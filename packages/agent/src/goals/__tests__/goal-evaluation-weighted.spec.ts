import type { Repository } from 'typeorm';
import { Goal, GoalOutcome, GoalStatus } from '../../entities/goal.entity';
import type { GoalMetricSample } from '../../entities/goal-metric-sample.entity';
import type { MetricsFacadeService } from '../../facades/metrics.facade';
import { GoalEvaluationService } from '../goal-evaluation.service';

/**
 * Weighted Goal evaluation (judgment layer G1) — the service half.
 *
 * `goal-criteria.spec.ts` pins the scoring MATH; this file pins the
 * WIRING: that a Goal with no criteria takes the untouched single-metric
 * path, that a Goal with criteria is judged by them instead, and that a
 * violated hard constraint both vetoes the outcome and escalates.
 */
function makeGoal(overrides: Partial<Goal> = {}): Goal {
    return {
        id: 'g1',
        userId: 'u1',
        title: 'Income >= 1000/month',
        description: null,
        metricSource: { pluginId: 'stripe', metricId: 'income' },
        comparator: 'gte',
        targetValue: 1000,
        unit: 'usd',
        window: 'month',
        baselineValue: null,
        currentValue: null,
        currentValueAt: null,
        deadline: null,
        checkFrequencyMinutes: 60,
        nextCheckAt: null,
        status: GoalStatus.ACTIVE,
        outcome: null,
        criteria: null,
        constraints: null,
        resolvedScore: null,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        ...overrides,
    } as Goal;
}

describe('GoalEvaluationService — weighted criteria + constraints (G1)', () => {
    let goals: jest.Mocked<Pick<Repository<Goal>, 'find' | 'update' | 'save'>>;
    let samples: jest.Mocked<Pick<Repository<GoalMetricSample>, 'insert'>>;
    let metricsFacade: jest.Mocked<Pick<MetricsFacadeService, 'getMetricValue'>>;
    let escalations: { record: jest.Mock };

    function makeSvc(): GoalEvaluationService {
        const svc = new GoalEvaluationService(
            goals as never,
            samples as never,
            metricsFacade as never,
            escalations as never,
        );
        for (const level of ['warn', 'error', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    }

    /** Resolve each (pluginId, metricId) pair to a fixed value. */
    function metricValues(byMetricId: Record<string, number>) {
        metricsFacade.getMetricValue.mockImplementation(async (_plugin, query) => ({
            value: byMetricId[(query as { metricId: string }).metricId] ?? 0,
            unit: 'usd',
            at: new Date('2026-07-20T00:00:00.000Z').toISOString(),
        }));
    }

    beforeEach(() => {
        goals = {
            find: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            save: jest.fn().mockImplementation(async (g) => g),
        } as never;
        samples = { insert: jest.fn().mockResolvedValue(undefined) } as never;
        metricsFacade = { getMetricValue: jest.fn() } as never;
        escalations = { record: jest.fn().mockResolvedValue({ id: 'e1' }) };
    });

    afterEach(() => jest.restoreAllMocks());

    it('⭐ leaves a single-metric Goal on the pre-G1 path, reading exactly one metric', async () => {
        // THE ADDITIVITY TEST at the service level: an existing Goal must
        // make the SAME number of provider calls and reach the SAME outcome
        // it did before this feature landed. A second read would be both a
        // behavior change and a billed one.
        metricValues({ income: 1500 });
        const goal = makeGoal();

        const entry = await makeSvc().evaluateOne(goal);

        expect(metricsFacade.getMetricValue).toHaveBeenCalledTimes(1);
        expect(entry.outcome).toBe('achieved');
        expect(entry.score).toBeUndefined();
        expect(goal.resolvedScore).toBeNull();
        expect(goal.status).toBe(GoalStatus.COMPLETED);
        expect(goal.outcome).toBe(GoalOutcome.ACHIEVED);
    });

    it('judges a weighted Goal by its criteria, not by the top-level comparator', async () => {
        // Top-level comparator would say ACHIEVED (1500 >= 1000); the
        // criteria say otherwise, and the criteria win.
        metricValues({ income: 1500, churn: 20 });
        const goal = makeGoal({
            criteria: [
                { id: 'income', name: 'Income', weight: 1, target: 1000, direction: 'gte' },
                {
                    id: 'churn',
                    name: 'Churn',
                    weight: 1,
                    target: 5,
                    direction: 'lte',
                    metricSource: { pluginId: 'stripe', metricId: 'churn' },
                },
            ],
        });

        const entry = await makeSvc().evaluateOne(goal);

        expect(entry.outcome).toBe('evaluated');
        expect(goal.status).toBe(GoalStatus.ACTIVE);
        expect(entry.score).toBeGreaterThan(0);
        expect(goal.resolvedScore?.criteria.map((c) => c.satisfied)).toEqual([true, false]);
    });

    it('achieves a weighted Goal once every criterion is satisfied', async () => {
        metricValues({ income: 1500, churn: 2 });
        const goal = makeGoal({
            criteria: [
                { id: 'income', name: 'Income', weight: 2, target: 1000, direction: 'gte' },
                {
                    id: 'churn',
                    name: 'Churn',
                    weight: 1,
                    target: 5,
                    direction: 'lte',
                    metricSource: { pluginId: 'stripe', metricId: 'churn' },
                },
            ],
        });

        const entry = await makeSvc().evaluateOne(goal);

        expect(entry.outcome).toBe('achieved');
        expect(entry.score).toBe(1);
        expect(goal.outcome).toBe(GoalOutcome.ACHIEVED);
    });

    it('⭐ a violated HARD constraint blocks ACHIEVED at a perfect score', async () => {
        // "We hit every number, by breaking a rule" is not an achievement.
        // This is the behavior `escalate-on-hard` names.
        metricValues({ income: 5000, spend: 900 });
        const goal = makeGoal({
            criteria: [{ id: 'income', name: 'Income', weight: 1, target: 1000, direction: 'gte' }],
            constraints: [
                {
                    id: 'spend-cap',
                    name: 'Stay under $500 spend',
                    category: 'cost',
                    maxValue: 500,
                    metricSource: { pluginId: 'stripe', metricId: 'spend' },
                },
            ],
        });

        const entry = await makeSvc().evaluateOne(goal);

        expect(entry.outcome).toBe('evaluated');
        expect(goal.outcome).toBeNull();
        expect(goal.resolvedScore?.violatedHardConstraintIds).toEqual(['spend-cap']);
    });

    it('escalates a hard-constraint violation for a human, deduped per constraint set', async () => {
        metricValues({ income: 5000, spend: 900 });
        const goal = makeGoal({
            criteria: [{ id: 'income', name: 'Income', weight: 1, target: 1000, direction: 'gte' }],
            constraints: [
                {
                    id: 'spend-cap',
                    name: 'Stay under $500 spend',
                    category: 'cost',
                    maxValue: 500,
                    metricSource: { pluginId: 'stripe', metricId: 'spend' },
                },
            ],
        });

        await makeSvc().evaluateOne(goal);

        expect(escalations.record).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                reasonCode: 'guardrail-refusal',
                dedupKey: 'goal-hard-constraint:g1:spend-cap',
            }),
        );
    });

    it('lets a SOFT constraint violation through — it warns, it does not veto', async () => {
        metricValues({ income: 5000, spend: 900 });
        const goal = makeGoal({
            criteria: [{ id: 'income', name: 'Income', weight: 1, target: 1000, direction: 'gte' }],
            constraints: [
                {
                    id: 'spend-guide',
                    name: 'Prefer under $500 spend',
                    category: 'cost',
                    hard: false,
                    maxValue: 500,
                    metricSource: { pluginId: 'stripe', metricId: 'spend' },
                },
            ],
        });

        const entry = await makeSvc().evaluateOne(goal);

        expect(entry.outcome).toBe('achieved');
        expect(goal.resolvedScore?.violatedConstraintIds).toEqual(['spend-guide']);
        expect(goal.resolvedScore?.violatedHardConstraintIds).toEqual([]);
        expect(escalations.record).not.toHaveBeenCalled();
    });

    it('⭐ treats an unreadable constraint metric as UNKNOWN, never as violated', async () => {
        // Failing a Goal because a provider was down would be the worst
        // possible default for a rule that vetoes outcomes.
        metricsFacade.getMetricValue.mockImplementation(async (_plugin, query) => {
            const metricId = (query as { metricId: string }).metricId;
            if (metricId === 'spend') throw new Error('provider 503');
            return { value: 5000, unit: 'usd', at: new Date().toISOString() };
        });
        const goal = makeGoal({
            criteria: [{ id: 'income', name: 'Income', weight: 1, target: 1000, direction: 'gte' }],
            constraints: [
                {
                    id: 'spend-cap',
                    name: 'Spend cap',
                    category: 'cost',
                    maxValue: 500,
                    metricSource: { pluginId: 'stripe', metricId: 'spend' },
                },
            ],
        });

        const entry = await makeSvc().evaluateOne(goal);

        expect(goal.resolvedScore?.violatedHardConstraintIds).toEqual([]);
        expect(entry.outcome).toBe('achieved');
        expect(escalations.record).not.toHaveBeenCalled();
    });

    it('survives a failed criterion metric read and records the error on that entry', async () => {
        metricsFacade.getMetricValue.mockImplementation(async (_plugin, query) => {
            const metricId = (query as { metricId: string }).metricId;
            if (metricId === 'churn') throw new Error('provider 503');
            return { value: 1500, unit: 'usd', at: new Date().toISOString() };
        });
        const goal = makeGoal({
            criteria: [
                { id: 'income', name: 'Income', weight: 1, target: 1000, direction: 'gte' },
                {
                    id: 'churn',
                    name: 'Churn',
                    weight: 1,
                    target: 5,
                    direction: 'lte',
                    metricSource: { pluginId: 'stripe', metricId: 'churn' },
                },
            ],
        });

        const entry = await makeSvc().evaluateOne(goal);

        // One criterion unreadable ⇒ not every criterion satisfied ⇒ not achieved.
        expect(entry.outcome).toBe('evaluated');
        expect(goal.resolvedScore?.criteria[1].error).toContain('503');
    });

    it('still writes exactly one metric sample from the Goal-level metric', async () => {
        // The samples table is the single-metric progress history and must
        // not start collecting one row per criterion.
        metricValues({ income: 1500, churn: 2 });
        const goal = makeGoal({
            criteria: [
                { id: 'income', name: 'Income', weight: 1, target: 1000, direction: 'gte' },
                {
                    id: 'churn',
                    name: 'Churn',
                    weight: 1,
                    target: 5,
                    direction: 'lte',
                    metricSource: { pluginId: 'stripe', metricId: 'churn' },
                },
            ],
        });

        await makeSvc().evaluateOne(goal);

        expect(samples.insert).toHaveBeenCalledTimes(1);
        expect(samples.insert).toHaveBeenCalledWith(
            expect.objectContaining({ goalId: 'g1', value: 1500 }),
        );
    });

    it('works with no escalation sink wired at all', async () => {
        metricValues({ income: 5000, spend: 900 });
        const svc = new GoalEvaluationService(
            goals as never,
            samples as never,
            metricsFacade as never,
        );
        jest.spyOn(
            (svc as never as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        const goal = makeGoal({
            criteria: [{ id: 'income', name: 'Income', weight: 1, target: 1000, direction: 'gte' }],
            constraints: [
                {
                    id: 'spend-cap',
                    name: 'Spend cap',
                    category: 'cost',
                    maxValue: 500,
                    metricSource: { pluginId: 'stripe', metricId: 'spend' },
                },
            ],
        });

        await expect(svc.evaluateOne(goal)).resolves.toBeDefined();
        expect(goal.resolvedScore?.violatedHardConstraintIds).toEqual(['spend-cap']);
    });
});
