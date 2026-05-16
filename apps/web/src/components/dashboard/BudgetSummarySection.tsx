import { budgetsAPI } from '@/lib/api/budgets';
import { BudgetOverviewCard } from './BudgetOverviewCard';
import { TopPluginsCard } from './TopPluginsCard';
import { SpendTrendCard } from './SpendTrendCard';

interface BudgetSummarySectionProps {
    workId: string;
}

/**
 * EW-602 — Server component that fetches the per-Work usage summary +
 * trend in parallel and renders the 3 dashboard widgets in a 3-column
 * grid (collapsing to 1 column on small screens).
 *
 * Failures degrade gracefully: a fetch error returns null and the
 * section disappears rather than blocking the parent page.
 */
export async function BudgetSummarySection({ workId }: BudgetSummarySectionProps) {
    let summary;
    let trend;
    try {
        [summary, trend] = await Promise.all([
            budgetsAPI.getSummary(workId),
            budgetsAPI.getTrend(workId, undefined, 'day'),
        ]);
    } catch {
        return null;
    }

    return (
        <div className="grid grid-cols-1 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 gap-6">
            <BudgetOverviewCard
                totalSpendCents={summary.totalSpendCents}
                currency={summary.currency}
                periodLabel={summary.periodLabel}
                globalBudget={summary.globalBudget}
            />
            <TopPluginsCard perPlugin={summary.perPlugin} currency={summary.currency} />
            <SpendTrendCard
                buckets={trend.buckets}
                currency={summary.currency}
                periodLabel={summary.periodLabel}
            />
        </div>
    );
}
