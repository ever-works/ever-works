import type {
	IPlugin,
	ISearchPlugin,
	IContentExtractorPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	SearchOptions,
	SearchResponse,
	SearchResult,
	RateLimitInfo,
	ContentExtractionOptions,
	ContentExtractionResult,
	ConnectionValidationResult
} from '@ever-works/plugin';

const JINA_READER_URL = 'https://r.jina.ai/';
const JINA_SEARCH_URL = 'https://s.jina.ai/';

interface JinaReaderResponse {
	code: number;
	status: number;
	data: {
		title: string;
		description?: string;
		url: string;
		content: string;
		publishedTime?: string;
		images?: Record<string, string>;
		links?: Record<string, string>;
		metadata?: Record<string, string>;
		warning?: string;
		usage?: { tokens: number };
	};
}

interface JinaSearchResult {
	title: string;
	description?: string;
	url: string;
	content?: string;
	date?: string;
	usage?: { tokens: number };
}

interface JinaSearchResponse {
	code: number;
	status: number;
	data: JinaSearchResult[];
	meta?: { usage?: { tokens: number } };
}

export class JinaReaderPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
	readonly id = 'jina';
	readonly name = 'Jina AI';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'content-extractor';
	readonly capabilities: readonly string[] = ['search', 'content-extractor'];
	readonly providerName = 'Jina';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		required: ['apiKey'],
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Jina API key. Get one at https://jina.ai',
				'x-secret': true,
				'x-envVar': 'PLUGIN_JINA_API_KEY',
				'x-scope': 'user'
			}
		}
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async search(options: SearchOptions): Promise<SearchResponse> {
		const startTime = Date.now();
		const apiKey = options.settings?.apiKey as string;

		try {
			const headers: Record<string, string> = {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'X-Respond-With': 'no-content',
				Authorization: `Bearer ${apiKey}`
			};

			if (options.includeDomains && options.includeDomains.length > 0) {
				headers['X-Site'] = options.includeDomains[0] as string;
			}

			const body: Record<string, unknown> = {
				q: options.query
			};

			if (options.limit) {
				body.num = options.limit;
			}
			if (options.region) {
				body.gl = options.region;
			}
			if (options.language) {
				body.hl = options.language;
			}

			const response = await fetch(JINA_SEARCH_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(30000)
			});

			if (!response.ok) {
				throw new Error(`Jina Search API returned ${response.status}: ${response.statusText}`);
			}

			const json = (await response.json()) as JinaSearchResponse;

			const results: SearchResult[] = (json.data || []).map((r, index) => {
				let source: string | undefined;
				try {
					if (r.url) source = new URL(r.url).hostname;
				} catch {
					// malformed URL
				}
				return {
					title: r.title || '',
					url: r.url || '',
					snippet: r.description || '',
					position: index + 1,
					publishedDate: r.date || undefined,
					source
				};
			});

			return {
				results,
				query: options.query,
				totalResults: results.length,
				hasMore: false,
				duration: Date.now() - startTime
			};
		} catch (error) {
			this.context?.logger.error(`Jina search failed: ${error instanceof Error ? error.message : String(error)}`);
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
			return { success: false, message: 'Jina AI API key is not configured.' };
		}

		try {
			const response = await fetch(JINA_SEARCH_URL, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					'X-Respond-With': 'no-content',
					Authorization: `Bearer ${apiKey}`
				},
				body: JSON.stringify({ q: 'test', num: 1 }),
				signal: AbortSignal.timeout(15000)
			});

			if (!response.ok) {
				return {
					success: false,
					message: `Jina AI connection failed (${response.status}): ${response.statusText}`
				};
			}

			return { success: true, message: 'Jina AI connection verified.' };
		} catch (error) {
			return {
				success: false,
				message: `Jina AI connection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	async getRateLimitInfo(): Promise<RateLimitInfo> {
		return {
			remaining: -1,
			limit: -1,
			period: 'minute'
		};
	}

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();
		const { url, settings } = options;
		const apiKey = settings?.apiKey as string;

		try {
			const headers: Record<string, string> = {
				Accept: 'application/json',
				'X-Respond-With': 'markdown',
				Authorization: `Bearer ${apiKey}`
			};

			const response = await fetch(JINA_READER_URL, {
				method: 'POST',
				headers: {
					...headers,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ url }),
				signal: AbortSignal.timeout(options.timeout || 30000)
			});

			if (!response.ok) {
				return {
					success: false,
					url,
					error: `Jina API returned ${response.status}: ${response.statusText}`,
					duration: Date.now() - startTime
				};
			}

			const json = (await response.json()) as JinaReaderResponse;
			const data = json.data;

			if (!data || !data.content) {
				return {
					success: false,
					url,
					error: 'No content returned from Jina API',
					duration: Date.now() - startTime
				};
			}

			const wordCount = data.content.split(/\s+/).filter((w) => w.length > 0).length;

			const images = data.images ? Object.entries(data.images).map(([alt, src]) => ({ src, alt })) : undefined;

			const links = data.links
				? Object.entries(data.links).map(([text, href]) => ({
						href,
						text,
						isExternal: true
					}))
				: undefined;

			const metadata: Record<string, unknown> = {};
			if (data.description) metadata.description = data.description;
			if (data.publishedTime) metadata.publishedDate = data.publishedTime;
			if (data.metadata?.lang) metadata.language = data.metadata.lang;

			return {
				success: true,
				url,
				finalUrl: data.url !== url ? data.url : undefined,
				title: data.title,
				content: data.content,
				markdown: data.content,
				images: options.includeImages !== false ? images : undefined,
				links: options.includeLinks !== false ? links : undefined,
				metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
				duration: Date.now() - startTime,
				wordCount,
				readingTime: Math.ceil(wordCount / 200)
			};
		} catch (error) {
			return {
				success: false,
				url,
				error: error instanceof Error ? error.message : String(error),
				duration: Date.now() - startTime
			};
		}
	}

	async extractBatch(
		urls: readonly string[],
		options?: Partial<ContentExtractionOptions>
	): Promise<readonly ContentExtractionResult[]> {
		const batchSize = 5;
		const results: ContentExtractionResult[] = [];

		for (let i = 0; i < urls.length; i += batchSize) {
			const batch = urls.slice(i, i + batchSize);
			const batchResults = await Promise.all(batch.map((url) => this.extract({ url, ...options })));
			results.push(...batchResults);

			if (i + batchSize < urls.length) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}

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

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Jina AI Reader Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Jina AI Reader plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Web search and content extraction using the Jina AI APIs',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			homepage: 'https://jina.ai',
			icon: {
				type: 'url',
				value: 'https://jina.ai/icons/favicon-128x128.png'
			},
			readme: [
				'## What does Jina AI do?',
				'',
				'Jina AI provides web search with LLM-optimized results and content extraction that converts any web page into clean markdown.',
				'',
				'## Why use it?',
				'',
				'- **Web search** — search the web and get results with content already extracted',
				'- **Content extraction** — converts pages to clean markdown, strips ads and navigation',
				'- **Domain filtering** — restrict search to specific domains',
				'',
				'## How it works in Ever Works',
				'',
				'During directory generation, Jina finds relevant information about each item via search and extracts clean content from web pages for enriching descriptions.',
				'',
				'## Getting started',
				'',
				'1. Get an API key at [jina.ai](https://jina.ai)',
				'2. Enter the key in the **API Key** field below',
				'3. Enable the plugin'
			].join('\n')
		};
	}
}

export default JinaReaderPlugin;
