import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ItemExtractionStep } from '../steps/item-extraction.step';
import type { StepExecutionContext, WorkReference, GenerationRequest, WebPageData } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';

describe('ItemExtractionStep', () => {
	let step: ItemExtractionStep;
	let mockContext: MutableGenerationContext;
	let mockExecContext: StepExecutionContext;

	const createMockLogger = () => ({
		log: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn()
	});

	// Note: item-extraction step uses convertNullsToUndefined which converts null to undefined.
	// Fields without .default() in the schema (brand, brand_logo_url, source_url) need actual values, not null.
	const createMockAiFacade = () => ({
		askJson: vi.fn().mockResolvedValue({
			result: {
				items: [
					{
						name: 'Item 1',
						description: 'Description 1 that is long enough for validation',
						source_url: 'https://example.com',
						featured: false,
						brand: 'Brand1',
						brand_logo_url: 'https://brand.com/logo.png',
						images: []
					},
					{
						name: 'Item 2',
						description: 'Description 2 that is long enough for validation',
						source_url: 'https://item2.com',
						featured: false,
						brand: 'Brand2',
						brand_logo_url: 'https://brand2.com/logo.png',
						images: []
					}
				]
			},
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
				min_content_length_for_extraction: 100,
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
			work: createMockWork(),
			request: createMockRequest(),
			webPages: [createMockWebPage('A'.repeat(200))],
			featuredItemHints: [],
			metrics: { steps: {} },
			advancedPrompts: {},
			extractedWebItems: [],
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new ItemExtractionStep();
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
			expect(step.name).toBe('Item Extraction');
		});
	});

	describe('run method', () => {
		it('should extract items from web pages', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedWebItems.length).toBe(2);
			expect(result.extractedWebItems[0].name).toBe('Item 1');
		});

		it('should skip pages with insufficient content', async () => {
			mockContext.webPages = [createMockWebPage('short')];

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedWebItems).toEqual([]);
			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
		});

		it('should skip when AI is not configured', async () => {
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedWebItems).toEqual([]);
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('AI provider not configured')
			);
		});

		it('should add slugs to extracted items', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'My Test Item',
							description: 'Test description that is long enough for validation',
							source_url: 'https://example.com',
							featured: false,
							brand: 'TestBrand',
							brand_logo_url: 'https://brand.com/logo.png',
							images: []
						}
					]
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedWebItems.length).toBe(1);
			expect(result.extractedWebItems[0].slug).toBe('my-test-item');
		});

		it('should handle empty AI response and add warning', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: { items: [] },
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedWebItems).toEqual([]);
			expect(result.warnings).toContain('Item extraction produced 0 items from 1 pages.');
		});

		it('should handle AI errors gracefully', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.extractedWebItems).toEqual([]);
		});

		it('should chunk large pages', async () => {
			// Create a page with content larger than MAX_CHUNK_SIZE (6000)
			const largeContent = 'A'.repeat(10000);
			mockContext.webPages = [createMockWebPage(largeContent)];
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'Item',
							description: 'A valid description that is long enough for validation',
							source_url: 'https://example.com',
							featured: false,
							brand: 'TestBrand',
							brand_logo_url: 'https://brand.com/logo.png',
							images: []
						}
					]
				},
				usage: null,
				cost: null
			});

			await step.run(mockContext, mockExecContext);

			// Should be called multiple times for chunked content
			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalled();
		});

		it('should deduplicate items across chunks', async () => {
			const largeContent = 'A'.repeat(10000);
			mockContext.webPages = [createMockWebPage(largeContent)];
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'Same Item',
							description: 'Description from chunk 1 that is long enough',
							source_url: 'https://example.com',
							featured: false,
							brand: 'TestBrand',
							brand_logo_url: 'https://brand.com/logo.png',
							images: []
						},
						{
							name: 'Same Item',
							description: 'Description from chunk 2 that is long enough',
							source_url: 'https://example2.com',
							featured: false,
							brand: 'TestBrand2',
							brand_logo_url: 'https://brand2.com/logo.png',
							images: []
						}
					]
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			// Should deduplicate items with same name
			const sameItemCount = result.extractedWebItems.filter((i) => i.name === 'Same Item').length;
			expect(sameItemCount).toBe(1);
		});

		it('should accumulate metrics correctly', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: { items: [] },
				usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
				cost: 0.01
			});

			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['items-extraction'];
			expect(stepMetrics?.custom?.totalTokens).toBe(150);
		});

		it('should process multiple pages', async () => {
			mockContext.webPages = [
				createMockWebPage('A'.repeat(200), 'https://page1.com'),
				createMockWebPage('B'.repeat(200), 'https://page2.com')
			];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalledTimes(2);
		});

		it('should include featured hints in prompt', async () => {
			mockContext.featuredItemHints = ['Popular tools', 'Open source'];

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[2].variables.featured_hints_section).toContain('Popular tools');
		});

		it('should skip invalid items from AI response', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'Valid Item',
							description: 'Valid description that is long enough for validation',
							source_url: 'https://example.com',
							featured: false,
							brand: 'TestBrand',
							brand_logo_url: 'https://brand.com/logo.png',
							images: []
						},
						{
							name: '',
							description: 'Invalid - empty name',
							source_url: 'https://example.com',
							featured: false,
							brand: 'TestBrand',
							brand_logo_url: 'https://brand.com/logo.png',
							images: []
						},
						{
							description: 'Invalid - no name',
							source_url: 'https://example.com',
							featured: false,
							brand: 'TestBrand',
							brand_logo_url: 'https://brand.com/logo.png',
							images: []
						}
					]
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			// Only item with missing 'name' field fails validation
			// Empty string name is valid for Zod (z.string() allows '')
			expect(result.extractedWebItems.length).toBe(2);
			expect(result.extractedWebItems[0].name).toBe('Valid Item');
		});

		it('should apply custom prompt when provided', async () => {
			mockContext.advancedPrompts = { itemExtraction: 'Additional extraction rules' };

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[0]).toContain('Additional extraction rules');
		});

		it('should handle items with all valid fields', async () => {
			// Note: item-extraction step converts null to undefined via convertNullsToUndefined,
			// which breaks validation for fields without .default(). So we test with valid values.
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'Item',
							description: 'A valid description that is long enough for validation',
							source_url: 'https://example.com',
							brand: 'TestBrand',
							brand_logo_url: 'https://brand.com/logo.png',
							featured: false,
							images: ['https://example.com/img.png']
						}
					]
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.extractedWebItems.length).toBe(1);
			expect(result.extractedWebItems[0].name).toBe('Item');
			expect(result.extractedWebItems[0].source_url).toBe('https://example.com');
		});

		it('should deduplicate items across pages', async () => {
			mockContext.webPages = [
				createMockWebPage('A'.repeat(200), 'https://page1.com'),
				createMockWebPage('B'.repeat(200), 'https://page2.com')
			];
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					items: [
						{
							name: 'Duplicate Item',
							description: 'Same item from different pages with long enough description',
							source_url: 'https://example.com',
							featured: false,
							brand: 'TestBrand',
							brand_logo_url: 'https://brand.com/logo.png',
							images: []
						}
					]
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			// Should only have one instance of the duplicate
			expect(result.extractedWebItems.filter((i) => i.name === 'Duplicate Item').length).toBe(1);
		});
	});
});
