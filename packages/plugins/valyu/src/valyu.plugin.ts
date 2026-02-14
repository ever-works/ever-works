import type {
	IPlugin,
	ISearchPlugin,
	IContentExtractorPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	SearchOptions,
	SearchResponse,
	SearchResult,
	RateLimitInfo,
	ContentExtractionOptions,
	ContentExtractionResult
} from '@ever-works/plugin';

import { Valyu, type SearchOptions as ValyuSearchOptions } from 'valyu-js';

export class ValyuSearchPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	readonly id = 'valyu';
	readonly name = 'Valyu';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search', 'content-extractor'];
	readonly providerName = 'Valyu';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Valyu API key. Get one at https://valyu.ai',
				'x-secret': true,
				'x-envVar': 'PLUGIN_VALYU_API_KEY',
				'x-scope': 'user'
			},
			responseLength: {
				type: 'string',
				title: 'Response Length',
				description:
					'Content volume per result: short (~25k chars), medium (~50k), large (~100k), or max (unlimited)',
				enum: ['short', 'medium', 'large', 'max'],
				default: 'medium'
			}
		},
		required: ['apiKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async search(options: SearchOptions): Promise<SearchResponse> {
		const client = this.getClient(options.settings);
		const startTime = Date.now();

		const maxNumResults = options.limit || 20;
		const responseLength = (options.settings?.responseLength as ValyuSearchOptions['responseLength']) || 'short';

		try {
			const searchOptions: ValyuSearchOptions = {
				searchType: 'all',
				maxNumResults,
				responseLength
			};

			if (options.includeDomains && options.includeDomains.length > 0) {
				searchOptions.includedSources = options.includeDomains as string[];
			} else if (options.excludeDomains && options.excludeDomains.length > 0) {
				searchOptions.excludeSources = options.excludeDomains as string[];
			}

			if (options.region) {
				searchOptions.countryCode = options.region.toUpperCase() as ValyuSearchOptions['countryCode'];
			}

			if (options.timeRange && options.timeRange !== 'all') {
				const now = new Date();
				const start = new Date(now);
				if (options.timeRange === 'day') start.setDate(now.getDate() - 1);
				else if (options.timeRange === 'week') start.setDate(now.getDate() - 7);
				else if (options.timeRange === 'month') start.setMonth(now.getMonth() - 1);
				else if (options.timeRange === 'year') start.setFullYear(now.getFullYear() - 1);
				searchOptions.startDate = start.toISOString().split('T')[0];
				searchOptions.endDate = now.toISOString().split('T')[0];
			}

			const response = await client.search(options.query, searchOptions);

			const results: SearchResult[] = (response.results || []).map((r, index) => ({
				title: r.title,
				url: r.url,
				snippet: typeof r.content === 'string' ? r.content : String(r.content),
				position: index + 1,
				publishedDate: r.publication_date,
				metadata: {
					relevanceScore: r.relevance_score,
					source: r.source,
					description: r.description
				}
			}));

			return {
				results,
				query: options.query,
				totalResults: results.length,
				hasMore: false,
				duration: Date.now() - startTime
			};
		} catch (error) {
			this.context?.logger.error(
				`Valyu search failed: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async getRateLimitInfo(): Promise<RateLimitInfo> {
		return {
			remaining: -1,
			limit: -1,
			period: 'month'
		};
	}

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const client = this.getClient(options.settings);
		const startTime = Date.now();

		try {
			const response = await client.contents([options.url]);

			if (!response.results || response.results.length === 0) {
				return {
					success: false,
					url: options.url,
					error: 'No content extracted',
					duration: Date.now() - startTime
				};
			}

			const result = response.results[0];
			const content = typeof result.content === 'string' ? result.content : String(result.content || '');

			return {
				success: true,
				url: options.url,
				finalUrl: result.url !== options.url ? result.url : undefined,
				title: result.title,
				content,
				markdown: content,
				duration: Date.now() - startTime,
				wordCount: content ? content.split(/\s+/).length : 0
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

		try {
			const batchSize = 10;
			const allResults: ContentExtractionResult[] = [];

			for (let i = 0; i < urls.length; i += batchSize) {
				const batch = urls.slice(i, i + batchSize);
				const response = await client.contents(batch as string[]);

				const results = (response.results || []).map((result) => {
					const content = typeof result.content === 'string' ? result.content : String(result.content || '');
					return {
						success: true,
						url: result.url,
						title: result.title,
						content,
						markdown: content,
						duration: Date.now() - startTime,
						wordCount: content ? content.split(/\s+/).length : 0
					};
				});

				allResults.push(...results);
			}

			return allResults;
		} catch (error) {
			return urls.map((url) => ({
				success: false,
				url,
				error: error instanceof Error ? error.message : String(error),
				duration: Date.now() - startTime
			}));
		}
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
		return ['text', 'markdown'];
	}

	private getClient(settings?: PluginSettings): Valyu {
		const apiKey = settings?.apiKey as string;

		if (!apiKey) {
			throw new Error(
				'Valyu API key not configured. ' +
					'Set it in plugin settings or via PLUGIN_VALYU_API_KEY environment variable.'
			);
		}

		return new Valyu(apiKey);
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Valyu Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey) {
			errors.push({ path: 'apiKey', message: 'API key is required' });
		}

		if (
			settings.responseLength &&
			!['short', 'medium', 'large', 'max'].includes(settings.responseLength as string)
		) {
			errors.push({
				path: 'responseLength',
				message: 'Response length must be "short", "medium", "large", or "max"'
			});
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Valyu plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'AI-native search and content extraction across web and proprietary data sources',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			homepage: 'https://valyu.ai',
			icon: {
				type: 'svg',
				value: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"><g fill="#1e1d1d" fill-opacity="1"><g transform="translate(-3, 88)"><path d="M 48.3125 1.734375 L 59.78125 1.734375 L 91.5625 -71.453125 L 91.5625 -77.5 L 16.328125 -77.5 L 16.328125 -71.453125 Z M 64.421875 -32.640625 L 54.15625 -7.140625 L 53.609375 -7.140625 L 43.234375 -32.640625 L 27.78125 -68.96875 L 79.984375 -68.96875 Z M 64.421875 -32.640625 "/></g></g></svg>`,
				darkValue: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"><g fill="#ebebeb" fill-opacity="1"><g transform="translate(-3, 88)"><path d="M 48.3125 1.734375 L 59.78125 1.734375 L 91.5625 -71.453125 L 91.5625 -77.5 L 16.328125 -77.5 L 16.328125 -71.453125 Z M 64.421875 -32.640625 L 54.15625 -7.140625 L 53.609375 -7.140625 L 43.234375 -32.640625 L 27.78125 -68.96875 L 79.984375 -68.96875 Z M 64.421875 -32.640625 "/></g></g></svg>`
			},
			readme: [
				'## What does Valyu do?',
				'',
				'Valyu is an AI-native search and content extraction service that searches across web and proprietary data sources. It returns results optimized for AI applications and RAG pipelines, providing the source material that Ever Works uses to generate accurate directory items.',
				'',
				'## Why use it?',
				'',
				'- **Multi-source search** — search across web, proprietary datasets (arXiv, PubMed, financial data), and news',
				'- **AI-optimized results** — returns content formatted for AI processing with relevance scoring',
				'- **Content extraction** — pulls clean text and markdown from web pages',
				'- **Domain filtering** — include or exclude specific websites from search results',
				'- **Date filtering** — restrict results to specific time periods',
				'',
				'## How it works in Ever Works',
				'',
				'During directory generation, the search facade uses Valyu to find information about each item, discover relevant source URLs, and extract content from web pages. This powers automatic descriptions, source URL resolution, and content enrichment across the generation pipeline.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [valyu.ai](https://valyu.ai)',
				'2. Copy your API key from the Valyu dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Valyu will be used during directory generation when selected as the search provider'
			].join('\n')
		};
	}
}

export default ValyuSearchPlugin;
