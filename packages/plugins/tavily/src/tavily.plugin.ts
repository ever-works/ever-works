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

/**
 * Tavily Plugin
 *
 * Provides web search and content extraction capabilities using the Tavily API.
 * Implements both ISearchPlugin and IContentExtractorPlugin interfaces.
 *
 * Settings Resolution:
 * The API key is resolved through the 4-level hierarchy:
 * 1. Directory settings (highest priority)
 * 2. User settings
 * 3. Admin settings
 * 4. Environment variable: PLUGIN_TAVILY_API_KEY (via x-envVar)
 * 5. Not configured (plugin unavailable)
 *
 */
export class TavilySearchPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'tavily';
	readonly name = 'Tavily';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search', 'content-extractor'];

	/**
	 * Provider name for facade identification
	 */
	readonly providerName = 'Tavily';

	/**
	 * Settings schema with environment variable fallback.
	 *
	 * The 'x-envVar' extension tells the PluginSettingsService to check
	 * the environment variable when no other setting is found.
	 */
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Tavily API key. Get one at https://tavily.com',
				// Security marker - encrypt and never return via API
				'x-secret': true,
				// Environment variable fallback
				'x-envVar': 'PLUGIN_TAVILY_API_KEY',
				// Scope - can be set at any level
				'x-scope': 'global'
			},
			searchDepth: {
				type: 'string',
				title: 'Search Depth',
				description: 'Search depth: basic (faster) or advanced (more thorough)',
				enum: ['basic', 'advanced'],
				default: 'basic'
			},
			includeRawContent: {
				type: 'boolean',
				title: 'Include Raw Content',
				description: 'Include the full raw content of each search result',
				default: false
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

	/**
	 * Configuration mode: hybrid allows admin-level defaults with user overrides
	 */
	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;
	private client?: TavilyClient;

	// ============================================================================
	// ISearchPlugin Interface
	// ============================================================================

	async search(options: SearchOptions): Promise<SearchResponse> {
		const client = this.getClient(options.settings);
		const startTime = Date.now();

		const searchDepth = (options.settings?.searchDepth as 'basic' | 'advanced') || 'basic';
		const includeRawContent = (options.settings?.includeRawContent as boolean) || false;
		const maxResults = options.limit || (options.settings?.maxResults as number) || 10;

		try {
			const response = await client.search(options.query, {
				searchDepth,
				maxResults,
				includeRawContent: includeRawContent ? 'markdown' : false,
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

	/**
	 * Check if Tavily is available (API key configured)
	 */
	async isAvailable(): Promise<boolean> {
		// This is a quick check - actual availability depends on settings
		// which are resolved at call time
		return true;
	}

	/**
	 * Get rate limit information (Tavily doesn't expose this directly)
	 */
	async getRateLimitInfo(): Promise<RateLimitInfo> {
		return {
			remaining: -1, // Unknown
			limit: -1,
			period: 'month'
		};
	}

	// ============================================================================
	// IContentExtractorPlugin Interface
	// ============================================================================

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
				markdown: result.rawContent, // Tavily returns clean text
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

			return response.results.map((result) => ({
				success: true,
				url: result.url,
				content: result.rawContent,
				markdown: result.rawContent,
				duration: Date.now() - startTime,
				wordCount: result.rawContent ? result.rawContent.split(/\s+/).length : 0
			}));
		} catch (error) {
			// Return error for all URLs
			return urls.map((url) => ({
				success: false,
				url,
				error: error instanceof Error ? error.message : String(error),
				duration: Date.now() - startTime
			}));
		}
	}

	/**
	 * Check if a URL can be extracted.
	 * Tavily can extract from any HTTP/HTTPS URL.
	 */
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

	// ============================================================================
	// Private Helper Methods
	// ============================================================================

	/**
	 * Get or create a Tavily client with the resolved settings.
	 *
	 * The settings parameter contains the resolved API key from the
	 * 4-level hierarchy (directory > user > admin > env > default).
	 */
	private getClient(settings?: PluginSettings): TavilyClient {
		const apiKey = settings?.apiKey as string;

		if (!apiKey) {
			throw new Error(
				'Tavily API key not configured. ' +
					'Set it in plugin settings or via PLUGIN_TAVILY_API_KEY environment variable.'
			);
		}

		// Create a new client with the resolved API key
		// We create a new client each time to support per-request credentials
		return tavily({ apiKey });
	}

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Tavily Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Tavily Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Tavily Plugin disabled');
		this.client = undefined;
	}

	async onUnload(): Promise<void> {
		this.client = undefined;
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		// API key is required
		if (!settings.apiKey) {
			errors.push({
				path: 'apiKey',
				message: 'API key is required'
			});
		}

		// Validate search depth
		if (settings.searchDepth && !['basic', 'advanced'].includes(settings.searchDepth as string)) {
			errors.push({
				path: 'searchDepth',
				message: 'Search depth must be "basic" or "advanced"'
			});
		}

		// Validate max results
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
		// Note: We can't do a real health check without settings context
		// The facade will pass settings when making actual calls
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
