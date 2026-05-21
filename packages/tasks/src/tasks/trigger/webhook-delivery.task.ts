import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import type { WebhookDeliveryPayload } from '@ever-works/agent/tasks';
import { WebhookSubscriptionDeliveryService } from '@ever-works/agent/services';
import { TriggerWebhookDeliveryModule } from '../../trigger/worker/modules/trigger-webhook-delivery.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * EW-634 — outbound webhook delivery worker.
 *
 * One run per (subscription, event) pair. The producer-side dispatcher
 * (`apps/api/src/webhooks/webhook-event-dispatcher.service.ts`) creates a
 * `webhook_deliveries` row, then triggers this task with the row id.
 *
 * Lifecycle:
 *
 *   1. Boot the lightweight {@link TriggerWebhookDeliveryModule}.
 *   2. Hand the payload to {@link WebhookSubscriptionDeliveryService},
 *      which loads the subscription, decrypts the per-subscription HMAC
 *      secret, signs the body, POSTs (with the SSRF DNS pin + redirect
 *      refusal + 1 MiB cap from `WebhookDeliveryService`), and applies
 *      success / failure / dead-letter semantics.
 *   3. If the orchestrator returns `shouldRetry: true`, THROW so the
 *      Trigger.dev retry policy below kicks in. The orchestrator has
 *      already incremented the consecutive-failure counter on the
 *      subscription, so when the retry budget runs out the next attempt
 *      will be marked as dead-letter even if `shouldRetry` would still
 *      have been true.
 *
 * Backoff schedule (set on the task, not in `trigger.config.ts` — webhook
 * delivery has a much longer tail than the rest of the platform's jobs):
 *
 *   30s → 2m → 10m → 1h → 6h → 1d → 1d (max attempts: 10 by default)
 *
 * `factor: 6` + jitter approximates that curve; the explicit `maxAttempts`
 * matches `WEBHOOK_MAX_CONSECUTIVE_FAILURES` so the Trigger.dev runtime
 * stops retrying at roughly the same point the orchestrator would
 * dead-letter the subscription.
 */
export const webhookDeliveryTask = task<'webhook-delivery', WebhookDeliveryPayload>({
    id: 'webhook-delivery',
    // 30 minutes is plenty even for a slow receiver that hits the
    // per-attempt timeout twice. Lets us catch runaway tasks.
    maxDuration: 30 * 60,
    retry: {
        maxAttempts: webhookMaxAttemptsFromEnv(),
        minTimeoutInMs: 30_000, // 30s
        maxTimeoutInMs: 24 * 60 * 60 * 1000, // 24h
        factor: 6,
        randomize: true,
    },
    run: async (payload: WebhookDeliveryPayload, { ctx }) => {
        const appContext = await NestFactory.createApplicationContext(TriggerWebhookDeliveryModule);
        appContext.useLogger(createTriggerLogger('WebhookDelivery'));

        try {
            const orchestrator = appContext.get(WebhookSubscriptionDeliveryService);
            // EW-634 Codex P2 follow-up: pass the Trigger run id through
            // to the orchestrator so the `webhook_deliveries.triggerRunId`
            // column stays populated across attempts. The producer side
            // stamps it via `markEnqueued` at enqueue time; this keeps
            // it correct on each retry's recordAttempt update too.
            const outcome = await orchestrator.dispatch({
                deliveryId: payload.deliveryId,
                subscriptionId: payload.subscriptionId,
                event: payload.eventName,
                payload: payload.payload,
                triggerRunId: ctx?.run?.id ?? null,
            });

            if (outcome.shouldRetry) {
                // Throwing tells the Trigger.dev runtime to retry under
                // the policy declared above. Include both the outcome
                // bucket and the current consecutive-failure count so
                // operators tailing the run log can see how close to
                // dead-letter the subscription is.
                throw new Error(
                    `webhook_delivery_retryable subscription=${outcome.subscription.id} ` +
                        `outcome=${outcome.result.outcome} ` +
                        `status=${outcome.result.status ?? 'n/a'} ` +
                        `failures=${outcome.consecutiveFailures}`,
                );
            }

            return {
                deliveryId: payload.deliveryId,
                subscriptionId: payload.subscriptionId,
                event: payload.eventName,
                outcome: outcome.result.outcome,
                status: outcome.result.status ?? null,
                ok: outcome.result.ok,
                consecutiveFailures: outcome.consecutiveFailures,
                subscriptionStatus: outcome.subscription.status,
            };
        } finally {
            await appContext.close();
        }
    },
});

function webhookMaxAttemptsFromEnv(): number {
    const raw = process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES;
    if (!raw) return 10;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
}
