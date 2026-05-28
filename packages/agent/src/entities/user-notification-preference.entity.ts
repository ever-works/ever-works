import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { User } from './user.entity';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * One row per user storing global quiet-hours window + timezone
 * override. Falls back to `User.timezone` (when present) when
 * `timezone` is null here.
 *
 * Quiet hours are stored as `varchar` (HH:MM:SS) not the SQLite-
 * incompatible `time` type — TypeORM's `time` column is fine on
 * Postgres but breaks the SQLite test/dev fallback path.
 *
 * See `docs/specs/features/event-subscriptions/spec.md` §5.1.
 */
@Entity({ name: 'user_notification_preferences' })
export class UserNotificationPreference {
    @PrimaryColumn({ type: 'uuid' })
    userId: string;

    @OneToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /** `HH:MM:SS` — null means no quiet-hours configured. */
    @Column({ type: 'varchar', length: 8, nullable: true })
    quietHoursStart?: string | null;

    @Column({ type: 'varchar', length: 8, nullable: true })
    quietHoursEnd?: string | null;

    /** IANA tz name (e.g. `Europe/Kyiv`). NULL → use `User.timezone`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    timezone?: string | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
