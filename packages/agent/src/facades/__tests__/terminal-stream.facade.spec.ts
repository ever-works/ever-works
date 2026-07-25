import { TerminalStreamFacadeService, TerminalStreamFacadeError } from '../terminal-stream.facade';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';

const FACADE_OPTS = { userId: 'user-1', workId: 'work-1' };

function makeFacade(plugin: unknown) {
    const registry = {
        // BaseFacadeService.resolvePlugin walks these; the exact internals
        // differ per repo version, so stub at the seam the facade uses.
    } as unknown as PluginRegistryService;
    const settings = {} as unknown as PluginSettingsService;
    const facade = new TerminalStreamFacadeService(registry, settings);
    // Stub the protected base resolution directly — the base class's own
    // resolution matrix is covered by its dedicated suite; THIS suite
    // pins the terminal-stream-specific behavior on top of it.
    (facade as unknown as { resolvePlugin: () => Promise<unknown> }).resolvePlugin = jest
        .fn()
        .mockResolvedValue(plugin);
    (
        facade as unknown as { getResolvedSettings: () => Promise<Record<string, unknown>> }
    ).getResolvedSettings = jest.fn().mockResolvedValue({ defaultCols: 80 });
    return facade;
}

function makeTerminalPlugin(overrides: Record<string, unknown> = {}) {
    return {
        id: 'pty-local',
        capabilities: ['terminal-stream'],
        providerName: 'pty-local',
        spawn: jest.fn().mockResolvedValue({ runId: 'r1', isPty: true }),
        ...overrides,
    };
}

describe('TerminalStreamFacadeService', () => {
    it('resolves and spawns through the capability-guarded plugin, injecting settings', async () => {
        const plugin = makeTerminalPlugin();
        const facade = makeFacade(plugin);
        const transport = { publish: jest.fn(), inbound: jest.fn(), close: jest.fn() };

        const handle = await facade.spawn(
            { runId: 'r1', command: ['/bin/true'], cwd: '/tmp', env: {} },
            transport as never,
            FACADE_OPTS as never,
        );

        expect(handle).toMatchObject({ runId: 'r1' });
        expect(plugin.spawn).toHaveBeenCalledWith(
            expect.objectContaining({ settings: { defaultCols: 80 } }),
            transport,
        );
    });

    it('refuses a plugin that lacks the terminal-stream capability', async () => {
        const facade = makeFacade({ id: 'openai', capabilities: ['ai-provider'] });
        await expect(facade.resolveProvider(FACADE_OPTS as never)).resolves.toBeNull();
        await expect(
            facade.spawn(
                { runId: 'r1', command: ['/bin/true'], cwd: '/tmp', env: {} },
                { publish: jest.fn(), inbound: jest.fn(), close: jest.fn() } as never,
                FACADE_OPTS as never,
            ),
        ).rejects.toBeInstanceOf(TerminalStreamFacadeError);
    });

    it('passes TerminalNotProvisionedError through UN-wrapped (the cannot-connect signal)', async () => {
        const notProvisioned = new Error('no PTY host in this runtime');
        notProvisioned.name = 'TerminalNotProvisionedError';
        const plugin = makeTerminalPlugin({
            spawn: jest.fn().mockRejectedValue(notProvisioned),
        });
        const facade = makeFacade(plugin);

        await expect(
            facade.spawn(
                { runId: 'r1', command: ['/bin/true'], cwd: '/tmp', env: {} },
                { publish: jest.fn(), inbound: jest.fn(), close: jest.fn() } as never,
                FACADE_OPTS as never,
            ),
        ).rejects.toMatchObject({ name: 'TerminalNotProvisionedError' });
    });

    it('wraps other spawn failures in TerminalStreamFacadeError with provider identity', async () => {
        const plugin = makeTerminalPlugin({
            spawn: jest.fn().mockRejectedValue(new Error('pump exploded')),
        });
        const facade = makeFacade(plugin);

        await expect(
            facade.spawn(
                { runId: 'r1', command: ['/bin/true'], cwd: '/tmp', env: {} },
                { publish: jest.fn(), inbound: jest.fn(), close: jest.fn() } as never,
                FACADE_OPTS as never,
            ),
        ).rejects.toMatchObject({
            name: 'TerminalStreamFacadeError',
            provider: 'pty-local',
        });
    });
});
