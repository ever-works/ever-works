import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    JoinColumn,
    CreateDateColumn,
    Index,
} from 'typeorm';
import type { ClassToObject } from './types';
import { PortableDateColumn } from './_types';
import { Work } from './work.entity';
import { WorkBudget } from './work-budget.entity';
// Import BudgetOwnerType from the leaf-types file (NOT from
// work-budget.entity) — see `_types.ts` for the cycle-break rationale.
import { BudgetOwnerType } from './_types';

export enum WorkBudgetAlertThreshold {
    PERCENT_75 = '75',
    PERCENT_90 = '90',
    PERCENT_100 = '100',
    OVERAGE = 'overage',
}

/**
 * EW-602 — Idempotency record for budget threshold alerts.
 *
 * One row per (budget, threshold, period) ensures the user gets exactly
 * one in-app + email notification each time spend crosses 75% / 90% /
 * 100% / overage within a billing period. Cleared/re-created on period
 * rollover.
 */
@Index(['budgetId', 'threshold', 'periodStart'], { unique: true })
@Index(['workId', 'periodStart'])
@Index('idx_work_budget_alert_states_owner', ['ownerType', 'ownerId'])
@Entity({ name: 'work_budget_alert_states' })
export class WorkBudgetAlertState {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    workId: string;

    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work: ClassToObject<Work>;

    @Column()
    budgetId: string;

    @ManyToOne(() => WorkBudget, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'budgetId' })
    budget: ClassToObject<WorkBudget>;

    @Column({ type: 'varchar', length: 16 })
    threshold: WorkBudgetAlertThreshold;

    // EW-602 fix: `type: 'timestamp'` is Postgres-only and breaks the
    // internal-cli boot under better-sqlite3 in CI. PortableDateColumn
    // (`type: Date`) lets TypeORM pick the right column type per dialect.
    @PortableDateColumn()
    periodStart: Date;

    /**
     * Polymorphic-owner discriminator (Missions/Ideas/Works spec §8.2).
     * Backfilled to `'work'` by Phase 0 PR 0.3 for existing rows.
     */
    @Column({ type: 'varchar', length: 16, default: BudgetOwnerType.WORK })
    ownerType: BudgetOwnerType;

    /**
     * UUID of the owning Work / Idea / Mission. Backfilled to
     * `workId` for existing rows. See `WorkBudget.ownerId` for
     * full rationale.
     */
    @Column({ type: 'uuid', nullable: true })
    ownerId?: string | null;

    @CreateDateColumn()
    sentAt: Date;
}
