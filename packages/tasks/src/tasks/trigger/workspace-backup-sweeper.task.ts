import { logger, schedules } from '@trigger.dev/sdk';
import { WorkspaceBackupService } from '@ever-works/agent/account-transfer';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
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
 */
export const workspaceBackupSweeperTask = schedules.task({
    id: 'workspace-backup-sweeper',
    cron: '17 * * * *',
    run: async () => {
        return withWorkerContext(
            'WorkspaceBackupSweeper',
            async (appContext) => {
                const backups = appContext.get(WorkspaceBackupService);
                const locks = appContext.get(DistributedTaskLockService);
                const now = new Date();

                const summary = { expired: 0, stalled: 0, pruned: 0 };

                const expired = await locks.runExclusive('workspace-backup:expire', () =>
                    backups.expireDueArchives(now),
                );
                summary.expired = expired.result ?? 0;

                const stalled = await locks.runExclusive('workspace-backup:stalls', () =>
                    backups.failStalledBackups(now),
                );
                summary.stalled = stalled.result ?? 0;

                const pruned = await locks.runExclusive('workspace-backup:prune', () =>
                    backups.pruneOldRecords(now),
                );
                summary.pruned = pruned.result ?? 0;

                if (summary.expired > 0 || summary.stalled > 0 || summary.pruned > 0) {
                    logger.info('workspace-backup-sweeper pass complete', { ...summary });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
