import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PluginBootstrapService } from '../services/plugin-bootstrap.service';
import { PluginLoaderService } from '../services/plugin-loader.service';
import { PluginLifecycleManagerService } from '../services/plugin-lifecycle-manager.service';
import { PluginContextFactoryService } from '../services/plugin-context-factory.service';

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

describe('PluginBootstrapService', () => {
    let service: PluginBootstrapService;
    let loader: PluginLoaderService;
    let lifecycleManager: PluginLifecycleManagerService;

    beforeEach(async () => {
        PluginBootstrapService.resetForTesting();

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
                    },
                },
                {
                    provide: PluginLifecycleManagerService,
                    useValue: {
                        setContextFactory: jest.fn(),
                        callOnLoad: jest.fn().mockResolvedValue({ success: true }),
                        enableSystemPlugins: jest
                            .fn()
                            .mockResolvedValue([{ success: true, pluginId: 'system-plugin' }]),
                        enableAutoEnablePlugins: jest
                            .fn()
                            .mockResolvedValue([{ success: true, pluginId: 'auto-plugin' }]),
                        shutdownAll: jest.fn().mockResolvedValue(undefined),
                    },
                },
                {
                    provide: PluginContextFactoryService,
                    useValue: {},
                },
            ],
        }).compile();

        service = module.get<PluginBootstrapService>(PluginBootstrapService);
        loader = module.get<PluginLoaderService>(PluginLoaderService);
        lifecycleManager = module.get<PluginLifecycleManagerService>(PluginLifecycleManagerService);
    });

    afterEach(() => {
        PluginBootstrapService.resetForTesting();
    });

    describe('bootstrap', () => {
        it('should call enableAutoEnablePlugins after enableSystemPlugins', async () => {
            const callOrder: string[] = [];
            (lifecycleManager.enableSystemPlugins as jest.Mock).mockImplementation(async () => {
                callOrder.push('enableSystemPlugins');
                return [{ success: true, pluginId: 'system-plugin' }];
            });
            (lifecycleManager.enableAutoEnablePlugins as jest.Mock).mockImplementation(async () => {
                callOrder.push('enableAutoEnablePlugins');
                return [{ success: true, pluginId: 'auto-plugin' }];
            });

            await service.bootstrap();

            expect(callOrder).toEqual(['enableSystemPlugins', 'enableAutoEnablePlugins']);
        });

        it('should include auto-enabled count in systemEnabled result', async () => {
            const result = await service.bootstrap();

            expect(result.executed).toBe(true);
            expect(result.systemEnabled).toBe(2); // 1 system + 1 auto-enable
        });

        it('should work when no auto-enable plugins exist', async () => {
            (lifecycleManager.enableAutoEnablePlugins as jest.Mock).mockResolvedValue([]);

            const result = await service.bootstrap();

            expect(result.executed).toBe(true);
            expect(result.systemEnabled).toBe(1); // only system plugin
        });

        it('should skip if already initialized', async () => {
            await service.bootstrap();
            const result = await service.bootstrap();

            expect(result.executed).toBe(false);
            expect(lifecycleManager.enableAutoEnablePlugins).toHaveBeenCalledTimes(1);
        });
    });
});
