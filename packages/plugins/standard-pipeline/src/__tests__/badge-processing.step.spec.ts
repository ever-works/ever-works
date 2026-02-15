import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadgeProcessingStep } from '../steps/badge-processing.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest,
	MutableItemData
} from '@ever-works/plugin';

describe('BadgeProcessingStep', () => {
	let step: BadgeProcessingStep;
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
				evaluation_summary: 'Item evaluated successfully',
				badges: {
					security: { value: 'A', details: 'No vulnerabilities' },
					license: { value: 'A', details: 'MIT license' },
					quality: { value: 'A', details: 'Well maintained' }
				}
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
				badge_evaluation_enabled: true,
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
			finalItems: [createMockItem('Test Repo', 'https://github.com/user/repo')],
			metrics: { steps: {} },
			domainAnalysis: { domain_type: 'software', confidence: 0.9 },
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new BadgeProcessingStep();
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
			expect(step.name).toBe('Badges Processing');
		});
	});

	describe('run method', () => {
		it('should skip when badge_evaluation_enabled is false', async () => {
			mockContext.request = createMockRequest({
				config: { badge_evaluation_enabled: false }
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
			expect(result.finalItems[0].badges).toBeUndefined();
		});

		it('should evaluate badges for repository URLs', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].badges).toBeDefined();
			expect(result.finalItems[0].badges?.security?.value).toBe('A');
		});

		it('should skip non-repository URLs for software domain', async () => {
			mockContext.finalItems = [createMockItem('Website', 'https://example.com')];

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
			expect(result.finalItems[0].badges).toBeUndefined();
		});

		it('should recognize GitHub URLs as repositories', async () => {
			mockContext.finalItems = [createMockItem('Repo', 'https://github.com/user/repo')];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalled();
		});

		it('should recognize GitLab URLs as repositories', async () => {
			mockContext.finalItems = [createMockItem('Repo', 'https://gitlab.com/user/repo')];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalled();
		});

		it('should recognize Bitbucket URLs as repositories', async () => {
			mockContext.finalItems = [createMockItem('Repo', 'https://bitbucket.org/user/repo')];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalled();
		});

		it('should skip items without source_url', async () => {
			mockContext.finalItems = [createMockItem('No URL')];

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).not.toHaveBeenCalled();
			expect(result.finalItems[0].badges).toBeUndefined();
		});

		it('should use ecommerce badges for ecommerce domain', async () => {
			mockContext.domainAnalysis = { domain_type: 'ecommerce', confidence: 0.9 };
			mockContext.finalItems = [createMockItem('Product', 'https://shop.com/product')];
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					evaluation_summary: 'Evaluated',
					badges: {
						verified: { value: 'yes', details: 'Official store' },
						price_range: { value: '$$', details: 'Mid-range' },
						availability: { value: 'in_stock', details: 'Available' }
					}
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].badges?.verified?.value).toBe('yes');
		});

		it('should use services badges for services domain', async () => {
			mockContext.domainAnalysis = { domain_type: 'services', confidence: 0.9 };
			mockContext.finalItems = [createMockItem('Service', 'https://service.com')];
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					evaluation_summary: 'Evaluated',
					badges: {
						availability: { value: 'online', details: 'Online service' },
						booking: { value: 'instant', details: 'Instant booking' },
						verified: { value: 'yes', details: 'Verified provider' }
					}
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].badges?.availability?.value).toBe('online');
		});

		it('should handle AI errors gracefully', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.finalItems[0].badges).toBeUndefined();
		});

		it('should process multiple items', async () => {
			mockContext.finalItems = [
				createMockItem('Repo 1', 'https://github.com/user/repo1'),
				createMockItem('Repo 2', 'https://github.com/user/repo2')
			];

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalledTimes(2);
		});

		it('should accumulate metrics correctly', async () => {
			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['badges-processing'];
			expect(stepMetrics?.custom?.totalTokens).toBe(150);
		});

		it('should skip when AI is not configured', async () => {
			mockExecContext.aiFacade.isConfigured = vi.fn().mockReturnValue(false);

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].badges).toBeUndefined();
		});

		it('should add evaluated_at timestamp to badges', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].badges?.security?.evaluated_at).toBeDefined();
		});

		it('should update metrics with itemsProcessed count', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.metrics.itemsProcessed).toBe(1);
		});

		it('should use general badges when domain is general', async () => {
			mockContext.domainAnalysis = { domain_type: 'general', confidence: 0.8 };
			mockContext.finalItems = [createMockItem('Item', 'https://example.com')];
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					evaluation_summary: 'Evaluated',
					badges: {
						verified: { value: 'yes', details: 'Verified source' }
					}
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].badges?.verified?.value).toBe('yes');
		});

		it('should default to software domain when analysis is missing', async () => {
			mockContext.domainAnalysis = undefined;

			const result = await step.run(mockContext, mockExecContext);

			// Should still work with software domain default
			expect(result.finalItems[0].badges?.security?.value).toBe('A');
		});

		it('should handle null badges in AI response', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					evaluation_summary: 'Could not evaluate',
					badges: null
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.finalItems[0].badges).toEqual({});
		});

		it('should process items in batches with concurrency limit', async () => {
			mockContext.finalItems = Array.from({ length: 15 }, (_, i) =>
				createMockItem(`Repo ${i}`, `https://github.com/user/repo${i}`)
			);

			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.aiFacade.askJson).toHaveBeenCalledTimes(15);
		});
	});
});
