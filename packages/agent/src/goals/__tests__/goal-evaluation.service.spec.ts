import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { Goal, GoalOutcome, GoalStatus } from '../../entities/goal.entity';
import type { GoalMetricSample } from '../../entities/goal-metric-sample.entity';
import type { MetricsFacadeService } from '../../facades/metrics.facade';
import { GoalEvaluationService } from '../goal-evaluation.service';
import { MIN_CHECK_FREQUENCY_MINUTES } from '../types';

/**
 * Goals & Metrics — PR-8 evaluation engine unit tests.
 *
 * Hand-rolled repository + facade mocks (mirrors the
 * missions.service.spec idiom): plain `jest.fn()` surfaces are enough
 * for the exact calls `GoalEvaluationService` makes — `goals.find`,
 * the CAS `goals.update`, `goals.save`, the append-only
 * `samples.insert`, and `metricsFacade.getMetricValue`. The mocks
 * deliberately do NOT interpret TypeORM operators (`LessThanOrEqual`);
 * we drive behaviour by fixing what each mock resolves to.
 */

function makeGoal(overrides: Partial<Goal> = {}): Goal {
    return {
        id: 'g1',
        userId: 'u1',
        title: 'Income >= 1000/month',
        description: null,
        goalKind: 'metric',
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
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        ...overrides,
    } as Goal;
}

function makeMocks() {
    const goals = {
        find: jest.fn(),
        update: jest.fn(),
        save: jest.fn(async (g: Goal) => g),
    };
    const samples = {
        insert: jest.fn(async () => ({ identifiers: [] })),
    };
    const metricsFacade = {
        getMetricValue: jest.fn(),
    };
    const service = new GoalEvaluationService(
        goals as unknown as Repository<Goal>,
        samples as unknown as Repository<GoalMetricSample>,
        metricsFacade as unknown as MetricsFacadeService,
    );
    return { goals, samples, metricsFacade, service };
}

describe('GoalEvaluationService', () => {
    describe('evaluateOne', () => {
        it('gte satisfied → COMPLETED + ACHIEVED, sample appended, currentValue set', async () => {
            const { service, samples, metricsFacade, goals } = makeMocks();
            metricsFacade.getMetricValue.mockResolvedValue({
                value: 1500,
                unit: 'usd',
                at: '2026-07-19T00:00:00.000Z',
            });
            const goal = makeGoal({ comparator: 'gte', targetValue: 1000, baselineValue: null });

            const entry = await service.evaluateOne(goal);

            expect(entry).toEqual({ goalId: 'g1', outcome: 'achieved', value: 1500 });
            expect(goal.status).toBe(GoalStatus.COMPLETED);
            expect(goal.outcome).toBe(GoalOutcome.ACHIEVED);
            expect(goal.currentValue).toBe(1500);
            expect(goal.currentValueAt).toEqual(new Date('2026-07-19T00:00:00.000Z'));
            // First observation seeds the baseline.
            expect(goal.baselineValue).toBe(1500);
            // A satisfied goal stops being scheduled.
            expect(goal.nextCheckAt).toBeNull();
            // Immutable observation row written exactly once, before the goal save.
            expect(samples.insert).toHaveBeenCalledTimes(1);
            expect(samples.insert).toHaveBeenCalledWith(
                expect.objectContaining({ goalId: 'g1', value: 1500 }),
            );
            expect(goals.save).toHaveBeenCalledWith(goal);
        });

        it('lte satisfied → COMPLETED + ACHIEVED (shrink metric)', async () => {
            const { service, samples, metricsFacade } = makeMocks();
            metricsFacade.getMetricValue.mockResolvedValue({
                value: 20,
                unit: 'pct',
                at: '2026-07-19T00:00:00.000Z',
            });
            const goal = makeGoal({ comparator: 'lte', targetValue: 50, unit: 'pct' });

            const entry = await service.evaluateOne(goal);

            expect(entry.outcome).toBe('achieved');
            expect(goal.status).toBe(GoalStatus.COMPLETED);
            expect(goal.outcome).toBe(GoalOutcome.ACHIEVED);
            expect(goal.currentValue).toBe(20);
            expect(samples.insert).toHaveBeenCalledTimes(1);
        });

        it('deadline passed AND unmet → COMPLETED + MISSED, sample still appended', async () => {
            const { service, samples, metricsFacade } = makeMocks();
            metricsFacade.getMetricValue.mockResolvedValue({
                value: 500,
                unit: 'usd',
                at: '2026-07-19T00:00:00.000Z',
            });
            const past = new Date(Date.now() - 60_000);
            const goal = makeGoal({ comparator: 'gte', targetValue: 1000, deadline: past });

            const entry = await service.evaluateOne(goal);

            expect(entry.outcome).toBe('missed');
            expect(goal.status).toBe(GoalStatus.COMPLETED);
            expect(goal.outcome).toBe(GoalOutcome.MISSED);
            expect(goal.nextCheckAt).toBeNull();
            // Sample is recorded even on a miss (the read succeeded).
            expect(samples.insert).toHaveBeenCalledTimes(1);
        });

        it('unmet with no deadline → stays ACTIVE (outcome "evaluated"), keeps existing baseline', async () => {
            const { service, metricsFacade, samples } = makeMocks();
            metricsFacade.getMetricValue.mockResolvedValue({
                value: 500,
                unit: 'usd',
                at: '2026-07-19T00:00:00.000Z',
            });
            const goal = makeGoal({
                comparator: 'gte',
                targetValue: 1000,
                deadline: null,
                baselineValue: 100,
            });

            const entry = await service.evaluateOne(goal);

            expect(entry.outcome).toBe('evaluated');
            expect(goal.status).toBe(GoalStatus.ACTIVE);
            expect(goal.outcome).toBeNull();
            expect(goal.currentValue).toBe(500);
            // Existing baseline is NOT overwritten by later samples.
            expect(goal.baselineValue).toBe(100);
            expect(samples.insert).toHaveBeenCalledTimes(1);
        });

        it('facade throws → re-throws, NO sample appended, goal not mutated', async () => {
            const { service, metricsFacade, samples, goals } = makeMocks();
            const boom = new Error('provider down');
            metricsFacade.getMetricValue.mockRejectedValue(boom);
            const goal = makeGoal({ status: GoalStatus.ACTIVE });

            await expect(service.evaluateOne(goal)).rejects.toBe(boom);

            expect(samples.insert).not.toHaveBeenCalled();
            expect(goals.save).not.toHaveBeenCalled();
            expect(goal.status).toBe(GoalStatus.ACTIVE);
            expect(goal.outcome).toBeNull();
            expect(goal.currentValue).toBeNull();
        });
    });

    describe('evaluateDue (CAS claim)', () => {
        it('skips a goal whose CAS claim affects 0 rows (already claimed by another worker)', async () => {
            const { service, goals, samples, metricsFacade } = makeMocks();
            const goal = makeGoal({ id: 'g1', nextCheckAt: new Date('2026-07-19T00:00:00.000Z') });
            goals.find.mockResolvedValue([goal]);
            goals.update.mockResolvedValue({ affected: 0 });

            const summary = await service.evaluateDue();

            expect(summary.dueCount).toBe(1);
            expect(summary.skipped).toBe(1);
            expect(summary.evaluated).toBe(0);
            expect(summary.failed).toBe(0);
            expect(summary.entries[0]).toEqual(
                expect.objectContaining({ goalId: 'g1', outcome: 'skipped' }),
            );
            // A skipped goal is never read or sampled.
            expect(metricsFacade.getMetricValue).not.toHaveBeenCalled();
            expect(samples.insert).not.toHaveBeenCalled();
        });

        it('claims (affected 1) then evaluates the goal', async () => {
            const { service, goals, samples, metricsFacade } = makeMocks();
            const token = new Date('2026-07-19T00:00:00.000Z');
            const goal = makeGoal({
                id: 'g1',
                nextCheckAt: token,
                comparator: 'gte',
                targetValue: 1000,
            });
            goals.find.mockResolvedValue([goal]);
            goals.update.mockResolvedValue({ affected: 1 });
            metricsFacade.getMetricValue.mockResolvedValue({
                value: 500,
                unit: 'usd',
                at: '2026-07-19T00:05:00.000Z',
            });

            const summary = await service.evaluateDue();

            expect(summary.evaluated).toBe(1);
            expect(summary.skipped).toBe(0);
            expect(summary.entries[0].outcome).toBe('evaluated');
            // CAS token is the exact value read during the due scan.
            expect(goals.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'g1',
                    status: GoalStatus.ACTIVE,
                    nextCheckAt: token,
                }),
                expect.objectContaining({ nextCheckAt: expect.any(Date) }),
            );
            // Claim advanced the in-memory schedule past the token.
            expect(goal.nextCheckAt).not.toEqual(token);
            expect(samples.insert).toHaveBeenCalledTimes(1);
        });

        it('facade throws → counted failed, goal stays ACTIVE with advanced schedule, no sample', async () => {
            const { service, goals, samples, metricsFacade } = makeMocks();
            const token = new Date('2026-07-19T00:00:00.000Z');
            const goal = makeGoal({ id: 'g1', nextCheckAt: token, checkFrequencyMinutes: 30 });
            goals.find.mockResolvedValue([goal]);
            goals.update.mockResolvedValue({ affected: 1 });
            metricsFacade.getMetricValue.mockRejectedValue(new Error('boom'));

            const summary = await service.evaluateDue();

            expect(summary.failed).toBe(1);
            expect(summary.evaluated).toBe(0);
            expect(summary.skipped).toBe(0);
            expect(summary.entries[0]).toEqual(
                expect.objectContaining({ goalId: 'g1', outcome: 'failed', message: 'boom' }),
            );
            // Claim advanced nextCheckAt BEFORE the (failing) evaluation → no tight retry loop.
            expect(goal.nextCheckAt).not.toEqual(token);
            // Goal is left ACTIVE for the next interval.
            expect(goal.status).toBe(GoalStatus.ACTIVE);
            expect(samples.insert).not.toHaveBeenCalled();
        });

        it('re-clamps the schedule advance to >= 15 minutes (defense in depth)', async () => {
            jest.useFakeTimers();
            const fixedNow = new Date('2026-07-19T12:00:00.000Z');
            jest.setSystemTime(fixedNow);
            try {
                const { service, goals, metricsFacade } = makeMocks();
                const token = new Date('2026-07-19T11:00:00.000Z');
                // A row written by an older code path with a sub-minimum cadence.
                const goal = makeGoal({ id: 'g1', nextCheckAt: token, checkFrequencyMinutes: 5 });
                goals.find.mockResolvedValue([goal]);
                goals.update.mockResolvedValue({ affected: 1 });
                metricsFacade.getMetricValue.mockResolvedValue({
                    value: 10,
                    unit: 'x',
                    at: fixedNow.toISOString(),
                });

                await service.evaluateDue();

                const expectedNext = new Date(
                    fixedNow.getTime() + MIN_CHECK_FREQUENCY_MINUTES * 60_000,
                );
                expect(goals.update).toHaveBeenCalledWith(
                    expect.objectContaining({ id: 'g1', nextCheckAt: token }),
                    { nextCheckAt: expectedNext },
                );
            } finally {
                jest.useRealTimers();
            }
        });
    });

    // ── Self-build slice AG (EW-795): the delivery kind ────────────────

    /** A delivery Goal row: no metric at all, the DoD is the completion rule. */
    function deliveryGoal(overrides: Partial<Goal> = {}): Goal {
        return makeGoal({
            goalKind: 'delivery',
            metricSource: null,
            comparator: null,
            targetValue: null,
            unit: null,
            window: 'total',
            ...overrides,
        });
    }

    describe('evaluateOne — delivery kind', () => {
        it('completes on the approved Definition of Done alone — no provider read, no sample', async () => {
            const { service, samples, metricsFacade, goals } = makeMocks();
            const goal = deliveryGoal({
                dodCriteria: [
                    { id: 'api', text: 'API merged', status: 'done' },
                    { id: 'docs', text: 'Docs', status: 'waived' },
                ],
                nextCheckAt: new Date('2026-07-19T00:00:00.000Z'),
            });

            const entry = await service.evaluateOne(goal);

            expect(entry).toEqual({ goalId: 'g1', outcome: 'achieved' });
            expect('value' in entry).toBe(false);
            expect(goal.status).toBe(GoalStatus.COMPLETED);
            expect(goal.outcome).toBe(GoalOutcome.ACHIEVED);
            expect(goal.nextCheckAt).toBeNull();
            expect(metricsFacade.getMetricValue).not.toHaveBeenCalled();
            expect(samples.insert).not.toHaveBeenCalled();
            // Only the Goal row is written (invariant I-4 holds).
            expect(goals.save).toHaveBeenCalledTimes(1);
            expect(goals.save).toHaveBeenCalledWith(goal);
        });

        it('keeps iterating (outcome "evaluated", stays ACTIVE) while a criterion is open', async () => {
            const { service, samples, metricsFacade, goals } = makeMocks();
            const goal = deliveryGoal({
                dodCriteria: [
                    { id: 'api', text: 'API merged', status: 'done' },
                    { id: 'web', text: 'Web form', status: 'open' },
                ],
            });

            const entry = await service.evaluateOne(goal);

            expect(entry).toEqual({ goalId: 'g1', outcome: 'evaluated' });
            expect(goal.status).toBe(GoalStatus.ACTIVE);
            expect(goal.outcome).toBeNull();
            expect(goal.currentValue).toBeNull();
            expect(metricsFacade.getMetricValue).not.toHaveBeenCalled();
            expect(samples.insert).not.toHaveBeenCalled();
            expect(goals.save).toHaveBeenCalledWith(goal);
        });

        it('does not complete on proposed (unapproved) criteria, even when they are all done', async () => {
            const { service } = makeMocks();
            const goal = deliveryGoal({
                dodCriteria: [
                    { id: 'p', text: 'Planner says done', status: 'done', proposed: true },
                ],
            });

            const entry = await service.evaluateOne(goal);

            expect(entry.outcome).toBe('evaluated');
            expect(goal.status).toBe(GoalStatus.ACTIVE);
        });

        it('ignores pending proposals once the approved criteria are complete', async () => {
            const { service } = makeMocks();
            const goal = deliveryGoal({
                dodCriteria: [
                    { id: 'a', text: 'Approved and done', status: 'done' },
                    { id: 'p', text: 'Also add a FAQ', status: 'open', proposed: true },
                ],
            });

            const entry = await service.evaluateOne(goal);

            expect(entry.outcome).toBe('achieved');
            expect(goal.status).toBe(GoalStatus.COMPLETED);
        });

        it('deadline passed with an open criterion → COMPLETED + MISSED, still no provider call', async () => {
            const { service, metricsFacade } = makeMocks();
            const goal = deliveryGoal({
                dodCriteria: [{ id: 'a', text: 'x', status: 'open' }],
                deadline: new Date(Date.now() - 60_000),
            });

            const entry = await service.evaluateOne(goal);

            expect(entry.outcome).toBe('missed');
            expect(goal.status).toBe(GoalStatus.COMPLETED);
            expect(goal.outcome).toBe(GoalOutcome.MISSED);
            expect(goal.nextCheckAt).toBeNull();
            expect(metricsFacade.getMetricValue).not.toHaveBeenCalled();
        });

        it('a complete DoD beats a passed deadline', async () => {
            const { service } = makeMocks();
            const goal = deliveryGoal({
                dodCriteria: [{ id: 'a', text: 'x', status: 'done' }],
                deadline: new Date(Date.now() - 60_000),
            });

            const entry = await service.evaluateOne(goal);

            expect(entry.outcome).toBe('achieved');
            expect(goal.outcome).toBe(GoalOutcome.ACHIEVED);
        });

        it('fails closed on a metric row that lost one of its metric fields', async () => {
            const { service, samples, metricsFacade, goals } = makeMocks();
            const goal = makeGoal({ comparator: null });

            await expect(service.evaluateOne(goal)).rejects.toBeInstanceOf(BadRequestException);

            expect(metricsFacade.getMetricValue).not.toHaveBeenCalled();
            expect(samples.insert).not.toHaveBeenCalled();
            expect(goals.save).not.toHaveBeenCalled();
            expect(goal.status).toBe(GoalStatus.ACTIVE);
        });

        it('a pre-migration row with no goalKind evaluates as the metric Goal it is', async () => {
            const { service, metricsFacade, samples } = makeMocks();
            metricsFacade.getMetricValue.mockResolvedValue({
                value: 1500,
                unit: 'usd',
                at: '2026-07-19T00:00:00.000Z',
            });
            const goal = makeGoal({ goalKind: undefined });

            const entry = await service.evaluateOne(goal);

            expect(entry).toEqual({ goalId: 'g1', outcome: 'achieved', value: 1500 });
            expect(metricsFacade.getMetricValue).toHaveBeenCalledTimes(1);
            expect(samples.insert).toHaveBeenCalledTimes(1);
        });
    });

    describe('evaluateDue — delivery kind', () => {
        it('claims and completes a due delivery Goal without touching the provider', async () => {
            const { service, goals, samples, metricsFacade } = makeMocks();
            const token = new Date('2026-07-19T00:00:00.000Z');
            const goal = deliveryGoal({
                nextCheckAt: token,
                dodCriteria: [{ id: 'a', text: 'x', status: 'done' }],
            });
            goals.find.mockResolvedValue([goal]);
            goals.update.mockResolvedValue({ affected: 1 });

            const summary = await service.evaluateDue();

            expect(summary.evaluated).toBe(1);
            expect(summary.failed).toBe(0);
            expect(summary.entries[0]).toEqual({ goalId: 'g1', outcome: 'achieved' });
            expect(metricsFacade.getMetricValue).not.toHaveBeenCalled();
            expect(samples.insert).not.toHaveBeenCalled();
            expect(goal.status).toBe(GoalStatus.COMPLETED);
        });

        it('counts a corrupt metric row as failed and moves on (no sample, schedule advanced)', async () => {
            const { service, goals, samples, metricsFacade } = makeMocks();
            const token = new Date('2026-07-19T00:00:00.000Z');
            const goal = makeGoal({ nextCheckAt: token, targetValue: null });
            goals.find.mockResolvedValue([goal]);
            goals.update.mockResolvedValue({ affected: 1 });

            const summary = await service.evaluateDue();

            expect(summary.failed).toBe(1);
            expect(summary.evaluated).toBe(0);
            expect(summary.entries[0]).toEqual(
                expect.objectContaining({ goalId: 'g1', outcome: 'failed' }),
            );
            expect(metricsFacade.getMetricValue).not.toHaveBeenCalled();
            expect(samples.insert).not.toHaveBeenCalled();
            expect(goal.nextCheckAt).not.toEqual(token);
            expect(goal.status).toBe(GoalStatus.ACTIVE);
        });
    });
});
