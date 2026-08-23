import { logger, schedules } from '@trigger.dev/sdk';
import { CreditLedgerService } from '@ever-works/agent/subscriptions';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Daily free-credit grant (pricing Wave 9 M1).
 *
 * Once a day (00:05 UTC — offset off the hour per the sweeper-family
 * rationale, clear of the midnight cron crowd), top every active user
 * whose plan carries the `daily-free-credits` entitlement back UP TO
 * that level. Non-accumulating by design (PRD §3.6): a balance already
 * at/above the level receives nothing, so free credits are a daily
 * allowance, not a stockpile.
 *
 * The real `CreditLedgerService` lives in the API (ledger +
 * entitlement repositories are wired there); the worker only calls
 * `dispatchDailyGrants()` over the internal RPC channel — same shape
 * as the event-ingest-tick / task-branch-gc crons.
 *
 * Idempotency: every grant is written with idempotencyKey
 * `daily:{userId}:{date}`, so re-running the cron (retry, redeploy,
 * manual trigger) is a no-op for already-granted users.
 */
export const creditsDailyGrantTask = schedules.task({
    id: 'credits-daily-grant',
    cron: '5 0 * * *',
    run: async () => {
        return withWorkerContext(
            'CreditsDailyGrant',
            async (appContext) => {
                const svc = appContext.get(CreditLedgerService);
                const summary = await svc.dispatchDailyGrants();
                // 🛑 The monthly counters must not hide behind the daily ones. On any
                // same-day re-run - a retry, a redeploy, a manual trigger - every daily
                // grant returns 'already', so granted and skipped are both 0 and this
                // used to log NOTHING AT ALL, even in a sweep where every paying
                // subscriber's monthly grant threw. Silence that looks like health is
                // the exact failure the `failed` counters were added to end.
                if (
                    summary.granted > 0 ||
                    summary.skipped > 0 ||
                    summary.monthlyGranted > 0 ||
                    summary.monthlyAlreadyGranted > 0 ||
                    summary.monthlyFailed > 0
                ) {
                    logger.info('credits-daily-grant dispatched daily free credits', {
                        ...summary,
                    });
                }
                if (summary.failed > 0 || summary.monthlyFailed > 0) {
                    logger.error('credits-daily-grant had per-user failures', {
                        failed: summary.failed,
                        monthlyFailed: summary.monthlyFailed,
                        scanned: summary.scanned,
                    });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
