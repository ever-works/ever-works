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
import { User } from './user.entity';
import { PortableDateColumn } from './_types';

/**
 * Goal lifecycle states (Goals & Metrics spec §3.2, PR-8).
 *
 * `DRAFT`     — created but not yet evaluated; the dispatcher ignores it.
 * `ACTIVE`    — evaluated on schedule by the goal-evaluate-dispatcher.
 * `PAUSED`    — user paused; dispatcher skips it, samples stop.
 * `COMPLETED` — terminal-ish; carries an `outcome`. Human-overridable:
 *               a completed Goal can be re-activated (clearing outcome).
 */
export enum GoalStatus {
    DRAFT = 'draft',
    ACTIVE = 'active',
    PAUSED = 'paused',
    COMPLETED = 'completed',
}

/**
 * How a Goal ended (spec FR-13). Auto-set by evaluation (`ACHIEVED`
 * when the comparator is satisfied, `MISSED` when the deadline passes
 * unmet) and ALWAYS human-overridable via PATCH — including
 * `ABANDONED`, which only a human sets.
 */
export enum GoalOutcome {
    ACHIEVED = 'achieved',
    MISSED = 'missed',
    ABANDONED = 'abandoned',
}

/**
 * Direction of the target comparison:
 *   `gte` — achieved when observed value >= targetValue (grow metrics:
 *           income, signups).
 *   `lte` — achieved when observed value <= targetValue (shrink
 *           metrics: churn, error rate, spend).
 */
export type GoalComparator = 'gte' | 'lte';

/**
 * Aggregation window the Goal's metric is read over. Mirrors the
 * `MetricWindow` union from `@ever-works/plugin` (metrics-provider
 * capability, PR-7) — duplicated here as a plain string union so the
 * entities barrel stays dependency-free (it must import nothing but
 * TypeORM + sibling entities; see `_types.ts` cycle notes).
 */
export type GoalWindow = 'day' | 'week' | 'month' | 'total' | 'point';

/**
 * Which metric this Goal tracks — resolved through the
 * `MetricsFacadeService` (PR-7) at evaluation time.
 *
 * `pluginId` — the metrics-provider plugin (e.g. `'stripe'`,
 *   `'custom-http'`). Explicit by design: multiple metrics providers
 *   can be enabled at once (spec FR-3), so a Goal always names its
 *   provider rather than relying on a scope default.
 * `metricId` — a `MetricDescriptor.id` served by that provider
 *   (e.g. `'income'`, `'balance'`).
 * `params`   — optional per-query parameters validated by the
 *   provider's `paramsSchema` (e.g. a currency filter).
 */
export interface GoalMetricSource {
    pluginId: string;
    metricId: string;
    params?: Record<string, unknown>;
}

/**
 * A measurable target — "income >= $1000/month via Stripe" — evaluated
 * automatically against real business metrics (Goals & Metrics spec
 * FR-9..FR-14; domain-model review §23.4).
 *
 * Goals are created standalone (owned by `userId`) and attached to
 * Missions via the `mission_goals` join table (spec §8 open-question
 * default: standalone-first). Evaluation:
 *   - the per-minute `goal-evaluate-dispatcher` cron claims due ACTIVE
 *     Goals (`nextCheckAt <= now`) with an atomic CAS update, reads the
 *     metric through `MetricsFacadeService.getMetricValue` (budget-
 *     guarded + metered), appends a `goal_metric_samples` row and
 *     updates `currentValue`.
 *   - when the comparator is satisfied → status COMPLETED + outcome
 *     ACHIEVED; when `deadline` passes unmet → COMPLETED + MISSED.
 *     Both auto-outcomes are human-overridable (FR-13).
 *
 * **Invariant I-4 (FR-14): Goal evaluation NEVER touches Missions.**
 * A Mission is completed only by an explicit human action, even when
 * every attached Goal is achieved.
 */
@Entity({ name: 'goals' })
@Index('idx_goals_user_status', ['userId', 'status'])
@Index('idx_goals_status_next_check', ['status', 'nextCheckAt'])
export class Goal {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('uuid')
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ type: 'varchar', length: 200 })
    title: string;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    /**
     * Which provider + metric to read. Stored as `simple-json` to
     * match how sibling entities persist small structured shapes
     * (`Mission.guardrailsOverride`).
     */
    @Column('simple-json')
    metricSource: GoalMetricSource;

    @Column({ type: 'varchar', length: 8 })
    comparator: GoalComparator;

    @Column({ type: 'float' })
    targetValue: number;

    /** Unit of `targetValue` / samples (e.g. `'usd'`, `'count'`). */
    @Column({ type: 'varchar', length: 32 })
    unit: string;

    /** Aggregation window the metric is read over on every evaluation. */
    @Column({ type: 'varchar', length: 16 })
    window: GoalWindow;

    /**
     * First observed value — captured on the first successful
     * evaluation after activation so progress can be rendered as
     * baseline → current → target. NULL until first sample.
     */
    @Column({ type: 'float', nullable: true })
    baselineValue?: number | null;

    /** Most recently observed value (denormalized from the samples). */
    @Column({ type: 'float', nullable: true })
    currentValue?: number | null;

    /** When `currentValue` was observed. */
    @PortableDateColumn({ nullable: true })
    currentValueAt?: Date | null;

    /**
     * Optional deadline. When it passes and the comparator is still
     * unsatisfied, evaluation auto-sets COMPLETED + MISSED (FR-13).
     * NULL = open-ended Goal (can only complete via ACHIEVED or a
     * human override).
     */
    @PortableDateColumn({ nullable: true })
    deadline?: Date | null;

    /**
     * Desired evaluation cadence. Service-layer clamps to a minimum
     * of 15 minutes (spec FR-12) regardless of what's stored here —
     * defense-in-depth against rows written by older code paths.
     */
    @Column({ type: 'int', default: 60 })
    checkFrequencyMinutes: number;

    /**
     * When the dispatcher should evaluate this Goal next. Doubles as
     * the CAS claim token: the dispatcher advances it atomically
     * (`UPDATE ... WHERE nextCheckAt = <read value>`) before
     * evaluating, so concurrent workers can't double-claim (mirrors
     * `WorkScheduleService.markRunDispatched`). NULL when not ACTIVE.
     */
    @PortableDateColumn({ nullable: true })
    nextCheckAt?: Date | null;

    @Column({ type: 'varchar', length: 16, default: GoalStatus.DRAFT })
    status: GoalStatus;

    @Column({ type: 'varchar', length: 16, nullable: true })
    outcome?: GoalOutcome | null;

    // Tier A scope columns (EW-655 pattern) — nullable until the lazy
    // Organization backfill, no @ManyToOne to avoid the entities
    // import cycle (see mission.entity.ts / user.entity.ts EW-654).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
