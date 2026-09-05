import { McpToolSource } from '../mcp-tool-source';
import { McpConnectionsService } from '../mcp-connections.service';
import type { McpClientService } from '../mcp-client.service';
import type { McpSdkClient } from '../mcp-sdk';
import type { McpStdioLauncher } from '../mcp-stdio-launcher';
import type { McpServerConnection } from '../../entities/mcp-server-connection.entity';
import type { AgentMcpServerBinding } from '../../entities/agent-mcp-server-binding.entity';
import type { Agent } from '../../entities/agent.entity';

/**
 * AP-14, the consumer half: a stdio server declared by an installed package
 * contributes tools to an agent run.
 *
 * The properties that matter are not "it lists tools" but the lifecycle
 * around it — launched ONCE per run rather than per call (for stdio,
 * "connect" means "spawn"), registered against the run so `releaseRun`
 * closes it on every exit path, and failure-isolated so a package that
 * refuses to start costs its own tools and nothing else.
 */
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
        name: 'acme-search',
        url: 'stdio:acme-tools/search',
        transport: 'stdio',
        authHeaders: null,
        enabled: true,
        source: 'package',
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

const RUN = { runId: 'run-1' };

function makeSource(options: {
    connections: McpServerConnection[];
    launcher?: McpStdioLauncher | undefined;
    launchedClient?: McpSdkClient;
    closeSpy?: jest.Mock;
}) {
    const connectionsRepo = {
        findEnabledByUser: jest
            .fn()
            .mockResolvedValue(options.connections.filter((c) => c.enabled)),
        findByUser: jest.fn().mockResolvedValue(options.connections),
    };
    const bindingsRepo = { findForAgent: jest.fn().mockResolvedValue([makeBinding()]) };

    const client = {
        listTools: jest.fn().mockResolvedValue([]),
        callTool: jest.fn().mockResolvedValue({ remote: true }),
        listToolsOver: jest.fn().mockResolvedValue([
            {
                name: 'search',
                description: 'Search',
                inputSchema: { type: 'object', properties: {}, required: [] },
            },
        ]),
        callToolOver: jest.fn().mockResolvedValue({ overClient: true }),
        invalidate: jest.fn(),
    } as unknown as jest.Mocked<McpClientService>;

    const connections = new McpConnectionsService(
        connectionsRepo as never,
        bindingsRepo as never,
        client,
        { findByIdAndUser: jest.fn() } as never,
        undefined,
    );

    const source = new McpToolSource(connections, client, undefined, options.launcher);
    return { source, client };
}

function makeLauncher(over: Partial<{ client: McpSdkClient; close: jest.Mock }> = {}) {
    const close = over.close ?? jest.fn().mockResolvedValue(undefined);
    const client = over.client ?? ({ id: 'launched' } as unknown as McpSdkClient);
    const launch = jest.fn().mockResolvedValue({ client, close });
    return { launcher: { launch } as unknown as McpStdioLauncher, launch, close, client };
}

describe('McpToolSource — stdio connections (AP-14)', () => {
    it('launches the package server named by the connection pointer and lists its tools over that client', async () => {
        const { launcher, launch, client: launched } = makeLauncher();
        const { source, client } = makeSource({ connections: [makeConnection()], launcher });

        const tools = await source.buildTools(makeAgent(), RUN);

        expect(launch).toHaveBeenCalledWith({
            userId: 'u1',
            packageName: 'acme-tools',
            serverName: 'search',
        });
        expect(client.listToolsOver).toHaveBeenCalledWith(launched, expect.anything());
        expect(client.listTools).not.toHaveBeenCalled();
        expect(tools.map((tool) => tool.name)).toEqual(['mcp__acme-search__search']);
    });

    it('invokes over the SAME client rather than reconnecting — a reconnect here is a respawn', async () => {
        const { launcher, launch, client: launched } = makeLauncher();
        const { source, client } = makeSource({ connections: [makeConnection()], launcher });

        const [tool] = await source.buildTools(makeAgent(), RUN);
        const result = await tool.invoke({ q: 'x' });

        expect(result).toEqual({ overClient: true });
        expect(client.callToolOver).toHaveBeenCalledWith(launched, expect.anything(), 'search', {
            q: 'x',
        });
        expect(client.callTool).not.toHaveBeenCalled();
        // Still one launch: building tools spawned it, calling did not.
        expect(launch).toHaveBeenCalledTimes(1);
    });

    it('registers the launched server against the run, so releaseRun stops it', async () => {
        const { launcher, close } = makeLauncher();
        const { source } = makeSource({ connections: [makeConnection()], launcher });

        await source.buildTools(makeAgent(), RUN);
        expect(close).not.toHaveBeenCalled();

        await source.releaseRun('run-1');

        expect(close).toHaveBeenCalledTimes(1);
    });

    /**
     * A tool descriptor outlives its run: the model can hold one and call it
     * late. Reaching the closed client would surface as "Not connected",
     * which `callToolOver` classifies as a server fault and STAMPS onto
     * `lastError` — leaving a healthy connection showing an error in the
     * Settings UI because a call arrived after the run ended.
     */
    it('a call after releaseRun fails locally, without touching the connection or its status', async () => {
        const { launcher } = makeLauncher();
        const { source, client } = makeSource({ connections: [makeConnection()], launcher });

        const [tool] = await source.buildTools(makeAgent(), RUN);
        await source.releaseRun('run-1');

        const result = (await tool.invoke({ q: 'x' })) as { error: string };

        expect(result.error).toContain('the run that started this server has ended');
        expect(client.callToolOver).not.toHaveBeenCalled();
        expect(client.callTool).not.toHaveBeenCalled();
    });

    it('keeps runs apart — releasing another run leaves this one’s server running', async () => {
        const { launcher, close } = makeLauncher();
        const { source } = makeSource({ connections: [makeConnection()], launcher });

        await source.buildTools(makeAgent(), RUN);
        await source.releaseRun('some-other-run');

        expect(close).not.toHaveBeenCalled();
    });

    it('a server that refuses to launch costs its own tools and nothing else', async () => {
        const launcher = {
            launch: jest.fn().mockRejectedValue(new Error('disabled by policy')),
        } as unknown as McpStdioLauncher;
        const { source } = makeSource({
            connections: [
                makeConnection(),
                makeConnection({
                    id: 'c2',
                    name: 'remote',
                    url: 'https://mcp.example.com/mcp',
                    transport: 'streamable-http',
                }),
            ],
            launcher,
        });

        const tools = await source.buildTools(makeAgent(), RUN);

        // The remote server still contributed (its listTools returns []),
        // and the run was never failed.
        expect(tools).toEqual([]);
    });

    it('contributes nothing when no launcher is bound — a runtime without Agent Plugins', async () => {
        const { source, client } = makeSource({
            connections: [makeConnection()],
            launcher: undefined,
        });

        await expect(source.buildTools(makeAgent(), RUN)).resolves.toEqual([]);
        expect(client.listToolsOver).not.toHaveBeenCalled();
    });

    it('refuses a stdio row whose pointer does not name a package server, rather than guessing', async () => {
        const { launcher, launch } = makeLauncher();
        const { source } = makeSource({
            connections: [makeConnection({ url: 'https://not-a-stdio-pointer.example' })],
            launcher,
        });

        await expect(source.buildTools(makeAgent(), RUN)).resolves.toEqual([]);
        expect(launch).not.toHaveBeenCalled();
    });

    it('leaves the remote path completely untouched', async () => {
        const { launcher, launch } = makeLauncher();
        const { source, client } = makeSource({
            connections: [
                makeConnection({
                    url: 'https://mcp.example.com/mcp',
                    transport: 'streamable-http',
                }),
            ],
            launcher,
        });

        await source.buildTools(makeAgent(), RUN);

        expect(launch).not.toHaveBeenCalled();
        expect(client.listTools).toHaveBeenCalled();
        expect(client.listToolsOver).not.toHaveBeenCalled();
    });

    it('does not launch anything for an agent forbidden from external tools', async () => {
        const { launcher, launch } = makeLauncher();
        const { source } = makeSource({ connections: [makeConnection()], launcher });

        await source.buildTools(
            makeAgent({ permissions: { canCallExternalTools: false } as Agent['permissions'] }),
            RUN,
        );

        expect(launch).not.toHaveBeenCalled();
    });
});
