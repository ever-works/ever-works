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

    /**
     * Attention controls (AW-13) — where the latest write of this choice came
     * from. `'matrix'` when it was saved from Settings -> Notifications, which
     * always writes the complete list for the row: an empty list there means
     * "nothing" and a list without `'in-app'` keeps the notification out of
     * the bell.
     *
     * NULL for every row stored before AW-13 and for every write through
     * `PUT /api/notifications/preferences/event/:eventKey` (API callers, the
     * chat assistant). Those rows keep their original meaning: an empty list
     * falls back to the organisation / event defaults, and the notification
     * always reaches the bell. See `notification-choice.ts`.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    origin?: string | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
