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
					if (options?.variables?.items) {
						return Promise.resolve({
							result: { items: JSON.parse(options.variables.items) },
							usage: null,
							cost: null
						});
					}
					if (options?.variables?.new) {
						return Promise.resolve({
							result: { items: JSON.parse(options.variables.new) },
							usage: null,
							cost: null
						});
					}
					return Promise.resolve({ result: { keywords: ['test', 'keyword'] }, usage: null, cost: null });
				}
			),
		isConfigured: vi.fn().mockReturnValue(true),
		getDefaultProvider: vi.fn()
	});

	const createMockDataSourceFacade = () => ({
		queryAll: vi.fn().mockResolvedValue({ items: [], errors: [] }),
		isConfigured: vi.fn().mockReturnValue(false)
	});

	const createMockItem = (name: string, source_url?: string): MutableItemData =>
		({
			name,
			slug: name.toLowerCase().replace(/\s+/g, '-'),
			description: `Description for ${name}`,
			source_url
		}) as MutableItemData;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			directory: { id: 'test-dir-id', slug: 'test-directory', name: 'Test Directory' } as DirectoryReference,
			request: { prompt: 'Test prompt', config: {} } as GenerationRequest,
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
			dataSourceFacade: createMockDataSourceFacade(),
			user: { id: 'test-user-id' },
			directory: { id: 'test-dir-id' }
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
			mockExecContext.dataSourceFacade!.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade!.queryAll = vi.fn().mockResolvedValue({
				items: [createMockItem('External Item', 'https://external.com')],
				errors: []
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.dataSourceFacade!.queryAll).toHaveBeenCalled();
			expect(result.aggregatedItems.some((i) => i.name === 'External Item')).toBe(true);
		});

		it('should not run AI dedup on data source items', async () => {
			const aiAskJson = mockExecContext.aiFacade.askJson as ReturnType<typeof vi.fn>;

			mockExecContext.dataSourceFacade!.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade!.queryAll = vi.fn().mockResolvedValue({
				items: Array.from({ length: 100 }, (_, i) => createMockItem(`DS Item ${i}`, `https://ds-${i}.com`)),
				errors: []
			});

			await step.run(mockContext, mockExecContext);

			// AI dedup should NOT be called for data source items
			// Only keyword extraction should use askJson
			const dedupCalls = aiAskJson.mock.calls.filter((call: unknown[]) => {
				const opts = call[2] as { routing?: { taskId?: string } } | undefined;
				return opts?.routing?.taskId === 'ai-deduplication';
			});
			expect(dedupCalls).toHaveLength(0);
		});

		it('should field-dedup data source items against existing + AI items', async () => {
			mockContext.initialAiItems = [createMockItem('AI Tool', 'https://aitool.com')];
			mockContext.existing = {
				items: [createMockItem('Existing Tool', 'https://existing.com')]
			};

			mockExecContext.dataSourceFacade!.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade!.queryAll = vi.fn().mockResolvedValue({
				items: [
					createMockItem('Existing Tool', 'https://existing.com'),
					createMockItem('AI Tool', 'https://aitool.com'),
					createMockItem('New DS Tool', 'https://new-ds.com')
				],
				errors: []
			});

			const result = await step.run(mockContext, mockExecContext);

			const dsItem = result.aggregatedItems.find((i) => i.name === 'New DS Tool');
			expect(dsItem).toBeDefined();

			const dupExisting = result.aggregatedItems.filter((i) => i.name === 'Existing Tool');
			expect(dupExisting.length).toBeLessThanOrEqual(1);
		});

		it('should log data source errors', async () => {
			mockExecContext.dataSourceFacade!.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade!.queryAll = vi.fn().mockResolvedValue({
				items: [],
				errors: [{ sourceId: 'test-source', error: 'Connection failed' }]
			});

			await step.run(mockContext, mockExecContext);
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('test-source'));
		});

		it('should handle data source query failures', async () => {
			mockExecContext.dataSourceFacade!.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade!.queryAll = vi.fn().mockRejectedValue(new Error('Query failed'));

			mockContext.initialAiItems = [createMockItem('Local Item')];

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalled();
			expect(result.aggregatedItems.length).toBe(1);
		});

		it('should apply max_items limit', async () => {
			mockContext.request = { prompt: 'Test', config: { max_items: 2 } } as GenerationRequest;
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
			mockContext.existing = { items: [createMockItem('Existing Item', 'https://existing.com')] };
			mockContext.initialAiItems = [
				createMockItem('Existing Item', 'https://existing.com'),
				createMockItem('New Item', 'https://new.com')
			];

			const result = await step.run(mockContext, mockExecContext);
			expect(result.aggregatedItems.some((i) => i.name === 'New Item')).toBe(true);
		});

		it('should extract keywords using AI for data source filtering', async () => {
			mockExecContext.dataSourceFacade!.isConfigured = vi.fn().mockReturnValue(true);
			mockExecContext.dataSourceFacade!.queryAll = vi.fn().mockResolvedValue({ items: [], errors: [] });
			mockContext.request = { prompt: 'Find vector databases' } as GenerationRequest;
			mockContext.subject = 'vector databases';

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalled();
			const queryCall = (mockExecContext.dataSourceFacade!.queryAll as ReturnType<typeof vi.fn>).mock.calls[0][0];
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
			expect(mockExecContext.logger.log).toHaveBeenCalled();
		});
	});
});
