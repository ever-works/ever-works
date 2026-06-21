/**
 * EW-743 Phase 2 — Internal platform event names emitted by the
 * Trigger.dev webhook router.
 *
 * Downstream services (notification fan-out, run-state cache, retry
 * policy) subscribe to these via `@OnEvent(TRIGGER_WEBHOOK_EVENTS.…)`.
 *
 * Naming convention: `trigger.<subject>.<verb-past>` to match the
 * existing platform convention used in `@ever-works/agent/events`
 * (e.g. `work.created`, `work-generation.completed`).
 *
 * The supported Trigger.dev upstream event types track Trigger.dev's
 * v4 "alert webhook" surface as documented at
 * https://trigger.dev/docs/troubleshooting-alerts#alert-webhooks
 * (`alert.run.failed`, `alert.deployment.success`,
 * `alert.deployment.failed`) plus two forward-looking run-state
 * events (`alert.run.succeeded`, `alert.run.cancelled`) that Trigger
 * is likely to add given the existing `RunStatus` enum already covers
 * `COMPLETED` and `CANCELED`. Unknown event types are dropped (with
 * a log line) at the router so adding to this map is backwards-
 * compatible — no controller / receiver change required.
 *
 * The router emits the FULL verified webhook payload as the event
 * body, wrapped in a {@link TriggerWebhookInternalEventPayload}
 * envelope. Subscribers see the tenantId (route-authoritative) and
 * the upstream `payload` field opaquely; pulling typed slices out of
 * `payload.object` is the subscriber's responsibility (Trigger.dev's
 * `object` shape differs per event type — see the run-state vs.
 * deployment alert schemas).
 */
export const TRIGGER_WEBHOOK_EVENTS = {
    RUN_SUCCEEDED: 'trigger.run.succeeded',
    RUN_FAILED: 'trigger.run.failed',
    RUN_CANCELLED: 'trigger.run.cancelled',
    DEPLOYMENT_SUCCEEDED: 'trigger.deployment.succeeded',
    DEPLOYMENT_FAILED: 'trigger.deployment.failed',
} as const;

export type TriggerWebhookInternalEventName =
    (typeof TRIGGER_WEBHOOK_EVENTS)[keyof typeof TRIGGER_WEBHOOK_EVENTS];

/**
 * Upstream → internal map. Lookup-only; do NOT iterate to derive the
 * supported set (the iteration order is unstable and unknown event
 * types must drop, not throw). Add entries here when Trigger.dev
 * pins a new alert type.
 */
export const TRIGGER_WEBHOOK_EVENT_TYPE_MAP: Readonly<
    Record<string, TriggerWebhookInternalEventName>
> = Object.freeze({
    'alert.run.succeeded': TRIGGER_WEBHOOK_EVENTS.RUN_SUCCEEDED,
    'alert.run.failed': TRIGGER_WEBHOOK_EVENTS.RUN_FAILED,
    'alert.run.cancelled': TRIGGER_WEBHOOK_EVENTS.RUN_CANCELLED,
    'alert.deployment.success': TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_SUCCEEDED,
    'alert.deployment.failed': TRIGGER_WEBHOOK_EVENTS.DEPLOYMENT_FAILED,
});

/**
 * Envelope emitted on `TRIGGER_WEBHOOK_EVENTS.*`. Subscribers should
 * import this type for autocompletion on the handler argument:
 *
 * ```ts
 * @OnEvent(TRIGGER_WEBHOOK_EVENTS.RUN_FAILED)
 * onRunFailed(evt: TriggerWebhookInternalEventPayload) { … }
 * ```
 *
 * `tenantId` is the route-param value (authoritative). When the
 * upstream body also carries a `tenant_id` and the two disagree, the
 * router LOGS a warn line and still emits with the route value — see
 * `TriggerWebhookEventRouterService.route` for the rationale.
 */
export interface TriggerWebhookInternalEventPayload {
    /** Tenant id from the controller route param (authoritative). */
    readonly tenantId: string;
    /** Upstream `event_type` string the router matched against. */
    readonly upstreamEventType: string;
    /** Internal platform event name this delivery was emitted under. */
    readonly internalEventName: TriggerWebhookInternalEventName;
    /** ISO timestamp from the upstream `created_at` field. */
    readonly createdAt: string;
    /** Opaque upstream payload (`payload` field of the verified envelope). */
    readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Verified webhook envelope shape this router expects AFTER the
 * receiver-side HMAC check. Defined as a runtime guard rather than
 * a class-validator DTO because the router lives outside the request
 * pipeline (the controller invokes it directly, so the global
 * `ValidationPipe` does not run on this object).
 */
export interface TriggerWebhookEnvelope {
    readonly event_type: string;
    readonly tenant_id: string;
    readonly created_at: string;
    readonly payload: Readonly<Record<string, unknown>>;
}

export function isTriggerWebhookEnvelope(value: unknown): value is TriggerWebhookEnvelope {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.event_type !== 'string' || obj.event_type.length === 0) {
        return false;
    }
    if (typeof obj.tenant_id !== 'string' || obj.tenant_id.length === 0) {
        return false;
    }
    if (typeof obj.created_at !== 'string' || obj.created_at.length === 0) {
        return false;
    }
    if (!obj.payload || typeof obj.payload !== 'object' || Array.isArray(obj.payload)) {
        return false;
    }
    return true;
}
