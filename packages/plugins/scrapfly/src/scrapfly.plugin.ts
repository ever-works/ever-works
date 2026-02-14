import type {
	IPlugin,
	IScreenshotPlugin,
	IContentExtractorPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	ScreenshotOptions,
	ScreenshotResult,
	ContentExtractionOptions,
	ContentExtractionResult
} from '@ever-works/plugin';

import { ScrapflyClient, ScrapeConfig } from 'scrapfly-sdk';

const API_KEY_ERROR =
	'Scrapfly API key not configured. Set it in plugin settings or via PLUGIN_SCRAPFLY_API_KEY environment variable.';

export class ScrapflyPlugin implements IPlugin, IScreenshotPlugin, IContentExtractorPlugin {
	readonly id = 'scrapfly';
	readonly name = 'Scrapfly';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'content-extractor';
	readonly capabilities: readonly string[] = ['screenshot', 'content-extractor'];
	readonly providerName = 'Scrapfly';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Scrapfly API key. Get one at https://scrapfly.io',
				'x-secret': true,
				'x-envVar': 'PLUGIN_SCRAPFLY_API_KEY',
				'x-scope': 'user'
			}
		},
		required: ['apiKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async capture(options: ScreenshotOptions): Promise<ScreenshotResult> {
		const apiKey = this.getApiKey(options.settings);

		try {
			const client = new ScrapflyClient({ key: apiKey });

			const width = options.viewportWidth ?? 1280;
			const height = options.viewportHeight ?? 800;

			const config = new ScrapeConfig({
				url: options.url,
				render_js: true,
				rendering_wait: options.delay ? options.delay : undefined,
				wait_for_selector: options.waitForSelector || undefined,
				screenshots: { main: 'fullpage' },
				country: 'us'
			});

			const response = await client.scrape(config);
			const screenshotData = response.result.screenshots;

			if (screenshotData?.main) {
				const screenshotUrl = screenshotData.main.url;
				const fileSize = screenshotData.main.size || undefined;

				return {
					success: true,
					imageUrl: screenshotUrl,
					width,
					height,
					fileSize
				};
			}

			return {
				success: false,
				error: 'No screenshot data returned from Scrapfly'
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`Scrapfly screenshot failed: ${errorMessage}`);

			return {
				success: false,
				error: errorMessage
			};
		}
	}

	async getScreenshotUrl(options: ScreenshotOptions): Promise<string | null> {
		const result = await this.capture(options);
		return result.imageUrl || null;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	getMaxDimensions(): { width: number; height: number } {
		return { width: 3840, height: 2160 };
	}

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const apiKey = this.getApiKey(options.settings);
		const startTime = Date.now();

		try {
			const client = new ScrapflyClient({ key: apiKey });

			const config = new ScrapeConfig({
				url: options.url,
				render_js: options.waitForJs !== false,
				asp: true,
				format: 'markdown',
				country: 'us'
			});

			const response = await client.scrape(config);
			const content = response.result.content || '';

			if (!content) {
				return {
					success: false,
					url: options.url,
					error: 'No content returned from Scrapfly',
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

	private getApiKey(settings?: PluginSettings): string {
		const apiKey = settings?.apiKey as string;
		if (!apiKey) {
			throw new Error(API_KEY_ERROR);
		}
		return apiKey;
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Scrapfly Plugin loaded');
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
			message: 'Scrapfly plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Screenshot capture and content extraction using the Scrapfly API',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: false,
			autoEnable: false,
			homepage: 'https://scrapfly.io',
			icon: {
				type: 'url',
				value: 'https://cdn.scrapfly.io/0.1.156/www/public/favicon.ico?version=0.1.156'
			},
			readme: [
				'## What does Scrapfly do?',
				'',
				'Scrapfly is a web scraping and screenshot API that handles JavaScript rendering, anti-bot bypass, and proxy rotation. It can capture screenshots of any web page and extract content from even heavily protected sites.',
				'',
				'## Why use it?',
				'',
				'- **Anti-bot bypass** — handles CAPTCHAs, JavaScript challenges, and bot detection',
				'- **Screenshot capture** — full-page screenshots with JavaScript rendering',
				'- **Content extraction** — pulls raw HTML from any page, including SPAs',
				'- **Global proxy network** — access region-locked content from any country',
				'',
				'## How it works in Ever Works',
				'',
				'Scrapfly serves dual purposes during directory generation: capturing screenshots for item preview images and extracting content from web pages. Its anti-bot capabilities make it effective for scraping sites that block standard HTTP requests.',
				'',
				'## Getting started',
				'',
				'1. Sign up at [scrapfly.io](https://scrapfly.io)',
				'2. Copy your API key from the dashboard',
				'3. Enter the key in the **API Key** field below',
				'4. Enable this plugin for screenshot capture and/or content extraction'
			].join('\n')
		};
	}
}

export default ScrapflyPlugin;
