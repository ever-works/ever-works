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

import { bdclient } from '@brightdata/sdk';

const API_KEY_ERROR =
	'Bright Data API key not configured. Set it in plugin settings or via PLUGIN_BRIGHTDATA_API_KEY environment variable.';

interface SerpOrganicResult {
	title?: string;
	url?: string;
	link?: string;
	description?: string;
	snippet?: string;
}

export class BrightDataPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	readonly id = 'brightdata';
	readonly name = 'Bright Data';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'search';
	readonly capabilities: readonly string[] = ['search', 'content-extractor'];
	readonly providerName = 'Bright Data';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Bright Data API key. Get one at https://brightdata.com',
				'x-secret': true,
				'x-envVar': 'PLUGIN_BRIGHTDATA_API_KEY',
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
			let query = options.query;

			if (options.includeDomains && options.includeDomains.length > 0) {
				const siteFilter = options.includeDomains.map((d) => `site:${d}`).join(' OR ');
				query = `${query} (${siteFilter})`;
			}
			if (options.excludeDomains && options.excludeDomains.length > 0) {
				const excludeFilter = options.excludeDomains.map((d) => `-site:${d}`).join(' ');
				query = `${query} ${excludeFilter}`;
			}

			const searchOpts: { format: 'json'; country?: string; searchEngine?: string } = { format: 'json' };
			if (options.region) {
				searchOpts.country = options.region;
			}

			const response = await client.search(query, searchOpts);
			let organicResults: SerpOrganicResult[] = [];

			try {
				const parsed = JSON.parse(response.body);
				if (Array.isArray(parsed.organic)) {
					organicResults = parsed.organic;
				} else if (Array.isArray(parsed.results)) {
					organicResults = parsed.results;
				} else if (Array.isArray(parsed)) {
					organicResults = parsed;
				}
			} catch {
				// body is not JSON — cannot extract structured results
				this.context?.logger.warn('Bright Data search returned non-JSON body');
			}

			const searchResults: SearchResult[] = organicResults.slice(0, options.limit || 20).map((r, index) => {
				const rawUrl = r.url || r.link || '';
				let source: string | undefined;
				try {
					if (rawUrl) source = new URL(rawUrl).hostname;
				} catch {
					// malformed URL — skip source
				}
				return {
					title: r.title || '',
					url: rawUrl,
					snippet: r.description || r.snippet || '',
					position: index + 1,
					source
				};
			});

			return {
				results: searchResults,
				query: options.query,
				totalResults: searchResults.length,
				hasMore: false,
				duration: Date.now() - startTime
			};
		} catch (error) {
			this.context?.logger.error(
				`Bright Data search failed: ${error instanceof Error ? error.message : String(error)}`
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

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const client = this.getClient(options.settings);
		const startTime = Date.now();

		try {
			// Without format: 'json', scrape() returns SingleRawResponse (string)
			const content = await client.scrape(options.url, { dataFormat: 'markdown' });

			if (!content) {
				return {
					success: false,
					url: options.url,
					error: 'No content returned from Bright Data',
					duration: Date.now() - startTime
				};
			}

			const wordCount = content.split(/\s+/).filter((w: string) => w.length > 0).length;

			return {
				success: true,
				url: options.url,
				content,
				markdown: content,
				duration: Date.now() - startTime,
				wordCount,
				readingTime: Math.ceil(wordCount / 200)
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
			// Batch scrape returns BatchRawResponse = Array<string | BRDError>
			const responses = await client.scrape([...urls], { dataFormat: 'markdown' });

			return responses.map((r: string | Error, index: number) => {
				if (r instanceof Error) {
					return {
						success: false,
						url: urls[index] || '',
						error: r.message,
						duration: Date.now() - startTime
					};
				}

				return {
					success: true,
					url: urls[index] || '',
					content: r,
					markdown: r,
					duration: Date.now() - startTime,
					wordCount: r ? r.split(/\s+/).length : 0
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
		return ['text', 'html', 'markdown'];
	}

	private getClient(settings?: PluginSettings): bdclient {
		const apiKey = settings?.apiKey as string;
		if (!apiKey) {
			throw new Error(API_KEY_ERROR);
		}
		return new bdclient({ apiKey });
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Bright Data Plugin loaded');
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
			message: 'Bright Data plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Web search and content extraction using the Bright Data API',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			homepage: 'https://brightdata.com',
			icon: {
				type: 'base64',
				value: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFEAAABRCAMAAACdUboEAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAACrUExURT1//AAAAECA/z2A/D18/D2A/DqA+j19/Dp9+jt/+jt9+jyB/Tx+/T6A+z5++z1//Tx++zx//D1++zx//T1++z5//T1//T1//D1+/D1//P\/\///P3//L3/ufv/+fv/ubv/trn/s7f/sLX/rbP/rbP/arH/Z6//p6//Z2//ZK3/ZG3/Yav/YWv/YWv/Hqn/Xmn/Xmn/G6f/W2f/GGX/WGX/FWP/VWP/EmH/UmH/Hn2ufsAAAAadFJOU/8AEFBQYGBgYHBwf3+AgI+Qr7DP0N/f3+Dvarfr+gAAASlJREFUeNrt2ctygjAYhuEvaOuhBxVrlR9PlFIqSJFqKfd/ZZ1Q0Bm3fBvGPItMVu9kMpPNHyjNGk5e0cx00lcl6KXrgGHer4sjsDz+Fx/AM9LFHpi6CmoGJsdCD1xD2OCyMQXXHEbL7VNw5RKCayduDqo3kU0BmhTYiIindxzbKBLtcx+Aw5PKklV0peaBIpWLAgzvcnGkXqOWcYr0M4ZytgLFjyu1mPaoKz5Ydivdcz9A9BXH2S9uT3FKosDnpA5J4G+XUgKDLyVTbOjor7hFLXPZRaxN0RRN0RRN0RRbUyxOh8iVSph8F2hKruW3UFxfy83UpqUW4JqCPyMdgOselgOmuYLqcI+ooNQYPM9KF9UTWMb138fdDAxOR1VF3bRf0MzCHlhl6g+OWT4TrYIo4gAAAABJRU5ErkJggg==`
			},
			readme: [
				'## What does Bright Data do?',
				'',
				'Bright Data provides web search via its SERP API and content extraction via its Web Scraper. It handles bot detection, CAPTCHAs, and geo-restrictions through a global proxy network.',
				'',
				'## Why use it?',
				'',
				'- **SERP API** — search Google, Bing, and Yandex programmatically with structured results',
				'- **Bot detection bypass** — handles CAPTCHAs, JavaScript challenges, and anti-bot measures',
				'- **Markdown extraction** — converts any web page into clean markdown content',
				'- **Parallel scraping** — extract content from multiple URLs concurrently',
				'',
				'## How it works in Ever Works',
				'',
				'Bright Data serves dual purposes: the SERP API finds relevant information about directory items, while the Web Scraper extracts content from web pages. Its bot-detection bypass makes it effective for sites that block standard requests.',
				'',
				'## Getting started',
				'',
				'1. Sign up at [brightdata.com](https://brightdata.com)',
				'2. Copy your API key from the dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Enable this plugin to use it for search and/or content extraction'
			].join('\n')
		};
	}
}

export default BrightDataPlugin;
