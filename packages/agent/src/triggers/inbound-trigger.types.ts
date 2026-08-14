import type {
    InboundTriggerEventMatcher,
    InboundTriggerKind,
    InboundTriggerSourceType,
    InboundTriggerStatus,
} from '../entities/inbound-trigger.entity';

/**
 * Inbound Triggers ("Trigger Schedules") — shared constants + service
 * contract types. Kept next to the service so the API controller, the
 * schedules aggregation, and the specs all consume one vocabulary.
 */

/** Max age (either direction) of `x-everworks-timestamp` at fire time. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** How long the previous secret keeps verifying after a rotation. */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/** Hard cap on the fire payload size (raw bytes). */
export const MAX_FIRE_PAYLOAD_BYTES = 64 * 1024;

/** Task title used when the trigger has no custom template. `{name}` → trigger name. */
export const DEFAULT_TASK_TITLE_TEMPLATE = 'Trigger: {name}';

/** Label stamped on Tasks spawned by `testFire` so they are unmistakably rehearsals. */
export const TRIGGER_TEST_LABEL = 'trigger-test';

/** Hard cap on stored description templates (matches the API DTO). */
export const MAX_TASK_DESCRIPTION_TEMPLATE_LENGTH = 4000;

/** `taskTemplateSlug` shape — kebab-case slug, max 80 (matches the reserved column). */
export const TASK_TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Hex HMAC-SHA256 over `${timestamp}.${rawBody}` (optionally `sha256=`-prefixed). */
export const INBOUND_TRIGGER_SIGNATURE_HEADER = 'x-everworks-signature';

/** Unix epoch seconds (milliseconds also accepted) — the value that was signed. */
export const INBOUND_TRIGGER_TIMESTAMP_HEADER = 'x-everworks-timestamp';

/** Caller scope for management routes — mirrors `ScheduleScope` (Tier A read conventions). */
export interface InboundTriggerScope {
    userId: string;
    /** Active Organization id, or null for the bare-Tenant (personal) scope. */
    organizationId: string | null;
}

/** Secret-free projection returned by every management read. */
export interface InboundTriggerView {
    id: string;
    name: string;
    description: string | null;
    kind: InboundTriggerKind;
    status: InboundTriggerStatus;
    /** `'webhook'` (signed endpoint) or `'event'` (ingest-spine matching). */
    sourceType: InboundTriggerSourceType;
    /** Ingest matcher for `'event'` triggers; null otherwise. */
    eventMatcher: InboundTriggerEventMatcher | null;
    targetAgentId: string | null;
    taskTitleTemplate: string | null;
    taskDescriptionTemplate: string | null;
    /** Reserved template linkage (feature I) — slug, resolved lazily at fire time. */
    taskTemplateSlug: string | null;
    /** ISO 8601, or null when the trigger never fired. */
    lastFiredAt: string | null;
    fireCount: number;
    /** ISO 8601, or null when the secret was never rotated. */
    rotatedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateInboundTriggerInput {
    name: string;
    description?: string | null;
    kind?: InboundTriggerKind;
    /** Defaults to `'webhook'`. Immutable after create (like `kind`). */
    sourceType?: InboundTriggerSourceType;
    /** Required (non-empty) when `sourceType === 'event'`. */
    eventMatcher?: InboundTriggerEventMatcher | null;
    targetAgentId?: string | null;
    taskTitleTemplate?: string | null;
    taskDescriptionTemplate?: string | null;
    taskTemplateSlug?: string | null;
}

export interface UpdateInboundTriggerInput {
    name?: string;
    description?: string | null;
    /** For `'event'` triggers only; `null` is rejected (a matcher is required). */
    eventMatcher?: InboundTriggerEventMatcher | null;
    /** `null` clears the assignment. */
    targetAgentId?: string | null;
    taskTitleTemplate?: string | null;
    /** `null` reverts to the built-in payload-dump description. */
    taskDescriptionTemplate?: string | null;
    /** `null` clears the reserved template linkage. */
    taskTemplateSlug?: string | null;
}

/** Raw fire-request material — verified inside the service, never pre-parsed. */
export interface FireInboundTriggerInput {
    /** Exact raw request body the sender signed. */
    rawBody: string;
    /** `x-everworks-signature` header value (hex, optional `sha256=` prefix). */
    signatureHeader: string | undefined;
    /** `x-everworks-timestamp` header value — the exact string that was signed. */
    timestampHeader: string | undefined;
    /** Request Content-Type; JSON types get a payload-shape check. */
    contentType?: string | undefined;
}

export interface FireInboundTriggerResult {
    ok: true;
    taskId: string;
    taskSlug: string;
}

/** `testFire` — a real Task, labelled {@link TRIGGER_TEST_LABEL}; counters untouched. */
export interface TestFireInboundTriggerResult {
    ok: true;
    taskId: string;
    taskSlug: string;
    /** Rendered title, so the UI can show what the trigger would produce. */
    taskTitle: string;
}

/** Outcome of offering one ingested event to a user's event triggers. */
export interface FireForEventResult {
    /** Triggers that matched AND won the `(trigger, event)` claim. */
    fired: number;
    /** Triggers that matched but had already claimed this event. */
    deduped: number;
    /** Matching triggers whose fire failed (logged, never thrown). */
    failed: number;
}
