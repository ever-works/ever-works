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
import type { ClassToObject } from './types';
import { User } from './user.entity';
import type { WorkAgentGuardrails } from './work-agent-preference.entity';

export enum WorkAgentGoalStatus {
    PENDING = 'pending',
    PLANNING = 'planning',
    WAITING_FOR_APPROVAL = 'waiting-for-approval',
    RUNNING = 'running',
    COMPLETED = 'completed',
    CANCELED = 'canceled',
    REJECTED = 'rejected',
    FAILED = 'failed',
}

export enum WorkAgentGoalSource {
    USER = 'user',
    EW584_SUGGESTION = 'ew-584-suggestion',
    SCHEDULED = 'scheduled',
}

@Entity({ name: 'work_agent_goals' })
@Index('idx_work_agent_goals_user_status_created', ['userId', 'status', 'createdAt'])
export class WorkAgentGoal {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: ClassToObject<User>;

    @Column({ type: 'text' })
    instruction: string;

    @Column({ type: 'varchar', default: WorkAgentGoalStatus.PENDING })
    status: WorkAgentGoalStatus;

    @Column({ type: 'varchar', default: WorkAgentGoalSource.USER })
    source: WorkAgentGoalSource;

    @Column({ default: false })
    dryRun: boolean;

    @Column('simple-json', { nullable: true })
    guardrailsOverride?: Partial<WorkAgentGuardrails> | null;

    @Column({ type: 'text', nullable: true })
    agentPlanSummary?: string | null;

    @Column({ type: 'text', nullable: true })
    approvalSummary?: string | null;

    /**
     * FK back to the `WorkProposal` (Idea) this Goal is building,
     * when the Goal was created by the new build-from-Idea path
     * (`POST /me/work-proposals/:id/build`, Phase 1 PR B). NULL for
     * Goals created via the existing power-user direct-queue path
     * (`POST /me/work-agent/goals`).
     *
     * Lets the Goal-completion handler join back to "the Idea this
     * Goal was building" so it can:
     *   - call `acceptInternal(ideaId, workId)` on success (and
     *     transition the Idea to ACCEPTED with the new Work),
     *   - persist `failureMessage` + `failureKind` on the Idea
     *     on failure (Phase 0 PR 0.8 / Phase 1 PR FF).
     *
     * Spec §10.6 + PLAN Decision A3.
     */
    @Column({ type: 'uuid', nullable: true })
    ideaId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
