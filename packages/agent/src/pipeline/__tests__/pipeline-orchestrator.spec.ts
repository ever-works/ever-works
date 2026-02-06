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
import { DefaultPipelinePlugin } from '@ever-works/default-pipeline-plugin';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { AiFacadeService } from '../../facades/ai.facade';
import { SearchFacadeService } from '../../facades/search.facade';
import { ScreenshotFacadeService } from '../../facades/screenshot.facade';
import { ContentExtractorFacadeService } from '../../facades/content-extractor.facade';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    IFullPipelinePlugin,
    IPlugin,
    PluginManifest,
    PluginCategory,
    MutableGenerationContext,
    PipelineStepDefinition,
} from '@ever-works/plugin';

describe('PipelineOrchestratorService', () => {
    let service: PipelineOrchestratorService;
    let stepExecutor: StepPipelineExecutorService;
    let fullExecutor: FullPipelineExecutorService;
    let registry: PluginRegistryService;
    let defaultPlugin: DefaultPipelinePlugin;

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

    const createMockFullPipelinePlugin = (id: string): IFullPipelinePlugin =>
        ({
            id,
            name: `Full Pipeline ${id}`,
            version: '1.0.0',
            category: 'pipeline' as PluginCategory,
            capabilities: ['full-pipeline'],
            settingsSchema: { type: 'object', properties: {} },
            onLoad: jest.fn(),
            onEnable: jest.fn(),
            onDisable: jest.fn(),
            onUnload: jest.fn(),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
            getStepDefinitions: jest.fn().mockReturnValue([]),
            createExecutionPlan: jest.fn(),
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
        }) as unknown as IFullPipelinePlugin;

    const createMockManifest = (
        id: string,
        capabilities: string[] = ['full-pipeline'],
    ): PluginManifest => ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category: 'pipeline' as PluginCategory,
        capabilities,
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PipelineOrchestratorService,
                StepPipelineExecutorService,
                FullPipelineExecutorService,
                PipelineBuilderService,
                DefaultPipelinePlugin,
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
                    provide: AiFacadeService,
                    useValue: {
                        generateText: jest.fn().mockResolvedValue(''),
                        generateStructuredOutput: jest.fn().mockResolvedValue({}),
                        isConfigured: jest.fn().mockReturnValue(true),
                    },
                },
                {
                    provide: SearchFacadeService,
                    useValue: {
                        search: jest.fn().mockResolvedValue([]),
                        extractContent: jest.fn().mockResolvedValue(null),
                        isConfigured: jest.fn().mockReturnValue(true),
                    },
                },
                {
                    provide: ScreenshotFacadeService,
                    useValue: {
                        capture: jest.fn().mockResolvedValue(null),
                        isConfigured: jest.fn().mockReturnValue(true),
                    },
                },
                {
                    provide: ContentExtractorFacadeService,
                    useValue: {
                        extractContent: jest.fn().mockResolvedValue(null),
                        canHandle: jest.fn().mockReturnValue(false),
                        isConfigured: jest.fn().mockReturnValue(true),
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
        defaultPlugin = module.get<DefaultPipelinePlugin>(DefaultPipelinePlugin);

        // Register the default pipeline plugin in the registry so getDefaultPipelinePlugin() can find it
        // Note: We intentionally do NOT include 'pipeline-step' capability because the DefaultPipelinePlugin
        // provides the built-in steps (via static getBuiltInSteps()), not by implementing getStepDefinition().
        registry.register(defaultPlugin, {
            id: 'default-pipeline',
            name: 'Default Pipeline',
            version: '1.0.0',
            description: 'Default pipeline plugin for tests',
            category: 'pipeline',
            capabilities: ['default-pipeline'],
        });
        registry.updateState('default-pipeline', 'enabled');

        // Register mock executors for built-in steps
        for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
            defaultPlugin.registerStepExecutor(step.id as any, {
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

        it('should use full executor when full pipeline plugin is enabled', async () => {
            const plugin = createMockFullPipelinePlugin('full-pipeline-plugin');
            registry.register(
                plugin as unknown as IPlugin,
                createMockManifest('full-pipeline-plugin'),
                {
                    state: 'enabled',
                },
            );

            const fullExecuteSpy = jest.spyOn(fullExecutor, 'execute');

            await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(fullExecuteSpy).toHaveBeenCalledWith(
                plugin,
                mockDirectory,
                mockRequest,
                mockExisting,
                undefined,
                undefined,
            );
        });

        it('should not use disabled full pipeline plugin', async () => {
            const plugin = createMockFullPipelinePlugin('disabled-plugin');
            registry.register(plugin as unknown as IPlugin, createMockManifest('disabled-plugin'), {
                state: 'loaded', // Not enabled
            });

            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');

            await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
        });

        it('should pass options to selected executor', async () => {
            const executeSpy = jest.spyOn(stepExecutor, 'execute');
            const options = { timeout: 5000, continueOnError: true };

            await service.execute(mockDirectory, mockRequest, mockExisting, options);

            expect(executeSpy).toHaveBeenCalledWith(
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
                state: 'enabled',
            });

            const stepExecuteSpy = jest.spyOn(stepExecutor, 'execute');

            await service.executeWithMode('step', mockDirectory, mockRequest, mockExisting);

            expect(stepExecuteSpy).toHaveBeenCalled();
        });

        it('should use full mode when specified and plugin available', async () => {
            const plugin = createMockFullPipelinePlugin('full-plugin');
            registry.register(plugin as unknown as IPlugin, createMockManifest('full-plugin'), {
                state: 'enabled',
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
                state: 'enabled',
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
                state: 'enabled',
            });

            expect(await service.hasFullPipelinePlugin()).toBe(true);
        });
    });

    describe('getAvailableFullPipelinePlugins()', () => {
        it('should return empty array when no plugins', () => {
            const plugins = service.getAvailableFullPipelinePlugins();

            expect(plugins).toEqual([]);
        });

        it('should return enabled full pipeline plugins', () => {
            const plugin1 = createMockFullPipelinePlugin('full-plugin-1');
            const plugin2 = createMockFullPipelinePlugin('full-plugin-2');

            registry.register(plugin1 as unknown as IPlugin, createMockManifest('full-plugin-1'), {
                state: 'enabled',
            });
            registry.register(plugin2 as unknown as IPlugin, createMockManifest('full-plugin-2'), {
                state: 'enabled',
            });

            const plugins = service.getAvailableFullPipelinePlugins();

            expect(plugins).toHaveLength(2);
        });
    });

    describe('resumeFromCheckpoint()', () => {
        it('should delegate to step executor', async () => {
            const resumeSpy = jest.spyOn(stepExecutor, 'resumeFromCheckpoint');
            resumeSpy.mockResolvedValue(null);

            await service.resumeFromCheckpoint('dir-123');

            expect(resumeSpy).toHaveBeenCalledWith('dir-123', undefined, undefined);
        });
    });

    describe('clearCheckpoint()', () => {
        it('should delegate to step executor', async () => {
            const clearSpy = jest.spyOn(stepExecutor, 'clearCheckpoint');
            clearSpy.mockResolvedValue(undefined);

            await service.clearCheckpoint('dir-123');

            expect(clearSpy).toHaveBeenCalledWith('dir-123');
        });
    });
});
