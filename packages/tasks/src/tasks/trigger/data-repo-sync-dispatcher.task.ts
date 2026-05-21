import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import {
    DATA_SYNC_DISPATCHER_SERVICE,
    TriggerInternalModule,
} from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * EW-628 data-repo instant-sync dispatcher.
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §5.3.
 *
 * Single `schedules.task` that fires every minute and runs BOTH paths
 * by delegating to the API-side `DataSyncDispatcherService` over the
 * trigger internal RPC channel:
 *
 * - **Path A** (webhook flush): Works where the GitHub App `push`
 *   handler set `pendingSyncRequestedAt` ≥ debounceMs ago.
 * - **Path B** (poller fallback): Works without the App installed
 *   whose `lastPolledAt` is older than `syncIntervalMinutes`.
 *
 * Both paths converge on `DataSyncService.runDataSync(workId, source)`
 * (G3 body) which acquires the per-Work `data-sync:<workId>` lock and
 * runs the three gates (retry-backoff / generation-in-progress / render).
 *
 * Flag gating: `subscriptions.dataSync.dispatcherEnabled = false` makes
 * the dispatcher service return an empty summary so the cron stays
 * registered (Trigger.dev requires a stable schedule list) but does
 * nothing in production until the flag is flipped.
 */

// Cron fixed at every minute per spec §7 ("Dispatcher cron"). Made
// overridable via env so soak tests can dial it down without redeploying.
const cronExpression = process.env.DATA_SYNC_DISPATCHER_CRON ?? '*/1 * * * *';

interface DataSyncDispatcher {
    dispatchDue: (limit?: number) => Promise<{
        limit: number;
        dueCount: number;
        dispatched: number;
        skipped: number;
        failed: number;
    }>;
}

export const dataRepoSyncDispatcherTask = schedules.task({
    id: 'data-repo-sync-dispatcher',
    cron: cronExpression,
    run: async () => {
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('DataRepoSyncDispatcher'));
        // `appContext.get('NestFactoryStaticLogger', { strict: false })` still
        // throws under Nest 11 when the provider isn't registered, so the
        // `?? console` fallback never fires. Guard explicitly.
        let logger: { log?: (m: string) => void } = console;
        try {
            const fromCtx = appContext.get('NestFactoryStaticLogger', { strict: false });
            if (fromCtx) logger = fromCtx as typeof logger;
        } catch {
            // Fall back to console — already the default.
        }

        try {
            const dispatcher = appContext.get<DataSyncDispatcher>(DATA_SYNC_DISPATCHER_SERVICE);
            const summary = await dispatcher.dispatchDue();

            (logger as { log?: (m: string) => void }).log?.(
                `Data-sync dispatch tick — due=${summary.dueCount} dispatched=${summary.dispatched} skipped=${summary.skipped} failed=${summary.failed}`,
            );

            return {
                cron: cronExpression,
                dueCount: summary.dueCount,
                dispatched: summary.dispatched,
                skipped: summary.skipped,
                failed: summary.failed,
            };
        } finally {
            await appContext.close();
        }
    },
});
