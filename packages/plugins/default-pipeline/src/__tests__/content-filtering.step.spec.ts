import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContentFilteringStep } from '../steps/content-filtering.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest,
	WebPageData
} from '@ever-works/plugin';

describe('ContentFilteringStep', () => {
	let step: ContentFilteringStep;
	let mockContext: MutableGenerationContext;
	let mockExecContext: StepExecutionContext;

	const createMockLogger = () => ({
		log: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	});

	const createMockAiFacade = () => ({
		askJson: vi.fn().mockResolvedValue({
			result: {
				relevant: true,
				relevance_score: 0.8,
				reason: 'Content is highly relevant to the topic'
			},
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			cost: 0.01
		}),
		isConfigured: vi.fn().mockReturnValue(true),
		getDefaultProvider: vi.fn()
	});

	const createMockDirectory = (): DirectoryReference => ({
		id: 'test-dir-id',
		slug: 'test-directory',
		name: 'Test Directory'
	});

	const createMockRequest = (overrides?: Partial<GenerationRequest>): GenerationRequest =>
		({
			prompt: 'Test prompt',
			name: 'Test Directory',
			config: {
				content_filtering_enabled: true,
				min_content_length_for_extraction: 100,
				relevance_threshold_content: 0.5,
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockWebPage = (content: string, url = 'https://example.com'): WebPageData => ({
		source_url: url,
		raw_content: content,
		retrieved_at: new Date().toISOString()
	});

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			directory: createMockDirectory(),
			request: createMockRequest(),
			webPages: [createMockWebPage('A'.repeat(200))],
			metrics: { steps: {} },
			advancedPrompts: {},
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new ContentFilteringStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			aiFacade: createMockAiFacade()
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Content Filtering');
		});
	});

	describe('run method', () => {
		it('should filter relevant pages', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(1);
		});

		it('should skip when content_filtering_enabled is false', async () => {
			mockContext.request = createMockRequest({
				config: { content_filtering_enabled: false }
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
			expect(result.webPages.length).toBe(1);
		});

		it('should filter out pages with insufficient content', async () => {
			mockContext.webPages = [createMockWebPage('short')];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(0);
		});

		it('should filter out irrelevant pages', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					relevant: false,
					relevance_score: 0.2,
					reason: 'Not relevant to topic'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(0);
		});

		it('should filter out pages below relevance threshold', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					relevant: true,
					relevance_score: 0.3, // Below default 0.5 threshold
					reason: 'Somewhat relevant'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(0);
		});

		it('should keep pages at or above relevance threshold', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					relevant: true,
					relevance_score: 0.5,
					reason: 'Relevant'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(1);
		});

		it('should deduplicate pages by URL', async () => {
			mockContext.webPages = [
				createMockWebPage('A'.repeat(200), 'https://example.com'),
				createMockWebPage('B'.repeat(200), 'https://example.com') // Duplicate URL
			];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(1);
		});

		it('should handle AI errors gracefully', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			// Should keep page on error (fail-safe)
			expect(result.webPages.length).toBe(1);
		});

		it('should process multiple pages', async () => {
			mockContext.webPages = [
				createMockWebPage('A'.repeat(200), 'https://page1.com'),
				createMockWebPage('B'.repeat(200), 'https://page2.com')
			];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalledTimes(2);
		});

		it('should accumulate metrics correctly', async () => {
			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['content-filtering'];
			expect(stepMetrics?.custom?.totalTokens).toBe(150);
		});

		it('should skip AI filtering when AI is not configured', async () => {
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
			expect(result.webPages.length).toBe(1);
		});

		it('should use custom relevance prompt when provided', async () => {
			mockContext.advancedPrompts = { relevanceAssessment: 'Custom relevance rules' };

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[0]).toContain('Custom relevance rules');
		});

		it('should truncate content for AI assessment', async () => {
			const longContent = 'A'.repeat(5000);
			mockContext.webPages = [createMockWebPage(longContent)];

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[2].variables.snippet.length).toBeLessThanOrEqual(3000);
		});

		it('should respect custom min_content_length', async () => {
			mockContext.request = createMockRequest({
				config: { min_content_length_for_extraction: 500 }
			});
			mockContext.webPages = [createMockWebPage('A'.repeat(200))]; // Below 500

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(0);
		});

		it('should respect custom relevance_threshold', async () => {
			mockContext.request = createMockRequest({
				config: { relevance_threshold_content: 0.9 }
			});
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					relevant: true,
					relevance_score: 0.8, // Below 0.9 threshold
					reason: 'Relevant'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages.length).toBe(0);
		});

		it('should log filtering progress', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(expect.stringContaining('Content Filtering'));
			expect(mockExecContext.logger.log).toHaveBeenCalledWith(expect.stringContaining('relevant pages'));
		});

		it('should handle empty webPages array', async () => {
			mockContext.webPages = [];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.webPages).toEqual([]);
		});
	});
});
