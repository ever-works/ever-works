import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { AgentBudgetsClient } from '@/components/agents/AgentBudgetsClient';

type Params = Promise<{ id: string; locale: string }>;

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-4.
 *
 * Per-Agent spend rollup. Server-fetches the budget from the FU-2
 * endpoint and renders a current-period progress bar + 30-day total.
 * When `capCents` is null (Agent without an explicit budget cap), the
 * progress bar is hidden and the panel renders the running total
 * with a "no cap configured" hint.
 */
export default async function AgentBudgetsPage({ params }: { params: Params }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    const budget = await agentsAPI.getBudget(id).catch(() => ({
        currentSpendCents: 0,
        capCents: null,
        periodStart: new Date().toISOString(),
        periodEnd: new Date().toISOString(),
        currency: 'USD',
    }));

    return <AgentBudgetsClient agentId={id} initial={budget} />;
}
