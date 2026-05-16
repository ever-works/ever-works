import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * EW-628 data-repo instant-sync dispatcher (Phase 4).
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §5.3.
 *
 * Single `schedules.task` that fires every minute and runs BOTH:
 *
 * - **Path A** (webhook flush): pick Works where
 *   `pendingSyncRequestedAt <= now() - 30s` (quiet-period debounce) and
 *   fan out a `data-repo-sync` task call with `source='webhook'`.
 * - **Path B** (poller fallback): pick Works where
 *   `githubAppInstalled = false AND (lastPolledAt IS NULL OR lastPolledAt
 *   + syncIntervalMinutes·minutes <= now())`. For each, run `ls-remote
 *   HEAD` synchronously and only fan out when the SHA differs from
 *   `lastSyncedDataRepoSha`; otherwise emit a rate-limited
 *   `data-sync.skipped reason=no-changes` row.
 *
 * Both paths converge on `DataSyncService.runDataSync(workId, source)`
 * (Phase 3 surface), which acquires the per-Work
 * `data-sync:<workId>` lock via {@link DistributedTaskLockService} and
 * runs the three gates documented in spec §5.4.
 *
 * Flag gating (Phase 8): the body short-circuits when
 * `subscriptions.dataSync.dispatcherEnabled = false` so the cron stays
 * registered (Trigger.dev requires a stable schedule list) but does
 * nothing in production until the flag is flipped.
 *
 * NOTE: Phase 4 (this commit) lands the registered schedule + the
 * NestJS bootstrap shell. The actual `DataSyncDispatcherService` that
 * runs the bulk SQL eligibility query and fans out per-Work lands in
 * a follow-up commit on the same PR so reviewers can read the
 * scheduling change separately from the dispatcher logic.
 */

// Cron fixed at every minute per spec §7 ("Dispatcher cron"). Made
// overridable via env so soak tests can dial it down without redeploying.
const cronExpression = process.env.DATA_SYNC_DISPATCHER_CRON ?? '*/1 * * * *';

export const dataRepoSyncDispatcherTask = schedules.task({
    id: 'data-repo-sync-dispatcher',
    cron: cronExpression,
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('DataRepoSyncDispatcher'));
        const logger = appContext.get('NestFactoryStaticLogger', { strict: false }) ?? console;

        try {
            // TODO(EW-628 Phase 4 follow-up): inject DataSyncDispatcherService
            // and call dispatchDue() — bulk SELECT eligible Works, fan out
            // to data-repo-sync.task per row, return summary for trigger
            // run history. Until then this task is registered but inert
            // (matches the default-off subscriptions.dataSync.dispatcherEnabled
            // flag landing in Phase 8).
            (logger as { log?: (m: string) => void }).log?.(
                'EW-628 dispatcher stub — Phase 4 follow-up wires DataSyncDispatcherService',
            );

            return { cron: cronExpression, dispatched: 0, skipped: 0 };
        } finally {
            await appContext.close();
        }
    },
});
