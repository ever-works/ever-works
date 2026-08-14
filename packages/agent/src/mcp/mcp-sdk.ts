import type { McpServerConnection } from '../entities/mcp-server-connection.entity';

/**
 * Agent Plugins MCP slice (plan §2.4) — the thin seam between
 * `McpClientService` and the official `@modelcontextprotocol/sdk`.
 *
 * The SDK is consumed through structural interfaces + a factory token so:
 *   - unit tests inject a fake factory (NO network, NO SDK loading — the
 *     SDK is ESM-first and loading it under Jest's CJS transformer is
 *     exactly the kind of incidental coupling the tests should not have);
 *   - the production factory lazy-`import()`s the SDK per transport, so
 *     runtimes that never touch MCP never pay for it.
 */

/** Structural subset of `Client` from `@modelcontextprotocol/sdk/client`. */
export interface McpSdkTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

export interface McpSdkClient {
    listTools(
        params?: Record<string, unknown>,
        options?: { timeout?: number },
    ): Promise<{ tools: McpSdkTool[] }>;
    callTool(
        params: { name: string; arguments?: Record<string, unknown> },
        resultSchema?: unknown,
        options?: { timeout?: number },
    ): Promise<unknown>;
    close(): Promise<void>;
}

export interface McpClientFactory {
    /**
     * Connect to one MCP server per its declared transport with the
     * client-generated `headers` applied (AP-15). Resolves to a READY
     * (connected + initialized) client; rejects on connect failure.
     */
    connect(connection: {
        url: string;
        transport: McpServerConnection['transport'];
        headers: Record<string, string>;
    }): Promise<McpSdkClient>;
}

export const MCP_CLIENT_FACTORY = 'MCP_CLIENT_FACTORY' as const;

/**
 * Production factory over the official SDK. Header values are applied to
 * the transport's `requestInit` and never logged or re-read.
 */
export function createSdkMcpClientFactory(): McpClientFactory {
    return {
        async connect({ url, transport, headers }) {
            const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
            const client = new Client(
                { name: 'ever-works-agent', version: '1.0.0' },
                { capabilities: {} },
            );
            const target = new URL(url);
            const requestInit: RequestInit = { headers };
            if (transport === 'sse') {
                const { SSEClientTransport } = await import(
                    '@modelcontextprotocol/sdk/client/sse.js'
                );
                await client.connect(new SSEClientTransport(target, { requestInit }));
            } else {
                const { StreamableHTTPClientTransport } = await import(
                    '@modelcontextprotocol/sdk/client/streamableHttp.js'
                );
                await client.connect(new StreamableHTTPClientTransport(target, { requestInit }));
            }
            return client as unknown as McpSdkClient;
        },
    };
}
