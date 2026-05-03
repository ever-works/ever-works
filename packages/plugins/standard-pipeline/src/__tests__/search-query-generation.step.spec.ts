import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SearchQueryGenerationStep } from '../steps/search-query-generation.step';
import type { StepExecutionContext, WorkReference, GenerationRequest } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';

describe('SearchQueryGenerationStep', () => {
	let step: SearchQueryGenerationStep;
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
			result: { queries: ['query 1', 'query 2', 'query 3'] },
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			cost: 0.01
		}),
		isConfigured: vi.fn().mockReturnValue(true),
		getDefaultProvider: vi.fn()
	});

	const createMockWork = (): WorkReference => ({
		id: 'test-dir-id',
		slug: 'test-work',
		name: 'Test Work'
	});

	const createMockRequest = (overrides?: Partial<GenerationRequest>): GenerationRequest =>
		({
			prompt: 'Test prompt',
			name: 'Test Work',
			config: {
				max_search_queries: 10,
				target_keywords: [],
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			work: createMockWork(),
			request: createMockRequest(),
			metrics: { steps: {} },
			advancedPrompts: {},
			searchQueries: [],
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new SearchQueryGenerationStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			aiFacade: createMockAiFacade(),
			user: { id: 'test-user-id' },
			work: { id: 'test-dir-id' }
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Search Query Generation');
		});
	});

	describe('run method', () => {
		it('should generate search queries using AI', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.searchQueries).toEqual(['query 1', 'query 2', 'query 3']);
			expect(mockExecContext.logger.log).toHaveBeenCalledWith(
				expect.stringContaining('Generated 3 search queries')
			);
		});

		it('should use fallback queries when AI is not configured', async () => {
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);

			const result = await step.run(mockContext, mockExecContext);

			expect(result.searchQueries.length).toBeGreaterThan(0);
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('AI provider not configured')
			);
		});

		it('should include fallback queries with topic name', async () => {
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);
			mockContext.request = createMockRequest({ name: 'Vector Databases' });

			const result = await step.run(mockContext, mockExecContext);

			expect(result.searchQueries.some((q) => q.includes('Vector Databases'))).toBe(true);
		});

		it('should use fallback on AI error', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(result.searchQueries.length).toBeGreaterThan(0);
			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Falling back'));
		});

		it('should deduplicate queries', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: { queries: ['same query', 'same query', 'different query'] },
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.searchQueries).toEqual(['same query', 'different query']);
		});

		it('should filter out short queries', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: { queries: ['ab', 'abc', 'abcd', 'valid query'] },
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.searchQueries).not.toContain('ab');
			expect(result.searchQueries).toContain('valid query');
		});

		it('should respect max_search_queries limit', async () => {
			mockContext.request = createMockRequest({
				config: { max_search_queries: 2 }
			});
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: { queries: ['query 1', 'query 2', 'query 3', 'query 4'] },
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.searchQueries.length).toBeLessThanOrEqual(2);
		});

		it('should accumulate metrics correctly', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: { queries: ['test'] },
				usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
				cost: 0.01
			});

			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['search-queries-generation'];
			expect(stepMetrics?.custom?.totalTokens).toBe(150);
			expect(stepMetrics?.custom?.totalCost).toBeCloseTo(0.01);
		});

		it('should include target keywords in fallback queries', async () => {
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);
			mockContext.request = createMockRequest({
				name: 'AI Tools',
				config: { target_keywords: ['machine learning', 'deep learning'] }
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(
				result.searchQueries.some((q) => q.includes('machine learning') || q.includes('deep learning'))
			).toBe(true);
		});

		it('should pass current date to AI prompt', async () => {
			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[2].variables.date).toBeDefined();
			expect(call[2].variables.date).toMatch(/\w+, \w+ \d{4}/);
		});

		it('should apply custom prompt when provided', async () => {
			mockContext.advancedPrompts = { searchQuery: 'Additional instructions' };

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[0]).toContain('Additional instructions');
		});

		it('should trim whitespace from queries', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: { queries: ['  query with spaces  ', 'normal query'] },
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.searchQueries).toContain('query with spaces');
			expect(result.searchQueries).not.toContain('  query with spaces  ');
		});
	});
});
