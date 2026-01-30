import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSearchStep } from '../steps/web-search.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest
} from '@ever-works/plugin';

describe('WebSearchStep', () => {
	let step: WebSearchStep;
	let mockContext: MutableGenerationContext;
	let mockExecContext: StepExecutionContext;

	const createMockLogger = () => ({
		log: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	});

	const createMockSearchFacade = () => ({
		search: vi.fn().mockResolvedValue([
			{ url: 'https://example1.com', title: 'Result 1', content: 'Content 1' },
			{ url: 'https://example2.com', title: 'Result 2', content: 'Content 2' }
		]),
		isConfigured: vi.fn().mockReturnValue(true)
	});

	const createMockContentExtractorFacade = () => ({
		extractContent: vi.fn().mockResolvedValue({ rawContent: 'extracted content' }),
		isConfigured: vi.fn().mockReturnValue(true)
	});

	const createMockDirectory = (): DirectoryReference => ({
		id: 'test-dir-id',
		slug: 'test-directory',
		name: 'Test Directory'
	});

	const createMockRequest = (overrides?: Partial<GenerationRequest>): GenerationRequest =>
		({
			prompt: 'Test prompt',
			config: {
				max_search_queries: 10,
				max_results_per_query: 10,
				max_pages_to_process: 50,
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			directory: createMockDirectory(),
			request: createMockRequest(),
			searchQueries: ['test query 1', 'test query 2'],
			extractedUrls: [],
			processedSourceUrls: new Set<string>(),
			webPages: [],
			contentCache: new Map<string, string>(),
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new WebSearchStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			searchFacade: createMockSearchFacade(),
			contentExtractorFacade: createMockContentExtractorFacade()
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Web Search');
		});
	});

	describe('run method', () => {
		it('should execute search queries', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.searchFacade.search).toHaveBeenCalledTimes(2);
			expect(mockExecContext.searchFacade.search).toHaveBeenCalledWith('test query 1', { maxResults: 10 });
			expect(mockExecContext.searchFacade.search).toHaveBeenCalledWith('test query 2', { maxResults: 10 });
		});

		it('should extract content from search results', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalled();
		});

		it('should populate webPages array', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBeGreaterThan(0);
			expect(result.webPages[0].source_url).toBeDefined();
			expect(result.webPages[0].raw_content).toBe('extracted content');
		});

		it('should populate contentCache', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.contentCache.size).toBeGreaterThan(0);
		});

		it('should deduplicate URLs across queries', async () => {
			mockExecContext.searchFacade.search = vi
				.fn()
				.mockResolvedValue([{ url: 'https://duplicate.com', title: 'Duplicate', content: 'Content' }]);

			await step.run(mockContext, mockExecContext);

			// Should only extract once despite being returned by both queries
			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledTimes(1);
		});

		it('should skip already processed URLs', async () => {
			mockContext.processedSourceUrls.add('https://example1.com');

			await step.run(mockContext, mockExecContext);

			const extractCalls = mockExecContext.contentExtractorFacade.extractContent.mock.calls;
			const extractedUrls = extractCalls.map((call) => call[0]);
			expect(extractedUrls).not.toContain('https://example1.com');
		});

		it('should handle search errors gracefully', async () => {
			mockExecContext.searchFacade.search = vi
				.fn()
				.mockRejectedValueOnce(new Error('Search Error'))
				.mockResolvedValueOnce([{ url: 'https://example.com', title: 'Result', content: 'Content' }]);

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			// Should continue with successful searches
			expect(result.webPages.length).toBeGreaterThan(0);
		});

		it('should handle extraction errors gracefully', async () => {
			mockExecContext.contentExtractorFacade.extractContent = vi
				.fn()
				.mockRejectedValue(new Error('Extraction Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.webPages.length).toBe(0);
		});

		it('should skip URLs with no content', async () => {
			mockExecContext.contentExtractorFacade.extractContent = vi.fn().mockResolvedValue({ rawContent: null });

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalled();
			expect(result.webPages.length).toBe(0);
		});

		it('should process extracted URLs first', async () => {
			mockContext.extractedUrls = ['https://extracted.com'];
			mockExecContext.contentExtractorFacade.extractContent = vi
				.fn()
				.mockResolvedValue({ rawContent: 'content' });

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledWith('https://extracted.com');
			expect(result.webPages.some((p) => p.source_url === 'https://extracted.com')).toBe(true);
		});

		it('should respect max_pages_to_process limit', async () => {
			mockContext.request = createMockRequest({
				config: { max_pages_to_process: 2 }
			});
			mockExecContext.searchFacade.search = vi.fn().mockResolvedValue([
				{ url: 'https://example1.com', title: 'R1', content: 'C1' },
				{ url: 'https://example2.com', title: 'R2', content: 'C2' },
				{ url: 'https://example3.com', title: 'R3', content: 'C3' },
				{ url: 'https://example4.com', title: 'R4', content: 'C4' }
			]);

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledTimes(2);
		});

		it('should respect max_search_queries limit', async () => {
			mockContext.request = createMockRequest({
				config: { max_search_queries: 1 }
			});
			mockContext.searchQueries = ['query1', 'query2', 'query3'];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.searchFacade.search).toHaveBeenCalledTimes(1);
		});

		it('should skip invalid URLs', async () => {
			mockExecContext.searchFacade.search = vi.fn().mockResolvedValue([
				{ url: null, title: 'No URL', content: 'Content' },
				{ url: '', title: 'Empty URL', content: 'Content' },
				{ url: 'https://valid.com', title: 'Valid', content: 'Content' }
			]);

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledTimes(1);
			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledWith('https://valid.com');
		});

		it('should mark URLs as processed after extraction', async () => {
			mockExecContext.searchFacade.search = vi
				.fn()
				.mockResolvedValue([{ url: 'https://example.com', title: 'Result', content: 'Content' }]);

			const result = await step.run(mockContext, mockExecContext);

			expect(result.processedSourceUrls.has('https://example.com')).toBe(true);
		});

		it('should add retrieved_at timestamp to web pages', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages[0].retrieved_at).toBeDefined();
			expect(new Date(result.webPages[0].retrieved_at).getTime()).toBeLessThanOrEqual(Date.now());
		});
	});
});
