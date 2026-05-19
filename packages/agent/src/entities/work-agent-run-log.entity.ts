import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { WorkAgentRun } from './work-agent-run.entity';
import type { ClassToObject } from './types';
import { User } from './user.entity';

export enum WorkAgentRunLogLevel {
    INFO = 'info',
    WARNING = 'warning',
    ERROR = 'error',
}

@Entity({ name: 'work_agent_run_logs' })
@Index('idx_work_agent_run_logs_run_created', ['runId', 'createdAt'])
export class WorkAgentRunLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: ClassToObject<User>;

    @Column('uuid')
    runId: string;

    @ManyToOne(() => WorkAgentRun, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'runId' })
    run?: ClassToObject<WorkAgentRun>;

    @Column({ type: 'varchar', default: WorkAgentRunLogLevel.INFO })
    level: WorkAgentRunLogLevel;

    @Column({ type: 'varchar', length: 80 })
    step: string;

    @Column({ type: 'text' })
    message: string;

    @Column('simple-json', { nullable: true })
    metadata?: Record<string, unknown> | null;

    @CreateDateColumn()
    createdAt: Date;
}
