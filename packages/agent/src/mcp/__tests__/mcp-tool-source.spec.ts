import { McpToolSource } from '../mcp-tool-source';
import { McpConnectionsService } from '../mcp-connections.service';
import type { McpClientService, McpToolInfo } from '../mcp-client.service';
import type { McpServerConnection } from '../../entities/mcp-server-connection.entity';
import type { AgentMcpServerBinding } from '../../entities/agent-mcp-server-binding.entity';
import type { Agent } from '../../entities/agent.entity';

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'agent-1',
        userId: 'u1',
        permissions: { canCallExternalTools: true },
        workId: null,
        missionId: null,
        ideaId: null,
        tenantId: null,
        organizationId: null,
        ...over,
    } as Agent;
}

function makeConnection(over: Partial<McpServerConnection> = {}): McpServerConnection {
    return {
        id: 'c1',
        userId: 'u1',
        name: 'github',
        url: 'https://mcp.example.com/mcp',
        transport: 'streamable-http',
        authHeaders: null,
        enabled: true,
        source: 'manual',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
    } as McpServerConnection;
}

function makeBinding(over: Partial<AgentMcpServerBinding> = {}): AgentMcpServerBinding {
    return {
        id: 'b1',
        connectionId: 'c1',
        targetType: 'tenant',
        targetId: null,
        userId: 'u1',
        enabled: true,
        createdAt: new Date(),
        ...over,
    } as AgentMcpServerBinding;
}

/**
 * Builds a REAL McpConnectionsService over mocked repositories (the
 * resolution matrix under test lives there) plus a mocked client, then
 * wires the McpToolSource over both.
 */
function makeSource(options: {
    connections: McpServerConnection[];
    bindings: AgentMcpServerBinding[];
    toolsByConnection?: Record<string, McpToolInfo[] | Error>;
    usage?: { record: jest.Mock };
}) {
    const connectionsRepo = {
        findEnabledByUser: jest
            .fn()
            .mockResolvedValue(options.connections.filter((c) => c.enabled)),
        findByUser: jest.fn().mockResolvedValue(options.connections),
    };
    const bindingsRepo = {
        findForAgent: jest.fn().mockResolvedValue(options.bindings),
    };
    const client = {
        listTools: jest.fn().mockImplementation(async (connection: McpServerConnection) => {
            const entry = options.toolsByConnection?.[connection.id];
            if (entry instanceof Error) throw entry;
            return (
                entry ?? [
                    {
                        name: 'search_issues',
                        description: 'Search issues',
                        inputSchema: {
                            type: 'object',
                            properties: { q: { type: 'string', description: 'query' } },
                            required: ['q'],
                        },
                    },
                ]
            );
        }),
        callTool: jest.fn().mockResolvedValue({ ok: true }),
        invalidate: jest.fn(),
    } as unknown as jest.Mocked<McpClientService>;

    const connections = new McpConnectionsService(
        connectionsRepo as never,
        bindingsRepo as never,
        client,
        { findByIdAndUser: jest.fn() } as never,
        undefined,
    );
    const usage = options.usage;
    return {
        source: new McpToolSource(connections, client, usage as never),
        client,
        usage,
    };
}

describe('McpToolSource', () => {
    describe('binding resolution matrix', () => {
        it('tenant binding enabled → the agent inherits the connection', async () => {
            const { source } = makeSource({
                connections: [makeConnection()],
                bindings: [makeBinding({ targetType: 'tenant', targetId: null, enabled: true })],
            });
            const tools = await source.buildTools(makeAgent());
            expect(tools.map((t) => t.name)).toEqual(['mcp__github__search_issues']);
        });

        it('agent-level enabled=false overrides the tenant inherit (narrowing)', async () => {
            const { source } = makeSource({
                connections: [makeConnection()],
                bindings: [
                    makeBinding({ id: 'b1', targetType: 'tenant', targetId: null, enabled: true }),
                    makeBinding({
                        id: 'b2',
                        targetType: 'agent',
                        targetId: 'agent-1',
                        enabled: false,
                    }),
                ],
            });
            const tools = await source.buildTools(makeAgent());
            expect(tools).toEqual([]);
        });

        it('agent-only binding (no tenant row) binds just that agent', async () => {
            const { source } = makeSource({
                connections: [makeConnection()],
                bindings: [
                    makeBinding({ targetType: 'agent', targetId: 'agent-1', enabled: true }),
                ],
            });
            const tools = await source.buildTools(makeAgent());
            expect(tools.map((t) => t.name)).toEqual(['mcp__github__search_issues']);
        });

        it('a disabled connection contributes no tools regardless of bindings', async () => {
            const { source, client } = makeSource({
                connections: [makeConnection({ enabled: false })],
                bindings: [makeBinding({ targetType: 'tenant', targetId: null, enabled: true })],
            });
            const tools = await source.buildTools(makeAgent());
            expect(tools).toEqual([]);
            expect(client.listTools).not.toHaveBeenCalled();
        });

        it('no bindings at all → no tools', async () => {
            const { source } = makeSource({ connections: [makeConnection()], bindings: [] });
            expect(await source.buildTools(makeAgent())).toEqual([]);
        });
    });

    describe('gating + isolation', () => {
        it('returns no tools without canCallExternalTools (outbound-call risk class)', async () => {
            const { source, client } = makeSource({
                connections: [makeConnection()],
                bindings: [makeBinding()],
            });
            const agent = makeAgent({ permissions: { canCallExternalTools: false } as never });
            expect(await source.buildTools(agent)).toEqual([]);
            expect(client.listTools).not.toHaveBeenCalled();
        });

        it('a dead server contributes zero tools without failing the others', async () => {
            const { source } = makeSource({
                connections: [
                    makeConnection({ id: 'c1', name: 'dead' }),
                    makeConnection({ id: 'c2', name: 'alive' }),
                ],
                bindings: [
                    makeBinding({ id: 'b1', connectionId: 'c1' }),
                    makeBinding({ id: 'b2', connectionId: 'c2' }),
                ],
                toolsByConnection: {
                    c1: new Error('Server unreachable (connection failed).'),
                    c2: [{ name: 'ping', description: 'Ping', inputSchema: {} }],
                },
            });
            const tools = await source.buildTools(makeAgent());
            expect(tools.map((t) => t.name)).toEqual(['mcp__alive__ping']);
        });
    });

    describe('descriptor shape', () => {
        it('passes the JSON schema through and prefixes the description with the server name', async () => {
            const { source } = makeSource({
                connections: [makeConnection()],
                bindings: [makeBinding()],
            });
            const [tool] = await source.buildTools(makeAgent());
            expect(tool.description).toBe('[github] Search issues');
            expect(tool.parameters).toEqual({
                type: 'object',
                properties: { q: { type: 'string', description: 'query' } },
                required: ['q'],
            });
        });

        it('sanitizes hostile tool names and strips control chars from descriptions', async () => {
            const { source } = makeSource({
                connections: [makeConnection()],
                bindings: [makeBinding()],
                toolsByConnection: {
                    c1: [
                        {
                            name: 'evil name!!/../x',
                            description: 'line1\u0000\u001fline2',
                            inputSchema: {},
                        },
                    ],
                },
            });
            const [tool] = await source.buildTools(makeAgent());
            expect(tool.name).toBe('mcp__github__evil_name__x');
            expect(tool.name).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(tool.description).toBe('[github] line1  line2');
        });

        it('the executor proxies callTool with the ORIGINAL server-side tool name', async () => {
            const { source, client } = makeSource({
                connections: [makeConnection()],
                bindings: [makeBinding()],
            });
            const [tool] = await source.buildTools(makeAgent());
            await tool.invoke({ q: 'bug' });
            expect(client.callTool).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'c1' }),
                'search_issues',
                { q: 'bug' },
            );
        });
    });
});

/**
 * Usage accounting is deliberately NOT awaited by `invoke`, so an assertion
 * made immediately after would be racing a microtask. Flushing makes these
 * tests deterministic rather than dependent on how fast the stub resolves.
 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('usage accounting (T28)', () => {
    it('records one event per successful tool invocation', async () => {
        const usage = { record: jest.fn().mockResolvedValue({}) };
        const { source } = makeSource({
            connections: [makeConnection()],
            bindings: [makeBinding()],
            usage,
        });

        const tools = await source.buildTools(makeAgent({ workId: 'work-1' }));
        await tools[0].invoke({ q: 'x' });
        await flush();

        expect(usage.record).toHaveBeenCalledTimes(1);
        expect(usage.record).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: 'work-1',
                userId: 'u1',
                capability: 'mcp',
                units: 1,
            }),
        );
    });

    it('does NOT record a failed tool call', async () => {
        const usage = { record: jest.fn().mockResolvedValue({}) };
        const { source, client } = makeSource({
            connections: [makeConnection()],
            bindings: [makeBinding()],
            usage,
        });
        (client.callTool as jest.Mock).mockRejectedValue(new Error('server down'));

        const tools = await source.buildTools(makeAgent({ workId: 'work-1' }));
        await expect(tools[0].invoke({ q: 'x' })).rejects.toThrow('server down');
        await flush();

        // Recording after the call is what makes this true: a failed
        // invocation consumed nothing, so counting it would overstate spend.
        expect(usage.record).not.toHaveBeenCalled();
    });

    it('NEVER breaks a tool call when accounting fails', async () => {
        const usage = { record: jest.fn().mockRejectedValue(new Error('db down')) };
        const { source } = makeSource({
            connections: [makeConnection()],
            bindings: [makeBinding()],
            usage,
        });

        const tools = await source.buildTools(makeAgent({ workId: 'work-1' }));

        // Trading a working tool for a complete ledger is the wrong way round.
        await expect(tools[0].invoke({ q: 'x' })).resolves.toEqual({ ok: true });
    });

    it('skips an agent with no workId rather than inventing one', async () => {
        const usage = { record: jest.fn().mockResolvedValue({}) };
        const { source } = makeSource({
            connections: [makeConnection()],
            bindings: [makeBinding()],
            usage,
        });

        // `plugin_usage_events.workId` is NOT NULL, and an agent scoped to a
        // Mission or Idea has none. Making that column nullable is a migration
        // on a table five other capabilities write to — a larger change than
        // this feature should make alone, so such agents are simply not
        // counted, and the gap is stated rather than hidden.
        const tools = await source.buildTools(makeAgent({ workId: null }));
        await tools[0].invoke({ q: 'x' });
        await flush();

        expect(usage.record).not.toHaveBeenCalled();
    });

    it('returns the tool result WITHOUT waiting for accounting to finish', async () => {
        let settle!: () => void;
        const usage = {
            record: jest.fn(
                () =>
                    new Promise<void>((resolve) => {
                        settle = resolve;
                    }),
            ),
        };
        const { source } = makeSource({
            connections: [makeConnection()],
            bindings: [makeBinding()],
            usage,
        });

        const tools = await source.buildTools(makeAgent({ workId: 'work-1' }));

        // The write never settles. If `invoke` awaited it, this would hang —
        // a stalled accounting write would hold every successful tool
        // response open, making the ledger a latency dependency of the run.
        await expect(tools[0].invoke({ q: 'x' })).resolves.toEqual({ ok: true });

        settle();
    });

    it('works with no usage repository bound at all', async () => {
        const { source } = makeSource({
            connections: [makeConnection()],
            bindings: [makeBinding()],
        });

        const tools = await source.buildTools(makeAgent({ workId: 'work-1' }));
        await expect(tools[0].invoke({ q: 'x' })).resolves.toEqual({ ok: true });
    });
});
