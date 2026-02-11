import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromptProcessingStep } from '../steps/prompt-processing.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest
} from '@ever-works/plugin';

describe('PromptProcessingStep', () => {
	let step: PromptProcessingStep;
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
				extractedUrls: [],
				suggestedCategories: [],
				priorityCategories: [],
				featuredItemHints: [],
				subject: 'test topic',
				rewrittenPrompt: 'Rewritten prompt'
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
			prompt: 'Build a directory about vector databases',
			config: {
				source_urls: [],
				priority_categories: [],
				initial_categories: [],
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			directory: createMockDirectory(),
			request: createMockRequest(),
			existing: {},
			metrics: { steps: {} },
			extractedUrls: [],
			allInitialCategories: [],
			allPriorityCategories: [],
			featuredItemHints: [],
			subject: '',
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new PromptProcessingStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			aiFacade: createMockAiFacade(),
			user: { id: 'test-user-id' },
			directory: { id: 'test-dir-id' }
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Prompt Processing');
		});
	});

	describe('run method', () => {
		it('should extract URLs from prompt', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: ['https://example.com', 'https://test.com'],
					suggestedCategories: [],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Prompt without URLs'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedUrls).toContain('https://example.com');
			expect(result.extractedUrls).toContain('https://test.com');
		});

		it('should extract categories from prompt', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: [],
					suggestedCategories: ['Category A', 'Category B'],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.allInitialCategories).toContain('Category A');
			expect(result.allInitialCategories).toContain('Category B');
		});

		it('should extract priority categories', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: [],
					suggestedCategories: [],
					priorityCategories: ['Priority Cat'],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.allPriorityCategories).toContain('Priority Cat');
		});

		it('should extract featured item hints', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: [],
					suggestedCategories: [],
					priorityCategories: [],
					featuredItemHints: ['Open source', 'Popular'],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			// The cleanCategories function normalizes to title case
			expect(result.featuredItemHints).toContain('Open Source');
			expect(result.featuredItemHints).toContain('Popular');
		});

		it('should extract subject from prompt', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: [],
					suggestedCategories: [],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'vector databases',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.subject).toBe('vector databases');
		});

		it('should rewrite prompt without URLs', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: ['https://example.com'],
					suggestedCategories: [],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Prompt without URLs'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.request.prompt).toBe('Prompt without URLs');
		});

		it('should merge with config source_urls', async () => {
			mockContext.request = createMockRequest({
				config: { source_urls: ['https://config-url.com'] }
			});
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: ['https://prompt-url.com'],
					suggestedCategories: [],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedUrls).toContain('https://config-url.com');
			expect(result.extractedUrls).toContain('https://prompt-url.com');
		});

		it('should merge with config priority_categories', async () => {
			mockContext.request = createMockRequest({
				config: { priority_categories: ['Config Priority'] }
			});
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: [],
					suggestedCategories: [],
					priorityCategories: ['Prompt Priority'],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.allPriorityCategories).toContain('Config Priority');
			expect(result.allPriorityCategories).toContain('Prompt Priority');
		});

		it('should handle empty prompt', async () => {
			mockContext.request = createMockRequest({ prompt: '' });

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedUrls).toEqual([]);
			expect(result.subject).toBe('');
		});

		it('should use regex fallback on AI error', async () => {
			mockContext.request = createMockRequest({
				prompt: 'Check out https://example.com for resources'
			});
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.extractedUrls).toContain('https://example.com');
		});

		it('should accumulate metrics correctly', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: [],
					suggestedCategories: [],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
				cost: 0.01
			});

			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['prompt-processing'];
			expect(stepMetrics?.custom?.totalTokens).toBe(150);
		});

		it('should validate extracted URLs', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: ['https://valid.com', 'invalid-url', 'also-invalid'],
					suggestedCategories: [],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedUrls).toContain('https://valid.com');
			expect(result.extractedUrls).not.toContain('invalid-url');
		});

		it('should clean and normalize categories', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: [],
					suggestedCategories: ['  category a  ', 'CATEGORY B'],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.allInitialCategories).toContain('Category A');
			expect(result.allInitialCategories).toContain('Category B');
		});

		it('should deduplicate categories', async () => {
			mockContext.request = createMockRequest({
				config: { initial_categories: ['Category A'] }
			});
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					extractedUrls: [],
					suggestedCategories: ['Category A'],
					priorityCategories: [],
					featuredItemHints: [],
					subject: 'test',
					rewrittenPrompt: 'Clean prompt'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			const categoryCount = result.allInitialCategories.filter((c) => c === 'Category A').length;
			expect(categoryCount).toBe(1);
		});

		it('should extract subject using fallback when AI fails', async () => {
			mockContext.request = createMockRequest({
				prompt: 'Awesome Vector Databases'
			});
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(result.subject).toBe('vector databases');
		});
	});
});
