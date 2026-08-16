import { notFound } from 'next/navigation';
import { agentsAPI } from '@/lib/api/agents';
import { mcpConnectionsAPI } from '@/lib/api/mcp-connections';
import { AgentMcpServersClient } from '@/components/agents/AgentMcpServersClient';

type Params = Promise<{ id: string; locale: string }>;

/**
 * Agent Plugins MCP slice (merged spec US-7) — the per-agent MCP Servers
 * tab: every workspace connection with this agent's effective binding
 * state (per-agent toggles + inherited badges).
 */
export default async function AgentMcpServersPage({ params }: { params: Params }) {
    const { id } = await params;
    const agent = await agentsAPI.get(id);
    if (!agent) notFound();

    const initial = await mcpConnectionsAPI.listForAgent(id).catch(() => ({ data: [] }));

    return <AgentMcpServersClient agentId={id} initial={initial} />;
}
