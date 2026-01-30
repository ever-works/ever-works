export interface ScreenshotCaptureOptions {
	/** URL to capture */
	readonly url: string;
	/** Viewport width in pixels */
	readonly viewportWidth?: number;
	/** Viewport height in pixels */
	readonly viewportHeight?: number;
	/** Output format */
	readonly format?: 'png' | 'jpg' | 'webp';
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
}

export interface ScreenshotCaptureResult {
	/** Whether capture was successful */
	readonly success: boolean;
	/** Direct URL to the image (may expire) */
	readonly imageUrl?: string;
	/** Cached/permanent URL to the image */
	readonly cacheUrl?: string;
	/** Image as buffer */
	readonly imageBuffer?: Buffer;
	/** Error message if failed */
	readonly error?: string;
}

export interface SmartImageOptions {
	/** URL to capture */
	readonly url: string;
	/** Domain type (optional, not used for routing) */
	readonly domainType?: string;
	/** Item name for context */
	readonly itemName?: string;
}

export interface SmartImageResult {
	/** Primary image URL */
	readonly primaryImage?: string;
	/** Source of the image (screenshot, og-image, etc.) */
	readonly source: string;
	/** Additional images found */
	readonly additionalImages?: readonly string[];
}

/**
 * Screenshot Facade interface for pipeline steps.
 *
 * Provides screenshot capture and smart image routing capabilities.
 * The actual implementation handles provider resolution and settings.
 */
export interface IScreenshotFacade {
	/**
	 * Capture a screenshot of a URL.
	 *
	 * @param options - Screenshot options
	 * @returns Capture result with image URL or buffer
	 *
	 * @example
	 * ```typescript
	 * const result = await screenshotFacade.capture({
	 *     url: 'https://example.com',
	 *     viewportWidth: 1280,
	 *     viewportHeight: 800
	 * });
	 * if (result.success) {
	 *     console.log(result.cacheUrl);
	 * }
	 * ```
	 */
	capture(options: ScreenshotCaptureOptions): Promise<ScreenshotCaptureResult>;

	/**
	 * Get a smart image for a URL based on domain type.
	 *
	 * This method intelligently routes image capture based on the domain type:
	 * - For software: may prefer GitHub repo images, app screenshots
	 * - For ecommerce: may prefer product images
	 * - For general: uses standard screenshot
	 *
	 * @param options - Smart image options
	 * @returns Smart image result with primary image URL
	 */
	getSmartImage(options: SmartImageOptions): Promise<SmartImageResult>;

	/**
	 * Get a pre-signed screenshot URL without actually capturing.
	 *
	 * @param options - Screenshot options
	 * @returns Pre-signed URL or null if not available
	 */
	getScreenshotUrl(options: ScreenshotCaptureOptions): Promise<string | null>;

	/**
	 * Check if screenshot service is available.
	 */
	isAvailable(): boolean;
}
