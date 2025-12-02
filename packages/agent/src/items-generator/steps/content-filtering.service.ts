import { Injectable, Logger } from '@nestjs/common';
import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { WebPageData, RelevanceAssessment } from '../interfaces/items-generator.interfaces';
import { AiService, BaseChatModel, ModelRouterService, TaskComplexity } from 'src/ai';
import z from 'zod';

const relevanceSchema = z.object({
    relevant: z.boolean().describe('Whether the content is highly relevant to the topic'),
    relevance_score: z
        .number()
        .min(0)
        .max(1)
        .describe('A score between 0.0 (not relevant) and 1.0 (highly relevant)'),
    reason: z.string().describe('A brief explanation for the relevance assessment'),
});

import { ContentPrefilterService } from './content-prefilter.service';

@Injectable()
export class ContentFilteringService {
    private readonly logger = new Logger(ContentFilteringService.name);
    private llm: BaseChatModel;
    private BATCH_SIZE = 10;

    constructor(
        private readonly aiService: AiService,
        private readonly modelRouter: ModelRouterService,
        private readonly contentPrefilterService: ContentPrefilterService,
    ) {
        this.llm = this.modelRouter.getModel(TaskComplexity.MEDIUM);
    }

    async filterAndAssessPages(
        directorySlug: string,
        webPages: WebPageData[],
        topicName: string,
        topicDescription: string,
        config: Required<ConfigDto>,
    ): Promise<WebPageData[]> {
        this.logger.log(
            `[${directorySlug}] Starting content filtering for ${webPages.length} pages`,
        );

        // 1. Basic deduplication and length filter
        const initialFilteredPages = webPages
            .filter((page, index, self) => {
                return index === self.findIndex((t) => t.source_url === page.source_url);
            })
            .filter((page) => {
                const isLongEnough =
                    (page.raw_content?.length ?? 0) >= config.min_content_length_for_extraction;

                return isLongEnough;
            });

        this.logger.log(
            `[${directorySlug}] ${initialFilteredPages.length} pages passed initial length filter`,
        );

        if (initialFilteredPages.length === 0) {
            return [];
        }

        // 2. Fast Heuristic Prefiltering (NEW)
        const prefilteredPages = this.contentPrefilterService.prefilterPages(
            initialFilteredPages,
            topicName,
            topicDescription,
        );

        const discardedByPrefilter = initialFilteredPages.length - prefilteredPages.length;
        if (discardedByPrefilter > 0) {
            this.logger.log(
                `[${directorySlug}] Prefilter discarded ${discardedByPrefilter} pages (low quality/relevance). Remaining: ${prefilteredPages.length}`,
            );
        }

        // Check if OpenAI API is configured
        if (!this.aiService.isAiConfigured()) {
            return prefilteredPages;
        }

        if (prefilteredPages.length === 0) {
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

                // Stricter prompt for page relevance
                const prompt = HumanMessagePromptTemplate.fromTemplate(
                    `You are an expert content analyst. Assess the relevance of the following web page content to the **main topic**: "{topicName}" (Description: "{topicDescription}").

Web Page Content (first 3000 characters):
<content>
{page_content_snippet}
</content>

**Critically evaluate:** Is this page's **primary focus** highly relevant to "{topicName}" and "{topicDescription}"?
- **Accept:** Pages dedicated to the topic, comprehensive comparisons, core tutorials, official documentation, key project pages.
- **Reject:** Pages where the topic is only mentioned briefly, listicles covering many unrelated topics, pages focused *only* on a very specific niche *unless* that niche is the explicit topic "{topicName}" (e.g., reject a page *only* about a Ruby vector library if the topic is general vector databases), forum threads with low signal-to-noise, or purely marketing pages.

Provide a relevance score between 0.0 (not relevant) and 1.0 (highly relevant). Only assign a high score if the primary focus aligns strongly with "{topicName}".
`,
                );

                const relevanceChain = prompt.pipe(this.llm.withStructuredOutput(relevanceSchema));

                const SNIPPET_LENGTH = 3000;
                const snippet_middle = Math.floor(page.raw_content.length / 2);

                const page_content_snippet =
                    page.raw_content.length > SNIPPET_LENGTH
                        ? page.raw_content.slice(
                              page.raw_content.length / 2 - snippet_middle,
                              page.raw_content.length / 2 + snippet_middle,
                          )
                        : page.raw_content;

                const assessmentResult = (await relevanceChain.invoke({
                    topicName,
                    topicDescription,
                    page_content_snippet,
                })) as RelevanceAssessment;

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
                    `[${directorySlug}] Error assessing relevance for ${page.source_url}: ${error.message}`,
                    error.stack,
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
        for (let i = 0; i < prefilteredPages.length; i += this.BATCH_SIZE) {
            const batch = prefilteredPages.slice(i, i + this.BATCH_SIZE);

            // Process the batch in parallel
            const assessmentPromises = batch.map((page) => assessPageRelevance(page));
            const assessmentResults = await Promise.all(assessmentPromises);

            // Filter relevant pages from this batch
            const relevantPagesFromBatch = assessmentResults
                .filter((result) => result.isRelevant)
                .map((result) => result.page);

            relevantPages.push(...relevantPagesFromBatch);

            // Add a small delay between batches to avoid rate limiting
            if (i + this.BATCH_SIZE < prefilteredPages.length) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }

        this.logger.log(
            `[${directorySlug}] Content filtering complete. ${relevantPages.length} relevant pages found out of ${webPages.length} total pages.`,
        );
        return relevantPages;
    }
}
