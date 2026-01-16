import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { z } from 'zod';
import { ItemData, ConfigDto } from '../dto';
import { AiService, TaskComplexity } from 'src/ai';
import { SearchService } from '../shared';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { accumulateMetrics } from '../utils/metrics.util';
import { appendCustomPrompt } from '../utils/prompt.util';

const urlValidationSchema = z.object({
    is_official: z.boolean(),
    is_relevant: z.boolean(),
    confidence_score: z.number().min(0).max(1),
    url_type: z.enum([
        'official_website',
        'github_repository',
        'documentation',
        'blog_post',
        'news_article',
        'marketplace',
        'other',
    ]),
    reasoning: z.string(),
});

const URL_VALIDATION_PROMPT =
    `You are an expert at identifying official and canonical URLs for software tools, libraries, frameworks, and other technical items.

Given an item name, description, and a candidate URL with its content, determine if this URL is the official/canonical source for the item.

Item Name: {itemName}
Item Description: {itemDescription}
Candidate URL: {candidateUrl}
Page Content (first 2000 chars): {pageContent}

Analyze the URL and content to determine:
1. Is this the official website, GitHub repository, or primary documentation for the item?
2. Is this just a blog post, news article, or secondary source talking about the item?
3. How confident are you in this assessment?

Prefer official sources in this order:
1. Official project website/homepage
2. GitHub/GitLab repository
3. Official documentation
4. Package manager pages (npm, PyPI, etc.)
5. Avoid: blog posts, news articles, tutorials, unless they are the only authoritative source
` as const;

@Injectable()
export class SourceValidationService implements IPipelineStep {
    private readonly logger = new Logger(SourceValidationService.name);

    public readonly name = ItemsGeneratorStep.SOURCES_VALIDATION;

    constructor(
        private readonly searchService: SearchService,
        private readonly aiService: AiService,
    ) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { directory, finalItems, metrics, subject, advancedPrompts } = context;

        this.logger.log(
            `[${directory.slug}] Validating source URLs for ${finalItems.length} items`,
        );

        const validatedItems = await this.filterAndValidateSourceItems(
            finalItems,
            metrics,
            subject,
            advancedPrompts?.sourceValidation,
        );

        context.finalItems = validatedItems;

        return context;
    }

    async filterAndValidateSourceItems(
        items: ItemData[],
        metrics?: GenerationContext['metrics'],
        subject?: string,
        customPrompt?: string | null,
    ): Promise<ItemData[]> {
        if (!items || items.length === 0) {
            return [];
        }

        const BATCH_SIZE = 15;
        const validItems: ItemData[] = [];
        const startTime = Date.now();

        try {
            for (let i = 0; i < items.length; i += BATCH_SIZE) {
                const batch = items.slice(i, i + BATCH_SIZE);

                const validationPromises = batch.map((item) => {
                    return this.validateAndFetchSourceUrl(item, metrics, subject, customPrompt)
                        .then((validatedSourceUrl) => {
                            if (validatedSourceUrl) {
                                return { ...item, source_url: validatedSourceUrl, valid: true };
                            }
                            return { ...item, valid: false };
                        })
                        .catch(() => ({ ...item, valid: false }));
                });

                const batchResults = await Promise.all(validationPromises);
                const validBatchItems = batchResults
                    .filter((item) => item.valid)
                    .map(({ valid, ...item }) => item);
                validItems.push(...validBatchItems);

                if (i + BATCH_SIZE < items.length) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }
        } catch (error) {
            this.logger.error(`Source URL validation error: ${error.message}`);
        }

        const processingTime = (Date.now() - startTime) / 1000;
        this.logger.log(
            `Source validation complete: ${validItems.length}/${items.length} passed in ${processingTime.toFixed(1)}s`,
        );

        return validItems;
    }

    private async validateAndFetchSourceUrl(
        currentItem: ItemData,
        metrics?: GenerationContext['metrics'],
        subject?: string,
        customPrompt?: string | null,
    ): Promise<string | undefined> {
        const sourceUrl = currentItem.source_url;
        const itemName = currentItem.name;
        const itemDescription = currentItem.description;

        if (this.isGoogleSearchUrl(sourceUrl)) {
            return undefined;
        }

        const validateUrl = async (urlToValidate: string): Promise<string | undefined> => {
            if (!urlToValidate || typeof urlToValidate !== 'string') {
                return undefined;
            }

            if (this.isGoogleSearchUrl(urlToValidate)) {
                return undefined;
            }

            try {
                new URL(urlToValidate);
            } catch {
                return undefined;
            }

            const axiosConfig = {
                validateStatus: (status: number) => status >= 200 && status < 400,
                headers: {
                    Accept: 'text/html',
                    'Accept-Encoding': 'gzip, deflate',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'max-age=0',
                    'Upgrade-Insecure-Requests': '1',
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                },
            };

            try {
                await axios.head(urlToValidate, { ...axiosConfig, timeout: 5000 });
                return urlToValidate;
            } catch {
                try {
                    await axios.get(urlToValidate, {
                        ...axiosConfig,
                        timeout: 8000,
                        maxContentLength: 1024,
                        headers: { ...axiosConfig.headers, Range: 'bytes=0-1024' },
                    });
                    return urlToValidate;
                } catch {
                    return undefined;
                }
            }
        };

        const validatedInitialUrl = await validateUrl(sourceUrl);
        if (validatedInitialUrl) {
            return validatedInitialUrl;
        }

        try {
            const safeItemName = typeof itemName === 'string' ? itemName : 'item';
            const safeItemDescription =
                typeof itemDescription === 'string' ? itemDescription.substring(0, 100) : '';

            const searchQueries = this.generateOfficialSourceQueries(
                safeItemName,
                safeItemDescription,
                subject,
            );

            const allDocuments = [];
            for (const query of searchQueries) {
                try {
                    const documents = await this.webSearch(query, { max_results_per_query: 3 });
                    if (documents?.length > 0) {
                        allDocuments.push(...documents);
                    }
                } catch {
                    // Search failed, continue with other queries
                }
            }

            if (allDocuments.length === 0) {
                return undefined;
            }

            const uniqueUrls = Array.from(
                new Set(
                    allDocuments
                        .filter((doc) => doc.url && typeof doc.url === 'string')
                        .map((doc) => doc.url),
                ),
            );

            if (uniqueUrls.length === 0) {
                return undefined;
            }

            const urlAnalysisPromises = uniqueUrls.slice(0, 8).map(async (url) => {
                // for now, skip basic validation (we just trust the search results)
                // const basicValidation = await validateUrl(url);
                // if (!basicValidation) {
                //     return null;
                // }

                const aiValidation = await this.validateUrlWithAI(
                    safeItemName,
                    safeItemDescription,
                    url,
                    metrics,
                    customPrompt,
                );
                return { url, aiValidation };
            });

            const urlAnalysisResults = await Promise.all(urlAnalysisPromises);
            const validResults = urlAnalysisResults.filter((result) => result !== null);

            if (validResults.length === 0) {
                return undefined;
            }

            let bestUrl = null;
            let bestScore = 0;

            for (const result of validResults) {
                if (result.aiValidation) {
                    const { isOfficial, confidence } = result.aiValidation;
                    const score = isOfficial ? confidence : confidence * 0.3;

                    if (score > bestScore) {
                        bestScore = score;
                        bestUrl = result.url;
                    }
                } else if (bestScore === 0) {
                    bestUrl = result.url;
                    bestScore = 0.1;
                }
            }

            if (bestUrl && bestScore > 0.2) {
                return bestUrl;
            }

            return bestUrl;
        } catch (error) {
            this.logger.error(`Search error for "${itemName}": ${error.message}`);
        }

        return undefined;
    }

    private async webSearch(query: string, config?: Partial<ConfigDto>) {
        return this.searchService.webSearch(query, config);
    }

    private async validateUrlWithAI(
        itemName: string,
        itemDescription: string,
        candidateUrl: string,
        metrics?: GenerationContext['metrics'],
        customPrompt?: string | null,
    ): Promise<{ isOfficial: boolean; confidence: number; reasoning: string } | null> {
        if (!this.aiService.isAiConfigured()) {
            return null;
        }

        try {
            let pageContent = '';
            try {
                const extractedContent = await this.searchService.extractContent(candidateUrl);
                pageContent = extractedContent.rawContent || '';
            } catch {
                // Continue with empty content - AI can still analyze the URL structure
            }

            const midContent = Math.floor(pageContent.length / 2);
            const partialContent =
                pageContent.slice(midContent - 1000, midContent + 1000) ||
                pageContent.slice(0, 2000);

            const finalPrompt = appendCustomPrompt(URL_VALIDATION_PROMPT, customPrompt);
            const { result, usage, cost } = await this.aiService.askJson(
                finalPrompt,
                urlValidationSchema,
                {
                    temperature: 0.1,
                    variables: {
                        itemName,
                        itemDescription,
                        candidateUrl,
                        pageContent: partialContent,
                    },
                    routing: {
                        complexity: TaskComplexity.SIMPLE,
                        taskId: 'source-validation',
                    },
                },
            );

            accumulateMetrics(metrics, usage, cost);

            return {
                isOfficial: result.is_official && result.is_relevant,
                confidence: result.confidence_score,
                reasoning: result.reasoning,
            };
        } catch {
            return null;
        }
    }

    private generateOfficialSourceQueries(
        itemName: string,
        itemDescription: string,
        subject?: string,
    ): string[] {
        const queries = [];

        if (subject) {
            queries.push(`"${itemName}" ${subject}`);
        }

        const descriptionLower = itemDescription.toLowerCase();
        if (descriptionLower.includes('library') || descriptionLower.includes('framework')) {
            queries.push(`"${itemName}" library`);
        }
        if (descriptionLower.includes('tool') || descriptionLower.includes('software')) {
            queries.push(`"${itemName}" tool official site`);
        }

        if (queries.length === 0) {
            queries.push(`"${itemName}" official website`);
        }

        return queries;
    }

    private isGoogleSearchUrl(url: string): boolean {
        if (!url || typeof url !== 'string') {
            return false;
        }
        return /google\.(?:com?\.)?[a-z]{2,3}\/search/i.test(url);
    }
}
