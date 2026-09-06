import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Agent Plugins MCP slice — API client for the manual MCP connection
 * registry (Settings → Connections) + per-agent binding endpoints.
 *
 * Responses are MASKED: `authHeaderNames` only, never header values.
 */

/**
 * What a connection row can BE. `stdio` rows are minted only by the Agent
 * Plugins package reconciler for a server an installed package declares
 * (AP-14); their `url` is the opaque `stdio:<package>/<server>` pointer, not
 * an address, and the platform launches them as a subprocess for the duration
 * of an agent run.
 */
export type McpConnectionTransport = 'streamable-http' | 'sse' | 'stdio';

/**
 * What a person may CREATE. Deliberately narrower, and it mirrors the API:
 * `CreateMcpConnectionDto` validates against its own two-value enum, so a
 * pasted stdio connection is a 400 there and is not offered here. A row that
 * runs local code can only come from a package the deployment installed.
 */
export type McpManualTransport = Exclude<McpConnectionTransport, 'stdio'>;

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
    transport: McpManualTransport;
    authHeaders?: Record<string, string>;
}

export interface UpdateMcpConnectionInput {
    name?: string;
    url?: string;
    transport?: McpManualTransport;
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
