import { logger, task } from '@trigger.dev/sdk';
import type { WorkspaceBackupPayload } from '@ever-works/agent/tasks';
import { WorkspaceBackupRunner, WorkspaceBackupService } from '@ever-works/agent/account-transfer';
import { WorkspaceBackupRepository } from '@ever-works/agent/database';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { TenantRuntimeBindingResolverService } from '../../trigger/worker/services/tenant-runtime-binding-resolver.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * Workspace backup (AW-22) — build one complete archive of one workspace.
 *
 * This is the whole reason the epic exists: a workspace with a year of runs
 * and a knowledge base full of PDFs cannot be exported inside a web request,
 * so the archive is produced here and the request that asked for it returns
 * in milliseconds (spec FR-2).
 *
 * `maxDuration` is an hour (spec FR-6) — a backup that has not finished by
 * then is stopped and the record says `timeout`, which is a better answer
 * than a job that runs until something else kills it. `retry.maxAttempts` is
 * 1 deliberately: a half-written archive must never be silently rebuilt over
 * the top of itself, and the retries that matter happen per query inside the
 * runner, where a transient database error can actually be resumed (spec
 * FR-17).
 *
 * Skip-and-ack conditions return `{ status: 'skipped', reason }` rather than
 * throwing, because a retry would observe the same thing forever:
 *
 *  - `backup-not-found` — the row was pruned or the account deleted between
 *    enqueue and run.
 *  - `already-terminal` — the owner cancelled it, or the sweeper called it
 *    stalled, before a worker picked it up.
 *  - `already-claimed` — another worker won the compare-and-set.
 *  - `credentials-drained` — the tenant rotated its job-runtime overlay past
 *    the version this run was enqueued against.
 *
 * Everything else — a storage backend that will not take the stream, a
 * database that is down — is recorded on the row with a reason the card has
 * specific copy for, so the owner is never shown a generic error.
 *
 * ## Where the archive is actually built
 *
 * `WorkspaceBackupRunner`, `WorkspaceBackupRepository` and
 * `WorkspaceBackupService` are RPC proxies to the API process (see
 * `trigger-internal.module.ts`). This task used to resolve them from the
 * default `TriggerWorkerModule`, which provides none of them, so every
 * dispatched backup died at `appContext.get(WorkspaceBackupRunner)` with
 * `Nest could not find WorkspaceBackupRunner element` and the row was left
 * at `queued` forever — the exact regression this repository already records
 * for `AnonymousUserCleanupService`.
 *
 * Proxying is not a preference: the runner injects `@InjectDataSource()`,
 * streams to the active storage backend and clones each Work's data
 * repository, and the worker process has no TypeORM DataSource at all. So
 * the dispatch still flows through the job-runtime dispatcher and this task,
 * and the hour of work happens where its dependencies are.
 *
 * One consequence is handled below rather than hidden: the internal RPC
 * channel has a per-request deadline (45 s by default), and a large archive
 * will exceed it. A client-side deadline does not stop the API pod, and the
 * runner owns the row — it claims it with a compare-and-set and settles it
 * itself — so the archive still completes and still lands. What would be
 * lost is the one notification of spec FR-33, so a failed run call falls
 * through to reading the row and notifying on it if it has in fact settled.
 */
export const workspaceBackupTask = task<'workspace-backup', WorkspaceBackupPayload>({
    id: 'workspace-backup',
    // Spec FR-6. The runner heartbeats throughout, so a job that dies before
    // this is noticed by the hourly sweeper within ten minutes rather than
    // sitting at "running" until the ceiling.
    maxDuration: 3600,
    retry: { maxAttempts: 1 },
    queue: {
        name: 'workspace-backup',
        // Two archives at a time across the whole instance: each one is a
        // long read over most of the database plus a large upload, and three
        // at once would make every OTHER job slower for no user-visible
        // gain. Per-workspace serialisation is already guaranteed upstream
        // by the partial unique index (spec FR-3).
        concurrencyLimit: 2,
    },
    run: async (payload) => {
        return withWorkerContext('WorkspaceBackup', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();

            const binding = await appContext
                .get(TenantRuntimeBindingResolverService)
                .resolve(payload, payload.tenantId ?? null);
            if (binding.status === 'drained') {
                logger.warn('workspace-backup: credentials drained, skipping run', {
                    backupId: payload.backupId,
                    providerId: binding.providerId,
                    credentialVersion: binding.credentialVersion,
                });
                return {
                    status: 'skipped',
                    reason: 'credentials-drained',
                    backupId: payload.backupId,
                };
            }

            const scope = {
                userId: payload.userId,
                organizationId: payload.organizationId ?? null,
                tenantId: payload.tenantId ?? null,
            };

            /**
             * Exactly one notification per finished backup (spec FR-33),
             * raised here rather than inside the runner so a cancelled run —
             * which the owner already knows about — stays silent. Reads the
             * row rather than trusting a status, because the row is the only
             * thing that knows what actually happened.
             */
            const notifyFromRow = async (): Promise<string | undefined> => {
                const settled = await appContext
                    .get(WorkspaceBackupRepository)
                    .findInScope(scope, payload.backupId);
                if (!settled || settled.status === 'cancelled') {
                    return settled?.status;
                }
                await appContext.get(WorkspaceBackupService).notifyFinished(settled);
                return settled.status;
            };

            const runner = appContext.get(WorkspaceBackupRunner);
            let result: Awaited<ReturnType<typeof runner.runFromPayload>>;
            try {
                result = await runner.runFromPayload({
                    backupId: payload.backupId,
                    userId: payload.userId,
                    organizationId: payload.organizationId ?? null,
                });
            } catch (error) {
                // The run call did not come back — most plausibly the
                // internal RPC deadline elapsed on a large archive. The
                // runner still owns the row and settles it itself, so the
                // honest thing is to report what the row says rather than
                // guess, and to still raise the notification the owner is
                // owed if it has settled.
                const status = await notifyFromRow().catch(() => undefined);
                logger.warn('workspace-backup: run call did not return', {
                    backupId: payload.backupId,
                    rowStatus: status,
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }

            if (result.status === 'skipped') {
                logger.info('workspace-backup: nothing to do', {
                    backupId: payload.backupId,
                    reason: result.reason,
                });
                return result;
            }

            if (result.status !== 'cancelled') {
                await notifyFromRow();
            }

            logger.info('workspace-backup finished', {
                backupId: payload.backupId,
                status: result.status,
            });
            return result;
        });
    },
});
