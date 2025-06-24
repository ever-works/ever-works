import { Injectable, Logger } from '@nestjs/common';
import { PromptTemplate } from '@langchain/core/prompts';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { WebPageData, RelevanceAssessment } from '../interfaces/items-generator.interfaces';
import { AiService } from '../shared';
import { BaseChatModel } from '../shared/ai-provider.interface';
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

@Injectable()
export class ContentFilteringService {
    private readonly logger = new Logger(ContentFilteringService.name);
    private llm: BaseChatModel;
    private BATCH_SIZE = 10;

    constructor(private readonly aiService: AiService) {
        this.llm = this.aiService.getLlm();
    }

    async filterAndAssessPages(
        slug: string,
        webPages: WebPageData[],
        topicName: string,
        topicDescription: string,
        config: Required<ConfigDto>,
    ): Promise<WebPageData[]> {
        this.logger.log(`[${slug}] Starting content filtering for ${webPages.length} pages`);

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

        this.logger.log(`[${slug}] ${filteredPages.length} pages passed initial length filter`);

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
                this.logger.log(`[${slug}] Assessing relevance for: ${page.source_url}`);

                // Stricter prompt for page relevance
                const prompt = PromptTemplate.fromTemplate(
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

                const page_content_snippet =
                    page.raw_content.length > 3000
                        ? page.raw_content.slice(
                              page.raw_content.length / 2 - 1500,
                              page.raw_content.length / 2 + 1500,
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
                        `[${slug}] Relevant page (Score: ${assessmentResult.relevance_score}): ${page.source_url} - Reason: ${assessmentResult.reason}`,
                    );
                } else {
                    this.logger.log(
                        `[${slug}] Discarding page (Not relevant/Score too low: ${assessmentResult.relevance_score}): ${page.source_url} - Reason: ${assessmentResult.reason}`,
                    );
                }

                return { page, isRelevant, assessment: assessmentResult };
            } catch (error) {
                this.logger.error(
                    `[${slug}] Error assessing relevance for ${page.source_url}: ${error.message}`,
                    error.stack,
                );
                this.logger.warn(
                    `[${slug}] Keeping page due to relevance assessment error (will rely on later extraction quality): ${page.source_url}`,
                );
                return { page, isRelevant: true, error };
            }
        };

        // Step 3: Process pages in batches to avoid rate limits
        const relevantPages: WebPageData[] = [];

        this.logger.log(
            `[${slug}] Processing relevance assessment in batches of ${this.BATCH_SIZE}`,
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
            `[${slug}] Content filtering complete. ${relevantPages.length} relevant pages found out of ${webPages.length} total pages.`,
        );
        return relevantPages;
    }
}
