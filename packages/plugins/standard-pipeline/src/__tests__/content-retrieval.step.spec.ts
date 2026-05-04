import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContentRetrievalStep } from '../steps/content-retrieval.step';
import type { StepExecutionContext, WorkReference, GenerationRequest } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';

describe('ContentRetrievalStep', () => {
	let step: ContentRetrievalStep;
	let mockContext: MutableGenerationContext;
	let mockExecContext: StepExecutionContext;

	const createMockLogger = () => ({
		log: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	});

	const createMockSearchFacade = () => ({
		search: vi.fn(),
		extractContent: vi.fn().mockResolvedValue({ rawContent: 'test content' }),
		isConfigured: vi.fn().mockReturnValue(true)
	});

	const createMockContentExtractorFacade = () => ({
		canHandle: vi.fn().mockReturnValue(false),
		isConfigured: vi.fn().mockReturnValue(true),
		extractContent: vi.fn().mockResolvedValue({ rawContent: 'extracted content' })
	});

	const createMockWork = (): WorkReference => ({
		id: 'test-dir-id',
		slug: 'test-work',
		name: 'Test Work'
	});

	const createMockRequest = (overrides?: Partial<GenerationRequest>): GenerationRequest =>
		({
			prompt: 'Test prompt',
			config: {
				source_urls: [],
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			work: createMockWork(),
			request: createMockRequest(),
			extractedUrls: [],
			processedSourceUrls: new Set<string>(),
			webPages: [],
			contentCache: new Map<string, string>(),
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	const expectedFacadeOptions = { userId: 'test-user-id', workId: 'test-dir-id' };

	beforeEach(() => {
		step = new ContentRetrievalStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			searchFacade: createMockSearchFacade(),
			contentExtractorFacade: createMockContentExtractorFacade(),
			aiFacade: {} as StepExecutionContext['aiFacade'],
			screenshotFacade: {} as StepExecutionContext['screenshotFacade'],
			user: { id: 'test-user-id' },
			work: { id: 'test-dir-id' }
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Content Retrieval');
		});

		it('should have correct stepId', () => {
			expect(step.stepId).toBe('content-retrieval');
		});
	});

	describe('run method', () => {
		it('should return context unchanged when no URLs to process', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result).toBe(mockContext);
			expect(mockExecContext.logger.log).toHaveBeenCalledWith(
				expect.stringContaining('No URLs to retrieve content from')
			);
		});

		it('should combine extractedUrls and sourceUrls from config', async () => {
			mockContext.extractedUrls = ['https://example1.com'];
			mockContext.request = createMockRequest({
				config: { source_urls: ['https://example2.com'] }
			});

			await step.run(mockContext, mockExecContext);

			// Should have processed both URLs
			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledTimes(2);
		});

		it('should deduplicate URLs', async () => {
			mockContext.extractedUrls = ['https://example.com'];
			mockContext.request = createMockRequest({
				config: { source_urls: ['https://example.com'] } // Same URL
			});

			await step.run(mockContext, mockExecContext);

			// Should only process once
			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledTimes(1);
		});

		it('should skip already processed URLs', async () => {
			mockContext.extractedUrls = ['https://example.com'];
			mockContext.processedSourceUrls.add('https://example.com');

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(
				expect.stringContaining('All URLs have already been processed')
			);
		});

		it('should use contentExtractorFacade for all URLs', async () => {
			mockContext.extractedUrls = ['https://example.com'];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledWith(
				'https://example.com',
				undefined,
				expectedFacadeOptions
			);
		});

		it('should add retrieved pages to webPages array', async () => {
			mockContext.extractedUrls = ['https://example.com'];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(1);
			expect(result.webPages[0].source_url).toBe('https://example.com');
			expect(result.webPages[0].raw_content).toBe('extracted content');
		});

		it('should populate contentCache', async () => {
			mockContext.extractedUrls = ['https://example.com'];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.contentCache.get('https://example.com')).toBe('extracted content');
		});

		it('should mark URLs as processed', async () => {
			mockContext.extractedUrls = ['https://example.com'];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.processedSourceUrls.has('https://example.com')).toBe(true);
		});

		it('should handle extraction errors gracefully', async () => {
			mockContext.extractedUrls = ['https://example.com'];
			mockExecContext.contentExtractorFacade.extractContent = vi
				.fn()
				.mockRejectedValue(new Error('Network error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.webPages.length).toBe(0);
		});

		it('should skip URLs with no content', async () => {
			mockContext.extractedUrls = ['https://example.com'];
			mockExecContext.contentExtractorFacade.extractContent = vi.fn().mockResolvedValue({ rawContent: null });

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalled();
			expect(result.webPages.length).toBe(0);
		});

		it('should log progress messages', async () => {
			mockContext.extractedUrls = ['https://example.com'];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(
				expect.stringContaining('Content Retrieval - Starting')
			);
			expect(mockExecContext.logger.log).toHaveBeenCalledWith(
				expect.stringContaining('Content Retrieval complete')
			);
		});

		it('should preserve existing webPages', async () => {
			mockContext.webPages = [
				{
					source_url: 'https://existing.com',
					raw_content: 'existing content',
					retrieved_at: new Date().toISOString()
				}
			];
			mockContext.extractedUrls = ['https://new.com'];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(2);
			expect(result.webPages[0].source_url).toBe('https://existing.com');
			expect(result.webPages[1].source_url).toBe('https://new.com');
		});

		it('should process URLs in batches', async () => {
			// Create 15 URLs (more than batch size of 10)
			mockContext.extractedUrls = Array.from({ length: 15 }, (_, i) => `https://example${i}.com`);

			await step.run(mockContext, mockExecContext);

			// Should have processed all URLs
			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledTimes(15);
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty sourceUrls in config', async () => {
			mockContext.extractedUrls = ['https://example.com'];
			mockContext.request = createMockRequest({ config: { source_urls: [] } });

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(1);
		});

		it('should process all URLs through contentExtractorFacade', async () => {
			mockContext.extractedUrls = ['https://notion.so/page', 'https://example.com'];

			await step.run(mockContext, mockExecContext);

			// All URLs go through the unified contentExtractorFacade
			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledTimes(2);
			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledWith(
				'https://notion.so/page',
				undefined,
				expectedFacadeOptions
			);
			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledWith(
				'https://example.com',
				undefined,
				expectedFacadeOptions
			);
		});
	});
});
