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
        it('should call callOnLoad for each loaded plugin', async () => {
            await service.bootstrap();

            expect(lifecycleManager.callOnLoad).toHaveBeenCalledTimes(3);
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledWith('system-plugin');
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledWith('auto-plugin');
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledWith('manual-plugin');
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
            expect(lifecycleManager.callOnLoad).toHaveBeenCalledTimes(3);
        });

        it('should set context factory on lifecycle manager', async () => {
            await service.bootstrap();

            expect(lifecycleManager.setContextFactory).toHaveBeenCalledTimes(1);
        });
    });
});
