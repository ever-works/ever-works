/**
 * Payload contract between the EW-634 producer-side dispatcher and the
 * Trigger.dev `webhook-delivery` task.
 *
 * The producer:
 *   1. Resolves the active subscription rows for a platform event.
 *   2. Allocates a `webhook_deliveries` row per (subscription, event) pair
 *      via `WebhookDeliveryRepository.createPending(...)`.
 *   3. Calls `WebhookDeliveryDispatcher.dispatchWebhookDelivery(...)` with
 *      this payload.
 *
 * The task runtime then resolves the subscription, decrypts the secret,
 * POSTs the signed payload, and applies success / failure / dead-letter
 * semantics. Anything that needs to retry is rethrown so Trigger.dev's
 * exponential backoff schedule kicks in (see
 * `packages/tasks/src/tasks/trigger/webhook-delivery.task.ts`).
 */
export interface WebhookDeliveryPayload {
    /** UUID from the `webhook_deliveries` row. */
    readonly deliveryId: string;

    /** UUID of the `webhook_subscriptions` row that should receive this. */
    readonly subscriptionId: string;

    /** Stable event identifier, e.g. `'work.generation.completed'`. */
    readonly eventName: string;

    /** Raw JSON payload that will be signed and POSTed verbatim. */
    readonly payload: Record<string, unknown>;
}
