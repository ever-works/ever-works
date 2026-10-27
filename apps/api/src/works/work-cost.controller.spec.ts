// Stub the agent barrels so the spec never drags the entity / services / auth graph in (the
// sibling `work-evolve.controller.spec.ts` posture).
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class PluginUsageRepository {},
    WorkBudgetRepository: class WorkBudgetRepository {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
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
});
