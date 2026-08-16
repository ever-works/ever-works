'use server';

import { revalidatePath } from 'next/cache';
import {
    mcpConnectionsAPI,
    type AgentMcpServerState,
    type CreateMcpConnectionInput,
    type McpConnection,
    type McpConnectionTestResult,
    type UpdateMcpConnectionInput,
} from '@/lib/api/mcp-connections';

/**
 * Agent Plugins MCP slice — server actions for Settings → Connections
 * and the per-agent MCP Servers tab. Auth header values travel one way
 * (browser → API); reads only ever return header names.
 */

export async function listMcpConnectionsAction(): Promise<{ data: McpConnection[] }> {
    return mcpConnectionsAPI.list();
}

export async function createMcpConnectionAction(
    input: CreateMcpConnectionInput,
): Promise<McpConnection> {
    const created = await mcpConnectionsAPI.create(input);
    revalidatePath('/settings/connections');
    return created;
}

export async function updateMcpConnectionAction(
    id: string,
    input: UpdateMcpConnectionInput,
): Promise<McpConnection> {
    const updated = await mcpConnectionsAPI.update(id, input);
    revalidatePath('/settings/connections');
    return updated;
}

export async function deleteMcpConnectionAction(id: string): Promise<{ deleted: true }> {
    const result = await mcpConnectionsAPI.remove(id);
    revalidatePath('/settings/connections');
    return result;
}

export async function testMcpConnectionAction(id: string): Promise<McpConnectionTestResult> {
    const result = await mcpConnectionsAPI.test(id);
    revalidatePath('/settings/connections');
    return result;
}

export async function listAgentMcpServersAction(
    agentId: string,
): Promise<{ data: AgentMcpServerState[] }> {
    return mcpConnectionsAPI.listForAgent(agentId);
}

export async function setAgentMcpBindingAction(
    agentId: string,
    connectionId: string,
    enabled: boolean,
): Promise<AgentMcpServerState> {
    return mcpConnectionsAPI.setAgentBinding(agentId, connectionId, enabled);
}

export async function clearAgentMcpBindingAction(
    agentId: string,
    connectionId: string,
): Promise<AgentMcpServerState> {
    return mcpConnectionsAPI.clearAgentBinding(agentId, connectionId);
}
