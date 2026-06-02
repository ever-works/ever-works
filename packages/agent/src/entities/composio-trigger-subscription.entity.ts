import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { PortableDateColumn } from './_types';

/**
 * One row per user-installed Composio trigger.
 *
 * A *trigger* is Composio's webhook event surface (`GMAIL_NEW_EMAIL`,
 * `SLACK_NEW_MESSAGE`, `GITHUB_NEW_STAR`, …). Each enabled trigger
 * fires HTTP POSTs to `/api/plugins/composio/webhook`. This table
 * tracks which triggers the user has enabled, plus the per-trigger
 * HMAC secret used to verify inbound deliveries.
 *
 * `composioTriggerId` is the Composio-assigned nanoid (`tg_*`) — it
 * is the primary lookup key when verifying a webhook delivery. A
 * Composio account can only subscribe to a given (toolkit, trigger)
 * pair once per user, hence the unique index.
 *
 * See `docs/specs/features/composio-triggers/spec.md` (EW-684 PR-D).
 */
@Entity({ name: 'composio_trigger_subscriptions' })
@Index('uq_composio_trigger_subscription', ['userId', 'toolkitSlug', 'triggerSlug'], {
    unique: true,
})
@Index('uq_composio_trigger_subscription_remote', ['composioTriggerId'], { unique: true })
@Index('idx_composio_trigger_subscription_user', ['userId'])
export class ComposioTriggerSubscription {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /** Composio toolkit slug, uppercase (`GMAIL`, `SLACK`, …). */
    @Column({ type: 'varchar', length: 64 })
    toolkitSlug: string;

    /** Composio trigger slug, uppercase (`GMAIL_NEW_EMAIL`, …). */
    @Column({ type: 'varchar', length: 128 })
    triggerSlug: string;

    /** Composio trigger nanoid (`tg_*`). Stable identifier for webhook lookup. */
    @Column({ type: 'varchar', length: 64 })
    composioTriggerId: string;

    /** Composio connected-account id (`ca_*`) the trigger was bound to. */
    @Column({ type: 'varchar', length: 64 })
    composioConnectedAccountId: string;

    /**
     * Security: this field is vestigial — it is random noise generated only
     * to satisfy the NOT NULL constraint. Actual Composio webhook signature
     * verification uses the project-level webhook secret resolved from plugin
     * settings at verify time (see ComposioService.verifyWebhook), NOT this
     * per-subscription value. This column is never surfaced in API responses
     * and should be dropped in a future migration once the NOT NULL constraint
     * is removed.
     *
     * @deprecated vestigial; do NOT use for any HMAC/signature purpose.
     */
    @Column({ type: 'varchar', length: 128 })
    webhookSecret: string;

    /** Per-trigger config (filters, polling cadence, …) — passthrough to Composio. */
    @Column({ type: 'simple-json', nullable: true })
    config?: Record<string, unknown> | null;

    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    @PortableDateColumn({ nullable: true })
    lastFiredAt?: Date | null;

    @Column({ type: 'integer', default: 0 })
    deliveriesReceived: number;

    @Column({ type: 'integer', default: 0 })
    deliveriesRejected: number;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
