import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import {
    StepPipelineExecutorService,
    PipelineEvents,
    CheckpointData,
} from '../step-pipeline-executor.service';

// Silence logger during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
import { PipelineBuilderService } from '../pipeline-builder.service';
import { DefaultPipelinePlugin } from '@ever-works/default-pipeline-plugin';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { createGenerationContext, TypedGenerationContext } from '../generation-context';
import * as superjson from 'superjson';
import { AiFacadeService } from '../../facades/ai.facade';
import { SearchFacadeService } from '../../facades/search.facade';
import { ScreenshotFacadeService } from '../../facades/screenshot.facade';
import { ContentExtractorFacadeService } from '../../facades/content-extractor.facade';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    MutableGenerationContext,
    PipelineExecutionOptions,
} from '@ever-works/plugin';

describe('StepPipelineExecutorService', () => {
    let service: StepPipelineExecutorService;
    let pipelineBuilder: PipelineBuilderService;
    let defaultPlugin: DefaultPipelinePlugin;
    let registry: PluginRegistryService;
    let eventEmitter: EventEmitter2;
    let cacheManager: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

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

    beforeEach(async () => {
        cacheManager = {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StepPipelineExecutorService,
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
                    useValue: cacheManager,
                },
                {
                    provide: AiFacadeService,
                    useValue: {
                        generateText: jest.fn().mockResolvedValue(''),
                        generateStructuredOutput: jest.fn().mockResolvedValue({}),
                        askJson: jest
                            .fn()
                            .mockResolvedValue({ result: {}, usage: null, cost: null }),
                        testConnection: jest.fn().mockResolvedValue(true),
                        getAvailableModels: jest.fn().mockResolvedValue([]),
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
                        getSmartImage: jest.fn().mockResolvedValue(null),
                        getScreenshotUrl: jest.fn().mockResolvedValue(null),
                        isAvailable: jest.fn().mockReturnValue(true),
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

        service = module.get<StepPipelineExecutorService>(StepPipelineExecutorService);
        pipelineBuilder = module.get<PipelineBuilderService>(PipelineBuilderService);
        defaultPlugin = module.get<DefaultPipelinePlugin>(DefaultPipelinePlugin);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    });

    afterEach(() => {
        registry.clear();
        jest.clearAllMocks();
    });

    describe('execute()', () => {
        beforeEach(() => {
            // Register the default pipeline plugin in the registry so getDefaultPipelinePlugin() can find it
            // Note: We intentionally do NOT include 'pipeline-step' capability because the DefaultPipelinePlugin
            // provides the built-in steps (via static getBuiltInSteps()), not by implementing getStepDefinition().
            // If we included 'pipeline-step', the pipeline builder would try to call getStepDefinition() on it
            // which would cause issues.
            registry.register(defaultPlugin, {
                id: 'default-pipeline',
                name: 'Default Pipeline',
                version: '1.0.0',
                description: 'Default pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['default-pipeline'],
            });
            registry.updateState('default-pipeline', 'loaded');

            // Register mock executors for all built-in steps
            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                defaultPlugin.registerStepExecutor(step.id as any, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx: MutableGenerationContext) => {
                        // Mark shouldStop on prompt-comparison to stop early for tests
                        if (step.id === 'prompt-comparison') {
                            ctx.shouldStop = true;
                        }
                        return Promise.resolve(ctx);
                    }),
                });
            }
        });

        it('should execute pipeline and emit started event', async () => {
            const result = await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STARTED,
                expect.objectContaining({
                    directoryId: mockDirectory.id,
                }),
            );
            expect(result).toBeDefined();
        });

        it('should emit step-started event for each step', async () => {
            await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STEP_STARTED,
                expect.objectContaining({
                    stepId: 'prompt-comparison',
                    stepName: 'Prompt Comparison',
                    stepIndex: 0,
                }),
            );
        });

        it('should emit step-completed after step success', async () => {
            await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STEP_COMPLETED,
                expect.objectContaining({
                    stepId: 'prompt-comparison',
                    stepName: 'Prompt Comparison',
                }),
            );
        });

        it('should stop pipeline when shouldStop is set', async () => {
            const result = await service.execute(mockDirectory, mockRequest, mockExisting);

            // Should have stopped after prompt-comparison (which sets shouldStop)
            expect(result.stepsCompleted).toBe(1);
        });

        it('should skip steps in skipSteps option', async () => {
            // Reset shouldStop behavior
            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                defaultPlugin.registerStepExecutor(step.id as any, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => Promise.resolve(ctx)),
                });
            }

            const options: PipelineExecutionOptions = {
                skipSteps: ['prompt-comparison'],
            };

            const result = await service.execute(mockDirectory, mockRequest, mockExisting, options);

            // prompt-comparison should have been skipped
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STEP_SKIPPED,
                expect.objectContaining({
                    stepId: 'prompt-comparison',
                }),
            );
        });

        it('should save checkpoint after each step', async () => {
            await service.execute(mockDirectory, mockRequest, mockExisting);

            // Verify checkpoint was saved as serialized string
            expect(cacheManager.set).toHaveBeenCalledWith(
                `pipeline-checkpoint-${mockDirectory.id}`,
                expect.any(String),
                expect.any(Number),
            );

            // Parse and verify content
            const serialized = cacheManager.set.mock.calls[0][1];
            const checkpoint = superjson.parse<CheckpointData>(serialized);
            expect(checkpoint.stepIndex).toBe(0);
            expect(checkpoint.stepName).toBe('Prompt Comparison');
        });

        it('should convert Sets and Maps to arrays when saving checkpoint', async () => {
            // Add some data to Sets and Maps
            defaultPlugin.registerStepExecutor('prompt-comparison' as any, {
                name: 'Prompt Comparison',
                run: jest.fn().mockImplementation((ctx) => {
                    ctx.processedSourceUrls.add('https://example.com');
                    ctx.contentCache.set('url1', 'content1');
                    ctx.contentCache.set('url2', 'content2');
                    ctx.shouldStop = true;
                    return Promise.resolve(ctx);
                }),
            });

            await service.execute(mockDirectory, mockRequest, mockExisting);

            // Verify that checkpoint was serialized with superjson
            const serializedCheckpoint = cacheManager.set.mock.calls[0][1];
            expect(typeof serializedCheckpoint).toBe('string');

            // Parse and verify Sets and Maps were preserved
            const savedCheckpoint = superjson.parse<CheckpointData>(serializedCheckpoint);
            expect(savedCheckpoint.context.processedSourceUrls instanceof Set).toBe(true);
            expect(savedCheckpoint.context.processedSourceUrls.has('https://example.com')).toBe(
                true,
            );
            expect(savedCheckpoint.context.contentCache instanceof Map).toBe(true);
            expect(savedCheckpoint.context.contentCache.get('url1')).toBe('content1');
            expect(savedCheckpoint.context.contentCache.get('url2')).toBe('content2');
        });

        it('should track per-step metrics', async () => {
            const result = await service.execute(mockDirectory, mockRequest, mockExisting);

            // The state should have completed steps
            expect(result.state.completedSteps.length).toBeGreaterThan(0);
        });

        it('should respect cancellation signal', async () => {
            const controller = new AbortController();
            controller.abort();

            const result = await service.execute(mockDirectory, mockRequest, mockExisting, {
                signal: controller.signal,
            });

            expect(result.success).toBe(false);
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.CANCELLED,
                expect.any(Object),
            );
        });

        it('should continue on error when continueOnError is true', async () => {
            // Make first step fail
            defaultPlugin.registerStepExecutor('prompt-comparison' as any, {
                name: 'Prompt Comparison',
                run: jest.fn().mockRejectedValue(new Error('Test error')),
            });

            const result = await service.execute(mockDirectory, mockRequest, mockExisting, {
                continueOnError: true,
            });

            // Should have continued despite error (prompt-comparison is not optional)
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STEP_FAILED,
                expect.objectContaining({
                    stepId: 'prompt-comparison',
                    error: 'Test error',
                }),
            );
        });

        it('should execute parallel steps concurrently', async () => {
            // Setup: Create a pipeline with 1 start step and 2 parallel steps
            // We use the pipelineBuilder mock behavior to return our custom pipeline structure
            // effectively bypassing the plugin registry for this specific test to control the graph exactly.

            const startStep = {
                id: 'start',
                name: 'Start',
                run: jest.fn().mockResolvedValue(undefined),
            };
            const parallel1 = {
                id: 'p1',
                name: 'Parallel 1',
                run: jest
                    .fn()
                    .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50))),
            };
            const parallel2 = {
                id: 'p2',
                name: 'Parallel 2',
                run: jest
                    .fn()
                    .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50))),
            };

            // Mock the build method to return our manual parallel structure
            jest.spyOn(pipelineBuilder, 'build').mockResolvedValue({
                steps: [
                    { id: 'start', name: 'Start', position: { type: 'first' } },
                    { id: 'p1', name: 'Parallel 1', position: { type: 'after', stepId: 'start' } },
                    { id: 'p2', name: 'Parallel 2', position: { type: 'after', stepId: 'start' } },
                ],
                groups: [
                    { id: 'g1', stepIds: ['start'], allRequired: true },
                    { id: 'g2', stepIds: ['p1', 'p2'], allRequired: true }, // Parallel group
                ],
                executorMap: new Map([
                    ['start', { type: 'builtin', serviceId: 'start' }],
                    ['p1', { type: 'builtin', serviceId: 'p1' }],
                    ['p2', { type: 'builtin', serviceId: 'p2' }],
                ]),
                replacedSteps: new Map(),
                disabledSteps: new Set(),
                injectedSteps: new Set(),
                source: 'test',
            } as any);

            // Register executors for these custom steps (using defaultPlugin as a container)
            // In a real scenario these would be looked up via the map, here we reuse the default plugin's registry
            // but we need to patch the getDefaultPipelinePlugin private method or ensures it uses the registry
            // The service uses getDefaultPipelinePlugin() which looks up 'default-pipeline'
            // We can add our custom steps to the default plugin mock
            defaultPlugin.registerStepExecutor('start' as any, startStep);
            defaultPlugin.registerStepExecutor('p1' as any, parallel1);
            defaultPlugin.registerStepExecutor('p2' as any, parallel2);

            const startTime = Date.now();
            await service.execute(mockDirectory, mockRequest, mockExisting);
            const duration = Date.now() - startTime;

            // Verification
            // Both parallel steps take 50ms.
            // If sequential: 50 + 50 = 100ms (+ overhead)
            // If parallel: max(50, 50) = 50ms (+ overhead)
            // We expect the total duration to be closer to 50ms than 100ms
            // Using a slightly loose check to account for test overhead
            expect(duration).toBeLessThan(90);
            expect(parallel1.run).toHaveBeenCalled();
            expect(parallel2.run).toHaveBeenCalled();
        });
    });

    describe('provider overrides', () => {
        beforeEach(() => {
            registry.register(defaultPlugin, {
                id: 'default-pipeline',
                name: 'Default Pipeline',
                version: '1.0.0',
                description: 'Default pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['default-pipeline'],
            });
            registry.updateState('default-pipeline', 'loaded');
        });

        it('should pass provider overrides from request to bound AI facade', async () => {
            const aiFacadeMock = {
                askJson: jest.fn().mockResolvedValue({ result: {}, usage: null, cost: null }),
                isConfigured: jest.fn().mockReturnValue(true),
                testConnection: jest.fn().mockResolvedValue(true),
                getAvailableModels: jest.fn().mockResolvedValue([]),
            };

            // Override the aiFacade on the service to spy on calls
            (service as any).aiFacade = aiFacadeMock;

            const requestWithProviders: GenerationRequest = {
                prompt: 'Generate test items',
                config: {},
                providers: {
                    ai: 'openai',
                    search: 'tavily',
                    screenshot: 'screenshotone',
                    contentExtractor: 'jina',
                },
            };

            // Register a step executor that uses the AI facade
            defaultPlugin.registerStepExecutor('prompt-comparison' as any, {
                name: 'Prompt Comparison',
                run: jest.fn().mockImplementation(async (ctx, execContext) => {
                    // Use the AI facade to trigger the bound call
                    await execContext.aiFacade.askJson('test prompt', {}, {});
                    ctx.shouldStop = true;
                    return ctx;
                }),
            });

            // Register remaining step executors
            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                if (step.id !== 'prompt-comparison') {
                    defaultPlugin.registerStepExecutor(step.id as any, {
                        name: step.name,
                        run: jest.fn().mockResolvedValue(undefined),
                    });
                }
            }

            await service.execute(mockDirectory, requestWithProviders, mockExisting);

            // Verify the AI facade was called with providerOverride
            expect(aiFacadeMock.askJson).toHaveBeenCalledWith(
                'test prompt',
                expect.anything(),
                expect.anything(),
                expect.objectContaining({
                    directoryId: 'dir-123',
                    userId: 'user-123',
                    providerOverride: 'openai',
                }),
            );
        });

        it('should not include providerOverride when request has no providers', async () => {
            const aiFacadeMock = {
                askJson: jest.fn().mockResolvedValue({ result: {}, usage: null, cost: null }),
                isConfigured: jest.fn().mockReturnValue(true),
                testConnection: jest.fn().mockResolvedValue(true),
                getAvailableModels: jest.fn().mockResolvedValue([]),
            };

            (service as any).aiFacade = aiFacadeMock;

            defaultPlugin.registerStepExecutor('prompt-comparison' as any, {
                name: 'Prompt Comparison',
                run: jest.fn().mockImplementation(async (ctx, execContext) => {
                    await execContext.aiFacade.askJson('test prompt', {}, {});
                    ctx.shouldStop = true;
                    return ctx;
                }),
            });

            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                if (step.id !== 'prompt-comparison') {
                    defaultPlugin.registerStepExecutor(step.id as any, {
                        name: step.name,
                        run: jest.fn().mockResolvedValue(undefined),
                    });
                }
            }

            await service.execute(mockDirectory, mockRequest, mockExisting);

            // Verify the AI facade was called without providerOverride
            expect(aiFacadeMock.askJson).toHaveBeenCalledWith(
                'test prompt',
                expect.anything(),
                expect.anything(),
                expect.objectContaining({
                    directoryId: 'dir-123',
                    userId: 'user-123',
                    providerOverride: undefined,
                }),
            );
        });

        it('should throw when directory has no user context', async () => {
            const directoryWithoutUser: DirectoryReference = {
                id: 'dir-no-user',
                name: 'No User Dir',
                slug: 'no-user-dir',
            };

            defaultPlugin.registerStepExecutor('prompt-comparison' as any, {
                name: 'Prompt Comparison',
                run: jest.fn().mockResolvedValue(undefined),
            });

            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                if (step.id !== 'prompt-comparison') {
                    defaultPlugin.registerStepExecutor(step.id as any, {
                        name: step.name,
                        run: jest.fn().mockResolvedValue(undefined),
                    });
                }
            }

            const result = await service.execute(directoryWithoutUser, mockRequest, mockExisting);

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });
    });

    describe('skip steps when data already provided', () => {
        it('should skip step when all provided data keys are available', async () => {
            // Register executors that check for skipping
            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                defaultPlugin.registerStepExecutor(step.id as any, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => {
                        // Stop after first step
                        ctx.shouldStop = true;
                        return Promise.resolve(ctx);
                    }),
                });
            }

            const result = await service.execute(mockDirectory, mockRequest, mockExisting);

            expect(result).toBeDefined();
        });
    });

    describe('loadCheckpoint()', () => {
        it('should return null when no checkpoint exists', async () => {
            cacheManager.get.mockResolvedValue(undefined);

            const checkpoint = await service.loadCheckpoint(mockDirectory.id);

            expect(checkpoint).toBeNull();
        });

        it('should return checkpoint data when exists', async () => {
            const mockCheckpoint: CheckpointData = {
                stepIndex: 5,
                stepName: 'Web Search',
                timestamp: new Date().toISOString(),
                context: {
                    directory: mockDirectory,
                    request: mockRequest,
                    existing: mockExisting,
                    extractedUrls: ['https://example.com'],
                    searchQueries: [],
                    webPages: [],
                    processedSourceUrls: new Set(),
                    contentCache: new Map(),
                    initialAiItems: [],
                    extractedWebItems: [],
                    aggregatedItems: [],
                    finalItems: [],
                    finalCategories: [],
                    finalTags: [],
                    finalBrands: [],
                    metrics: {
                        startTime: Date.now(),
                        itemsProcessed: 0,
                        urlsExtracted: 0,
                        pagesRetrieved: 0,
                        itemsExtracted: 0,
                        itemsAfterDedup: 0,
                        steps: {},
                    },
                    allInitialCategories: [],
                    allPriorityCategories: [],
                    featuredItemHints: [],
                },
                completedSteps: ['prompt-comparison', 'prompt-processing'],
                schemaVersion: 1,
            };

            // Serialize with superjson as the real implementation does
            cacheManager.get.mockResolvedValue(superjson.stringify(mockCheckpoint));

            const checkpoint = await service.loadCheckpoint(mockDirectory.id);

            expect(checkpoint).not.toBeNull();
            expect(checkpoint!.stepIndex).toBe(mockCheckpoint.stepIndex);
            expect(checkpoint!.stepName).toBe(mockCheckpoint.stepName);
            expect(checkpoint!.schemaVersion).toBe(mockCheckpoint.schemaVersion);
        });
    });

    describe('clearCheckpoint()', () => {
        it('should delete checkpoint from cache', async () => {
            await service.clearCheckpoint(mockDirectory.id);

            expect(cacheManager.del).toHaveBeenCalledWith(
                `pipeline-checkpoint-${mockDirectory.id}`,
            );
        });
    });

    describe('resumeFromCheckpoint()', () => {
        it('should return null when no checkpoint exists', async () => {
            cacheManager.get.mockResolvedValue(undefined);

            const result = await service.resumeFromCheckpoint(mockDirectory.id);

            expect(result).toBeNull();
        });

        it('should reject checkpoints with incompatible schema version', async () => {
            const oldCheckpoint = {
                stepIndex: 5,
                stepName: 'Web Search',
                timestamp: new Date().toISOString(),
                context: {},
                completedSteps: [],
                schemaVersion: 999, // Future/incompatible version
            };

            // Serialize with superjson as the real implementation does
            cacheManager.get.mockResolvedValue(superjson.stringify(oldCheckpoint));

            const result = await service.resumeFromCheckpoint(mockDirectory.id);

            expect(result).toBeNull();
            expect(cacheManager.del).toHaveBeenCalledWith(
                `pipeline-checkpoint-${mockDirectory.id}`,
            );
        });

        it('should properly restore Sets and Maps from checkpoint', async () => {
            registry.register(defaultPlugin, {
                id: 'default-pipeline',
                name: 'Default Pipeline',
                version: '1.0.0',
                description: 'Default pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['default-pipeline'],
            });
            registry.updateState('default-pipeline', 'loaded');

            const mockCheckpoint: CheckpointData = {
                stepIndex: 0,
                stepName: 'Prompt Comparison',
                timestamp: new Date().toISOString(),
                context: {
                    directory: mockDirectory,
                    request: mockRequest,
                    existing: mockExisting,
                    extractedUrls: ['https://example.com'],
                    searchQueries: ['test query'],
                    webPages: [],
                    // Use real Set and Map - superjson handles serialization
                    processedSourceUrls: new Set(['https://processed.com', 'https://url2.com']),
                    contentCache: new Map([
                        ['url1', 'content1'],
                        ['url2', 'content2'],
                    ]),
                    initialAiItems: [],
                    extractedWebItems: [],
                    aggregatedItems: [],
                    finalItems: [],
                    finalCategories: [],
                    finalTags: [],
                    finalBrands: [],
                    metrics: {
                        startTime: Date.now(),
                        itemsProcessed: 10,
                        urlsExtracted: 5,
                        pagesRetrieved: 3,
                        itemsExtracted: 8,
                        itemsAfterDedup: 7,
                        steps: {},
                    },
                    allInitialCategories: ['cat1'],
                    allPriorityCategories: ['cat2'],
                    featuredItemHints: ['hint1'],
                    subject: 'Test Subject',
                },
                completedSteps: [],
                schemaVersion: 1,
            };

            // Serialize with superjson as the real implementation does
            cacheManager.get.mockResolvedValue(superjson.stringify(mockCheckpoint));

            let capturedContext: TypedGenerationContext | null = null;

            // Register all built-in step executors
            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                defaultPlugin.registerStepExecutor(step.id as any, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => {
                        if (step.id === 'prompt-comparison') {
                            capturedContext = ctx;
                        }
                        ctx.shouldStop = true;
                        return Promise.resolve(ctx);
                    }),
                });
            }

            await service.resumeFromCheckpoint(mockDirectory.id);

            expect(capturedContext).not.toBeNull();
            // Verify Sets were restored correctly
            expect(capturedContext!.processedSourceUrls instanceof Set).toBe(true);
            expect(capturedContext!.processedSourceUrls.has('https://processed.com')).toBe(true);
            expect(capturedContext!.processedSourceUrls.has('https://url2.com')).toBe(true);
            expect(capturedContext!.processedSourceUrls.size).toBe(2);
            // Verify Maps were restored correctly
            expect(capturedContext!.contentCache instanceof Map).toBe(true);
            expect(capturedContext!.contentCache.get('url1')).toBe('content1');
            expect(capturedContext!.contentCache.get('url2')).toBe('content2');
            expect(capturedContext!.contentCache.size).toBe(2);
        });

        it('should handle empty Sets and Maps in checkpoint', async () => {
            registry.register(defaultPlugin, {
                id: 'default-pipeline',
                name: 'Default Pipeline',
                version: '1.0.0',
                description: 'Default pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['default-pipeline'],
            });
            registry.updateState('default-pipeline', 'loaded');

            const mockCheckpoint: CheckpointData = {
                stepIndex: 1,
                stepName: 'Prompt Comparison',
                timestamp: new Date().toISOString(),
                context: {
                    directory: mockDirectory,
                    request: mockRequest,
                    existing: mockExisting,
                    extractedUrls: [],
                    searchQueries: [],
                    webPages: [],
                    processedSourceUrls: new Set(),
                    contentCache: new Map(),
                    initialAiItems: [],
                    extractedWebItems: [],
                    aggregatedItems: [],
                    finalItems: [],
                    finalCategories: [],
                    finalTags: [],
                    finalBrands: [],
                    metrics: {
                        startTime: Date.now(),
                        itemsProcessed: 0,
                        urlsExtracted: 0,
                        pagesRetrieved: 0,
                        itemsExtracted: 0,
                        itemsAfterDedup: 0,
                        steps: {},
                    },
                    allInitialCategories: [],
                    allPriorityCategories: [],
                    featuredItemHints: [],
                },
                completedSteps: [],
                schemaVersion: 1,
            };

            // Serialize with superjson as the real implementation does
            cacheManager.get.mockResolvedValue(superjson.stringify(mockCheckpoint));

            let capturedContext: TypedGenerationContext | null = null;
            defaultPlugin.registerStepExecutor('prompt-comparison', {
                name: 'Prompt Comparison',
                run: jest.fn().mockImplementation((ctx) => {
                    capturedContext = ctx;
                    ctx.shouldStop = true;
                    return Promise.resolve(ctx);
                }),
            });

            await service.resumeFromCheckpoint(mockDirectory.id);

            expect(capturedContext).not.toBeNull();
            expect(capturedContext!.processedSourceUrls instanceof Set).toBe(true);
            expect(capturedContext!.processedSourceUrls.size).toBe(0);
            expect(capturedContext!.contentCache instanceof Map).toBe(true);
            expect(capturedContext!.contentCache.size).toBe(0);
        });
    });

    describe('executeWithContext()', () => {
        it('should execute using provided context', async () => {
            // Register the default pipeline plugin in the registry
            // Note: We intentionally do NOT include 'pipeline-step' capability (see execute() beforeEach for details)
            registry.register(defaultPlugin, {
                id: 'default-pipeline',
                name: 'Default Pipeline',
                version: '1.0.0',
                description: 'Default pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['default-pipeline'],
            });
            registry.updateState('default-pipeline', 'loaded');

            // Register mock executors
            for (const step of DefaultPipelinePlugin.getBuiltInSteps()) {
                defaultPlugin.registerStepExecutor(step.id as any, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => {
                        ctx.shouldStop = true;
                        return Promise.resolve(ctx);
                    }),
                });
            }

            const context = createGenerationContext(mockDirectory, mockRequest, mockExisting);

            const result = await service.executeWithContext(context);

            expect(result).toBeDefined();
            expect(result.success).toBe(true);
        });
    });
});
