import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { AgentCollaboratorsClient } from '@/components/agents/AgentCollaboratorsClient';

type Params = Promise<{ id: string; locale: string }>;

/**
 * Agent Collaborators tab — which OTHER agents this agent may spawn as
 * sub-agents. Server-composes the agent (cross-user 404) + the
 * candidate list with per-row allow-list state; the client renders the
 * Switch roster and writes through the collaborator server actions.
 */
export default async function AgentCollaboratorsPage({ params }: { params: Params }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    const initial = await agentsAPI.listCollaborators(id).catch(() => ({ data: [] }));

    return <AgentCollaboratorsClient agentId={id} initial={initial} />;
}
