import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
} from 'typeorm';
import { User } from './user.entity';
import { Work } from './work.entity';
import type { ActivityActionType, ActivityActorKind, ActivityStatus } from './activity-log.types';

@Entity({ name: 'activity_log' })
@Index(['userId', 'createdAt'])
@Index(['userId', 'actionType'])
@Index(['userId', 'workId'])
@Index(['userId', 'status'])
@Index('idx_activity_log_work_ingest_event', ['workId', 'ingestEventId'], {
    unique: true,
    where: '"ingestEventId" IS NOT NULL',
})
// Live Feed — the keyset page (`ORDER BY createdAt DESC, id DESC`) and the
// per-agent filter / actor roster. Shipped by
// 1791040000000-AddActivityLogFeedActor.
@Index('idx_activity_log_user_created_id', ['userId', 'createdAt', 'id'])
@Index('idx_activity_log_user_actor_created', ['userId', 'actorAgentId', 'createdAt'])
export class ActivityLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    @Index()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ nullable: true })
    workId?: string;

    @ManyToOne(() => Work, { onDelete: 'SET NULL', nullable: true })
    @JoinColumn({ name: 'workId' })
    work?: Work;

    @Column({ type: 'varchar', length: 50 })
    actionType: ActivityActionType;

    @Column({ type: 'varchar', length: 100 })
    action: string;

    @Column({ type: 'varchar', length: 50 })
    status: ActivityStatus;

    @Column({ type: 'varchar', length: 500 })
    summary: string;

    @Column({ type: 'simple-json', nullable: true })
    details?: Record<string, any>;

    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, any>;

    /**
     * Idempotency key for events ingested from the deployed directory site
     * via POST /api/activity-log/ingest (EW-120). The composite unique
     * index on (workId, ingestEventId) prevents duplicate rows when the
     * website retries a POST.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    ingestEventId?: string;

    @Column({ type: 'varchar', nullable: true })
    ipAddress?: string;

    @Column({ type: 'varchar', nullable: true })
    userAgent?: string;

    // Tenant + Organization scope FKs (EW-657 Tier C denormalization).
    // No @ManyToOne — cycle-avoidance, see user.entity.ts EW-654 comment.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /**
     * Live Feed — who did it. NULL on rows written before this column
     * existed; the feed resolves those at read time from `details` and the
     * action type, so there is deliberately no backfill.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    actorKind?: ActivityActorKind | null;

    /**
     * The acting agent. No @ManyToOne, by the same convention as the scope
     * columns above: deleting an Agent must not rewrite history, so
     * `actorLabel` stays the display source of truth for a deleted agent.
     */
    @Column({ type: 'uuid', nullable: true })
    actorAgentId?: string | null;

    /** The actor's display name captured when the record was written. */
    @Column({ type: 'varchar', length: 120, nullable: true })
    actorLabel?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
