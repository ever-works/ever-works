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

const MAX_RESULTS_LIMIT = 20;
const MAX_PAGE_OFFSET = 9;

const FRESHNESS_MAP: Record<string, string> = {
	day: 'pd',
	week: 'pw',
	month: 'pm',
	year: 'py'
};

/**
 * Brave Search Plugin
 *
 * Provides privacy-focused web search using the Brave Search API.
 * Uses plain fetch() — no SDK required.
 */
export class BraveSearchPlugin implements IPlugin, ISearchPlugin {
	readonly id = 'brave';
	readonly name = 'Brave Search';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search'];
	readonly providerName = 'Brave';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Brave Search API key. Get one at https://brave.com/search/api/',
				'x-secret': true,
				'x-envVar': 'PLUGIN_BRAVE_API_KEY',
				'x-scope': 'global'
			},
			maxResults: {
				type: 'number',
				title: 'Default Max Results',
				description: `Default maximum number of results per search (max ${MAX_RESULTS_LIMIT})`,
				default: 10,
				minimum: 1,
				maximum: MAX_RESULTS_LIMIT
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
				'Brave Search API key not configured. ' +
					'Set it in plugin settings or via PLUGIN_BRAVE_API_KEY environment variable.'
			);
		}

		const startTime = Date.now();
		const limit = Math.min(options.limit || (options.settings?.maxResults as number) || 10, MAX_RESULTS_LIMIT);
		const page = options.page || 1;

		// Build URL parameters
		const params = new URLSearchParams({
			q: options.query,
			count: String(limit)
		});

		// Pagination (0-based offset, max 9 pages)
		if (page > 1) {
			const offset = Math.min((page - 1) * limit, MAX_PAGE_OFFSET * limit);
			params.set('offset', String(offset));
		}

		// Region → country
		if (options.region) {
			params.set('country', options.region);
		}

		// Language → search_lang
		if (options.language) {
			params.set('search_lang', options.language);
		}

		// Safe search (off/moderate/strict maps directly)
		if (options.safeSearch) {
			params.set('safesearch', options.safeSearch);
		}

		// Time range: day/week/month/year → pd/pw/pm/py
		if (options.timeRange && options.timeRange !== 'all') {
			const freshness = FRESHNESS_MAP[options.timeRange];
			if (freshness) {
				params.set('freshness', freshness);
			}
		}

		try {
			const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
				headers: {
					'X-Subscription-Token': apiKey,
					Accept: 'application/json'
				}
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Brave Search request failed (${response.status}): ${errorText}`);
			}

			const data = await response.json();

			const webResults = (data.web?.results || []) as Array<Record<string, unknown>>;
			const results: SearchResult[] = webResults.map((r: Record<string, unknown>, index: number) => ({
				title: (r.title as string) || '',
				url: (r.url as string) || '',
				snippet: r.description as string | undefined,
				faviconUrl: r.favicon as string | undefined,
				position: index + 1,
				publishedDate: r.age as string | undefined,
				metadata: {
					language: r.language,
					familyFriendly: r.family_friendly
				}
			}));

			const queryData = data.query as Record<string, unknown> | undefined;
			const hasMore = (queryData?.more_results_available as boolean) || false;

			return {
				results,
				query: options.query,
				totalResults: results.length,
				hasMore,
				nextPage: hasMore ? page + 1 : undefined,
				duration: Date.now() - startTime
			};
		} catch (error) {
			this.context?.logger.error(
				`Brave Search failed: ${error instanceof Error ? error.message : String(error)}`
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

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Brave Search Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Brave Search Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Brave Search Plugin disabled');
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

		if (settings.maxResults !== undefined) {
			const maxResults = settings.maxResults as number;
			if (maxResults < 1 || maxResults > MAX_RESULTS_LIMIT) {
				errors.push({
					path: 'maxResults',
					message: `Max results must be between 1 and ${MAX_RESULTS_LIMIT}`
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
			message: 'Brave Search plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Privacy-focused web search using the Brave Search API with an independent search index',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			icon: {
				type: 'svg',
				value: '<svg viewBox="0 0 24 24" fill="none"><defs><linearGradient id="brave-grad" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#FF5500"/><stop offset="100%" stop-color="#FF2000"/></linearGradient></defs><path d="M20.14 6.78l.72-1.68-.93-.88a4.27 4.27 0 0 0-1.93-1L16.44 2l-2 2.24h-4.88L7.56 2 6 3.22a4.27 4.27 0 0 0-1.93 1l-.93.88.72 1.68L2.4 10.24A20.53 20.53 0 0 0 5.22 19l2.42 1.78a5.15 5.15 0 0 0 2.5 1.06L12 22l1.86-.16a5.15 5.15 0 0 0 2.5-1.06L18.78 19a20.53 20.53 0 0 0 2.82-8.76zM12 17.5l-2.5-1.5L12 14.5l2.5 1.5z" fill="url(#brave-grad)"/></svg>'
			},
			readme: [
				'## What does Brave Search do?',
				'',
				'Brave Search provides privacy-focused web search results from an independent search index. Unlike other search engines, Brave builds its own index and does not track users or their searches.',
				'',
				'## Why use it?',
				'',
				'- **Privacy-first** — no tracking, no profiling, independent search index',
				'- **Fresh results** — filter by time range (day, week, month, year)',
				'- **Safe search** — built-in content filtering (off, moderate, strict)',
				'- **Localization** — supports country and language filtering',
				'',
				'## How it works in Ever Works',
				'',
				'When enabled and set as the active search provider, Brave Search is used during directory generation to find information about each item. Its independent index can surface results that other engines may miss.',
				'',
				'## Getting started',
				'',
				'1. Get an API key at [brave.com/search/api](https://brave.com/search/api/)',
				'2. Enter the key in the **API Key** field below',
				'3. Enable this plugin to use it for directory generation'
			].join('\n')
		};
	}
}

export default BraveSearchPlugin;
