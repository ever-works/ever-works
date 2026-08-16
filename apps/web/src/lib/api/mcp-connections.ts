import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Agent Plugins MCP slice — API client for the manual MCP connection
 * registry (Settings → Connections) + per-agent binding endpoints.
 *
 * Responses are MASKED: `authHeaderNames` only, never header values.
 */

export type McpConnectionTransport = 'streamable-http' | 'sse';

export interface McpConnection {
    id: string;
    name: string;
    url: string;
    transport: McpConnectionTransport;
    enabled: boolean;
    source: string;
    authHeaderNames: string[];
    lastConnectedAt: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface McpConnectionTestResult {
    ok: boolean;
    toolCount: number;
    tools: string[];
    error?: string;
}

export interface AgentMcpServerState {
    connection: McpConnection;
    effectiveEnabled: boolean;
    bindingSource: 'agent' | 'tenant' | 'none';
    inheritedFromTenant: boolean;
}

export interface CreateMcpConnectionInput {
    name: string;
    url: string;
    transport: McpConnectionTransport;
    authHeaders?: Record<string, string>;
}

export interface UpdateMcpConnectionInput {
    name?: string;
    url?: string;
    transport?: McpConnectionTransport;
    authHeaders?: Record<string, string>;
    enabled?: boolean;
}

export const mcpConnectionsAPI = {
    list: async () => {
        return serverFetch<{ data: McpConnection[] }>('/mcp-connections');
    },

    create: async (data: CreateMcpConnectionInput) => {
        return serverMutation<McpConnection>({
            endpoint: '/mcp-connections',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    update: async (id: string, data: UpdateMcpConnectionInput) => {
        return serverMutation<McpConnection>({
            endpoint: `/mcp-connections/${id}`,
            data,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    remove: async (id: string) => {
        return serverMutation<{ deleted: true }>({
            endpoint: `/mcp-connections/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    test: async (id: string) => {
        return serverMutation<McpConnectionTestResult>({
            endpoint: `/mcp-connections/${id}/test`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    listForAgent: async (agentId: string) => {
        return serverFetch<{ data: AgentMcpServerState[] }>(`/agents/${agentId}/mcp-servers`);
    },

    setAgentBinding: async (agentId: string, connectionId: string, enabled: boolean) => {
        return serverMutation<AgentMcpServerState>({
            endpoint: `/agents/${agentId}/mcp-servers/${connectionId}`,
            data: { enabled },
            method: 'PUT',
            wrapInData: false,
        });
    },

    clearAgentBinding: async (agentId: string, connectionId: string) => {
        return serverMutation<AgentMcpServerState>({
            endpoint: `/agents/${agentId}/mcp-servers/${connectionId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
