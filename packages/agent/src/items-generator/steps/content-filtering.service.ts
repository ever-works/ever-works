import { Injectable, Logger } from '@nestjs/common';
import { ConfigDto } from '../dto/create-items-generator.dto';
import {
    WebPageData,
    RelevanceAssessment,
    TopicAnalysis,
} from '../interfaces/items-generator.interfaces';
import { AiService } from 'src/ai';
import z from 'zod';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { accumulateMetrics } from '../utils/metrics.util';
import { getErrorMessage, getErrorStack } from '../utils/error.util';

const RELEVANCE_ASSESSMENT_PROMPT =
    `You are an expert content analyst. Assess the relevance of the following web page content to the main topic.

Topic: "{topic_name}"
Description: "{topic_description}"
{keywords}
{exclusions}

Web Page Content (first {snippet_length} characters):
{snippet}

Critically evaluate: Is this page's primary focus highly relevant to the topic and description above?
- Accept: Pages dedicated to the topic, comprehensive comparisons, core tutorials, official documentation, key project pages.
- Reject: Pages where the topic is only mentioned briefly, listicles covering many unrelated topics, off-topic niche pages (unless the niche is exactly the topic), low-signal forum threads, or purely marketing fluff.

Return a JSON object matching the provided schema.` as const;

const relevanceSchema = z
    .object({
        relevant: z.boolean().describe('Whether the content is highly relevant to the topic'),
        relevance_score: z
            .number()
            .min(0)
            .max(1)
            .describe('A score between 0.0 (not relevant) and 1.0 (highly relevant)'),
        reason: z.string().describe('A brief explanation for the relevance assessment'),
    })
    .strict() as z.ZodType<RelevanceAssessment>;

@Injectable()
export class ContentFilteringService implements IPipelineStep {
    private readonly logger = new Logger(ContentFilteringService.name);
    private BATCH_SIZE = 10;

    public readonly name = ItemsGeneratorStep.CONTENT_FILTERING;

    constructor(private readonly aiService: AiService) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { dto, directory, webPages, topicKeywords, metrics } = context;
        const { config } = dto;

        if (config.content_filtering_enabled) {
            this.logger.log(`[${directory.slug}] Content Filtering - Starting`);

            const filteredWebPages = await this.filterAndAssessPages(
                directory.slug,
                webPages,
                dto.name,
                dto.prompt,
                config,
                topicKeywords,
                metrics,
            );

            this.logger.log(
                `[${directory.slug}] Filtered down to ${filteredWebPages.length} relevant pages.`,
            );

            context.webPages = filteredWebPages;
        } else {
            this.logger.debug(`[${directory.slug}] Content Filtering - Skipped`);
        }

        return context;
    }

    async filterAndAssessPages(
        directorySlug: string,
        webPages: WebPageData[],
        topicName: string,
        topicDescription: string,
        config: Required<ConfigDto>,
        topicKeywords?: TopicAnalysis,
        metrics?: GenerationContext['metrics'],
    ): Promise<WebPageData[]> {
        this.logger.log(
            `[${directorySlug}] Starting content filtering for ${webPages.length} pages`,
        );

        const filteredPages = webPages
            .filter((page, index, self) => {
                return index === self.findIndex((t) => t.source_url === page.source_url);
            })
            .filter((page) => {
                const isLongEnough =
                    (page.raw_content?.length ?? 0) >= config.min_content_length_for_extraction;

                return isLongEnough;
            });

        // Check if OpenAI API is configured
        if (!this.aiService.isAiConfigured()) {
            return filteredPages;
        }

        this.logger.log(
            `[${directorySlug}] ${filteredPages.length} pages passed initial length filter`,
        );

        if (filteredPages.length === 0) {
            return [];
        }

        // Define the relevance assessment function
        const assessPageRelevance = async (
            page: WebPageData,
        ): Promise<{
            page: WebPageData;
            isRelevant: boolean;
            assessment?: RelevanceAssessment;
            error?: any;
        }> => {
            try {
                this.logger.log(`[${directorySlug}] Assessing relevance for: ${page.source_url}`);

                const snippet = this.buildSnippet(page.raw_content);
                const keywords =
                    topicKeywords?.primary_keywords && topicKeywords.primary_keywords.length > 0
                        ? `Primary Keywords: ${topicKeywords.primary_keywords.join(', ')}`
                        : 'Primary Keywords: N/A';
                const exclusions =
                    topicKeywords?.exclusion_terms && topicKeywords.exclusion_terms.length > 0
                        ? `Exclusion Terms: ${topicKeywords.exclusion_terms.join(', ')}`
                        : 'Exclusion Terms: N/A';

                const {
                    result: assessmentResult,
                    usage,
                    cost,
                } = await this.aiService.askJson(RELEVANCE_ASSESSMENT_PROMPT, relevanceSchema, {
                    temperature: 0,
                    variables: {
                        topic_name: topicName,
                        topic_description: topicDescription,
                        keywords,
                        exclusions,
                        snippet_length: String(snippet.length),
                        snippet,
                    },
                });

                accumulateMetrics(metrics, usage, cost);

                const isRelevant =
                    assessmentResult.relevant &&
                    assessmentResult.relevance_score >= config.relevance_threshold_content;

                if (isRelevant) {
                    this.logger.log(
                        `[${directorySlug}] Relevant page (Score: ${assessmentResult.relevance_score}): ${page.source_url} - Reason: ${assessmentResult.reason}`,
                    );
                } else {
                    this.logger.log(
                        `[${directorySlug}] Discarding page (Not relevant/Score too low: ${assessmentResult.relevance_score}): ${page.source_url} - Reason: ${assessmentResult.reason}`,
                    );
                }

                return { page, isRelevant, assessment: assessmentResult };
            } catch (error) {
                this.logger.error(
                    `[${directorySlug}] Error assessing relevance for ${page.source_url}: ${getErrorMessage(error)}`,
                    getErrorStack(error),
                );
                this.logger.warn(
                    `[${directorySlug}] Keeping page due to relevance assessment error (will rely on later extraction quality): ${page.source_url}`,
                );
                return { page, isRelevant: true, error };
            }
        };

        // Step 3: Process pages in batches to avoid rate limits
        const relevantPages: WebPageData[] = [];

        this.logger.log(
            `[${directorySlug}] Processing relevance assessment in batches of ${this.BATCH_SIZE}`,
        );

        // Process pages in batches
        for (let i = 0; i < filteredPages.length; i += this.BATCH_SIZE) {
            const batch = filteredPages.slice(i, i + this.BATCH_SIZE);

            // Process the batch in parallel
            const assessmentPromises = batch.map((page) => assessPageRelevance(page));
            const assessmentResults = await Promise.all(assessmentPromises);

            // Filter relevant pages from this batch
            const relevantPagesFromBatch = assessmentResults
                .filter((result) => result.isRelevant)
                .map((result) => result.page);

            relevantPages.push(...relevantPagesFromBatch);

            // Add a small delay between batches to avoid rate limiting
            if (i + this.BATCH_SIZE < filteredPages.length) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }

        this.logger.log(
            `[${directorySlug}] Content filtering complete. ${relevantPages.length} relevant pages found out of ${webPages.length} total pages.`,
        );
        return relevantPages;
    }

    private buildSnippet(content: string): string {
        const SNIPPET_LENGTH = 3000;
        if (!content) return '';
        return content.length > SNIPPET_LENGTH ? content.slice(0, SNIPPET_LENGTH) : content;
    }
}
