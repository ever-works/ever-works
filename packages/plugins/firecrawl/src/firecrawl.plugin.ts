import type {
	IPlugin,
	ISearchPlugin,
	IContentExtractorPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	PluginSettings,
	SearchOptions,
	SearchResponse,
	SearchResult,
	RateLimitInfo,
	ContentExtractionOptions,
	ContentExtractionResult
} from '@ever-works/plugin';

import FirecrawlApp from '@mendable/firecrawl-js';

const API_KEY_ERROR =
	'Firecrawl API key not configured. Set it in plugin settings or via PLUGIN_FIRECRAWL_API_KEY environment variable.';

export class FirecrawlPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	readonly id = 'firecrawl';
	readonly name = 'Firecrawl';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search', 'content-extractor'];
	readonly providerName = 'Firecrawl';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Firecrawl API key. Get one at https://firecrawl.dev',
				'x-secret': true,
				'x-envVar': 'PLUGIN_FIRECRAWL_API_KEY',
				'x-scope': 'user'
			}
		},
		required: ['apiKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	// ============================================================================
	// ISearchPlugin Interface
	// ============================================================================

	async search(options: SearchOptions): Promise<SearchResponse> {
		const client = this.getClient(options.settings);
		const startTime = Date.now();

		try {
			const response = await client.search(options.query, {
				limit: options.limit
			});

			const items = response.web || [];

			const results: SearchResult[] = items.map((item, index) => {
				const url = ('url' in item ? item.url : '') || '';
				const title = ('title' in item ? item.title : '') || '';
				const snippet =
					('description' in item ? item.description : '') || ('markdown' in item ? item.markdown : '') || '';

				let hostname: string | undefined;
				try {
					hostname = url ? new URL(url).hostname : undefined;
				} catch {
					hostname = undefined;
				}

				return {
					title,
					url,
					snippet,
					position: index + 1,
					source: hostname
				};
			});

			return {
				results,
				query: options.query,
				totalResults: results.length,
				hasMore: false,
				duration: Date.now() - startTime
			};
		} catch (error) {
			this.context?.logger.error(
				`Firecrawl search failed: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	async getRateLimitInfo(): Promise<RateLimitInfo> {
		return {
			remaining: -1,
			limit: -1,
			period: 'month'
		};
	}

	// ============================================================================
	// IContentExtractorPlugin Interface
	// ============================================================================

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();

		try {
			const client = this.getClient(options.settings);
			const doc = await client.scrape(options.url, { formats: ['markdown'] });

			const markdown = doc.markdown || '';
			const title = doc.metadata?.title || undefined;
			const finalUrl = doc.metadata?.url;
			const wordCount = markdown ? markdown.split(/\s+/).filter((w: string) => w.length > 0).length : 0;

			if (!markdown) {
				return {
					success: false,
					url: options.url,
					error: 'No content extracted from page',
					duration: Date.now() - startTime
				};
			}

			return {
				success: true,
				url: options.url,
				finalUrl: finalUrl && finalUrl !== options.url ? finalUrl : undefined,
				title,
				content: markdown,
				markdown,
				duration: Date.now() - startTime,
				wordCount,
				readingTime: Math.ceil(wordCount / 200)
			};
		} catch (error) {
			return {
				success: false,
				url: options.url,
				error: error instanceof Error ? error.message : String(error),
				duration: Date.now() - startTime
			};
		}
	}

	async extractBatch(
		urls: readonly string[],
		options?: Partial<ContentExtractionOptions>
	): Promise<readonly ContentExtractionResult[]> {
		const client = this.getClient(options?.settings);
		const startTime = Date.now();

		// Try batch API first, fall back to sequential
		try {
			const job = await client.batchScrape([...urls], { options: { formats: ['markdown'] } });

			if (job.data && job.data.length > 0) {
				return job.data.map((doc, index) => {
					const markdown = doc.markdown || '';
					const wordCount = markdown ? markdown.split(/\s+/).filter((w: string) => w.length > 0).length : 0;
					const requestedUrl = urls[index] || doc.metadata?.url || '';

					if (!markdown) {
						return {
							success: false,
							url: requestedUrl,
							error: 'No content extracted from page',
							duration: Date.now() - startTime
						};
					}

					return {
						success: true,
						url: requestedUrl,
						finalUrl: doc.metadata?.url && doc.metadata.url !== requestedUrl ? doc.metadata.url : undefined,
						title: doc.metadata?.title || undefined,
						content: markdown,
						markdown,
						duration: Date.now() - startTime,
						wordCount,
						readingTime: Math.ceil(wordCount / 200)
					};
				});
			}
		} catch {
			// Fall through to sequential extraction
		}

		// Sequential fallback using Promise.allSettled
		const results = await Promise.allSettled(
			urls.map((url) =>
				this.extract({
					url,
					...options
				})
			)
		);

		return results.map((result, index) => {
			if (result.status === 'fulfilled') {
				return result.value;
			}
			return {
				success: false,
				url: urls[index],
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				duration: Date.now() - startTime
			};
		});
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async canExtract(url: string): Promise<boolean> {
		try {
			const parsed = new URL(url);
			return parsed.protocol === 'http:' || parsed.protocol === 'https:';
		} catch {
			return false;
		}
	}

	getSupportedFormats(): readonly ('text' | 'html' | 'markdown')[] {
		return ['markdown'];
	}

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	private getClient(settings?: PluginSettings): FirecrawlApp {
		const apiKey = settings?.apiKey as string;
		if (!apiKey) {
			throw new Error(API_KEY_ERROR);
		}
		return new FirecrawlApp({ apiKey });
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Firecrawl Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Firecrawl plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Search the web and extract content from websites using the Firecrawl API',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			readme: [
				'## What does Firecrawl do?',
				'',
				'Firecrawl is a web scraping and search API that can search the web for relevant results and extract clean, well-formatted markdown content from any web page. It handles JavaScript rendering, anti-bot bypasses, and content cleaning automatically.',
				'',
				'## Why use it?',
				'',
				'- **Web search** — search the web and get structured results with content snippets',
				'- **Clean markdown output** — returns well-structured markdown from any web page',
				'- **JavaScript rendering** — handles dynamic/SPA pages that simple HTTP fetches miss',
				'- **Anti-bot handling** — bypasses common protections automatically',
				'- **Metadata extraction** — captures title, description, and other page metadata',
				'',
				'## How it works in Ever Works',
				'',
				'When enabled, Firecrawl can be used as both a search provider and content extractor during directory generation. It searches the web for relevant information and extracts high-quality content from web pages, including JavaScript-heavy sites.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [firecrawl.dev](https://firecrawl.dev)',
				'2. Copy your API key from the Firecrawl dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Enable this plugin to use it for search and content extraction'
			].join('\n'),
			homepage: 'https://firecrawl.dev',
			icon: {
				type: 'svg',
				value: `<svg fill=none height=20 viewBox="0 0 20 20"width=20 xmlns=http://www.w3.org/2000/svg><path d="M13.7605 6.61389C13.138 6.79867 12.6687 7.21667 12.3251 7.67073C12.2513 7.76819 12.0975 7.69495 12.1268 7.57552C12.7848 4.86978 11.9155 2.6209 9.20582 1.51393C9.06836 1.4576 8.92527 1.58097 8.96132 1.72519C10.1939 6.67417 5.00941 6.25673 5.66459 11.8671C5.67585 11.9634 5.56769 12.0293 5.48882 11.973C5.2432 11.7967 4.96885 11.4288 4.78069 11.1702C4.72548 11.0942 4.60605 11.1156 4.5807 11.2063C4.43085 11.7482 4.35986 12.2586 4.35986 12.7656C4.35986 14.7373 5.37333 16.473 6.90734 17.4791C6.99522 17.5366 7.10789 17.4543 7.07804 17.3535C6.99917 17.0887 6.95466 16.8093 6.95128 16.5203C6.95128 16.3429 6.96255 16.1615 6.99015 15.9925C7.05438 15.5677 7.20197 15.1632 7.44985 14.7948C8.29995 13.5188 10.0041 12.2862 9.73199 10.6125C9.71453 10.5066 9.83959 10.4368 9.91846 10.5094C11.119 11.6063 11.3567 13.0817 11.1595 14.405C11.1426 14.5199 11.2868 14.5813 11.3595 14.4912C11.5432 14.2613 11.7674 14.0596 12.0113 13.9081C12.0722 13.8703 12.1533 13.8991 12.1764 13.9667C12.3121 14.3616 12.5138 14.7323 12.7042 15.1029C12.9318 15.5485 13.0529 16.0573 13.0338 16.5958C13.0242 16.8578 12.9808 17.1113 12.9082 17.3524C12.8772 17.4543 12.9887 17.5394 13.0783 17.4808C14.6134 16.4747 15.6275 14.739 15.6275 12.7662C15.6275 12.0806 15.5075 11.4085 15.2804 10.7787C14.8044 9.45766 13.5966 8.46561 13.9019 6.74403C13.9166 6.66178 13.8405 6.59023 13.7605 6.61389Z"fill=#ff4d00 /></svg>`
			}
		};
	}
}

export default FirecrawlPlugin;
