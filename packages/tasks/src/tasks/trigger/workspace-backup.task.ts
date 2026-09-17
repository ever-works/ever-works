import { logger, task } from '@trigger.dev/sdk';
import type { WorkspaceBackupPayload } from '@ever-works/agent/tasks';
import {
    WorkspaceBackupRunner,
    WorkspaceBackupService,
    type WorkspaceBackupStartResult,
} from '@ever-works/agent/account-transfer';
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
 * ## Start, then watch the row
 *
 * The internal RPC channel gives up on a request after a short deadline (45 s
 * by default, set below the ingress timeouts in front of the API). This task
 * used to call `runFromPayload`, which holds that request open for the WHOLE
 * archive — so every backup longer than the deadline failed here, and the
 * fallback that was meant to still raise the owner's notification read a row
 * that was, of course, still `running`, and sent nothing. The archive then
 * finished on the API side with nobody left to tell the owner (spec FR-33),
 * and with this run gone the queue's concurrency limit no longer bounded it.
 *
 * So the task now makes only SHORT calls:
 *
 *  1. `startFromPayload` claims the row and starts the archive on the API
 *     side, returning as soon as the claim is decided.
 *  2. `observeRun`, every {@link WATCH_INTERVAL_MS}, until the row settles.
 *     Each look also applies the stall rule (the API process died) and the
 *     hour ceiling, so a run that can no longer settle itself still does.
 *  3. `notifyFinished`, once, on the settled row — unless it was cancelled,
 *     which the owner already knows about.
 *
 * The runner's heartbeat, the owner's cancel and the hourly sweeper are all
 * unchanged: they act on the row, and this task only reads it. Because the
 * task stays alive for as long as the archive runs, `concurrencyLimit` and
 * `maxDuration` bound the archive again rather than a 45-second wait.
 */

/** How often the settled-or-not question is asked. One short read each time. */
export const WATCH_INTERVAL_MS = 10_000;

/** The job runtime's hard ceiling for this task, in seconds (spec FR-6). */
const MAX_DURATION_SECONDS = 3600;

/**
 * How long before that ceiling the task stops waiting and settles the row as
 * `timeout` itself. A run killed by the runtime raises no notification, so
 * the task has to leave itself time for one last look and the notification
 * — each a single RPC bounded by the channel's own deadline.
 */
const WATCH_MARGIN_MS = 120_000;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    'ready',
    'ready_with_gaps',
    'failed',
    'cancelled',
    'expired',
    'deleted',
]);

export const workspaceBackupTask = task<'workspace-backup', WorkspaceBackupPayload>({
    id: 'workspace-backup',
    // Spec FR-6. The runner heartbeats throughout, so a job that dies before
    // this is noticed by the hourly sweeper within ten minutes rather than
    // sitting at "running" until the ceiling.
    maxDuration: MAX_DURATION_SECONDS,
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
        const watchUntil = Date.now() + MAX_DURATION_SECONDS * 1000 - WATCH_MARGIN_MS;

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
            const service = appContext.get(WorkspaceBackupService);

            let started: WorkspaceBackupStartResult;
            try {
                started = await appContext.get(WorkspaceBackupRunner).startFromPayload({
                    backupId: payload.backupId,
                    userId: payload.userId,
                    organizationId: payload.organizationId ?? null,
                });
            } catch (error) {
                // The start call did not come back. It claims the row before
                // it returns, so the row says how far it got: still `queued`
                // means nothing started and there is nothing to watch (the
                // sweeper fails a queued row that is never picked up);
                // anything else means the run exists and is watched as usual.
                const row = await appContext
                    .get(WorkspaceBackupRepository)
                    .findInScope(scope, payload.backupId)
                    .catch(() => null);
                logger.warn('workspace-backup: start call did not return', {
                    backupId: payload.backupId,
                    rowStatus: row?.status,
                    error: error instanceof Error ? error.message : String(error),
                });
                if (!row || row.status === 'queued') {
                    throw error;
                }
                started = { status: 'started', backupId: payload.backupId };
            }

            if (started.status === 'skipped') {
                logger.info('workspace-backup: nothing to do', {
                    backupId: payload.backupId,
                    reason: started.reason,
                });
                return started;
            }

            // `started`, or an outcome the runner already settled on the row
            // before any work began (no storage backend). Either way the row
            // is the answer, and the one notification is raised from it.
            let settled: Awaited<ReturnType<typeof service.observeRun>> = null;
            for (;;) {
                const stop = Date.now() >= watchUntil ? ('timeout' as const) : undefined;
                try {
                    settled = await service.observeRun(
                        scope,
                        payload.backupId,
                        stop ? { stop } : {},
                    );
                } catch (error) {
                    // One lost look costs one interval. The loop is bounded by
                    // `watchUntil`, so a channel that stays down still ends it.
                    logger.warn('workspace-backup: could not read the backup row', {
                        backupId: payload.backupId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    if (stop) {
                        throw error;
                    }
                    await sleep(WATCH_INTERVAL_MS);
                    continue;
                }

                if (!settled) {
                    logger.info('workspace-backup: the backup row is gone', {
                        backupId: payload.backupId,
                    });
                    return {
                        status: 'skipped',
                        reason: 'backup-not-found',
                        backupId: payload.backupId,
                    };
                }
                if (TERMINAL_STATUSES.has(settled.status)) {
                    break;
                }
                await sleep(WATCH_INTERVAL_MS);
            }

            // Exactly one notification per finished backup (spec FR-33),
            // raised here rather than inside the runner so a cancelled run —
            // which the owner already knows about — stays silent.
            if (settled.status !== 'cancelled') {
                await service.notifyFinished(settled);
            }

            logger.info('workspace-backup finished', {
                backupId: payload.backupId,
                status: settled.status,
            });
            return {
                status: settled.status,
                backupId: payload.backupId,
                ...(settled.failureReason ? { reason: settled.failureReason } : {}),
            };
        });
    },
});

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
