import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { User } from './user.entity';
import { NotificationType, NotificationCategory } from './notification.types';
import { TimestampColumn } from './_types';

@Entity({ name: 'notifications' })
@Index(['userId', 'isRead'])
@Index(['userId', 'deduplicationKey'], { unique: true })
export class Notification {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    @Index()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ type: 'varchar', length: 50 })
    type: NotificationType;

    @Column({ type: 'varchar', length: 100 })
    category: NotificationCategory;

    @Column({ type: 'varchar', length: 200 })
    title: string;

    @Column({ type: 'text' })
    message: string;

    @Column({ type: 'varchar', length: 255, nullable: true })
    actionUrl?: string;

    @Column({ type: 'varchar', length: 50, nullable: true })
    actionLabel?: string;

    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, any>;

    @Column({ default: false })
    isRead: boolean;

    @Column({ default: false })
    isDismissed: boolean;

    @Column({ default: false })
    isPersistent: boolean;

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

    @Index()
    @TimestampColumn({ nullable: true })
    expiresAt?: Date;

    @Column({ type: 'varchar', length: 100, nullable: true })
    deduplicationKey?: string;
}
