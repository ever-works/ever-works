import type { McpServerConnection } from '../entities/mcp-server-connection.entity';
import { createGuardedFetch } from './guarded-fetch';

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

            // AP-15. Without this the SDK uses the global `fetch`, which
            // follows redirects itself — so a server answering
            // `302 Location: http://127.0.0.1:6379/` gets followed, and the
            // custom auth headers above go with it (the platform strips
            // `Authorization` cross-origin, but not `X-API-Key` and friends).
            // The guarded fetch re-checks every hop and forwards no
            // caller-supplied header across an origin boundary. It also closes
            // DNS rebinding, which `isSafeWebhookUrl` explicitly does not:
            // that guard is lexical, so a hostname resolving to a private
            // address passes it.
            const fetchImpl = createGuardedFetch();

            if (transport === 'stdio') {
                // Unreachable through this factory by construction: a stdio
                // connection is launched by `McpStdioLauncher`, never dialled.
                // Stated rather than assumed, because `new URL('stdio:a/b')`
                // parses happily and the HTTP branch below would then fail
                // with something misleading about the transport instead.
                throw new Error(
                    'A stdio MCP server is launched as a subprocess, not connected to by URL.',
                );
            }

            if (transport === 'sse') {
                const { SSEClientTransport } =
                    await import('@modelcontextprotocol/sdk/client/sse.js');
                await client.connect(
                    new SSEClientTransport(target, { requestInit, fetch: fetchImpl }),
                );
            } else {
                const { StreamableHTTPClientTransport } =
                    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
                await client.connect(
                    new StreamableHTTPClientTransport(target, { requestInit, fetch: fetchImpl }),
                );
            }
            return client as unknown as McpSdkClient;
        },
    };
}

/**
 * Spawn a stdio MCP server and return a CONNECTED client for it (AP-14).
 *
 * Two orderings here are load-bearing, and both are why this could not reuse
 * `AgentPluginStdioServerService.launch`:
 *
 *  1. `Client.connect(transport)` calls `transport.start()` itself, and
 *     `StdioClientTransport.start()` THROWS if the transport was already
 *     started. So the transport is handed over unstarted — the sibling
 *     `launch()` starts it standalone, which is right for a server nothing
 *     talks to and wrong for one a client owns.
 *  2. The stderr drain is attached BEFORE connect, not after. With
 *     `stderr: 'pipe'` the SDK creates the PassThrough in the transport's
 *     CONSTRUCTOR and returns it from `.stderr` immediately, precisely so a
 *     caller can listen before the child exists. Draining after connect
 *     deadlocks: a server that logs on startup fills the 16 KB PassThrough
 *     plus the ~64 KB OS pipe and blocks mid-write, so it never reads the
 *     `initialize` request, so connect never resolves, so the drain is never
 *     attached. Measured with a 200 KB flood; a token-sized one passes either
 *     way. `'pipe'` itself is deliberate: `'inherit'` would let a package
 *     forge lines into the platform log.
 */
export async function createStdioSdkClient(params: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
}): Promise<{ client: McpSdkClient; close(): Promise<void> }> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({ ...params, stderr: 'pipe' });
    const client = new Client({ name: 'ever-works-agent', version: '1.0.0' }, { capabilities: {} });

    // Before connect. See (2) above — after is a deadlock, not a style choice.
    transport.stderr?.on('data', () => undefined);

    try {
        await client.connect(transport);
    } catch (err) {
        // The child may already be running even though initialization failed.
        await transport.close().catch(() => undefined);
        throw err;
    }

    return {
        client: client as unknown as McpSdkClient,
        close: async () => {
            await client.close().catch(() => undefined);
            await transport.close().catch(() => undefined);
        },
    };
}
