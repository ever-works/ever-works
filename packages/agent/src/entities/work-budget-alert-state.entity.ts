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
import { Work } from './work.entity';
import { WorkBudget } from './work-budget.entity';

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

    @Column({ type: 'timestamp' })
    periodStart: Date;

    @CreateDateColumn()
    sentAt: Date;
}
