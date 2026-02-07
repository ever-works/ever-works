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
				'x-scope': 'user'
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
			homepage: 'https://brave.com/search/api',
			icon: {
				type: 'svg',
				value: `<svg width="56" height="64" viewBox="0 0 56 64" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M53.292 15.321l1.5-3.676s-1.909-2.043-4.227-4.358c-2.317-2.315-7.225-.953-7.225-.953L37.751 0H18.12l-5.589 6.334s-4.908-1.362-7.225.953C2.988 9.602 1.08 11.645 1.08 11.645l1.5 3.676-1.91 5.447s5.614 21.236 6.272 23.83c1.295 5.106 2.181 7.08 5.862 9.668 3.68 2.587 10.36 7.08 11.45 7.762 1.091.68 2.455 1.84 3.682 1.84 1.227 0 2.59-1.16 3.68-1.84 1.091-.681 7.77-5.175 11.452-7.762 3.68-2.587 4.567-4.562 5.862-9.668.657-2.594 6.27-23.83 6.27-23.83l-1.908-5.447z" fill="url(#paint0_linear)"/><path fill-rule="evenodd" clip-rule="evenodd" d="M34.888 11.508c.818 0 6.885-1.157 6.885-1.157s7.189 8.68 7.189 10.536c0 1.534-.619 2.134-1.347 2.842-.152.148-.31.3-.467.468l-5.39 5.717a9.42 9.42 0 01-.176.18c-.538.54-1.33 1.336-.772 2.658l.115.269c.613 1.432 1.37 3.2.407 4.99-1.025 1.906-2.78 3.178-3.905 2.967-1.124-.21-3.766-1.589-4.737-2.218-.971-.63-4.05-3.166-4.05-4.137 0-.809 2.214-2.155 3.29-2.81.214-.13.383-.232.48-.298.111-.075.297-.19.526-.332.981-.61 2.754-1.71 2.799-2.197.055-.602.034-.778-.758-2.264-.168-.316-.365-.654-.568-1.004-.754-1.295-1.598-2.745-1.41-3.784.21-1.173 2.05-1.845 3.608-2.415.194-.07.385-.14.567-.209l1.623-.609c1.556-.582 3.284-1.229 3.57-1.36.394-.181.292-.355-.903-.468a54.655 54.655 0 01-.58-.06c-1.48-.157-4.209-.446-5.535-.077-.261.073-.553.152-.86.235-1.49.403-3.317.897-3.493 1.182-.03.05-.06.093-.089.133-.168.238-.277.394-.091 1.406.055.302.169.895.31 1.629.41 2.148 1.053 5.498 1.134 6.25.011.106.024.207.036.305.103.84.171 1.399-.805 1.622l-.255.058c-1.102.252-2.717.623-3.3.623-.584 0-2.2-.37-3.302-.623l-.254-.058c-.976-.223-.907-.782-.804-1.622.012-.098.024-.2.035-.305.081-.753.725-4.112 1.137-6.259.14-.73.253-1.32.308-1.62.185-1.012.076-1.168-.092-1.406a3.743 3.743 0 01-.09-.133c-.174-.285-2-.779-3.491-1.182-.307-.083-.6-.162-.86-.235-1.327-.37-4.055-.08-5.535.077-.226.024-.422.045-.58.06-1.196.113-1.297.287-.903.468.285.131 2.013.778 3.568 1.36.597.223 1.17.437 1.624.609.183.069.373.138.568.21 1.558.57 3.398 1.241 3.608 2.414.187 1.039-.657 2.489-1.41 3.784-.204.35-.4.688-.569 1.004-.791 1.486-.812 1.662-.757 2.264.044.488 1.816 1.587 2.798 2.197.229.142.415.257.526.332.098.066.266.168.48.298 1.076.654 3.29 2 3.29 2.81 0 .97-3.078 3.507-4.05 4.137-.97.63-3.612 2.008-4.737 2.218-1.124.21-2.88-1.061-3.904-2.966-.963-1.791-.207-3.559.406-4.99l.115-.27c.559-1.322-.233-2.118-.772-2.658a9.377 9.377 0 01-.175-.18l-5.39-5.717c-.158-.167-.316-.32-.468-.468-.728-.707-1.346-1.308-1.346-2.842 0-1.855 7.189-10.536 7.189-10.536s6.066 1.157 6.884 1.157c.653 0 1.913-.433 3.227-.885.333-.114.669-.23 1-.34 1.635-.545 2.726-.549 2.726-.549s1.09.004 2.726.549c.33.11.667.226 1 .34 1.313.452 2.574.885 3.226.885zm-1.041 30.706c1.282.66 2.192 1.128 2.536 1.343.445.278.174.803-.232 1.09-.405.285-5.853 4.499-6.381 4.965l-.215.191c-.509.459-1.159 1.044-1.62 1.044-.46 0-1.11-.586-1.62-1.044l-.213-.191c-.53-.466-5.977-4.68-6.382-4.966-.405-.286-.677-.81-.232-1.09.344-.214 1.255-.683 2.539-1.344l1.22-.629c1.92-.992 4.315-1.837 4.689-1.837.373 0 2.767.844 4.689 1.837.436.226.845.437 1.222.63z" fill="#fff"/><path fill-rule="evenodd" clip-rule="evenodd" d="M43.34 6.334L37.751 0H18.12l-5.589 6.334s-4.908-1.362-7.225.953c0 0 6.544-.59 8.793 3.064 0 0 6.066 1.157 6.884 1.157.818 0 2.59-.68 4.226-1.225 1.636-.545 2.727-.549 2.727-.549s1.09.004 2.726.549 3.408 1.225 4.226 1.225c.818 0 6.885-1.157 6.885-1.157 2.249-3.654 8.792-3.064 8.792-3.064-2.317-2.315-7.225-.953-7.225-.953z" fill="url(#paint1_linear)"/><defs><linearGradient id="paint0_linear" x1=".671" y1="64.319" x2="55.2" y2="64.319" gradientUnits="userSpaceOnUse"><stop stop-color="#F50"/><stop offset=".41" stop-color="#F50"/><stop offset=".582" stop-color="#FF2000"/><stop offset="1" stop-color="#FF2000"/></linearGradient><linearGradient id="paint1_linear" x1="6.278" y1="11.466" x2="50.565" y2="11.466" gradientUnits="userSpaceOnUse"><stop stop-color="#FF452A"/><stop offset="1" stop-color="#FF2000"/></linearGradient></defs></svg>`
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
