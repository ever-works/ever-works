import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PluginBootstrapService } from '../services/plugin-bootstrap.service';
import { PluginLoaderService } from '../services/plugin-loader.service';
import { PluginLifecycleManagerService } from '../services/plugin-lifecycle-manager.service';
import { PluginContextFactoryService } from '../services/plugin-context-factory.service';
import { PluginRegistryService } from '../services/plugin-registry.service';
import { PluginRepository } from '../repositories/plugin.repository';

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

describe('PluginBootstrapService', () => {
    let service: PluginBootstrapService;
    let pluginLoader: PluginLoaderService;
    let lifecycleManager: PluginLifecycleManagerService;
    let registry: PluginRegistryService;
    let registryEntries: Record<string, { builtIn: boolean; plugin?: unknown }>;

    beforeEach(async () => {
        PluginBootstrapService.resetForTesting();

        // Three registered plugins: one built-in whose entry carries no lazy
        // proxy (a programmatic `builtInPlugins` instance — gets callOnLoad at
        // boot) and two lazy (modules deferred until first method call;
        // callOnLoad fires via the onFirstMaterialize hook, not at boot). A
        // builtIn DISCOVERED ON DISK is a lazy proxy instead; the tests at the
        // end of `bootstrap` cover it, and `plugin-bootstrap.disk-builtin.spec.ts`
        // covers it against the real loader and proxy.
        registryEntries = {
            'system-plugin': { builtIn: true },
            'auto-plugin': { builtIn: false },
            'manual-plugin': { builtIn: false },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PluginBootstrapService,
                {
                    provide: PluginLoaderService,
                    useValue: {
                        discoverAndLoadAll: jest.fn().mockResolvedValue({
                            discovered: 3,
                            loaded: 3,
                            failed: 0,
                            results: [
                                { success: true, pluginId: 'system-plugin' },
                                { success: true, pluginId: 'auto-plugin' },
                                { success: true, pluginId: 'manual-plugin' },
                            ],
                        }),
                        setOnFirstMaterialize: jest.fn(),
                        setOnMaterializeError: jest.fn(),
                    },
                },
                {
                    provide: PluginLifecycleManagerService,
                    useValue: {
                        setContextFactory: jest.fn(),
                        callOnLoad: jest.fn().mockResolvedValue({ success: true }),
                        shutdownAll: jest.fn().mockResolvedValue(undefined),
                    },
                },
                {
                    provide: PluginContextFactoryService,
                    useValue: {},
                },
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn((id: string) => registryEntries[id]),
                        updateState: jest.fn(),
                    },
                },
                {
                    provide: PluginRepository,
                    useValue: {
                        updateState: jest.fn().mockResolvedValue(undefined),
                    },
                },
            ],
        }).compile();

        service = module.get<PluginBootstrapService>(PluginBootstrapService);
        pluginLoader = module.get<PluginLoaderService>(PluginLoaderService);
        lifecycleManager = module.get<PluginLifecycleManagerService>(PluginLifecycleManagerService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
    });

    afterEach(() => {
        PluginBootstrapService.resetForTesting();
    });

    describe('bootstrap', () => {
        it('should call callOnLoad eagerly only for built-in plugins', async () => {
            await service.bootstrap();

            // Built-in plugin's module is bundled and has nothing to defer,
            // so its onLoad fires at boot. Lazy (filesystem) plugins skip
            // this — their onLoad fires via the proxy's onFirstMaterialize
            // hook on first method call.
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledTimes(1);
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledWith('system-plugin');
            expect(registry.get).toHaveBeenCalledWith('system-plugin');
            expect(registry.get).toHaveBeenCalledWith('auto-plugin');
            expect(registry.get).toHaveBeenCalledWith('manual-plugin');
        });

        it('should return loaded count in result', async () => {
            const result = await service.bootstrap();

            expect(result.executed).toBe(true);
            expect(result.loaded).toBe(3);
            expect(result.failed).toBe(0);
        });

        it('should skip if already initialized', async () => {
            await service.bootstrap();
            const result = await service.bootstrap();

            expect(result.executed).toBe(false);
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledTimes(1);
        });

        it('should set context factory on lifecycle manager', async () => {
            await service.bootstrap();

            expect(lifecycleManager.setContextFactory).toHaveBeenCalledTimes(1);
        });

        it('should materialise a disk builtIn (a lazy proxy) instead of calling callOnLoad on it', async () => {
            // callOnLoad on the proxy would call the proxy's onLoad: that
            // materialises, runs the first-materialise hook (callOnLoad =
            // onLoad #1), then forwards the original call (onLoad #2).
            const materialize = jest.fn().mockResolvedValue({});
            registryEntries['disk-builtin'] = {
                builtIn: true,
                plugin: { __materialize: materialize },
            };
            (pluginLoader.discoverAndLoadAll as jest.Mock).mockResolvedValue({
                discovered: 3,
                loaded: 3,
                failed: 0,
                results: [
                    { success: true, pluginId: 'system-plugin' },
                    { success: true, pluginId: 'disk-builtin' },
                    { success: true, pluginId: 'auto-plugin' },
                ],
            });

            await service.bootstrap();

            expect(materialize).toHaveBeenCalledTimes(1);
            expect(materialize).toHaveBeenCalledWith({ waitForLoad: true });
            expect(lifecycleManager.callOnLoad).not.toHaveBeenCalledWith('disk-builtin');
            // A builtIn that is a real instance still gets callOnLoad.
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledTimes(1);
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledWith('system-plugin');
        });

        it('should keep booting when a disk builtIn fails to materialise', async () => {
            registryEntries['disk-broken'] = {
                builtIn: true,
                plugin: { __materialize: jest.fn().mockRejectedValue(new Error('boom')) },
            };
            (pluginLoader.discoverAndLoadAll as jest.Mock).mockResolvedValue({
                discovered: 2,
                loaded: 2,
                failed: 0,
                results: [
                    { success: true, pluginId: 'disk-broken' },
                    { success: true, pluginId: 'system-plugin' },
                ],
            });

            const result = await service.bootstrap();

            expect(result.executed).toBe(true);
            expect(lifecycleManager.callOnLoad).not.toHaveBeenCalledWith('disk-broken');
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledWith('system-plugin');
            expect(Logger.prototype.warn).toHaveBeenCalledWith(
                expect.stringContaining('disk-broken'),
            );
        });
    });
});
