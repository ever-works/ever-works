import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { NotificationChannel } from './notification-channel.entity';
import { PortableDateColumn } from './_types';

/**
 * Notifications v2 — Notification Channels.
 *
 * Possible delivery statuses for one channel attempt.
 */
export type NotificationChannelDeliveryStatus =
    | 'pending'
    | 'delivered'
    | 'failed'
    | 'retrying'
    | 'dropped';

/**
 * Per-attempt delivery log for `NotificationChannel.send` calls.
 * Used for:
 *
 * 1. Idempotency: lookup by `messageRef` lets the facade skip a
 *    duplicate fanout from a BullMQ retry.
 * 2. Spend / engagement rollups in the UI.
 * 3. Dead-letter inspection — `dropped` rows are surfaced to the
 *    operator as failed deliveries.
 *
 * See `docs/specs/features/notification-channels/spec.md` §4.1.
 */
@Entity({ name: 'notification_channel_delivery_log' })
@Index('idx_ncdl_channel_created', ['channelId', 'createdAt'])
@Index('idx_ncdl_message_ref', ['messageRef'])
export class NotificationChannelDeliveryLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    channelId: string;

    @ManyToOne(() => NotificationChannel, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'channelId' })
    channel?: NotificationChannel;

    @Column({ type: 'varchar', length: 120 })
    messageRef: string;

    /** From `event-subscriptions` — what event triggered this send.
     *  NULL for ad-hoc / "Test" button sends. */
    @Column({ type: 'varchar', length: 120, nullable: true })
    eventType?: string | null;

    @Column({ type: 'varchar', length: 16 })
    status: NotificationChannelDeliveryStatus;

    @Column({ type: 'varchar', length: 200, nullable: true })
    providerMessageId?: string | null;

    @Column({ type: 'text', nullable: true })
    errorMessage?: string | null;

    @Column({ type: 'int', default: 0 })
    attemptCount: number;

    @PortableDateColumn({ nullable: true })
    deliveredAt?: Date | null;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
