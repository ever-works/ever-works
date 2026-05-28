import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { PortableDateColumn } from './_types';

/**
 * Notifications v2 — Event Subscriptions.
 *
 * Per-(user, category) temporary or indefinite mute.
 * `mutedUntil = NULL` ⇒ indefinite (until explicitly unmuted).
 *
 * When active:
 * - Non-`in-app` channels are dropped from the resolver output.
 * - In-app delivery still happens so the user can retrospectively
 *   review what was muted.
 *
 * See `docs/specs/features/event-subscriptions/spec.md` §5.1.
 */
@Entity({ name: 'user_notification_category_mutes' })
@Index('uq_user_notification_category_mute', ['userId', 'category'], { unique: true })
export class UserNotificationCategoryMute {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 64 })
    category: string;

    /** NULL ⇒ indefinite. */
    @PortableDateColumn({ nullable: true })
    mutedUntil?: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
