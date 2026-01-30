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
	ContentExtractionResult,
	ExtractedImage,
	ExtractedLink,
	PageMetadata
} from '@ever-works/plugin';

import axios, { type AxiosError } from 'axios';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

/**
 * Local Content Extractor Plugin
 *
 * System plugin for extracting web page content using local processing.
 * Uses axios for HTTP requests, linkedom for DOM parsing, and Mozilla's
 * Readability algorithm for content extraction.
 *
 * This plugin is a SYSTEM PLUGIN - it's always installed and enabled by default.
 * It provides fallback content extraction without requiring external API keys.
 *
 * Key characteristics:
 * - No external API dependencies (works offline after page fetch)
 * - Uses Mozilla Readability for high-quality content extraction
 * - Converts HTML to Markdown using TurndownService
 * - Handles non-HTML responses gracefully
 * - Extracts images, links, and metadata
 */
export class LocalContentExtractorPlugin implements IPlugin, IContentExtractorPlugin {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'local-content-extractor';
	readonly name = 'Local Content Extractor';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'content-extractor';
	readonly capabilities: readonly string[] = ['content-extractor'];

	/**
	 * Provider name for facade identification
	 */
	readonly providerName = 'Local (Readability)';

	/**
	 * This plugin has no required settings - it works out of the box
	 */
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			timeout: {
				type: 'number',
				title: 'Request Timeout',
				description: 'HTTP request timeout in milliseconds',
				default: 15000,
				minimum: 1000,
				maximum: 60000
			},
			minContentLength: {
				type: 'number',
				title: 'Minimum Content Length',
				description: 'Minimum character length for Readability to consider content valid',
				default: 200,
				minimum: 0,
				maximum: 10000
			},
			userAgent: {
				type: 'string',
				title: 'User Agent',
				description: 'Custom user agent string for HTTP requests',
				default:
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			}
		}
	};

	/**
	 * Marks this as a system plugin that cannot be disabled
	 */
	readonly systemPlugin = true;

	private context?: PluginContext;
	private turndownService: TurndownService;

	constructor() {
		this.turndownService = new TurndownService({
			headingStyle: 'atx',
			codeBlockStyle: 'fenced'
		});

		// Configure turndown to handle code blocks better
		this.turndownService.addRule('codeBlock', {
			filter: ['pre'],
			replacement: (content, node) => {
				const code = (node as HTMLPreElement).querySelector('code');
				const language = code?.className?.match(/language-(\w+)/)?.[1] || '';
				return `\n\`\`\`${language}\n${content.trim()}\n\`\`\`\n`;
			}
		});
	}

	// ============================================================================
	// IContentExtractorPlugin Interface
	// ============================================================================

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();
		const { url, settings } = options;

		const timeout = (settings?.timeout as number) || 15000;
		const minContentLength = (settings?.minContentLength as number) || 200;
		const userAgent =
			(settings?.userAgent as string) ||
			options.userAgent ||
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

		try {
			// Fetch the page
			const response = await axios.get(url, {
				headers: {
					Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Accept-Encoding': 'gzip, deflate',
					'Accept-Language': 'en-US,en;q=0.9',
					'User-Agent': userAgent
				},
				timeout,
				maxRedirects: 5,
				validateStatus: (status) => status >= 200 && status < 400
			});

			// Check content type
			const contentType = response.headers['content-type'] || '';
			if (
				!contentType.includes('text/html') &&
				!contentType.includes('text/plain') &&
				!contentType.includes('application/xhtml')
			) {
				return {
					success: false,
					url,
					error: `Unsupported content type: ${contentType}`,
					duration: Date.now() - startTime
				};
			}

			const html = response.data as string;
			const finalUrl = response.request?.res?.responseUrl || url;

			// Parse HTML using linkedom
			const { document } = parseHTML(html);

			// Extract metadata before Readability modifies the DOM
			const metadata = this.extractMetadata(document, url);

			// Try Mozilla Readability first (best quality)
			const article = new Readability(document as unknown as Document).parse();

			if (article?.textContent && article.textContent.length >= minContentLength) {
				// Extract images and links from the article content
				const { document: articleDocument } = parseHTML(article.content || '');
				const images = options.includeImages !== false ? this.extractImages(articleDocument, finalUrl) : [];
				const links = options.includeLinks !== false ? this.extractLinks(articleDocument, finalUrl) : [];

				const markdown = this.turndownService.turndown(article.content || '');
				const wordCount = this.countWords(article.textContent);

				return {
					success: true,
					url,
					finalUrl: finalUrl !== url ? finalUrl : undefined,
					title: article.title || metadata.title,
					content: article.textContent,
					html: article.content ?? undefined,
					markdown,
					images,
					links,
					metadata: {
						...metadata,
						author: article.byline || metadata.author
					},
					duration: Date.now() - startTime,
					wordCount,
					readingTime: Math.ceil(wordCount / 200)
				};
			}

			// Fallback 1: Try meta description
			const metaDescription =
				document.querySelector('meta[name="description"]')?.getAttribute('content') ||
				document.querySelector('meta[property="og:description"]')?.getAttribute('content');

			if (metaDescription && metaDescription.length > 50) {
				return {
					success: true,
					url,
					finalUrl: finalUrl !== url ? finalUrl : undefined,
					title: metadata.title,
					content: metaDescription,
					markdown: metaDescription,
					metadata,
					duration: Date.now() - startTime,
					wordCount: this.countWords(metaDescription),
					readingTime: 1
				};
			}

			// Fallback 2: Clean body content
			this.removeUnwantedElements(document);
			const bodyText = document.body?.textContent?.replace(/\s\s+/g, ' ').trim() || '';
			const bodyHtml = document.body?.innerHTML?.replace(/\s\s+/g, ' ').trim() || '';

			if (bodyText.length >= minContentLength) {
				const images = options.includeImages !== false ? this.extractImages(document, finalUrl) : [];
				const links = options.includeLinks !== false ? this.extractLinks(document, finalUrl) : [];

				return {
					success: true,
					url,
					finalUrl: finalUrl !== url ? finalUrl : undefined,
					title: metadata.title,
					content: bodyText,
					html: bodyHtml,
					markdown: this.turndownService.turndown(bodyHtml),
					images,
					links,
					metadata,
					duration: Date.now() - startTime,
					wordCount: this.countWords(bodyText),
					readingTime: Math.ceil(this.countWords(bodyText) / 200)
				};
			}

			// No usable content found
			return {
				success: false,
				url,
				finalUrl: finalUrl !== url ? finalUrl : undefined,
				error: 'No extractable content found',
				metadata,
				duration: Date.now() - startTime
			};
		} catch (error) {
			const axiosError = error as AxiosError;
			const errorMessage = axiosError.response?.status
				? `HTTP ${axiosError.response.status}: ${axiosError.message}`
				: axiosError.message || String(error);

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
		// Process in batches to avoid overwhelming the system
		const batchSize = 5;
		const results: ContentExtractionResult[] = [];

		for (let i = 0; i < urls.length; i += batchSize) {
			const batch = urls.slice(i, i + batchSize);
			const batchResults = await Promise.all(
				batch.map((url) =>
					this.extract({
						url,
						...options
					})
				)
			);
			results.push(...batchResults);

			// Small delay between batches
			if (i + batchSize < urls.length) {
				await this.delay(100);
			}
		}

		return results;
	}

	/**
	 * Check if the service is available.
	 * Local extraction is always available.
	 */
	async isAvailable(): Promise<boolean> {
		return true;
	}

	/**
	 * Check if a URL can be extracted.
	 * Local extractor can handle any HTTP/HTTPS URL.
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
		return ['text', 'html', 'markdown'];
	}

	// ============================================================================
	// Private Helper Methods
	// ============================================================================

	private extractMetadata(document: Document, baseUrl: string): PageMetadata {
		const getMeta = (names: string[]): string | undefined => {
			for (const name of names) {
				const content =
					document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ||
					document.querySelector(`meta[property="${name}"]`)?.getAttribute('content');
				if (content) return content;
			}
			return undefined;
		};

		const favicon =
			document.querySelector('link[rel="icon"]')?.getAttribute('href') ||
			document.querySelector('link[rel="shortcut icon"]')?.getAttribute('href');

		return {
			title: document.querySelector('title')?.textContent || undefined,
			description: getMeta(['description', 'og:description']),
			author: getMeta(['author', 'article:author']),
			publishedDate: getMeta(['article:published_time', 'date', 'pubdate']),
			modifiedDate: getMeta(['article:modified_time', 'last-modified']),
			language: document.documentElement?.getAttribute('lang') || undefined,
			keywords: getMeta(['keywords'])
				?.split(',')
				.map((k) => k.trim()),
			ogTitle: getMeta(['og:title']),
			ogDescription: getMeta(['og:description']),
			ogImage: getMeta(['og:image']),
			ogType: getMeta(['og:type']),
			twitterCard: getMeta(['twitter:card']),
			twitterTitle: getMeta(['twitter:title']),
			twitterDescription: getMeta(['twitter:description']),
			twitterImage: getMeta(['twitter:image']),
			canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || undefined,
			favicon: favicon ? this.resolveUrl(favicon, baseUrl) : undefined
		};
	}

	private extractImages(document: Document, baseUrl: string): ExtractedImage[] {
		const images: ExtractedImage[] = [];
		const imgElements = document.querySelectorAll('img');

		for (const img of Array.from(imgElements)) {
			const src = img.getAttribute('src') || img.getAttribute('data-src');
			if (!src) continue;

			// Skip data URIs for small images (likely icons)
			if (src.startsWith('data:') && src.length < 500) continue;

			const resolvedSrc = src.startsWith('data:') ? src : this.resolveUrl(src, baseUrl);

			images.push({
				src: resolvedSrc,
				alt: img.getAttribute('alt') || undefined,
				title: img.getAttribute('title') || undefined,
				width: img.getAttribute('width') ? parseInt(img.getAttribute('width')!, 10) : undefined,
				height: img.getAttribute('height') ? parseInt(img.getAttribute('height')!, 10) : undefined
			});
		}

		return images;
	}

	private extractLinks(document: Document, baseUrl: string): ExtractedLink[] {
		const links: ExtractedLink[] = [];
		const anchorElements = document.querySelectorAll('a[href]');
		const baseHost = new URL(baseUrl).host;

		for (const anchor of Array.from(anchorElements)) {
			const href = anchor.getAttribute('href');
			if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

			const resolvedHref = this.resolveUrl(href, baseUrl);
			let isExternal = false;

			try {
				const linkHost = new URL(resolvedHref).host;
				isExternal = linkHost !== baseHost;
			} catch {
				// Invalid URL, assume internal
			}

			links.push({
				href: resolvedHref,
				text: anchor.textContent?.trim() || undefined,
				title: anchor.getAttribute('title') || undefined,
				rel: anchor.getAttribute('rel') || undefined,
				isExternal
			});
		}

		return links;
	}

	private removeUnwantedElements(document: Document): void {
		const selectorsToRemove = [
			'script',
			'style',
			'noscript',
			'iframe',
			'header',
			'footer',
			'nav',
			'aside',
			'.sidebar',
			'.advertisement',
			'.ad',
			'.ads',
			'.comments',
			'.social-share',
			'[role="navigation"]',
			'[role="banner"]',
			'[role="complementary"]'
		];

		for (const selector of selectorsToRemove) {
			const elements = document.querySelectorAll(selector);
			for (const el of Array.from(elements)) {
				el.remove();
			}
		}
	}

	private resolveUrl(url: string, baseUrl: string): string {
		try {
			return new URL(url, baseUrl).href;
		} catch {
			return url;
		}
	}

	private countWords(text: string): number {
		return text.split(/\s+/).filter((word) => word.length > 0).length;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Local Content Extractor Plugin loaded');
	}

	async onEnable(_context: PluginContext): Promise<void> {
		this.context?.logger.log('Local Content Extractor Plugin enabled');
	}

	async onDisable(_context: PluginContext): Promise<void> {
		// System plugins should not be disabled, but handle gracefully
		this.context?.logger.warn('Attempted to disable system plugin - this should not happen');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(_settings: PluginSettings): Promise<ValidationResult> {
		return { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Local content extractor is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'System plugin for extracting web page content using axios + Readability',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoInstall: true,
			autoEnable: true,
			defaultForCapabilities: ['content-extractor']
		};
	}
}

export default LocalContentExtractorPlugin;
