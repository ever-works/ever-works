import type { WebhookDeliveryPayload } from './webhook-delivery.types';

/**
 * Producer-side interface implemented by the Trigger.dev `TriggerService`
 * (in `packages/tasks/src/trigger/trigger.service.ts`) and the in-process
 * fallback (`InlineWebhookDeliveryDispatcher` in the agent webhooks
 * module). The producer-side dispatcher in `apps/api/src/webhooks/` calls
 * one of these depending on whether Trigger.dev is configured.
 *
 * Returning `null` means the dispatcher was unable to enqueue (Trigger.dev
 * disabled, transport error). Callers then fall back to the in-process
 * implementation so single-instance dev environments still deliver.
 */
export interface WebhookDeliveryDispatcher {
    dispatchWebhookDelivery(payload: WebhookDeliveryPayload): Promise<string | null>;
}

export const WEBHOOK_DELIVERY_DISPATCHER = Symbol.for('WEBHOOK_DELIVERY_DISPATCHER');
