import { z } from 'zod';
import type {
	IBuiltInStepExecutor,
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	DomainType,
	DomainAnalysis
} from '@ever-works/plugin';

/**
 * Domain detection prompt template
 */
const DOMAIN_DETECTION_PROMPT = `You are classifying the domain of a directory topic.

Topic name: "{name}"
Topic description: "{description}"

Choose a domain_type from: software, ecommerce, services, general.
Return the classification with a confidence score and any useful cues (expected attributes, official patterns, aggregator domains, item noun).` as const;

/**
 * Schema for domain detection AI response
 */
const domainDetectionSchema = z.object({
	domain_type: z.enum(['software', 'ecommerce', 'services', 'general']),
	confidence: z.number().min(0).max(1),
	item_noun: z.string().nullable().optional(),
	expected_attributes: z.array(z.string()).nullable().optional(),
	official_source_patterns: z.array(z.string()).nullable().optional(),
	aggregator_domains: z.array(z.string()).nullable().optional()
});

/**
 * Domain Detection Step
 *
 * Analyzes the prompt to detect the domain type for specialized handling.
 * The domain type affects how items are searched, extracted, and validated.
 */
export class DomainDetectionStep implements IBuiltInStepExecutor {
	readonly name = 'Domain Detection';

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, directory, metrics } = context;
		const { logger, aiFacade } = execContext;
		const { name, prompt } = request;

		logger.log(`[${directory.slug}] Domain Detection - Starting`);

		try {
			const { result, usage, cost } = await aiFacade.askJson(DOMAIN_DETECTION_PROMPT, domainDetectionSchema, {
				temperature: 0.1,
				variables: { name: name || '', description: prompt ?? '' },
				routing: {
					complexity: 'simple',
					taskId: 'domain-detection'
				}
			});

			context.domainAnalysis = {
				domain_type: result.domain_type as DomainType,
				confidence: result.confidence,
				item_noun: result.item_noun || undefined,
				expected_attributes: result.expected_attributes || undefined,
				official_source_patterns: result.official_source_patterns || undefined,
				aggregator_domains: result.aggregator_domains || undefined
			};

			// Accumulate metrics
			if (usage) {
				this.accumulateMetrics(metrics, usage, cost);
			}

			logger.log(
				`[${directory.slug}] Domain Detection Complete: ${result.domain_type} (conf=${result.confidence})`
			);
		} catch (error) {
			logger.error(
				`[${directory.slug}] Domain detection failed, defaulting to software. ${error instanceof Error ? error.message : String(error)}`
			);
			context.domainAnalysis = {
				domain_type: 'software' as DomainType,
				confidence: 0
			};
		}

		return context;
	}

	/**
	 * Accumulate token usage and cost metrics
	 */
	private accumulateMetrics(
		metrics: PipelineMetrics,
		usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
		cost: number | null
	): void {
		if (!metrics.steps) {
			metrics.steps = {};
		}
		if (!metrics.steps['domain-detection']) {
			metrics.steps['domain-detection'] = {
				name: this.name,
				startTime: Date.now(),
				success: true
			};
		}
		const stepMetrics = metrics.steps['domain-detection'];
		if (!stepMetrics.custom) {
			stepMetrics.custom = {};
		}
		if (usage) {
			stepMetrics.custom.totalTokens = ((stepMetrics.custom.totalTokens as number) || 0) + usage.totalTokens;
		}
		if (cost) {
			stepMetrics.custom.totalCost = ((stepMetrics.custom.totalCost as number) || 0) + cost;
		}
	}
}
