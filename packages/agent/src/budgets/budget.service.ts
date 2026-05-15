import { Injectable } from '@nestjs/common';
import { WorkBudgetRepository } from '@src/database/repositories/work-budget.repository';
import { PluginUsageRepository } from '@src/database/repositories/plugin-usage.repository';
import { WorkBudget } from '@src/entities/work-budget.entity';
import { WorkBudgetAlertThreshold } from '@src/entities/work-budget-alert-state.entity';

export interface ApplicableBudgets {
    readonly global: WorkBudget | null;
    readonly plugin: WorkBudget | null;
}

export interface BudgetEvaluation {
    readonly budget: WorkBudget;
    readonly currentSpendCents: number;
    readonly capCents: number;
    readonly percentUsed: number;
    readonly crossedThresholds: readonly WorkBudgetAlertThreshold[];
    /**
     * True when current spend ≥ cap AND `allowOverage` = false.
     * The BudgetGuardService translates this into a thrown
     * BudgetExceededException at the facade entry point.
     */
    readonly blocked: boolean;
}

/**
 * EW-602 — Pure read service: computes current-period spend, resolves
 * applicable budgets for a (Work, plugin) pair, and reports which
 * thresholds the spend has crossed.
 *
 * Period boundary = first-of-month UTC. Recomputed lazily on every
 * query (no cron, no cache) — Postgres handles the aggregate cheaply
 * with the indexes shipped in Phase 1a.
 */
@Injectable()
export class BudgetService {
    private static readonly THRESHOLD_PERCENTS: ReadonlyArray<{
        threshold: WorkBudgetAlertThreshold;
        minPercent: number;
    }> = [
        { threshold: WorkBudgetAlertThreshold.PERCENT_75, minPercent: 75 },
        { threshold: WorkBudgetAlertThreshold.PERCENT_90, minPercent: 90 },
        { threshold: WorkBudgetAlertThreshold.PERCENT_100, minPercent: 100 },
    ];

    constructor(
        private readonly budgetRepository: WorkBudgetRepository,
        private readonly usageRepository: PluginUsageRepository,
    ) {}

    /** First day of the current calendar month at 00:00:00 UTC. */
    getCurrentPeriodStart(now: Date = new Date()): Date {
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    }

    /** First day of the next calendar month at 00:00:00 UTC. */
    getNextPeriodStart(now: Date = new Date()): Date {
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }

    async getApplicableBudgets(workId: string, pluginId: string): Promise<ApplicableBudgets> {
        const [global, plugin] = await Promise.all([
            this.budgetRepository.findGlobal(workId),
            this.budgetRepository.findForPlugin(workId, pluginId),
        ]);
        return { global, plugin };
    }

    async getCurrentSpendCents(
        workId: string,
        pluginId?: string,
        now: Date = new Date(),
    ): Promise<number> {
        const periodStart = this.getCurrentPeriodStart(now);
        const periodEnd = this.getNextPeriodStart(now);
        return this.usageRepository.getTotalSpendCents(workId, periodStart, periodEnd, pluginId);
    }

    async evaluateBudget(budget: WorkBudget, now: Date = new Date()): Promise<BudgetEvaluation> {
        const currentSpendCents = await this.getCurrentSpendCents(
            budget.workId,
            budget.pluginId ?? undefined,
            now,
        );

        const capCents = budget.monthlyCapCents;
        const percentUsed = capCents > 0 ? (currentSpendCents / capCents) * 100 : 0;

        const crossedThresholds: WorkBudgetAlertThreshold[] = [];
        for (const { threshold, minPercent } of BudgetService.THRESHOLD_PERCENTS) {
            if (percentUsed >= minPercent) {
                crossedThresholds.push(threshold);
            }
        }
        if (percentUsed > 100 && budget.allowOverage) {
            crossedThresholds.push(WorkBudgetAlertThreshold.OVERAGE);
        }

        const blocked = currentSpendCents >= capCents && !budget.allowOverage;

        return {
            budget,
            currentSpendCents,
            capCents,
            percentUsed,
            crossedThresholds,
            blocked,
        };
    }
}
