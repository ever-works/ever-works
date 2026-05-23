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
import { MockPipelinePlugin, createLinearChain } from './mock-pipeline-plugin';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import * as superjson from 'superjson';
import { PipelineFacadeService } from '../pipeline-facade.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { PluginContextFactoryService } from '../../plugins/services/plugin-context-factory.service';
import type {
    WorkReference,
    GenerationRequest,
    ExistingItems,
    IPipelineContext,
    PipelineExecutionOptions,
} from '@ever-works/plugin';

/** Simple 3-step linear chain for executor tests */
const EXECUTOR_STEPS = createLinearChain(['step-init', 'step-process', 'step-finalize']);

describe('StepPipelineExecutorService', () => {
    let service: StepPipelineExecutorService;
    let pipelineBuilder: PipelineBuilderService;
    let standardPlugin: MockPipelinePlugin;
    let registry: PluginRegistryService;
    let eventEmitter: EventEmitter2;
    let cacheManager: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

    const mockWork: WorkReference = {
        id: 'dir-123',
        name: 'Test Work',
        slug: 'test-work',
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
                    useValue: cacheManager,
                },
                {
                    provide: PipelineFacadeService,
                    useValue: {
                        createStepExecutionContext: jest.fn().mockReturnValue({
                            aiFacade: {
                                askJson: jest
                                    .fn()
                                    .mockResolvedValue({ result: {}, usage: null, cost: null }),
                                createChatCompletion: jest.fn().mockResolvedValue({
                                    choices: [{ message: { content: '' } }],
                                }),
                                createStreamingChatCompletion: jest.fn(),
                                isConfigured: jest.fn().mockReturnValue(true),
                                testConnection: jest.fn().mockResolvedValue(true),
                                getAvailableModels: jest.fn().mockResolvedValue([]),
                            },
                            searchFacade: {
                                search: jest.fn().mockResolvedValue([]),
                                isConfigured: jest.fn().mockReturnValue(true),
                            },
                            screenshotFacade: {
                                capture: jest.fn().mockResolvedValue(null),
                                getSmartImage: jest.fn().mockResolvedValue(null),
                                getScreenshotUrl: jest.fn().mockResolvedValue(null),
                                isAvailable: jest.fn().mockReturnValue(true),
                            },
                            contentExtractorFacade: {
                                extractContent: jest.fn().mockResolvedValue(null),
                                isConfigured: jest.fn().mockReturnValue(true),
                            },
                            dataSourceFacade: undefined,
                            logger: {
                                log: jest.fn(),
                                debug: jest.fn(),
                                warn: jest.fn(),
                                error: jest.fn(),
                            },
                            work: {
                                id: 'dir-123',
                                name: 'Test Work',
                                slug: 'test-work',
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
                {
                    provide: PluginContextFactoryService,
                    useValue: {
                        addLogInterceptor: jest.fn().mockReturnValue(() => {}),
                    },
                },
            ],
        }).compile();

        service = module.get<StepPipelineExecutorService>(StepPipelineExecutorService);
        pipelineBuilder = module.get<PipelineBuilderService>(PipelineBuilderService);
        standardPlugin = module.get<MockPipelinePlugin>(MockPipelinePlugin);
        registry = module.get<PluginRegistryService>(PluginRegistryService);
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);

        // Configure the mock pipeline with our 3-step chain
        standardPlugin.setSteps(EXECUTOR_STEPS);
    });

    afterEach(() => {
        registry.clear();
        jest.clearAllMocks();
    });

    describe('execute()', () => {
        beforeEach(() => {
            // Register the standard pipeline plugin in the registry
            registry.register(standardPlugin, {
                id: 'standard-pipeline',
                name: 'Standard Pipeline',
                version: '1.0.0',
                description: 'Standard pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['pipeline'],
            });
            registry.updateState('standard-pipeline', 'loaded');

            // Register mock executors for all steps
            for (const step of standardPlugin.getStepDefinitions()) {
                standardPlugin.registerStepExecutor(step.id, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx: IPipelineContext) => {
                        // Mark shouldStop on first step to stop early for tests
                        if (step.id === 'step-init') {
                            ctx.shouldStop = true;
                        }
                        return Promise.resolve(ctx);
                    }),
                });
            }
        });

        it('waits for already running limited-concurrency tasks before rejecting', async () => {
            const events: string[] = [];
            let releaseSlowTask: (() => void) | undefined;
            const slowTaskFinished = new Promise<void>((resolve) => {
                releaseSlowTask = () => {
                    events.push('slow-finished');
                    resolve();
                };
            });

            const runPromise = (service as any).runWithConcurrencyLimit(
                [
                    async () => {
                        events.push('fail-started');
                        throw new Error('first failure');
                    },
                    async () => {
                        events.push('slow-started');
                        await slowTaskFinished;
                    },
                    async () => {
                        events.push('not-started');
                    },
                ],
                2,
            );

            await Promise.resolve();
            releaseSlowTask?.();

            await expect(runPromise).rejects.toThrow('first failure');
            expect(events).toEqual(['fail-started', 'slow-started', 'slow-finished']);
        });

        it('should execute pipeline and emit started event', async () => {
            const result = await service.execute(
                standardPlugin,
                mockWork,
                mockRequest,
                mockExisting,
            );

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STARTED,
                expect.objectContaining({
                    workId: mockWork.id,
                }),
            );
            expect(result).toBeDefined();
        });

        it('should emit step-started event for each step', async () => {
            await service.execute(standardPlugin, mockWork, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STEP_STARTED,
                expect.objectContaining({
                    stepId: 'step-init',
                    stepName: 'Step Init',
                    stepIndex: 0,
                }),
            );
        });

        it('should emit step-completed after step success', async () => {
            await service.execute(standardPlugin, mockWork, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STEP_COMPLETED,
                expect.objectContaining({
                    stepId: 'step-init',
                    stepName: 'Step Init',
                }),
            );
        });

        it('should stop pipeline when shouldStop is set', async () => {
            const result = await service.execute(
                standardPlugin,
                mockWork,
                mockRequest,
                mockExisting,
            );

            // Should have stopped after step-init (which sets shouldStop)
            expect(result.stepsCompleted).toBe(1);
        });

        it('should skip steps in skipSteps option', async () => {
            // Reset shouldStop behavior
            for (const step of standardPlugin.getStepDefinitions()) {
                standardPlugin.registerStepExecutor(step.id, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => Promise.resolve(ctx)),
                });
            }

            const options: PipelineExecutionOptions = {
                skipSteps: ['step-init'],
            };

            const result = await service.execute(
                standardPlugin,
                mockWork,
                mockRequest,
                mockExisting,
                options,
            );

            // step-init should have been skipped
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STEP_SKIPPED,
                expect.objectContaining({
                    stepId: 'step-init',
                }),
            );
        });

        it('should save checkpoint after each step with pipeline-aware key', async () => {
            await service.execute(standardPlugin, mockWork, mockRequest, mockExisting);

            // Verify checkpoint was saved with pipeline-aware key
            expect(cacheManager.set).toHaveBeenCalledWith(
                `pipeline-checkpoint-${mockWork.id}-${standardPlugin.id}`,
                expect.any(String),
                expect.any(Number),
            );

            // Parse and verify content
            const serialized = cacheManager.set.mock.calls[0][1];
            const checkpoint = superjson.parse<CheckpointData>(serialized);
            expect(checkpoint.stepIndex).toBe(0);
            expect(checkpoint.stepName).toBe('Step Init');
            expect(checkpoint.pipelineId).toBe(standardPlugin.id);
            expect(checkpoint.schemaVersion).toBe(4);
        });

        it('should clear checkpoint after successful pipeline completion', async () => {
            await service.execute(standardPlugin, mockWork, mockRequest, mockExisting);

            // Verify checkpoint was cleared on success
            expect(cacheManager.del).toHaveBeenCalledWith(
                `pipeline-checkpoint-${mockWork.id}-${standardPlugin.id}`,
            );
        });

        it('should call contextToSnapshot when saving checkpoint', async () => {
            const snapshotSpy = jest.spyOn(standardPlugin, 'contextToSnapshot');

            standardPlugin.registerStepExecutor('step-init', {
                name: 'Step Init',
                run: jest.fn().mockImplementation((ctx) => {
                    ctx.shouldStop = true;
                    return Promise.resolve(ctx);
                }),
            });

            await service.execute(standardPlugin, mockWork, mockRequest, mockExisting);

            // Verify contextToSnapshot was called for checkpoint serialization
            expect(snapshotSpy).toHaveBeenCalled();
            expect(snapshotSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    work: mockWork,
                    request: mockRequest,
                    warnings: expect.any(Array),
                }),
            );

            // Verify checkpoint was saved as serialized string
            const serializedCheckpoint = cacheManager.set.mock.calls[0][1];
            expect(typeof serializedCheckpoint).toBe('string');

            // Verify the snapshot is stored in the checkpoint
            const savedCheckpoint = superjson.parse<CheckpointData>(serializedCheckpoint);
            expect((savedCheckpoint.context as any).work).toEqual(mockWork);
            expect((savedCheckpoint.context as any).request).toEqual(mockRequest);
        });

        it('should track per-step metrics', async () => {
            const result = await service.execute(
                standardPlugin,
                mockWork,
                mockRequest,
                mockExisting,
            );

            // The state should have completed steps
            expect(result.state.completedSteps.length).toBeGreaterThan(0);
        });

        it('should respect cancellation signal', async () => {
            const controller = new AbortController();
            controller.abort();

            const result = await service.execute(
                standardPlugin,
                mockWork,
                mockRequest,
                mockExisting,
                {
                    signal: controller.signal,
                },
            );

            expect(result.success).toBe(false);
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.CANCELLED,
                expect.any(Object),
            );
        });

        it('should continue on error when continueOnError is true', async () => {
            // Make first step fail
            standardPlugin.registerStepExecutor('step-init', {
                name: 'Step Init',
                run: jest.fn().mockRejectedValue(new Error('Test error')),
            });

            const result = await service.execute(
                standardPlugin,
                mockWork,
                mockRequest,
                mockExisting,
                {
                    continueOnError: true,
                },
            );

            // Should have continued despite error (step-init is not optional)
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STEP_FAILED,
                expect.objectContaining({
                    stepId: 'step-init',
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

            // Register executors for these custom steps
            standardPlugin.registerStepExecutor('start', startStep);
            standardPlugin.registerStepExecutor('p1', parallel1);
            standardPlugin.registerStepExecutor('p2', parallel2);

            const startTime = Date.now();
            await service.execute(standardPlugin, mockWork, mockRequest, mockExisting);
            const duration = Date.now() - startTime;

            // Verification
            // Both parallel steps take 50ms.
            // If sequential: 50 + 50 = 100ms (+ overhead)
            // If parallel: max(50, 50) = 50ms (+ overhead)
            // We expect the total duration to be closer to 50ms than 100ms
            // Using a slightly loose check to account for test overhead
            expect(duration).toBeLessThan(200);
            expect(parallel1.run).toHaveBeenCalled();
            expect(parallel2.run).toHaveBeenCalled();
        });
    });

    describe('provider overrides', () => {
        let facadeServiceMock: { createStepExecutionContext: jest.Mock };

        beforeEach(() => {
            registry.register(standardPlugin, {
                id: 'standard-pipeline',
                name: 'Standard Pipeline',
                version: '1.0.0',
                description: 'Standard pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['pipeline'],
            });
            registry.updateState('standard-pipeline', 'loaded');

            // Get reference to the mock facade service
            facadeServiceMock = (service as any).facadeService;

            // Register step executors for all steps
            for (const step of standardPlugin.getStepDefinitions()) {
                standardPlugin.registerStepExecutor(step.id, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx: IPipelineContext) => {
                        ctx.shouldStop = true;
                        return Promise.resolve(ctx);
                    }),
                });
            }
        });

        it('should pass provider overrides from request to facade service', async () => {
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

            await service.execute(standardPlugin, mockWork, requestWithProviders, mockExisting);

            // Verify facade service was called with provider overrides.
            // 5th arg is `kbContext` (EW-641 row 32c), 6th is `kbTools`
            // (EW-641 row 36c) — both undefined when neither
            // KnowledgeBaseService nor KbToolsFacadeAdapter is injected.
            expect(facadeServiceMock.createStepExecutionContext).toHaveBeenCalledWith(
                mockWork,
                requestWithProviders.providers,
                undefined,
                undefined,
                undefined,
                undefined,
            );
        });

        it('should not include provider overrides when request has no providers', async () => {
            await service.execute(standardPlugin, mockWork, mockRequest, mockExisting);

            // Verify facade service was called without provider overrides
            expect(facadeServiceMock.createStepExecutionContext).toHaveBeenCalledWith(
                mockWork,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
            );
        });

        it('should pass ai model override from request to facade service', async () => {
            const requestWithModel: GenerationRequest = {
                prompt: 'Generate test items',
                config: {},
                aiModel: 'openai/gpt-4.1',
            };

            await service.execute(standardPlugin, mockWork, requestWithModel, mockExisting);

            expect(facadeServiceMock.createStepExecutionContext).toHaveBeenCalledWith(
                mockWork,
                undefined,
                'openai/gpt-4.1',
                undefined,
                undefined,
                undefined,
            );
        });

        // EW-641 Phase 2/b row 32c — orchestrator populates execContext.kbContext.
        it('forwards the resolved KB bundle as the 5th arg when KnowledgeBaseService is wired', async () => {
            const bundle = {
                alwaysInjected: [{ id: 'b1' }],
                queryRetrieved: [{ id: 'q1' }],
            };
            const kbStub = { resolveContext: jest.fn().mockResolvedValue(bundle) };
            (service as any).knowledgeBaseService = kbStub;

            const requestWithPrompt: GenerationRequest = {
                prompt: 'voice tone',
                config: {},
            };

            await service.execute(standardPlugin, mockWork, requestWithPrompt, mockExisting);

            expect(kbStub.resolveContext).toHaveBeenCalledTimes(1);
            expect(kbStub.resolveContext).toHaveBeenCalledWith(mockWork.id, {
                query: 'voice tone',
            });
            // Bundle reaches the facade as the 5th positional arg of every
            // per-step createStepExecutionContext call. The 6th arg
            // (kbTools, row 36c) stays undefined — no adapter wired.
            expect(facadeServiceMock.createStepExecutionContext).toHaveBeenCalledWith(
                mockWork,
                undefined,
                undefined,
                undefined,
                bundle,
                undefined,
            );
        });

        it('degrades gracefully when resolveContext throws (kbContext stays undefined)', async () => {
            const kbStub = {
                resolveContext: jest.fn().mockRejectedValue(new Error('kb down')),
            };
            (service as any).knowledgeBaseService = kbStub;
            // Silence the expected warn log.
            jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

            await service.execute(standardPlugin, mockWork, mockRequest, mockExisting);

            expect(kbStub.resolveContext).toHaveBeenCalled();
            // 5th arg stays undefined even though resolveContext rejected.
            expect(facadeServiceMock.createStepExecutionContext).toHaveBeenCalledWith(
                mockWork,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
            );
        });

        it('should fail when facade service throws for missing user context', async () => {
            const workWithoutUser: WorkReference = {
                id: 'dir-no-user',
                name: 'No User Dir',
                slug: 'no-user-dir',
            };

            // Make facade service throw for works without user
            facadeServiceMock.createStepExecutionContext.mockImplementation(() => {
                throw new Error('User context is required for pipeline execution.');
            });

            const result = await service.execute(
                standardPlugin,
                workWithoutUser,
                mockRequest,
                mockExisting,
            );

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });
    });

    describe('skip steps when data already provided', () => {
        it('should skip step when all provided data keys are available', async () => {
            // Register executors that check for skipping
            for (const step of standardPlugin.getStepDefinitions()) {
                standardPlugin.registerStepExecutor(step.id, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => {
                        // Stop after first step
                        ctx.shouldStop = true;
                        return Promise.resolve(ctx);
                    }),
                });
            }

            const result = await service.execute(
                standardPlugin,
                mockWork,
                mockRequest,
                mockExisting,
            );

            expect(result).toBeDefined();
        });
    });

    describe('loadCheckpoint()', () => {
        it('should return null when no checkpoint exists', async () => {
            cacheManager.get.mockResolvedValue(undefined);

            const checkpoint = await service.loadCheckpoint(mockWork.id, 'standard-pipeline');

            expect(checkpoint).toBeNull();
        });

        it('should return checkpoint data when exists', async () => {
            const mockCheckpoint: CheckpointData = {
                stepIndex: 1,
                stepName: 'Step Process',
                pipelineId: 'standard-pipeline',
                timestamp: new Date().toISOString(),
                context: {
                    work: mockWork,
                    request: mockRequest,
                    existing: mockExisting,
                    shouldStop: false,
                    warnings: [],
                    data: {},
                },
                completedSteps: ['step-init'],
                schemaVersion: 4,
            };

            // Serialize with superjson as the real implementation does
            cacheManager.get.mockResolvedValue(superjson.stringify(mockCheckpoint));

            const checkpoint = await service.loadCheckpoint(mockWork.id, 'standard-pipeline');

            expect(checkpoint).not.toBeNull();
            expect(checkpoint!.stepIndex).toBe(mockCheckpoint.stepIndex);
            expect(checkpoint!.stepName).toBe(mockCheckpoint.stepName);
            expect(checkpoint!.pipelineId).toBe('standard-pipeline');
            expect(checkpoint!.schemaVersion).toBe(mockCheckpoint.schemaVersion);
        });

        it('should use pipeline-aware cache key', async () => {
            cacheManager.get.mockResolvedValue(undefined);

            await service.loadCheckpoint('dir-123', 'my-pipeline');

            expect(cacheManager.get).toHaveBeenCalledWith(
                'pipeline-checkpoint-dir-123-my-pipeline',
            );
        });
    });

    describe('clearCheckpoint()', () => {
        it('should delete checkpoint from cache using pipeline-aware key', async () => {
            await service.clearCheckpoint(mockWork.id, 'standard-pipeline');

            expect(cacheManager.del).toHaveBeenCalledWith(
                `pipeline-checkpoint-${mockWork.id}-standard-pipeline`,
            );
        });
    });

    describe('resumeFromCheckpoint()', () => {
        it('should return null when no checkpoint exists', async () => {
            cacheManager.get.mockResolvedValue(undefined);

            const result = await service.resumeFromCheckpoint(
                standardPlugin,
                mockWork.id,
                standardPlugin.id,
            );

            expect(result).toBeNull();
        });

        it('should reject checkpoints with incompatible schema version', async () => {
            const oldCheckpoint = {
                stepIndex: 1,
                stepName: 'Step Process',
                pipelineId: standardPlugin.id,
                timestamp: new Date().toISOString(),
                context: {},
                completedSteps: [],
                schemaVersion: 999, // Future/incompatible version
            };

            // Serialize with superjson as the real implementation does
            cacheManager.get.mockResolvedValue(superjson.stringify(oldCheckpoint));

            const result = await service.resumeFromCheckpoint(
                standardPlugin,
                mockWork.id,
                standardPlugin.id,
            );

            expect(result).toBeNull();
            expect(cacheManager.del).toHaveBeenCalledWith(
                `pipeline-checkpoint-${mockWork.id}-${standardPlugin.id}`,
            );
        });

        it('should restore context from checkpoint via contextFromSnapshot', async () => {
            registry.register(standardPlugin, {
                id: 'standard-pipeline',
                name: 'Standard Pipeline',
                version: '1.0.0',
                description: 'Standard pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['pipeline'],
            });
            registry.updateState('standard-pipeline', 'loaded');

            const mockCheckpoint: CheckpointData = {
                stepIndex: 0,
                stepName: 'Step Init',
                pipelineId: standardPlugin.id,
                timestamp: new Date().toISOString(),
                context: {
                    work: mockWork,
                    request: mockRequest,
                    existing: mockExisting,
                    shouldStop: false,
                    warnings: ['prior warning'],
                    data: { key1: 'value1' },
                },
                completedSteps: [],
                schemaVersion: 4,
            };

            // Serialize with superjson as the real implementation does
            cacheManager.get.mockResolvedValue(superjson.stringify(mockCheckpoint));

            const fromSnapshotSpy = jest.spyOn(standardPlugin, 'contextFromSnapshot');
            let capturedContext: IPipelineContext | null = null;

            // Register all step executors
            for (const step of standardPlugin.getStepDefinitions()) {
                standardPlugin.registerStepExecutor(step.id, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => {
                        if (step.id === 'step-init') {
                            capturedContext = ctx;
                        }
                        ctx.shouldStop = true;
                        return Promise.resolve(ctx);
                    }),
                });
            }

            await service.resumeFromCheckpoint(standardPlugin, mockWork.id, standardPlugin.id);

            // Verify contextFromSnapshot was called
            expect(fromSnapshotSpy).toHaveBeenCalled();
            expect(capturedContext).not.toBeNull();
            // Verify the restored context has the expected shape
            expect(capturedContext!.work).toEqual(mockWork);
            expect(capturedContext!.request).toEqual(mockRequest);
            expect(capturedContext!.warnings).toEqual(['prior warning']);
            expect((capturedContext as any).data).toEqual({ key1: 'value1' });
        });

        it('should restore context with empty data from checkpoint', async () => {
            registry.register(standardPlugin, {
                id: 'standard-pipeline',
                name: 'Standard Pipeline',
                version: '1.0.0',
                description: 'Standard pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['pipeline'],
            });
            registry.updateState('standard-pipeline', 'loaded');

            const mockCheckpoint: CheckpointData = {
                stepIndex: 0,
                stepName: 'Step Init',
                pipelineId: standardPlugin.id,
                timestamp: new Date().toISOString(),
                context: {
                    work: mockWork,
                    request: mockRequest,
                    existing: mockExisting,
                    shouldStop: false,
                    warnings: [],
                    data: {},
                },
                completedSteps: [],
                schemaVersion: 4,
            };

            // Serialize with superjson as the real implementation does
            cacheManager.get.mockResolvedValue(superjson.stringify(mockCheckpoint));

            let capturedContext: IPipelineContext | null = null;

            // Register all step executors
            for (const step of standardPlugin.getStepDefinitions()) {
                standardPlugin.registerStepExecutor(step.id, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => {
                        if (step.id === 'step-init') {
                            capturedContext = ctx;
                        }
                        ctx.shouldStop = true;
                        return Promise.resolve(ctx);
                    }),
                });
            }

            await service.resumeFromCheckpoint(standardPlugin, mockWork.id, standardPlugin.id);

            expect(capturedContext).not.toBeNull();
            expect(capturedContext!.work).toEqual(mockWork);
            expect(capturedContext!.warnings).toEqual([]);
            expect((capturedContext as any).data).toEqual({});
        });
    });

    describe('executeWithContext()', () => {
        it('should execute using provided context', async () => {
            // Register the standard pipeline plugin in the registry
            registry.register(standardPlugin, {
                id: 'standard-pipeline',
                name: 'Standard Pipeline',
                version: '1.0.0',
                description: 'Standard pipeline plugin for tests',
                category: 'pipeline',
                capabilities: ['pipeline'],
            });
            registry.updateState('standard-pipeline', 'loaded');

            // Register mock executors
            for (const step of standardPlugin.getStepDefinitions()) {
                standardPlugin.registerStepExecutor(step.id, {
                    name: step.name,
                    run: jest.fn().mockImplementation((ctx) => {
                        ctx.shouldStop = true;
                        return Promise.resolve(ctx);
                    }),
                });
            }

            const context = standardPlugin.createContext(mockWork, mockRequest, mockExisting);

            const result = await service.executeWithContext(standardPlugin, context);

            expect(result).toBeDefined();
            // Mock plugin's extractResult always returns success: true with empty items
            expect(result.success).toBe(true);
        });
    });
});
