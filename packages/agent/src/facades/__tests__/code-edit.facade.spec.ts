import { Test, TestingModule } from '@nestjs/testing';
import { CodeEditFacadeService } from '../code-edit.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { AiFacadeService } from '../ai.facade';
import type { ICodeEditPlugin, PluginManifest } from '@ever-works/plugin';

describe('CodeEditFacadeService', () => {
    let service: CodeEditFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;

    const createCodeEditPlugin = (id: string): ICodeEditPlugin =>
        ({
            id,
            name: id,
            version: '1.0.0',
            category: 'pipeline',
            capabilities: ['code-edit'],
            configurationMode: 'hybrid',
            executeCodeEdit: jest.fn(),
            onLoad: jest.fn(),
            onUnload: jest.fn(),
        }) as unknown as ICodeEditPlugin;

    const createRegistered = (
        id: string,
        manifest: Partial<PluginManifest> = {},
        state: RegisteredPlugin['state'] = 'loaded',
    ): RegisteredPlugin => ({
        plugin: createCodeEditPlugin(id),
        manifest: {
            id,
            name: id,
            version: '1.0.0',
            description: 'Test code-edit plugin',
            category: 'pipeline',
            capabilities: ['code-edit'],
            ...manifest,
        } as PluginManifest,
        state,
        builtIn: false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CodeEditFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(false),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: { getSettings: jest.fn().mockResolvedValue({}) },
                },
                { provide: AiFacadeService, useValue: {} },
            ],
        }).compile();

        service = module.get(CodeEditFacadeService);
        registry = module.get(PluginRegistryService);
    });

    describe('listProviders', () => {
        it('returns only plugins the user has enabled', async () => {
            registry.getByCapability.mockReturnValue([
                createRegistered('claude-code'),
                createRegistered('gemini'),
            ]);
            registry.isPluginEnabledForScope.mockImplementation(async (id) => id === 'claude-code');

            const providers = await service.listProviders('user-1');

            expect(providers.map((p) => p.id)).toEqual(['claude-code']);
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
                'claude-code',
                undefined,
                'user-1',
            );
            expect(registry.isPluginEnabledForScope).toHaveBeenCalledWith(
                'gemini',
                undefined,
                'user-1',
            );
        });

        it('skips plugins that are registered but not loaded', async () => {
            registry.getByCapability.mockReturnValue([
                createRegistered('claude-code', {}, 'error'),
                createRegistered('codex'),
            ]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const providers = await service.listProviders('user-1');

            expect(providers.map((p) => p.id)).toEqual(['codex']);
        });

        it('skips supplementary plugins', async () => {
            registry.getByCapability.mockReturnValue([
                createRegistered('claude-code'),
                createRegistered('helper', { supplementary: true }),
            ]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const providers = await service.listProviders('user-1');

            expect(providers.map((p) => p.id)).toEqual(['claude-code']);
        });

        it('returns an empty list when no code-edit plugins are registered', async () => {
            registry.getByCapability.mockReturnValue([]);
            await expect(service.listProviders('user-1')).resolves.toEqual([]);
        });

        it('marks defaultForCapabilities plugin as isDefault', async () => {
            registry.getByCapability.mockReturnValue([
                createRegistered('claude-code', { defaultForCapabilities: ['code-edit'] }),
                createRegistered('codex'),
            ]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const providers = await service.listProviders('user-1');

            expect(providers.find((p) => p.id === 'claude-code')?.isDefault).toBe(true);
            expect(providers.find((p) => p.id === 'codex')?.isDefault).toBe(false);
        });
    });

    describe('resolveProvider', () => {
        it('throws when the user has not enabled the requested plugin', async () => {
            const registered = createRegistered('gemini');
            registry.get.mockReturnValue(registered);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            await expect(
                service.resolveProvider({ userId: 'user-1', providerId: 'gemini' }),
            ).rejects.toThrow(/not enabled for this user/);
        });

        it('returns the plugin when the user has it enabled', async () => {
            const registered = createRegistered('claude-code');
            registry.get.mockReturnValue(registered);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const plugin = await service.resolveProvider({
                userId: 'user-1',
                providerId: 'claude-code',
            });

            expect(plugin.id).toBe('claude-code');
        });

        it('falls back to the first user-enabled plugin when no providerId is given', async () => {
            const registered = createRegistered('codex');
            registry.getByCapability.mockReturnValue([registered]);
            registry.get.mockReturnValue(registered);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const plugin = await service.resolveProvider({ userId: 'user-1' });

            expect(plugin.id).toBe('codex');
        });

        it('throws when the user has no providers enabled and none was requested', async () => {
            registry.getByCapability.mockReturnValue([createRegistered('codex')]);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            await expect(service.resolveProvider({ userId: 'user-1' })).rejects.toThrow(
                /No code-edit provider available/,
            );
        });
    });
});
