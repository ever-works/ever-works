import type {
	IPlugin,
	IContentExtractorPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	ContentExtractionOptions,
	ContentExtractionResult
} from '@ever-works/plugin';

import { NotionService } from './notion.js';

/**
 * Notion Content Extractor Plugin
 *
 * A user-configurable plugin that extracts content from Notion pages.
 * This plugin is ADDITIVE - it only handles Notion URLs (notion.so, notion.site).
 * All other URLs fall through to the default content extractor.
 *
 * Key characteristics:
 * - NOT a system plugin - users must explicitly enable it
 * - Only handles Notion URLs (returns false from canExtract for other URLs)
 * - Supports public pages via Splitbee API (no API key required)
 * - Supports private pages via official Notion API (requires API key)
 *
 * Per-directory enable:
 * - Plugin must be installed at user level first
 * - Then enabled per-directory via GeneratorForm or directory settings
 * - Settings are resolved through the plugin system's 4-level hierarchy:
 *   Directory > User > Admin > Environment variable
 */
export class NotionExtractorPlugin implements IPlugin, IContentExtractorPlugin {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'notion-extractor';
	readonly name = 'Notion Page Extractor';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'content-extractor';
	readonly capabilities: readonly string[] = ['content-extractor'];

	/**
	 * Provider name for facade identification
	 */
	readonly providerName = 'Notion';

	/**
	 * Settings schema for the plugin.
	 *
	 * Settings can be configured at:
	 * - Admin level: Default API key for all users
	 * - User level: User's personal Notion API key
	 * - Directory level: Per-directory overrides
	 *
	 * The plugin system resolves settings with directory > user > admin > env priority.
	 */
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Notion API Key',
				description:
					'Optional - Your Notion integration API key. Required for private pages. Leave empty for public pages only.',
				'x-secret': true,
				'x-envVar': 'PLUGIN_NOTION_API_KEY',
				'x-scope': 'user'
			},
			useSplitbeeForPublicPages: {
				type: 'boolean',
				title: 'Use Splitbee for public pages',
				description:
					'Use the free Splitbee API for public pages. Recommended unless you have rate limit issues.',
				default: true
			},
			timeout: {
				type: 'number',
				title: 'Request Timeout',
				description: 'HTTP request timeout in milliseconds',
				default: 30000,
				minimum: 5000,
				maximum: 120000
			}
		}
	};

	/**
	 * NOT a system plugin - users must enable it explicitly
	 */
	readonly systemPlugin = false;

	/**
	 * NOT the default content extractor
	 */
	readonly isDefault = false;

	private context?: PluginContext;
	private notionService?: NotionService;

	// ============================================================================
	// IContentExtractorPlugin Interface
	// ============================================================================

	/**
	 * Check if this plugin can extract content from the given URL.
	 *
	 * IMPORTANT: This is the key method that makes Notion extraction ADDITIVE.
	 * It returns true ONLY for Notion URLs, allowing other URLs to fall through
	 * to the default content extractor.
	 *
	 * @param url - URL to check
	 * @returns true if URL is a Notion page URL
	 */
	async canExtract(url: string): Promise<boolean> {
		try {
			const parsed = new URL(url);
			// Only handle notion.so and notion.site domains (including subdomains)
			// Must be exactly notion.so/notion.site or a subdomain like www.notion.so
			return /^([\w-]+\.)?notion\.(so|site)$/.test(parsed.hostname);
		} catch {
			return false;
		}
	}

	/**
	 * Extract content from a Notion page URL.
	 *
	 * Uses the Splitbee API for public pages (free, no API key required).
	 * Will use official Notion API for private pages when API key is provided.
	 *
	 * @param options - Extraction options including URL and resolved settings
	 * @returns Extracted content with markdown, metadata, etc.
	 */
	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();
		const { url, settings } = options;

		if (!this.notionService) {
			return {
				success: false,
				url,
				error: 'Notion service not initialized. Plugin may not be properly loaded.',
				duration: Date.now() - startTime
			};
		}

		// Check if this is actually a Notion URL
		if (!this.notionService.isNotionUrl(url)) {
			return {
				success: false,
				url,
				error: 'Not a Notion URL. This plugin only handles notion.so and notion.site URLs.',
				duration: Date.now() - startTime
			};
		}

		try {
			// Extract page ID from URL
			const pageId = this.notionService.extractNotionPageId(url);
			if (!pageId) {
				return {
					success: false,
					url,
					error: 'Could not extract Notion page ID from URL',
					duration: Date.now() - startTime
				};
			}

			// Check if we should use official Notion API (when API key is provided)
			const apiKey = settings?.apiKey as string | undefined;
			const useSplitbee = (settings?.useSplitbeeForPublicPages as boolean) ?? true;

			let markdown: string;
			let title: string | undefined;

			if (apiKey && !useSplitbee) {
				// Use official Notion API for private pages or when user prefers it
				this.context?.logger.debug('Using official Notion API for extraction');
				try {
					markdown = await this.notionService.extractWithOfficialApi(pageId, apiKey);
				} catch (apiError: unknown) {
					// If official API fails, fall back to Splitbee for public pages
					this.context?.logger.warn(
						`Official Notion API failed: ${(apiError as Error).message}. Falling back to Splitbee.`
					);
					markdown = await this.notionService.extractTextWithNotionAPI(pageId);
				}
			} else {
				// Use Splitbee API for public pages (default)
				this.context?.logger.debug('Using Splitbee API for public page extraction');
				markdown = await this.notionService.extractTextWithNotionAPI(pageId);
			}

			// Extract title from markdown (first # heading)
			const titleMatch = markdown.match(/^#\s+(.+)$/m);
			if (titleMatch) {
				title = titleMatch[1];
			}

			const wordCount = this.countWords(markdown);

			return {
				success: true,
				url,
				title,
				content: markdown, // Plain text version
				markdown, // Markdown version
				duration: Date.now() - startTime,
				wordCount,
				readingTime: Math.ceil(wordCount / 200)
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`Failed to extract Notion content: ${errorMessage}`);

			return {
				success: false,
				url,
				error: errorMessage,
				duration: Date.now() - startTime
			};
		}
	}

	async extractBatch(
		urls: readonly string[],
		options?: Partial<ContentExtractionOptions>
	): Promise<readonly ContentExtractionResult[]> {
		// Process sequentially to avoid rate limiting
		const results: ContentExtractionResult[] = [];

		for (const url of urls) {
			const result = await this.extract({
				url,
				...options
			});
			results.push(result);

			// Small delay between requests to be nice to the API
			if (urls.indexOf(url) < urls.length - 1) {
				await this.delay(200);
			}
		}

		return results;
	}

	/**
	 * Check if the service is available.
	 * The Splitbee API is generally always available for public pages.
	 */
	async isAvailable(): Promise<boolean> {
		return true;
	}

	getSupportedFormats(): readonly ('text' | 'html' | 'markdown')[] {
		return ['text', 'markdown'];
	}

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		// Create NotionService with logger from context
		this.notionService = new NotionService(context.logger);
		context.logger.log('Notion Extractor Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.notionService = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		// API key is optional - validate format if provided
		if (settings.apiKey && typeof settings.apiKey === 'string') {
			// Notion API keys start with 'secret_' or 'ntn_'
			const apiKey = settings.apiKey as string;
			if (!apiKey.startsWith('secret_') && !apiKey.startsWith('ntn_')) {
				return {
					valid: false,
					errors: [
						{
							path: 'apiKey',
							message: 'Invalid Notion API key format. Keys should start with "secret_" or "ntn_"'
						}
					]
				};
			}
		}

		return { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		// Try a simple API call to check connectivity
		try {
			// We can't easily test without a page ID, so just check if service is initialized
			if (!this.notionService) {
				return {
					status: 'unhealthy',
					message: 'Notion service not initialized',
					checkedAt: Date.now()
				};
			}

			return {
				status: 'healthy',
				message: 'Notion extractor is ready (Splitbee API)',
				checkedAt: Date.now()
			};
		} catch (error) {
			return {
				status: 'unhealthy',
				message: error instanceof Error ? error.message : 'Health check failed',
				checkedAt: Date.now()
			};
		}
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Extract content from Notion pages to use as source material for your directory',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: false,
			systemPlugin: false,
			homepage: 'https://developers.notion.com',
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M8 10h8"/><path d="M8 14h6"/></svg>'
			},
			readme: [
				'## What does the Notion Extractor do?',
				'',
				'This plugin extracts content from Notion pages and converts it to clean markdown for use as source material during directory generation. It supports both public and private Notion pages.',
				'',
				'## Why use it?',
				'',
				'- **Leverage existing content** — use Notion pages as source material without manual copy-pasting',
				'- **Public and private pages** — extracts published pages out of the box and private pages with an API key',
				'- **Clean markdown output** — preserves headings, formatting, and document structure',
				'- **No API key required for public pages** — public pages are extracted via the Splitbee API at no cost',
				'',
				'## How it works in Ever Works',
				'',
				'When a source URL points to a Notion page (notion.so or notion.site), the content extractor facade delegates to this plugin instead of the default extractor. It retrieves the page content as structured markdown, which the AI then uses to generate directory items during the pipeline.',
				'',
				'## Getting started',
				'',
				'1. Enable the Notion Extractor plugin on this page',
				'2. For public pages, no additional configuration is required',
				'3. For private pages, create a Notion integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) and enter the API key in the settings below',
				'4. Add Notion page URLs as source material when generating your directory'
			].join('\n')
		};
	}

	// ============================================================================
	// Private Helper Methods
	// ============================================================================

	private countWords(text: string): number {
		return text.split(/\s+/).filter((word) => word.length > 0).length;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

export default NotionExtractorPlugin;
