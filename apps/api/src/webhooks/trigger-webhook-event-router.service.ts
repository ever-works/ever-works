import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    TRIGGER_WEBHOOK_EVENT_TYPE_MAP,
    TriggerWebhookInternalEventPayload,
    isTriggerWebhookEnvelope,
} from './trigger-webhook-events';

/**
 * EW-743 Phase 2 — Maps verified Trigger.dev webhook deliveries to
 * platform-internal `EventEmitter2` events.
 *
 * Called by {@link TriggerWebhookController} after HMAC verification
 * succeeds and the body is parsed. Single responsibility:
 *
 *   1. Type-guard the body against the
 *      {@link TriggerWebhookEnvelope} contract (`event_type`,
 *      `tenant_id`, `created_at`, `payload`). Malformed bodies are
 *      logged + dropped — NEVER thrown. The receiver has already
 *      returned 200; throwing here would surface as a 500 to
 *      Trigger.dev and cause a redelivery storm for payloads we
 *      will never accept.
 *   2. Translate `event_type` via {@link TRIGGER_WEBHOOK_EVENT_TYPE_MAP}.
 *      Unknown event types are logged at `debug` + dropped — the
 *      Trigger.dev alert taxonomy may grow, and we don't want
 *      unmapped types to count as errors. Operators can grep the
 *      log line to discover newly-emitted upstream types.
 *   3. Emit the internal event with a {@link TriggerWebhookInternalEventPayload}
 *      envelope. The TENANT ID on the envelope is the controller's
 *      ROUTE-PARAM value (authoritative — the receiver looked up the
 *      tenant overlay by that id and verified HMAC with that
 *      tenant's secret). A mismatch with the body `tenant_id` is
 *      logged at `warn` but the route value still wins — this
 *      prevents a misconfigured Trigger.dev project from delivering
 *      events tagged as another tenant.
 *
 * No de-duplication: subscribers MUST be idempotent. Trigger.dev
 * documents at-least-once webhook delivery (same event id may
 * arrive multiple times on retry), and this router is intentionally
 * stateless — adding a seen-set here would silently swallow legit
 * retries triggered by a transient subscriber failure.
 */
@Injectable()
export class TriggerWebhookEventRouterService {
    private readonly logger = new Logger(TriggerWebhookEventRouterService.name);

    constructor(private readonly eventEmitter: EventEmitter2) {}

    /**
     * Route a verified webhook delivery to its internal event name.
     * Returns `true` when an event was emitted; `false` when the body
     * was malformed or the upstream `event_type` is unmapped. Never
     * throws — see class header.
     */
    route(tenantId: string, body: unknown): boolean {
        if (!isTriggerWebhookEnvelope(body)) {
            this.logger.warn(
                `Trigger.dev webhook dropped: malformed envelope ` +
                    `(missing event_type/tenant_id/created_at/payload) ` +
                    `tenantId=${tenantId}`,
            );
            return false;
        }

        const internalEventName = TRIGGER_WEBHOOK_EVENT_TYPE_MAP[body.event_type];
        if (!internalEventName) {
            // `debug` not `warn` — Trigger.dev's alert taxonomy will
            // grow over time, and we don't want every new upstream
            // type to page operators. The line is greppable so
            // unmapped types are still discoverable.
            this.logger.debug(
                `Trigger.dev webhook dropped: unmapped event_type=${body.event_type} ` +
                    `tenantId=${tenantId}`,
            );
            return false;
        }

        if (body.tenant_id !== tenantId) {
            // Route-param wins per class header. Log loudly so a
            // misconfigured Trigger.dev project (e.g. wrong tenant
            // in the body template) gets noticed.
            this.logger.warn(
                `Trigger.dev webhook tenantId mismatch: route=${tenantId} ` +
                    `body=${body.tenant_id} — using route value`,
            );
        }

        const envelope: TriggerWebhookInternalEventPayload = {
            tenantId,
            upstreamEventType: body.event_type,
            internalEventName,
            createdAt: body.created_at,
            payload: body.payload,
        };

        this.eventEmitter.emit(internalEventName, envelope);
        return true;
    }
}
