import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { TimestampColumn } from './_types';

/**
 * `disabled` (webhooks v2): the owning integration key was revoked or lost
 * access; only re-enabled by the owner, never by the delivery path.
 */
export type WebhookSubscriptionStatus = 'active' | 'paused' | 'failed' | 'disabled';

/** Webhooks v2 (EW-P1-5): who owns a v2 subscription. v1 rows are `user`-owned by `accountId`. */
export type WebhookSubscriptionOwnerType = 'user' | 'integration_key';

@Entity({ name: 'webhook_subscriptions' })
@Index(['accountId'])
@Index(['workId'])
export class WebhookSubscription {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    accountId: string;

    @Column({ type: 'uuid', nullable: true })
    workId: string | null;

    @Column({ type: 'varchar', length: 2048 })
    url: string;

    /**
     * HMAC-SHA256 signing secret, encrypted at rest.
     * x-secret: true — never log or echo this column.
     */
    @Column({ type: 'text' })
    secretEncrypted: string;

    @Column({ type: 'varchar', length: 32, default: 'active' })
    status: WebhookSubscriptionStatus;

    @Column({ type: 'int', default: 0 })
    consecutiveFailures: number;

    // ── Webhooks v2 (EW-P1-5, integration contract v1 B.5) ──────────────────
    // `version = 2` subscriptions receive domain events (the B.3 envelope) for
    // their `organizationIds`, filtered by `events` and `excludeOriginTags`,
    // signed `X-Ever-Works-Signature: t=,v1=`. `version = 1` rows (every row
    // before migration 1795080100000) keep the five work/deployment events and
    // the legacy headers; all v2 columns stay NULL on them.

    /** Subscription protocol version: 1 (legacy work/deploy events) or 2 (domain events). */
    @Column({ type: 'int', default: 1 })
    version: number;

    /** v2: `user` (created in Settings) or `integration_key` (created through the integration API). */
    @Column({ type: 'varchar', length: 32, default: 'user' })
    ownerType: WebhookSubscriptionOwnerType;

    /** v2: the owning user id or integration key (`api_keys.id`). NULL on v1 rows. */
    @Column({ type: 'uuid', nullable: true })
    ownerId?: string | null;

    /** v2: catalog types or `<domain>.*` patterns (opt-in types only by exact name). */
    @Column({ type: 'simple-json', nullable: true })
    events?: string[] | null;

    /** v2: the organizations whose events are delivered (at least one). */
    @Column({ type: 'simple-json', nullable: true })
    organizationIds?: string[] | null;

    /** v2: events whose `origin.tag` is listed here are not delivered (loop guard). */
    @Column({ type: 'simple-json', nullable: true })
    excludeOriginTags?: string[] | null;

    /**
     * v2: the change-feed head when the subscription was created — it receives
     * events with a later `seq` only (exact, unlike a creation timestamp: no
     * clock or column-precision skew). NULL = no lower bound.
     */
    @Column({ type: 'bigint', nullable: true })
    startAfterSeq?: string | null;

    /** v2: free-text note. */
    @Column({ type: 'varchar', length: 500, nullable: true })
    description?: string | null;

    /**
     * v2 secret rotation grace: the previous secret (encrypted at rest, same
     * envelope as `secretEncrypted`) keeps signing as a second `v1=` until
     * `previousSecretExpiresAt`. x-secret: true — never log or echo.
     */
    @Column({ type: 'text', nullable: true })
    previousSecretEncrypted?: string | null;

    @TimestampColumn({ nullable: true })
    previousSecretExpiresAt?: Date | null;

    @TimestampColumn({ nullable: true })
    lastDeliveryAt: Date | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs.
    // Both NULL until the owning user creates their first Organization
    // (Phase 6 lazy backfill). FK + index enforced at DB level by
    // migration 1779991006000-AddTenantIdAndOrganizationIdToTierA.
    // No @ManyToOne to avoid the entities import cycle that bit Phase 2 —
    // see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
