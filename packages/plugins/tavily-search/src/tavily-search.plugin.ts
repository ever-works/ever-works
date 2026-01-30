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
 * Tavily Search Plugin
 *
 * Provides web search and content extraction capabilities using the Tavily API.
 * Implements both ISearchPlugin and IContentExtractorPlugin interfaces.
 *
 * Settings Resolution:
 * The API key is resolved through the 4-level hierarchy:
 * 1. Directory settings (highest priority)
 * 2. User settings
 * 3. Admin settings
 * 4. Environment variable: TAVILY_API_KEY (via x-envVar)
 * 5. Not configured (plugin unavailable)
 *
 * This allows:
 * - Platform admins to set a shared API key for all users
 * - Users to bring their own API keys
 * - Per-directory API key overrides
 * - Fallback to environment variable for self-hosted deployments
 */
export class TavilySearchPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'tavily-search';
	readonly name = 'Tavily Search';
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
				// Security markers - encrypt and mask in UI
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				// Environment variable fallback
				'x-envVar': 'TAVILY_API_KEY',
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
			this.context?.logger.error(
				`Tavily search failed: ${error instanceof Error ? error.message : String(error)}`
			);
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
					'Set it in plugin settings or via TAVILY_API_KEY environment variable.'
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
		context.logger.log('Tavily Search Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Tavily Search Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Tavily Search Plugin disabled');
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
			message: 'Tavily Search plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Web search and content extraction using Tavily API',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoInstall: false
		};
	}
}

export default TavilySearchPlugin;
