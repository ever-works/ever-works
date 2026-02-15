import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AiItemGenerationStep } from '../steps/ai-item-generation.step';
import type { StepExecutionContext, DirectoryReference, GenerationRequest } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';

describe('AiItemGenerationStep', () => {
	let step: AiItemGenerationStep;
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
			result: { items: [] },
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
				ai_first_generation_enabled: true,
				target_keywords: [],
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			directory: createMockDirectory(),
			request: createMockRequest(),
			featuredItemHints: [],
			metrics: { steps: {} },
			advancedPrompts: {},
			initialAiItems: [],
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new AiItemGenerationStep();
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
			expect(step.name).toBe('AI Item Generation');
		});
	});

	describe('run method', () => {
		it('should skip when ai_first_generation_enabled is false', async () => {
			mockContext.request = createMockRequest({
				config: { ai_first_generation_enabled: false }
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.initialAiItems).toEqual([]);
			expect(mockExecContext.logger.debug).toHaveBeenCalledWith(expect.stringContaining('Skipped'));
		});

		it('should call AI facade when enabled', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalled();
		});

		// Note: ai-item-generation step uses ?? operator which converts null to undefined.
		// Fields without .default() in the schema need actual values, not null.
		it('should generate items on successful AI response', async () => {
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockResolvedValueOnce({
					result: { can_proceed: true },
					usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
					cost: 0.005
				})
				.mockResolvedValueOnce({
					result: {
						items: [
							{
								name: 'Test Item 1',
								description: 'A test item description that is long enough',
								source_url: 'https://item1.com',
								featured: false,
								brand: 'Brand1',
								brand_logo_url: 'https://brand1.com/logo.png',
								images: []
							},
							{
								name: 'Test Item 2',
								description: 'Another test item description that is long enough',
								source_url: 'https://example.com',
								featured: false,
								brand: 'Brand2',
								brand_logo_url: 'https://brand2.com/logo.png',
								images: []
							}
						]
					},
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					cost: 0.01
				});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.initialAiItems.length).toBe(2);
			expect(result.initialAiItems[0].name).toBe('Test Item 1');
		});

		it('should return empty list and add warning when AI cannot proceed', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					can_proceed: false,
					reason_if_cannot_proceed: 'Topic is too vague'
				},
				usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
				cost: 0.005
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.initialAiItems).toEqual([]);
			expect(mockExecContext.logger.warn).toHaveBeenCalled();
			expect(result.warnings).toContain('AI cannot confidently generate items: Topic is too vague');
		});

		it('should skip when AI provider is not configured', async () => {
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);

			const result = await step.run(mockContext, mockExecContext);

			expect(result.initialAiItems).toEqual([]);
			expect(mockExecContext.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('AI provider not configured')
			);
		});

		it('should add slugs to generated items', async () => {
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockResolvedValueOnce({
					result: { can_proceed: true },
					usage: null,
					cost: null
				})
				.mockResolvedValueOnce({
					result: {
						items: [
							{
								name: 'My Test Item',
								description: 'A test item description that is long enough for validation',
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

			expect(result.initialAiItems.length).toBe(1);
			expect(result.initialAiItems[0].slug).toBe('my-test-item');
		});

		it('should accumulate metrics correctly', async () => {
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockResolvedValueOnce({
					result: { can_proceed: true },
					usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
					cost: 0.005
				})
				.mockResolvedValueOnce({
					result: { items: [] },
					usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
					cost: 0.01
				});

			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['ai-first-items-generation'];
			expect(stepMetrics?.custom?.totalTokens).toBe(225);
			expect(stepMetrics?.custom?.totalCost).toBeCloseTo(0.015);
		});

		it('should handle AI errors gracefully during assessment', async () => {
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockRejectedValueOnce(new Error('AI Error'))
				.mockResolvedValueOnce({
					result: {
						items: [
							{
								name: 'Item',
								description: 'A valid test item description that is long enough',
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

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			// Should still attempt to generate items after assessment failure
			expect(result.initialAiItems.length).toBe(1);
		});

		it('should handle AI errors gracefully during generation and add warning', async () => {
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockResolvedValueOnce({
					result: { can_proceed: true },
					usage: null,
					cost: null
				})
				.mockRejectedValueOnce(new Error('Generation Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.initialAiItems).toEqual([]);
			expect(result.warnings).toContain(
				'AI item generation failed. The pipeline will rely on web search and data sources.'
			);
		});

		it('should add warning when AI returns 0 items', async () => {
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockResolvedValueOnce({
					result: { can_proceed: true },
					usage: null,
					cost: null
				})
				.mockResolvedValueOnce({
					result: { items: [] },
					usage: null,
					cost: null
				});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.initialAiItems).toEqual([]);
			expect(result.warnings).toContain('AI did not generate any items for this topic.');
		});

		it('should include featured hints in the prompt', async () => {
			mockContext.featuredItemHints = ['Open source projects', 'Well maintained'];
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockResolvedValueOnce({
					result: { can_proceed: true },
					usage: null,
					cost: null
				})
				.mockResolvedValueOnce({
					result: { items: [] },
					usage: null,
					cost: null
				});

			await step.run(mockContext, mockExecContext);

			const calls = mockExecContext.aiFacade.askJson.mock.calls;
			const generationCall = calls[1];
			expect(generationCall[2].variables.featured_hints_section).toContain('Open source projects');
		});

		it('should skip invalid items from AI response', async () => {
			mockExecContext.aiFacade.askJson = vi
				.fn()
				.mockResolvedValueOnce({
					result: { can_proceed: true },
					usage: null,
					cost: null
				})
				.mockResolvedValueOnce({
					result: {
						items: [
							{
								name: 'Valid Item',
								description: 'Valid description that is long enough to pass validation',
								source_url: 'https://example.com',
								featured: false,
								brand: 'TestBrand',
								brand_logo_url: 'https://brand.com/logo.png',
								images: []
							},
							{
								name: '',
								description: 'Empty name is valid for Zod but might be filtered elsewhere',
								source_url: 'https://example.com',
								featured: false,
								brand: 'TestBrand',
								brand_logo_url: 'https://brand.com/logo.png',
								images: []
							},
							{
								description: 'No name field at all - will fail Zod validation',
								source_url: 'https://example.com',
								featured: false,
								brand: 'TestBrand',
								brand_logo_url: 'https://brand.com/logo.png',
								images: []
							} // Invalid - missing required 'name' field
						]
					},
					usage: null,
					cost: null
				});

			const result = await step.run(mockContext, mockExecContext);

			// Only item with missing 'name' field fails validation
			// Empty string name is valid for Zod (z.string() allows '')
			expect(result.initialAiItems.length).toBe(2);
			expect(result.initialAiItems[0].name).toBe('Valid Item');
		});

		it('should use target keywords from config', async () => {
			mockContext.request = createMockRequest({
				config: {
					ai_first_generation_enabled: true,
					target_keywords: ['vector', 'database', 'embedding']
				}
			});

			await step.run(mockContext, mockExecContext);

			const calls = mockExecContext.aiFacade.askJson.mock.calls;
			const assessmentCall = calls[0];
			expect(assessmentCall[2].variables.target_keywords_string).toBe('vector, database, embedding');
		});
	});
});
