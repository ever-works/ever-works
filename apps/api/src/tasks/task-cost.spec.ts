import { TASK_COST_RUNS_LIMIT } from '@ever-works/contracts';

import { buildTaskCostView, runReceiptUrl, withTaskContainment } from './task-cost';

/**
 * APW-08 T24 (cost half) — `GET /api/tasks/:id/cost` reads the one usage ledger: each run's cost is
 * its receipt lines summed, the total is every row attributed to the Task. Before this lane the
 * route did not exist (the e2e contract row 08-5 was `shipped: false`).
 */
describe('buildTaskCostView (APW-08 T24)', () => {
    const run = (id: string, over: Record<string, unknown> = {}) => ({
        id,
        status: 'completed',
        startedAt: new Date('2026-10-27T10:00:00Z'),
        ...over,
    });

    it('sums each run’s receipt lines, links the receipt, and takes the total from the ledger', async () => {
        const usage = {
            getTotalSpendCentsForTask: jest.fn(async () => 175),
            getRunSpendLines: jest.fn(async (runId: string) =>
                runId === 'r1' ? [{ costCents: 100 }, { costCents: 25 }] : [{ costCents: 50 }],
            ),
        };
        const runs = { findRecentForTask: jest.fn(async () => [run('r1'), run('r2')]) };

        const view = await buildTaskCostView('t1', { usage, runs });

        expect(usage.getTotalSpendCentsForTask).toHaveBeenCalledWith('t1', { currency: 'usd' });
        expect(runs.findRecentForTask).toHaveBeenCalledWith('t1', TASK_COST_RUNS_LIMIT + 1);
        expect(view).toEqual({
            taskId: 't1',
            runs: [
                {
                    runId: 'r1',
                    costCents: 125,
                    receiptUrl: '/agents/sessions/r1',
                    status: 'completed',
                    startedAt: '2026-10-27T10:00:00.000Z',
                },
                {
                    runId: 'r2',
                    costCents: 50,
                    receiptUrl: '/agents/sessions/r2',
                    status: 'completed',
                    startedAt: '2026-10-27T10:00:00.000Z',
                },
            ],
            builds: [],
            totalCents: 175,
            currency: 'usd',
            runsLimit: TASK_COST_RUNS_LIMIT,
            runsTruncated: false,
        });
    });

    it('a run with no priced line yet costs null, not 0, and an unreadable receipt does not fail the view', async () => {
        const usage = {
            getTotalSpendCentsForTask: jest.fn(async () => 0),
            getRunSpendLines: jest.fn(async (runId: string) => {
                if (runId === 'r2') throw new Error('ledger hiccup');
                return [];
            }),
        };
        const view = await buildTaskCostView('t1', {
            usage,
            runs: { findRecentForTask: async () => [run('r1'), run('r2')] },
        });
        expect(view.runs.map((entry) => entry.costCents)).toEqual([null, null]);
    });

    it(`lists at most ${TASK_COST_RUNS_LIMIT} runs and says when there are more`, async () => {
        const many = Array.from({ length: TASK_COST_RUNS_LIMIT + 1 }, (_, index) =>
            run(`r${index}`),
        );
        const view = await buildTaskCostView('t1', {
            usage: { getTotalSpendCentsForTask: async () => 1, getRunSpendLines: async () => [] },
            runs: { findRecentForTask: async () => many },
        });
        expect(view.runs).toHaveLength(TASK_COST_RUNS_LIMIT);
        expect(view.runsTruncated).toBe(true);
    });

    it('without a run repository it still answers the Task’s total', async () => {
        const view = await buildTaskCostView('t1', {
            usage: { getTotalSpendCentsForTask: async () => 42, getRunSpendLines: async () => [] },
            runs: null,
        });
        expect(view.runs).toEqual([]);
        expect(view.totalCents).toBe(42);
    });

    it('encodes the run id in the receipt link', () => {
        expect(runReceiptUrl('a/b')).toBe('/agents/sessions/a%2Fb');
    });
});

/**
 * APW-08 T48 / T12 (FR-70, S33, ACC-08-34) — the Cost view's containment half: an App Work Task's
 * latest Fleet run record and the nodes holding its next run. Every other view is returned exactly
 * as built (no keys added), and a reader that fails never costs the view its cost half.
 */
describe('withTaskContainment (APW-08 T48)', () => {
    const view = {
        taskId: 't1',
        runs: [],
        builds: [],
        totalCents: 0,
        currency: 'usd',
        runsLimit: TASK_COST_RUNS_LIMIT,
        runsTruncated: false,
    };
    const task = { id: 't1', userId: 'u1', workId: 'w1' };
    const record = {
        executionPath: 'ordinary' as const,
        isolatedHome: false,
        downgrades: [{ control: 'isolated-home', reason: 'inherit' }],
        needsOwnerAllowance: true,
        runId: 'r1',
        nodeId: 'n1',
        nodeName: 'Maya desktop',
        reportedAt: '2026-10-30T00:00:00.000Z',
        reported: true,
        allowedByOwner: false,
    };

    it('adds the record and the holds for an App Work Task', async () => {
        const reader = {
            describeForTask: jest.fn(async () => ({ containment: record, containmentHolds: [record] })),
        };
        const out = await withTaskContainment(view, task, reader);
        expect(out).toEqual({ ...view, containment: record, containmentHolds: [record] });
        expect(reader.describeForTask).toHaveBeenCalledWith(task);
    });

    it('returns every other view exactly as built: no reader, a non-App Task (null), a reader that throws', async () => {
        expect(await withTaskContainment(view, task, null)).toBe(view);
        expect(await withTaskContainment(view, task, { describeForTask: async () => null })).toBe(view);
        expect(
            await withTaskContainment(view, task, {
                describeForTask: async () => {
                    throw new Error('db down');
                },
            }),
        ).toBe(view);
    });
});
