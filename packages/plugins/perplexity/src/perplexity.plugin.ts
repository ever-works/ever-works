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

import Perplexity from '@perplexity-ai/perplexity_ai';
import type { SearchCreateParams } from '@perplexity-ai/perplexity_ai/resources/search.js';

const API_KEY_ERROR =
	'Perplexity API key not configured. Set it in plugin settings or via PLUGIN_PERPLEXITY_API_KEY environment variable.';

const RECENCY_MAP: Record<string, SearchCreateParams['search_recency_filter']> = {
	day: 'day',
	week: 'week',
	month: 'month',
	year: 'year'
};

export class PerplexitySearchPlugin implements IPlugin, ISearchPlugin {
	readonly id = 'perplexity';
	readonly name = 'Perplexity';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search'];
	readonly providerName = 'Perplexity';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Perplexity API key. Get one at https://perplexity.ai/account/api',
				'x-secret': true,
				'x-envVar': 'PLUGIN_PERPLEXITY_API_KEY',
				'x-scope': 'user'
			}
		},
		required: ['apiKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async search(options: SearchOptions): Promise<SearchResponse> {
		const client = this.getClient(options.settings);
		const startTime = Date.now();

		try {
			const searchParams: SearchCreateParams = {
				query: options.query
			};

			if (options.limit) {
				searchParams.max_results = options.limit;
			}

			if (options.includeDomains && options.includeDomains.length > 0) {
				searchParams.search_domain_filter = [...options.includeDomains];
			} else if (options.excludeDomains && options.excludeDomains.length > 0) {
				searchParams.search_domain_filter = options.excludeDomains.map((d) => `-${d}`);
			}

			if (options.timeRange && options.timeRange !== 'all') {
				const recency = RECENCY_MAP[options.timeRange];
				if (recency) {
					searchParams.search_recency_filter = recency;
				}
			}

			const response = await client.search.create(searchParams);

			const results: SearchResult[] = (response.results || []).map((r, index) => ({
				title: r.title || '',
				url: r.url || '',
				snippet: r.snippet || '',
				position: index + 1,
				source: r.url ? new URL(r.url).hostname : undefined
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
				`Perplexity search failed: ${error instanceof Error ? error.message : String(error)}`
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
			period: 'minute'
		};
	}

	private getClient(settings?: PluginSettings): Perplexity {
		const apiKey = settings?.apiKey as string;
		if (!apiKey) {
			throw new Error(API_KEY_ERROR);
		}
		return new Perplexity({ apiKey });
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Perplexity Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey) {
			errors.push({ path: 'apiKey', message: 'API key is required' });
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Perplexity plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'AI-powered web search with citations using Perplexity',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			homepage: 'https://perplexity.ai',
			icon: {
				type: 'svg',
				value: `<svg height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><title>Perplexity</title><path d="M19.785 0v7.272H22.5V17.62h-2.935V24l-7.037-6.194v6.145h-1.091v-6.152L4.392 24v-6.465H1.5V7.188h2.884V0l7.053 6.494V.19h1.09v6.49L19.786 0zm-7.257 9.044v7.319l5.946 5.234V14.44l-5.946-5.397zm-1.099-.08l-5.946 5.398v7.235l5.946-5.234V8.965zm8.136 7.58h1.844V8.349H13.46l6.105 5.54v2.655zm-8.982-8.28H2.59v8.195h1.8v-2.576l6.192-5.62zM5.475 2.476v4.71h5.115l-5.115-4.71zm13.219 0l-5.115 4.71h5.115v-4.71z" fill="#22B8CD" fill-rule="nonzero"></path></svg>`
			},
			readme: [
				'## What does Perplexity do?',
				'',
				'Perplexity is an AI-powered search API that returns web search results enriched with citations and AI-generated context. It understands natural language queries and provides highly relevant results.',
				'',
				'## Why use it?',
				'',
				'- **AI-powered search** — understands intent, not just keywords',
				'- **Citations included** — every result comes with source attribution',
				'- **Domain filtering** — include or exclude specific domains',
				'- **Recency filtering** — restrict results to recent time periods (day, week, month)',
				'',
				'## How it works in Ever Works',
				'',
				'When enabled as the active search provider, Perplexity is used during directory generation to find relevant information about each item. Its AI-powered understanding produces more contextually relevant results than traditional keyword search.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [perplexity.ai](https://perplexity.ai)',
				'2. Get your API key from [perplexity.ai/account/api](https://perplexity.ai/account/api)',
				'3. Enter the key in the **API Key** field below',
				'4. Enable this plugin to use it for directory generation'
			].join('\n')
		};
	}
}

export default PerplexitySearchPlugin;
