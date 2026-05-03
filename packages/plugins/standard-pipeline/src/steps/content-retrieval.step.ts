import type { StepExecutionContext, WebPageData, FacadeOptions } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';

/**
 * Content Retrieval Step
 *
 * Retrieves web page content from URLs discovered during web search.
 * Uses ContentExtractorFacade for all content extraction (unified facade).
 */
export class ContentRetrievalStep extends BasePipelineStep {
	readonly name = 'Content Retrieval';
	readonly stepId = 'content-retrieval' as const;
	private readonly BATCH_SIZE = 10;
	private readonly BATCH_DELAY_MS = 500;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { request, work, extractedUrls, processedSourceUrls } = context;
		const { logger, contentExtractorFacade } = execContext;
		const config = request.config || {};

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			workId: execContext.work.id
		};

		logger.log(`[${work.slug}] Content Retrieval - Starting`);

		// Combine extractedUrls from previous steps with sourceUrls from config
		const sourceUrls = (config.source_urls as string[]) || [];
		const allUrls = [...new Set([...extractedUrls, ...sourceUrls])];

		if (allUrls.length === 0) {
			logger.log(`[${work.slug}] No URLs to retrieve content from`);
			return context;
		}

		// Filter out already processed URLs
		const urlsToProcess = allUrls.filter((url) => !processedSourceUrls.has(url));

		if (urlsToProcess.length === 0) {
			logger.log(`[${work.slug}] All URLs have already been processed`);
			return context;
		}

		logger.log(
			`[${work.slug}] Processing ${urlsToProcess.length} URLs (${allUrls.length - urlsToProcess.length} already processed)`
		);

		// Resolve provider name for user-facing warnings
		const extractorName =
			(await contentExtractorFacade.getActiveProviderName?.(facadeOptions)?.catch(() => null)) ?? null;
		const providerLabel = extractorName ? `Content extraction (${extractorName})` : 'Content extraction';

		// Process all URLs using ContentExtractorFacade (unified content extraction)
		const retrievedPages = await this.processUrls(
			work.slug,
			urlsToProcess,
			processedSourceUrls,
			contentExtractorFacade,
			logger,
			facadeOptions
		);

		// Update context
		context.webPages = [...context.webPages, ...retrievedPages];

		// Populate contentCache for reuse in markdown generation
		for (const page of retrievedPages) {
			if (page.source_url && page.raw_content) {
				context.contentCache.set(page.source_url, page.raw_content);
			}
		}

		logger.log(
			`[${work.slug}] Content Retrieval complete. Retrieved ${retrievedPages.length} pages (total: ${context.webPages.length})`
		);

		if (retrievedPages.length === 0 && urlsToProcess.length > 0) {
			this.addWarning(
				context,
				`${providerLabel} failed for all ${urlsToProcess.length} URLs. Check your content extraction provider configuration.`
			);
		}

		return context;
	}

	/**
	 * Process URLs using ContentExtractorFacade (unified content extraction).
	 *
	 * The facade internally handles routing to the appropriate plugin
	 * (Notion, Tavily, local-content-extractor, etc.).
	 */
	private async processUrls(
		slug: string,
		urls: string[],
		processedSourceUrls: Set<string>,
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		logger: StepExecutionContext['logger'],
		facadeOptions: FacadeOptions
	): Promise<WebPageData[]> {
		const pages: WebPageData[] = [];

		logger.debug(`[${slug}] Processing ${urls.length} URLs in batches of ${this.BATCH_SIZE}`);

		for (let i = 0; i < urls.length; i += this.BATCH_SIZE) {
			const batch = urls.slice(i, i + this.BATCH_SIZE);

			const extractionPromises = batch.map(async (url) => {
				try {
					const content = await contentExtractorFacade.extractContent(url, undefined, facadeOptions);

					if (!content?.rawContent) {
						logger.warn(`[${slug}] No content extracted from URL: ${url}`);
						return null;
					}

					// Mark as processed
					processedSourceUrls.add(url);

					return {
						source_url: url,
						raw_content: content.rawContent,
						retrieved_at: new Date().toISOString()
					} as WebPageData;
				} catch (error) {
					logger.error(
						`[${slug}] Error extracting content from ${url}: ${error instanceof Error ? error.message : String(error)}`
					);
					return null;
				}
			});

			const batchResults = await Promise.all(extractionPromises);
			const validResults = batchResults.filter((result): result is WebPageData => result !== null);
			pages.push(...validResults);

			// Add a delay between batches to be polite to APIs
			if (i + this.BATCH_SIZE < urls.length) {
				await this.delay(this.BATCH_DELAY_MS);
			}
		}

		logger.debug(`[${slug}] URL extraction complete: ${pages.length} pages retrieved`);
		return pages;
	}

	/**
	 * Helper to create a delay
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
