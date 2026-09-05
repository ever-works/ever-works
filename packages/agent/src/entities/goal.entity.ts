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
import { GOAL_KINDS, type GoalKind } from '@ever-works/contracts';
import { User } from './user.entity';
import { PortableDateColumn } from './_types';

// The kind vocabulary lives in `@ever-works/contracts` (like `WorkKind`)
// because the web app must render it without depending on this package.
// Re-exported so the goals barrel keeps its single-import idiom.
export { GOAL_KINDS, type GoalKind };

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
 * Autonomy layer — one Definition-of-Done criterion.
 *
 * A DoD criterion is a PROSE statement of completion ("the pricing page
 * ships with three tiers"), deliberately unlike {@link GoalCriterion},
 * which is a machine-read metric threshold. The two coexist: the metric
 * layer answers "is the number there?", the DoD layer answers "did we do
 * the things?", and the orchestrator loop stops when every DoD criterion
 * is closed (`done` or `waived`).
 *
 * `waived` is a first-class terminal state, not a synonym for done: an
 * operator who decides a criterion no longer applies must be able to say
 * so without lying about having satisfied it. `note` records why.
 */
export type GoalDoDStatus = 'open' | 'done' | 'waived';

export const GOAL_DOD_STATUSES: readonly GoalDoDStatus[] = ['open', 'done', 'waived'];

/**
 * Who authored a criterion. `planner` entries are produced by a planning
 * run and are inert until an operator approves them — the platform must
 * never let a model silently rewrite its own finish line.
 */
export type GoalDoDSource = 'operator' | 'planner';

export const GOAL_DOD_SOURCES: readonly GoalDoDSource[] = ['operator', 'planner'];

export interface GoalDoDCriterion {
    /** Stable slug, unique within the Goal. Also the patch key. */
    id: string;
    /** The completion statement, in the operator's own words. */
    text: string;
    status: GoalDoDStatus;
    /** Link or short note evidencing a `done` criterion. */
    evidence?: string | null;
    /** Why a criterion was waived (or any operator annotation). */
    note?: string | null;
    /** Omitted reads as `operator` — every hand-authored criterion. */
    source?: GoalDoDSource;
    /**
     * Awaiting operator approval. Set on planner-authored criteria; a
     * proposed criterion is EXCLUDED from the completion rollup, so a
     * planning run cannot extend (or satisfy) the finish line on its own.
     */
    proposed?: boolean;
    /** ISO timestamp of the last status/evidence write. */
    updatedAt?: string;
}

/**
 * Autonomy layer — state of the per-Goal execution LOOP.
 *
 * Deliberately a SEPARATE column from {@link GoalStatus} rather than new
 * members on it. `GoalStatus` drives the metric-evaluation dispatcher
 * (`status = 'active' AND nextCheckAt <= now`), the activate/pause state
 * machine, and the `/api/me/goals?status=` filter, all of which are pinned
 * by e2e specs. Adding `cancelled`/`stuck` there would silently widen
 * those contracts; a Goal can perfectly well be metric-ACTIVE while its
 * iteration loop is paused, so the two axes are genuinely independent.
 *
 * NULL = the loop was never started, which is every Goal predating this
 * column and every Goal an operator never asked to run autonomously.
 */
export type GoalLoopStatus = 'running' | 'paused' | 'done' | 'cancelled' | 'stuck';

export const GOAL_LOOP_STATUSES: readonly GoalLoopStatus[] = [
    'running',
    'paused',
    'done',
    'cancelled',
    'stuck',
];

/**
 * Advisory routing hint for where iterations should execute. ADVISORY is
 * the operative word: dispatch honours the platform's own job-runtime
 * resolution, and this records the operator's intent + is carried on the
 * dispatch event so a mismatch is visible rather than silent.
 */
export type GoalExecutionTarget = 'cloud' | 'local-runner';

export const GOAL_EXECUTION_TARGETS: readonly GoalExecutionTarget[] = ['cloud', 'local-runner'];

/**
 * A Goal comes in two KINDS (`goalKind`, self-build slice AG / EW-795):
 *
 *   - **metric** (the default, and every row that predates the column) —
 *     a measurable target, "income >= $1000/month via Stripe", evaluated
 *     automatically against real business metrics (Goals & Metrics spec
 *     FR-9..FR-14; domain-model review §23.4). `metricSource`,
 *     `comparator`, `targetValue` and `unit` are all REQUIRED (enforced
 *     by the DTO and the service; the columns themselves are nullable
 *     only so the delivery kind can share the table).
 *   - **delivery** — "ship feature X across three repos". There is NO
 *     metric: the four metric columns are NULL, no provider is ever read,
 *     and the Goal completes on its approved Definition of Done alone
 *     (`dodCriteria`, every approved criterion done or waived). A delivery
 *     Goal is born with at least one approved criterion and can never be
 *     emptied. Its iteration loop, budgets and deadline work exactly as
 *     for a metric Goal.
 *
 * Goals are created standalone (owned by `userId`) and attached to
 * Missions via the `mission_goals` join table (spec §8 open-question
 * default: standalone-first). Evaluation:
 *   - the per-minute `goal-evaluate-dispatcher` cron claims due ACTIVE
 *     Goals (`nextCheckAt <= now`) with an atomic CAS update. For a
 *     metric Goal it reads the metric through
 *     `MetricsFacadeService.getMetricValue` (budget-guarded + metered),
 *     appends a `goal_metric_samples` row and updates `currentValue`; for
 *     a delivery Goal it only re-checks the DoD rollup and the deadline.
 *   - when the comparator is satisfied (metric) or the DoD is complete
 *     (delivery) → status COMPLETED + outcome ACHIEVED; when `deadline`
 *     passes unmet → COMPLETED + MISSED. Both auto-outcomes are
 *     human-overridable (FR-13).
 *
 * **Invariant I-4 (FR-14): Goal evaluation NEVER touches Missions.**
 * A Mission is completed only by an explicit human action, even when
 * every attached Goal is achieved.
 */
@Entity({ name: 'goals' })
@Index('idx_goals_user_status', ['userId', 'status'])
@Index('idx_goals_status_next_check', ['status', 'nextCheckAt'])
// Autonomy layer — the orchestrator's due-scan predicate. NULL loopStatus
// (every Goal that never started a loop) is excluded by the equality, so
// the cron's cheap case stays one indexed lookup returning zero rows.
@Index('idx_goals_loop_status', ['loopStatus'])
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
     * `'metric'` (default — every pre-existing row) | `'delivery'`. Decides
     * which completion rule applies and whether the four metric columns
     * below are required (metric) or must be NULL (delivery). Immutable
     * after create. Vocabulary: {@link GOAL_KINDS} in `@ever-works/contracts`.
     */
    @Column({ type: 'varchar', length: 16, default: 'metric' })
    goalKind: GoalKind;

    // ── Metric fields — REQUIRED on a metric Goal, NULL on a delivery Goal.
    // Nullable at the column level only so both kinds share one table;
    // the DTO and `GoalsService` refuse a metric Goal that lacks any of
    // them, so a metric row with a NULL here is a corrupted row, not a
    // valid state (evaluation fails closed on it).

    /**
     * Which provider + metric to read. Stored as `simple-json` to
     * match how sibling entities persist small structured shapes
     * (`Mission.guardrailsOverride`).
     */
    @Column({ type: 'simple-json', nullable: true })
    metricSource?: GoalMetricSource | null;

    @Column({ type: 'varchar', length: 8, nullable: true })
    comparator?: GoalComparator | null;

    @Column({ type: 'float', nullable: true })
    targetValue?: number | null;

    /** Unit of `targetValue` / samples (e.g. `'usd'`, `'count'`). */
    @Column({ type: 'varchar', length: 32, nullable: true })
    unit?: string | null;

    /**
     * Aggregation window the metric is read over on every evaluation.
     * Not one of the four metric fields — stays NOT NULL; a delivery Goal
     * stores `'total'` and never reads it.
     */
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

    // ── Autonomy layer — Definition of Done, budgets, iteration loop ──
    // Every column below is additive and NULL/0 on every pre-existing
    // row, which reads as "no DoD, no limits, loop never started" — i.e.
    // exactly the metric-only Goal this entity already described.

    /**
     * Ordered Definition-of-Done checklist. NULL/empty = the Goal is
     * judged purely by its metric target, unchanged. Stored `simple-json`
     * like `criteria`/`constraints`.
     */
    @Column({ type: 'simple-json', nullable: true })
    dodCriteria?: GoalDoDCriterion[] | null;

    /**
     * Hard spend ceiling for the whole Goal, in CENTS.
     *
     * Cents, not dollars, because `agent_runs.costCents` — the only thing
     * that ever adds to `spentCents` — is already cents. A float-dollars
     * column would need a lossy conversion on every rollup, which is how
     * budget ceilings end up off by a penny and then off by a dollar.
     * NULL = uncapped.
     */
    @Column({ type: 'int', nullable: true })
    spendCapCents?: number | null;

    /**
     * Rolled-up spend of every run linked to this Goal's iterations, in
     * cents. A DENORM refreshed by `GoalOrchestratorService.rollupSpend`
     * on every advance/limit read — not a running counter incremented on
     * the side, because a counter that misses one terminal run under-
     * reports forever and a budget that under-reports is not a budget.
     */
    @Column({ type: 'int', default: 0 })
    spentCents: number;

    /** Wall-clock ceiling measured from `loopStartedAt`. NULL = none. */
    @Column({ type: 'int', nullable: true })
    wallClockLimitHours?: number | null;

    /**
     * Iterations allowed to pass with NO DoD progress before the loop is
     * declared stuck. NULL = never auto-stuck.
     */
    @Column({ type: 'int', nullable: true })
    stuckThresholdIterations?: number | null;

    /** Advisory per-session runtime budget handed to the routed agent. */
    @Column({ type: 'int', nullable: true })
    sessionBudgetMinutes?: number | null;

    /**
     * Grace period after a limit trips before the loop actually pauses —
     * lets an in-flight session land instead of being cut mid-write.
     */
    @Column({ type: 'int', nullable: true })
    gracePeriodMinutes?: number | null;

    /** `cloud` | `local-runner` — advisory routing hint. NULL = platform default. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    executionTarget?: GoalExecutionTarget | null;

    /** Free-string model hint for planning runs (no allow-list by design). */
    @Column({ type: 'varchar', length: 120, nullable: true })
    plannerModelHint?: string | null;

    /** Free-string model hint for worker (iteration) runs. */
    @Column({ type: 'varchar', length: 120, nullable: true })
    workerModelHint?: string | null;

    /** How many iterations the loop has dispatched. Monotonic. */
    @Column({ type: 'int', default: 0 })
    iteration: number;

    /**
     * Iteration number at which the DoD rollup last CHANGED. Stuck
     * detection is `iteration - lastProgressIteration >=
     * stuckThresholdIterations`, so it measures iterations without
     * progress rather than iterations in total.
     */
    @Column({ type: 'int', default: 0 })
    lastProgressIteration: number;

    /** Agent the current iteration was routed to. NULL between iterations. */
    @Column({ type: 'uuid', nullable: true })
    activeAgentId?: string | null;

    /**
     * Operator-pinned agent. When set, routing ALWAYS chooses it and the
     * round-robin never runs — the explicit rule beats the heuristic.
     */
    @Column({ type: 'uuid', nullable: true })
    assignedAgentId?: string | null;

    /** See {@link GoalLoopStatus}. NULL = loop never started. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    loopStatus?: GoalLoopStatus | null;

    /** When the loop last entered `running`. Anchors the wall-clock limit. */
    @PortableDateColumn({ nullable: true })
    loopStartedAt?: Date | null;

    /**
     * Archive marker. Archived Goals are hidden from the default catalog
     * and never advanced by the orchestrator, but are NOT deleted — the
     * observation history and orchestrator log stay readable.
     */
    @PortableDateColumn({ nullable: true })
    archivedAt?: Date | null;

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
