import { z } from 'zod';
import type {
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	FacadeOptions
} from '@ever-works/plugin';
import { BasePipelineStep } from '../base-pipeline-step.js';

const PROMPT_COMPARISON_PROMPT =
	`You are a helpful assistant tasked with comparing two prompts to determine if they are related and describe the same or similar data generation context.

<existing_prompt>
{existing_prompt}
</existing_prompt>

<new_prompt>
{new_prompt}
</new_prompt>

Your task:
1. Analyze both prompts to understand their intent, scope, and target domain.
2. Determine if they are describing the same or very similar data generation context.
3. Consider them related if they:
   - Target the same general domain or topic area
   - Have similar scope and intent
   - Would likely generate similar types of items/data
   - Are variations or refinements of the same core request

4. Consider them unrelated if they:
   - Target completely different domains or topics
   - Have fundamentally different scopes or intents
   - Would generate completely different types of items/data

5. Provide a clear reasoning for your decision.

Be somewhat lenient in determining relatedness - minor variations, additional details, or slight scope changes should still be considered related if the core intent is similar.` as const;

/**
 * Output schema for prompt comparison
 */
const promptComparisonOutputSchema = z.object({
	areRelated: z.boolean().describe('Whether the prompts are related and describe similar data generation context'),
	confidence: z.number().min(0).max(1).describe('Confidence level in the comparison result (0-1)'),
	reasoning: z.string().describe('Detailed explanation of why the prompts are considered related or unrelated')
});

export type PromptComparisonResult = z.infer<typeof promptComparisonOutputSchema>;

/**
 * Prompt Comparison Step
 *
 * Compares new prompts with existing prompts to ensure consistency
 * when updating existing directories. Prevents data inconsistency
 * by rejecting unrelated prompts in CREATE_UPDATE mode.
 */
export class PromptComparisonStep extends BasePipelineStep {
	readonly name = 'Prompt Comparison';
	readonly stepId = 'prompt-comparison' as const;

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, existing, directory } = context;
		const { logger, aiFacade } = execContext;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		const config = request.config || {};
		const existingConfig = existing.existingConfig;
		const $configMetadata = existingConfig?.metadata || {};

		// Check if comparison is needed
		if (
			$configMetadata?.initial_prompt &&
			request.generationMethod === 'CREATE_UPDATE' &&
			existing.items &&
			existing.items.length > 0
		) {
			logger.log(`[${directory.slug}] Prompt Comparison - Starting`);

			const comparisonResult = await this.comparePrompts(
				$configMetadata.initial_prompt as string,
				request.prompt ?? '',
				context.metrics,
				aiFacade,
				logger,
				facadeOptions
			);

			const confidence = comparisonResult.confidence;
			const confidenceThreshold = (config.prompt_comparison_confidence_threshold as number) || 0.5;

			const areRelated = comparisonResult.areRelated && comparisonResult.confidence > confidenceThreshold;

			logger.log(
				`[${directory.slug}] Prompt comparison: ${comparisonResult.areRelated ? 'RELATED' : 'UNRELATED'} ` +
					`(confidence: ${confidence.toFixed(2)})`
			);

			// If prompts are not related, throw an error to prevent data inconsistency
			if (!areRelated) {
				throw new Error(
					`Prompt comparison failed. Prompts are not related. Confidence: ${confidence.toFixed(2)}`
				);
			}
		} else {
			logger.debug(`[${directory.slug}] Prompt Comparison - Skipped`);
		}

		return context;
	}

	/**
	 * Compare two prompts to determine if they are related
	 */
	private async comparePrompts(
		existingPrompt: string,
		newPrompt: string,
		metrics: PipelineMetrics,
		aiFacade: StepExecutionContext['aiFacade'],
		logger: StepExecutionContext['logger'],
		facadeOptions: FacadeOptions
	): Promise<PromptComparisonResult> {
		if (!existingPrompt || !newPrompt) {
			return {
				areRelated: false,
				confidence: 0,
				reasoning: 'Cannot compare prompts: one or both prompts are empty or undefined'
			};
		}

		// If prompts are identical, they are definitely related
		if (existingPrompt.trim() === newPrompt.trim()) {
			return {
				areRelated: true,
				confidence: 1.0,
				reasoning: 'The prompts are identical'
			};
		}

		try {
			const { result, usage, cost } = await aiFacade.askJson(
				PROMPT_COMPARISON_PROMPT,
				promptComparisonOutputSchema,
				{
					temperature: 0.1,
					variables: { existing_prompt: existingPrompt, new_prompt: newPrompt },
					routing: {
						complexity: 'medium',
						taskId: 'prompt-comparison'
					}
				},
				facadeOptions
			);

			// Accumulate metrics
			if (usage) {
				this.accumulateMetrics(metrics, usage, cost);
			}

			return result;
		} catch (error) {
			logger.error(`Error comparing prompts: ${this.formatError(error)}`);

			// Fallback to simple string similarity check
			const similarity = this.calculateSimpleSimilarity(existingPrompt, newPrompt);
			const areRelated = similarity > 0.5;

			return {
				areRelated,
				confidence: 0.3,
				reasoning: `AI comparison failed, used fallback similarity check. Similarity score: ${similarity.toFixed(2)}`
			};
		}
	}

	/**
	 * Simple fallback similarity calculation using Jaccard index
	 */
	private calculateSimpleSimilarity(text1: string, text2: string): number {
		if (!text1 || !text2) return 0;

		const normalize = (text: string) =>
			text
				.toLowerCase()
				.replace(/[^\w\s]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim();

		const words1 = new Set(normalize(text1).split(' '));
		const words2 = new Set(normalize(text2).split(' '));

		const intersection = new Set([...words1].filter((word) => words2.has(word)));
		const union = new Set([...words1, ...words2]);

		return union.size > 0 ? intersection.size / union.size : 0;
	}
}
