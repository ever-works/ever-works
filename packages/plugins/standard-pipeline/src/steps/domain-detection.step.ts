import { z } from 'zod';
import type { StepExecutionContext, DomainType, FacadeOptions } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { PROMPT_KEYS } from '../prompt-keys.js';

/**
 * Domain detection prompt template
 */
const DOMAIN_DETECTION_PROMPT = `You are classifying the domain of a work topic.

<topic_name untrusted="true">{name}</topic_name>
<topic_description untrusted="true">{description}</topic_description>

Choose a domain_type from: software, ecommerce, services, general.
Return the classification with a confidence score and any useful cues (expected attributes, official patterns, aggregator domains, item noun).` as const;

/**
 * Security: sanitize user-supplied `name` and `description` before they are
 * interpolated into the LLM prompt. Collapse newlines so injected text cannot
 * fake new prompt lines, strip chat-template control markers that some models
 * treat as out-of-band role/turn delimiters, and hard-truncate. Mirrors the
 * canonical `sanitizePromptVariable` used by `badge-processing.step.ts` and
 * `source-validation.step.ts` for the same class of untrusted user input.
 */
function sanitizePromptVariable(value: string, maxLength: number): string {
	return value
		.replace(/\r?\n|\r/g, ' ')
		.replace(/\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi, '')
		.slice(0, maxLength);
}

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
		const { request, work, metrics } = context;
		const { logger, aiFacade, promptFacade } = execContext;
		const { name, prompt } = request;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			workId: execContext.work.id
		};

		logger.log(`[${work.slug}] Domain Detection - Starting`);

		try {
			const resolvedPrompt = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.DOMAIN_DETECTION, DOMAIN_DETECTION_PROMPT)
					: DOMAIN_DETECTION_PROMPT
			) as typeof DOMAIN_DETECTION_PROMPT;

			const { result, usage, cost } = await aiFacade.askJson(
				resolvedPrompt,
				domainDetectionSchema,
				{
					temperature: 0.1,
					// Security: sanitize user-supplied fields before LLM interpolation.
					variables: {
						name: sanitizePromptVariable(name || '', 500),
						description: sanitizePromptVariable(prompt ?? '', 2000)
					},
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

			logger.log(`[${work.slug}] Domain Detection Complete: ${result.domain_type} (conf=${result.confidence})`);
		} catch (error) {
			logger.error(`[${work.slug}] Domain detection failed, defaulting to software. ${this.formatError(error)}`);
			context.domainAnalysis = {
				domain_type: 'software' as DomainType,
				confidence: 0
			};
		}

		return context;
	}
}
