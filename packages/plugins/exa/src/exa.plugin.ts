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

import { Exa } from 'exa-js';

const SEARCH_TYPES = ['auto', 'neural', 'keyword'] as const;

const CATEGORIES = ['', 'company', 'research paper', 'news', 'tweet', 'personal site', 'github'] as const;

const TIME_RANGE_DAYS: Record<string, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365
};

const API_KEY_ERROR =
	'Exa API key not configured. Set it in plugin settings or via PLUGIN_EXA_API_KEY environment variable.';

export class ExaSearchPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	readonly id = 'exa';
	readonly name = 'Exa';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search', 'content-extractor'];
	readonly providerName = 'Exa';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Exa API key. Get one at https://exa.ai',
				'x-secret': true,
				'x-envVar': 'PLUGIN_EXA_API_KEY',
				'x-scope': 'user'
			},
			searchType: {
				type: 'string',
				title: 'Search Type',
				description: 'Search mode: auto (recommended), neural (semantic), or keyword (traditional)',
				enum: [...SEARCH_TYPES],
				default: 'auto'
			},
			maxResults: {
				type: 'number',
				title: 'Default Max Results',
				description: 'Default maximum number of results per search',
				default: 10,
				minimum: 1,
				maximum: 100
			},
			category: {
				type: 'string',
				title: 'Category Filter',
				description: 'Optionally restrict results to a specific category',
				enum: [...CATEGORIES],
				default: ''
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
		const searchType = (options.settings?.searchType as string) || 'auto';
		const limit = options.limit || (options.settings?.maxResults as number) || 10;
		const category = (options.settings?.category as string) || '';

		const searchOptions: Record<string, unknown> = {
			numResults: limit,
			type: searchType
		};

		if (category) {
			searchOptions.category = category;
		}
		if (options.includeDomains && options.includeDomains.length > 0) {
			searchOptions.includeDomains = [...options.includeDomains];
		}
		if (options.excludeDomains && options.excludeDomains.length > 0) {
			searchOptions.excludeDomains = [...options.excludeDomains];
		}

		if (options.timeRange && options.timeRange !== 'all') {
			const days = TIME_RANGE_DAYS[options.timeRange];
			if (days) {
				const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
				searchOptions.startPublishedDate = startDate.toISOString();
			}
		}

		try {
			const response = await client.search(options.query, searchOptions);

			const results: SearchResult[] = response.results.map((r, index) => ({
				title: r.title || '',
				url: r.url || '',
				publishedDate: r.publishedDate,
				source: r.author,
				faviconUrl: r.favicon,
				position: index + 1
			}));

			return {
				results,
				query: options.query,
				totalResults: results.length,
				hasMore: false,
				duration: Date.now() - startTime
			};
		} catch (error) {
			this.context?.logger.error(`Exa failed: ${error instanceof Error ? error.message : String(error)}`);
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

	// ============================================================================
	// IContentExtractorPlugin Interface
	// ============================================================================

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();

		try {
			const client = this.getClient(options.settings);
			const response = await client.getContents([options.url], { text: true, livecrawl: 'fallback' });

			if (!response.results || response.results.length === 0) {
				return {
					success: false,
					url: options.url,
					error: 'No content extracted',
					duration: Date.now() - startTime
				};
			}

			const result = response.results[0];
			const text = result.text || '';

			return {
				success: true,
				url: options.url,
				finalUrl: result.url !== options.url ? result.url : undefined,
				content: text,
				title: result.title || undefined,
				duration: Date.now() - startTime,
				wordCount: text ? text.split(/\s+/).length : 0
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
		const startTime = Date.now();

		try {
			const client = this.getClient(options?.settings);
			const response = await client.getContents([...urls], { text: true, livecrawl: 'fallback' });

			return response.results.map((result, index) => {
				const text = result.text || '';
				const requestedUrl = urls[index] || result.url;
				return {
					success: true,
					url: requestedUrl,
					finalUrl: result.url !== requestedUrl ? result.url : undefined,
					content: text,
					title: result.title || undefined,
					duration: Date.now() - startTime,
					wordCount: text ? text.split(/\s+/).length : 0
				};
			});
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
		return ['text'];
	}

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	private getClient(settings?: PluginSettings): Exa {
		const apiKey = settings?.apiKey as string;
		if (!apiKey) {
			throw new Error(API_KEY_ERROR);
		}
		return new Exa(apiKey);
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Exa Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Exa plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'AI-native search and content extraction using the Exa API',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			readme: [
				'## What does Exa do?',
				'',
				'Exa is an AI-native search engine that understands meaning, not just keywords. It offers neural search (semantic understanding), keyword search (traditional matching), and an auto mode that picks the best approach for each query. It can also extract clean text content from web pages.',
				'',
				'## Why use it?',
				'',
				'- **Neural search** — finds results based on meaning, not just keyword matching',
				'- **Content extraction** — pulls clean text from any web page URL',
				'- **Category filtering** — restrict to companies, research papers, news, tweets, GitHub repos, or personal sites',
				'- **Domain control** — include or exclude specific domains from results',
				'- **Time filtering** — find results from the last day, week, month, or year',
				'',
				'## How it works in Ever Works',
				'',
				'When enabled and set as the active search provider, Exa is used during directory generation to find information about each item. Its neural search mode is particularly useful for finding semantically relevant content that keyword-based engines might miss. The content extraction capability can pull text from web pages for enriching directory items.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [exa.ai](https://exa.ai)',
				'2. Copy your API key from the Exa dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Choose your preferred search type (auto recommended)',
				'5. Enable this plugin to use it for directory generation'
			].join('\n'),
			homepage: 'https://exa.ai'
		};
	}
}

export default ExaSearchPlugin;
