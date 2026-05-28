import {
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Per-user, per-event-type channel selection.
 *
 * `channelIds` is a JSON array containing either:
 * - A `notification_channels.id` UUID (concrete channel), or
 * - The literal string `'in-app'` (built-in channel; no concrete row).
 *
 * Soft FK on `eventTypeKey` → `notification_event_types.key`
 * (no DB-level FK because plugin-contributed event types come
 * and go with plugin install/uninstall).
 *
 * See `docs/specs/features/event-subscriptions/spec.md` §5.1.
 */
@Entity({ name: 'user_notification_subscriptions' })
@Index('uq_user_notification_subscription', ['userId', 'eventTypeKey'], { unique: true })
export class UserNotificationSubscription {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 120 })
    eventTypeKey: string;

    /** Array of channel-row UUIDs and/or the literal `'in-app'`. */
    @Column({ type: 'simple-json' })
    channelIds: string[];

    @UpdateDateColumn()
    updatedAt: Date;
}
