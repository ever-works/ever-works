import type { Metadata } from 'next';
import { budgetsAPI } from '@/lib/api/budgets';
import { BudgetsUsageClient } from './budgets-usage-client';

export const metadata: Metadata = {
    title: 'Budgets & Usage',
};

type Params = { params: Promise<{ id: string }> };

export default async function BudgetsUsagePage({ params }: Params) {
    const { id } = await params;

    const [summary, list] = await Promise.all([
        budgetsAPI.getSummary(id).catch(() => null),
        budgetsAPI.list(id).catch(() => ({ budgets: [] as never[] })),
    ]);

    return (
        <BudgetsUsageClient
            workId={id}
            initialSummary={summary}
            initialBudgets={list.budgets}
        />
    );
}
