import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { AgentSkillsClient } from '@/components/agents/AgentSkillsClient';

type Params = Promise<{ id: string; locale: string }>;

/**
 * Agents/Skills/Tasks PR #1019 follow-up — FU-4.
 *
 * Per-Agent skill bindings list. Server-fetches the resolved bindings
 * via `agentsAPI.listSkills()` and renders the bound Skills with
 * priority + a "remove binding" affordance (calls
 * `DELETE /api/skill-bindings/:id` via the existing skills client).
 */
export default async function AgentSkillsPage({ params }: { params: Params }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    const initial = await agentsAPI.listSkills(id).catch(() => ({ data: [] }));

    return <AgentSkillsClient agentId={id} initial={initial} />;
}
