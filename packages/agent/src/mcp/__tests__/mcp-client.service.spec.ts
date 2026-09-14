import {
    McpClientService,
    MCP_LIST_TIMEOUT_MS,
    MCP_RESULT_SIZE_CAP,
    MCP_TOOLS_CACHE_TTL_MS,
} from '../mcp-client.service';
import type { McpClientFactory, McpSdkClient } from '../mcp-sdk';
import type { McpServerConnection } from '../../entities/mcp-server-connection.entity';
import type { McpServerConnectionRepository } from '../../database/repositories/mcp-server-connection.repository';
import { McpCredentialTransportPolicyService } from '../mcp-credential-transport-policy.service';

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

    describe('header credentials resolved at connect time', () => {
        const RESOLVED = 'resolved-vault-value-9f8e7d6c';

        function makeResolver(values: Record<string, string> = { docs_token: RESOLVED }) {
            return {
                resolve: jest.fn(async (_ctx: unknown, keys: readonly string[]) => {
                    const out = new Map<string, string>();
                    for (const key of keys) {
                        if (values[key] !== undefined) out.set(key, values[key]);
                    }
                    return out;
                }),
            };
        }

        function referencing(over: Partial<McpServerConnection> = {}): McpServerConnection {
            return makeConnection({
                authHeaders: { Authorization: 'Bearer {{cred.docs_token}}' },
                tenantId: 't1',
                organizationId: 'o1',
                ...over,
            });
        }

        it('hands the factory resolved headers while the entity keeps the reference', async () => {
            const client = makeClient();
            const repo = makeRepo();
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
            const resolver = makeResolver();
            const service = new McpClientService(repo as never, factory, resolver);
            const connection = referencing();

            await service.listTools(connection);

            expect(factory.connect).toHaveBeenCalledWith({
                url: 'https://mcp.example.com/mcp',
                transport: 'streamable-http',
                headers: { Authorization: `Bearer ${RESOLVED}` },
            });
            expect(connection.authHeaders).toEqual({
                Authorization: 'Bearer {{cred.docs_token}}',
            });
            expect(resolver.resolve).toHaveBeenCalledWith(
                { userId: 'u1', organizationId: 'o1', tenantId: 't1' },
                ['docs_token'],
            );
        });

        it('resolves on every attempt (list, call) — nothing is cached', async () => {
            const client = makeClient();
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
            const resolver = makeResolver();
            const service = new McpClientService(makeRepo() as never, factory, resolver);

            await service.listTools(referencing(), { bypassCache: true });
            await service.callTool(referencing(), 'search_issues', {});

            expect(resolver.resolve).toHaveBeenCalledTimes(2);
        });

        it('a missing key fails BEFORE the factory is called and names the key', async () => {
            const repo = makeRepo();
            const factory: McpClientFactory = { connect: jest.fn() };
            const service = new McpClientService(repo as never, factory, makeResolver({}));

            await expect(service.listTools(referencing())).rejects.toThrow(
                'Missing credential `docs_token`',
            );
            expect(factory.connect).not.toHaveBeenCalled();
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', {
                ok: false,
                error: 'Missing credential `docs_token`',
            });
        });

        it('callTool returns the missing-key refusal as { error } without dialing', async () => {
            const factory: McpClientFactory = { connect: jest.fn() };
            const service = new McpClientService(makeRepo() as never, factory, makeResolver({}));

            const result = (await service.callTool(referencing(), 'search_issues', {})) as {
                error: string;
            };

            expect(result.error).toBe('MCP server "github": Missing credential `docs_token`');
            expect(factory.connect).not.toHaveBeenCalled();
        });

        it('an unbound resolver fails closed — the reference is never sent verbatim', async () => {
            const factory: McpClientFactory = { connect: jest.fn() };
            const service = new McpClientService(makeRepo() as never, factory);

            await expect(service.listTools(referencing())).rejects.toThrow(
                'Missing credential `docs_token`',
            );
            expect(factory.connect).not.toHaveBeenCalled();
        });

        it('a resolver that throws fails closed without logging its message', async () => {
            const factory: McpClientFactory = { connect: jest.fn() };
            const resolver = {
                resolve: jest.fn().mockRejectedValue(new Error(`store said ${RESOLVED}`)),
            };
            const service = new McpClientService(makeRepo() as never, factory, resolver);
            const warn = jest
                .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
                .mockImplementation(() => undefined);

            await expect(service.listTools(referencing())).rejects.toThrow(/Missing credential/);
            expect(factory.connect).not.toHaveBeenCalled();
            for (const call of warn.mock.calls) {
                expect(String(call[0])).not.toContain(RESOLVED);
            }
        });

        it('a header with no reference is sent unchanged and never consults the resolver', async () => {
            const client = makeClient();
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
            const resolver = makeResolver();
            const service = new McpClientService(makeRepo() as never, factory, resolver);

            await service.listTools(makeConnection());

            expect(factory.connect).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: { Authorization: 'Bearer secret-token-value' },
                }),
            );
            expect(resolver.resolve).not.toHaveBeenCalled();
        });

        it('redacts a resolved value an SDK error echoes back', async () => {
            const repo = makeRepo();
            const factory: McpClientFactory = {
                connect: jest
                    .fn()
                    .mockRejectedValue(
                        new Error(
                            `Headers.append: "Bearer ${RESOLVED}" is an invalid header value.`,
                        ),
                    ),
            };
            const service = new McpClientService(repo as never, factory, makeResolver());

            let thrown = '';
            try {
                await service.listTools(referencing());
            } catch (err) {
                thrown = err instanceof Error ? err.message : String(err);
            }

            expect(thrown).not.toContain(RESOLVED);
            const stamped = repo.stampConnectionResult.mock.calls[0][1];
            expect(String(stamped.error)).not.toContain(RESOLVED);
            expect(String(stamped.error)).toContain('[redacted:cred.docs_token]');
        });

        it('redacts a resolved value a tool result or tool error reflects', async () => {
            const reflecting = makeClient({
                callTool: jest
                    .fn()
                    .mockResolvedValue({ content: [{ type: 'text', text: `echo ${RESOLVED}` }] }),
            });
            const failing = makeClient({
                callTool: jest.fn().mockRejectedValue(new Error(`upstream said ${RESOLVED}`)),
            });

            const okService = new McpClientService(
                makeRepo() as never,
                { connect: jest.fn().mockResolvedValue(reflecting) },
                makeResolver(),
            );
            const failService = new McpClientService(
                makeRepo() as never,
                { connect: jest.fn().mockResolvedValue(failing) },
                makeResolver(),
            );

            const okResult = await okService.callTool(referencing(), 'echo', {});
            const failResult = await failService.callTool(referencing(), 'echo', {});

            expect(JSON.stringify(okResult)).not.toContain(RESOLVED);
            expect(JSON.stringify(failResult)).not.toContain(RESOLVED);
        });

        it('redacts a resolved value reflected in tool metadata before it is returned or cached', async () => {
            const reflecting = makeClient({
                listTools: jest.fn().mockResolvedValue({
                    tools: [
                        {
                            name: 'search_issues',
                            description: `Authenticated as Bearer ${RESOLVED}`,
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    token: { type: 'string', default: RESOLVED },
                                },
                            },
                        },
                    ],
                }),
            });
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(reflecting) };
            const service = new McpClientService(makeRepo() as never, factory, makeResolver());

            const live = await service.listTools(referencing());
            const cached = await service.listTools(referencing());

            expect(factory.connect).toHaveBeenCalledTimes(1);
            for (const tools of [live, cached]) {
                expect(JSON.stringify(tools)).not.toContain(RESOLVED);
                expect(tools[0].name).toBe('search_issues');
                expect(tools[0].description).toBe(
                    'Authenticated as Bearer [redacted:cred.docs_token]',
                );
                expect(JSON.stringify(tools[0].inputSchema)).toContain(
                    '[redacted:cred.docs_token]',
                );
            }
        });

        it('never writes a resolved value to a log line or the stamped error', async () => {
            const repo = makeRepo();
            const factory: McpClientFactory = {
                connect: jest.fn().mockRejectedValue(new Error(`HTTP 401 for ${RESOLVED}`)),
            };
            const service = new McpClientService(repo as never, factory, makeResolver());
            const logger = (
                service as unknown as {
                    logger: Record<'log' | 'warn' | 'error' | 'debug' | 'verbose', () => void>;
                }
            ).logger;
            const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
                jest.spyOn(logger, level).mockImplementation(() => undefined),
            );

            await expect(service.listTools(referencing())).rejects.toThrow(
                'Authentication failed (401). Check the auth header.',
            );

            for (const spy of spies) {
                for (const call of spy.mock.calls) {
                    expect(JSON.stringify(call)).not.toContain(RESOLVED);
                }
            }
            for (const call of repo.stampConnectionResult.mock.calls) {
                expect(JSON.stringify(call)).not.toContain(RESOLVED);
            }
        });
    });

    describe('credentials require an https endpoint (connect-time re-check)', () => {
        it('a legacy http row with a credential reference never reaches the factory', async () => {
            const repo = makeRepo();
            const factory: McpClientFactory = { connect: jest.fn() };
            const resolver = { resolve: jest.fn() };
            const service = new McpClientService(repo as never, factory, resolver);

            await expect(
                service.listTools(
                    makeConnection({
                        url: 'http://mcp.example.com/mcp',
                        authHeaders: { Authorization: 'Bearer {{cred.docs_token}}' },
                    }),
                ),
            ).rejects.toThrow('Credentials require an https:// endpoint');
            expect(factory.connect).not.toHaveBeenCalled();
            // Refused before any credential was even looked up.
            expect(resolver.resolve).not.toHaveBeenCalled();
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', {
                ok: false,
                error: 'Credentials require an https:// endpoint',
            });
        });

        it('a legacy http row with a literal header keeps connecting, marked insecure_transport', async () => {
            const client = makeClient();
            const repo = makeRepo();
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
            const service = new McpClientService(repo as never, factory);
            const connection = makeConnection({ url: 'http://mcp.example.com/mcp' });

            const result = await service.callTool(connection, 'search_issues', {});
            const tools = await service.listTools(connection, { bypassCache: true });

            expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
            expect(tools).toHaveLength(1);
            // Sent exactly as before this change: the literal header, untouched.
            expect(factory.connect).toHaveBeenCalledWith({
                url: 'http://mcp.example.com/mcp',
                transport: 'streamable-http',
                headers: { Authorization: 'Bearer secret-token-value' },
            });
            for (const call of repo.stampConnectionResult.mock.calls) {
                expect(call).toEqual(['c1', { ok: true, warning: 'insecure_transport' }]);
            }
            expect(repo.stampConnectionResult).toHaveBeenCalledTimes(2);
        });

        it('a legacy http row with a literal header keeps connecting when the organization setting is off', async () => {
            const client = makeClient();
            const repo = makeRepo();
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
            const policy = { requiresHttpsForCredentials: jest.fn().mockResolvedValue(false) };
            const service = new McpClientService(
                repo as never,
                factory,
                undefined,
                policy as never,
            );

            await service.listTools(
                makeConnection({
                    url: 'http://mcp.example.com/mcp',
                    organizationId: 'o1',
                    tenantId: 't1',
                }),
            );

            expect(policy.requiresHttpsForCredentials).toHaveBeenCalledWith({
                userId: 'u1',
                organizationId: 'o1',
                tenantId: 't1',
            });
            expect(factory.connect).toHaveBeenCalled();
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', {
                ok: true,
                warning: 'insecure_transport',
            });
        });

        it('with the organization setting on, a literal header over http is refused before dialing and names the setting', async () => {
            const repo = makeRepo();
            const factory: McpClientFactory = { connect: jest.fn() };
            const policy = { requiresHttpsForCredentials: jest.fn().mockResolvedValue(true) };
            const service = new McpClientService(
                repo as never,
                factory,
                undefined,
                policy as never,
            );

            const result = (await service.callTool(
                makeConnection({ url: 'http://mcp.example.com/mcp' }),
                'search_issues',
                {},
            )) as { error: string };

            expect(result.error).toBe(
                'MCP server "github": Credentials require an https:// endpoint (organization setting "Require https for connection credentials" is on)',
            );
            expect(factory.connect).not.toHaveBeenCalled();
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', {
                ok: false,
                error: 'Credentials require an https:// endpoint (organization setting "Require https for connection credentials" is on)',
            });
        });

        describe('the organization setting cannot be read (it defaults to off)', () => {
            /** The real policy service over an organization store whose every read throws. */
            function unreadablePolicy() {
                const organizations = {
                    findById: jest.fn().mockRejectedValue(new Error('driver: db-host-7c1e down')),
                    findByTenantId: jest
                        .fn()
                        .mockRejectedValue(new Error('driver: db-host-7c1e down')),
                };
                const policy = new McpCredentialTransportPolicyService(organizations as never);
                const warn = jest
                    .spyOn((policy as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
                    .mockImplementation(() => undefined);
                return { policy, organizations, warn };
            }

            it('a literal-header http connection still connects and is marked insecure_transport', async () => {
                const client = makeClient();
                const repo = makeRepo();
                const factory: McpClientFactory = {
                    connect: jest.fn().mockResolvedValue(client),
                };
                const { policy, organizations, warn } = unreadablePolicy();
                const service = new McpClientService(repo as never, factory, undefined, policy);

                const tools = await service.listTools(
                    makeConnection({ url: 'http://mcp.example.com/mcp', organizationId: 'org-9' }),
                );

                expect(tools).toHaveLength(1);
                expect(organizations.findById).toHaveBeenCalledWith('org-9');
                expect(factory.connect).toHaveBeenCalledWith({
                    url: 'http://mcp.example.com/mcp',
                    transport: 'streamable-http',
                    headers: { Authorization: 'Bearer secret-token-value' },
                });
                expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', {
                    ok: true,
                    warning: 'insecure_transport',
                });
                // Logged with the organization id; never a header value, a URL
                // or the driver's own message.
                expect(warn).toHaveBeenCalledTimes(1);
                const line = String(warn.mock.calls[0][0]);
                expect(line).toContain('org-9');
                expect(line).not.toContain('secret-token-value');
                expect(line).not.toContain('mcp.example.com');
                expect(line).not.toContain('db-host-7c1e');
            });

            it('a vault-reference http connection is still refused', async () => {
                const factory: McpClientFactory = { connect: jest.fn() };
                const resolver = { resolve: jest.fn() };
                const { policy } = unreadablePolicy();
                const service = new McpClientService(
                    makeRepo() as never,
                    factory,
                    resolver,
                    policy,
                );

                await expect(
                    service.listTools(
                        makeConnection({
                            url: 'http://mcp.example.com/mcp',
                            organizationId: 'org-9',
                            authHeaders: { Authorization: 'Bearer {{cred.docs_token}}' },
                        }),
                    ),
                ).rejects.toThrow('Credentials require an https:// endpoint');
                expect(factory.connect).not.toHaveBeenCalled();
                expect(resolver.resolve).not.toHaveBeenCalled();
            });

            it('a policy binding that throws is also read as off, never as a refusal', async () => {
                const client = makeClient();
                const repo = makeRepo();
                const factory: McpClientFactory = {
                    connect: jest.fn().mockResolvedValue(client),
                };
                const policy = {
                    requiresHttpsForCredentials: jest.fn().mockRejectedValue(new Error('db down')),
                };
                const service = new McpClientService(
                    repo as never,
                    factory,
                    undefined,
                    policy as never,
                );
                jest.spyOn(
                    (service as unknown as { logger: { warn: jest.Mock } }).logger,
                    'warn',
                ).mockImplementation(() => undefined);

                const result = await service.callTool(
                    makeConnection({ url: 'http://mcp.example.com/mcp' }),
                    'search_issues',
                    {},
                );

                expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
                expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', {
                    ok: true,
                    warning: 'insecure_transport',
                });
            });
        });

        it('https rows never consult the organization setting and stay plainly healthy', async () => {
            const client = makeClient();
            const repo = makeRepo();
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
            const policy = { requiresHttpsForCredentials: jest.fn().mockResolvedValue(true) };
            const service = new McpClientService(
                repo as never,
                factory,
                undefined,
                policy as never,
            );

            await service.listTools(makeConnection());

            expect(policy.requiresHttpsForCredentials).not.toHaveBeenCalled();
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', { ok: true });
        });

        it('a credential reference over http is refused even when the organization setting is off', async () => {
            const factory: McpClientFactory = { connect: jest.fn() };
            const policy = { requiresHttpsForCredentials: jest.fn().mockResolvedValue(false) };
            const resolver = { resolve: jest.fn() };
            const service = new McpClientService(
                makeRepo() as never,
                factory,
                resolver,
                policy as never,
            );

            await expect(
                service.listTools(
                    makeConnection({
                        url: 'http://mcp.example.com/mcp',
                        authHeaders: {
                            'X-Api-Key': 'literal',
                            Authorization: '{{cred.docs_token}}',
                        },
                    }),
                ),
            ).rejects.toThrow('Credentials require an https:// endpoint');
            expect(factory.connect).not.toHaveBeenCalled();
            expect(resolver.resolve).not.toHaveBeenCalled();
            // References are refused without needing the setting.
            expect(policy.requiresHttpsForCredentials).not.toHaveBeenCalled();
        });

        it('an unauthenticated plain-http connection never consults the organization setting', async () => {
            const client = makeClient();
            const repo = makeRepo();
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
            const policy = { requiresHttpsForCredentials: jest.fn().mockResolvedValue(true) };
            const service = new McpClientService(
                repo as never,
                factory,
                undefined,
                policy as never,
            );

            await service.listTools(
                makeConnection({ url: 'http://mcp.example.com/mcp', authHeaders: null }),
            );

            expect(policy.requiresHttpsForCredentials).not.toHaveBeenCalled();
            expect(repo.stampConnectionResult).toHaveBeenCalledWith('c1', { ok: true });
        });

        it('an unauthenticated plain-http connection keeps working exactly as before', async () => {
            const client = makeClient();
            const factory: McpClientFactory = { connect: jest.fn().mockResolvedValue(client) };
            const service = new McpClientService(makeRepo() as never, factory);

            const tools = await service.listTools(
                makeConnection({ url: 'http://mcp.example.com/mcp', authHeaders: null }),
            );

            expect(tools).toHaveLength(1);
            expect(factory.connect).toHaveBeenCalledWith({
                url: 'http://mcp.example.com/mcp',
                transport: 'streamable-http',
                headers: {},
            });
        });
    });
});
