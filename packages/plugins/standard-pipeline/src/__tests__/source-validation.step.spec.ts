import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SourceValidationStep } from '../steps/source-validation.step';
import type { StepExecutionContext, WorkReference, GenerationRequest, MutableItemData } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';

describe('SourceValidationStep', () => {
	let step: SourceValidationStep;
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
				is_official: true,
				is_relevant: true,
				confidence_score: 0.9,
				url_type: 'official_website',
				reasoning: 'This is the official website'
			},
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			cost: 0.01
		}),
		isConfigured: vi.fn().mockReturnValue(true),
		getDefaultProvider: vi.fn()
	});

	const createMockSearchFacade = () => ({
		search: vi.fn().mockResolvedValue([{ url: 'https://official.com', title: 'Official Site' }]),
		isConfigured: vi.fn().mockReturnValue(true)
	});

	const createMockContentExtractorFacade = () => ({
		extractContent: vi.fn().mockResolvedValue({ rawContent: 'Page content' }),
		isConfigured: vi.fn().mockReturnValue(true)
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
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockItem = (name: string, source_url?: string): MutableItemData =>
		({
			name,
			slug: name.toLowerCase().replace(/\s+/g, '-'),
			description: `Description for ${name}`,
			source_url
		}) as MutableItemData;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			work: createMockWork(),
			request: createMockRequest(),
			finalItems: [createMockItem('Test Item', 'https://example.com')],
			metrics: { steps: {} },
			advancedPrompts: {},
			subject: 'test topic',
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new SourceValidationStep();
		mockContext = createMockContext();

		// Mock global fetch
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200
		});

		mockExecContext = {
			logger: createMockLogger(),
			aiFacade: createMockAiFacade(),
			searchFacade: createMockSearchFacade(),
			contentExtractorFacade: createMockContentExtractorFacade(),
			user: { id: 'test-user-id' },
			work: { id: 'test-dir-id' }
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Sources Validation');
		});
	});

	describe('run method', () => {
		it('should validate items with valid source URLs', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems.length).toBe(1);
			expect(result.finalItems[0].source_url).toBe('https://example.com');
		});

		it('should filter out items with invalid URLs', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
			mockExecContext.searchFacade.search = vi.fn().mockResolvedValue([]);

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems.length).toBe(0);
		});

		it('should filter out Google search URLs', async () => {
			mockContext.finalItems = [createMockItem('Item', 'https://google.com/search?q=test')];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems.length).toBe(0);
		});

		it('should search for better URL when initial URL is invalid', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.searchFacade.search).toHaveBeenCalled();
		});

		it('should validate found URLs with AI', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalled();
		});

		it('should handle empty items array', async () => {
			mockContext.finalItems = [];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems).toEqual([]);
		});

		it('should process items in batches', async () => {
			mockContext.finalItems = Array.from({ length: 20 }, (_, i) =>
				createMockItem(`Item ${i}`, `https://example${i}.com`)
			);

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(
				expect.stringContaining('Source validation complete')
			);
		});

		it('should accumulate metrics correctly', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['sources-validation'];
			expect(stepMetrics?.custom?.totalTokens).toBeDefined();
		});

		it('should use subject in search queries', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
			mockContext.subject = 'vector databases';

			await step.run(mockContext, mockExecContext);

			const searchCall = mockExecContext.searchFacade.search.mock.calls[0];
			expect(searchCall[0]).toContain('vector databases');
		});

		it('should apply custom validation prompt', async () => {
			mockContext.advancedPrompts = { sourceValidation: 'Custom validation rules' };
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			await step.run(mockContext, mockExecContext);

			const aiCall = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(aiCall[0]).toContain('Custom validation rules');
		});

		it('should handle search failures gracefully', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
			mockExecContext.searchFacade.search = vi.fn().mockRejectedValue(new Error('Search failed'));

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems.length).toBe(0);
		});

		it('should prefer official URLs over blog posts', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
			mockExecContext.searchFacade.search = vi
				.fn()
				.mockResolvedValue([{ url: 'https://blog.example.com/about-item' }, { url: 'https://item.com' }]);
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockResolvedValueOnce({
					result: {
						is_official: false,
						is_relevant: true,
						confidence_score: 0.5,
						url_type: 'blog_post',
						reasoning: 'Blog post'
					},
					usage: null,
					cost: null
				})
				.mockResolvedValueOnce({
					result: {
						is_official: true,
						is_relevant: true,
						confidence_score: 0.9,
						url_type: 'official_website',
						reasoning: 'Official'
					},
					usage: null,
					cost: null
				});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0]?.source_url).toBe('https://item.com');
		});

		it('should skip AI validation when not configured', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
		});

		it('should log validation progress', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(expect.stringContaining('Validating source URLs'));
		});

		it('should try HEAD request first, then GET', async () => {
			global.fetch = vi
				.fn()
				.mockRejectedValueOnce(new Error('HEAD failed'))
				.mockResolvedValueOnce({ ok: true, status: 200 });

			await step.run(mockContext, mockExecContext);

			expect(global.fetch).toHaveBeenCalledTimes(2);
		});
	});
});
