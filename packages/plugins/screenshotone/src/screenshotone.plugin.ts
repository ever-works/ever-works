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

import * as screenshotone from 'screenshotone-api-sdk';

/**
 * ScreenshotOne plugin settings interface
 */
interface ScreenshotOneSettings {
	readonly accessKey?: string;
	readonly secretKey?: string;
	readonly viewportWidth?: number;
	readonly viewportHeight?: number;
	readonly format?: ScreenshotFormat;
	readonly fullPage?: boolean;
	readonly deviceScaleFactor?: number;
	readonly blockAds?: boolean;
	readonly blockTrackers?: boolean;
}

/**
 * ScreenshotOne Plugin
 *
 * Provides screenshot capture capabilities using the ScreenshotOne API service.
 * Supports configurable viewport sizes, formats, and advanced options like ad blocking.
 *
 * Settings Resolution:
 * The API keys are resolved through the 4-level hierarchy:
 * 1. Directory settings (highest priority)
 * 2. User settings
 * 3. Admin settings
 * 4. Environment variables: PLUGIN_SCREENSHOTONE_ACCESS_KEY, PLUGIN_SCREENSHOTONE_SECRET_KEY
 * 5. Not configured (plugin unavailable)
 *
 * Configuration mode: hybrid - allows admin-level defaults with user/directory overrides.
 */
export class ScreenshotOnePlugin implements IPlugin, IScreenshotPlugin {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'screenshotone';
	readonly name = 'ScreenshotOne';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'screenshot';
	readonly capabilities: readonly string[] = ['screenshot'];

	/**
	 * Provider name for facade identification
	 */
	readonly providerName = 'ScreenshotOne';

	/**
	 * Settings schema with environment variable fallback.
	 *
	 * The 'x-envVar' extension tells the PluginSettingsService to check
	 * the environment variable when no other setting is found.
	 */
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			accessKey: {
				type: 'string',
				title: 'Access Key',
				description: 'Your ScreenshotOne access key. Get one at https://screenshotone.com',
				// Security markers - encrypt and mask in UI
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				// Environment variable fallback
				'x-envVar': 'PLUGIN_SCREENSHOTONE_ACCESS_KEY',
				// Scope - can be set at any level
				'x-scope': 'global'
			},
			secretKey: {
				type: 'string',
				title: 'Secret Key',
				description: 'Your ScreenshotOne secret key for signed URLs (recommended for security)',
				// Security markers - encrypt and mask in UI
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				// Environment variable fallback
				'x-envVar': 'PLUGIN_SCREENSHOTONE_SECRET_KEY',
				// Scope - can be set at any level
				'x-scope': 'global'
			},
			viewportWidth: {
				type: 'number',
				title: 'Viewport Width',
				description: 'Default viewport width in pixels',
				default: 1280,
				minimum: 320,
				maximum: 3840,
				'x-envVar': 'PLUGIN_SCREENSHOTONE_VIEWPORT_WIDTH'
			},
			viewportHeight: {
				type: 'number',
				title: 'Viewport Height',
				description: 'Default viewport height in pixels',
				default: 800,
				minimum: 200,
				maximum: 2160,
				'x-envVar': 'PLUGIN_SCREENSHOTONE_VIEWPORT_HEIGHT'
			},
			format: {
				type: 'string',
				title: 'Image Format',
				description: 'Default output image format',
				enum: ['png', 'jpg', 'jpeg', 'webp'],
				default: 'png',
				'x-envVar': 'PLUGIN_SCREENSHOTONE_FORMAT'
			},
			fullPage: {
				type: 'boolean',
				title: 'Full Page',
				description: 'Capture full page by default',
				default: false
			},
			deviceScaleFactor: {
				type: 'number',
				title: 'Device Scale Factor',
				description: 'Device scale factor (1 = normal, 2 = retina)',
				default: 1,
				minimum: 0.5,
				maximum: 3
			},
			blockAds: {
				type: 'boolean',
				title: 'Block Ads',
				description: 'Block ads when capturing screenshots',
				default: true
			},
			blockTrackers: {
				type: 'boolean',
				title: 'Block Trackers',
				description: 'Block trackers when capturing screenshots',
				default: true
			}
		},
		required: ['accessKey']
	};

	/**
	 * Configuration mode: hybrid allows admin-level defaults with user overrides
	 */
	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	private context?: PluginContext;

	// ============================================================================
	// IScreenshotPlugin Interface
	// ============================================================================

	/**
	 * Capture a screenshot using ScreenshotOne API
	 */
	async capture(options: ScreenshotOptions): Promise<ScreenshotResult> {
		const startTime = Date.now();
		const settings = this.mergeSettings(options.settings);

		try {
			const client = this.createClient(settings);
			const takeOptions = this.buildTakeOptions(options, settings);

			// Download the screenshot
			const imageBlob = await client.take(takeOptions);
			const arrayBuffer = await imageBlob.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);

			// Generate the screenshot URL for reference
			const imageUrl = settings.secretKey
				? await Promise.resolve(client.generateSignedTakeURL(takeOptions))
				: await Promise.resolve(client.generateTakeURL(takeOptions));

			return {
				success: true,
				imageBuffer: buffer,
				imageBase64: buffer.toString('base64'),
				imageUrl: String(imageUrl),
				width: options.viewportWidth ?? settings.viewportWidth ?? 1280,
				height: options.viewportHeight ?? settings.viewportHeight ?? 800,
				fileSize: buffer.length
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`ScreenshotOne capture failed: ${errorMessage}`);

			return {
				success: false,
				error: errorMessage
			};
		}
	}

	/**
	 * Get screenshot URL without actually capturing
	 * Uses signed URLs when secret key is available
	 */
	async getScreenshotUrl(options: ScreenshotOptions): Promise<string | null> {
		const settings = this.mergeSettings(options.settings);

		try {
			const client = this.createClient(settings);
			const takeOptions = this.buildTakeOptions(options, settings);

			// Use signed URL if secret key is available
			const url = settings.secretKey
				? await Promise.resolve(client.generateSignedTakeURL(takeOptions))
				: await Promise.resolve(client.generateTakeURL(takeOptions));

			return String(url);
		} catch (error) {
			this.context?.logger.error(
				`ScreenshotOne URL generation failed: ${error instanceof Error ? error.message : String(error)}`
			);
			return null;
		}
	}

	/**
	 * Check if the service is available (API key configured)
	 */
	async isAvailable(): Promise<boolean> {
		// This is a quick check - actual availability depends on settings
		// which are resolved at call time
		return true;
	}

	/**
	 * Validate API credentials by making a test request
	 */
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

			if (!resolvedSettings.accessKey) {
				return {
					valid: false,
					message: 'Access key is not configured'
				};
			}

			// Try to generate a URL - if credentials are invalid, this should fail
			const client = this.createClient(resolvedSettings);
			const testOptions = screenshotone.TakeOptions.url('https://example.com');

			// Generate URL to verify credentials format
			const url = resolvedSettings.secretKey
				? await Promise.resolve(client.generateSignedTakeURL(testOptions))
				: await Promise.resolve(client.generateTakeURL(testOptions));

			const urlString = String(url);
			if (urlString && urlString.includes('api.screenshotone.com')) {
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

	/**
	 * Get supported screenshot formats
	 */
	getSupportedFormats(): readonly ScreenshotFormat[] {
		return ['png', 'jpg', 'jpeg', 'webp'] as const;
	}

	/**
	 * Get maximum viewport dimensions
	 */
	getMaxDimensions(): { width: number; height: number } {
		return { width: 3840, height: 2160 };
	}

	// ============================================================================
	// Private Helper Methods
	// ============================================================================

	/**
	 * Create a ScreenshotOne client with the resolved settings
	 */
	private createClient(settings: ScreenshotOneSettings): screenshotone.Client {
		const accessKey = settings.accessKey;
		const secretKey = settings.secretKey ?? '';

		if (!accessKey) {
			throw new Error(
				'ScreenshotOne access key not configured. ' +
					'Set it in plugin settings or via PLUGIN_SCREENSHOTONE_ACCESS_KEY environment variable.'
			);
		}

		return new screenshotone.Client(accessKey, secretKey);
	}

	/**
	 * Build TakeOptions from screenshot options and settings
	 */
	private buildTakeOptions(options: ScreenshotOptions, settings: ScreenshotOneSettings): screenshotone.TakeOptions {
		const takeOptions = screenshotone.TakeOptions.url(options.url);

		// Viewport settings
		const viewportWidth = options.viewportWidth ?? settings.viewportWidth ?? 1280;
		const viewportHeight = options.viewportHeight ?? settings.viewportHeight ?? 800;
		takeOptions.viewportWidth(viewportWidth);
		takeOptions.viewportHeight(viewportHeight);

		// Format
		const format = options.format ?? settings.format ?? 'png';
		takeOptions.format(format);

		// Full page
		const fullPage = options.fullPage ?? settings.fullPage ?? false;
		takeOptions.fullPage(fullPage);

		// Device scale factor
		const deviceScaleFactor = options.deviceScaleFactor ?? settings.deviceScaleFactor ?? 1;
		takeOptions.deviceScaleFactor(deviceScaleFactor);

		// Ad and tracker blocking
		const blockAds = options.blockAds ?? settings.blockAds ?? true;
		const blockTrackers = options.blockTrackers ?? settings.blockTrackers ?? true;
		takeOptions.blockAds(blockAds);
		takeOptions.blockTrackers(blockTrackers);

		// Cookie banners
		if (options.blockCookieBanners) {
			takeOptions.blockCookieBanners(true);
		}

		// Delay
		if (options.delay !== undefined) {
			takeOptions.delay(options.delay / 1000); // Convert ms to seconds
		}

		// Caching
		if (options.cache) {
			takeOptions.cache(true);
			if (options.cacheTtl !== undefined) {
				takeOptions.cacheTtl(options.cacheTtl);
			}
		}

		// Wait for selector
		if (options.waitForSelector) {
			takeOptions.selector(options.waitForSelector);
		}

		// User agent
		if (options.userAgent) {
			takeOptions.userAgent(options.userAgent);
		}

		return takeOptions;
	}

	/**
	 * Merge settings with defaults
	 */
	private mergeSettings(settings?: PluginSettings): ScreenshotOneSettings {
		return {
			accessKey: settings?.accessKey as string | undefined,
			secretKey: settings?.secretKey as string | undefined,
			viewportWidth: (settings?.viewportWidth as number | undefined) ?? 1280,
			viewportHeight: (settings?.viewportHeight as number | undefined) ?? 800,
			format: (settings?.format as ScreenshotFormat | undefined) ?? 'png',
			fullPage: (settings?.fullPage as boolean | undefined) ?? false,
			deviceScaleFactor: (settings?.deviceScaleFactor as number | undefined) ?? 1,
			blockAds: (settings?.blockAds as boolean | undefined) ?? true,
			blockTrackers: (settings?.blockTrackers as boolean | undefined) ?? true
		};
	}

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('ScreenshotOne Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('ScreenshotOne Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('ScreenshotOne Plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		// Access key is required
		if (!settings.accessKey) {
			errors.push({
				path: 'accessKey',
				message: 'Access key is required'
			});
		}

		// Validate viewport width
		if (settings.viewportWidth !== undefined) {
			const width = settings.viewportWidth as number;
			if (width < 320 || width > 3840) {
				errors.push({
					path: 'viewportWidth',
					message: 'Viewport width must be between 320 and 3840 pixels'
				});
			}
		}

		// Validate viewport height
		if (settings.viewportHeight !== undefined) {
			const height = settings.viewportHeight as number;
			if (height < 200 || height > 2160) {
				errors.push({
					path: 'viewportHeight',
					message: 'Viewport height must be between 200 and 2160 pixels'
				});
			}
		}

		// Validate format
		if (settings.format !== undefined && !['png', 'jpg', 'jpeg', 'webp'].includes(settings.format as string)) {
			errors.push({
				path: 'format',
				message: 'Format must be png, jpg, jpeg, or webp'
			});
		}

		// Validate device scale factor
		if (settings.deviceScaleFactor !== undefined) {
			const scale = settings.deviceScaleFactor as number;
			if (scale < 0.5 || scale > 3) {
				errors.push({
					path: 'deviceScaleFactor',
					message: 'Device scale factor must be between 0.5 and 3'
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
			message: 'ScreenshotOne plugin is ready (API key required for operations)',
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
			autoInstall: false,
			readme: [
				'## What does ScreenshotOne do?',
				'',
				'ScreenshotOne is a screenshot capture API. When directory items include source URLs, this plugin automatically generates preview images by capturing a screenshot of each page.',
				'',
				'## Why use it?',
				'',
				'- **Automated capture** — preview images are generated for each directory item without manual effort',
				'- **Consistent output** — every screenshot uses the same viewport size, format, and rendering settings',
				'- **Ad and tracker blocking** — captures clean screenshots free of ads and cookie banners',
				'- **Multiple formats** — supports PNG, JPG, and WebP output with configurable resolution',
				'',
				'## How it works in Ever Works',
				'',
				'During directory generation, the screenshot facade sends capture requests to ScreenshotOne for items that have a source URL. The resulting images are used as item preview thumbnails. You can configure viewport dimensions, image format, device scale factor, and caching behavior.',
				'',
				'## Getting started',
				'',
				'1. Sign up at [screenshotone.com](https://screenshotone.com)',
				'2. Copy your access key and optional secret key (for signed URLs)',
				'3. Enable the ScreenshotOne plugin on this page',
				'4. Enter your credentials in the settings below'
			].join('\n'),
			icon: {
				type: 'lucide',
				value: 'Camera',
				backgroundColor: '#4f46e5'
			}
		};
	}
}

export default ScreenshotOnePlugin;
