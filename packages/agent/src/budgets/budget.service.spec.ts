import { BudgetService } from './budget.service';
import { BudgetOwnerType } from '@src/entities/_types';
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
        // Phase 7 PR T — polymorphic-owner lookups.
        findGlobalForOwner: jest.fn(),
        findForOwnerPlugin: jest.fn(),
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
        // Phase 7 PR T — owner-scoped spend rollup.
        getTotalSpendCentsForOwner: jest.fn().mockResolvedValue(0),
        // Phase 7 PR II — user-scoped account-wide rollup.
        getTotalSpendCentsForUser: jest.fn().mockResolvedValue(0),
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
                'usd',
            );
        });

        it('scopes the spend aggregate to the budget currency', async () => {
            // EW-602 follow-up: cap is denominated in one currency, so the
            // spend aggregate must filter to that currency too — otherwise
            // a non-usd event would inflate the usd total.
            const budget = makeBudget({ currency: 'eur', monthlyCapCents: 10_000 });
            const usage = makeUsageRepo({
                getTotalSpendCents: jest.fn().mockResolvedValue(0),
            });
            const service = new BudgetService(makeBudgetRepo() as any, usage as any);
            await service.evaluateBudget(budget, now);
            expect(usage.getTotalSpendCents).toHaveBeenCalledWith(
                'work-1',
                expect.any(Date),
                expect.any(Date),
                undefined,
                'eur',
            );
        });
    });

    describe('Phase 7 PR T — polymorphic-owner paths', () => {
        const ownerRef = { ownerType: BudgetOwnerType.MISSION, ownerId: 'mission-1' };

        it('getApplicableBudgetsForOwner queries the owner-scoped repo methods', async () => {
            const budgetRepo = makeBudgetRepo({
                findGlobalForOwner: jest.fn().mockResolvedValue(null),
                findForOwnerPlugin: jest.fn().mockResolvedValue(null),
            });
            const service = new BudgetService(budgetRepo as any, makeUsageRepo() as any);
            await service.getApplicableBudgetsForOwner(ownerRef, 'plugin-x');
            expect(budgetRepo.findGlobalForOwner).toHaveBeenCalledWith(ownerRef);
            expect(budgetRepo.findForOwnerPlugin).toHaveBeenCalledWith(ownerRef, 'plugin-x');
        });

        it('evaluateBudget uses the owner-scoped spend rollup for Mission/Idea budgets', async () => {
            const budget = makeBudget({
                ownerType: BudgetOwnerType.MISSION,
                ownerId: 'mission-1',
            });
            const usage = makeUsageRepo({
                getTotalSpendCentsForOwner: jest.fn().mockResolvedValue(4_200),
                getTotalSpendCents: jest.fn().mockResolvedValue(99_999), // sentinel — should NOT be called
            });
            const service = new BudgetService(makeBudgetRepo() as any, usage as any);
            const result = await service.evaluateBudget(budget);
            expect(result.currentSpendCents).toBe(4_200);
            expect(usage.getTotalSpendCentsForOwner).toHaveBeenCalledWith(
                'mission',
                'mission-1',
                expect.any(Date),
                expect.any(Date),
                undefined,
                'usd',
            );
            // Legacy workId-keyed query is NOT used for non-Work owners.
            expect(usage.getTotalSpendCents).not.toHaveBeenCalled();
        });

        describe('Phase 7 PR II — summarizeForUser', () => {
            it('rolls up account-wide spend with no cap', async () => {
                const usage = makeUsageRepo({
                    getTotalSpendCentsForUser: jest.fn().mockResolvedValue(750),
                });
                const service = new BudgetService(makeBudgetRepo() as any, usage as any);
                const result = await service.summarizeForUser('user-1', {
                    capCents: null,
                    allowOverage: true,
                });
                expect(result.currentSpendCents).toBe(750);
                expect(result.capCents).toBeNull();
                expect(result.percentUsed).toBeNull();
                expect(result.blocked).toBe(false);
                expect(usage.getTotalSpendCentsForUser).toHaveBeenCalledWith(
                    'user-1',
                    expect.any(Date),
                    expect.any(Date),
                    'usd',
                );
            });

            it('computes percentUsed when a cap is set', async () => {
                const usage = makeUsageRepo({
                    getTotalSpendCentsForUser: jest.fn().mockResolvedValue(2500),
                });
                const service = new BudgetService(makeBudgetRepo() as any, usage as any);
                const result = await service.summarizeForUser('user-1', {
                    capCents: 10_000,
                    allowOverage: true,
                });
                expect(result.percentUsed).toBe(25);
            });

            it('blocks when spend >= cap and allowOverage = false', async () => {
                const usage = makeUsageRepo({
                    getTotalSpendCentsForUser: jest.fn().mockResolvedValue(10_000),
                });
                const service = new BudgetService(makeBudgetRepo() as any, usage as any);
                const result = await service.summarizeForUser('user-1', {
                    capCents: 10_000,
                    allowOverage: false,
                });
                expect(result.blocked).toBe(true);
            });

            it('does NOT block when allowOverage = true even past cap', async () => {
                const usage = makeUsageRepo({
                    getTotalSpendCentsForUser: jest.fn().mockResolvedValue(20_000),
                });
                const service = new BudgetService(makeBudgetRepo() as any, usage as any);
                const result = await service.summarizeForUser('user-1', {
                    capCents: 10_000,
                    allowOverage: true,
                });
                expect(result.blocked).toBe(false);
                expect(result.percentUsed).toBe(200);
            });
        });

        it('evaluateBudget keeps using the legacy workId query for Work-owned budgets (back-compat)', async () => {
            // No `ownerType` set → defaults to WORK → legacy path.
            const budget = makeBudget({ ownerType: undefined as any });
            const usage = makeUsageRepo({
                getTotalSpendCents: jest.fn().mockResolvedValue(1_234),
                getTotalSpendCentsForOwner: jest.fn().mockResolvedValue(99_999),
            });
            const service = new BudgetService(makeBudgetRepo() as any, usage as any);
            const result = await service.evaluateBudget(budget);
            expect(result.currentSpendCents).toBe(1_234);
            // Owner-scoped query is NOT used for the Work-owned default.
            expect(usage.getTotalSpendCentsForOwner).not.toHaveBeenCalled();
            expect(usage.getTotalSpendCents).toHaveBeenCalled();
        });
    });
});
