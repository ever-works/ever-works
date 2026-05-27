import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { TimestampColumn } from './_types';

export type WebhookSubscriptionStatus = 'active' | 'paused' | 'failed';

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
