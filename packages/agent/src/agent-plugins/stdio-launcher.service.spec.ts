import { AgentPluginStdioLauncherService } from './stdio-launcher.service';
import type { McpServerConfigService, ResolvedMcpServer } from './mcp-server-config.service';
import type { AgentPluginStdioServerService } from './stdio-server.service';

/**
 * The adapter between `mcp/`'s launcher contract and the Agent Plugins side
 * (AP-14).
 *
 * Its whole job is deciding whether a connection row still corresponds to a
 * launchable server, so these are about the REFUSALS. A connection row
 * outlives the package it points at: the package can be uninstalled, the
 * server renamed or removed from `mcp.json`, its transport switched to HTTP,
 * or the deployment's stdio policy turned off — and every one of those must
 * be an error the caller turns into "no tools", never a launch of something
 * else.
 */
function resolved(over: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
    return {
        name: 'search',
        toolNamespace: 'search',
        transport: 'stdio',
        config: { type: 'stdio', command: './bin/server' },
        provenance: {
            packageName: 'acme-tools',
            packageRoot: '/packages/acme-tools',
            packageVersion: '1.0.0',
            specVersion: '1.0.0',
            sourceKind: 'local',
        },
        ...over,
    } as ResolvedMcpServer;
}

function build(options: { servers?: ResolvedMcpServer[]; launch?: jest.Mock } = {}) {
    const resolveForPackage = jest.fn().mockResolvedValue(options.servers ?? [resolved()]);
    const close = jest.fn().mockResolvedValue(undefined);
    const launchClient =
        options.launch ??
        jest.fn().mockResolvedValue({
            plan: {
                command: './bin/server',
                args: [],
                env: {},
                cwd: '/x',
                resolvesThroughPath: false,
            },
            client: { id: 'client' },
            close,
        });

    const service = new AgentPluginStdioLauncherService(
        { resolveForPackage } as unknown as McpServerConfigService,
        { launchClient } as unknown as AgentPluginStdioServerService,
    );
    return { service, resolveForPackage, launchClient, close };
}

const request = { userId: 'u1', packageName: 'acme-tools', serverName: 'search' };

describe('AgentPluginStdioLauncherService', () => {
    it('launches the named server with the package root the resolver reports', async () => {
        const { service, launchClient } = build();

        const launched = await service.launch(request);

        expect(launchClient).toHaveBeenCalledWith({
            server: { type: 'stdio', command: './bin/server' },
            packageRoot: '/packages/acme-tools',
            userId: 'u1',
            packageName: 'acme-tools',
        });
        expect(launched.client).toEqual({ id: 'client' });
    });

    it('re-resolves from disk on every launch, so an edited package launches as it is NOW', async () => {
        const { service, resolveForPackage } = build();

        await service.launch(request);
        await service.launch(request);

        expect(resolveForPackage).toHaveBeenCalledTimes(2);
    });

    it('refuses when the server is no longer resolvable — uninstalled, renamed, or policy-refused', async () => {
        const { service, launchClient } = build({ servers: [] });

        await expect(service.launch(request)).rejects.toThrow('not currently resolvable');
        expect(launchClient).not.toHaveBeenCalled();
    });

    it('refuses when the package now declares a REMOTE server under that name', async () => {
        const { service, launchClient } = build({
            servers: [
                resolved({
                    transport: 'streamable-http',
                    config: { type: 'streamable-http', url: 'https://acme.example/mcp' },
                }),
            ],
        });

        await expect(service.launch(request)).rejects.toThrow('no longer a stdio server');
        expect(launchClient).not.toHaveBeenCalled();
    });

    it('picks the server by NAME, never the first one the package declares', async () => {
        const { service, launchClient } = build({
            servers: [
                resolved({ name: 'other', config: { type: 'stdio', command: './bin/other' } }),
                resolved({ name: 'search', config: { type: 'stdio', command: './bin/search' } }),
            ],
        });

        await service.launch(request);

        expect(launchClient).toHaveBeenCalledWith(
            expect.objectContaining({ server: { type: 'stdio', command: './bin/search' } }),
        );
    });

    it('propagates a policy refusal from the launcher rather than swallowing it', async () => {
        const { service } = build({
            launch: jest.fn().mockRejectedValue(new Error('Stdio servers are disabled by policy')),
        });

        await expect(service.launch(request)).rejects.toThrow('disabled by policy');
    });

    it('hands back a close that stops the launched server', async () => {
        const { service, close } = build();

        const launched = await service.launch(request);
        await launched.close();

        expect(close).toHaveBeenCalledTimes(1);
    });
});
