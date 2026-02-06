import type {
	IPlugin,
	IScreenshotPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	ScreenshotOptions,
	ScreenshotResult,
	ScreenshotFormat,
	ScreenshotValidationResult
} from '@ever-works/plugin';

import Urlbox, { type RenderOptions } from 'urlbox';

interface UrlboxSettings {
	readonly apiKey?: string;
	readonly apiSecret?: string;
	readonly viewportWidth?: number;
	readonly viewportHeight?: number;
	readonly format?: ScreenshotFormat;
	readonly fullPage?: boolean;
	readonly quality?: number;
	readonly retina?: boolean;
	readonly blockAds?: boolean;
	readonly hideCookieBanners?: boolean;
}

export class UrlboxPlugin implements IPlugin, IScreenshotPlugin {
	readonly id = 'urlbox';
	readonly name = 'Urlbox';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'screenshot';
	readonly capabilities: readonly string[] = ['screenshot'];
	readonly providerName = 'Urlbox';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				description: 'Your Urlbox API key. Get one at https://urlbox.com',
				'x-secret': true,
				'x-envVar': 'PLUGIN_URLBOX_API_KEY',
				'x-scope': 'global'
			},
			apiSecret: {
				type: 'string',
				title: 'API Secret',
				description: 'Your Urlbox API secret for signed render links (recommended for security)',
				'x-secret': true,
				'x-envVar': 'PLUGIN_URLBOX_API_SECRET',
				'x-scope': 'global'
			},
			viewportWidth: {
				type: 'number',
				title: 'Viewport Width',
				description: 'Default viewport width in pixels',
				default: 1280,
				minimum: 320,
				maximum: 3840,
				'x-envVar': 'PLUGIN_URLBOX_VIEWPORT_WIDTH'
			},
			viewportHeight: {
				type: 'number',
				title: 'Viewport Height',
				description: 'Default viewport height in pixels',
				default: 1024,
				minimum: 200,
				maximum: 2160,
				'x-envVar': 'PLUGIN_URLBOX_VIEWPORT_HEIGHT'
			},
			format: {
				type: 'string',
				title: 'Image Format',
				description: 'Default output image format',
				enum: ['png', 'jpg', 'jpeg', 'webp'],
				default: 'png',
				'x-envVar': 'PLUGIN_URLBOX_FORMAT'
			},
			fullPage: {
				type: 'boolean',
				title: 'Full Page',
				description: 'Capture full page by default',
				default: false
			},
			quality: {
				type: 'number',
				title: 'Image Quality',
				description: 'Image quality for lossy formats (1-100)',
				default: 80,
				minimum: 1,
				maximum: 100
			},
			retina: {
				type: 'boolean',
				title: 'Retina',
				description: 'Enable retina/HiDPI rendering (2x device scale factor)',
				default: false
			},
			blockAds: {
				type: 'boolean',
				title: 'Block Ads',
				description: 'Block ads when capturing screenshots',
				default: true
			},
			hideCookieBanners: {
				type: 'boolean',
				title: 'Hide Cookie Banners',
				description: 'Hide cookie consent banners when capturing screenshots',
				default: true
			}
		},
		required: ['apiKey']
	};

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	async capture(options: ScreenshotOptions): Promise<ScreenshotResult> {
		const settings = this.mergeSettings(options.settings);

		try {
			const client = this.createClient(settings);
			const renderOptions = this.buildOptions(options, settings);
			const renderUrl = client.generateRenderLink(renderOptions);
			const response = await fetch(renderUrl);

			if (!response.ok) {
				throw new Error(`Urlbox render failed with status ${response.status}`);
			}

			const arrayBuffer = await response.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);

			return {
				success: true,
				imageBuffer: buffer,
				imageBase64: buffer.toString('base64'),
				imageUrl: renderUrl,
				width: options.viewportWidth ?? settings.viewportWidth ?? 1280,
				height: options.viewportHeight ?? settings.viewportHeight ?? 1024,
				fileSize: buffer.length
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`Urlbox capture failed: ${errorMessage}`);

			return {
				success: false,
				error: errorMessage
			};
		}
	}

	async getScreenshotUrl(options: ScreenshotOptions): Promise<string | null> {
		const settings = this.mergeSettings(options.settings);

		try {
			const client = this.createClient(settings);
			const renderOptions = this.buildOptions(options, settings);

			return client.generateRenderLink(renderOptions);
		} catch (error) {
			this.context?.logger.error(
				`Urlbox URL generation failed: ${error instanceof Error ? error.message : String(error)}`
			);
			return null;
		}
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async validateCredentials(): Promise<ScreenshotValidationResult> {
		if (!this.context) {
			return {
				valid: false,
				message: 'Plugin not initialized'
			};
		}

		try {
			const settings = await this.context.getSettings();
			const resolvedSettings = this.mergeSettings(settings);

			if (!resolvedSettings.apiKey) {
				return {
					valid: false,
					message: 'API key is not configured'
				};
			}

			const client = this.createClient(resolvedSettings);
			const url = client.generateRenderLink({ url: 'https://example.com' });

			if (url && url.includes('api.urlbox.com')) {
				return {
					valid: true,
					message: 'Credentials are valid'
				};
			}

			return {
				valid: false,
				message: 'Invalid credentials format'
			};
		} catch (error) {
			return {
				valid: false,
				message: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	getSupportedFormats(): readonly ScreenshotFormat[] {
		return ['png', 'jpg', 'jpeg', 'webp'] as const;
	}

	getMaxDimensions(): { width: number; height: number } {
		return { width: 3840, height: 2160 };
	}

	private createClient(settings: UrlboxSettings) {
		const apiKey = settings.apiKey;
		const apiSecret = settings.apiSecret ?? '';

		if (!apiKey) {
			throw new Error(
				'Urlbox API key not configured. ' +
					'Set it in plugin settings or via PLUGIN_URLBOX_API_KEY environment variable.'
			);
		}

		return Urlbox(apiKey, apiSecret);
	}

	private buildOptions(options: ScreenshotOptions, settings: UrlboxSettings): RenderOptions {
		const format = options.format ?? settings.format ?? 'png';

		const renderOptions: RenderOptions = {
			url: options.url,
			width: options.viewportWidth ?? settings.viewportWidth ?? 1280,
			height: options.viewportHeight ?? settings.viewportHeight ?? 1024,
			format: format as RenderOptions['format'],
			full_page: options.fullPage ?? settings.fullPage ?? false,
			quality: settings.quality ?? 80,
			retina: settings.retina ?? false,
			block_ads: options.blockAds ?? settings.blockAds ?? true,
			hide_cookie_banners: options.blockCookieBanners ?? settings.hideCookieBanners ?? true
		};

		if (options.delay !== undefined) {
			renderOptions.delay = options.delay;
		}

		if (options.waitForSelector) {
			renderOptions.selector = options.waitForSelector;
		}

		if (options.userAgent) {
			renderOptions.user_agent = options.userAgent;
		}

		return renderOptions;
	}

	private mergeSettings(settings?: PluginSettings): UrlboxSettings {
		return {
			apiKey: settings?.apiKey as string | undefined,
			apiSecret: settings?.apiSecret as string | undefined,
			viewportWidth: (settings?.viewportWidth as number | undefined) ?? 1280,
			viewportHeight: (settings?.viewportHeight as number | undefined) ?? 1024,
			format: (settings?.format as ScreenshotFormat | undefined) ?? 'png',
			fullPage: (settings?.fullPage as boolean | undefined) ?? false,
			quality: (settings?.quality as number | undefined) ?? 80,
			retina: (settings?.retina as boolean | undefined) ?? false,
			blockAds: (settings?.blockAds as boolean | undefined) ?? true,
			hideCookieBanners: (settings?.hideCookieBanners as boolean | undefined) ?? true
		};
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Urlbox Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Urlbox Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Urlbox Plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (!settings.apiKey) {
			errors.push({
				path: 'apiKey',
				message: 'API key is required'
			});
		}

		if (settings.viewportWidth !== undefined) {
			const width = settings.viewportWidth as number;
			if (width < 320 || width > 3840) {
				errors.push({
					path: 'viewportWidth',
					message: 'Viewport width must be between 320 and 3840 pixels'
				});
			}
		}

		if (settings.viewportHeight !== undefined) {
			const height = settings.viewportHeight as number;
			if (height < 200 || height > 2160) {
				errors.push({
					path: 'viewportHeight',
					message: 'Viewport height must be between 200 and 2160 pixels'
				});
			}
		}

		if (settings.format !== undefined && !['png', 'jpg', 'jpeg', 'webp'].includes(settings.format as string)) {
			errors.push({
				path: 'format',
				message: 'Format must be png, jpg, jpeg, or webp'
			});
		}

		if (settings.quality !== undefined) {
			const quality = settings.quality as number;
			if (quality < 1 || quality > 100) {
				errors.push({
					path: 'quality',
					message: 'Quality must be between 1 and 100'
				});
			}
		}

		return {
			valid: errors.length === 0,
			errors: errors.length > 0 ? errors : undefined
		};
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Urlbox plugin is ready (API key required for operations)',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Automatically capture website screenshots for your directory items',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: false,
			systemPlugin: false,
			readme: [
				'## What does Urlbox do?',
				'',
				'Urlbox is a screenshot capture API. When directory items include source URLs, this plugin automatically generates preview images by capturing a screenshot of each page.',
				'',
				'## Why use it?',
				'',
				'- **Automated capture** — preview images are generated for each directory item without manual effort',
				'- **Consistent output** — every screenshot uses the same viewport size, format, and rendering settings',
				'- **Ad and cookie banner blocking** — captures clean screenshots free of ads and cookie banners',
				'- **Retina rendering** — supports HiDPI output for crisp images on high-resolution displays',
				'- **Multiple formats** — supports PNG, JPG, and WebP output with configurable quality',
				'',
				'## How it works in Ever Works',
				'',
				'During directory generation, the screenshot facade sends capture requests to Urlbox for items that have a source URL. The resulting images are used as item preview thumbnails. You can configure viewport dimensions, image format, quality, retina rendering, and ad/cookie blocking behavior.',
				'',
				'## Getting started',
				'',
				'1. Sign up at [urlbox.com](https://urlbox.com)',
				'2. Copy your API key and API secret',
				'3. Enable the Urlbox plugin on this page',
				'4. Enter your credentials in the settings below'
			].join('\n'),
			icon: {
				type: 'url',
				value: 'https://urlbox.com/apple-touch-icon.png'
			}
		};
	}
}

export default UrlboxPlugin;
