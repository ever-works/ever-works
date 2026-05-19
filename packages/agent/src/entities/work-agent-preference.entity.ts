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

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
