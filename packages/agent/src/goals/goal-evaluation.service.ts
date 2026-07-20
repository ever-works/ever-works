import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Goal, GoalOutcome, GoalStatus } from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import { MetricsFacadeService } from '../facades/metrics.facade';
import {
    MIN_CHECK_FREQUENCY_MINUTES,
    type GoalEvaluationEntry,
    type GoalEvaluationSummary,
} from './types';

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
     * Evaluate one Goal now: read the metric through the facade
     * (budget-guarded + metered per PR-7), append an (immutable)
     * sample, refresh currentValue/baseline, and apply the
     * auto-outcome rules:
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
     * sample and no Goal mutation happens in that case.
     */
    async evaluateOne(goal: Goal): Promise<GoalEvaluationEntry> {
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
        if (this.isSatisfied(goal, sample.value)) {
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

        return { goalId: goal.id, outcome, value: sample.value };
    }

    // ─── internals ──────────────────────────────────────────────────

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

    private isSatisfied(goal: Goal, value: number): boolean {
        return goal.comparator === 'gte' ? value >= goal.targetValue : value <= goal.targetValue;
    }
}
