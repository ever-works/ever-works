import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { WorkAgentGoal } from './work-agent-goal.entity';
import { TimestampColumn } from './_types';
import type { ClassToObject } from './types';
import { User } from './user.entity';

export enum WorkAgentRunStatus {
    QUEUED = 'queued',
    PLANNING = 'planning',
    RESEARCHING = 'researching',
    GENERATING = 'generating',
    WRITING = 'writing',
    WAITING_FOR_APPROVAL = 'waiting-for-approval',
    COMPLETED = 'completed',
    CANCELED = 'canceled',
    FAILED = 'failed',
}

export interface WorkAgentRunSummary {
    worksPlanned: number;
    worksCreated: number;
    itemsPlanned: number;
    itemsCreated: number;
    approvalsRequired: number;
    estimatedRemainingSeconds?: number;
}

@Entity({ name: 'work_agent_runs' })
@Index('idx_work_agent_runs_user_status_created', ['userId', 'status', 'createdAt'])
export class WorkAgentRun {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: ClassToObject<User>;

    @Column('uuid')
    goalId: string;

    @ManyToOne(() => WorkAgentGoal, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'goalId' })
    goal?: ClassToObject<WorkAgentGoal>;

    @Column({ type: 'varchar', default: WorkAgentRunStatus.QUEUED })
    status: WorkAgentRunStatus;

    @Column({ default: false })
    dryRun: boolean;

    @Column({ type: 'int', default: 0 })
    progressPercent: number;

    @Column('simple-json')
    summary: WorkAgentRunSummary;

    @TimestampColumn({ nullable: true })
    startedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    finishedAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    error?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
