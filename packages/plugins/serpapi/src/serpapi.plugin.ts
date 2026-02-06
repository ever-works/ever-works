import type {
	IPlugin,
	ISearchPlugin,
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
	RateLimitInfo
} from '@ever-works/plugin';

const SUPPORTED_ENGINES = ['google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex'] as const;

const SAFE_SEARCH_MAP: Record<string, string> = {
	off: 'off',
	moderate: 'medium',
	strict: 'active'
};

/**
 * SerpAPI Search Plugin
 *
 * Provides web search using SerpAPI with support for multiple search engines
 * (Google, Bing, Yahoo, DuckDuckGo, Baidu, Yandex).
 * Uses plain fetch() — no SDK required.
 */
export class SerpApiSearchPlugin implements IPlugin, ISearchPlugin {
	readonly id = 'serpapi';
	readonly name = 'SerpAPI';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search'];
	readonly providerName = 'SerpAPI';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your SerpAPI key. Get one at https://serpapi.com',
				'x-secret': true,
				'x-envVar': 'PLUGIN_SERPAPI_API_KEY',
				'x-scope': 'global'
			},
			engine: {
				type: 'string',
				title: 'Search Engine',
				description: 'Which search engine to use',
				enum: [...SUPPORTED_ENGINES],
				default: 'google'
			},
			maxResults: {
				type: 'number',
				title: 'Default Max Results',
				description: 'Default maximum number of results per search',
				default: 10,
				minimum: 1,
				maximum: 100
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
		const apiKey = options.settings?.apiKey as string;
		if (!apiKey) {
			throw new Error(
				'SerpAPI key not configured. ' +
					'Set it in plugin settings or via PLUGIN_SERPAPI_API_KEY environment variable.'
			);
		}

		const startTime = Date.now();
		const engine = (options.settings?.engine as string) || 'google';
		const limit = options.limit || (options.settings?.maxResults as number) || 10;
		const page = options.page || 1;

		// Build query string with site/filetype prefixes
		let query = options.query;
		if (options.site) {
			query = `site:${options.site} ${query}`;
		}
		if (options.fileType) {
			query = `filetype:${options.fileType} ${query}`;
		}

		// Build URL parameters
		const params = new URLSearchParams({
			engine,
			q: query,
			api_key: apiKey,
			num: String(limit),
			output: 'json'
		});

		// Pagination
		if (page > 1) {
			params.set('start', String((page - 1) * limit));
		}

		// Region → gl parameter
		if (options.region) {
			params.set('gl', options.region);
		}

		// Language → hl parameter
		if (options.language) {
			params.set('hl', options.language);
		}

		// Safe search mapping
		if (options.safeSearch) {
			params.set('safe', SAFE_SEARCH_MAP[options.safeSearch] || 'off');
		}

		try {
			const response = await fetch(`https://serpapi.com/search?${params.toString()}`);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`SerpAPI request failed (${response.status}): ${errorText}`);
			}

			const data = await response.json();

			const organicResults = (data.organic_results || []) as Array<Record<string, unknown>>;
			const results: SearchResult[] = organicResults.map((r: Record<string, unknown>, index: number) => ({
				title: (r.title as string) || '',
				url: (r.link as string) || '',
				snippet: r.snippet as string | undefined,
				displayUrl: r.displayed_link as string | undefined,
				faviconUrl: r.favicon as string | undefined,
				source: r.source as string | undefined,
				position: (r.position as number) || index + 1,
				publishedDate: r.date as string | undefined
			}));

			const relatedSearches = ((data.related_searches || []) as Array<Record<string, unknown>>).map(
				(r: Record<string, unknown>) => r.query as string
			);

			const pagination = data.serpapi_pagination as Record<string, unknown> | undefined;
			const hasMore = pagination?.next != null;

			return {
				results,
				query: options.query,
				totalResults: results.length,
				hasMore,
				nextPage: hasMore ? page + 1 : undefined,
				relatedSearches: relatedSearches.length > 0 ? relatedSearches : undefined,
				duration: Date.now() - startTime
			};
		} catch (error) {
			this.context?.logger.error(`SerpAPI failed: ${error instanceof Error ? error.message : String(error)}`);
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
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('SerpAPI Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('SerpAPI Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('SerpAPI Plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey) {
			errors.push({
				path: 'apiKey',
				message: 'API key is required'
			});
		}

		if (settings.engine && !SUPPORTED_ENGINES.includes(settings.engine as (typeof SUPPORTED_ENGINES)[number])) {
			errors.push({
				path: 'engine',
				message: `Engine must be one of: ${SUPPORTED_ENGINES.join(', ')}`
			});
		}

		if (settings.maxResults !== undefined) {
			const maxResults = settings.maxResults as number;
			if (maxResults < 1 || maxResults > 100) {
				errors.push({
					path: 'maxResults',
					message: 'Max results must be between 1 and 100'
				});
			}
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'SerpAPI plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Search the web using SerpAPI with support for Google, Bing, Yahoo, DuckDuckGo, Baidu, and Yandex',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>'
			},
			readme: [
				'## What does SerpAPI do?',
				'',
				'SerpAPI provides structured search results from multiple search engines including Google, Bing, Yahoo, DuckDuckGo, Baidu, and Yandex. It returns clean, parsed results ready for AI processing.',
				'',
				'## Why use it?',
				'',
				'- **Multiple engines** — choose from Google, Bing, Yahoo, DuckDuckGo, Baidu, or Yandex',
				'- **Structured data** — returns parsed results with titles, snippets, links, and metadata',
				'- **Region & language** — target specific countries and languages for localized results',
				'- **Pagination** — navigate through multiple pages of results',
				'- **Related searches** — discover related search queries',
				'',
				'## How it works in Ever Works',
				'',
				'When enabled and set as the active search provider, SerpAPI is used during directory generation to find information about each item. It can search across multiple engines to gather diverse source material.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [serpapi.com](https://serpapi.com)',
				'2. Copy your API key from the SerpAPI dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Select your preferred search engine',
				'5. Enable this plugin to use it for directory generation'
			].join('\n')
		};
	}
}

export default SerpApiSearchPlugin;
