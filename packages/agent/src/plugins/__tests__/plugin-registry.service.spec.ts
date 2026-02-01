import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginRegistryService } from '../services/plugin-registry.service';
import { DirectoryPluginRepository } from '../repositories/directory-plugin.repository';
import { UserPluginRepository } from '../repositories/user-plugin.repository';
import { PluginEvents } from '../plugins.constants';
import type { IPlugin, PluginManifest, PluginCategory } from '@ever-works/plugin';

describe('PluginRegistryService', () => {
    let service: PluginRegistryService;
    let eventEmitter: EventEmitter2;
    let directoryPluginRepository: jest.Mocked<DirectoryPluginRepository>;
    let userPluginRepository: jest.Mocked<UserPluginRepository>;

    const createMockPlugin = (id: string, category: PluginCategory = 'utility'): IPlugin =>
        ({
            id,
            name: `Plugin ${id}`,
            version: '1.0.0',
            category,
            capabilities: ['test-capability'],
            settingsSchema: { type: 'object', properties: {} },
            configurationMode: 'hybrid',
            onLoad: jest.fn(),
            onEnable: jest.fn(),
            onDisable: jest.fn(),
            onUnload: jest.fn(),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
        }) as unknown as IPlugin;

    const createMockManifest = (
        id: string,
        category: PluginCategory = 'utility',
    ): PluginManifest => ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category,
        capabilities: ['test-capability'],
    });

    beforeEach(async () => {
        directoryPluginRepository = {
            findByDirectoryAndPlugin: jest.fn(),
        } as unknown as jest.Mocked<DirectoryPluginRepository>;

        userPluginRepository = {
            findByUserAndPlugin: jest.fn(),
        } as unknown as jest.Mocked<UserPluginRepository>;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PluginRegistryService,
                {
                    provide: EventEmitter2,
                    useValue: {
                        emit: jest.fn(),
                        on: jest.fn(),
                        off: jest.fn(),
                    },
                },
                {
                    provide: DirectoryPluginRepository,
                    useValue: directoryPluginRepository,
                },
                {
                    provide: UserPluginRepository,
                    useValue: userPluginRepository,
                },
            ],
        }).compile();

        service = module.get<PluginRegistryService>(PluginRegistryService);
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    });

    afterEach(() => {
        service.clear();
    });

    describe('register', () => {
        it('should register a plugin', () => {
            const plugin = createMockPlugin('test-plugin');
            const manifest = createMockManifest('test-plugin');

            const registered = service.register(plugin, manifest);

            expect(registered).toBeDefined();
            expect(registered.plugin).toBe(plugin);
            expect(registered.manifest).toBe(manifest);
            expect(registered.state).toBe('unloaded');
            expect(service.has('test-plugin')).toBe(true);
        });

        it('should emit registration event', () => {
            const plugin = createMockPlugin('test-plugin');
            const manifest = createMockManifest('test-plugin');

            service.register(plugin, manifest);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.REGISTERED,
                expect.objectContaining({
                    pluginId: 'test-plugin',
                    version: '1.0.0',
                }),
            );
        });

        it('should throw error for duplicate registration', () => {
            const plugin = createMockPlugin('test-plugin');
            const manifest = createMockManifest('test-plugin');

            service.register(plugin, manifest);

            expect(() => service.register(plugin, manifest)).toThrow(
                'Plugin "test-plugin" is already registered',
            );
        });

        it('should register with custom options', () => {
            const plugin = createMockPlugin('test-plugin');
            const manifest = createMockManifest('test-plugin');

            const registered = service.register(plugin, manifest, {
                builtIn: true,
                installPath: '/path/to/plugin',
                state: 'loaded',
            });

            expect(registered.builtIn).toBe(true);
            expect(registered.installPath).toBe('/path/to/plugin');
            expect(registered.state).toBe('loaded');
        });
    });

    describe('unregister', () => {
        it('should unregister a plugin', () => {
            const plugin = createMockPlugin('test-plugin');
            const manifest = createMockManifest('test-plugin');
            service.register(plugin, manifest);

            const result = service.unregister('test-plugin');

            expect(result).toBe(true);
            expect(service.has('test-plugin')).toBe(false);
        });

        it('should emit unregistration event', () => {
            const plugin = createMockPlugin('test-plugin');
            const manifest = createMockManifest('test-plugin');
            service.register(plugin, manifest);

            service.unregister('test-plugin');

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.UNREGISTERED,
                expect.objectContaining({
                    pluginId: 'test-plugin',
                }),
            );
        });

        it('should return false for non-existent plugin', () => {
            const result = service.unregister('non-existent');
            expect(result).toBe(false);
        });
    });

    describe('get', () => {
        it('should get a registered plugin', () => {
            const plugin = createMockPlugin('test-plugin');
            const manifest = createMockManifest('test-plugin');
            service.register(plugin, manifest);

            const registered = service.get('test-plugin');

            expect(registered).toBeDefined();
            expect(registered?.plugin.id).toBe('test-plugin');
        });

        it('should return undefined for non-existent plugin', () => {
            const registered = service.get('non-existent');
            expect(registered).toBeUndefined();
        });
    });

    describe('getByCategory', () => {
        it('should get plugins by category', () => {
            const plugin1 = createMockPlugin('plugin-1', 'utility');
            const plugin2 = createMockPlugin('plugin-2', 'utility');
            const plugin3 = createMockPlugin('plugin-3', 'git-provider');

            service.register(plugin1, createMockManifest('plugin-1', 'utility'));
            service.register(plugin2, createMockManifest('plugin-2', 'utility'));
            service.register(plugin3, createMockManifest('plugin-3', 'git-provider'));

            const utilityPlugins = service.getByCategory('utility');

            expect(utilityPlugins).toHaveLength(2);
            expect(utilityPlugins.map((p) => p.plugin.id)).toContain('plugin-1');
            expect(utilityPlugins.map((p) => p.plugin.id)).toContain('plugin-2');
        });

        it('should return empty array for non-existent category', () => {
            const plugins = service.getByCategory('deployment');
            expect(plugins).toHaveLength(0);
        });
    });

    describe('getByCapability', () => {
        it('should get plugins by capability', () => {
            const plugin1 = createMockPlugin('plugin-1');
            const plugin2 = createMockPlugin('plugin-2');

            const manifest1 = {
                ...createMockManifest('plugin-1'),
                capabilities: ['cap-a', 'cap-b'],
            };
            const manifest2 = {
                ...createMockManifest('plugin-2'),
                capabilities: ['cap-b', 'cap-c'],
            };

            service.register(plugin1, manifest1 as PluginManifest);
            service.register(plugin2, manifest2 as PluginManifest);

            const capBPlugins = service.getByCapability('cap-b');

            expect(capBPlugins).toHaveLength(2);
        });

        it('should return empty array for non-existent capability', () => {
            const plugins = service.getByCapability('non-existent');
            expect(plugins).toHaveLength(0);
        });
    });

    describe('getEnabled', () => {
        it('should get only enabled plugins', () => {
            const plugin1 = createMockPlugin('plugin-1');
            const plugin2 = createMockPlugin('plugin-2');

            service.register(plugin1, createMockManifest('plugin-1'), { state: 'enabled' });
            service.register(plugin2, createMockManifest('plugin-2'), { state: 'loaded' });

            const enabledPlugins = service.getEnabled();

            expect(enabledPlugins).toHaveLength(1);
            expect(enabledPlugins[0].plugin.id).toBe('plugin-1');
        });
    });

    describe('updateState', () => {
        it('should update plugin state', () => {
            const plugin = createMockPlugin('test-plugin');
            service.register(plugin, createMockManifest('test-plugin'));

            const result = service.updateState('test-plugin', 'loaded');

            expect(result).toBe(true);
            expect(service.get('test-plugin')?.state).toBe('loaded');
        });

        it('should record state history', () => {
            const plugin = createMockPlugin('test-plugin');
            service.register(plugin, createMockManifest('test-plugin'));

            service.updateState('test-plugin', 'loading');
            service.updateState('test-plugin', 'loaded');
            service.updateState('test-plugin', 'enabled');

            const registered = service.get('test-plugin');
            expect(registered?.stateHistory).toHaveLength(4); // initial + 3 updates
        });

        it('should emit state change event', () => {
            const plugin = createMockPlugin('test-plugin');
            service.register(plugin, createMockManifest('test-plugin'));

            service.updateState('test-plugin', 'loaded');

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PluginEvents.STATE_CHANGED,
                expect.objectContaining({
                    pluginId: 'test-plugin',
                    oldState: 'unloaded',
                    newState: 'loaded',
                }),
            );
        });

        it('should record loadedAt timestamp when state is loaded', () => {
            const plugin = createMockPlugin('test-plugin');
            service.register(plugin, createMockManifest('test-plugin'));

            service.updateState('test-plugin', 'loaded');

            expect(service.get('test-plugin')?.loadedAt).toBeDefined();
        });

        it('should record enabledAt timestamp when state is enabled', () => {
            const plugin = createMockPlugin('test-plugin');
            service.register(plugin, createMockManifest('test-plugin'));

            service.updateState('test-plugin', 'enabled');

            expect(service.get('test-plugin')?.enabledAt).toBeDefined();
        });

        it('should store error when provided', () => {
            const plugin = createMockPlugin('test-plugin');
            service.register(plugin, createMockManifest('test-plugin'));

            service.updateState('test-plugin', 'error', new Error('Test error'));

            expect(service.get('test-plugin')?.error).toBeDefined();
        });
    });

    describe('getVersionsMap', () => {
        it('should return map of plugin versions', () => {
            const plugin1 = createMockPlugin('plugin-1');
            const plugin2 = createMockPlugin('plugin-2');

            const manifest1 = { ...createMockManifest('plugin-1'), version: '1.0.0' };
            const manifest2 = { ...createMockManifest('plugin-2'), version: '2.0.0' };

            service.register(plugin1, manifest1 as PluginManifest);
            service.register(plugin2, manifest2 as PluginManifest);

            const versionsMap = service.getVersionsMap();

            expect(versionsMap.get('plugin-1')).toEqual({ version: '1.0.0' });
            expect(versionsMap.get('plugin-2')).toEqual({ version: '2.0.0' });
        });
    });

    describe('count', () => {
        it('should return correct count', () => {
            expect(service.count()).toBe(0);

            service.register(createMockPlugin('plugin-1'), createMockManifest('plugin-1'));
            expect(service.count()).toBe(1);

            service.register(createMockPlugin('plugin-2'), createMockManifest('plugin-2'));
            expect(service.count()).toBe(2);

            service.unregister('plugin-1');
            expect(service.count()).toBe(1);
        });
    });

    describe('clear', () => {
        it('should remove all plugins', () => {
            service.register(createMockPlugin('plugin-1'), createMockManifest('plugin-1'));
            service.register(createMockPlugin('plugin-2'), createMockManifest('plugin-2'));

            service.clear();

            expect(service.count()).toBe(0);
            expect(service.getAll()).toHaveLength(0);
        });
    });

    describe('getDefaultForCapability', () => {
        it('should return plugin with matching defaultForCapabilities', () => {
            const plugin = createMockPlugin('search-plugin');
            const manifest: PluginManifest = {
                ...createMockManifest('search-plugin'),
                capabilities: ['search'],
                defaultForCapabilities: ['search'],
            };
            service.register(plugin, manifest, { state: 'enabled' });

            const result = service.getDefaultForCapability('search');

            expect(result?.plugin.id).toBe('search-plugin');
        });

        it('should return undefined when no plugin has defaultForCapabilities', () => {
            const plugin = createMockPlugin('search-plugin');
            const manifest: PluginManifest = {
                ...createMockManifest('search-plugin'),
                capabilities: ['search'],
            };
            service.register(plugin, manifest, { state: 'enabled' });

            const result = service.getDefaultForCapability('search');

            expect(result).toBeUndefined();
        });

        it('should only return enabled plugins', () => {
            const plugin = createMockPlugin('search-plugin');
            const manifest: PluginManifest = {
                ...createMockManifest('search-plugin'),
                capabilities: ['search'],
                defaultForCapabilities: ['search'],
            };
            service.register(plugin, manifest); // state is 'unloaded' by default

            const result = service.getDefaultForCapability('search');

            expect(result).toBeUndefined();
        });

        it('should support multi-capability plugins with selective defaults', () => {
            const plugin = createMockPlugin('multi-plugin');
            const manifest: PluginManifest = {
                ...createMockManifest('multi-plugin'),
                capabilities: ['search', 'content-extractor'],
                defaultForCapabilities: ['search'],
            };
            service.register(plugin, manifest, { state: 'enabled' });

            expect(service.getDefaultForCapability('search')?.plugin.id).toBe('multi-plugin');
            expect(service.getDefaultForCapability('content-extractor')).toBeUndefined();
        });
    });

    describe('getDefaultForCapabilityScoped', () => {
        it('should return plugin enabled at directory level first', async () => {
            const plugin = createMockPlugin('search-plugin');
            const manifest: PluginManifest = {
                ...createMockManifest('search-plugin'),
                capabilities: ['search'],
            };
            service.register(plugin, manifest, { state: 'enabled' });

            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue({
                id: '1',
                directoryId: 'dir-1',
                pluginId: 'search-plugin',
                enabled: true,
                activeCapability: 'search',
            } as any);

            const result = await service.getDefaultForCapabilityScoped('search', 'dir-1');

            expect(result?.plugin.id).toBe('search-plugin');
            expect(directoryPluginRepository.findByDirectoryAndPlugin).toHaveBeenCalledWith(
                'dir-1',
                'search-plugin',
            );
        });

        it('should skip plugin disabled at directory level', async () => {
            const plugin1 = createMockPlugin('plugin-1');
            const plugin2 = createMockPlugin('plugin-2');
            const manifest1: PluginManifest = {
                ...createMockManifest('plugin-1'),
                capabilities: ['search'],
            };
            const manifest2: PluginManifest = {
                ...createMockManifest('plugin-2'),
                capabilities: ['search'],
            };
            service.register(plugin1, manifest1, { state: 'enabled' });
            service.register(plugin2, manifest2, { state: 'enabled' });

            // plugin-1 is disabled at directory level
            directoryPluginRepository.findByDirectoryAndPlugin.mockImplementation(
                async (dirId, pluginId) => {
                    if (pluginId === 'plugin-1') {
                        return { enabled: false, directoryId: dirId, pluginId } as any;
                    }
                    return { enabled: true, directoryId: dirId, pluginId } as any;
                },
            );

            const result = await service.getDefaultForCapabilityScoped('search', 'dir-1');

            expect(result?.plugin.id).toBe('plugin-2');
        });

        it('should check user level when directory level returns null', async () => {
            const plugin = createMockPlugin('search-plugin');
            const manifest: PluginManifest = {
                ...createMockManifest('search-plugin'),
                capabilities: ['search'],
                autoEnable: true,
            };
            service.register(plugin, manifest, { state: 'enabled' });

            // No directory-level config
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            // User has it enabled
            userPluginRepository.findByUserAndPlugin.mockResolvedValue({
                enabled: true,
                userId: 'user-1',
                pluginId: 'search-plugin',
            } as any);

            const result = await service.getDefaultForCapabilityScoped('search', 'dir-1', 'user-1');

            expect(result?.plugin.id).toBe('search-plugin');
        });

        it('should fall back to autoEnable when no scope config exists', async () => {
            const plugin = createMockPlugin('search-plugin');
            const manifest: PluginManifest = {
                ...createMockManifest('search-plugin'),
                capabilities: ['search'],
                autoEnable: true,
            };
            service.register(plugin, manifest, { state: 'enabled' });

            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            userPluginRepository.findByUserAndPlugin.mockResolvedValue(null);

            const result = await service.getDefaultForCapabilityScoped('search');

            expect(result?.plugin.id).toBe('search-plugin');
        });

        it('should return undefined when plugin autoEnable is false and no config', async () => {
            const plugin = createMockPlugin('search-plugin');
            const manifest: PluginManifest = {
                ...createMockManifest('search-plugin'),
                capabilities: ['search'],
                autoEnable: false,
            };
            service.register(plugin, manifest, { state: 'enabled' });

            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            userPluginRepository.findByUserAndPlugin.mockResolvedValue(null);

            const result = await service.getDefaultForCapabilityScoped('search');

            expect(result).toBeUndefined();
        });

        it('should prefer plugin with defaultForCapabilities when enabled', async () => {
            const plugin1 = createMockPlugin('plugin-1');
            const plugin2 = createMockPlugin('plugin-2');
            const manifest1: PluginManifest = {
                ...createMockManifest('plugin-1'),
                capabilities: ['search'],
            };
            const manifest2: PluginManifest = {
                ...createMockManifest('plugin-2'),
                capabilities: ['search'],
                defaultForCapabilities: ['search'],
            };
            service.register(plugin1, manifest1, { state: 'enabled' });
            service.register(plugin2, manifest2, { state: 'enabled' });

            // No directory-level config (returns null)
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            userPluginRepository.findByUserAndPlugin.mockResolvedValue(null);

            const result = await service.getDefaultForCapabilityScoped('search');

            expect(result?.plugin.id).toBe('plugin-2');
        });
    });

    describe('getEnabledPluginsScoped', () => {
        it('should return all enabled plugins when no scope provided', async () => {
            const plugin1 = createMockPlugin('plugin-1');
            const plugin2 = createMockPlugin('plugin-2');
            service.register(plugin1, createMockManifest('plugin-1'), { state: 'enabled' });
            service.register(plugin2, createMockManifest('plugin-2'), { state: 'enabled' });

            // With no scope IDs, falls back to autoEnable (defaults to true)
            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            userPluginRepository.findByUserAndPlugin.mockResolvedValue(null);

            const result = await service.getEnabledPluginsScoped();

            expect(result).toHaveLength(2);
        });

        it('should filter by capability when provided', async () => {
            const plugin1 = createMockPlugin('plugin-1');
            const plugin2 = createMockPlugin('plugin-2');
            const manifest1 = { ...createMockManifest('plugin-1'), capabilities: ['cap-a'] };
            const manifest2 = { ...createMockManifest('plugin-2'), capabilities: ['cap-b'] };
            service.register(plugin1, manifest1 as PluginManifest, { state: 'enabled' });
            service.register(plugin2, manifest2 as PluginManifest, { state: 'enabled' });

            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            userPluginRepository.findByUserAndPlugin.mockResolvedValue(null);

            const result = await service.getEnabledPluginsScoped('cap-a');

            expect(result).toHaveLength(1);
            expect(result[0].plugin.id).toBe('plugin-1');
        });

        it('should exclude plugins disabled at directory level', async () => {
            const plugin1 = createMockPlugin('plugin-1');
            const plugin2 = createMockPlugin('plugin-2');
            service.register(plugin1, createMockManifest('plugin-1'), { state: 'enabled' });
            service.register(plugin2, createMockManifest('plugin-2'), { state: 'enabled' });

            directoryPluginRepository.findByDirectoryAndPlugin.mockImplementation(
                async (dirId, pluginId) => {
                    if (pluginId === 'plugin-1') {
                        return { enabled: false, directoryId: dirId, pluginId } as any;
                    }
                    return { enabled: true, directoryId: dirId, pluginId } as any;
                },
            );

            const result = await service.getEnabledPluginsScoped(undefined, 'dir-1');

            expect(result).toHaveLength(1);
            expect(result[0].plugin.id).toBe('plugin-2');
        });

        it('should include plugins enabled at user level when directory is null', async () => {
            const plugin = createMockPlugin('plugin-1');
            service.register(plugin, createMockManifest('plugin-1'), { state: 'enabled' });

            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            userPluginRepository.findByUserAndPlugin.mockResolvedValue({
                enabled: true,
                userId: 'user-1',
                pluginId: 'plugin-1',
            } as any);

            const result = await service.getEnabledPluginsScoped(undefined, 'dir-1', 'user-1');

            expect(result).toHaveLength(1);
        });

        it('should exclude plugins disabled at user level when no directory config', async () => {
            const plugin = createMockPlugin('plugin-1');
            service.register(plugin, createMockManifest('plugin-1'), { state: 'enabled' });

            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            userPluginRepository.findByUserAndPlugin.mockResolvedValue({
                enabled: false,
                userId: 'user-1',
                pluginId: 'plugin-1',
            } as any);

            const result = await service.getEnabledPluginsScoped(undefined, undefined, 'user-1');

            expect(result).toHaveLength(0);
        });

        it('should not include plugins that are not enabled at registry level', async () => {
            const plugin = createMockPlugin('plugin-1');
            service.register(plugin, createMockManifest('plugin-1'), { state: 'loaded' }); // Not 'enabled'

            directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);
            userPluginRepository.findByUserAndPlugin.mockResolvedValue(null);

            const result = await service.getEnabledPluginsScoped();

            expect(result).toHaveLength(0);
        });
    });
});
