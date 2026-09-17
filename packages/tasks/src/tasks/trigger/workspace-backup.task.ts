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

            const runner = appContext.get(WorkspaceBackupRunner);
            const result = await runner.runFromPayload({
                backupId: payload.backupId,
                userId: payload.userId,
                organizationId: payload.organizationId ?? null,
            });

            if (result.status === 'skipped') {
                logger.info('workspace-backup: nothing to do', {
                    backupId: payload.backupId,
                    reason: result.reason,
                });
                return result;
            }

            // Exactly one notification per finished backup (spec FR-33),
            // raised here rather than inside the runner so a cancelled run —
            // which the owner already knows about — stays silent.
            if (result.status !== 'cancelled') {
                const backups = appContext.get(WorkspaceBackupRepository);
                const settled = await backups.findInScope(
                    {
                        userId: payload.userId,
                        organizationId: payload.organizationId ?? null,
                        tenantId: payload.tenantId ?? null,
                    },
                    payload.backupId,
                );
                if (settled) {
                    await appContext.get(WorkspaceBackupService).notifyFinished(settled);
                }
            }

            logger.info('workspace-backup finished', {
                backupId: payload.backupId,
                status: result.status,
            });
            return result;
        });
    },
});
