import { logger, schedules } from '@trigger.dev/sdk';
import { CreditsSweepService } from '@ever-works/agent/subscriptions';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Daily credits sweep (pricing Wave 9 M1; billing spec §3.2 / FR-23).
 *
 * Once a day (00:05 UTC — offset off the hour per the sweeper-family
 * rationale, clear of the midnight cron crowd) the worker asks the API
 * to run three idempotent passes, in this order:
 *
 *   1. **expire** every lapsed credit bucket (`expiry` rows), so that
 *   2. **daily free grants** top every active user — on EVERY plan —
 *      back UP TO the plan's `daily-free-credits` level (non-accumulating:
 *      a balance already at/above the level receives nothing), and
 *   3. **plan allowance grants** open the current allowance month's
 *      bucket for every active cloud subscription that has not received
 *      it yet (3,000 Pro / 25,000 Enterprise, expiring at month end).
 *
 * The real services live in the API (ledger, entitlement and subscription
 * repositories are wired there); the worker only calls
 * `CreditsSweepService.runDailySweep()` over the internal RPC channel —
 * same shape as the event-ingest-tick / task-branch-gc crons.
 *
 * Idempotency: every write carries a structural key
 * (`expiry:{entryId}`, `daily:{userId}:{date}`,
 * `grant:plan:{userId}:{monthStart}`), so re-running the cron (retry,
 * redeploy, manual trigger) is a no-op for already-processed rows.
 *
 * The task id is unchanged from the original daily-grant task so the
 * existing Trigger schedule keeps firing without re-registration.
 */
export const creditsDailyGrantTask = schedules.task({
    id: 'credits-daily-grant',
    cron: '5 0 * * *',
    run: async () => {
        return withWorkerContext(
            'CreditsDailyGrant',
            async (appContext) => {
                const svc = appContext.get(CreditsSweepService);
                const summary = await svc.runDailySweep();
                logger.info('credits-daily-grant ran the daily credits sweep', {
                    ...summary,
                });
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
