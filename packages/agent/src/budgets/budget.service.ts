import { Injectable } from '@nestjs/common';
import {
    WorkBudgetRepository,
    type BudgetOwnerRef,
} from '@src/database/repositories/work-budget.repository';
import { PluginUsageRepository } from '@src/database/repositories/plugin-usage.repository';
import { BudgetOwnerType } from '@src/entities/_types';
import { WorkBudget } from '@src/entities/work-budget.entity';
import { WorkBudgetAlertThreshold } from '@src/entities/work-budget-alert-state.entity';

export interface ApplicableBudgets {
    readonly global: WorkBudget | null;
    readonly plugin: WorkBudget | null;
}

export type { BudgetOwnerRef };

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

    /**
     * Phase 7 PR T — polymorphic-owner version. Same shape +
     * semantics as `getApplicableBudgets(workId, pluginId)` but
     * keyed on `(ownerType, ownerId)` so per-Mission and per-Idea
     * budgets resolve correctly. For Work owners this returns
     * the same rows as the legacy method (PR 0.3 backfilled
     * `ownerType='work'` + `ownerId=workId` on every pre-existing
     * row).
     */
    async getApplicableBudgetsForOwner(
        owner: BudgetOwnerRef,
        pluginId: string,
    ): Promise<ApplicableBudgets> {
        const [global, plugin] = await Promise.all([
            this.budgetRepository.findGlobalForOwner(owner),
            this.budgetRepository.findForOwnerPlugin(owner, pluginId),
        ]);
        return { global, plugin };
    }

    async getCurrentSpendCents(
        workId: string,
        pluginId?: string,
        now: Date = new Date(),
        currency?: string,
    ): Promise<number> {
        const periodStart = this.getCurrentPeriodStart(now);
        const periodEnd = this.getNextPeriodStart(now);
        return this.usageRepository.getTotalSpendCents(
            workId,
            periodStart,
            periodEnd,
            pluginId,
            currency,
        );
    }

    async evaluateBudget(budget: WorkBudget, now: Date = new Date()): Promise<BudgetEvaluation> {
        // Phase 7 PR T — when the budget carries a non-Work owner
        // (a Mission or Idea), use the polymorphic-owner spend
        // rollup so per-Mission and per-Idea evaluations resolve
        // correctly. Work-owned budgets keep using the legacy
        // workId-keyed query so existing tests that mock only
        // `getTotalSpendCents` keep passing (NN #20: extension,
        // not replacement). Both queries return the same number
        // for Work owners thanks to the PR 0.3 backfill.
        const ownerType = budget.ownerType ?? BudgetOwnerType.WORK;
        const ownerId = budget.ownerId ?? budget.workId;
        const isNonWorkOwner = ownerType !== BudgetOwnerType.WORK;
        const currentSpendCents = isNonWorkOwner
            ? await this.usageRepository.getTotalSpendCentsForOwner(
                  ownerType,
                  ownerId,
                  this.getCurrentPeriodStart(now),
                  this.getNextPeriodStart(now),
                  budget.pluginId ?? undefined,
                  budget.currency,
              )
            : await this.getCurrentSpendCents(
                  budget.workId,
                  budget.pluginId ?? undefined,
                  now,
                  budget.currency,
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
