import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CategoryProcessingStep } from '../steps/category-processing.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest,
	MutableItemData
} from '@ever-works/plugin';

describe('CategoryProcessingStep', () => {
	let step: CategoryProcessingStep;
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
				items: [{ name: 'Item 1', description: 'Desc 1', category: 'Category A', tags: ['tag1', 'tag2'] }]
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
			config: {
				generate_categories: true,
				generate_tags: true,
				generate_brands: true,
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockItem = (name: string): MutableItemData =>
		({
			name,
			slug: name.toLowerCase().replace(/\s+/g, '-'),
			description: `Description for ${name}`
		}) as MutableItemData;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			directory: createMockDirectory(),
			request: createMockRequest(),
			existing: { items: [], categories: [], tags: [], brands: [] },
			aggregatedItems: [createMockItem('Test Item')],
			allInitialCategories: [],
			allPriorityCategories: [],
			metrics: { steps: {} },
			advancedPrompts: {},
			finalItems: [],
			finalCategories: [],
			finalTags: [],
			finalBrands: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new CategoryProcessingStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			aiFacade: createMockAiFacade()
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Categories Tags Processing');
		});
	});

	describe('run method', () => {
		it('should categorize items using AI', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems.length).toBe(1);
			expect(result.finalCategories.length).toBeGreaterThan(0);
		});

		it('should skip AI when all generation is disabled', async () => {
			mockContext.request = createMockRequest({
				config: {
					generate_categories: false,
					generate_tags: false,
					generate_brands: false
				}
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
			expect(result.finalItems[0].category).toBe('uncategorized');
			expect(result.finalCategories[0].name).toBe('Uncategorized');
		});

		it('should assign uncategorized when categories are disabled', async () => {
			mockContext.request = createMockRequest({
				config: { generate_categories: false }
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalCategories).toEqual([{ id: 'uncategorized', name: 'Uncategorized' }]);
		});

		it('should clear tags when tags are disabled', async () => {
			mockContext.request = createMockRequest({
				config: { generate_tags: false }
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalTags).toEqual([]);
		});

		it('should handle empty aggregatedItems', async () => {
			mockContext.aggregatedItems = [];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems).toEqual([]);
			expect(result.finalCategories).toEqual([]);
		});

		it('should extract unique categories from results', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{ name: 'Item 1', description: 'D1', category: 'Category A', tags: [] },
						{ name: 'Item 2', description: 'D2', category: 'Category A', tags: [] },
						{ name: 'Item 3', description: 'D3', category: 'Category B', tags: [] }
					]
				},
				usage: null,
				cost: null
			});
			mockContext.aggregatedItems = [
				createMockItem('Item 1'),
				createMockItem('Item 2'),
				createMockItem('Item 3')
			];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalCategories.length).toBe(2);
		});

		it('should extract unique tags from results', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{ name: 'Item 1', description: 'D1', category: 'Cat', tags: ['tag1', 'tag2'] },
						{ name: 'Item 2', description: 'D2', category: 'Cat', tags: ['tag2', 'tag3'] }
					]
				},
				usage: null,
				cost: null
			});
			mockContext.aggregatedItems = [createMockItem('Item 1'), createMockItem('Item 2')];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalTags.length).toBe(3);
		});

		it('should handle AI errors with fallback', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.finalItems[0].category).toBe('others');
			expect(result.finalCategories[0].name).toBe('Others');
		});

		it('should process items in batches when many items', async () => {
			const manyItems = Array.from({ length: 50 }, (_, i) => createMockItem(`Item ${i}`));
			mockContext.aggregatedItems = manyItems;
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [{ name: 'Item 0', description: 'D', category: 'Cat', tags: [] }]
				},
				usage: null,
				cost: null
			});

			await step.run(mockContext, mockExecContext);

			// Should be called multiple times for batch processing
			expect(mockExecContext.aiFacade.askJson.mock.calls.length).toBeGreaterThan(1);
		});

		it('should accumulate metrics correctly', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [{ name: 'Item 1', description: 'D1', category: 'Cat', tags: [] }]
				},
				usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
				cost: 0.01
			});

			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['categories-tags-processing'];
			expect(stepMetrics?.custom?.totalTokens).toBe(150);
		});

		it('should respect priority categories order', async () => {
			mockContext.allPriorityCategories = ['Priority Category'];
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{ name: 'Item 1', description: 'D1', category: 'Priority Category', tags: [] },
						{ name: 'Item 2', description: 'D2', category: 'Other Category', tags: [] }
					]
				},
				usage: null,
				cost: null
			});
			mockContext.aggregatedItems = [createMockItem('Item 1'), createMockItem('Item 2')];

			const result = await step.run(mockContext, mockExecContext);

			// Priority category should come first
			const priorityCat = result.finalCategories.find((c) => c.name === 'Priority Category');
			expect(priorityCat?.priority).toBeDefined();
		});

		it('should extract brands from items', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'Product',
							description: 'Desc',
							category: 'Cat',
							tags: [],
							brand: 'Acme Corp',
							brand_logo_url: 'https://acme.com/logo.png'
						}
					]
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalBrands.length).toBe(1);
			expect(result.finalBrands[0].name).toBe('Acme Corp');
		});

		it('should clear brands when brands are disabled', async () => {
			mockContext.request = createMockRequest({
				config: { generate_brands: false }
			});
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'Product',
							description: 'Desc',
							category: 'Cat',
							tags: [],
							brand: 'Acme'
						}
					]
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalBrands).toEqual([]);
		});

		it('should apply custom categorization prompt', async () => {
			mockContext.advancedPrompts = { categorization: 'Custom categorization rules' };

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[0]).toContain('Custom categorization rules');
		});

		it('should slugify category and tag values', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'Item',
							description: 'Desc',
							category: 'My Category Name',
							tags: ['My Tag Name']
						}
					]
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].category).toBe('my-category-name');
			expect(result.finalItems[0].tags).toContain('my-tag-name');
		});

		it('should use existing categories for consistency', async () => {
			mockContext.existing = {
				items: [],
				categories: [{ id: 'existing-cat', name: 'Existing Cat' }],
				tags: [{ id: 'existing-tag', name: 'Existing Tag' }],
				brands: []
			};

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[2].variables.existing_categories).toContain('Existing Cat');
		});
	});
});
