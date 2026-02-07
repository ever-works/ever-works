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
                        enableAll: jest.fn().mockResolvedValue([
                            { success: true, pluginId: 'system-plugin' },
                            { success: true, pluginId: 'auto-plugin' },
                            { success: true, pluginId: 'manual-plugin' },
                        ]),
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
        it('should call enableAll after loading plugins', async () => {
            await service.bootstrap();

            expect(lifecycleManager.enableAll).toHaveBeenCalledTimes(1);
        });

        it('should include enabled count in systemEnabled result', async () => {
            const result = await service.bootstrap();

            expect(result.executed).toBe(true);
            expect(result.systemEnabled).toBe(3);
        });

        it('should handle partial enable failures', async () => {
            (lifecycleManager.enableAll as jest.Mock).mockResolvedValue([
                { success: true, pluginId: 'system-plugin' },
                { success: false, pluginId: 'broken-plugin', error: 'some error' },
            ]);

            const result = await service.bootstrap();

            expect(result.executed).toBe(true);
            expect(result.systemEnabled).toBe(1);
        });

        it('should skip if already initialized', async () => {
            await service.bootstrap();
            const result = await service.bootstrap();

            expect(result.executed).toBe(false);
            expect(lifecycleManager.enableAll).toHaveBeenCalledTimes(1);
        });
    });
});
