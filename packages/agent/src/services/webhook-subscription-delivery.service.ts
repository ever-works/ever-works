import { Injectable, Logger } from '@nestjs/common';
import { WebhookSubscriptionRepository, WebhookDeliveryRepository } from '../database';
import { WebhookDeliveryService, type DeliveryResult } from './webhook-delivery.service';

/**
 * Default dead-letter threshold (overridable via env). Picked to match the
 * ticket's "consecutiveFailures >= 10" guidance — after ~10 attempts at the
 * 30s/2m/10m/1h/6h/1d backoff schedule we've held the subscription open for
 * roughly a week of attempts. Anything beyond that is almost always the
 * receiver going away permanently.
 */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;

export interface DispatchWebhookInput {
    readonly subscriptionId: string;
    readonly event: string;
    readonly payload: Record<string, unknown>;
    /** Pre-allocated delivery row id (created by the producer dispatcher). */
    readonly deliveryId?: string;
    /** Optional Trigger.dev run id, recorded on the delivery row for audit. */
    readonly triggerRunId?: string | null;
}

export interface DispatchedWebhookResult {
    readonly result: DeliveryResult;
    readonly subscription: { id: string; status: 'active' | 'paused' | 'failed' };
    /**
     * `true` when the outcome is retryable AND we have NOT yet hit the
     * dead-letter threshold. Producers (Trigger.dev task) throw to trigger
     * a retry when this is true.
     */
    readonly shouldRetry: boolean;
    /**
     * The current consecutive-failure count AFTER this attempt. Producers
     * surface this in logs so operators can see how close to dead-letter
     * a misbehaving receiver is.
     */
    readonly consecutiveFailures: number;
}

/**
 * Orchestrates a single delivery attempt against a stored subscription:
 *
 *   1. Resolve the subscription row.
 *   2. Decrypt the per-subscription HMAC secret (caller-supplied decrypt
 *      function — `WebhookSecretService.decrypt` in the API surface; the
 *      agent package deliberately does NOT depend on the API-side
 *      `WebhookSecretService` since AES-256-GCM key management lives in
 *      `apps/api`).
 *   3. POST via {@link WebhookDeliveryService}.
 *   4. Apply success / failure / dead-letter semantics to the subscription.
 *   5. Persist a {@link WebhookDelivery} row reflecting the outcome.
 *
 * Trigger.dev wrapping (`packages/tasks/src/tasks/trigger/webhook-delivery.task.ts`)
 * throws when {@link DispatchedWebhookResult.shouldRetry} is true so the
 * Trigger.dev runtime can apply the exponential backoff schedule.
 */
@Injectable()
export class WebhookSubscriptionDeliveryService {
    private readonly logger = new Logger(WebhookSubscriptionDeliveryService.name);

    constructor(
        private readonly delivery: WebhookDeliveryService,
        private readonly subscriptions: WebhookSubscriptionRepository,
        private readonly deliveries: WebhookDeliveryRepository,
    ) {}

    /**
     * Decrypt callback. The agent package can't depend on the API-side
     * `WebhookSecretService` directly (that one lives in
     * `apps/api/src/webhooks/webhook-secret.service.ts` and pulls in the
     * platform encryption key). Producers MUST register a decryptor before
     * the first call — typically inside the NestJS module that wires this
     * service. We default to identity so unit tests that pass a raw secret
     * via the subscription row work without setup.
     */
    private decryptSecret: (encrypted: string) => string = (s) => s;

    setSecretDecryptor(decrypt: (encrypted: string) => string): void {
        this.decryptSecret = decrypt;
    }

    private get maxConsecutiveFailures(): number {
        const raw = process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES;
        if (!raw) return DEFAULT_MAX_CONSECUTIVE_FAILURES;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CONSECUTIVE_FAILURES;
    }

    async dispatch(input: DispatchWebhookInput): Promise<DispatchedWebhookResult> {
        const sub = await this.subscriptions.findById(input.subscriptionId);
        if (!sub) {
            return {
                result: {
                    ok: false,
                    outcome: 'client_error',
                    error: 'subscription_not_found',
                    deliveryId: input.deliveryId ?? input.subscriptionId,
                },
                subscription: { id: input.subscriptionId, status: 'failed' },
                shouldRetry: false,
                consecutiveFailures: 0,
            };
        }

        if (sub.status !== 'active') {
            this.logger.log(
                `webhook.dispatch_skipped sub=${sub.id} status=${sub.status} event=${input.event}`,
            );
            return {
                result: {
                    ok: false,
                    outcome: 'client_error',
                    error: `subscription_${sub.status}`,
                    deliveryId: input.deliveryId ?? sub.id,
                },
                subscription: { id: sub.id, status: sub.status },
                shouldRetry: false,
                consecutiveFailures: sub.consecutiveFailures,
            };
        }

        // Decrypt per-delivery, never cache. Mirrors the ticket's explicit
        // requirement: "Decrypt the secret on each delivery via
        // WebhookSecretService.decrypt. Do not cache the decrypted secret
        // beyond the delivery."
        const secret = this.decryptSecret(sub.secretEncrypted);
        if (!secret) {
            this.logger.error(
                `webhook.decrypt_failed sub=${sub.id} event=${input.event} — refusing to deliver`,
            );
            await this.deliveries
                .recordAttempt(input.deliveryId!, {
                    status: 'failed',
                    lastOutcome: 'decrypt_failed',
                    lastError: 'secret_decryption_returned_empty',
                    triggerRunId: input.triggerRunId ?? null,
                })
                .catch(() => {});
            return {
                result: {
                    ok: false,
                    outcome: 'client_error',
                    error: 'decrypt_failed',
                    deliveryId: input.deliveryId ?? sub.id,
                },
                subscription: { id: sub.id, status: sub.status },
                shouldRetry: false,
                consecutiveFailures: sub.consecutiveFailures,
            };
        }

        const result = await this.delivery.deliver({
            url: sub.url,
            secret,
            event: input.event,
            payload: input.payload,
            deliveryId: input.deliveryId,
        });

        return this.applyResult(sub, result, input);
    }

    private async applyResult(
        sub: { id: string; status: 'active' | 'paused' | 'failed'; consecutiveFailures: number },
        result: DeliveryResult,
        input: DispatchWebhookInput,
    ): Promise<DispatchedWebhookResult> {
        // Retryable outcomes: server errors AND timeouts. The Trigger.dev
        // runtime then re-enters the task and reruns dispatch().
        const retryable = result.outcome === 'server_error' || result.outcome === 'timeout';

        if (result.outcome === 'success') {
            await this.subscriptions.markSuccess(sub.id).catch((err) => {
                this.logger.error(`webhook.mark_success_failed sub=${sub.id}`, err as Error);
            });
            if (input.deliveryId) {
                await this.deliveries
                    .recordAttempt(input.deliveryId, {
                        status: 'delivered',
                        lastResponseStatus: result.status ?? null,
                        lastOutcome: result.outcome,
                        durationMs: result.durationMs ?? null,
                        triggerRunId: input.triggerRunId ?? null,
                    })
                    .catch((err) => {
                        this.logger.error(
                            `webhook.delivery_record_failed delivery=${input.deliveryId}`,
                            err as Error,
                        );
                    });
            }
            return {
                result,
                subscription: { id: sub.id, status: 'active' },
                shouldRetry: false,
                consecutiveFailures: 0,
            };
        }

        // Any non-success outcome bumps the failure counter. The counter is
        // what eventually trips the dead-letter — even retryable failures
        // count, so a receiver that's down for a week eventually drops out.
        let failures = sub.consecutiveFailures;
        try {
            failures = await this.subscriptions.incrementFailure(sub.id);
        } catch (err) {
            this.logger.error(`webhook.increment_failure_failed sub=${sub.id}`, err as Error);
        }

        const shouldDeadLetter = failures >= this.maxConsecutiveFailures;
        const terminalThisAttempt = !retryable || shouldDeadLetter;

        if (shouldDeadLetter) {
            try {
                await this.subscriptions.markFailed(sub.id);
                this.logger.warn(
                    `webhook.dead_letter sub=${sub.id} failures=${failures} threshold=${this.maxConsecutiveFailures}`,
                );
            } catch (err) {
                this.logger.error(`webhook.mark_failed_failed sub=${sub.id}`, err as Error);
            }
        }

        if (input.deliveryId) {
            await this.deliveries
                .recordAttempt(input.deliveryId, {
                    status: terminalThisAttempt ? 'failed' : 'retrying',
                    lastResponseStatus: result.status ?? null,
                    lastOutcome: result.outcome,
                    lastError: result.error ?? null,
                    durationMs: result.durationMs ?? null,
                    triggerRunId: input.triggerRunId ?? null,
                })
                .catch((err) => {
                    this.logger.error(
                        `webhook.delivery_record_failed delivery=${input.deliveryId}`,
                        err as Error,
                    );
                });
        }

        return {
            result,
            subscription: {
                id: sub.id,
                status: shouldDeadLetter ? 'failed' : sub.status,
            },
            shouldRetry: retryable && !shouldDeadLetter,
            consecutiveFailures: failures,
        };
    }
}
