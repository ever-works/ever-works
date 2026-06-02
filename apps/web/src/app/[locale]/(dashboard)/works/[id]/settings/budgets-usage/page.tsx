import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { canAccessSettings } from '@/lib/permissions';
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

    // Security: gate the budgets/usage settings sub-page on the user's Work
    // role, mirroring the sibling settings pages (settings/page.tsx,
    // settings/members/page.tsx). Without this, any member (incl. VIEWER) could
    // read budget caps and per-plugin spend by navigating directly to this
    // route. workAPI.get is React.cache()-memoised, so this adds no extra fetch.
    let work;
    try {
        const res = await workAPI.get(id);
        work = res.work;
    } catch {
        notFound();
    }

    if (!canAccessSettings(work.userRole)) {
        notFound();
    }

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
