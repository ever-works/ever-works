import { Injectable, Logger } from '@nestjs/common';
import { slugifyText } from '../utils/text.utils';
import { getErrorMessage, getErrorStack } from '../utils/error.util';
import { AiService } from 'src/ai';
import { CreateItemsGeneratorDto, ItemData } from '../dto';
import {
    extractedItemsSchema,
    itemDataSchema,
    promptUnderstandingAssessmentSchema,
} from '../schemas/item-extraction.schemas';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { accumulateMetrics, MetricsAccumulator } from '../utils/metrics.util';

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

{featured_hints_section}

Based on this topic, please generate a comprehensive list of distinct items (e.g., tools, software, libraries, frameworks, official documentation, key community resources, important projects).

For each item, provide the following details:
1.  **name**: The canonical name of the item.
2.  **description**: A concise description (1-3 sentences) highlighting its specific relevance to "{topicName}".
3.  **source_url**: The most direct and canonical URL (e.g., homepage, official documentation, repository). If a high-quality, canonical URL cannot be confidently determined, you may omit it but it's highly encouraged.
4.  **brand**: Optional single brand/manufacturer associated with the item (or null if not applicable).
5.  **brand_logo_url**: Optional logo URL for the brand if a canonical logo is clear (prefer SVG/PNGs from the official domain).
6.  **images**: Array of 1-4 image URLs (screenshots, product images, hero visuals) that clearly represent the item. Prefer official assets from the item or brand domain. Leave empty if none are trustworthy.
7.  **featured**: A boolean indicating if this item should be highlighted or given special prominence (true/false). Consider the featured item guidelines above when making this determination. Default to false if unsure.

**Critical Instructions:**
-   *Only generate items if you are completely certain of their relevance to the topic.*
-   Focus on **relevance** to "{topicName}".
-   Aim for **diversity** in the types of items if appropriate for the topic.
-   Provide **accurate and canonical** information, especially for names and URLs.
-   If the topic is broad, try to cover its main sub-areas. If it's niche, focus on key resources for that niche.

Generate the list of items according to the specified schema.` as const;

@Injectable()
export class AiItemGenerationService implements IPipelineStep {
    private readonly logger = new Logger(AiItemGenerationService.name);

    public readonly name = ItemsGeneratorStep.AI_FIRST_ITEMS_GENERATION;

    constructor(private readonly aiService: AiService) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, directory, featuredItemHints, metrics } = context;

        if (dto.config.ai_first_generation_enabled) {
            this.logger.log(`[${directory.slug}] AI-First Item Generation - Invoking`);

            const initialAiItems = await this.generateInitialItemsWithAI(
                directory.slug,
                dto,
                featuredItemHints,
                metrics,
            );
            this.logger.log(
                `[${directory.slug}] AI generated ${initialAiItems.length} initial items.`,
            );

            context.initialAiItems = initialAiItems;
        } else {
            this.logger.debug(`[${directory.slug}] AI-First Item Generation - Skipped`);
            context.initialAiItems = [];
        }

        return context;
    }

    async generateInitialItemsWithAI(
        directorySlug: string,
        createItemsGeneratorDto: CreateItemsGeneratorDto,
        featuredItemHints: string[] = [],
        metrics?: MetricsAccumulator,
    ): Promise<ItemData[]> {
        const {
            name: topicName,
            prompt: topicDescription,
            target_keywords,
        } = createItemsGeneratorDto;

        this.logger.log(
            `[${directorySlug}] AI-First Item Generation - Starting for topic: ${topicName}`,
        );
        const allGeneratedItems: ItemData[] = [];

        if (!this.aiService.isAiConfigured()) {
            this.logger.warn(
                `[${directorySlug}] OpenAI API Key not configured. Skipping AI-first item generation.`,
            );
            return [];
        }

        const keywordsString = target_keywords ? target_keywords.join(', ') : 'N/A';

        try {
            const {
                result: assessment,
                usage,
                cost,
            } = await this.aiService.askJson(
                UNDERSTANDING_PROMPT,
                promptUnderstandingAssessmentSchema,
                {
                    temperature: 0.3,
                    variables: {
                        topicName,
                        topicDescription,
                        target_keywords_string: keywordsString,
                    },
                },
            );

            accumulateMetrics(metrics, usage, cost);

            if (!assessment.can_proceed) {
                this.logger.warn(
                    `[${directorySlug}] AI cannot confidently proceed with item generation for topic "${topicName}" due to prompt clarity. Reason: ${assessment.reason_if_cannot_proceed || 'No specific reason provided.'}`,
                );
                if (
                    assessment.suggested_clarifications &&
                    assessment.suggested_clarifications.length > 0
                ) {
                    this.logger.warn(
                        `[${directorySlug}] AI suggested clarifications: ${assessment.suggested_clarifications.join('; ')}`,
                    );
                }
                return []; // Do not proceed with item generation
            }

            this.logger.log(
                `[${directorySlug}] AI assessment: Prompt for topic "${topicName}" is clear. Proceeding with item generation.`,
            );
        } catch (error) {
            this.logger.error(
                `[${directorySlug}] Error during AI prompt understanding assessment for topic "${topicName}": ${getErrorMessage(error)}. Proceeding with caution (will attempt item generation).`,
                getErrorStack(error),
            );
            // If the understanding check itself fails, we log the error but still attempt item generation.
            // This is a fallback in case the assessment mechanism has an issue.
        }

        // Generate featured hints section for the prompt
        const featuredHintsSection = this.generateFeaturedHintsSection(featuredItemHints);

        try {
            const { result, usage, cost } = await this.aiService.askJson(
                GENERATION_PROMPT,
                extractedItemsSchema,
                {
                    temperature: 0,
                    variables: {
                        topicName,
                        topicDescription,
                        target_keywords_string: keywordsString,
                        featured_hints_section: featuredHintsSection,
                    },
                },
            );

            accumulateMetrics(metrics, usage, cost);

            if (result && result.items && result.items.length > 0) {
                this.logger.log(
                    `[${directorySlug}] AI initially generated ${result.items.length} items.`,
                );
                for (const generatedItem of result.items) {
                    try {
                        const itemToValidate: Partial<ItemData> = {
                            ...generatedItem,
                        };

                        const validatedItem = itemDataSchema.parse(itemToValidate) as ItemData;

                        validatedItem.slug = slugifyText(validatedItem.name);

                        if (!validatedItem.source_url) {
                            this.logger.warn(
                                `[${directorySlug}] AI generated item "${validatedItem.name}" without a source_url. Deduplication might be affected.`,
                            );
                        }
                        allGeneratedItems.push(validatedItem);
                    } catch (validationError: any) {
                        this.logger.warn(
                            `[${directorySlug}] Discarding AI-generated item due to validation error: ${validationError.errors?.map((e: any) => e.message).join(', ') || getErrorMessage(validationError)}. Item: ${JSON.stringify(generatedItem)}`,
                        );
                    }
                }
            } else {
                this.logger.log(
                    `[${directorySlug}] No initial items generated by AI for topic: ${topicName}.`,
                );
            }
        } catch (error) {
            this.logger.error(
                `[${directorySlug}] Error generating initial items with AI for topic ${topicName}: ${getErrorMessage(error)}`,
                getErrorStack(error),
            );
        }

        this.logger.log(
            `[${directorySlug}] AI-First Item Generation - Complete. Validated ${allGeneratedItems.length} items.`,
        );
        return allGeneratedItems;
    }

    /**
     * Generate the featured hints section for the prompt
     * @param featuredItemHints Array of featured item specifications (guidelines, instructions, or criteria)
     * @returns Formatted section for the prompt
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
