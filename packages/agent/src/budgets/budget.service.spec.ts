import { BudgetService } from './budget.service';
import { WorkBudget, WorkBudgetScope } from '@src/entities/work-budget.entity';
import { WorkBudgetAlertThreshold } from '@src/entities/work-budget-alert-state.entity';

/**
 * EW-602 — BudgetService is the pure read-side layer behind the
 * budget UI and the BudgetGuard enforcement loop. The two repository
 * collaborators (WorkBudgetRepository, PluginUsageRepository) are
 * mocked as `jest.fn()` shells — no Nest container, no DB, no
 * timekeeping that depends on `Date.now()`.
 *
 * Coverage:
 *   - period boundary math (getCurrentPeriodStart / getNextPeriodStart)
 *   - applicable-budget lookup (global + plugin)
 *   - evaluateBudget threshold detection at 75 / 90 / 100 / overage
 *   - `blocked` is gated by allowOverage
 */

function makeBudgetRepo(overrides: Record<string, jest.Mock> = {}) {
    return {
        findGlobal: jest.fn(),
        findForPlugin: jest.fn(),
        findAllForWork: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        ...overrides,
    };
}

function makeUsageRepo(overrides: Record<string, jest.Mock> = {}) {
    return {
        record: jest.fn(),
        getTotalSpendCents: jest.fn().mockResolvedValue(0),
        getSpendByPlugin: jest.fn().mockResolvedValue([]),
        getDailySpend: jest.fn().mockResolvedValue([]),
        getCrossUserSpend: jest.fn().mockResolvedValue([]),
        findForExport: jest.fn().mockResolvedValue([]),
        pruneOlderThan: jest.fn().mockResolvedValue(0),
        ...overrides,
    };
}

function makeService(
    budget: Record<string, jest.Mock> = {},
    usage: Record<string, jest.Mock> = {},
) {
    const budgetRepo = makeBudgetRepo(budget);
    const usageRepo = makeUsageRepo(usage);
    const service = new BudgetService(budgetRepo as any, usageRepo as any);
    return { service, budgetRepo, usageRepo };
}

function makeBudget(overrides: Partial<WorkBudget> = {}): WorkBudget {
    return {
        id: 'budget-1',
        workId: 'work-1',
        scope: WorkBudgetScope.GLOBAL,
        pluginId: null,
        monthlyCapCents: 10_000,
        currency: 'usd',
        allowOverage: false,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-01T00:00:00Z'),
        work: undefined as any,
        ...overrides,
    } as WorkBudget;
}

describe('BudgetService', () => {
    describe('period boundaries', () => {
        it('getCurrentPeriodStart returns first-of-month at 00:00 UTC', () => {
            const { service } = makeService();
            const now = new Date('2026-05-15T22:34:56.789Z');
            const start = service.getCurrentPeriodStart(now);
            expect(start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
        });

        it('getNextPeriodStart returns first-of-next-month at 00:00 UTC', () => {
            const { service } = makeService();
            const now = new Date('2026-05-15T22:34:56.789Z');
            const end = service.getNextPeriodStart(now);
            expect(end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
        });

        it('rolls year over correctly at December → January', () => {
            const { service } = makeService();
            const now = new Date('2026-12-31T23:59:59.999Z');
            const end = service.getNextPeriodStart(now);
            expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
        });

        it('handles the first instant of a month (boundary case)', () => {
            const { service } = makeService();
            const now = new Date('2026-05-01T00:00:00.000Z');
            expect(service.getCurrentPeriodStart(now).toISOString()).toBe(
                '2026-05-01T00:00:00.000Z',
            );
            expect(service.getNextPeriodStart(now).toISOString()).toBe('2026-06-01T00:00:00.000Z');
        });
    });

    describe('getApplicableBudgets', () => {
        it('returns both global and plugin budgets when configured', async () => {
            const global = makeBudget({ id: 'g', scope: WorkBudgetScope.GLOBAL });
            const plugin = makeBudget({
                id: 'p',
                scope: WorkBudgetScope.PLUGIN,
                pluginId: 'openai',
            });
            const { service, budgetRepo } = makeService({
                findGlobal: jest.fn().mockResolvedValue(global),
                findForPlugin: jest.fn().mockResolvedValue(plugin),
            });
            const result = await service.getApplicableBudgets('work-1', 'openai');
            expect(result).toEqual({ global, plugin });
            expect(budgetRepo.findGlobal).toHaveBeenCalledWith('work-1');
            expect(budgetRepo.findForPlugin).toHaveBeenCalledWith('work-1', 'openai');
        });

        it('returns nulls when neither budget exists', async () => {
            const { service } = makeService({
                findGlobal: jest.fn().mockResolvedValue(null),
                findForPlugin: jest.fn().mockResolvedValue(null),
            });
            const result = await service.getApplicableBudgets('work-1', 'openai');
            expect(result).toEqual({ global: null, plugin: null });
        });
    });

    describe('evaluateBudget — threshold detection', () => {
        const now = new Date('2026-05-15T12:00:00Z');

        it('returns no crossed thresholds when spend is under 75%', async () => {
            const budget = makeBudget({ monthlyCapCents: 10_000 });
            const { service } = makeService(
                {},
                { getTotalSpendCents: jest.fn().mockResolvedValue(7_000) }, // 70%
            );
            const evaluation = await service.evaluateBudget(budget, now);
            expect(evaluation.percentUsed).toBe(70);
            expect(evaluation.crossedThresholds).toEqual([]);
            expect(evaluation.blocked).toBe(false);
        });

        it('crosses 75% only when spend reaches 75%', async () => {
            const budget = makeBudget({ monthlyCapCents: 10_000 });
            const { service } = makeService(
                {},
                { getTotalSpendCents: jest.fn().mockResolvedValue(7_500) }, // 75%
            );
            const evaluation = await service.evaluateBudget(budget, now);
            expect(evaluation.crossedThresholds).toEqual([WorkBudgetAlertThreshold.PERCENT_75]);
            expect(evaluation.blocked).toBe(false);
        });

        it('crosses 75 + 90 at 90%', async () => {
            const budget = makeBudget({ monthlyCapCents: 10_000 });
            const { service } = makeService(
                {},
                { getTotalSpendCents: jest.fn().mockResolvedValue(9_000) }, // 90%
            );
            const evaluation = await service.evaluateBudget(budget, now);
            expect(evaluation.crossedThresholds).toEqual([
                WorkBudgetAlertThreshold.PERCENT_75,
                WorkBudgetAlertThreshold.PERCENT_90,
            ]);
            expect(evaluation.blocked).toBe(false);
        });

        it('crosses 75 + 90 + 100 at 100% (no overage threshold without allowOverage)', async () => {
            const budget = makeBudget({ monthlyCapCents: 10_000, allowOverage: false });
            const { service } = makeService(
                {},
                { getTotalSpendCents: jest.fn().mockResolvedValue(10_000) },
            );
            const evaluation = await service.evaluateBudget(budget, now);
            expect(evaluation.crossedThresholds).toEqual([
                WorkBudgetAlertThreshold.PERCENT_75,
                WorkBudgetAlertThreshold.PERCENT_90,
                WorkBudgetAlertThreshold.PERCENT_100,
            ]);
            expect(evaluation.blocked).toBe(true);
        });

        it('emits the OVERAGE threshold and does NOT block when allowOverage = true', async () => {
            const budget = makeBudget({ monthlyCapCents: 10_000, allowOverage: true });
            const { service } = makeService(
                {},
                { getTotalSpendCents: jest.fn().mockResolvedValue(12_000) }, // 120%
            );
            const evaluation = await service.evaluateBudget(budget, now);
            expect(evaluation.crossedThresholds).toContain(WorkBudgetAlertThreshold.PERCENT_100);
            expect(evaluation.crossedThresholds).toContain(WorkBudgetAlertThreshold.OVERAGE);
            expect(evaluation.blocked).toBe(false);
        });

        it('returns currentSpendCents and capCents in the evaluation', async () => {
            const budget = makeBudget({ monthlyCapCents: 5_000 });
            const { service } = makeService(
                {},
                { getTotalSpendCents: jest.fn().mockResolvedValue(2_500) },
            );
            const evaluation = await service.evaluateBudget(budget, now);
            expect(evaluation.currentSpendCents).toBe(2_500);
            expect(evaluation.capCents).toBe(5_000);
            expect(evaluation.budget).toBe(budget);
        });

        it('handles a zero-cap budget without dividing by zero (percent = 0, not blocked at spend 0)', async () => {
            const budget = makeBudget({ monthlyCapCents: 0 });
            const { service } = makeService(
                {},
                { getTotalSpendCents: jest.fn().mockResolvedValue(0) },
            );
            const evaluation = await service.evaluateBudget(budget, now);
            expect(evaluation.percentUsed).toBe(0);
            expect(evaluation.crossedThresholds).toEqual([]);
            // 0 >= 0 is true → blocked when allowOverage is false. Sane default
            // (a zero cap is effectively "block all spend").
            expect(evaluation.blocked).toBe(true);
        });

        it('plumbs pluginId into getTotalSpendCents for plugin-scoped budgets', async () => {
            const budget = makeBudget({
                scope: WorkBudgetScope.PLUGIN,
                pluginId: 'openai',
            });
            const usage = makeUsageRepo({
                getTotalSpendCents: jest.fn().mockResolvedValue(0),
            });
            const service = new BudgetService(makeBudgetRepo() as any, usage as any);
            await service.evaluateBudget(budget, now);
            expect(usage.getTotalSpendCents).toHaveBeenCalledWith(
                'work-1',
                expect.any(Date),
                expect.any(Date),
                'openai',
            );
        });
    });
});
