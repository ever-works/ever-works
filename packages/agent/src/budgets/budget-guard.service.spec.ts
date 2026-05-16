import { BudgetGuardService } from './budget-guard.service';
import { BudgetService } from './budget.service';
import { BudgetExceededException } from './budget-exceeded.exception';
import { BudgetThresholdCrossedEvent } from './budget-threshold-crossed.event';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { WorkBudget, WorkBudgetScope } from '@src/entities/work-budget.entity';
import { WorkBudgetAlertThreshold } from '@src/entities/work-budget-alert-state.entity';

/**
 * EW-602 — BudgetGuardService is the enforcement gate at the top of
 * each capability facade. Coverage:
 *   - throws BudgetExceededException (HTTP 402) on a blocked budget
 *   - skips silently when no budgets are configured
 *   - emits BudgetThresholdCrossedEvent for newly-crossed thresholds
 *     (idempotency-guarded by WorkBudgetAlertStateRepository)
 *   - pre-flight: blocks BEFORE the call when estimatedCostCents
 *     would push over the cap on a non-overage budget
 */

function makeBudget(overrides: Partial<WorkBudget> = {}): WorkBudget {
    return {
        id: 'budget-1',
        workId: 'work-1',
        scope: WorkBudgetScope.GLOBAL,
        pluginId: null,
        monthlyCapCents: 10_000,
        currency: 'usd',
        allowOverage: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        work: undefined as any,
        ...overrides,
    } as WorkBudget;
}

function makeAlertStateRepo(overrides: Record<string, jest.Mock> = {}) {
    return {
        hasAlerted: jest.fn().mockResolvedValue(false),
        record: jest.fn().mockResolvedValue(undefined),
        listForBudget: jest.fn().mockResolvedValue([]),
        ...overrides,
    };
}

function makeEventEmitter() {
    return { emit: jest.fn() };
}

function makeGuard({
    global = null as WorkBudget | null,
    plugin = null as WorkBudget | null,
    currentSpendCents = 0,
    alertState = makeAlertStateRepo(),
    eventEmitter = makeEventEmitter(),
}: {
    global?: WorkBudget | null;
    plugin?: WorkBudget | null;
    currentSpendCents?: number;
    alertState?: ReturnType<typeof makeAlertStateRepo>;
    eventEmitter?: ReturnType<typeof makeEventEmitter>;
} = {}) {
    const budgetRepo = {
        findGlobal: jest.fn().mockResolvedValue(global),
        findForPlugin: jest.fn().mockResolvedValue(plugin),
        findAllForWork: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    };
    const usageRepo = {
        record: jest.fn(),
        getTotalSpendCents: jest.fn().mockResolvedValue(currentSpendCents),
        getSpendByPlugin: jest.fn(),
        getDailySpend: jest.fn(),
        getCrossUserSpend: jest.fn(),
        findForExport: jest.fn(),
        pruneOlderThan: jest.fn(),
    };
    const budgetService = new BudgetService(budgetRepo as any, usageRepo as any);
    const guard = new BudgetGuardService(budgetService, alertState as any, eventEmitter as any);
    return { guard, budgetRepo, usageRepo, alertState, eventEmitter };
}

describe('BudgetGuardService.checkBudget', () => {
    const NOW = new Date('2026-05-15T12:00:00Z');

    it('returns silently when no budgets are configured for the Work', async () => {
        const { guard, eventEmitter } = makeGuard();
        await expect(
            guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
                now: NOW,
            }),
        ).resolves.toBeUndefined();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('throws BudgetExceededException when global cap is reached and allowOverage = false', async () => {
        const global = makeBudget({ monthlyCapCents: 10_000, allowOverage: false });
        const { guard } = makeGuard({ global, currentSpendCents: 10_000 });
        await expect(
            guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
                now: NOW,
            }),
        ).rejects.toBeInstanceOf(BudgetExceededException);
    });

    it('does NOT throw when at-cap but allowOverage = true (warning only)', async () => {
        const global = makeBudget({ monthlyCapCents: 10_000, allowOverage: true });
        const { guard } = makeGuard({ global, currentSpendCents: 12_000 });
        await expect(
            guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
                now: NOW,
            }),
        ).resolves.toBeUndefined();
    });

    it('emits BudgetThresholdCrossedEvent for each newly-crossed threshold', async () => {
        const global = makeBudget({ monthlyCapCents: 10_000, allowOverage: true });
        const { guard, eventEmitter, alertState } = makeGuard({
            global,
            currentSpendCents: 9_500, // 95% → crosses 75 + 90
        });
        await guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
            now: NOW,
        });
        expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
        expect(eventEmitter.emit).toHaveBeenCalledWith(
            BudgetThresholdCrossedEvent.EVENT_NAME,
            expect.objectContaining({ threshold: WorkBudgetAlertThreshold.PERCENT_75 }),
        );
        expect(eventEmitter.emit).toHaveBeenCalledWith(
            BudgetThresholdCrossedEvent.EVENT_NAME,
            expect.objectContaining({ threshold: WorkBudgetAlertThreshold.PERCENT_90 }),
        );
        expect(alertState.record).toHaveBeenCalledTimes(2);
    });

    it('does NOT re-emit a threshold that was already alerted in the period (idempotent)', async () => {
        const global = makeBudget({ monthlyCapCents: 10_000, allowOverage: true });
        const { guard, eventEmitter } = makeGuard({
            global,
            currentSpendCents: 7_500, // 75%
            alertState: makeAlertStateRepo({
                hasAlerted: jest
                    .fn()
                    .mockImplementation((_b, threshold: WorkBudgetAlertThreshold) =>
                        Promise.resolve(threshold === WorkBudgetAlertThreshold.PERCENT_75),
                    ),
            }),
        });
        await guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
            now: NOW,
        });
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('pre-flight: blocks when estimatedCostCents would push the next call over the cap', async () => {
        const global = makeBudget({ monthlyCapCents: 10_000, allowOverage: false });
        const { guard } = makeGuard({
            global,
            currentSpendCents: 9_500, // already at 95%
        });
        // Estimated 1000c more would land at 10500 > 10000 cap.
        await expect(
            guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
                estimatedCostCents: 1000,
                now: NOW,
            }),
        ).rejects.toBeInstanceOf(BudgetExceededException);
    });

    it('pre-flight: does NOT block when estimatedCostCents stays under cap', async () => {
        const global = makeBudget({ monthlyCapCents: 10_000, allowOverage: false });
        const { guard } = makeGuard({
            global,
            currentSpendCents: 5_000, // 50%
        });
        await expect(
            guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
                estimatedCostCents: 1000, // 5000 + 1000 < 10000
                now: NOW,
            }),
        ).resolves.toBeUndefined();
    });

    it('pre-flight: respects allowOverage (does not block even if estimate exceeds)', async () => {
        const global = makeBudget({ monthlyCapCents: 10_000, allowOverage: true });
        const { guard } = makeGuard({
            global,
            currentSpendCents: 9_500,
        });
        await expect(
            guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
                estimatedCostCents: 5000,
                now: NOW,
            }),
        ).resolves.toBeUndefined();
    });

    it('throws even when only the plugin-scoped budget is exceeded (not global)', async () => {
        const plugin = makeBudget({
            id: 'p',
            scope: WorkBudgetScope.PLUGIN,
            pluginId: 'openai',
            monthlyCapCents: 1_000,
            allowOverage: false,
        });
        const { guard } = makeGuard({
            global: null,
            plugin,
            currentSpendCents: 1_000,
        });
        await expect(
            guard.checkBudget('work-1', 'user-1', PluginUsageCapability.AI, 'openai', {
                now: NOW,
            }),
        ).rejects.toBeInstanceOf(BudgetExceededException);
    });
});
