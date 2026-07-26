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
 * Judgment layer G1 — one WEIGHTED success criterion.
 *
 * A Goal today is a single metric + comparator + target. That is one
 * criterion with weight 1, and it keeps working exactly as it did. This
 * shape lets a Goal instead declare SEVERAL, each pulling its own metric
 * and contributing a weighted share of a resolved 0..1 score — the
 * machine-checkable target a quality gate (or an LLM judge) can be told
 * to aim at.
 *
 * `direction` mirrors {@link GoalComparator} rather than reusing it so a
 * criterion stays readable on its own ("higher is better" / "lower is
 * better") and so the two can diverge later without a migration.
 */
export interface GoalCriterion {
    /** Stable slug, unique within the Goal. Also the merge/report key. */
    id: string;
    /** Human-readable label rendered in progress/score breakdowns. */
    name: string;
    /**
     * Which metric this criterion reads. Omitted = the Goal's own
     * `metricSource` — the common "same metric, different thresholds"
     * case costs no extra configuration.
     */
    metricSource?: GoalMetricSource;
    /**
     * Aggregation window override. Omitted = the Goal's `window`.
     */
    window?: GoalWindow;
    /** Relative weight (> 0). Normalized across criteria at score time. */
    weight: number;
    /** Value at which this criterion is fully satisfied. */
    target: number;
    /** `gte` = higher is better; `lte` = lower is better. */
    direction: GoalComparator;
    /** Unit of `target` (display only). Omitted = the Goal's `unit`. */
    unit?: string;
}

/**
 * Judgment layer G1 — categories a hard constraint can belong to. Purely
 * descriptive (grouping + reporting); enforcement is identical for all
 * five. Mirrors the constraint taxonomy the gates already reason about.
 */
export type GoalConstraintCategory = 'time' | 'cost' | 'safety' | 'scope' | 'quality';

export const GOAL_CONSTRAINT_CATEGORIES: readonly GoalConstraintCategory[] = [
    'time',
    'cost',
    'safety',
    'scope',
    'quality',
];

/**
 * Judgment layer G1 — a constraint that MUST hold.
 *
 * `hard: true` (the default) means violation is disqualifying: the Goal
 * cannot be ACHIEVED while it is violated, no matter how high the
 * weighted score is, and the violation is escalated for a human (G3).
 * `hard: false` records the violation on the evaluation and lets the
 * score speak — a soft constraint is a warning, not a veto.
 *
 * A constraint with no `metricSource` and no `maxValue`/`minValue` is a
 * DECLARATIVE one (e.g. "never send unconfirmed email"): it is carried
 * for prompts and reports and is never auto-evaluated. That is the
 * honest behavior — the platform must not claim to have checked
 * something it cannot measure.
 */
export interface GoalConstraint {
    /** Stable slug, unique within the Goal. */
    id: string;
    /** Human-readable statement of the rule. */
    name: string;
    category: GoalConstraintCategory;
    /** Disqualifying when violated. Omitted = `true`. */
    hard?: boolean;
    /** Metric to read when the constraint is measurable. */
    metricSource?: GoalMetricSource;
    /** Window override for `metricSource`. Omitted = the Goal's `window`. */
    window?: GoalWindow;
    /** Violated when the observed value exceeds this. */
    maxValue?: number;
    /** Violated when the observed value falls below this. */
    minValue?: number;
}

/**
 * Judgment layer G1 — the resolved score written back after evaluation.
 * NULL on every single-metric Goal (nothing to resolve) and on a Goal
 * that has never been evaluated.
 */
export interface GoalResolvedScore {
    /** Weighted, normalized 0..1 across every criterion that resolved. */
    score: number;
    /** Per-criterion detail, in declared order. */
    criteria: Array<{
        id: string;
        /** Observed metric value, or null when the read failed. */
        value: number | null;
        target: number;
        weight: number;
        /** 0..1 contribution BEFORE weighting. */
        ratio: number;
        satisfied: boolean;
        /** Present only when the metric read failed. */
        error?: string;
    }>;
    /** Ids of constraints observed to be violated at this evaluation. */
    violatedConstraintIds: string[];
    /** Subset of the above declared `hard` — these veto ACHIEVED. */
    violatedHardConstraintIds: string[];
    /** ISO timestamp of the evaluation that produced this score. */
    at: string;
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

    // ── Judgment layer G1 — weighted criteria + hard constraints. All
    // three are additive and NULL on every pre-existing row, which is
    // exactly the single-metric Goal this entity already described:
    // evaluation only takes the weighted path when `criteria` holds at
    // least one entry, so nothing about an existing Goal changes.

    /**
     * Weighted success criteria. NULL/empty = single-metric Goal
     * (`metricSource` + `comparator` + `targetValue` decide everything,
     * unchanged). Stored `simple-json` like `metricSource`.
     */
    @Column({ type: 'simple-json', nullable: true })
    criteria?: GoalCriterion[] | null;

    /**
     * Constraints that must hold. A violated HARD constraint vetoes
     * ACHIEVED even at a perfect score and raises an escalation (G3).
     */
    @Column({ type: 'simple-json', nullable: true })
    constraints?: GoalConstraint[] | null;

    /**
     * Last resolved weighted score + per-criterion breakdown. Written by
     * `GoalEvaluationService` on every weighted evaluation; never written
     * for single-metric Goals.
     */
    @Column({ type: 'simple-json', nullable: true })
    resolvedScore?: GoalResolvedScore | null;

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
