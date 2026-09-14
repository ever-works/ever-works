import { Injectable, Optional } from '@nestjs/common';
import { HOME_SPEND_WINDOW_DAYS, type HomeSpend } from '@ever-works/contracts';
import { toAccountWideBudgetPrefs } from '../../budgets/account-wide-budget-prefs';
import { BudgetService, type UserBudgetSummary } from '../../budgets/budget.service';
import type { OwnershipScope } from '../../database/ownership-scope';
import { PluginUsageRepository } from '../../database/repositories/plugin-usage.repository';
import {
    CostsSummaryService,
    type CostsSummary,
} from '../../subscriptions/credits/costs-summary.service';
import { WorkAgentService } from '../../work-agent/work-agent.service';
import { HomeSourceUnavailableError, type HomeBuildContext } from '../home-build-context';

/**
 * Compose the This-week panel. Pure.
 *
 * The headline, run count and average are the SCOPED Costs summary. The cap
 * is the account-wide budget summary — the same numbers the account-wide
 * usage endpoint reports — and is never derived from the scoped total.
 */
export function toHomeSpend(input: {
    summary: CostsSummary;
    accountCap: UserBudgetSummary;
    everRecordedUsage: boolean;
    scope: OwnershipScope;
}): HomeSpend {
    const { summary, accountCap, everRecordedUsage, scope } = input;
    const capCents = accountCap.capCents;
    const hasCap = capCents !== null && capCents > 0;
    return {
        windowDays: summary.windowDays,
        totalCents: summary.totalCostCents,
        currency: accountCap.currency,
        runsCount: summary.runsCount,
        avgPerRunCents: summary.runsCount > 0 ? summary.avgPerRunCents : null,
        scope: { kind: scope.organizationId ? 'organization' : 'personal' },
        accountCap: {
            periodSpendCents: accountCap.currentSpendCents,
            periodCapCents: hasCap ? capCents : null,
            percentUsed: hasCap ? (accountCap.percentUsed ?? null) : null,
            blocked: accountCap.blocked,
            allowOverage: accountCap.allowOverage,
        },
        everSpent:
            everRecordedUsage || summary.totalCostCents > 0 || accountCap.currentSpendCents > 0,
    };
}

/** This week — the Costs summary (scoped) beside the account-wide cap. */
@Injectable()
export class HomeSpendBuilder {
    constructor(
        @Optional() private readonly costs?: CostsSummaryService,
        @Optional() private readonly budgets?: BudgetService,
        @Optional() private readonly workAgent?: WorkAgentService,
        @Optional() private readonly pluginUsage?: PluginUsageRepository,
    ) {}

    async build(context: HomeBuildContext): Promise<HomeSpend> {
        const { costs, budgets, workAgent, pluginUsage } = this;
        if (!costs || !budgets || !workAgent || !pluginUsage) {
            throw new HomeSourceUnavailableError('spend');
        }
        const [summary, accountCap, everRecordedUsage] = await Promise.all([
            costs.getSummary(context.userId, HOME_SPEND_WINDOW_DAYS, context.scope),
            workAgent
                .getPreferences(context.userId)
                .then((prefs) =>
                    budgets.summarizeForUser(context.userId, toAccountWideBudgetPrefs(prefs)),
                ),
            pluginUsage.hasAnyUsageForUser(context.userId),
        ]);
        return toHomeSpend({ summary, accountCap, everRecordedUsage, scope: context.scope });
    }
}
