import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { TimestampColumn } from './_types';

/** Delivery style the trigger was created for (informational — both fire the same endpoint). */
export type InboundTriggerKind = 'webhook' | 'api';

export type InboundTriggerStatus = 'active' | 'paused';

/**
 * What fires the trigger:
 *  - `'webhook'` — the signed `POST /api/inbound-triggers/:id/fire`
 *    endpoint (the original delivery path; still the default).
 *  - `'event'`  — the ingest spine: every `ingested_events` row drained
 *    by `EventIngestService.processBatch` is offered to the owner's
 *    active event triggers and fires the ones whose `eventMatcher`
 *    matches.
 */
export type InboundTriggerSourceType = 'webhook' | 'event';

/**
 * What a fire PRODUCES — locked at create time (see the `mode` column):
 *  - `'single-task'` — one Task built from `agentPrompt`, with the
 *    delivery payload appended in a neutralized `<webhook_body>` block.
 *  - `'template'` — the Task is built from the `taskTemplateSlug`
 *    linkage (the Template-DAG mode; resolved lazily, see that column).
 */
export type InboundTriggerMode = 'single-task' | 'template';

/**
 * Whether the first Task a fire produces is dispatched immediately
 * (`'always'`, the default) or parked in the backlog for a human to
 * start (`'manual'`).
 */
export type InboundTriggerAutoStart = 'always' | 'manual';

/**
 * One value the trigger expects to find in the delivery payload's top
 * level. `required` variables that are missing REFUSE the fire (the
 * reason is written to the fire log); optional ones are advisory and
 * exist so the UI can label the payload contract.
 */
export interface InboundTriggerVariable {
    /** Top-level payload key — `[A-Za-z0-9_-]{1,64}`. */
    key: string;
    /** Human label for the UI; falls back to `key`. */
    label?: string;
    required: boolean;
}

/**
 * Matcher an `'event'`-sourced trigger applies to each ingested event.
 * Keys are whitelisted (nothing else is ever consulted): `source` and
 * `kind` support a trailing-`*` wildcard (`github.*`) or a lone `*`;
 * `workId` is an exact uuid match. An omitted key matches anything; a
 * matcher with NO keys matches nothing (defensive — an event trigger
 * must say what it listens for).
 */
export interface InboundTriggerEventMatcher {
    /** Producing plugin id, e.g. `slack-connector`; trailing `*` wildcard allowed. */
    source?: string;
    /** Source-namespaced kind, e.g. `github.push`; trailing `*` wildcard allowed. */
    kind?: string;
    /** Exact Work uuid the event was routed to. */
    workId?: string;
}

/**
 * Inbound Triggers ("Trigger Schedules") — event-driven ops without polling.
 *
 * One row per named trigger an org member creates. The platform hands the
 * creator a signed webhook URL (`POST /api/inbound-triggers/:id/fire`);
 * an external system POSTs to it, the platform verifies the HMAC-SHA256
 * signature + replay window, and spawns a Task (optionally assigned to
 * `targetAgentId`).
 *
 * Secret model mirrors `webhook_subscriptions.secretEncrypted`: the HMAC
 * signing secret is AES-256-GCM-encrypted at rest via
 * `WebhookSubscriptionSecretService` (PLATFORM_ENCRYPTION_KEY envelope)
 * and the raw value is returned ONCE on create / rotate. Rotation keeps
 * the previous secret accepted for a 24h grace window
 * (`previousSecretEncrypted` + `rotatedAt`) so external senders can roll
 * without a hard cutover.
 *
 * Tier A scope shape (EW-655): nullable `tenantId` / `organizationId`
 * uuid columns auto-stamped by `ScopeStampingSubscriber`; `userId` and
 * `targetAgentId` are RAW uuid columns (no @ManyToOne — cycle avoidance
 * per EW-654); FKs + indexes live in migration
 * `1782100000000-CreateInboundTriggers`.
 */
@Entity({ name: 'inbound_triggers' })
@Index('idx_inbound_triggers_user', ['userId'])
@Index('idx_inbound_triggers_org_status', ['organizationId', 'status'])
export class InboundTrigger {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owning user (raw uuid — FK in the migration). */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'varchar', length: 120 })
    name: string;

    @Column({ type: 'text', nullable: true })
    description: string | null;

    @Column({ type: 'varchar', length: 16, default: 'webhook' })
    kind: InboundTriggerKind;

    @Column({ type: 'varchar', length: 16, default: 'active' })
    status: InboundTriggerStatus;

    /**
     * HMAC-SHA256 signing secret, encrypted at rest.
     * x-secret: true — never log or echo this column.
     */
    @Column({ type: 'text' })
    secretEncrypted: string;

    /**
     * Previous signing secret (encrypted) — accepted alongside the current
     * one for ROTATION_GRACE_MS (24h) after `rotatedAt`, then dead.
     * x-secret: true — never log or echo this column.
     */
    @Column({ type: 'text', nullable: true })
    previousSecretEncrypted: string | null;

    /** When the secret was last rotated (starts the 24h grace window). */
    @TimestampColumn({ nullable: true })
    rotatedAt: Date | null;

    /**
     * What fires this trigger — `'webhook'` (signed endpoint, default)
     * or `'event'` (ingest-spine matching via `eventMatcher`).
     * Immutable after create, like `kind`.
     */
    @Column({ type: 'varchar', length: 16, default: 'webhook' })
    sourceType: InboundTriggerSourceType;

    /**
     * Ingest-event matcher for `'event'`-sourced triggers; null for
     * webhook triggers. See {@link InboundTriggerEventMatcher}.
     */
    @Column({ type: 'simple-json', nullable: true })
    eventMatcher: InboundTriggerEventMatcher | null;

    /** Optional Agent assigned to spawned Tasks (raw uuid — FK in the migration). */
    @Column({ type: 'uuid', nullable: true })
    targetAgentId: string | null;

    /** Title template for spawned Tasks; `{name}` → trigger name. Defaults to 'Trigger: {name}'. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    taskTitleTemplate: string | null;

    /**
     * Description template for spawned Tasks. Supports the same safe
     * `{{event.*}}` placeholder set as the title (see
     * `triggers/trigger-template.ts`); null keeps the built-in
     * payload-dump description.
     */
    @Column({ type: 'text', nullable: true })
    taskDescriptionTemplate: string | null;

    /**
     * What a fire produces — IMMUTABLE after create (a trigger that
     * changed shape mid-life would silently rewrite what every future
     * delivery does). `'template'` requires `taskTemplateSlug`.
     */
    @Column({ type: 'varchar', length: 16, default: 'single-task' })
    mode: InboundTriggerMode;

    /**
     * `'single-task'` mode instructions for the agent. The delivery
     * payload is appended to this prompt inside a neutralized
     * `<webhook_body>` block (see `triggers/trigger-prompt.ts`) — the
     * payload is DATA, never instructions.
     */
    @Column({ type: 'text', nullable: true })
    agentPrompt: string | null;

    /**
     * When true the primary Task a fire produces shows on the Kanban
     * board; when false it is created with `tasks.hiddenFromBoard` set
     * so automated noise stays out of the human board. Child tasks are
     * never surfaced by this flag.
     */
    @Column({ type: 'boolean', default: false })
    showOnBoard: boolean;

    /**
     * Per-trigger replay window in SECONDS. Governs both webhook-path
     * gates: how stale `x-everworks-timestamp` may be, and how long a
     * repeated delivery id is treated as a duplicate. Clamped to
     * `MIN/MAX_REPLAY_WINDOW_SEC` at write time.
     */
    @Column({ type: 'int', default: 300 })
    replayWindowSec: number;

    /** `'always'` dispatches the first Task; `'manual'` leaves it in the backlog. */
    @Column({ type: 'varchar', length: 16, default: 'always' })
    autoStart: InboundTriggerAutoStart;

    /**
     * Payload contract — `[{key, label?, required}]`. A fire whose
     * payload is missing a `required` key is REFUSED and the reason is
     * recorded in the fire log. See {@link InboundTriggerVariable}.
     */
    @Column({ type: 'simple-json', nullable: true })
    defaultVariables: InboundTriggerVariable[] | null;

    /**
     * RESERVED linkage to `task_templates` (feature I, parallel branch)
     * — a string slug on purpose, resolved lazily at fire time through
     * the optional `TASK_TEMPLATE_LOOKUP` port so this column works
     * standalone today and lights up when the templates table merges.
     * Never a FK.
     */
    @Column({ type: 'varchar', length: 80, nullable: true })
    taskTemplateSlug: string | null;

    @TimestampColumn({ nullable: true })
    lastFiredAt: Date | null;

    @Column({ type: 'int', default: 0 })
    fireCount: number;

    // Tier A scope FKs (EW-655) — nullable, auto-stamped on insert by
    // ScopeStampingSubscriber. No @ManyToOne to avoid the entities
    // import cycle that bit Phase 2 — see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
