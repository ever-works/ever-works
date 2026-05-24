import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    OneToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { ClassToObject } from './types';
import { User } from './user.entity';

export interface WorkAgentGuardrails {
    maxWorksPerRun: number;
    maxItemsPerWork: number;
    maxBudgetCentsPerRun: number;
    requireApprovalBeforeCreate: boolean;
    requireApprovalBeforeDelete: boolean;
    requireApprovalAboveBudgetCents: number;
    dryRunByDefault: boolean;
}

@Entity({ name: 'work_agent_preferences' })
export class WorkAgentPreference {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid', { unique: true })
    userId: string;

    @OneToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: ClassToObject<User>;

    @Column({ default: false })
    enabled: boolean;

    @Column({ default: false })
    autoApproveLowImpact: boolean;

    @Column({ default: true })
    dailySuggestionsEnabled: boolean;

    @Column('simple-json')
    guardrails: WorkAgentGuardrails;

    /**
     * User-customized cadence for the Auto-generate Ideas background
     * loop (cron expression). NULL = inherit the platform-hardcoded
     * default. Promoted from a hardcoded constant by Phase 0 PR 0.4
     * (Missions/Ideas/Works spec §6.2). The Auto-generate Ideas ⚙
     * gear on `/ideas` deep-links to a settings field that writes
     * this value.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    autoGenerateCadence?: string | null;

    /**
     * How many Ideas per Auto-generate tick. NULL = inherit
     * platform default. Promoted from a hardcoded constant by Phase
     * 0 PR 0.4 (spec §6.2).
     */
    @Column({ type: 'int', nullable: true })
    autoGenerateBatchSize?: number | null;

    /**
     * Max number of Ideas auto-built into Works per day. NULL =
     * unlimited (no throttle). Bounds the blast radius of
     * Auto-build Works. Promoted from a hardcoded constant by Phase
     * 0 PR 0.4 (spec §6.3).
     */
    @Column({ type: 'int', nullable: true })
    autoBuildThrottlePerDay?: number | null;

    /**
     * Default per-Mission outstanding-Ideas cap when the Mission
     * itself doesn't override (Mission.outstandingIdeasCap = NULL).
     * NULL on this column = inherit platform-hardcoded default (20).
     * Negative sentinel (-1) = user wants "unlimited" as their
     * account default. Promoted from a hardcoded constant by Phase
     * 0 PR 0.4 (spec §1.3, §6.3).
     */
    @Column({ type: 'int', nullable: true })
    missionDefaultOutstandingCap?: number | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
