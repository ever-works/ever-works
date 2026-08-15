import type {
    InboundTriggerAutoStart,
    InboundTriggerEventMatcher,
    InboundTriggerKind,
    InboundTriggerMode,
    InboundTriggerSourceType,
    InboundTriggerStatus,
    InboundTriggerVariable,
} from '../entities/inbound-trigger.entity';
import type {
    InboundTriggerFireOrigin,
    InboundTriggerFireStatus,
} from '../entities/inbound-trigger-fire.entity';

/**
 * Inbound Triggers ("Trigger Schedules") — shared constants + service
 * contract types. Kept next to the service so the API controller, the
 * schedules aggregation, and the specs all consume one vocabulary.
 */

/**
 * Max age (either direction) of `x-everworks-timestamp` at fire time,
 * for triggers with no per-trigger `replayWindowSec` (rows predating
 * that column). Same value as `DEFAULT_REPLAY_WINDOW_SEC`.
 */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Per-trigger replay window default, in seconds. */
export const DEFAULT_REPLAY_WINDOW_SEC = 300;

/** Per-trigger replay window bounds — 10s to 24h. */
export const MIN_REPLAY_WINDOW_SEC = 10;
export const MAX_REPLAY_WINDOW_SEC = 24 * 60 * 60;

/** Header an external sender may use to name its delivery (dedupe identity). */
export const INBOUND_TRIGGER_DELIVERY_HEADER = 'x-everworks-delivery';

/** How many fire-log rows a trigger detail page shows. */
export const RECENT_FIRES_LIMIT = 50;

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

/**
 * Caller-supplied variable declaration. `required` defaults to false, so
 * the API DTO can leave it off; the service canonicalizes to the stored
 * {@link InboundTriggerVariable} shape.
 */
export interface InboundTriggerVariableInput {
    key: string;
    label?: string;
    required?: boolean;
}

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
    /** What a fire produces — locked at create time. */
    mode: InboundTriggerMode;
    /** `'single-task'` instructions; the payload is appended in a `<webhook_body>` block. */
    agentPrompt: string | null;
    /** Primary Task of a fire shows on the Kanban board. */
    showOnBoard: boolean;
    /** Per-trigger replay window (timestamp freshness + duplicate suppression). */
    replayWindowSec: number;
    /** `'always'` dispatches the first Task; `'manual'` parks it in the backlog. */
    autoStart: InboundTriggerAutoStart;
    /** Declared payload contract; `required` keys gate the fire. */
    defaultVariables: InboundTriggerVariable[] | null;
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
    /**
     * Defaults to `'single-task'`. IMMUTABLE after create — deliberately
     * absent from {@link UpdateInboundTriggerInput}.
     */
    mode?: InboundTriggerMode;
    agentPrompt?: string | null;
    showOnBoard?: boolean;
    /** Clamped to MIN/MAX_REPLAY_WINDOW_SEC. */
    replayWindowSec?: number;
    autoStart?: InboundTriggerAutoStart;
    defaultVariables?: InboundTriggerVariableInput[] | null;
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
    /** `'single-task'` instructions; `null` clears them. */
    agentPrompt?: string | null;
    showOnBoard?: boolean;
    replayWindowSec?: number;
    autoStart?: InboundTriggerAutoStart;
    /** `null` clears the payload contract. */
    defaultVariables?: InboundTriggerVariableInput[] | null;
    // NOTE: `mode` is absent ON PURPOSE — it is locked at create time.
}

/** One row of the trigger's recent-fires log. */
export interface InboundTriggerFireView {
    id: string;
    origin: InboundTriggerFireOrigin;
    status: InboundTriggerFireStatus;
    /** Why a refused/failed fire produced nothing; never carries payload values. */
    reason: string | null;
    taskId: string | null;
    /** ISO 8601. */
    firedAt: string;
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
    /**
     * `x-everworks-delivery` — the sender's id for THIS delivery. When
     * present it is the dedupe identity inside the replay window; when
     * absent the request signature stands in (a byte-identical retry
     * signs identically).
     */
    deliveryHeader?: string | undefined;
}

export interface FireInboundTriggerResult {
    ok: true;
    /** Null only when a duplicate delivery matched a fire that produced no Task. */
    taskId: string | null;
    /** Null on the duplicate path (the original Task's slug is not re-read). */
    taskSlug: string | null;
    /**
     * True when the delivery was recognized as a duplicate inside the
     * trigger's replay window — the ids point at the ORIGINAL fire's
     * Task and no new work was created. Senders that retry get a 200
     * with the same task, not a second one.
     */
    duplicate?: boolean;
}

/** `fireNow` — an owner-initiated real fire (counters bump, dispatch honours autoStart). */
export interface FireNowInboundTriggerResult {
    ok: true;
    taskId: string;
    taskSlug: string;
    taskTitle: string;
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
    /**
     * Triggers that matched but refused the event on their own declared
     * contract (a missing required variable). Not a failure — the reason
     * is recorded in the trigger's fire log.
     */
    refused: number;
}
