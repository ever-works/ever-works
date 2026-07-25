import { Test, TestingModule } from '@nestjs/testing';
import { WorkspaceFacadeService, WorkspaceFacadeError } from '../workspace.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { IWorkspacePlugin, PluginManifest, WorkspaceHandle } from '@ever-works/plugin';
import { WorkspaceNotProvisionedError } from '@ever-works/plugin';

describe('WorkspaceFacadeService', () => {
    let service: WorkspaceFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;

    const handle: WorkspaceHandle = {
        path: '/tmp/ws/task-abc12345',
        baseSha: 'deadbeef',
        reused: false,
        branch: 'task/fix-thing-abc12345',
        bindingKey: 'task-1',
    };

    const spec = {
        repoUrl: 'https://github.com/acme/site.git',
        baseRef: 'main',
        branch: 'task/fix-thing-abc12345',
        bindingKey: 'task-1',
    };

    const createMockWorkspacePlugin = (id: string): IWorkspacePlugin => ({
        id,
        name: id,
        version: '1.0.0',
        category: 'utility',
        capabilities: ['workspace'],
        settingsSchema: { type: 'object', properties: {} },
        providerName: id,
        onLoad: jest.fn(),
        onUnload: jest.fn(),
        provision: jest.fn().mockResolvedValue(handle),
        finalize: jest.fn().mockResolvedValue({ pushed: true, headSha: 'cafe', empty: false }),
        simulateMerge: jest.fn().mockResolvedValue({ clean: true, conflictPaths: [] }),
        teardown: jest.fn().mockResolvedValue(undefined),
    });

    const createRegisteredPlugin = (
        plugin: IWorkspacePlugin,
        state: RegisteredPlugin['state'] = 'loaded',
    ): RegisteredPlugin => ({
        plugin: plugin as any,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test workspace plugin',
            category: plugin.category,
            capabilities: plugin.capabilities,
        } as PluginManifest,
        state,
        builtIn: false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WorkspaceFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: { getSettings: jest.fn().mockResolvedValue({ poolDir: '/tmp/ws' }) },
                },
            ],
        }).compile();

        service = module.get(WorkspaceFacadeService);
        registry = module.get(PluginRegistryService);
    });

    const arm = (plugin: IWorkspacePlugin) => {
        const registered = createRegisteredPlugin(plugin);
        registry.get.mockReturnValue(registered);
        registry.getByCapability.mockReturnValue([registered]);
    };

    it('provisions through the resolved plugin with resolved settings attached', async () => {
        const plugin = createMockWorkspacePlugin('local-workspace');
        arm(plugin);

        const result = await service.provision(spec, {
            userId: 'u1',
            providerOverride: 'local-workspace',
        });

        expect(result).toEqual(handle);
        expect(plugin.provision).toHaveBeenCalledWith(
            expect.objectContaining({ ...spec, settings: { poolDir: '/tmp/ws' } }),
        );
    });

    it('passes WorkspaceNotProvisionedError through un-wrapped (stable name)', async () => {
        const plugin = createMockWorkspacePlugin('local-workspace');
        (plugin.provision as jest.Mock).mockRejectedValue(
            new WorkspaceNotProvisionedError('no git on host'),
        );
        arm(plugin);

        await expect(
            service.provision(spec, { userId: 'u1', providerOverride: 'local-workspace' }),
        ).rejects.toMatchObject({
            name: 'WorkspaceNotProvisionedError',
            message: 'no git on host',
        });
    });

    it('wraps generic plugin failures in WorkspaceFacadeError with operation + provider', async () => {
        const plugin = createMockWorkspacePlugin('local-workspace');
        (plugin.simulateMerge as jest.Mock).mockRejectedValue(new Error('merge-tree exploded'));
        arm(plugin);

        await expect(
            service.simulateMerge(handle, 'main', {
                userId: 'u1',
                providerOverride: 'local-workspace',
            }),
        ).rejects.toMatchObject({
            name: 'WorkspaceFacadeError',
            message: expect.stringContaining('merge-tree exploded'),
        });
    });

    it('teardown never throws — plugin failure is swallowed and logged', async () => {
        const plugin = createMockWorkspacePlugin('local-workspace');
        (plugin.teardown as jest.Mock).mockRejectedValue(new Error('EBUSY'));
        arm(plugin);

        await expect(
            service.teardown(handle, { userId: 'u1', providerOverride: 'local-workspace' }),
        ).resolves.toBeUndefined();
    });

    it('rejects a resolved plugin that lacks the workspace contract', async () => {
        const impostor = createMockWorkspacePlugin('github');
        (impostor as any).capabilities = ['git-provider'];
        const registered = createRegisteredPlugin(impostor);
        (registered.manifest as any).capabilities = ['workspace']; // registry thinks yes, instance says no
        registry.get.mockReturnValue(registered);

        await expect(
            service.provision(spec, { userId: 'u1', providerOverride: 'github' }),
        ).rejects.toBeInstanceOf(WorkspaceFacadeError);
    });
});
