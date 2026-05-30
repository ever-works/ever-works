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
    let lifecycleManager: PluginLifecycleManagerService;
    let registry: PluginRegistryService;

    beforeEach(async () => {
        PluginBootstrapService.resetForTesting();

        // Three registered plugins: one built-in (eagerly loaded at boot,
        // gets callOnLoad immediately) and two lazy (modules deferred until
        // first method call; callOnLoad fires via onFirstMaterialize hook,
        // not at boot).
        const registryEntries: Record<string, { builtIn: boolean }> = {
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
    });
});
