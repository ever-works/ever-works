import type { Metadata } from 'next';
import { budgetsAPI } from '@/lib/api/budgets';
import { pluginsAPI } from '@/lib/api/plugins';
import { BudgetsUsageClient, type BudgetEligiblePlugin } from './budgets-usage-client';

export const metadata: Metadata = {
    title: 'Budgets & Usage',
};

type Params = { params: Promise<{ id: string }> };

// Capabilities that produce billable PluginUsageEvent rows (see
// PluginUsageCapability enum). Only plugins matching one of these categories
// are eligible for a per-plugin cap — capping a git-provider would be a
// no-op since no usage is ever recorded for it.
const BUDGET_ELIGIBLE_CATEGORIES = new Set([
    'ai-provider',
    'search',
    'screenshot',
    'content-extractor',
]);

export default async function BudgetsUsagePage({ params }: Params) {
    const { id } = await params;

    const [summary, list, plugins] = await Promise.all([
        budgetsAPI.getSummary(id).catch(() => null),
        budgetsAPI.list(id).catch(() => ({ budgets: [] as never[] })),
        pluginsAPI.listForWork(id).catch(() => ({ plugins: [] as never[], total: 0 })),
    ]);

    const eligiblePlugins: BudgetEligiblePlugin[] = plugins.plugins
        .filter((p) => p.workEnabled && BUDGET_ELIGIBLE_CATEGORIES.has(p.category))
        .map((p) => ({ pluginId: p.pluginId, name: p.name }));

    return (
        <BudgetsUsageClient
            workId={id}
            initialSummary={summary}
            initialBudgets={list.budgets}
            availablePlugins={eligiblePlugins}
        />
    );
}
