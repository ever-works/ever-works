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

import { tavily, TavilyClient } from '@tavily/core';

export class TavilySearchPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	readonly id = 'tavily';
	readonly name = 'Tavily';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search', 'content-extractor'];
	readonly providerName = 'Tavily';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Tavily API key. Get one at https://tavily.com',
				'x-secret': true,
				'x-envVar': 'PLUGIN_TAVILY_API_KEY',
				'x-scope': 'user'
			}
		},
		required: ['apiKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;
	private client?: TavilyClient;

	async search(options: SearchOptions): Promise<SearchResponse> {
		const client = this.getClient(options.settings);
		const startTime = Date.now();

		const maxResults = options.limit || 20;

		try {
			const response = await client.search(options.query, {
				searchDepth: 'advanced',
				maxResults,
				includeDomains: options.includeDomains as string[],
				excludeDomains: options.excludeDomains as string[]
			});

			const results: SearchResult[] = response.results.map((r, index) => ({
				title: r.title,
				url: r.url,
				snippet: r.content,
				position: index + 1,
				publishedDate: r.publishedDate,
				metadata: {
					score: r.score,
					rawContent: r.rawContent
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
			this.context?.logger.error(`Tavily failed: ${error instanceof Error ? error.message : String(error)}`);
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
			const response = await client.extract([options.url]);

			if (!response.results || response.results.length === 0) {
				return {
					success: false,
					url: options.url,
					error: 'No content extracted',
					duration: Date.now() - startTime
				};
			}

			const result = response.results[0];

			return {
				success: true,
				url: options.url,
				finalUrl: result.url !== options.url ? result.url : undefined,
				content: result.rawContent,
				markdown: result.rawContent,
				duration: Date.now() - startTime,
				wordCount: result.rawContent ? result.rawContent.split(/\s+/).length : 0
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
			const response = await client.extract(urls as string[]);

			return response.results.map((result, index) => {
				const requestedUrl = urls[index] || result.url;
				return {
					success: true,
					url: requestedUrl,
					finalUrl: result.url !== requestedUrl ? result.url : undefined,
					content: result.rawContent,
					markdown: result.rawContent,
					duration: Date.now() - startTime,
					wordCount: result.rawContent ? result.rawContent.split(/\s+/).length : 0
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
		return ['text', 'markdown'];
	}

	private getClient(settings?: PluginSettings): TavilyClient {
		const apiKey = settings?.apiKey as string;

		if (!apiKey) {
			throw new Error(
				'Tavily API key not configured. ' +
					'Set it in plugin settings or via PLUGIN_TAVILY_API_KEY environment variable.'
			);
		}

		return tavily({ apiKey });
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Tavily Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.client = undefined;
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
			message: 'Tavily plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Search the web and extract content from websites to build your directory',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			defaultForCapabilities: ['search'],
			homepage: 'https://tavily.com',
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
			},
			readme: [
				'## What does Tavily do?',
				'',
				'Tavily is a search and content extraction service designed for AI applications. It searches the web for relevant results and extracts clean, structured content from web pages, providing the source material that Ever Works uses to generate accurate directory items.',
				'',
				'## Why use it?',
				'',
				'- **AI-optimized search** — returns results formatted for AI processing, not just links',
				'- **Content extraction** — pulls clean text from web pages, removing ads and navigation elements',
				'- **Configurable depth** — choose basic search for speed or advanced search for thoroughness',
				'- **Domain filtering** — include or exclude specific websites from search results',
				'',
				'## How it works in Ever Works',
				'',
				'During directory generation, the search facade uses Tavily to find information about each item, discover relevant source URLs, and extract content from web pages. This powers automatic descriptions, source URL resolution, and content enrichment across the generation pipeline.',
				'',
				'## Getting started',
				'',
				'1. Create an account at [tavily.com](https://tavily.com)',
				'2. Copy your API key from the Tavily dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Tavily will be used automatically during directory generation'
			].join('\n')
		};
	}
}

export default TavilySearchPlugin;
