import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
    PipelineOrchestratorService,
    PipelineExecutionMode,
} from '../pipeline-orchestrator.service';
import { StepPipelineExecutorService } from '../step-pipeline-executor.service';
import { FullPipelineExecutorService } from '../full-pipeline-executor.service';
import { PipelineBuilderService } from '../pipeline-builder.service';
import { MockPipelinePlugin, createLinearChain } from './mock-pipeline-plugin';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PipelineFacadeService } from '../pipeline-facade.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    IPipelinePlugin,
    IPlugin,
    PluginManifest,
    PluginCategory,
    MutableGenerationContext,
    PipelineStepDefinition,
} from '@ever-works/plugin';

/** Simple 3-step linear chain for orchestrator tests */
const ORCHESTRATOR_STEPS = createLinearChain(['step-init', 'step-process', 'step-finalize']);

describe('PipelineOrchestratorService', () => {
    let service: PipelineOrchestratorService;
    let stepExecutor: StepPipelineExecutorService;
    let fullExecutor: FullPipelineExecutorService;
    let registry: PluginRegistryService;
    let standardPlugin: MockPipelinePlugin;

    const mockDirectory: DirectoryReference = {
        id: 'dir-123',
        name: 'Test Directory',
        slug: 'test-directory',
        user: { id: 'user-123' },
    };

    const mockRequest: GenerationRequest = {
        prompt: 'Generate test items',
        config: {},
    };

    const mockExisting: ExistingItems = {
        items: [],
        categories: [],
        tags: [],
    };

    const createMockFullPipelinePlugin = (id: string): IPipelinePlugin =>
        ({
            id,
            name: `Full Pipeline ${id}`,
            version: '1.0.0',
            category: 'pipeline' as PluginCategory,
            capabilities: ['pipeline'],
            settingsSchema: { type: 'object', properties: {} },
            onLoad: jest.fn(),
            onUnload: jest.fn(),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
            getStepDefinitions: jest.fn().mockReturnValue([]),
            execute: jest.fn().mockResolvedValue({
                success: true,
                items: [],
                categories: [],
                tags: [],
                brands: [],
                duration: 1000,
                stepsCompleted: 5,
                totalSteps: 5,
                state: {
                    steps: new Map(),
                    completedSteps: [],
                    failedSteps: [],
                    isRunning: false,
                    isCancelled: false,
                },
            }),
        }) as unknown as IPipelinePlugin;

    const createMockManifest = (
        id: string,
        capabilities: string[] = ['pipeline'],
    ): PluginManifest => ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category: 'pipeline' as PluginCategory,
        capabilities,
        autoEnable: true,
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PipelineOrchestratorService,
                StepPipelineExecutorService,
                FullPipelineExecutorService,
                PipelineBuilderService,
                MockPipelinePlugin,
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
                    provide: CACHE_MANAGER,
                    useValue: {
                        get: jest.fn(),
                        set: jest.fn(),
                        del: jest.fn(),
                    },
                },
                {
                    provide: PipelineFacadeService,
                    useValue: {
                        createStepExecutionContext: jest.fn().mockReturnValue({
                            aiFacade: {},
                            searchFacade: {},
                            screenshotFacade: {},
                            contentExtractorFacade: {},
                            dataSourceFacade: undefined,
                            logger: {
                                log: jest.fn(),
                                debug: jest.fn(),
                                warn: jest.fn(),
                                error: jest.fn(),
                            },
                            directory: {
                                id: 'dir-123',
                                name: 'Test',
                                slug: 'test',
                                user: { id: 'user-123' },
                            },
                            user: { id: 'user-123' },
                        }),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: {
                        getSettings: jest.fn().mockResolvedValue({}),
                    },
                },
            ],
        }).compile();

        service = module.get<PipelineOrchestratorService>(PipelineOrchestratorService);
        stepExecutor = module.get<StepPipelineExecutorService>(StepPipelineExecutorService);
        fullExecutor = module.get<FullPipelineExecutorService>(FullPipelineExecutorService);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
        standardPlugin = module.get<MockPipelinePlugin>(MockPipelinePlugin);

        // Configure the mock pipeline with our 3-step chain
        standardPlugin.setSteps(ORCHESTRATOR_STEPS);

        // Register the standard pipeline plugin in the registry
        registry.register(standardPlugin, {
            id: 'standard-pipeline',
            name: 'Standard Pipeline',
            version: '1.0.0',
            description: 'Standard pipeline plugin for tests',
            category: 'pipeline',
            capabilities: ['pipeline'],
            defaultForCapabilities: ['pipeline'],
        });
        registry.updateState('standard-pipeline', 'loaded');

        // Register mock executors for built-in steps
        for (const step of standardPlugin.getStepDefinitions()) {
            standardPlugin.registerStepExecutor(step.id, {
                name: step.name,
                run: jest.fn().mockImplementation((ctx: MutableGenerationContext) => {
                    ctx.shouldStop = true;
                    return Promise.resolve(ctx);
                }),
            });
        }
    });

    afterEach(() => {
        registry.clear();
        jest.clearAllMocks();
    });

    describe('execute()', () => {
        it('should use step executor when no full pipeline plugin', async () => {
            const executeSpy = jest.spyOn(stepExecutor, 'execute');

            await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(executeSpy).toHaveBeenCalled();
        });

        it('should use full executor when explicit full pipeline is specified', async () => {
            const plugin = createMockFullPipelinePlugin('full-pipeline-plugin');
            registry.register(
                plugin as unknown as IPlugin,
                createMockManifest('full-pipeline-plugin'),
                {
                    state: 'loaded',
                },
            );

            const fullExecuteSpy = jest.spyOn(fullExecutor, 'execute');

            const requestWithPipeline: GenerationRequest = {
                ...mockRequest,
                providers: { pipeline: 'full-pipeline-plugin' },
            };

            await service.execute(mockDirectory, requestWithPipeline, mockExisting);

            expect(fullExecuteSpy).toHaveBeenCalledWith(
                plugin,
                mockDirectory,
                requestWithPipeline,
                mockExisting,
                undefined,
                undefined,
            );
        });

        it('should not use disabled full pipeline plugin', async () => {
            const plugin = createMockFullPipelinePlugin('disabled-plugin');
            registry.register(plugin as unknown as IPlugin, createMockManifest('disabled-plugin'), {
                state: 'unloaded', // Not loaded
            });

            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');

            await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
        });

        it('should use step executor when providers.pipeline is null (explicit standard)', async () => {
            const plugin = createMockFullPipelinePlugin('full-pipeline-plugin');
            registry.register(
                plugin as unknown as IPlugin,
                createMockManifest('full-pipeline-plugin'),
                {
                    state: 'loaded',
                },
            );

            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');
            const fullExecuteSpy = jest.spyOn(fullExecutor, 'execute');

            const requestWithNullPipeline: GenerationRequest = {
                ...mockRequest,
                providers: { pipeline: null },
            };

            await service.execute(mockDirectory, requestWithNullPipeline, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
            expect(fullExecuteSpy).not.toHaveBeenCalled();
        });

        it('should use explicit pipeline plugin when providers.pipeline is a plugin ID', async () => {
            const plugin = createMockFullPipelinePlugin('my-custom-pipeline');
            registry.register(
                plugin as unknown as IPlugin,
                createMockManifest('my-custom-pipeline'),
                {
                    state: 'loaded',
                },
            );

            const fullExecuteSpy = jest.spyOn(fullExecutor, 'execute');

            const requestWithPipelineId: GenerationRequest = {
                ...mockRequest,
                providers: { pipeline: 'my-custom-pipeline' },
            };

            await service.execute(mockDirectory, requestWithPipelineId, mockExisting);

            expect(fullExecuteSpy).toHaveBeenCalledWith(
                plugin,
                mockDirectory,
                requestWithPipelineId,
                mockExisting,
                undefined,
                undefined,
            );
        });

        it('should fall back to step mode when providers.pipeline references unknown plugin', async () => {
            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');

            const requestWithBadId: GenerationRequest = {
                ...mockRequest,
                providers: { pipeline: 'non-existent-plugin' },
            };

            await service.execute(mockDirectory, requestWithBadId, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
        });

        it('should fall back to step mode when providers.pipeline references disabled plugin', async () => {
            const plugin = createMockFullPipelinePlugin('disabled-pipeline');
            registry.register(
                plugin as unknown as IPlugin,
                createMockManifest('disabled-pipeline'),
                {
                    state: 'unloaded', // Not loaded
                },
            );

            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');

            const requestWithDisabledId: GenerationRequest = {
                ...mockRequest,
                providers: { pipeline: 'disabled-pipeline' },
            };

            await service.execute(mockDirectory, requestWithDisabledId, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
        });

        it('should prefer defaultForCapabilities pipeline when auto-detecting', async () => {
            const plugin = createMockFullPipelinePlugin('other-pipeline');
            registry.register(plugin as unknown as IPlugin, createMockManifest('other-pipeline'), {
                state: 'loaded',
            });

            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');

            // No providers at all → auto-detect → standard-pipeline wins via defaultForCapabilities
            await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
            // Verify it resolved to standard-pipeline (step-orchestratable), not other-pipeline
            expect(stepExecuteSpy).toHaveBeenCalledWith(
                standardPlugin,
                mockDirectory,
                mockRequest,
                mockExisting,
                undefined,
                undefined,
            );
        });

        it('should throw when no pipeline plugin is available', async () => {
            registry.clear();

            await expect(service.execute(mockDirectory, mockRequest, mockExisting)).rejects.toThrow(
                'No pipeline plugin available',
            );
        });

        it('should pass options to selected executor', async () => {
            const executeSpy = jest.spyOn(stepExecutor, 'execute');
            const options = { timeout: 5000, continueOnError: true };

            await service.execute(mockDirectory, mockRequest, mockExisting, options);

            expect(executeSpy).toHaveBeenCalledWith(
                expect.anything(),
                mockDirectory,
                mockRequest,
                mockExisting,
                options,
                undefined,
            );
        });
    });

    describe('executeWithMode()', () => {
        it('should use step mode when specified', async () => {
            const plugin = createMockFullPipelinePlugin('full-plugin');
            registry.register(plugin as unknown as IPlugin, createMockManifest('full-plugin'), {
                state: 'loaded',
            });

            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');

            await service.executeWithMode('step', mockDirectory, mockRequest, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
        });

        it('should use full mode when specified and plugin available', async () => {
            const plugin = createMockFullPipelinePlugin('full-plugin');
            registry.register(plugin as unknown as IPlugin, createMockManifest('full-plugin'), {
                state: 'loaded',
            });

            const fullExecuteSpy = jest.spyOn(fullExecutor, 'execute');

            await service.executeWithMode('full', mockDirectory, mockRequest, mockExisting);

            expect(fullExecuteSpy).toHaveBeenCalled();
        });

        it('should fall back to step mode when full mode requested but no plugin', async () => {
            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');

            await service.executeWithMode('full', mockDirectory, mockRequest, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
        });
    });

    describe('getRecommendedMode()', () => {
        it('should recommend step mode when no full pipeline plugin', async () => {
            const recommendation = await service.getRecommendedMode();

            expect(recommendation.mode).toBe('step');
            expect(recommendation.plugin).toBeUndefined();
        });

        it('should recommend full mode when full pipeline plugin enabled', async () => {
            const plugin = createMockFullPipelinePlugin('full-plugin');
            registry.register(plugin as unknown as IPlugin, createMockManifest('full-plugin'), {
                state: 'loaded',
            });

            const recommendation = await service.getRecommendedMode();

            expect(recommendation.mode).toBe('full');
            expect(recommendation.plugin).toBe('full-plugin');
        });
    });

    describe('hasFullPipelinePlugin()', () => {
        it('should return false when no full pipeline plugin', async () => {
            expect(await service.hasFullPipelinePlugin()).toBe(false);
        });

        it('should return true when full pipeline plugin enabled', async () => {
            const plugin = createMockFullPipelinePlugin('full-plugin');
            registry.register(plugin as unknown as IPlugin, createMockManifest('full-plugin'), {
                state: 'loaded',
            });

            expect(await service.hasFullPipelinePlugin()).toBe(true);
        });
    });

    describe('getAvailablePipelinePlugins()', () => {
        it('should return standard-pipeline when no other plugins', () => {
            const plugins = service.getAvailablePipelinePlugins();

            expect(plugins).toHaveLength(1);
            expect(plugins[0].id).toBe('standard-pipeline');
        });

        it('should return all enabled pipeline plugins including standard', () => {
            const plugin1 = createMockFullPipelinePlugin('full-plugin-1');
            const plugin2 = createMockFullPipelinePlugin('full-plugin-2');

            registry.register(plugin1 as unknown as IPlugin, createMockManifest('full-plugin-1'), {
                state: 'loaded',
            });
            registry.register(plugin2 as unknown as IPlugin, createMockManifest('full-plugin-2'), {
                state: 'loaded',
            });

            const plugins = service.getAvailablePipelinePlugins();

            expect(plugins).toHaveLength(3);
        });
    });

    describe('resumeFromCheckpoint()', () => {
        it('should delegate to step executor with pipelineId', async () => {
            const resumeSpy = jest.spyOn(stepExecutor, 'resumeFromCheckpoint');
            resumeSpy.mockResolvedValue(null);

            await service.resumeFromCheckpoint('dir-123', 'standard-pipeline');

            expect(resumeSpy).toHaveBeenCalledWith(
                expect.anything(),
                'dir-123',
                'standard-pipeline',
                undefined,
                undefined,
            );
        });
    });

    describe('clearCheckpoint()', () => {
        it('should delegate to step executor with pipelineId', async () => {
            const clearSpy = jest.spyOn(stepExecutor, 'clearCheckpoint');
            clearSpy.mockResolvedValue(undefined);

            await service.clearCheckpoint('dir-123', 'standard-pipeline');

            expect(clearSpy).toHaveBeenCalledWith('dir-123', 'standard-pipeline');
        });
    });

    describe('resumeOrExecute()', () => {
        it('should try resume for step-orchestratable pipeline and fall back to fresh execution', async () => {
            const resumeSpy = jest.spyOn(stepExecutor, 'resumeFromCheckpoint');
            resumeSpy.mockResolvedValue(null); // No checkpoint found

            const executeSpy = jest.spyOn(stepExecutor, 'execute');

            await service.resumeOrExecute(mockDirectory, mockRequest, mockExisting);

            // Should have tried to resume first
            expect(resumeSpy).toHaveBeenCalledWith(
                standardPlugin,
                mockDirectory.id,
                standardPlugin.id,
                undefined,
                undefined,
            );

            // Should have fallen back to fresh execution
            expect(executeSpy).toHaveBeenCalled();
        });

        it('should return resumed result when checkpoint exists', async () => {
            const mockResult = {
                success: true,
                items: [],
                categories: [],
                tags: [],
                brands: [],
                duration: 500,
                stepsCompleted: 3,
                totalSteps: 3,
                state: {
                    steps: new Map(),
                    completedSteps: ['step-init', 'step-process', 'step-finalize'],
                    failedSteps: [],
                    isRunning: false,
                    isCancelled: false,
                },
            };

            const resumeSpy = jest.spyOn(stepExecutor, 'resumeFromCheckpoint');
            resumeSpy.mockResolvedValue(mockResult as any);

            const executeSpy = jest.spyOn(stepExecutor, 'execute');

            const result = await service.resumeOrExecute(mockDirectory, mockRequest, mockExisting);

            expect(result.success).toBe(true);
            // Should NOT have called fresh execute
            expect(executeSpy).not.toHaveBeenCalled();
        });

        it('should skip resume for non-step-orchestratable pipelines', async () => {
            const fullPlugin = createMockFullPipelinePlugin('full-pipeline-plugin');
            registry.register(
                fullPlugin as unknown as IPlugin,
                createMockManifest('full-pipeline-plugin'),
                { state: 'loaded' },
            );

            const resumeSpy = jest.spyOn(stepExecutor, 'resumeFromCheckpoint');
            const fullExecuteSpy = jest.spyOn(fullExecutor, 'execute');

            const requestWithPipeline: GenerationRequest = {
                ...mockRequest,
                providers: { pipeline: 'full-pipeline-plugin' },
            };

            await service.resumeOrExecute(mockDirectory, requestWithPipeline, mockExisting);

            // Should NOT have tried to resume (full pipeline is not step-orchestratable)
            expect(resumeSpy).not.toHaveBeenCalled();
            // Should have gone straight to execute
            expect(fullExecuteSpy).toHaveBeenCalled();
        });
    });
});
