import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Task, type TaskActorType } from './task.entity';

export type TaskReviewState = 'pending' | 'requested-changes' | 'approved';

/**
 * Tasks feature — Phase 11.2. Reviewers act as advisors before
 * approval; their state is a soft signal rather than a gate.
 */
@Entity({ name: 'task_reviewers' })
@Index('uq_task_reviewer', ['taskId', 'reviewerType', 'reviewerId'], { unique: true })
@Index('idx_task_reviewer_actor', ['reviewerType', 'reviewerId'])
export class TaskReviewer {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    taskId: string;

    @ManyToOne(() => Task, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task?: Task;

    @Column({ length: 8 })
    reviewerType: TaskActorType;

    @Column({ type: 'uuid' })
    reviewerId: string;

    @Column({ type: 'varchar', length: 24, default: "'pending'" })
    reviewState: TaskReviewState;

    @Column({ type: 'timestamp', nullable: true })
    reviewedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
