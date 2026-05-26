import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { AgentActivityClient } from '@/components/agents/AgentActivityClient';

type Params = Promise<{ id: string; locale: string }>;

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-4.
 *
 * Per-Agent activity feed. Server-fetches the most recent runs via
 * `agentsAPI.listRuns()` (paginated by the FU-2 endpoint added on the
 * api-side controller) and renders the compact list with event-type
 * chips + cancel affordance for queued/running rows.
 */
export default async function AgentActivityPage({ params }: { params: Params }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    const initial = await agentsAPI
        .listRuns(id, { limit: 25, offset: 0 })
        .catch(() => ({ data: [], meta: { total: 0, limit: 25, offset: 0 } }));

    return <AgentActivityClient agentId={id} initial={initial} />;
}
