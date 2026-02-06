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

const SEARCH_TYPES = ['auto', 'neural', 'keyword'] as const;

const CATEGORIES = ['', 'company', 'research paper', 'news', 'tweet', 'personal site', 'github'] as const;

const TIME_RANGE_DAYS: Record<string, number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365
};

/**
 * Exa Search Plugin
 *
 * Provides AI-native search using the Exa API with neural, keyword, and auto modes.
 * Uses plain fetch() — no SDK required.
 */
export class ExaSearchPlugin implements IPlugin, ISearchPlugin {
	readonly id = 'exa';
	readonly name = 'Exa';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search'];
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
				'x-scope': 'global'
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
		const apiKey = options.settings?.apiKey as string;
		if (!apiKey) {
			throw new Error(
				'Exa API key not configured. ' +
					'Set it in plugin settings or via PLUGIN_EXA_API_KEY environment variable.'
			);
		}

		const startTime = Date.now();
		const searchType = (options.settings?.searchType as string) || 'auto';
		const limit = options.limit || (options.settings?.maxResults as number) || 10;
		const category = (options.settings?.category as string) || '';

		// Build request body
		const body: Record<string, unknown> = {
			query: options.query,
			numResults: limit,
			type: searchType
		};

		// Category filter
		if (category) {
			body.category = category;
		}

		// Domain filters (natively supported by Exa)
		if (options.includeDomains && options.includeDomains.length > 0) {
			body.includeDomains = [...options.includeDomains];
		}
		if (options.excludeDomains && options.excludeDomains.length > 0) {
			body.excludeDomains = [...options.excludeDomains];
		}

		// Time range → startPublishedDate (ISO 8601)
		if (options.timeRange && options.timeRange !== 'all') {
			const days = TIME_RANGE_DAYS[options.timeRange];
			if (days) {
				const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
				body.startPublishedDate = startDate.toISOString();
			}
		}

		try {
			const response = await fetch('https://api.exa.ai/search', {
				method: 'POST',
				headers: {
					'x-api-key': apiKey,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body)
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Exa request failed (${response.status}): ${errorText}`);
			}

			const data = await response.json();

			const exaResults = (data.results || []) as Array<Record<string, unknown>>;
			const results: SearchResult[] = exaResults.map((r: Record<string, unknown>, index: number) => ({
				title: (r.title as string) || '',
				url: (r.url as string) || '',
				publishedDate: r.publishedDate as string | undefined,
				source: r.author as string | undefined,
				faviconUrl: r.favicon as string | undefined,
				position: index + 1
			}));

			return {
				results,
				query: options.query,
				totalResults: results.length,
				hasMore: false, // Exa has no pagination
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
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Exa Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Exa Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Exa Plugin disabled');
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

		if (settings.searchType && !SEARCH_TYPES.includes(settings.searchType as (typeof SEARCH_TYPES)[number])) {
			errors.push({
				path: 'searchType',
				message: `Search type must be one of: ${SEARCH_TYPES.join(', ')}`
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

		if (settings.category) {
			if (!CATEGORIES.includes(settings.category as (typeof CATEGORIES)[number])) {
				errors.push({
					path: 'category',
					message: `Category must be one of: ${CATEGORIES.filter(Boolean).join(', ')}`
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
			message: 'Exa plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'AI-native search using the Exa API with neural, keyword, and auto search modes',
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
				'Exa is an AI-native search engine that understands meaning, not just keywords. It offers neural search (semantic understanding), keyword search (traditional matching), and an auto mode that picks the best approach for each query.',
				'',
				'## Why use it?',
				'',
				'- **Neural search** — finds results based on meaning, not just keyword matching',
				'- **Category filtering** — restrict to companies, research papers, news, tweets, GitHub repos, or personal sites',
				'- **Domain control** — include or exclude specific domains from results',
				'- **Time filtering** — find results from the last day, week, month, or year',
				'',
				'## How it works in Ever Works',
				'',
				'When enabled and set as the active search provider, Exa is used during directory generation to find information about each item. Its neural search mode is particularly useful for finding semantically relevant content that keyword-based engines might miss.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [exa.ai](https://exa.ai)',
				'2. Copy your API key from the Exa dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Choose your preferred search type (auto recommended)',
				'5. Enable this plugin to use it for directory generation'
			].join('\n')
		};
	}
}

export default ExaSearchPlugin;
