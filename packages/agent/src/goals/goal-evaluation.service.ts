import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import {
    Goal,
    GoalOutcome,
    GoalStatus,
    type GoalComparator,
    type GoalConstraint,
    type GoalMetricSource,
    type GoalResolvedScore,
} from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { MetricsFacadeService } from '../facades/metrics.facade';
import { AgentEscalationService } from '../agents/agent-escalation.service';
import {
    computeResolvedScore,
    constraintViolated,
    hasWeightedCriteria,
    isHardConstraint,
    isMeasurableConstraint,
    isWeightedGoalAchieved,
    resolveConstraints,
    resolveSourceFor,
    type CriterionObservation,
} from './goal-criteria';
import { summarizeDoD } from './goal-dod';
import { isDeliveryGoal } from './goal-kind';
import {
    MIN_CHECK_FREQUENCY_MINUTES,
    type GoalEvaluationEntry,
    type GoalEvaluationSummary,
} from './types';

/** A metric Goal whose four metric fields are all present — the only shape this service will read. */
type MetricGoal = Goal & {
    metricSource: GoalMetricSource;
    comparator: GoalComparator;
    targetValue: number;
};

/**
 * Goals & Metrics — PR-8 evaluation engine (spec FR-12..FR-14).
 *
 * Driven by the `goal-evaluate-dispatcher` Trigger.dev cron (per
 * minute, `packages/tasks/src/tasks/trigger/goal-evaluate-dispatcher.task.ts`)
 * calling {@link evaluateDue} over the trigger-internal RPC channel —
 * same topology as `MissionTickService.tickDue`.
 *
 * Concurrency: due Goals are claimed with an atomic CAS —
 * `UPDATE goals SET nextCheckAt = <advanced> WHERE id = :id AND
 * status = 'active' AND nextCheckAt = <value we read>` — mirroring
 * `WorkScheduleService.markRunDispatched`. A row whose `nextCheckAt`
 * moved under us was claimed by another worker → counted `skipped`.
 * Claiming ADVANCES the schedule BEFORE evaluating, so a provider
 * failure can never produce a tight retry loop (spec "Reliability"):
 * the Goal simply stays active and is re-read one interval later.
 *
 * **Invariant I-4 (FR-14): this service NEVER touches Missions.**
 * Auto-outcomes update the Goal row only; completing a Mission is
 * always an explicit human action — even when every linked Goal is
 * achieved. There is deliberately no Mission repository in here.
 */
@Injectable()
export class GoalEvaluationService {
    private readonly logger = new Logger(GoalEvaluationService.name);

    constructor(
        @InjectRepository(Goal)
        private readonly goals: Repository<Goal>,
        @InjectRepository(GoalMetricSample)
        private readonly samples: Repository<GoalMetricSample>,
        private readonly metricsFacade: MetricsFacadeService,
        // Judgment layer G1/G3 — "escalate-on-hard". A violated HARD
        // constraint is a decision a human owes, not a number on a chart.
        // @Optional() + appended LAST so positional spec constructors and
        // installs without the escalation stack keep compiling.
        @Optional() private readonly escalations?: AgentEscalationService,
    ) {}

    /**
     * One dispatcher tick: claim + evaluate every ACTIVE Goal whose
     * `nextCheckAt` is due, up to `limit` (oldest due first).
     */
    async evaluateDue(limit = 100): Promise<GoalEvaluationSummary> {
        const now = new Date();
        const due = await this.goals.find({
            where: {
                status: GoalStatus.ACTIVE,
                // NULL nextCheckAt never satisfies <= — inactive rows
                // (and just-paused ones) are naturally excluded.
                nextCheckAt: LessThanOrEqual(now),
            },
            order: { nextCheckAt: 'ASC' },
            take: limit,
        });

        const summary: GoalEvaluationSummary = {
            limit,
            dueCount: due.length,
            evaluated: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };

        for (const goal of due) {
            const claimed = await this.tryClaim(goal, now);
            if (!claimed) {
                summary.skipped += 1;
                summary.entries.push({
                    goalId: goal.id,
                    outcome: 'skipped',
                    message: 'Goal was already claimed by another worker',
                });
                continue;
            }

            try {
                const entry = await this.evaluateOne(goal);
                summary.evaluated += 1;
                summary.entries.push(entry);
            } catch (error) {
                // Failure policy (spec "Reliability" + design): log,
                // keep the Goal ACTIVE, and DON'T retry — nextCheckAt
                // was already advanced by the claim, so the next
                // attempt happens one full interval from now.
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`Goal ${goal.id} evaluation failed: ${message}`);
                summary.failed += 1;
                summary.entries.push({ goalId: goal.id, outcome: 'failed', message });
            }
        }

        return summary;
    }

    /**
     * Evaluate one Goal now.
     *
     * **Delivery Goal** (self-build slice AG): no provider is read and no
     * sample is written — the Goal completes on its approved Definition of
     * Done alone. See {@link evaluateDelivery}.
     *
     * **Metric Goal**: read the metric through the facade (budget-guarded
     * + metered per PR-7), append an (immutable) sample, refresh
     * currentValue/baseline, and apply the auto-outcome rules:
     *
     *   - comparator satisfied            → COMPLETED + ACHIEVED
     *   - deadline passed AND unsatisfied → COMPLETED + MISSED
     *
     * Both auto-outcomes stay human-overridable via PATCH (FR-13).
     * Callers own scheduling: `evaluateDue` advances `nextCheckAt`
     * before calling this; `GoalsService.evaluateNow` (manual tick)
     * deliberately leaves the schedule untouched.
     *
     * Throws the facade's typed errors on provider failure — no
     * sample and no Goal mutation happens in that case. Also throws,
     * fail-closed, on a metric row that lacks any of its metric fields:
     * that row is corrupt, and guessing a target would be worse than
     * reporting it (`evaluateDue` counts it `failed` and moves on).
     */
    async evaluateOne(goal: Goal): Promise<GoalEvaluationEntry> {
        if (isDeliveryGoal(goal)) {
            return this.evaluateDelivery(goal);
        }
        this.assertMetricGoalShape(goal);

        const source = goal.metricSource;
        const sample = await this.metricsFacade.getMetricValue(
            source.pluginId,
            {
                metricId: source.metricId,
                window: goal.window,
                ...(source.params ? { params: source.params } : {}),
            },
            // Q3 (spec §8): evaluation reads as the Goal's creator so
            // settings resolution + usage attribution follow the user.
            { userId: goal.userId },
        );

        // Judgment layer G1 — resolve weighted criteria + constraints
        // BEFORE the outcome rules, because both can veto an achievement.
        // `null` for a single-metric Goal, which is the overwhelming
        // majority and takes the byte-identical original path below.
        const resolved = await this.resolveJudgment(goal);

        const now = new Date();
        const sampledAtMs = Date.parse(sample.at);
        const sampledAt = Number.isFinite(sampledAtMs) ? new Date(sampledAtMs) : now;

        // Append-only history row first — if the Goal update below
        // races a concurrent writer, the observation is still kept.
        await this.samples.insert({
            goalId: goal.id,
            sampledAt,
            value: sample.value,
        });

        goal.currentValue = sample.value;
        goal.currentValueAt = sampledAt;
        if (goal.baselineValue === null || goal.baselineValue === undefined) {
            // First observation after activation becomes the baseline
            // for progress rendering (baseline → current → target).
            goal.baselineValue = sample.value;
        }

        let outcome: GoalEvaluationEntry['outcome'] = 'evaluated';
        // Weighted Goals are judged by their criteria + constraints; a
        // single-metric Goal is judged by the comparator exactly as
        // before. One `if`, no shared branch — the two rules never mix.
        const satisfied = resolved
            ? isWeightedGoalAchieved(resolved)
            : this.isSatisfied(goal, sample.value);
        if (resolved) {
            goal.resolvedScore = resolved;
        }
        if (satisfied) {
            goal.status = GoalStatus.COMPLETED;
            goal.outcome = GoalOutcome.ACHIEVED;
            goal.nextCheckAt = null;
            outcome = 'achieved';
        } else if (goal.deadline && goal.deadline.getTime() <= now.getTime()) {
            goal.status = GoalStatus.COMPLETED;
            goal.outcome = GoalOutcome.MISSED;
            goal.nextCheckAt = null;
            outcome = 'missed';
        }

        // Invariant I-4: only the Goal row is written — linked
        // Missions are NEVER auto-completed from here.
        await this.goals.save(goal);

        // Escalate-on-hard (G1's stated behavior). AFTER the save so the
        // escalation always describes persisted state, and best-effort so
        // an escalation-store hiccup can never fail an evaluation.
        if (resolved && resolved.violatedHardConstraintIds.length > 0) {
            await this.escalateHardViolation(goal, resolved);
        }

        return {
            goalId: goal.id,
            outcome,
            value: sample.value,
            ...(resolved ? { score: resolved.score } : {}),
        };
    }

    /**
     * Delivery-kind evaluation: the approved DoD IS the completion rule.
     *
     * No `MetricsFacadeService` call, no `goal_metric_samples` row, no
     * comparator — a delivery Goal has none of those, and reading a
     * provider for it would be reading nothing. `summarizeDoD` already
     * excludes proposed (unapproved) criteria, so a planning run cannot
     * complete a Goal by proposing that it is done. The deadline rule is
     * the same as for a metric Goal, which is why `activate` schedules
     * delivery Goals too: a missed deadline must surface without a plugin.
     *
     * Idempotent with the orchestrator's `applyTerminal`, which writes the
     * same terminal state when the loop observes the complete DoD first.
     * Invariant I-4 holds: only the Goal row is written.
     */
    private async evaluateDelivery(goal: Goal): Promise<GoalEvaluationEntry> {
        const now = new Date();
        const dod = summarizeDoD(goal.dodCriteria);
        let outcome: GoalEvaluationEntry['outcome'] = 'evaluated';

        if (dod.complete) {
            goal.status = GoalStatus.COMPLETED;
            goal.outcome = GoalOutcome.ACHIEVED;
            goal.nextCheckAt = null;
            outcome = 'achieved';
        } else if (goal.deadline && goal.deadline.getTime() <= now.getTime()) {
            goal.status = GoalStatus.COMPLETED;
            goal.outcome = GoalOutcome.MISSED;
            goal.nextCheckAt = null;
            outcome = 'missed';
        }

        await this.goals.save(goal);
        return { goalId: goal.id, outcome };
    }

    // ─── internals ──────────────────────────────────────────────────

    /**
     * Fail closed on a metric row that lacks its metric fields. The
     * columns are nullable only so the delivery kind can share the table;
     * for a metric Goal a NULL there is corruption, never a valid state.
     */
    private assertMetricGoalShape(goal: Goal): asserts goal is MetricGoal {
        const source = goal.metricSource;
        const missing: string[] = [];
        if (typeof source !== 'object' || source === null || Array.isArray(source)) {
            missing.push('metricSource');
        }
        if (goal.comparator !== 'gte' && goal.comparator !== 'lte') missing.push('comparator');
        if (typeof goal.targetValue !== 'number' || !Number.isFinite(goal.targetValue)) {
            missing.push('targetValue');
        }
        if (missing.length > 0) {
            throw new BadRequestException(
                `Metric Goal ${goal.id} cannot be evaluated: missing ${missing.join(', ')}.`,
            );
        }
    }

    /**
     * Atomic claim: advance `nextCheckAt` by the (re-clamped)
     * frequency iff nobody else already did. Returns false when the
     * row was claimed/paused/completed under us. On success the
     * in-memory `goal.nextCheckAt` is synced to the advanced value so
     * the later `save()` in `evaluateOne` can't roll it back.
     */
    private async tryClaim(goal: Goal, now: Date): Promise<boolean> {
        // Re-clamp defensively (FR-12) — even a row written by an
        // older code path can't schedule tighter than 15 minutes.
        const frequencyMinutes = Math.max(
            MIN_CHECK_FREQUENCY_MINUTES,
            goal.checkFrequencyMinutes || MIN_CHECK_FREQUENCY_MINUTES,
        );
        const next = new Date(now.getTime() + frequencyMinutes * 60_000);
        const result = await this.goals.update(
            {
                id: goal.id,
                status: GoalStatus.ACTIVE,
                // CAS token: the exact value we read during the due
                // scan. TypeORM compares the transformed timestamp.
                nextCheckAt: goal.nextCheckAt ?? undefined,
            },
            { nextCheckAt: next },
        );
        if (!result.affected) {
            return false;
        }
        goal.nextCheckAt = next;
        return true;
    }

    private isSatisfied(goal: MetricGoal, value: number): boolean {
        return goal.comparator === 'gte' ? value >= goal.targetValue : value <= goal.targetValue;
    }

    /**
     * Judgment layer G1 — read every weighted criterion and every
     * MEASURABLE constraint, then fold them into a resolved score.
     *
     * Returns `null` when the Goal declares no criteria: that is the
     * single-metric Goal this service has always evaluated, and it must
     * take the original path untouched. Constraints alone do not trigger
     * the weighted path — a Goal with constraints but one metric is still
     * scored by its comparator; the constraints simply veto.
     *
     * Per-metric failures are CONTAINED: a provider outage on one
     * criterion records the error on that entry and drops it out of the
     * normalization, rather than throwing and losing the whole
     * evaluation. That is the difference between "we could not read one
     * number" and "this Goal cannot be evaluated".
     */
    private async resolveJudgment(goal: Goal): Promise<GoalResolvedScore | null> {
        const constraints = resolveConstraints(goal);
        if (!hasWeightedCriteria(goal)) {
            // No criteria: no weighted score. Constraints on a
            // single-metric Goal are carried for prompts/reports only —
            // vetoing an outcome the user configured with a comparator
            // would change existing behavior, which G1 must not do.
            return null;
        }

        const observations: CriterionObservation[] = [];
        for (const criterion of goal.criteria) {
            const { source, window } = resolveSourceFor(goal, criterion);
            if (!source) {
                // Neither the criterion nor the Goal names a metric: unknown,
                // not failed — the same containment as a provider outage.
                observations.push({ criterion, value: null, error: 'no metric source' });
                continue;
            }
            try {
                const sample = await this.metricsFacade.getMetricValue(
                    source.pluginId,
                    {
                        metricId: source.metricId,
                        window,
                        ...(source.params ? { params: source.params } : {}),
                    },
                    { userId: goal.userId },
                );
                observations.push({ criterion, value: sample.value });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `Goal ${goal.id} criterion '${criterion.id}' metric read failed: ${message}`,
                );
                observations.push({ criterion, value: null, error: message });
            }
        }

        const violated: GoalConstraint[] = [];
        const violatedHard: GoalConstraint[] = [];
        for (const constraint of constraints) {
            // Declarative constraints are never auto-violated — the
            // platform does not claim to have checked what it cannot read.
            if (!isMeasurableConstraint(constraint)) continue;
            const { source, window } = resolveSourceFor(goal, constraint);
            if (!source) {
                // No metric to read → UNKNOWN, never violated (see below).
                this.logger.warn(
                    `Goal ${goal.id} constraint '${constraint.id}' has no metric source (treated as not violated)`,
                );
                continue;
            }
            try {
                const sample = await this.metricsFacade.getMetricValue(
                    source.pluginId,
                    {
                        metricId: source.metricId,
                        window,
                        ...(source.params ? { params: source.params } : {}),
                    },
                    { userId: goal.userId },
                );
                if (constraintViolated(constraint, sample.value)) {
                    violated.push(constraint);
                    if (isHardConstraint(constraint)) violatedHard.push(constraint);
                }
            } catch (error) {
                // An unreadable constraint is UNKNOWN, never violated:
                // failing a Goal because a provider was down would be the
                // worst possible default for a rule that vetoes outcomes.
                this.logger.warn(
                    `Goal ${goal.id} constraint '${constraint.id}' metric read failed (treated as ` +
                        `not violated): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        return computeResolvedScore(observations, { violated, violatedHard });
    }

    /**
     * Escalate-on-hard. Deduplicated per (goal, constraint set) so a Goal
     * that keeps evaluating while a constraint stays violated files ONE
     * card, not one per tick.
     */
    private async escalateHardViolation(goal: Goal, resolved: GoalResolvedScore): Promise<void> {
        if (!this.escalations) return;
        const ids = [...resolved.violatedHardConstraintIds].sort().join(',');
        await this.escalations.record({
            userId: goal.userId,
            reasonCode: 'guardrail-refusal',
            dedupKey: `goal-hard-constraint:${goal.id}:${ids}`,
            summary:
                `Goal "${goal.title}" violates hard constraint(s): ${ids}. ` +
                `Weighted score ${resolved.score.toFixed(2)}.`,
            decisionNeeded:
                'A hard constraint on this Goal is violated, so it cannot be achieved as ' +
                'configured. Decide whether to relax the constraint, change the target, or ' +
                'stop pursuing this Goal.',
            attempted: resolved.criteria.map((entry) => ({
                label: entry.id,
                outcome:
                    entry.value === null
                        ? `metric unreadable${entry.error ? `: ${entry.error}` : ''}`
                        : `${entry.value} vs target ${entry.target} (${
                              entry.satisfied ? 'met' : 'not met'
                          })`,
            })),
            ...(goal.organizationId !== undefined ? { organizationId: goal.organizationId } : {}),
        });
    }
}
