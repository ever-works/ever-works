import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DomainDetectionStep } from '../steps/domain-detection.step';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	DirectoryReference,
	GenerationRequest
} from '@ever-works/plugin';

describe('DomainDetectionStep', () => {
	let step: DomainDetectionStep;
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
				domain_type: 'software',
				confidence: 0.9,
				item_noun: 'tools',
				expected_attributes: ['source_url', 'license'],
				official_source_patterns: ['github.com'],
				aggregator_domains: ['awesome.com']
			},
			usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
			cost: 0.005
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
			name: 'Vector Databases',
			config: {
				...((overrides?.config as Record<string, unknown>) || {})
			},
			...overrides
		}) as GenerationRequest;

	const createMockContext = (overrides?: Partial<MutableGenerationContext>): MutableGenerationContext =>
		({
			directory: createMockDirectory(),
			request: createMockRequest(),
			metrics: { steps: {} },
			domainAnalysis: undefined,
			warnings: [],
			shouldStop: false,
			...overrides
		}) as MutableGenerationContext;

	beforeEach(() => {
		step = new DomainDetectionStep();
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
			expect(step.name).toBe('Domain Detection');
		});
	});

	describe('run method', () => {
		it('should detect software domain', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.domain_type).toBe('software');
			expect(result.domainAnalysis?.confidence).toBe(0.9);
		});

		it('should detect ecommerce domain', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					domain_type: 'ecommerce',
					confidence: 0.85,
					item_noun: 'products'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.domain_type).toBe('ecommerce');
		});

		it('should detect services domain', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					domain_type: 'services',
					confidence: 0.8,
					item_noun: 'services'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.domain_type).toBe('services');
		});

		it('should detect general domain', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					domain_type: 'general',
					confidence: 0.7,
					item_noun: 'items'
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.domain_type).toBe('general');
		});

		it('should include item noun in analysis', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.item_noun).toBe('tools');
		});

		it('should include expected attributes', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.expected_attributes).toContain('source_url');
			expect(result.domainAnalysis?.expected_attributes).toContain('license');
		});

		it('should include official source patterns', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.official_source_patterns).toContain('github.com');
		});

		it('should include aggregator domains', async () => {
			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.aggregator_domains).toContain('awesome.com');
		});

		it('should default to software on AI error', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockRejectedValue(new Error('AI Error'));

			const result = await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.error).toHaveBeenCalled();
			expect(result.domainAnalysis?.domain_type).toBe('software');
			expect(result.domainAnalysis?.confidence).toBe(0);
		});

		it('should pass name and description to AI', async () => {
			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[2].variables.name).toBe('Vector Databases');
			expect(call[2].variables.description).toBe('Build a directory about vector databases');
		});

		it('should accumulate metrics correctly', async () => {
			const result = await step.run(mockContext, mockExecContext);

			const stepMetrics = result.metrics.steps?.['domain-detection'];
			expect(stepMetrics?.custom?.totalTokens).toBe(75);
			expect(stepMetrics?.custom?.totalCost).toBeCloseTo(0.005);
		});

		it('should log detection result', async () => {
			await step.run(mockContext, mockExecContext);

			expect(mockExecContext.logger.log).toHaveBeenCalledWith(
				expect.stringContaining('Domain Detection Complete')
			);
			expect(mockExecContext.logger.log).toHaveBeenCalledWith(expect.stringContaining('software'));
		});

		it('should handle null optional fields', async () => {
			mockExecContext.aiFacade.askJson = vi.fn().mockResolvedValue({
				result: {
					domain_type: 'software',
					confidence: 0.9,
					item_noun: null,
					expected_attributes: null,
					official_source_patterns: null,
					aggregator_domains: null
				},
				usage: null,
				cost: null
			});

			const result = await step.run(mockContext, mockExecContext);

			expect(result.domainAnalysis?.domain_type).toBe('software');
			expect(result.domainAnalysis?.item_noun).toBeUndefined();
		});

		it('should use low temperature for consistent results', async () => {
			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[2].temperature).toBe(0.1);
		});

		it('should handle empty name and description', async () => {
			mockContext.request = createMockRequest({ name: undefined, prompt: undefined });

			await step.run(mockContext, mockExecContext);

			const call = mockExecContext.aiFacade.askJson.mock.calls[0];
			expect(call[2].variables.name).toBe('');
			expect(call[2].variables.description).toBe('');
		});
	});
});
