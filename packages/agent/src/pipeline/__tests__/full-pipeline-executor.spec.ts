import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { FullPipelineExecutorService } from '../full-pipeline-executor.service';
import { PipelineEvents } from '../step-pipeline-executor.service';

// Silence logger during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    IFullPipelinePlugin,
    PluginCategory,
    PipelineResult,
    PipelineStepDefinition,
    PipelineExecutionOptions,
    PipelineProgressCallback,
} from '@ever-works/plugin';

describe('FullPipelineExecutorService', () => {
    let service: FullPipelineExecutorService;
    let eventEmitter: EventEmitter2;

    const mockDirectory: DirectoryReference = {
        id: 'dir-123',
        name: 'Test Directory',
        slug: 'test-directory',
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

    const mockSuccessResult: PipelineResult = {
        success: true,
        items: [
            {
                name: 'Test Item',
                slug: 'test-item',
                source_url: 'https://example.com',
            } as any,
        ],
        categories: [{ name: 'Category 1' }] as any[],
        tags: [{ name: 'Tag 1' }] as any[],
        brands: [],
        duration: 5000,
        stepsCompleted: 5,
        totalSteps: 5,
        state: {
            steps: new Map(),
            completedSteps: ['step-1', 'step-2', 'step-3', 'step-4', 'step-5'],
            failedSteps: [],
            isRunning: false,
            isCancelled: false,
        },
    };

    /**
     * Creates a mock full pipeline plugin
     */
    const createMockFullPipelinePlugin = (
        id: string,
        options: {
            executeResult?: PipelineResult;
            executeError?: Error;
            supportsCancel?: boolean;
            supportsGetState?: boolean;
        } = {},
    ): IFullPipelinePlugin => {
        const {
            executeResult = mockSuccessResult,
            executeError,
            supportsCancel = false,
            supportsGetState = false,
        } = options;

        // Full pipeline plugins define their own steps with custom IDs
        const stepDefinitions = [
            {
                id: 'exa-init',
                name: 'Exa Init',
                position: { type: 'first' },
                provides: ['exa-session'],
            },
            {
                id: 'exa-research',
                name: 'Exa Research',
                position: { type: 'after', stepId: 'exa-init' },
                provides: ['exa-results'],
            },
            {
                id: 'exa-curate',
                name: 'Exa Curate',
                position: { type: 'after', stepId: 'exa-research' },
                provides: ['curated-items'],
            },
            {
                id: 'exa-enrich',
                name: 'Exa Enrich',
                position: { type: 'after', stepId: 'exa-curate' },
                provides: ['enriched-items'],
            },
            {
                id: 'exa-format',
                name: 'Exa Format',
                position: { type: 'last' },
                provides: ['final-items'],
            },
        ] as PipelineStepDefinition[];

        const plugin: IFullPipelinePlugin = {
            id,
            name: `Full Pipeline Plugin ${id}`,
            version: '1.0.0',
            category: 'pipeline' as PluginCategory,
            capabilities: ['full-pipeline'],
            settingsSchema: { type: 'object', properties: {} },
            onLoad: jest.fn(),
            onEnable: jest.fn(),
            onDisable: jest.fn(),
            onUnload: jest.fn(),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
            getStepDefinitions: jest.fn().mockReturnValue(stepDefinitions),
            createExecutionPlan: jest.fn().mockReturnValue({
                steps: stepDefinitions,
                estimatedDuration: 30000,
            }),
            execute: jest.fn().mockImplementation(() => {
                if (executeError) {
                    return Promise.reject(executeError);
                }
                return Promise.resolve(executeResult);
            }),
        };

        if (supportsCancel) {
            plugin.cancel = jest.fn().mockResolvedValue(undefined);
        }

        if (supportsGetState) {
            plugin.getState = jest.fn().mockReturnValue({
                steps: new Map(),
                completedSteps: ['exa-init'],
                failedSteps: [],
                isRunning: true,
                isCancelled: false,
                currentStep: 'exa-research',
                startedAt: Date.now() - 10000,
            });
        }

        return plugin;
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FullPipelineExecutorService,
                {
                    provide: EventEmitter2,
                    useValue: {
                        emit: jest.fn(),
                        on: jest.fn(),
                        off: jest.fn(),
                    },
                },
            ],
        }).compile();

        service = module.get<FullPipelineExecutorService>(FullPipelineExecutorService);
        eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('execute()', () => {
        it('should execute full pipeline plugin', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');

            const result = await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(plugin.execute).toHaveBeenCalledWith(
                mockDirectory,
                mockRequest,
                mockExisting,
                undefined,
                undefined,
            );
            expect(result.success).toBe(true);
            expect(result.items).toHaveLength(1);
        });

        it('should emit pipeline:started event', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');

            await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STARTED,
                expect.objectContaining({
                    directoryId: mockDirectory.id,
                    pipelineId: plugin.id,
                }),
            );
        });

        it('should emit pipeline:completed event on success', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');

            await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.COMPLETED,
                expect.objectContaining({
                    directoryId: mockDirectory.id,
                    pipelineId: plugin.id,
                    stepsCompleted: 5,
                    items: expect.any(Array),
                    categories: expect.any(Array),
                    tags: expect.any(Array),
                    brands: expect.any(Array),
                }),
            );
        });

        it('should emit pipeline:failed event on error', async () => {
            const error = new Error('Plugin execution failed');
            const plugin = createMockFullPipelinePlugin('exa-websets', { executeError: error });

            const result = await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(result.success).toBe(false);
            expect(result.error).toBe(error);
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.FAILED,
                expect.objectContaining({
                    directoryId: mockDirectory.id,
                    pipelineId: plugin.id,
                    error: 'Plugin execution failed',
                }),
            );
        });

        it('should return failed result with step count on error', async () => {
            const error = new Error('Plugin execution failed');
            const plugin = createMockFullPipelinePlugin('exa-websets', { executeError: error });

            const result = await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(result.success).toBe(false);
            expect(result.items).toEqual([]);
            expect(result.categories).toEqual([]);
            expect(result.stepsCompleted).toBe(0);
            expect(result.totalSteps).toBe(5); // From getStepDefinitions
            expect(result.state.isRunning).toBe(false);
        });

        it('should pass options to plugin execute', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');
            const options: PipelineExecutionOptions = {
                timeout: 60000,
                continueOnError: true,
                skipSteps: ['optional-step'],
            };

            await service.execute(plugin, mockDirectory, mockRequest, mockExisting, options);

            expect(plugin.execute).toHaveBeenCalledWith(
                mockDirectory,
                mockRequest,
                mockExisting,
                options,
                undefined,
            );
        });

        it('should pass progress callback to plugin', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');
            const onProgress: PipelineProgressCallback = jest.fn();

            await service.execute(
                plugin,
                mockDirectory,
                mockRequest,
                mockExisting,
                undefined,
                onProgress,
            );

            expect(plugin.execute).toHaveBeenCalledWith(
                mockDirectory,
                mockRequest,
                mockExisting,
                undefined,
                onProgress,
            );
        });

        it('should include duration in result', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');

            const result = await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(result.duration).toBeGreaterThanOrEqual(0);
        });

        it('should include timestamp in events', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');

            await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.STARTED,
                expect.objectContaining({
                    timestamp: expect.any(String),
                }),
            );
        });
    });

    describe('executeWithCancellation()', () => {
        it('should execute normally when signal is not aborted', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets', { supportsCancel: true });
            const controller = new AbortController();
            const options: PipelineExecutionOptions & { signal: AbortSignal } = {
                signal: controller.signal,
            };

            const result = await service.executeWithCancellation(
                plugin,
                mockDirectory,
                mockRequest,
                mockExisting,
                options,
            );

            expect(result.success).toBe(true);
            expect(plugin.cancel).not.toHaveBeenCalled();
        });

        it('should call plugin.cancel when signal is aborted', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets', { supportsCancel: true });
            // Make execute return a delayed promise
            (plugin.execute as jest.Mock).mockImplementation(
                () =>
                    new Promise((resolve) => {
                        setTimeout(() => resolve(mockSuccessResult), 100);
                    }),
            );

            const controller = new AbortController();
            const options: PipelineExecutionOptions & { signal: AbortSignal } = {
                signal: controller.signal,
            };

            // Start execution
            const executePromise = service.executeWithCancellation(
                plugin,
                mockDirectory,
                mockRequest,
                mockExisting,
                options,
            );

            // Abort after a short delay
            setTimeout(() => controller.abort(), 10);

            await executePromise;

            expect(plugin.cancel).toHaveBeenCalled();
        });

        it('should work without cancel support', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets', { supportsCancel: false });
            const controller = new AbortController();
            const options: PipelineExecutionOptions & { signal: AbortSignal } = {
                signal: controller.signal,
            };

            const result = await service.executeWithCancellation(
                plugin,
                mockDirectory,
                mockRequest,
                mockExisting,
                options,
            );

            expect(result.success).toBe(true);
        });

        it('should remove abort listener after completion', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets', { supportsCancel: true });
            const controller = new AbortController();
            const removeEventListenerSpy = jest.spyOn(controller.signal, 'removeEventListener');
            const options: PipelineExecutionOptions & { signal: AbortSignal } = {
                signal: controller.signal,
            };

            await service.executeWithCancellation(
                plugin,
                mockDirectory,
                mockRequest,
                mockExisting,
                options,
            );

            expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
        });

        it('should handle cancel errors gracefully', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets', { supportsCancel: true });
            (plugin.cancel as jest.Mock).mockRejectedValue(new Error('Cancel failed'));
            (plugin.execute as jest.Mock).mockImplementation(
                () =>
                    new Promise((resolve) => {
                        setTimeout(() => resolve(mockSuccessResult), 100);
                    }),
            );

            const controller = new AbortController();
            const options: PipelineExecutionOptions & { signal: AbortSignal } = {
                signal: controller.signal,
            };

            const executePromise = service.executeWithCancellation(
                plugin,
                mockDirectory,
                mockRequest,
                mockExisting,
                options,
            );

            setTimeout(() => controller.abort(), 10);

            // Should not throw even if cancel fails
            const result = await executePromise;
            expect(result).toBeDefined();
        });
    });

    describe('getPluginState()', () => {
        it('should return plugin state when supported', () => {
            const plugin = createMockFullPipelinePlugin('exa-websets', { supportsGetState: true });

            const state = service.getPluginState(plugin);

            expect(state).toBeDefined();
            expect(state?.currentStep).toBe('exa-research');
            expect(state?.isRunning).toBe(true);
            expect(state?.completedSteps).toContain('exa-init');
        });

        it('should return null when getState not supported', () => {
            const plugin = createMockFullPipelinePlugin('exa-websets', { supportsGetState: false });

            const state = service.getPluginState(plugin);

            expect(state).toBeNull();
        });
    });

    describe('event emission', () => {
        it('should emit events with correct timestamp format', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');

            await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            const startedCall = (eventEmitter.emit as jest.Mock).mock.calls.find(
                (call) => call[0] === PipelineEvents.STARTED,
            );

            expect(startedCall).toBeDefined();
            const timestamp = startedCall[1].timestamp;
            expect(new Date(timestamp).toISOString()).toBe(timestamp);
        });

        it('should include all required fields in completed event', async () => {
            const plugin = createMockFullPipelinePlugin('exa-websets');

            await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.COMPLETED,
                expect.objectContaining({
                    timestamp: expect.any(String),
                    directoryId: mockDirectory.id,
                    pipelineId: plugin.id,
                    duration: expect.any(Number),
                    stepsCompleted: expect.any(Number),
                    items: expect.any(Array),
                    categories: expect.any(Array),
                    tags: expect.any(Array),
                    brands: expect.any(Array),
                }),
            );
        });

        it('should include all required fields in failed event', async () => {
            const error = new Error('Test error');
            const plugin = createMockFullPipelinePlugin('exa-websets', { executeError: error });

            await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                PipelineEvents.FAILED,
                expect.objectContaining({
                    timestamp: expect.any(String),
                    directoryId: mockDirectory.id,
                    pipelineId: plugin.id,
                    error: 'Test error',
                    completedSteps: 0,
                }),
            );
        });
    });

    describe('integration scenarios', () => {
        it('should handle plugin with partial result', async () => {
            const partialResult: PipelineResult = {
                success: true,
                items: [],
                categories: [],
                tags: [],
                brands: [],
                duration: 1000,
                stepsCompleted: 3,
                totalSteps: 5,
                state: {
                    steps: new Map(),
                    completedSteps: ['step-1', 'step-2', 'step-3'],
                    failedSteps: [],
                    isRunning: false,
                    isCancelled: false,
                },
            };

            const plugin = createMockFullPipelinePlugin('exa-websets', {
                executeResult: partialResult,
            });

            const result = await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(result.success).toBe(true);
            expect(result.stepsCompleted).toBe(3);
            expect(result.totalSteps).toBe(5);
        });

        it('should handle plugin with cancelled state', async () => {
            const cancelledResult: PipelineResult = {
                success: false,
                items: [],
                categories: [],
                tags: [],
                brands: [],
                duration: 500,
                stepsCompleted: 2,
                totalSteps: 5,
                state: {
                    steps: new Map(),
                    completedSteps: ['step-1', 'step-2'],
                    failedSteps: [],
                    isRunning: false,
                    isCancelled: true,
                },
            };

            const plugin = createMockFullPipelinePlugin('exa-websets', {
                executeResult: cancelledResult,
            });

            const result = await service.execute(plugin, mockDirectory, mockRequest, mockExisting);

            expect(result.success).toBe(false);
            expect(result.state.isCancelled).toBe(true);
        });
    });
});
