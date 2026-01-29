import type {
	IBuiltInStepExecutor,
	MutableGenerationContext,
	StepExecutionContext,
	WebPageData
} from '@ever-works/plugin';

/**
 * Content Retrieval Step
 *
 * Retrieves web page content from URLs discovered during web search.
 * This step is responsible for:
 * - Fetching content from extractedUrls
 * - Processing source_urls from the request
 * - Populating webPages array and contentCache map
 * - Tracking processedSourceUrls to avoid duplicates
 *
 * Uses ContentExtractorFacade for specialized content extraction (Notion, Google Docs, etc.)
 * and SearchFacade for general web page content extraction.
 */
export class ContentRetrievalStep implements IBuiltInStepExecutor {
	readonly name = 'Content Retrieval';
	readonly stepId = 'content-retrieval';
	private readonly BATCH_SIZE = 10;
	private readonly BATCH_DELAY_MS = 500;

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, directory, extractedUrls, processedSourceUrls } = context;
		const { logger, searchFacade, contentExtractorFacade } = execContext;
		const config = request.config || {};

		logger.log(`[${directory.slug}] Content Retrieval - Starting`);

		// Combine extractedUrls from previous steps with sourceUrls from config
		const sourceUrls = (config.source_urls as string[]) || [];
		const allUrls = [...new Set([...extractedUrls, ...sourceUrls])];

		if (allUrls.length === 0) {
			logger.log(`[${directory.slug}] No URLs to retrieve content from`);
			return context;
		}

		// Filter out already processed URLs
		const urlsToProcess = allUrls.filter((url) => !processedSourceUrls.has(url));

		if (urlsToProcess.length === 0) {
			logger.log(`[${directory.slug}] All URLs have already been processed`);
			return context;
		}

		logger.log(
			`[${directory.slug}] Processing ${urlsToProcess.length} URLs (${allUrls.length - urlsToProcess.length} already processed)`
		);

		// Separate URLs that can be handled by data source plugins from regular URLs
		const dataSourceUrls: string[] = [];
		const regularUrls: string[] = [];

		for (const url of urlsToProcess) {
			if (contentExtractorFacade.canHandle(url)) {
				dataSourceUrls.push(url);
			} else {
				regularUrls.push(url);
			}
		}

		logger.debug(
			`[${directory.slug}] URL breakdown: ${dataSourceUrls.length} data source URLs, ${regularUrls.length} regular URLs`
		);

		const retrievedPages: WebPageData[] = [];

		// Process data source URLs (Notion, Google Docs, etc.)
		if (dataSourceUrls.length > 0) {
			const dataSourcePages = await this.processDataSourceUrls(
				directory.slug,
				dataSourceUrls,
				processedSourceUrls,
				contentExtractorFacade,
				logger
			);
			retrievedPages.push(...dataSourcePages);
		}

		// Process regular URLs using search facade
		if (regularUrls.length > 0) {
			const regularPages = await this.processRegularUrls(
				directory.slug,
				regularUrls,
				processedSourceUrls,
				searchFacade,
				logger
			);
			retrievedPages.push(...regularPages);
		}

		// Update context
		context.webPages = [...context.webPages, ...retrievedPages];

		// Populate contentCache for reuse in markdown generation
		for (const page of retrievedPages) {
			if (page.source_url && page.raw_content) {
				context.contentCache.set(page.source_url, page.raw_content);
			}
		}

		logger.log(
			`[${directory.slug}] Content Retrieval complete. Retrieved ${retrievedPages.length} pages (total: ${context.webPages.length})`
		);

		return context;
	}

	/**
	 * Process URLs using data source plugins (Notion, Google Docs, etc.)
	 */
	private async processDataSourceUrls(
		slug: string,
		urls: string[],
		processedSourceUrls: Set<string>,
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		logger: StepExecutionContext['logger']
	): Promise<WebPageData[]> {
		const pages: WebPageData[] = [];

		logger.debug(`[${slug}] Processing ${urls.length} data source URLs`);

		for (const url of urls) {
			// Check if the plugin is configured
			if (!contentExtractorFacade.isConfigured(url)) {
				logger.warn(`[${slug}] Data source plugin not configured for URL: ${url}`);
				continue;
			}

			try {
				const content = await contentExtractorFacade.extractContent(url);

				if (content && content.rawContent) {
					processedSourceUrls.add(url);
					pages.push({
						source_url: url,
						raw_content: content.rawContent,
						retrieved_at: new Date().toISOString()
					});
					logger.debug(`[${slug}] Successfully extracted content from data source: ${url}`);
				} else {
					logger.warn(`[${slug}] No content extracted from data source URL: ${url}`);
				}
			} catch (error) {
				logger.error(
					`[${slug}] Error extracting content from data source URL ${url}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}

		logger.debug(`[${slug}] Data source extraction complete: ${pages.length} pages retrieved`);
		return pages;
	}

	/**
	 * Process regular URLs using search facade
	 */
	private async processRegularUrls(
		slug: string,
		urls: string[],
		processedSourceUrls: Set<string>,
		searchFacade: StepExecutionContext['searchFacade'],
		logger: StepExecutionContext['logger']
	): Promise<WebPageData[]> {
		const pages: WebPageData[] = [];

		logger.debug(`[${slug}] Processing ${urls.length} regular URLs in batches of ${this.BATCH_SIZE}`);

		for (let i = 0; i < urls.length; i += this.BATCH_SIZE) {
			const batch = urls.slice(i, i + this.BATCH_SIZE);

			const extractionPromises = batch.map(async (url) => {
				try {
					const response = await searchFacade.extractContent(url);

					if (!response.rawContent) {
						logger.warn(`[${slug}] No content extracted from URL: ${url}`);
						return null;
					}

					// Mark as processed
					processedSourceUrls.add(url);

					return {
						source_url: url,
						raw_content: response.rawContent,
						retrieved_at: new Date().toISOString()
					} as WebPageData;
				} catch (error) {
					logger.error(
						`[${slug}] Error fetching content from ${url}: ${error instanceof Error ? error.message : String(error)}`
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

		logger.debug(`[${slug}] Regular URL extraction complete: ${pages.length} pages retrieved`);
		return pages;
	}

	/**
	 * Helper to create a delay
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
