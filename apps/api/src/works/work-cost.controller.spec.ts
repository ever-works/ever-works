// Stub the agent barrels so the spec never drags the entity / services / auth graph in (the
// sibling `work-evolve.controller.spec.ts` posture).
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class PluginUsageRepository {},
    WorkBudgetRepository: class WorkBudgetRepository {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
// APW-08 T56 — the Task titles behind the `tasks` lines (an optional, trailing dependency).
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TaskRepository: class TaskRepository {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';

import { WorkCostController, monthWindow, rollup } from './work-cost.controller';

/**
 * APW-08 T56 (XC-19, FR-73) — `GET /api/works/:id/cost`: the month's spend against the Work's own
 * budget, from the usage ledger and the existing `WorkBudget` (no new spend account). Before this
 * lane the route did not exist (the e2e contract row 08-7 was `shipped: false`).
 */
describe('WorkCostController (APW-08 T56)', () => {
    const auth = { userId: 'u1' } as never;

    function harness(
        over: { budget?: Record<string, unknown> | null; access?: () => Promise<unknown> } = {},
    ) {
        const ownership = {
            ensureCanView: jest.fn(over.access ?? (async () => ({ work: { id: 'w1' } }))),
        };
        const usage = {
            getTotalSpendCents: jest.fn(
                async (
                    _workId: string,
                    _start: Date,
                    _end: Date,
                    _pluginId?: string,
                    _currency?: string,
                ) => 9_200,
            ),
        };
        const budgets = {
            findGlobal: jest.fn(async () =>
                over.budget === undefined
                    ? { monthlyCapCents: 10_000, currency: 'eur', allowOverage: false }
                    : over.budget,
            ),
        };
        const controller = new WorkCostController(
            ownership as never,
            usage as never,
            budgets as never,
        );
        return { controller, ownership, usage, budgets };
    }

    it('answers the month’s spend against the Work’s budget, in the budget’s currency', async () => {
        const { controller, usage } = harness();
        const view = await controller.cost(auth, 'w1', '2026-09');

        expect(usage.getTotalSpendCents).toHaveBeenCalledWith(
            'w1',
            new Date('2026-09-01T00:00:00.000Z'),
            new Date('2026-10-01T00:00:00.000Z'),
            undefined,
            'eur',
        );
        expect(view).toEqual({
            workId: 'w1',
            month: '2026-09',
            periodStart: '2026-09-01T00:00:00.000Z',
            periodEnd: '2026-10-01T00:00:00.000Z',
            currency: 'eur',
            spendCents: 9_200,
            capCents: 10_000,
            remainingCents: 800,
            percentUsed: 92,
            allowOverage: false,
            alert: '90',
        });
    });

    it('with no budget: every currency counts, and cap, remaining and percent are null', async () => {
        const { controller, usage } = harness({ budget: null });
        const view = await controller.cost(auth, 'w1');
        expect(usage.getTotalSpendCents.mock.calls[0][4]).toBeUndefined();
        expect(view).toMatchObject({
            capCents: null,
            remainingCents: null,
            percentUsed: null,
            alert: 'none',
        });
    });

    it('another account’s Work, or one the caller cannot see, is one 404 not_found', async () => {
        for (const error of [new NotFoundException('x'), new ForbiddenException('x')]) {
            const { controller, usage } = harness({
                access: async () => {
                    throw error;
                },
            });
            const refusal = await controller.cost(auth, 'w1').catch((caught: unknown) => caught);
            expect(refusal).toBeInstanceOf(HttpException);
            expect((refusal as HttpException).getStatus()).toBe(404);
            expect((refusal as HttpException).getResponse()).toMatchObject({ code: 'not_found' });
            expect(usage.getTotalSpendCents).not.toHaveBeenCalled();
        }
    });

    it('a malformed month is a 400 invalidMonth', () => {
        // A repeated parameter arrives as an array; `['2026-09']` stringifies to a valid month.
        for (const bad of [
            '2026-13',
            '2026-1',
            'september',
            '2026-09-01',
            ['2026-09'],
            ['2026-09', 'x'],
            202609,
        ]) {
            let refusal: unknown;
            try {
                monthWindow(bad);
            } catch (caught) {
                refusal = caught;
            }
            expect((refusal as HttpException).getStatus()).toBe(400);
            expect((refusal as HttpException).getResponse()).toMatchObject({
                code: 'invalidMonth',
            });
        }
    });

    it('the default month is the current UTC month', () => {
        const window = monthWindow(undefined, new Date('2026-12-31T23:30:00Z'));
        expect(window).toEqual({
            label: '2026-12',
            start: new Date('2026-12-01T00:00:00.000Z'),
            end: new Date('2027-01-01T00:00:00.000Z'),
        });
    });

    it('walks the EW-602 alert ladder, and never reports a negative remainder', () => {
        const at = (spendCents: number, allowOverage = false) =>
            rollup({
                workId: 'w1',
                month: '2026-10',
                start: new Date('2026-10-01T00:00:00Z'),
                end: new Date('2026-11-01T00:00:00Z'),
                currency: 'usd',
                spendCents,
                capCents: 1_000,
                allowOverage,
            });
        expect(at(700).alert).toBe('none');
        expect(at(750).alert).toBe('75');
        expect(at(900).alert).toBe('90');
        expect(at(1_000).alert).toBe('100');
        expect(at(1_500).alert).toBe('100');
        expect(at(1_500, true).alert).toBe('overage');
        expect(at(1_500).remainingCents).toBe(0);
    });

    it('an amount the ledger could not give as a number is UNKNOWN, never 0 (ACC-08-37)', async () => {
        // Before T56 a non-numeric total read as 0 spent and the whole cap remaining.
        for (const unreadable of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
            const view = rollup({
                workId: 'w1',
                month: '2026-10',
                start: new Date('2026-10-01T00:00:00Z'),
                end: new Date('2026-11-01T00:00:00Z'),
                currency: 'usd',
                spendCents: unreadable as never,
                capCents: 1_000,
                allowOverage: false,
            });
            expect(view.spendCents).toBeNull();
            expect(view.remainingCents).toBeNull();
            expect(view.percentUsed).toBeNull();
            expect(view.capCents).toBe(1_000);
            expect(view.alert).toBe('none');
        }
        const { controller, usage } = harness();
        usage.getTotalSpendCents.mockResolvedValueOnce(Number.NaN as never);
        await expect(controller.cost(auth, 'w1', '2026-09')).resolves.toMatchObject({
            spendCents: null,
            remainingCents: null,
            capCents: 10_000,
        });
    });

    describe('the Task lines the overview links to each Task’s Cost section from (T56, FR-62)', () => {
        function withTasks(
            rows: Array<{ taskId: string; costCents: number }>,
            tasks: Record<string, { id: string; workId: string; userId: string; title?: string }>,
        ) {
            const { ownership, usage, budgets } = harness();
            const lines = {
                ...usage,
                getSpendByTaskForWork: jest.fn(async () => rows),
            };
            const repository = { findById: jest.fn(async (id: string) => tasks[id] ?? null) };
            const controller = new WorkCostController(
                ownership as never,
                lines as never,
                budgets as never,
                repository as never,
            );
            return { controller, lines, repository };
        }

        it('lists the month’s costliest Tasks of THIS Work the viewer owns, costliest first', async () => {
            const { controller, lines } = withTasks(
                [
                    { taskId: 't-big', costCents: 6_000 },
                    { taskId: 't-other-person', costCents: 2_000 },
                    { taskId: 't-other-work', costCents: 1_000 },
                    { taskId: 't-gone', costCents: 150 },
                    { taskId: 't-small', costCents: 50 },
                ],
                {
                    't-big': { id: 't-big', workId: 'w1', userId: 'u1', title: 'Add dark mode' },
                    // Record visibility: a Work viewer is not a reader of another person's Task.
                    't-other-person': {
                        id: 't-other-person',
                        workId: 'w1',
                        userId: 'u2',
                        title: 'x',
                    },
                    't-other-work': { id: 't-other-work', workId: 'w2', userId: 'u1', title: 'y' },
                    't-small': { id: 't-small', workId: 'w1', userId: 'u1' },
                },
            );
            const view = await controller.cost(auth, 'w1', '2026-09');

            expect(lines.getSpendByTaskForWork).toHaveBeenCalledWith(
                'w1',
                new Date('2026-09-01T00:00:00.000Z'),
                new Date('2026-10-01T00:00:00.000Z'),
                // The budget's currency, like the total.
                expect.objectContaining({ currency: 'eur' }),
            );
            expect(view.tasks).toEqual([
                { taskId: 't-big', title: 'Add dark mode', spendCents: 6_000 },
                { taskId: 't-small', title: null, spendCents: 50 },
            ]);
            // The rollup itself is untouched by the lines.
            expect(view).toMatchObject({
                spendCents: 9_200,
                capCents: 10_000,
                remainingCents: 800,
            });
        });

        it('lists at most WORK_COST_TASKS_LIMIT lines', async () => {
            const rows = Array.from({ length: 9 }, (_, i) => ({
                taskId: `t${i}`,
                costCents: 100 - i,
            }));
            const tasks = Object.fromEntries(
                rows.map((row) => [row.taskId, { id: row.taskId, workId: 'w1', userId: 'u1' }]),
            );
            const { controller } = withTasks(rows, tasks);
            const view = await controller.cost(auth, 'w1');
            expect(view.tasks).toHaveLength(5);
            expect(view.tasks?.[0]).toMatchObject({ taskId: 't0' });
        });

        it('a failed read is an empty list, never a failed rollup', async () => {
            const { controller, lines } = withTasks([], {});
            lines.getSpendByTaskForWork.mockRejectedValueOnce(new Error('db down'));
            const view = await controller.cost(auth, 'w1');
            expect(view.tasks).toEqual([]);
            expect(view.spendCents).toBe(9_200);
        });
    });
});
