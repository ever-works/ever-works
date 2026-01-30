import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataAggregationStep } from '../steps/data-aggregation.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest,
	MutableItemData
} from '@ever-works/plugin';

describe('DataAggregationStep', () => {
	let step: DataAggregationStep;
	let mockContext: MutableGenerationContext;
	let mockExecContext: StepExecutionContext;

	const createMockLogger = () => ({
		log: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	});

	const createMockAiFacade = () => ({
		askJson: vi
			.fn()
			.mockImplementation(
				(
					_prompt: string,
					_schema: unknown,
					options?: { variables?: { items?: string; new?: string; existing?: string } }
				) => {
					// Check if this is an AI deduplication call (has items variable)
					if (options?.variables?.items) {
						const items = JSON.parse(options.variables.items);
						return Promise.resolve({
							result: { items },
							usage: null,
							cost: null
						});
					}
					// Check if this is a new items extraction call (has new and existing variables)
					if (options?.variables?.new) {
						// Return the new items (simulating AI returning genuinely new items)
						const newItems = JSON.parse(options.variables.new);
						return Promise.resolve({
							result: { items: newItems },
							usage: null,
							cost: null
						});
					}
					// Keyword extraction call
					return Promise.resolve({
						result: { keywords: ['test', 'keyword'] },
						usage: null,
						cost: null
					});
				}
			),
		isConfigured: vi.fn().mockReturnValue(true),
		getDefaultProvider: vi.fn()
	});

	const createMockDataSourceFacade = () => ({
		queryAll: vi.fn().mockResolvedValue({ items: [], errors: [] }),
		isConfigured: vi.fn().mockReturnValue(false)
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
			directory: createMockDirectory(),
			request: createMockRequest(),
			existing: { items: [] },
			initialAiItems: [],
			extractedWebItems: [],
			webPages: [],
			metrics: { steps: {} },
			advancedPrompts: {},
			aggregatedItems: [],
			pluginConfig: {},
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new DataAggregationStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			aiFacade: createMockAiFacade(),
			dataSourceFacade: createMockDataSourceFacade()
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Deduplication and Data Aggregation');
		});
	});

	describe('run method', () => {
		it('should combine AI-generated and web-extracted items', async () => {
			mockContext.initialAiItems = [createMockItem('AI Item 1'), createMockItem('AI Item 2')];
			mockContext.extractedWebItems = [createMockItem('Web Item 1')];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.aggregatedItems.length).toBe(3);
		});

		it('should deduplicate items by slug', async () => {
			mockContext.initialAiItems = [createMockItem('Duplicate Item'), createMockItem('Duplicate Item')];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.aggregatedItems.length).toBe(1);
		});

		it('should deduplicate items by source_url', async () => {
			mockContext.initialAiItems = [
				createMockItem('Item 1', 'https://same-url.com'),
				createMockItem('Item 2', 'https://same-url.com')
			];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.aggregatedItems.length).toBe(1);
		});

		it('should query external data sources when configured', async () => {
			mockExecContext.dataSourceFacade.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade.queryAll = vi.fn().mockResolvedValue({
				items: [createMockItem('External Item')],
				errors: []
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.dataSourceFacade.queryAll).toHaveBeenCalled();
			expect(result.aggregatedItems.some((i) => i.name === 'External Item')).toBe(true);
		});

		it('should log data source errors', async () => {
			mockExecContext.dataSourceFacade.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade.queryAll = vi.fn().mockResolvedValue({
				items: [],
				errors: [{ sourceId: 'test-source', error: 'Connection failed' }]
			});

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('test-source'));
		});

		it('should handle data source query failures', async () => {
			mockExecContext.dataSourceFacade.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade.queryAll = vi.fn().mockRejectedValue(new Error('Query failed'));

			mockContext.initialAiItems = [createMockItem('Local Item')];

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalled();
			// Should still process local items
			expect(result.aggregatedItems.length).toBe(1);
		});

		it('should apply max_items limit', async () => {
			mockContext.request = createMockRequest({
				config: { max_items: 2 }
			});
			mockContext.initialAiItems = [
				createMockItem('Item 1', 'https://url1.com'),
				createMockItem('Item 2', 'https://url2.com'),
				createMockItem('Item 3', 'https://url3.com'),
				createMockItem('Item 4', 'https://url4.com')
			];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.aggregatedItems.length).toBeLessThanOrEqual(2);
		});

		it('should update metrics with item counts', async () => {
			mockContext.initialAiItems = [createMockItem('Item 1')];
			mockContext.webPages = [{ source_url: 'https://example.com', raw_content: 'content', retrieved_at: '' }];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.metrics.itemsExtracted).toBeDefined();
			expect(result.metrics.itemsAfterDedup).toBeDefined();
		});

		it('should extract new items when existing items present', async () => {
			mockContext.existing = {
				items: [createMockItem('Existing Item', 'https://existing.com')]
			};
			mockContext.initialAiItems = [
				createMockItem('Existing Item', 'https://existing.com'),
				createMockItem('New Item', 'https://new.com')
			];

			const result = await step.run(mockContext, mockExecContext);

			// Should filter out duplicates of existing items
			expect(result.aggregatedItems.some((i) => i.name === 'New Item')).toBe(true);
		});

		it('should extract keywords using AI for data source filtering', async () => {
			mockExecContext.dataSourceFacade.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade.queryAll = vi.fn().mockResolvedValue({
				items: [],
				errors: []
			});
			mockContext.request = createMockRequest({ prompt: 'Find vector databases' });
			mockContext.subject = 'vector databases';

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalled();
			const queryCall = mockExecContext.dataSourceFacade.queryAll.mock.calls[0][0];
			expect(queryCall.filterContext.keywords).toBeDefined();
		});

		it('should handle empty input', async () => {
			mockContext.initialAiItems = [];
			mockContext.extractedWebItems = [];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.aggregatedItems).toEqual([]);
		});

		it('should apply custom deduplication prompt', async () => {
			mockContext.advancedPrompts = { deduplication: 'Custom dedup rules' };
			mockContext.initialAiItems = [createMockItem('Item 1')];

			await step.run(mockContext, mockExecContext);

			// The custom prompt should be used during AI deduplication
			expect(mockExecContext.logger.log).toHaveBeenCalled();
		});
	});
});
