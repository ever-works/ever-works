import { z } from 'zod';
import type { StepExecutionContext, MutableItemData, FacadeOptions } from '@ever-works/plugin';
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers';
import type { MutableGenerationContext, StandardPipelineMetrics } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { appendCustomPrompt } from '../utils/prompt.utils.js';
import { PROMPT_KEYS } from '../prompt-keys.js';

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
		'other'
	]),
	reasoning: z.string()
});

type UrlValidationResult = z.infer<typeof urlValidationSchema>;

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

/**
 * Source Validation Step
 *
 * Validates and corrects source URLs for items using web search and AI.
 */
export class SourceValidationStep extends BasePipelineStep {
	readonly name = 'Sources Validation';
	readonly stepId = 'sources-validation' as const;
	private readonly BATCH_SIZE = 15;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { work, finalItems, metrics, subject, advancedPrompts } = context;
		const { logger, aiFacade, searchFacade, contentExtractorFacade, promptFacade } = execContext;

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			workId: execContext.work.id
		};

		logger.log(`[${work.slug}] Validating source URLs for ${finalItems.length} items`);

		const validatedItems = await this.filterAndValidateSourceItems(
			finalItems,
			metrics,
			subject,
			advancedPrompts?.sourceValidation,
			logger,
			aiFacade,
			searchFacade,
			contentExtractorFacade,
			facadeOptions,
			promptFacade
		);

		context.finalItems = validatedItems;

		return context;
	}

	private async filterAndValidateSourceItems(
		items: MutableItemData[],
		metrics: StandardPipelineMetrics,
		subject: string | undefined,
		customPrompt: string | null | undefined,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		searchFacade: StepExecutionContext['searchFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions,
		promptFacade?: StepExecutionContext['promptFacade']
	): Promise<MutableItemData[]> {
		if (!items || items.length === 0) {
			return [];
		}

		const validItems: MutableItemData[] = [];
		const startTime = Date.now();

		try {
			for (let i = 0; i < items.length; i += this.BATCH_SIZE) {
				const batch = items.slice(i, i + this.BATCH_SIZE);

				const validationPromises = batch.map((item) => {
					return this.validateAndFetchSourceUrl(
						item,
						metrics,
						subject,
						customPrompt,
						logger,
						aiFacade,
						searchFacade,
						contentExtractorFacade,
						facadeOptions,
						promptFacade
					)
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
					.map(({ valid, ...item }) => item as MutableItemData);
				validItems.push(...validBatchItems);

				if (i + this.BATCH_SIZE < items.length) {
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
		} catch (error) {
			logger.error(`Source URL validation error: ${this.formatError(error)}`);
		}

		const processingTime = (Date.now() - startTime) / 1000;
		logger.log(
			`Source validation complete: ${validItems.length}/${items.length} passed in ${processingTime.toFixed(1)}s`
		);

		return validItems;
	}

	private async validateAndFetchSourceUrl(
		currentItem: MutableItemData,
		metrics: StandardPipelineMetrics,
		subject: string | undefined,
		customPrompt: string | null | undefined,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		searchFacade: StepExecutionContext['searchFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions,
		promptFacade?: StepExecutionContext['promptFacade']
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

			// H-11: refuse to probe URLs pointing at private, loopback,
			// link-local, or cloud-metadata IPs. Returning a boolean from this
			// step still let an attacker map internal ports / ping IMDS via
			// the timing of the fetch — close the side-channel entirely.
			if (!isSafeWebhookUrl(urlToValidate)) {
				return undefined;
			}

			// Use fetch for basic URL validation instead of axios
			try {
				const response = await fetch(urlToValidate, {
					method: 'HEAD',
					headers: {
						Accept: 'text/html',
						'User-Agent':
							'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
					},
					signal: AbortSignal.timeout(5000)
				});
				if (response.ok) {
					return urlToValidate;
				}
			} catch {
				// Try GET as fallback
				try {
					const response = await fetch(urlToValidate, {
						method: 'GET',
						headers: {
							Accept: 'text/html',
							Range: 'bytes=0-1024',
							'User-Agent':
								'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
						},
						signal: AbortSignal.timeout(8000)
					});
					if (response.ok) {
						return urlToValidate;
					}
				} catch {
					return undefined;
				}
			}
			return undefined;
		};

		const validatedInitialUrl = await validateUrl(sourceUrl || '');
		if (validatedInitialUrl) {
			return validatedInitialUrl;
		}

		try {
			const safeItemName = typeof itemName === 'string' ? itemName : 'item';
			const safeItemDescription = typeof itemDescription === 'string' ? itemDescription.substring(0, 100) : '';

			const searchQueries = this.generateOfficialSourceQueries(safeItemName, safeItemDescription, subject);

			const allDocuments: Array<{ url: string }> = [];
			for (const query of searchQueries) {
				try {
					const documents = await searchFacade.search(query, { maxResults: 3 }, facadeOptions);
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
				new Set(allDocuments.filter((doc) => doc.url && typeof doc.url === 'string').map((doc) => doc.url))
			);

			if (uniqueUrls.length === 0) {
				return undefined;
			}

			const urlAnalysisPromises = uniqueUrls.slice(0, 8).map(async (url) => {
				const aiValidation = await this.validateUrlWithAI(
					safeItemName,
					safeItemDescription,
					url,
					metrics,
					customPrompt,
					aiFacade,
					contentExtractorFacade,
					facadeOptions,
					promptFacade
				);
				return { url, aiValidation };
			});

			const urlAnalysisResults = await Promise.all(urlAnalysisPromises);
			const validResults = urlAnalysisResults.filter((result) => result !== null);

			if (validResults.length === 0) {
				return undefined;
			}

			let bestUrl: string | null = null;
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

			return bestUrl || undefined;
		} catch (error) {
			logger.error(`Search error for "${itemName}": ${this.formatError(error)}`);
		}

		return undefined;
	}

	private async validateUrlWithAI(
		itemName: string,
		itemDescription: string,
		candidateUrl: string,
		metrics: StandardPipelineMetrics,
		customPrompt: string | null | undefined,
		aiFacade: StepExecutionContext['aiFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		facadeOptions: FacadeOptions,
		promptFacade?: StepExecutionContext['promptFacade']
	): Promise<{ isOfficial: boolean; confidence: number; reasoning: string } | null> {
		if (!aiFacade.isConfigured()) {
			return null;
		}

		try {
			let pageContent = '';
			try {
				const extractedContent = await contentExtractorFacade.extractContent(
					candidateUrl,
					undefined,
					facadeOptions
				);
				pageContent = extractedContent?.rawContent || '';
			} catch {
				// Continue with empty content - AI can still analyze the URL structure
			}

			const midContent = Math.floor(pageContent.length / 2);
			const partialContent =
				pageContent.slice(midContent - 1000, midContent + 1000) || pageContent.slice(0, 2000);

			const resolvedPrompt = (
				promptFacade
					? await promptFacade.getPrompt(PROMPT_KEYS.SOURCE_VALIDATION, URL_VALIDATION_PROMPT)
					: URL_VALIDATION_PROMPT
			) as typeof URL_VALIDATION_PROMPT;
			const finalPrompt = appendCustomPrompt(resolvedPrompt, customPrompt);
			const { result, usage, cost } = await aiFacade.askJson<UrlValidationResult>(
				finalPrompt,
				urlValidationSchema,
				{
					temperature: 0.1,
					variables: {
						itemName,
						itemDescription,
						candidateUrl,
						pageContent: partialContent
					},
					routing: {
						complexity: 'simple',
						taskId: 'source-validation'
					}
				},
				facadeOptions
			);

			this.accumulateMetrics(metrics, usage, cost);

			return {
				isOfficial: result.is_official && result.is_relevant,
				confidence: result.confidence_score,
				reasoning: result.reasoning
			};
		} catch {
			return null;
		}
	}

	private generateOfficialSourceQueries(itemName: string, itemDescription: string, subject?: string): string[] {
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

	private isGoogleSearchUrl(url: string | undefined): boolean {
		if (!url || typeof url !== 'string') {
			return false;
		}
		return /google\.(?:com?\.)?[a-z]{2,3}\/search/i.test(url);
	}
}
