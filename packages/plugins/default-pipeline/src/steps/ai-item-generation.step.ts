import type {
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics,
	MutableItemData,
	FacadeOptions
} from '@ever-works/plugin';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { slugifyText } from '../utils/text.utils.js';
import { getErrorStack } from '../utils/error.utils.js';
import { appendCustomPrompt } from '../utils/prompt.utils.js';
import { z } from 'zod';
import {
	extractedItemsSchema,
	itemDataSchema,
	promptUnderstandingAssessmentSchema
} from '../schemas/item-extraction.schemas.js';

// Inferred types from schemas
type PromptAssessment = z.infer<typeof promptUnderstandingAssessmentSchema>;
type ExtractedItems = z.infer<typeof extractedItemsSchema>;

const UNDERSTANDING_PROMPT = `You are an AI assistant helping to curate a "Directory website".
Topic: "{topicName}"
Description: "{topicDescription}"
Keywords: "{target_keywords_string}"

Before attempting to generate items, please assess if the provided information is clear, specific, and sufficient for you to generate a high-quality, relevant list of items (tools, resources, libraries, etc.).

- If the information is clear and sufficient, respond with 'can_proceed: true'.
- If the information is too vague, ambiguous, or lacks necessary detail, respond with 'can_proceed: false' and provide a brief 'reason_if_cannot_proceed'.
- Optionally, if 'can_proceed: false', you can provide 'suggested_clarifications' as an array of questions or points the user could address to improve the prompt.

Consider:
- Is the topic well-defined?
- Is the scope clear (not too broad, not too narrow without context)?
- Are there any ambiguities that would make item generation difficult or likely to produce irrelevant results?` as const;

const GENERATION_PROMPT =
	`You are an expert curator and technical writer tasked with generating an initial list of items for a "Directory website" about a specific topic.
The **main topic** of the Directory website is: "{topicName}"
Description: "{topicDescription}"
Optional initial keywords: {target_keywords_string}

## Featured Item Guidelines:
{featured_hints_section}

## Task:
Based on this topic, please generate a comprehensive list of distinct items (e.g., tools, software, libraries, frameworks, official documentation, key community resources, important projects).

For each item, provide the following details:
1.  **name**: The canonical name of the item.
2.  **description**: A concise description (1-3 sentences) highlighting its specific relevance to "{topicName}".
3.  **source_url**: The most direct and canonical URL (e.g., homepage, official documentation, repository). If a high-quality, canonical URL cannot be confidently determined, you may omit it but it's highly encouraged.
4.  **brand**: Optional single brand/manufacturer associated with the item (or null if not applicable).
5.  **brand_logo_url**: Optional logo URL for the brand if a canonical logo is clear (prefer SVG/PNGs from the official domain).
6.  **images**: Array of 1-4 image URLs (screenshots, product images, hero visuals) that clearly represent the item. Prefer official assets from the item or brand domain. Leave empty if none are trustworthy.
7.  **featured**: A boolean indicating whether this item should be highlighted or given special prominence (true/false). This value should be set to true only when the item specification complies with the "Featured Item Guidelines".

**Critical Instructions:**
-   *Only generate items if you are completely certain of their relevance to the topic.*
-   Focus on **relevance** to "{topicName}".
-   Aim for **diversity** in the types of items if appropriate for the topic.
-   Provide **accurate and canonical** information, especially for names and URLs.
-   If the topic is broad, try to cover its main sub-areas. If it's niche, focus on key resources for that niche.

Generate the list of items according to the specified schema.` as const;

/**
 * AI Item Generation Step
 *
 * Generates initial items using AI based on the topic description.
 * This step runs before web search to seed the directory with AI-curated items.
 */
export class AiItemGenerationStep extends BasePipelineStep {
	readonly name = 'AI Item Generation';
	readonly stepId = 'ai-first-items-generation' as const;

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, directory, featuredItemHints, metrics, advancedPrompts } = context;
		const { logger, aiFacade } = execContext;
		const config = request.config || {};

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			directoryId: execContext.directory.id
		};

		const aiFirstEnabled = config.ai_first_generation_enabled !== false;

		if (aiFirstEnabled) {
			logger.log(`[${directory.slug}] AI-First Item Generation - Starting`);

			const initialAiItems = await this.generateInitialItemsWithAI(
				directory.slug,
				request.name || directory.name,
				request.prompt || '',
				(config.target_keywords as string[]) || [],
				featuredItemHints,
				metrics,
				advancedPrompts?.itemGeneration,
				logger,
				aiFacade,
				facadeOptions
			);

			logger.log(`[${directory.slug}] AI generated ${initialAiItems.length} initial items.`);

			context.initialAiItems = initialAiItems;
		} else {
			logger.debug(`[${directory.slug}] AI-First Item Generation - Skipped`);
			context.initialAiItems = [];
		}

		return context;
	}

	/**
	 * Generate initial items using AI
	 */
	private async generateInitialItemsWithAI(
		directorySlug: string,
		topicName: string,
		topicDescription: string,
		targetKeywords: string[],
		featuredItemHints: string[] = [],
		metrics: PipelineMetrics,
		customPrompt: string | null | undefined,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		facadeOptions: FacadeOptions
	): Promise<MutableItemData[]> {
		logger.debug(`[${directorySlug}] AI-First Item Generation - Starting for topic: ${topicName}`);
		const allGeneratedItems: MutableItemData[] = [];

		if (!aiFacade.isConfigured()) {
			logger.warn(`[${directorySlug}] AI provider not configured. Skipping AI-first item generation.`);
			return [];
		}

		const keywordsString = targetKeywords.length > 0 ? targetKeywords.join(', ') : 'N/A';

		// First, assess if the prompt is clear enough
		try {
			const {
				result: assessment,
				usage,
				cost
			} = await aiFacade.askJson<PromptAssessment>(
				UNDERSTANDING_PROMPT,
				promptUnderstandingAssessmentSchema,
				{
					temperature: 0.3,
					variables: {
						topicName,
						topicDescription,
						target_keywords_string: keywordsString
					},
					routing: {
						complexity: 'simple',
						taskId: 'ai-item-generation-assessment'
					}
				},
				facadeOptions
			);

			if (usage) {
				this.accumulateMetrics(metrics, usage, cost);
			}

			if (!assessment.can_proceed) {
				logger.warn(
					`[${directorySlug}] AI cannot confidently proceed with item generation for topic "${topicName}" due to prompt clarity. Reason: ${assessment.reason_if_cannot_proceed || 'No specific reason provided.'}`
				);
				if (assessment.suggested_clarifications && assessment.suggested_clarifications.length > 0) {
					logger.warn(
						`[${directorySlug}] AI suggested clarifications: ${assessment.suggested_clarifications.join('; ')}`
					);
				}
				return [];
			}

			logger.debug(
				`[${directorySlug}] AI assessment: Prompt for topic "${topicName}" is clear. Proceeding with item generation.`
			);
		} catch (error) {
			logger.error(
				`[${directorySlug}] Error during AI prompt understanding assessment for topic "${topicName}": ${this.formatError(error)}. Proceeding with caution (will attempt item generation).`,
				getErrorStack(error)
			);
		}

		// Generate featured hints section for the prompt
		const featuredHintsSection = this.generateFeaturedHintsSection(featuredItemHints);

		try {
			const finalPrompt = appendCustomPrompt(GENERATION_PROMPT, customPrompt);

			const { result, usage, cost } = await aiFacade.askJson<ExtractedItems>(
				finalPrompt,
				extractedItemsSchema,
				{
					temperature: 0,
					variables: {
						topicName,
						topicDescription,
						target_keywords_string: keywordsString,
						featured_hints_section: featuredHintsSection
					},
					routing: {
						complexity: 'complex',
						taskId: 'ai-item-generation'
					}
				},
				facadeOptions
			);

			if (usage) {
				this.accumulateMetrics(metrics, usage, cost);
			}

			if (result && result.items && result.items.length > 0) {
				logger.debug(`[${directorySlug}] AI initially generated ${result.items.length} items.`);
				for (const generatedItem of result.items) {
					try {
						// Convert nulls to undefined for compatibility
						const itemToValidate: Partial<MutableItemData> = {
							name: generatedItem.name,
							description: generatedItem.description,
							source_url: generatedItem.source_url ?? undefined,
							featured: generatedItem.featured ?? undefined,
							brand: generatedItem.brand ?? undefined,
							brand_logo_url: generatedItem.brand_logo_url ?? undefined,
							images: generatedItem.images ?? undefined
						};

						const validatedItem = itemDataSchema.parse(itemToValidate) as MutableItemData;
						validatedItem.slug = slugifyText(validatedItem.name);

						allGeneratedItems.push(validatedItem);
					} catch {
						// Skip invalid items silently
					}
				}
			} else {
				logger.log(`[${directorySlug}] No initial items generated by AI for topic: ${topicName}.`);
			}
		} catch (error) {
			logger.error(
				`[${directorySlug}] Error generating initial items with AI for topic ${topicName}: ${this.formatError(error)}`,
				getErrorStack(error)
			);
		}

		logger.log(
			`[${directorySlug}] AI-First Item Generation - Complete. Validated ${allGeneratedItems.length} items.`
		);
		return allGeneratedItems;
	}

	/**
	 * Generate the featured hints section for the prompt
	 */
	private generateFeaturedHintsSection(featuredItemHints: string[]): string {
		if (!featuredItemHints || featuredItemHints.length === 0) {
			return '';
		}

		return `
**Featured Item Specifications:**
The user has provided the following specifications for which items should be marked as featured (highlighted):
${featuredItemHints.map((hint) => `- ${hint}`).join('\n')}

When determining the 'featured' status for items, carefully consider these specifications. Items that match these criteria, guidelines, or instructions should be marked as featured=true.
`;
	}
}
