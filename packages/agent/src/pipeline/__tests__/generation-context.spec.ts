import { TypedGenerationContext } from '../generation-context';
import type { DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';

describe('TypedGenerationContext', () => {
    let context: TypedGenerationContext;

    const mockDirectory: DirectoryReference = {
        id: 'dir-123',
        name: 'Test Directory',
        slug: 'test-directory',
        description: 'A test directory',
    };

    const mockPluginConfig: Record<string, Record<string, unknown>> = {
        'apify-data-source': { datasetId: 'ds-123', enabled: true },
        'notion-extractor': { enabled: false },
    };

    const mockRequest: GenerationRequest = {
        prompt: 'Generate test items',
        config: {},
    };

    const mockRequestWithPluginConfig: GenerationRequest = {
        prompt: 'Generate test items',
        config: {},
        pluginConfig: mockPluginConfig,
    };

    const mockExisting: ExistingItems = {
        items: [],
        categories: [],
        tags: [],
    };

    beforeEach(() => {
        context = new TypedGenerationContext(mockDirectory, mockRequest, mockExisting);
    });

    describe('constructor', () => {
        it('should initialize with provided values', () => {
            expect(context.directory).toBe(mockDirectory);
            expect(context.request).toBe(mockRequest);
            expect(context.existing).toBe(mockExisting);
        });

        it('should initialize arrays as empty', () => {
            expect(context.extractedUrls).toEqual([]);
            expect(context.searchQueries).toEqual([]);
            expect(context.webPages).toEqual([]);
            expect(context.initialAiItems).toEqual([]);
            expect(context.extractedWebItems).toEqual([]);
            expect(context.aggregatedItems).toEqual([]);
            expect(context.finalItems).toEqual([]);
            expect(context.finalCategories).toEqual([]);
            expect(context.finalTags).toEqual([]);
            expect(context.finalBrands).toEqual([]);
        });

        it('should initialize sets and maps as empty', () => {
            expect(context.processedSourceUrls.size).toBe(0);
            expect(context.contentCache.size).toBe(0);
        });

        it('should initialize metrics with start time', () => {
            expect(context.metrics).toBeDefined();
            expect(context.metrics.startTime).toBeLessThanOrEqual(Date.now());
            expect(context.metrics.itemsProcessed).toBe(0);
        });

        it('should initialize pluginConfig as undefined when not in request', () => {
            expect(context.pluginConfig).toBeUndefined();
        });

        it('should initialize pluginConfig from request', () => {
            const ctx = new TypedGenerationContext(
                mockDirectory,
                mockRequestWithPluginConfig,
                mockExisting,
            );
            expect(ctx.pluginConfig).toEqual(mockPluginConfig);
        });
    });

    describe('getStepResult', () => {
        it('should return undefined for empty direct properties', () => {
            expect(context.getStepResult('extractedUrls')).toBeUndefined();
            expect(context.getStepResult('searchQueries')).toBeUndefined();
        });

        it('should return value for populated direct properties', () => {
            context.extractedUrls = ['https://example.com'];
            expect(context.getStepResult('extractedUrls')).toEqual(['https://example.com']);
        });

        it('should return metrics even when empty (always present)', () => {
            expect(context.getStepResult('metrics')).toBeDefined();
        });
    });

    describe('setStepResult', () => {
        it('should set direct property values', () => {
            context.setStepResult('extractedUrls', ['https://example.com']);
            expect(context.extractedUrls).toEqual(['https://example.com']);
        });

        it('should set searchQueries', () => {
            context.setStepResult('searchQueries', ['query1', 'query2']);
            expect(context.searchQueries).toEqual(['query1', 'query2']);
        });

        it('should set subject', () => {
            context.setStepResult('subject', 'Test Subject');
            expect(context.subject).toBe('Test Subject');
        });

        it('should set shouldStop', () => {
            context.setStepResult('shouldStop', true);
            expect(context.shouldStop).toBe(true);
        });
    });

    describe('hasStepResult', () => {
        it('should return false for unset values', () => {
            expect(context.hasStepResult('extractedUrls')).toBe(false);
        });

        it('should return true for set values', () => {
            context.extractedUrls = ['https://example.com'];
            expect(context.hasStepResult('extractedUrls')).toBe(true);
        });

        it('should return true for metrics (always present)', () => {
            expect(context.hasStepResult('metrics')).toBe(true);
        });
    });

    describe('recordStepMetrics', () => {
        it('should record step metrics', () => {
            context.recordStepMetrics('test-step', {
                name: 'Test Step',
                startTime: Date.now(),
                duration: 1000,
                success: true,
            });

            expect(context.metrics.steps['test-step']).toBeDefined();
            expect(context.metrics.steps['test-step'].name).toBe('Test Step');
            expect(context.metrics.steps['test-step'].success).toBe(true);
        });
    });

    describe('updateMetrics', () => {
        it('should update aggregate metrics', () => {
            context.updateMetrics({
                itemsProcessed: 10,
                urlsExtracted: 5,
                pagesRetrieved: 3,
            });

            expect(context.metrics.itemsProcessed).toBe(10);
            expect(context.metrics.urlsExtracted).toBe(5);
            expect(context.metrics.pagesRetrieved).toBe(3);
        });
    });

    describe('toSnapshot', () => {
        it('should create a read-only snapshot', () => {
            context.extractedUrls = ['https://example.com'];
            context.searchQueries = ['query1'];
            context.subject = 'Test Subject';

            const snapshot = context.toSnapshot();

            expect(snapshot.directory).toBe(context.directory);
            expect(snapshot.extractedUrls).toEqual(['https://example.com']);
            expect(snapshot.searchQueries).toEqual(['query1']);
            expect(snapshot.subject).toBe('Test Subject');
        });

        it('should include pluginConfig in snapshot', () => {
            const ctx = new TypedGenerationContext(
                mockDirectory,
                mockRequestWithPluginConfig,
                mockExisting,
            );
            const snapshot = ctx.toSnapshot();
            expect(snapshot.pluginConfig).toEqual(mockPluginConfig);
        });

        it('should create copies of arrays', () => {
            context.extractedUrls = ['https://example.com'];
            const snapshot = context.toSnapshot();

            // Modify original
            context.extractedUrls.push('https://example2.com');

            // Snapshot should be unaffected
            expect(snapshot.extractedUrls).toHaveLength(1);
        });
    });

    describe('fromMutableContext', () => {
        it('should create TypedGenerationContext from MutableGenerationContext', () => {
            const mutableContext = {
                directory: mockDirectory,
                request: mockRequest,
                existing: mockExisting,
                extractedUrls: ['https://example.com'],
                searchQueries: ['query1'],
                webPages: [],
                processedSourceUrls: new Set(['https://processed.com']),
                contentCache: new Map([['url', 'content']]),
                initialAiItems: [],
                extractedWebItems: [],
                aggregatedItems: [],
                finalItems: [],
                finalCategories: [],
                finalTags: [],
                finalBrands: [],
                metrics: {
                    startTime: Date.now(),
                    itemsProcessed: 5,
                    urlsExtracted: 3,
                    pagesRetrieved: 2,
                    itemsExtracted: 4,
                    itemsAfterDedup: 3,
                    steps: {},
                },
                allInitialCategories: [],
                allPriorityCategories: [],
                featuredItemHints: [],
                subject: 'Test Subject',
                warnings: [],
                pluginConfig: mockPluginConfig,
            };

            const typed = TypedGenerationContext.fromMutableContext(mutableContext);

            expect(typed.extractedUrls).toEqual(['https://example.com']);
            expect(typed.processedSourceUrls.has('https://processed.com')).toBe(true);
            expect(typed.contentCache.get('url')).toBe('content');
            expect(typed.subject).toBe('Test Subject');
            expect(typed.pluginConfig).toEqual(mockPluginConfig);
        });
    });

    describe('fromSnapshot', () => {
        it('should restore pluginConfig from snapshot', () => {
            const ctx = new TypedGenerationContext(
                mockDirectory,
                mockRequestWithPluginConfig,
                mockExisting,
            );
            const snapshot = ctx.toSnapshot();
            const restored = TypedGenerationContext.fromSnapshot(snapshot);
            expect(restored.pluginConfig).toEqual(mockPluginConfig);
        });
    });

    describe('clearContentCache', () => {
        it('should clear all content from cache', () => {
            context.contentCache.set('url1', 'content1');
            context.contentCache.set('url2', 'content2');
            expect(context.contentCache.size).toBe(2);

            context.clearContentCache();

            expect(context.contentCache.size).toBe(0);
        });

        it('should handle clearing empty cache', () => {
            expect(context.contentCache.size).toBe(0);

            context.clearContentCache();

            expect(context.contentCache.size).toBe(0);
        });
    });
});
