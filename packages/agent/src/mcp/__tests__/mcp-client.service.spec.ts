import {
    McpClientService,
    MCP_LIST_TIMEOUT_MS,
    MCP_RESULT_SIZE_CAP,
    MCP_TOOLS_CACHE_TTL_MS,
} from '../mcp-client.service';
import type { McpClientFactory, McpSdkClient } from '../mcp-sdk';
import type { McpServerConnection } from '../../entities/mcp-server-connection.entity';
import type { McpServerConnectionRepository } from '../../database/repositories/mcp-server-connection.repository';

function makeConnection(over: Partial<McpServerConnection> = {}): McpServerConnection {
    return {
        id: 'c1',
        userId: 'u1',
        name: 'github',
        url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http',
        authHeaders: { Authorization: 'Bearer secret-token-value' },
        enabled: true,
        source: 'manual',
        lastConnectedAt: null,
        lastError: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as McpServerConnection;
}

function makeRepo(): jest.Mocked<Pick<McpServerConnectionRepository, 'stampConnectionResult'>> {
    return { stampConnectionResult: jest.fn().mockResolvedValue(undefined) };
}

function makeClient(over: Partial<McpSdkClient> = {}): McpSdkClient {
    return {
        listTools: jest.fn().mockResolvedValue({
            tools: [{ name: 'search_issues', description: 'Search issues', inputSchema: {} }],
        }),
        callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
        close: jest.fn().mockResolvedValue(undefined),
        ...over,
    } as McpSdkClient;
}

function makeService(client: McpSdkClient, repo = makeRepo()) {
    const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
    const service = new McpClientService(repo as never, factory);
    return { service, factory, repo };
}

describe('McpClientService', () => {
    describe('listTools', () => {
        it('lists tools, stamps success, and closes the client', async () => {
            const client = makeClient();
            const { service, repo } = makeService(client);

            const tools = await service.listTools(makeConnection());

            expect(tools).toEqual([
                // The server's schema object passes through untouched; the
                // {type,properties} default only fills a MISSING schema.
                { name: 'search_issues', description: 'Search issues', inputSchema: {} },
            ]);
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', { ok: true });
            expect(client.close).toHaveBeenCalled();
        });

        it('serves from the TTL cache within 60s and refreshes after expiry', async () => {
            const client = makeClient();
            const { service, factory } = makeService(client);
            const now = Date.now();
            const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

            await service.listTools(makeConnection());
            await service.listTools(makeConnection());
            expect(factory.connect).toHaveBeenCalledTimes(1);

            nowSpy.mockReturnValue(now + MCP_TOOLS_CACHE_TTL_MS + 1);
            await service.listTools(makeConnection());
            expect(factory.connect).toHaveBeenCalledTimes(2);
            nowSpy.mockRestore();
        });

        it('bypassCache forces a live round-trip', async () => {
            const client = makeClient();
            const { service, factory } = makeService(client);

            await service.listTools(makeConnection());
            await service.listTools(makeConnection(), { bypassCache: true });
            expect(factory.connect).toHaveBeenCalledTimes(2);
        });

        it('classifies failures, stamps lastError, and never leaks header values', async () => {
            const repo = makeRepo();
            const factory: McpClientFactory = {
                connect: jest
                    .fn()
                    .mockRejectedValue(
                        new Error('fetch failed: Authorization: Bearer secret-token-value'),
                    ),
            };
            const service = new McpClientService(repo as never, factory);

            await expect(service.listTools(makeConnection())).rejects.toThrow(
                'Server unreachable (connection failed).',
            );
            const stamped = repo.stampConnectionResult.mock.calls[0][1];
            expect(stamped.ok).toBe(false);
            expect(String(stamped.error)).not.toContain('secret-token-value');
        });

        it('redacts the auth header VALUE an error quotes back at us', async () => {
            // Regression: `new Headers({...})` reports a malformed value by
            // quoting it verbatim. That message is short and matches no
            // classifier branch, so it used to pass straight through into
            // `lastError` (a plaintext column the API returns and the
            // Settings screen renders) and into the thrown message.
            const repo = makeRepo();
            const factory: McpClientFactory = {
                connect: jest
                    .fn()
                    .mockRejectedValue(
                        new Error(
                            'Headers.append: "Bearer secret-token-value" is an invalid header value.',
                        ),
                    ),
            };
            const service = new McpClientService(repo as never, factory);

            await expect(service.listTools(makeConnection())).rejects.toThrow(/\*\*\*/);
            const stamped = repo.stampConnectionResult.mock.calls[0][1];
            expect(String(stamped.error)).not.toContain('secret-token-value');
            expect(String(stamped.error)).toContain('***');
        });

        it('redacts the header value out of a callTool { error } too', async () => {
            const client = makeClient({
                callTool: jest
                    .fn()
                    .mockRejectedValue(new Error('upstream said: Bearer secret-token-value')),
            });
            const { service } = makeService(client);

            const result = (await service.callTool(makeConnection(), 'search_issues', {})) as {
                error: string;
            };

            expect(result.error).not.toContain('secret-token-value');
            expect(result.error).toContain('***');
        });

        it('bounds a connect that never settles (run assembly must not hang)', async () => {
            // The SDK bounds nothing here: SSE `start()` resolves only on the
            // server's `endpoint` event, so a silent server leaves connect
            // pending forever — and connect is awaited inside run assembly.
            jest.useFakeTimers();
            try {
                const repo = makeRepo();
                const factory: McpClientFactory = {
                    connect: jest.fn().mockReturnValue(new Promise<never>(() => undefined)),
                };
                const service = new McpClientService(repo as never, factory);

                const pending = service.listTools(makeConnection());
                const assertion = expect(pending).rejects.toThrow(/timed out/i);
                await jest.advanceTimersByTimeAsync(MCP_LIST_TIMEOUT_MS + 1);
                await assertion;

                expect(repo.stampConnectionResult).toHaveBeenCalledWith(
                    'c1',
                    expect.objectContaining({ ok: false }),
                );
            } finally {
                jest.useRealTimers();
            }
        });

        it('classifies a 401 into an auth message', async () => {
            const factory: McpClientFactory = {
                connect: jest.fn().mockRejectedValue(new Error('HTTP 401 Unauthorized')),
            };
            const service = new McpClientService(makeRepo() as never, factory);

            await expect(service.listTools(makeConnection())).rejects.toThrow(
                'Authentication failed (401). Check the auth header.',
            );
        });
    });

    describe('callTool', () => {
        it('returns the tool result and stamps success', async () => {
            const client = makeClient();
            const { service, repo } = makeService(client);

            const result = await service.callTool(makeConnection(), 'search_issues', { q: 'bug' });

            expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
            expect(client.callTool).toHaveBeenCalledWith(
                { name: 'search_issues', arguments: { q: 'bug' } },
                undefined,
                { timeout: 30_000 },
            );
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', { ok: true });
        });

        it('times out a hung call and returns { error } instead of throwing', async () => {
            const client = makeClient({
                callTool: jest.fn().mockImplementation(() => new Promise(() => undefined)),
            });
            const { service } = makeService(client);

            const result = (await service.callTool(
                makeConnection(),
                'slow_tool',
                {},
                { timeoutMs: 20 },
            )) as { error: string };

            expect(result.error).toContain('timed out after 20ms');
            expect(client.close).toHaveBeenCalled();
        });

        it('caps oversized results with an explicit truncation marker', async () => {
            const huge = 'x'.repeat(MCP_RESULT_SIZE_CAP + 1000);
            const client = makeClient({
                callTool: jest.fn().mockResolvedValue({ content: huge }),
            });
            const { service } = makeService(client);

            const result = (await service.callTool(makeConnection(), 'big_tool', {})) as {
                truncated: boolean;
                content: string;
            };

            expect(result.truncated).toBe(true);
            expect(result.content.length).toBe(MCP_RESULT_SIZE_CAP);
        });

        it('returns a classified { error } naming the server on failure', async () => {
            const client = makeClient({
                callTool: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:443')),
            });
            const { service, repo } = makeService(client);

            const result = (await service.callTool(makeConnection(), 'search_issues', {})) as {
                error: string;
            };

            expect(result.error).toBe(
                'MCP server "github": Server unreachable (connection failed).',
            );
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', {
                ok: false,
                error: 'Server unreachable (connection failed).',
            });
        });
    });
});
