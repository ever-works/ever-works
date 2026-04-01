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
	ContentExtractionResult,
	ConnectionValidationResult
} from '@ever-works/plugin';

const LINKUP_API_BASE = 'https://api.linkup.so/v1';

interface LinkupSource {
	name: string;
	url: string;
	snippet: string;
}

interface LinkupSearchResult {
	name: string;
	url: string;
	content: string;
}

interface LinkupSearchResponse {
	answer?: string;
	results?: LinkupSearchResult[];
	sources?: LinkupSource[];
}

interface LinkupFetchResponse {
	markdown: string;
	rawHtml?: string;
	images?: { url: string; alt: string }[];
}

export class LinkupSearchPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	readonly id = 'linkup';
	readonly name = 'Linkup';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search', 'content-extractor'];
	readonly providerName = 'Linkup';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Linkup API key. Get one at https://linkup.so',
				'x-secret': true,
				'x-envVar': 'PLUGIN_LINKUP_API_KEY',
				'x-scope': 'user'
			}
		},
		required: ['apiKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async search(options: SearchOptions): Promise<SearchResponse> {
		const apiKey = this.getApiKey(options.settings);
		const startTime = Date.now();

		try {
			const body: Record<string, unknown> = {
				q: options.query,
				depth: 'deep',
				outputType: 'searchResults'
			};

			if (options.includeDomains?.length) {
				body.includeDomains = options.includeDomains;
			}
			if (options.excludeDomains?.length) {
				body.excludeDomains = options.excludeDomains;
			}

			const response = await fetch(`${LINKUP_API_BASE}/search`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body)
			});

			if (!response.ok) {
				throw new Error(`Linkup search failed with status ${response.status}: ${await response.text()}`);
			}

			const data = (await response.json()) as LinkupSearchResponse;

			const results: SearchResult[] = (data.results || data.sources || []).map((r, index) => ({
				title: 'name' in r ? r.name : '',
				url: r.url,
				snippet: 'content' in r ? r.content : 'snippet' in r ? (r as LinkupSource).snippet : '',
				position: index + 1,
				metadata: {}
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
				`Linkup search failed: ${error instanceof Error ? error.message : String(error)}`
			);
			throw error;
		}
	}

	async isAvailable(): Promise<boolean> {
		if (!this.context) return false;
		const settings = await this.context.getSettings();
		return Boolean(settings?.apiKey);
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const apiKey = settings.apiKey as string | undefined;
		if (!apiKey) {
			return { success: false, message: 'Linkup API key is not configured.' };
		}

		try {
			const response = await fetch(`${LINKUP_API_BASE}/search`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					q: 'test',
					depth: 'standard',
					outputType: 'searchResults'
				})
			});

			if (!response.ok) {
				const text = await response.text();
				return { success: false, message: `Linkup connection failed (${response.status}): ${text}` };
			}

			return { success: true, message: 'Linkup connection verified.' };
		} catch (error) {
			return {
				success: false,
				message: `Linkup connection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	async getRateLimitInfo(): Promise<RateLimitInfo> {
		return {
			remaining: -1,
			limit: 10,
			period: 'second'
		};
	}

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const apiKey = this.getApiKey(options.settings);
		const startTime = Date.now();

		try {
			const response = await fetch(`${LINKUP_API_BASE}/fetch`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					url: options.url,
					renderJs: true,
					includeRawHtml: false,
					extractImages: false
				})
			});

			if (!response.ok) {
				return {
					success: false,
					url: options.url,
					error: `Linkup fetch failed with status ${response.status}: ${await response.text()}`,
					duration: Date.now() - startTime
				};
			}

			const data = (await response.json()) as LinkupFetchResponse;

			if (!data.markdown) {
				return {
					success: false,
					url: options.url,
					error: 'No content extracted',
					duration: Date.now() - startTime
				};
			}

			return {
				success: true,
				url: options.url,
				content: data.markdown,
				markdown: data.markdown,
				duration: Date.now() - startTime,
				wordCount: data.markdown.split(/\s+/).length
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
		const results = await Promise.all(
			urls.map((url) =>
				this.extract({
					url,
					...options
				} as ContentExtractionOptions)
			)
		);
		return results;
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

	private getApiKey(settings?: PluginSettings): string {
		const apiKey = settings?.apiKey as string;

		if (!apiKey) {
			throw new Error(
				'Linkup API key not configured. ' +
					'Set it in plugin settings or via PLUGIN_LINKUP_API_KEY environment variable.'
			);
		}

		return apiKey;
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Linkup Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Linkup plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Search the web and extract content from websites using Linkup',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			defaultForCapabilities: [],
			homepage: 'https://linkup.so',
			icon: {
				type: 'url',
				value: 'https://framerusercontent.com/images/PuShJA41szIkwbQopIjqoEoOvUc.png'
			},
			readme: [
				'## What does Linkup do?',
				'',
				'Linkup connects AI applications to the internet, providing grounding data to enrich AI output with precision and factuality. It searches the web for relevant content and extracts clean markdown from any URL.',
				'',
				'## Why use it?',
				'',
				'- **High precision search** — optimized for factual grounding of LLM responses',
				'- **Deep search mode** — iterative search for comprehensive results when needed',
				'- **Content extraction** — fetches clean markdown from any webpage via the /fetch endpoint',
				'- **Domain filtering** — include or exclude specific websites from search results',
				'',
				'## How it works in Ever Works',
				'',
				'During directory generation, the search facade uses Linkup to find information about each item, discover relevant source URLs, and extract content from web pages. This powers automatic descriptions, source URL resolution, and content enrichment across the generation pipeline.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [linkup.so](https://linkup.so)',
				'2. Copy your API key from the Linkup dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Linkup will be available for use during directory generation'
			].join('\n')
		};
	}
}

export default LinkupSearchPlugin;
