import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Screenshot format options
 */
export type ScreenshotFormat = 'png' | 'jpg' | 'jpeg' | 'webp';

/**
 * Screenshot capture options
 */
export interface ScreenshotOptions {
	/** URL to capture */
	readonly url: string;
	/** Viewport width in pixels */
	readonly viewportWidth?: number;
	/** Viewport height in pixels */
	readonly viewportHeight?: number;
	/** Output format */
	readonly format?: ScreenshotFormat;
	/** Capture full page */
	readonly fullPage?: boolean;
	/** Delay in milliseconds before capture */
	readonly delay?: number;
	/** Block ads */
	readonly blockAds?: boolean;
	/** Block trackers */
	readonly blockTrackers?: boolean;
	/** Block cookie banners */
	readonly blockCookieBanners?: boolean;
	/** Enable caching */
	readonly cache?: boolean;
	/** Cache TTL in seconds */
	readonly cacheTtl?: number;
	/** Device scale factor */
	readonly deviceScaleFactor?: number;
	/** Clip area */
	readonly clip?: ScreenshotClip;
	/** Wait for selector before capture */
	readonly waitForSelector?: string;
	/** Wait for navigation */
	readonly waitForNavigation?: boolean;
	/** Custom user agent */
	readonly userAgent?: string;
	/** Custom headers */
	readonly headers?: Record<string, string>;
	/** Cookies to set */
	readonly cookies?: readonly ScreenshotCookie[];
	/**
	 * Resolved settings for this operation.
	 * Passed by the facade with user/directory-scoped settings.
	 * Plugins should use these settings instead of their stored defaults.
	 */
	readonly settings?: PluginSettings;
}

/**
 * Clip area for partial screenshot
 */
export interface ScreenshotClip {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Cookie for screenshot request
 */
export interface ScreenshotCookie {
	readonly name: string;
	readonly value: string;
	readonly domain?: string;
	readonly path?: string;
	readonly httpOnly?: boolean;
	readonly secure?: boolean;
}

/**
 * Screenshot capture result
 */
export interface ScreenshotResult {
	/** Whether capture was successful */
	readonly success: boolean;
	/** Direct URL to the image (may expire) */
	readonly imageUrl?: string;
	/** Cached/permanent URL to the image */
	readonly cacheUrl?: string;
	/** Image as buffer (if requested) */
	readonly imageBuffer?: Buffer;
	/** Image as base64 string (if requested) */
	readonly imageBase64?: string;
	/** Error message if failed */
	readonly error?: string;
	/** Image width */
	readonly width?: number;
	/** Image height */
	readonly height?: number;
	/** Image file size in bytes */
	readonly fileSize?: number;
}

/**
 * Screenshot validation result
 */
export interface ScreenshotValidationResult {
	readonly valid: boolean;
	readonly message?: string;
}

/**
 * Screenshot plugin interface
 * Capability: 'screenshot'
 */
export interface IScreenshotPlugin extends IPlugin {
	/** Provider name (e.g., 'screenshotone', 'browserless', 'puppeteer') */
	readonly providerName: string;

	/**
	 * Capture a screenshot
	 */
	capture(options: ScreenshotOptions): Promise<ScreenshotResult>;

	/**
	 * Get screenshot URL without actually capturing
	 */
	getScreenshotUrl?(options: ScreenshotOptions): Promise<string | null>;

	/**
	 * Check if the service is available
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Validate API keys/credentials
	 */
	validateCredentials?(): Promise<ScreenshotValidationResult>;

	/**
	 * Get supported formats
	 */
	getSupportedFormats?(): readonly ScreenshotFormat[];

	/**
	 * Get maximum viewport dimensions
	 */
	getMaxDimensions?(): { width: number; height: number };
}

/**
 * Type guard for screenshot plugins
 */
export function isScreenshotPlugin(plugin: IPlugin): plugin is IScreenshotPlugin {
	return plugin.capabilities.includes('screenshot');
}
