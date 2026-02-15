import { z } from 'zod';
import type { StepExecutionContext, DomainType, FacadeOptions } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';

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
export class DomainDetectionStep extends BasePipelineStep {
	readonly name = 'Domain Detection';
	readonly stepId = 'domain-detection' as const;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { request, directory, metrics } = context;
		const { logger, aiFacade } = execContext;
		const { name, prompt } = request;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		logger.log(`[${directory.slug}] Domain Detection - Starting`);

		try {
			const { result, usage, cost } = await aiFacade.askJson(
				DOMAIN_DETECTION_PROMPT,
				domainDetectionSchema,
				{
					temperature: 0.1,
					variables: { name: name || '', description: prompt ?? '' },
					routing: {
						complexity: 'simple',
						taskId: 'domain-detection'
					}
				},
				facadeOptions
			);

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
				`[${directory.slug}] Domain detection failed, defaulting to software. ${this.formatError(error)}`
			);
			this.addWarning(context, 'Could not detect the domain type. Defaulting to "software".');
			context.domainAnalysis = {
				domain_type: 'software' as DomainType,
				confidence: 0
			};
		}

		return context;
	}
}
