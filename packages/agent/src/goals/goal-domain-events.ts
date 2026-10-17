import { INTEGRATION_EXTERNAL_METRIC_PLUGIN_ID } from '@ever-works/contracts';
import type { EntityManager } from 'typeorm';
import { DomainEvent } from '../entities/domain-event.entity';
import type { Goal, GoalConstraint, GoalMetricSource } from '../entities/goal.entity';
import { GoalMetricSample } from '../entities/goal-metric-sample.entity';
import type {
    DomainEventPublisher,
    PublishOptions,
} from '../domain-events/domain-event-publisher.service';
import { computeResolvedScore, hasWeightedCriteria, resolveSourceFor } from './goal-criteria';

/**
 * Goals in the domain-event stream (EW-P2-2, integration contract v1 B.4):
 * the external metric source and the throttled `goal.progress_changed`.
 */

/**
 * `goal.progress_changed` is throttled to at most one per Goal per 5 minutes
 * (contract B.4). A change inside the window still bumps the Goal's `version`
 * (and `updatedAt`), so a GET or the hourly reconcile sees it; only the event is
 * skipped.
 */
export const GOAL_PROGRESS_EVENT_MIN_INTERVAL_MS = 5 * 60_000;

/** The external metric source: no provider is read, values arrive as samples. */
export function isExternalMetricSource(
    source: Pick<GoalMetricSource, 'pluginId'> | null | undefined,
): boolean {
    return source?.pluginId === INTEGRATION_EXTERNAL_METRIC_PLUGIN_ID;
}

/**
 * Record `goal.progress_changed` (full snapshot) unless one was recorded for this
 * Goal within {@link GOAL_PROGRESS_EVENT_MIN_INTERVAL_MS}; then only bump the
 * version. Call it in the transaction of the write (or through `recordAfterWrite`).
 */
export async function recordGoalProgress(
    publisher: DomainEventPublisher,
    manager: EntityManager,
    goalId: string,
    options: PublishOptions = {},
    now: Date = new Date(),
): Promise<'recorded' | 'throttled'> {
    const last = await manager.getRepository(DomainEvent).findOne({
        where: { aggregateType: 'goal', aggregateId: goalId, type: 'goal.progress_changed' },
        order: { outboxSeq: 'DESC' },
        select: { id: true, occurredAt: true },
    });
    const lastAt = last?.occurredAt ? new Date(last.occurredAt).getTime() : null;
    if (lastAt !== null && now.getTime() - lastAt < GOAL_PROGRESS_EVENT_MIN_INTERVAL_MS) {
        await publisher.recorder.bumpAggregateVersion(manager, 'goal', goalId);
        return 'throttled';
    }
    await publisher.changed(manager, 'goal', goalId, 'goal.progress_changed', options);
    return 'recorded';
}

/**
 * The latest externally pushed value of each criterion (`goal_metric_samples`
 * rows with that `criterionId`), for the criteria whose metric is external.
 */
export async function latestExternalCriterionValues(
    manager: EntityManager,
    goal: Pick<Goal, 'id' | 'criteria' | 'metricSource' | 'window'>,
): Promise<Map<string, number>> {
    const values = new Map<string, number>();
    if (!hasWeightedCriteria(goal)) return values;
    for (const criterion of goal.criteria) {
        const { source } = resolveSourceFor(goal, criterion);
        if (!isExternalMetricSource(source)) continue;
        // Only touched for an external criterion: a provider-only Goal reads nothing here.
        const latest = await manager.getRepository(GoalMetricSample).findOne({
            where: { goalId: goal.id, criterionId: criterion.id },
            order: { sampledAt: 'DESC', createdAt: 'DESC' },
        });
        if (latest) values.set(criterion.id, Number(latest.value));
    }
    return values;
}

/**
 * Re-score a Goal whose criteria read (at least partly) an external source, from
 * the pushed values: an external criterion takes its latest own sample, else (when
 * it inherits the Goal's external source) the Goal's `currentValue`; a provider
 * criterion keeps the value of the last evaluation. Constraint violations are left
 * as the last evaluation found them (samples never evaluate constraints).
 * `null` when the Goal has no criteria.
 */
export async function rescoreFromExternalValues(
    manager: EntityManager,
    goal: Goal,
    now: Date = new Date(),
): Promise<Goal['resolvedScore']> {
    if (!hasWeightedCriteria(goal)) return goal.resolvedScore ?? null;
    const pushed = await latestExternalCriterionValues(manager, goal);
    const previous = new Map(
        (goal.resolvedScore?.criteria ?? []).map((entry) => [entry.id, entry.value]),
    );
    const observations = goal.criteria.map((criterion) => {
        const { source } = resolveSourceFor(goal, criterion);
        if (isExternalMetricSource(source)) {
            const own = pushed.get(criterion.id);
            const inherited =
                !criterion.metricSource && typeof goal.currentValue === 'number'
                    ? goal.currentValue
                    : null;
            const value = own ?? inherited;
            return value === null
                ? { criterion, value: null, error: 'no external sample yet' }
                : { criterion, value };
        }
        const value = previous.get(criterion.id) ?? null;
        return value === null
            ? { criterion, value: null, error: 'not evaluated yet' }
            : { criterion, value };
    });
    const constraints: GoalConstraint[] = Array.isArray(goal.constraints) ? goal.constraints : [];
    const violatedIds = new Set(goal.resolvedScore?.violatedConstraintIds ?? []);
    const violatedHardIds = new Set(goal.resolvedScore?.violatedHardConstraintIds ?? []);
    return computeResolvedScore(
        observations,
        {
            violated: constraints.filter((constraint) => violatedIds.has(constraint.id)),
            violatedHard: constraints.filter((constraint) => violatedHardIds.has(constraint.id)),
        },
        now,
    );
}
