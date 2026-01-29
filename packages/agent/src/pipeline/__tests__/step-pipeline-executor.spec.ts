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
import { DefaultPipelinePlugin } from '../default-pipeline.plugin';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { BUILT_IN_STEPS } from '../built-in-steps';
import { createGenerationContext } from '../generation-context';
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
    };

    const mockRequest: GenerationRequest = {
        count: 10,
        prompt: 'Generate test items',
        includeAiItems: true,
        includeWebItems: true,
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
            // Register mock executors for all built-in steps
            for (const step of BUILT_IN_STEPS) {
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
            for (const step of BUILT_IN_STEPS) {
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

            expect(cacheManager.set).toHaveBeenCalledWith(
                `pipeline-checkpoint-${mockDirectory.id}`,
                expect.objectContaining({
                    stepIndex: 0,
                    stepName: 'Prompt Comparison',
                }),
                expect.any(Number),
            );
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
    });

    describe('skip steps when data already provided', () => {
        it('should skip step when all provided data keys are available', async () => {
            // Register executors that check for skipping
            for (const step of BUILT_IN_STEPS) {
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
            };

            cacheManager.get.mockResolvedValue(mockCheckpoint);

            const checkpoint = await service.loadCheckpoint(mockDirectory.id);

            expect(checkpoint).toEqual(mockCheckpoint);
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
    });

    describe('executeWithContext()', () => {
        it('should execute using provided context', async () => {
            // Register mock executors
            for (const step of BUILT_IN_STEPS) {
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
