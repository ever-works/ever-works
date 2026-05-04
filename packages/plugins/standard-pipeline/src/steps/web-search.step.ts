import type { StepExecutionContext, WebPageData, FacadeOptions } from '@ever-works/plugin';
import type { MutableGenerationContext } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { sanitizeErrorForUser } from '../utils/error.utils.js';

/**
 * Web Search Step
 *
 * Executes search queries and retrieves web page content.
 * Uses the SearchFacade for web search and ContentExtractorFacade
 * for all content extraction (unified facade).
 */
export class WebSearchStep extends BasePipelineStep {
	readonly name = 'Web Search';
	readonly stepId = 'web-search' as const;
	private readonly BATCH_SIZE = 10;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { request, work, extractedUrls, searchQueries, processedSourceUrls } = context;
		const { logger, searchFacade, contentExtractorFacade } = execContext;
		const config = request.config || {};

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			workId: execContext.work.id
		};

		logger.log(`[${work.slug}] Web Search & Content Retrieval - Starting`);

		// Process extracted URLs first if any were found
		let initialWebPages: WebPageData[] = [];
		if (extractedUrls.length > 0) {
			initialWebPages = await this.retrieveSpecificUrls(
				work.slug,
				extractedUrls,
				processedSourceUrls,
				contentExtractorFacade,
				logger,
				facadeOptions
			);
			logger.debug(`[${work.slug}] Retrieved ${initialWebPages.length} web pages from extracted URLs`);
		}

		// Resolve search provider name for user-facing warnings
		const searchProviderName =
			(await searchFacade.getActiveProviderName?.(facadeOptions)?.catch(() => null)) ?? null;
		const providerLabel = searchProviderName ? `Web search (${searchProviderName})` : 'Web search';

		// Then proceed with normal web search
		const { pages: searchWebPages, errorReasons } = await this.retrieveWebPages(
			work.slug,
			searchQueries,
			processedSourceUrls,
			config,
			searchFacade,
			contentExtractorFacade,
			logger,
			facadeOptions
		);

		// Surface unique search errors as warnings
		if (errorReasons.length > 0) {
			const uniqueErrors = [...new Set(errorReasons.map(sanitizeErrorForUser))];
			this.addWarning(context, `${providerLabel} errors: ${uniqueErrors.join('; ')}`);
		}

		// Combine web pages from both sources
		const webPages = [...initialWebPages, ...searchWebPages];

		logger.log(`[${work.slug}] Retrieved ${webPages.length} web pages for processing.`);

		context.webPages = webPages;

		// Populate contentCache for reuse in markdown generation
		for (const page of webPages) {
			if (page.source_url && page.raw_content) {
				context.contentCache.set(page.source_url, page.raw_content);
			}
		}

		if (webPages.length === 0 && searchQueries.length > 0) {
			this.addWarning(context, `${providerLabel} produced no results. Check your search provider configuration.`);
		}

		return context;
	}

	/**
	 * Retrieve web pages by executing search queries
	 */
	private async retrieveWebPages(
		slug: string,
		searchQueries: string[],
		processedSourceUrls: Set<string>,
		config: Record<string, unknown>,
		searchFacade: StepExecutionContext['searchFacade'],
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		logger: StepExecutionContext['logger'],
		facadeOptions: FacadeOptions
	): Promise<{ pages: WebPageData[]; errorReasons: string[] }> {
		const allFetchedPages: WebPageData[] = [];
		const currentRunProcessedUrls = new Set<string>();

		const maxSearchQueries = (config.max_search_queries as number) || 10;
		const maxResultsPerQuery = (config.max_results_per_query as number) || 10;
		const maxPagesToProcess = (config.max_pages_to_process as number) || 50;

		logger.log(`[${slug}] Executing ${searchQueries.length} search queries`);

		const queriesToProcess = searchQueries.slice(0, maxSearchQueries);

		// Create an array of search promises
		const searchPromises = queriesToProcess.map(async (query) => {
			try {
				const results = await searchFacade.search(
					query,
					{
						maxResults: maxResultsPerQuery
					},
					facadeOptions
				);
				logger.debug(`[${slug}] Found ${results.length} results for query: "${query}"`);
				return { query, results, success: true };
			} catch (error) {
				const errorReason = error instanceof Error ? error.message : String(error);
				logger.error(`[${slug}] Error executing search query "${query}": ${errorReason}`);
				return { query, results: [], success: false, errorReason };
			}
		});

		const searchResults = await Promise.all(searchPromises);

		// Collect error reasons from failed queries
		const errorReasons = searchResults
			.filter((r) => !r.success && r.errorReason)
			.map((r) => r.errorReason as string);

		// Process all search results and extract unique URLs to fetch
		const urlsToFetch: Array<{ url: string; query: string }> = [];

		for (const result of searchResults) {
			if (!result.success || !result.results.length) {
				continue;
			}

			// Get the top N results based on config
			const topResults = result.results.slice(0, maxResultsPerQuery);

			for (const doc of topResults) {
				const source_url = doc.url;

				// Skip invalid URLs
				if (!source_url || typeof source_url !== 'string') {
					logger.warn(
						`[${slug}] Skipping document with missing or invalid source URL for query "${result.query}"`
					);
					continue;
				}

				// Skip already processed URLs
				if (processedSourceUrls.has(source_url) || currentRunProcessedUrls.has(source_url)) {
					continue;
				}

				urlsToFetch.push({ url: source_url, query: result.query });
				currentRunProcessedUrls.add(source_url);
			}
		}

		logger.debug(`[${slug}] Found ${urlsToFetch.length} unique URLs to fetch content from`);

		// Limit the number of URLs to process based on config
		const urlsToProcess = urlsToFetch.slice(0, maxPagesToProcess);

		for (let i = 0; i < urlsToProcess.length; i += this.BATCH_SIZE) {
			const batch = urlsToProcess.slice(i, i + this.BATCH_SIZE);

			const extractionPromises = batch.map(async ({ url, query }) => {
				try {
					// Use ContentExtractorFacade for all content extraction
					const response = await contentExtractorFacade.extractContent(url, undefined, facadeOptions);

					if (!response?.rawContent) {
						logger.warn(
							`[${slug}] Skipping document with missing extraction results for query "${query}". URL: ${url}`
						);
						return null;
					}

					// Mark URL as processed
					processedSourceUrls.add(url);

					return {
						source_url: url,
						raw_content: response.rawContent,
						retrieved_at: new Date().toISOString()
					};
				} catch (error) {
					logger.error(
						`[${slug}] Error fetching content from ${url}: ${error instanceof Error ? error.message : String(error)}`
					);
					return null;
				}
			});

			const batchResults = await Promise.all(extractionPromises);

			const validResults: WebPageData[] = batchResults.filter((result): result is WebPageData => result !== null);

			allFetchedPages.push(...validResults);

			// Add a small delay between batches to be polite to the API
			if (i + this.BATCH_SIZE < urlsToProcess.length) {
				await this.delay(1000);
			}
		}

		logger.log(`[${slug}] Web page retrieval complete. Retrieved ${allFetchedPages.length} pages.`);

		return { pages: allFetchedPages, errorReasons };
	}

	/**
	 * Retrieve web pages from specific URLs.
	 *
	 * Uses ContentExtractorFacade for all content extraction (unified facade).
	 * The facade internally handles routing to the appropriate plugin.
	 */
	private async retrieveSpecificUrls(
		slug: string,
		urls: string[],
		processedSourceUrls: Set<string>,
		contentExtractorFacade: StepExecutionContext['contentExtractorFacade'],
		logger: StepExecutionContext['logger'],
		facadeOptions: FacadeOptions
	): Promise<WebPageData[]> {
		const dedupedUrls = [...new Set(urls)];
		const allFetchedPages: WebPageData[] = [];

		// Filter out already processed URLs
		const urlsToProcess = dedupedUrls.filter((url) => !processedSourceUrls.has(url));

		if (urlsToProcess.length === 0) {
			logger.debug(`[${slug}] All URLs have already been processed. Skipping.`);
			return [];
		}

		logger.log(`[${slug}] Processing ${urlsToProcess.length} URLs`);

		// Process all URLs using ContentExtractorFacade (unified content extraction)
		for (let i = 0; i < urlsToProcess.length; i += this.BATCH_SIZE) {
			const batch = urlsToProcess.slice(i, i + this.BATCH_SIZE);

			const extractionPromises = batch.map(async (url) => {
				try {
					const content = await contentExtractorFacade.extractContent(url, undefined, facadeOptions);

					if (!content?.rawContent) {
						logger.warn(`[${slug}] Skipping URL with missing extraction results: ${url}`);
						return null;
					}

					// Mark URL as processed
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
			allFetchedPages.push(...validResults);

			// Add a small delay between batches to be polite to APIs
			if (i + this.BATCH_SIZE < urlsToProcess.length) {
				await this.delay(500);
			}
		}

		logger.log(`[${slug}] Specific URL retrieval complete. Retrieved ${allFetchedPages.length} pages.`);

		return allFetchedPages;
	}

	/**
	 * Helper to create a delay
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
