import { logger, schedules } from '@trigger.dev/sdk';
import { PaygService } from '@ever-works/agent/subscriptions';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Pay-as-you-go meter flush (billing spec §3.5 / FR-23).
 *
 * Every 5 minutes, resend the `credit_meter_events` rows the settlement
 * path could not deliver to the provider's usage meter (a Stripe blip, a
 * timeout, a pod restart between the row write and the send). The API's
 * `PaygService.flushPending()` does the work over the internal RPC
 * channel — same shape as the other sweeper crons.
 *
 * Idempotency: each row's `identifier` (`run:{runId}`) is also the
 * provider's meter-event identifier and request idempotency key, so a
 * resend of an event that actually landed cannot double-count within the
 * provider's de-duplication window. Rows older than the provider's
 * backdating window are marked `failed` and logged for reconciliation
 * instead of being retried forever.
 */
export const creditsMeterFlushTask = schedules.task({
    id: 'credits-meter-flush',
    cron: '*/5 * * * *',
    run: async () => {
        return withWorkerContext(
            'CreditsMeterFlush',
            async (appContext) => {
                const svc = appContext.get(PaygService);
                const summary = await svc.flushPending();
                if (summary.scanned > 0) {
                    logger.info('credits-meter-flush resent pending meter events', { ...summary });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
