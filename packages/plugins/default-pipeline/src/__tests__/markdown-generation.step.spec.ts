import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MarkdownGenerationStep } from '../steps/markdown-generation.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest,
	MutableItemData
} from '@ever-works/plugin';

describe('MarkdownGenerationStep', () => {
	let step: MarkdownGenerationStep;
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
			result: { markdown: '# Test Item\n\nThis is a test markdown.' },
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			cost: 0.01
		}),
		isConfigured: vi.fn().mockReturnValue(true),
		getDefaultProvider: vi.fn()
	});

	const createMockContentExtractorFacade = () => ({
		extractContent: vi.fn().mockResolvedValue({ rawContent: 'Extracted content from page' }),
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
			finalItems: [createMockItem('Test Item', 'https://example.com')],
			contentCache: new Map<string, string>(),
			metrics: { steps: {} },
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new MarkdownGenerationStep();
		mockContext = createMockContext();
		mockExecContext = {
			logger: createMockLogger(),
			aiFacade: createMockAiFacade(),
			contentExtractorFacade: createMockContentExtractorFacade(),
			user: { id: 'test-user-id' },
			directory: { id: 'test-dir-id' }
		} as unknown as StepExecutionContext;
	});

	describe('Step Properties', () => {
		it('should have correct name', () => {
			expect(step.name).toBe('Markdown Generation');
		});
	});

	describe('run method', () => {
		it('should return unchanged context when no items', async () => {
			mockContext.finalItems = [];

			const result = await step.run(mockContext, mockExecContext);

			expect(result).toBe(mockContext);
			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
		});

		it('should generate markdown for items with source URLs', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].markdown).toBe('# Test Item\n\nThis is a test markdown.');
		});

		it('should use content from cache when available', async () => {
			mockContext.contentCache.set('https://example.com', 'Cached content');

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.contentExtractorFacade.extractContent).not.toHaveBeenCalled();
		});

		it('should fetch content when not in cache', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.contentExtractorFacade.extractContent).toHaveBeenCalledWith('https://example.com');
		});

		it('should skip items without source_url', async () => {
			mockContext.finalItems = [createMockItem('No URL Item')];

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalled();
			expect(result.finalItems[0].markdown).toBe('');
		});

		it('should skip when AI is not configured', async () => {
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('AI provider not configured')
			);
			expect(result.finalItems[0].markdown).toBe('');
		});

		it('should handle content extraction failures', async () => {
			mockExecContext.contentExtractorFacade.extractContent = vi
				.fn()
				.mockRejectedValue(new Error('Extraction failed'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalled();
			expect(result.finalItems[0].markdown).toBe('');
		});

		it('should handle AI errors gracefully', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));
			mockContext.contentCache.set('https://example.com', 'Cached content');

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.finalItems[0].markdown).toBe('');
		});

		it('should process multiple items', async () => {
			mockContext.finalItems = [
				createMockItem('Item 1', 'https://example1.com'),
				createMockItem('Item 2', 'https://example2.com')
			];
			mockContext.contentCache.set('https://example1.com', 'Content 1');
			mockContext.contentCache.set('https://example2.com', 'Content 2');

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalledTimes(2);
		});

		it('should accumulate metrics correctly', async () => {
			mockContext.contentCache.set('https://example.com', 'Cached content');

			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['markdown-generation'];
			expect(stepMetrics?.custom?.totalTokens).toBe(150);
		});

		it('should truncate content to 4000 characters', async () => {
			const longContent = 'A'.repeat(5000);
			mockContext.contentCache.set('https://example.com', longContent);

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[2].variables.content.length).toBeLessThanOrEqual(4000);
		});

		it('should pass item data to AI prompt', async () => {
			mockContext.contentCache.set('https://example.com', 'Cached content');

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			const itemJson = call[2].variables.item;
			expect(itemJson).toContain('Test Item');
		});

		it('should handle null content from extractor', async () => {
			mockExecContext.contentExtractorFacade.extractContent = vi.fn().mockResolvedValue({ rawContent: null });

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to get content'));
			expect(result.finalItems[0].markdown).toBe('');
		});

		it('should log progress', async () => {
			mockContext.contentCache.set('https://example.com', 'Content');

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(expect.stringContaining('Generating markdown'));
		});
	});
});
