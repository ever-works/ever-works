import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Source of a registered event type.
 *
 * - `core` — declared by the platform itself (existing v1 dedup keys
 *   + the small expansion set in Phase 1).
 * - `plugin` — contributed by a plugin via `everworks.plugin.events`
 *   on the plugin manifest. `pluginId` is then set.
 *
 * See `docs/specs/features/event-subscriptions/spec.md` §3 / §5.
 */
export type NotificationEventTypeSource = 'core' | 'plugin';

/**
 * Registry of notification event types. The Settings → Notifications
 * preference matrix is rendered from this table at request time so
 * newly-registered plugin event types appear without a UI deploy.
 *
 * `key` is the PK (also the soft FK target from
 * `user_notification_subscriptions.eventTypeKey`).
 */
@Entity({ name: 'notification_event_types' })
@Index('idx_notification_event_type_category', ['category'])
export class NotificationEventType {
    /** e.g. `ai_credits_depleted`, `work_generation_finished`. */
    @PrimaryColumn({ type: 'varchar', length: 120 })
    key: string;

    /** Matches `NotificationCategory` (string for forward-compat with
     *  plugin-contributed categories). */
    @Column({ type: 'varchar', length: 64 })
    category: string;

    @Column({ type: 'varchar', length: 200 })
    title: string;

    @Column({ type: 'text' })
    description: string;

    /** `true` → bypass quiet hours. */
    @Column({ type: 'boolean', default: false })
    urgent: boolean;

    /** e.g. `['in-app']` or `['in-app', 'email']`. */
    @Column({ type: 'simple-json', default: () => "'[\"in-app\"]'" })
    defaultChannels: string[];

    @Column({ type: 'varchar', length: 16, default: 'core' })
    source: NotificationEventTypeSource;

    /** Only set when `source='plugin'`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    pluginId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
