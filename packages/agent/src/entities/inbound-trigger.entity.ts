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
