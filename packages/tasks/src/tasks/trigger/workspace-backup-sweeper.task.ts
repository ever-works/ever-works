import { logger, schedules } from '@trigger.dev/sdk';
import { WorkspaceBackupService } from '@ever-works/agent/account-transfer';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Workspace backup (AW-22) — the hourly sweep that keeps the record honest.
 *
 * Three independent passes, each idempotent and each answering a promise the
 * product makes on the backup card:
 *
 *  1. **Expire artefacts** (spec FR-28). "Archives are kept for 14 days" has
 *     to be true of the bytes, not just of the copy. The row survives with
 *     status `expired` and the date, because "I took a backup that day" is
 *     still true and is the only version of the question anyone asks
 *     (spec S-16).
 *  2. **Fail stalls** (spec FR-5, S-14). A worker that dies leaves a backup
 *     showing a progress bar that will never move. Ten minutes without a
 *     heartbeat, or fifteen minutes queued with nothing picking it up, and
 *     the row says so, any partial archive is deleted, and the daily
 *     allowance is not charged for an attempt that produced nothing.
 *  3. **Prune records** (spec FR-29). A record outlives its bytes by ninety
 *     days so history stays legible, and then it goes.
 *
 * `17 * * * *` — hourly, off the top of the hour, the same reason every
 * other sweeper in this directory is offset: the crowded top-of-hour slot
 * makes a slow pass look like an outage.
 *
 * Each pass runs under a distributed lock so two replicas do not both try to
 * delete the same object. A pass that cannot take the lock does nothing and
 * the next hour picks it up — every pass is idempotent, so a missed hour
 * costs an hour of retention precision and nothing else.
 *
 * ## Why this calls one method instead of taking the locks here
 *
 * It used to resolve `WorkspaceBackupService` AND `DistributedTaskLockService`
 * from `TriggerInternalModule`, which provided neither, so the cron threw
 * `Nest could not find WorkspaceBackupService element` before any pass ran —
 * every hour since it shipped. Retention was never enforced, and because
 * `create()` adopts an active row, an owner whose worker died could never
 * start another backup.
 *
 * The service is now an RPC proxy to the API (see
 * `trigger-internal.module.ts`), and the three passes plus their locks are
 * composed API-side as `runSweep()` — both because `runExclusive` takes a
 * CALLBACK, which cannot cross an RPC boundary, and because the lock injects
 * `@InjectRepository(CacheEntry)` and the worker process has no DataSource at
 * all. Same shape as `CreditsSweepService.runDailySweep()`, for the same
 * reason.
 */
export const workspaceBackupSweeperTask = schedules.task({
    id: 'workspace-backup-sweeper',
    cron: '17 * * * *',
    run: async () => {
        return withWorkerContext(
            'WorkspaceBackupSweeper',
            async (appContext) => {
                const summary = await appContext.get(WorkspaceBackupService).runSweep(new Date());

                if (summary.expired > 0 || summary.stalled > 0 || summary.pruned > 0) {
                    logger.info('workspace-backup-sweeper pass complete', { ...summary });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
