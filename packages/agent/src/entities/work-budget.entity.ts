import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
    Index,
} from 'typeorm';
import type { ClassToObject } from './types';
import { Work } from './work.entity';

export enum WorkBudgetScope {
    /** Cap applies to total spend across all plugins for the Work */
    GLOBAL = 'global',
    /** Cap applies to a single plugin (pluginId required) */
    PLUGIN = 'plugin',
}

/**
 * EW-602 — Per-directory monthly spending cap.
 *
 * Each Work can have at most one GLOBAL budget and one PLUGIN budget per
 * pluginId. When current-period spend reaches `monthlyCapCents`, the
 * BudgetGuardService blocks subsequent plugin calls UNLESS `allowOverage`
 * is true (in which case warnings continue but the call is permitted).
 */
@Index(['workId', 'scope', 'pluginId'], { unique: true })
@Entity({ name: 'work_budgets' })
export class WorkBudget {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column({ type: 'varchar', length: 16 })
    scope: WorkBudgetScope;

    /** Required when scope = PLUGIN; null when scope = GLOBAL. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    pluginId?: string | null;

    @Column({ type: 'int' })
    monthlyCapCents: number;

    @Column({ type: 'varchar', length: 8, default: 'usd' })
    currency: string;

    @Column({ type: 'boolean', default: false })
    allowOverage: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
