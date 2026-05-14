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
import type { ActivityActionType, ActivityStatus } from './activity-log.types';

@Entity({ name: 'activity_log' })
@Index(['userId', 'createdAt'])
@Index(['userId', 'actionType'])
@Index(['userId', 'workId'])
@Index(['userId', 'status'])
@Index('idx_activity_log_work_ingest_event', ['workId', 'ingestEventId'], {
    unique: true,
    where: '"ingestEventId" IS NOT NULL',
})
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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
