import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { StepAdapterService, ILegacyPipelineStep } from '../step-adapter.service';
import { TypedGenerationContext, createGenerationContext } from '../generation-context';
import type {
    DirectoryReference,
    GenerationRequest,
    ExistingItems,
    MutableGenerationContext,
    StepExecutionContext,
} from '@ever-works/plugin';
import type { BuiltInStepId } from '@ever-works/default-pipeline-plugin';

// Silence logger during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

describe('StepAdapterService', () => {
    let service: StepAdapterService;

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

    const createMockLegacyStep = (name: string): ILegacyPipelineStep => ({
        name,
        run: jest.fn().mockImplementation((ctx) => Promise.resolve(ctx)),
    });

    const mockExecContext: StepExecutionContext = {
        aiFacade: {} as StepExecutionContext['aiFacade'],
        searchFacade: {} as StepExecutionContext['searchFacade'],
        screenshotFacade: {} as StepExecutionContext['screenshotFacade'],
        contentExtractorFacade: {} as StepExecutionContext['contentExtractorFacade'],
        logger: {
            log: jest.fn(),
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        },
        directory: mockDirectory,
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [StepAdapterService],
        }).compile();

        service = module.get<StepAdapterService>(StepAdapterService);
    });

    afterEach(() => {
        service.clear();
    });

    describe('registerService()', () => {
        it('should register a service for a step', () => {
            const step = createMockLegacyStep('Test Step');

            service.registerService('prompt-processing', step);

            expect(service.hasService('prompt-processing')).toBe(true);
            expect(service.count()).toBe(1);
        });

        it('should overwrite existing service', () => {
            const step1 = createMockLegacyStep('Step 1');
            const step2 = createMockLegacyStep('Step 2');

            service.registerService('prompt-processing', step1);
            service.registerService('prompt-processing', step2);

            expect(service.getService('prompt-processing')).toBe(step2);
            expect(service.count()).toBe(1);
        });
    });

    describe('registerServices()', () => {
        it('should register multiple services', () => {
            const services = new Map<BuiltInStepId, ILegacyPipelineStep>([
                ['prompt-processing', createMockLegacyStep('Step 1')],
                ['domain-detection', createMockLegacyStep('Step 2')],
                ['web-search', createMockLegacyStep('Step 3')],
            ]);

            service.registerServices(services);

            expect(service.count()).toBe(3);
            expect(service.hasService('prompt-processing')).toBe(true);
            expect(service.hasService('domain-detection')).toBe(true);
            expect(service.hasService('web-search')).toBe(true);
        });
    });

    describe('hasService()', () => {
        it('should return true for registered service', () => {
            service.registerService('prompt-processing', createMockLegacyStep('Step'));

            expect(service.hasService('prompt-processing')).toBe(true);
        });

        it('should return false for unregistered service', () => {
            expect(service.hasService('prompt-processing')).toBe(false);
        });
    });

    describe('getService()', () => {
        it('should return registered service', () => {
            const step = createMockLegacyStep('Test Step');
            service.registerService('prompt-processing', step);

            expect(service.getService('prompt-processing')).toBe(step);
        });

        it('should return undefined for unregistered service', () => {
            expect(service.getService('prompt-processing')).toBeUndefined();
        });
    });

    describe('getRegisteredStepIds()', () => {
        it('should return empty array when no services registered', () => {
            expect(service.getRegisteredStepIds()).toEqual([]);
        });

        it('should return all registered step IDs', () => {
            service.registerService('prompt-processing', createMockLegacyStep('Step 1'));
            service.registerService('domain-detection', createMockLegacyStep('Step 2'));

            const ids = service.getRegisteredStepIds();

            expect(ids).toHaveLength(2);
            expect(ids).toContain('prompt-processing');
            expect(ids).toContain('domain-detection');
        });
    });

    describe('executeStep()', () => {
        it('should execute registered service', async () => {
            const step = createMockLegacyStep('Test Step');
            service.registerService('prompt-processing', step);

            const context = createGenerationContext(mockDirectory, mockRequest, mockExisting);
            const result = await service.executeStep('prompt-processing', context);

            expect(step.run).toHaveBeenCalledWith(context);
            expect(result).toBeInstanceOf(TypedGenerationContext);
        });

        it('should throw for unregistered service', async () => {
            const context = createGenerationContext(mockDirectory, mockRequest, mockExisting);

            await expect(service.executeStep('prompt-processing', context)).rejects.toThrow(
                /No executor registered for step/,
            );
        });

        it('should throw when signal is aborted', async () => {
            const step = createMockLegacyStep('Test Step');
            service.registerService('prompt-processing', step);

            const context = createGenerationContext(mockDirectory, mockRequest, mockExisting);
            const controller = new AbortController();
            controller.abort();

            await expect(
                service.executeStep('prompt-processing', context, { signal: controller.signal }),
            ).rejects.toThrow(/cancelled before execution/);

            expect(step.run).not.toHaveBeenCalled();
        });

        it('should call progress callback', async () => {
            const step = createMockLegacyStep('Test Step');
            service.registerService('prompt-processing', step);

            const context = createGenerationContext(mockDirectory, mockRequest, mockExisting);
            const onProgress = jest.fn();

            await service.executeStep('prompt-processing', context, undefined, onProgress);

            expect(onProgress).toHaveBeenCalledWith(
                expect.objectContaining({ percent: 0, message: 'Starting Test Step' }),
            );
            expect(onProgress).toHaveBeenCalledWith(
                expect.objectContaining({ percent: 100, message: 'Completed Test Step' }),
            );
        });

        it('should propagate errors from service', async () => {
            const error = new Error('Service error');
            const step: ILegacyPipelineStep = {
                name: 'Failing Step',
                run: jest.fn().mockRejectedValue(error),
            };
            service.registerService('prompt-processing', step);

            const context = createGenerationContext(mockDirectory, mockRequest, mockExisting);

            await expect(service.executeStep('prompt-processing', context)).rejects.toThrow(
                'Service error',
            );
        });

        it('should convert MutableGenerationContext result to TypedGenerationContext', async () => {
            const modifiedContext: MutableGenerationContext = {
                directory: mockDirectory,
                request: mockRequest,
                existing: mockExisting,
                extractedUrls: ['https://example.com'],
                searchQueries: ['test query'],
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
            };

            const step: ILegacyPipelineStep = {
                name: 'Modifying Step',
                run: jest.fn().mockResolvedValue(modifiedContext),
            };
            service.registerService('prompt-processing', step);

            const context = createGenerationContext(mockDirectory, mockRequest, mockExisting);
            const result = await service.executeStep('prompt-processing', context);

            expect(result).toBeInstanceOf(TypedGenerationContext);
            expect(result.extractedUrls).toEqual(['https://example.com']);
            expect(result.searchQueries).toEqual(['test query']);
        });
    });

    describe('createExecutorWrapper()', () => {
        it('should create executor wrapper for registered service', () => {
            const step = createMockLegacyStep('Test Step');
            service.registerService('prompt-processing', step);

            const wrapper = service.createExecutorWrapper('prompt-processing');

            expect(wrapper).toBeDefined();
            expect(wrapper?.name).toBe('Test Step');
        });

        it('should return undefined for unregistered service', () => {
            const wrapper = service.createExecutorWrapper('prompt-processing');

            expect(wrapper).toBeUndefined();
        });

        it('should create working executor', async () => {
            const step = createMockLegacyStep('Test Step');
            service.registerService('prompt-processing', step);

            const wrapper = service.createExecutorWrapper('prompt-processing');
            const context = createGenerationContext(mockDirectory, mockRequest, mockExisting);

            await wrapper!.run(context, mockExecContext);

            expect(step.run).toHaveBeenCalledWith(context);
        });
    });

    describe('createAllExecutorWrappers()', () => {
        it('should create wrappers for all registered services', () => {
            service.registerService('prompt-processing', createMockLegacyStep('Step 1'));
            service.registerService('domain-detection', createMockLegacyStep('Step 2'));
            service.registerService('web-search', createMockLegacyStep('Step 3'));

            const wrappers = service.createAllExecutorWrappers();

            expect(wrappers.size).toBe(3);
            expect(wrappers.get('prompt-processing')).toBeDefined();
            expect(wrappers.get('domain-detection')).toBeDefined();
            expect(wrappers.get('web-search')).toBeDefined();
        });

        it('should return empty map when no services registered', () => {
            const wrappers = service.createAllExecutorWrappers();

            expect(wrappers.size).toBe(0);
        });
    });

    describe('clear()', () => {
        it('should remove all registered services', () => {
            service.registerService('prompt-processing', createMockLegacyStep('Step 1'));
            service.registerService('domain-detection', createMockLegacyStep('Step 2'));

            service.clear();

            expect(service.count()).toBe(0);
            expect(service.hasService('prompt-processing')).toBe(false);
            expect(service.hasService('domain-detection')).toBe(false);
        });
    });

    describe('count()', () => {
        it('should return 0 when empty', () => {
            expect(service.count()).toBe(0);
        });

        it('should return correct count', () => {
            service.registerService('prompt-processing', createMockLegacyStep('Step 1'));
            service.registerService('domain-detection', createMockLegacyStep('Step 2'));

            expect(service.count()).toBe(2);
        });
    });
});
