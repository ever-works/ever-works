import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    UpdateDateColumn,
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
 *
 * Uniqueness ("one global per Work" + "one per plugin per Work") is
 * enforced by two partial unique indexes declared in
 * `1778866612310-AddWorkBudgets`: a single index on
 * `(workId, scope, pluginId)` would not work because Postgres treats
 * NULL as distinct, so the global rows (with `pluginId = NULL`) would
 * not collide. The decorator-level `@Index` is intentionally omitted
 * here to keep TypeORM's `synchronize` (used only by the in-memory
 * SQLite test driver) from generating a non-partial duplicate.
 */
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
