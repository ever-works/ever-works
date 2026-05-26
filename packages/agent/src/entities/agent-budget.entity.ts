import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Per-Agent spending interval (agents/spec.md §3.4, operator N6 override
 * round 9 — all 5 values ship in v1; aggregator added in
 * `BudgetService.getCurrentPeriodStart` / `getNextPeriodStart`).
 *
 * - `hour` / `day` / `week` — rolling periods anchored at `intervalAnchor`.
 * - `month`                  — calendar-month-UTC boundary (matches existing
 *                              `WorkBudget` semantics); `intervalAnchor`
 *                              ignored on read.
 * - `unlimited`              — never resets; sentinel for "no cap by time".
 */
export type AgentBudgetIntervalUnit = 'hour' | 'day' | 'week' | 'month' | 'unlimited';

/**
 * Per-Agent budget (agents/plan.md §3.1, ADR-013 budget integration).
 *
 * Reuses the polymorphic `BudgetOwnerType.AGENT` value (see `_types.ts`)
 * so `BudgetGuardService` checks Agent caps through the same SQL path as
 * Work/Mission/Idea budgets. The aggregator over `plugin_usage_events`
 * filters by `agentId` directly.
 *
 * Uniqueness: one budget row per Agent.
 *
 * Cascade: deletes with the Agent.
 */
@Entity({ name: 'agent_budgets' })
@Index('uq_agent_budgets_agentId', ['agentId'], { unique: true })
export class AgentBudget {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    agentId: string;

    @Column({ type: 'varchar', length: 16 })
    intervalUnit: AgentBudgetIntervalUnit;

    /**
     * UTC anchor timestamp for sub-month intervals (hour/day/week). Periods
     * roll forward from here (e.g. created at 09:42 UTC with `intervalUnit
     * = 'hour'` ⇒ resets at 10:42, 11:42, …). NULL for `month` (calendar
     * boundary) and `unlimited`.
     */
    @PortableDateColumn({ nullable: true })
    intervalAnchor?: Date | null;

    @Column({ type: 'int' })
    capCents: number;

    @Column({ length: 3, default: 'usd' })
    currency: string;

    /**
     * When true, the budget guard logs a warning but does NOT short-circuit
     * an AI call that would cross the cap. Useful for "soft" budgets where
     * the user wants visibility, not blocking.
     */
    @Column({ type: 'boolean', default: false })
    allowOverage: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
