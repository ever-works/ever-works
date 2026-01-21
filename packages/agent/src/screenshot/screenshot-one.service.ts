import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { config } from '../config';
import { User } from '../entities/user.entity';

export interface ScreenshotOptions {
    url: string;
    viewportWidth?: number;
    viewportHeight?: number;
    format?: 'png' | 'jpg' | 'webp';
    fullPage?: boolean;
    delay?: number;
    blockAds?: boolean;
    blockTrackers?: boolean;
    blockCookieBanners?: boolean;
}

export interface ScreenshotResult {
    success: boolean;
    imageUrl?: string;
    imageBuffer?: Buffer;
    error?: string;
}

export interface ScreenshotValidationResult {
    valid: boolean;
    message?: string;
}

@Injectable()
export class ScreenshotOneService {
    private readonly logger = new Logger(ScreenshotOneService.name);
    private readonly baseUrl = 'https://api.screenshotone.com/take';

    /**
     * Resolves the access key to use. User key takes precedence over global.
     */
    resolveAccessKey(user?: User): string | null {
        if (user?.screenshotoneAccessKey) {
            return user.screenshotoneAccessKey;
        }
        return config.screenshotone.getAccessKey() || null;
    }

    /**
     * Checks if the service is available (has a valid access key configured).
     */
    isAvailable(user?: User): boolean {
        return this.resolveAccessKey(user) !== null;
    }

    /**
     * Captures a screenshot of the given URL.
     */
    async capture(options: ScreenshotOptions, user?: User): Promise<ScreenshotResult> {
        const accessKey = this.resolveAccessKey(user);

        if (!accessKey) {
            this.logger.warn('ScreenshotOne capture attempted without API key');
            return {
                success: false,
                error: 'No ScreenshotOne API key configured',
            };
        }

        try {
            const params = this.buildParams(options, accessKey);
            const queryString = new URLSearchParams(params).toString();
            const screenshotUrl = `${this.baseUrl}?${queryString}`;

            this.logger.debug(`Capturing screenshot for URL: ${options.url}`);

            // Fetch the screenshot as a buffer
            const response = await axios.get(screenshotUrl, {
                responseType: 'arraybuffer',
                timeout: 60000, // 60 second timeout
                validateStatus: (status) => status >= 200 && status < 400,
            });

            if (response.status !== 200) {
                return {
                    success: false,
                    error: `Screenshot API returned status ${response.status}`,
                };
            }

            // Return the image URL (for direct use) and buffer (for storage)
            return {
                success: true,
                imageUrl: screenshotUrl,
                imageBuffer: Buffer.from(response.data),
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Failed to capture screenshot for ${options.url}: ${errorMessage}`);

            return {
                success: false,
                error: errorMessage,
            };
        }
    }

    /**
     * Gets the direct URL for a screenshot (without fetching it).
     * Useful for displaying screenshots directly in img tags.
     */
    getScreenshotUrl(options: ScreenshotOptions, user?: User): string | null {
        const accessKey = this.resolveAccessKey(user);

        if (!accessKey) {
            return null;
        }

        const params = this.buildParams(options, accessKey);
        const queryString = new URLSearchParams(params).toString();
        return `${this.baseUrl}?${queryString}`;
    }

    /**
     * Validates an access key by making a test request to the API.
     */
    async validateAccessKey(accessKey: string): Promise<ScreenshotValidationResult> {
        if (!accessKey || typeof accessKey !== 'string') {
            return {
                valid: false,
                message: 'Access key is required',
            };
        }

        try {
            // Test the key by trying to capture a screenshot of a simple page
            const testUrl = 'https://httpbin.org/html';
            const params = this.buildParams(
                {
                    url: testUrl,
                    viewportWidth: 320,
                    viewportHeight: 240,
                    format: 'png',
                },
                accessKey,
            );

            const queryString = new URLSearchParams(params).toString();
            const screenshotUrl = `${this.baseUrl}?${queryString}`;

            const response = await axios.head(screenshotUrl, {
                timeout: 30000,
                validateStatus: (status) => status >= 200 && status < 500,
            });

            if (response.status === 200) {
                return {
                    valid: true,
                    message: 'Access key is valid',
                };
            } else if (response.status === 401 || response.status === 403) {
                return {
                    valid: false,
                    message: 'Invalid or unauthorized access key',
                };
            } else {
                return {
                    valid: false,
                    message: `Unexpected response status: ${response.status}`,
                };
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Failed to validate access key: ${errorMessage}`);

            return {
                valid: false,
                message: 'Failed to validate access key',
            };
        }
    }

    /**
     * Builds the query parameters for the ScreenshotOne API.
     */
    private buildParams(options: ScreenshotOptions, accessKey: string): Record<string, string> {
        const params: Record<string, string> = {
            access_key: accessKey,
            url: options.url,
            viewport_width: String(
                options.viewportWidth || config.screenshotone.getDefaultViewportWidth(),
            ),
            viewport_height: String(
                options.viewportHeight || config.screenshotone.getDefaultViewportHeight(),
            ),
            format: options.format || config.screenshotone.getDefaultFormat(),
        };

        // Optional parameters
        if (options.fullPage) {
            params.full_page = 'true';
        }

        if (options.delay !== undefined && options.delay > 0) {
            params.delay = String(options.delay);
        }

        if (options.blockAds) {
            params.block_ads = 'true';
        }

        if (options.blockTrackers) {
            params.block_trackers = 'true';
        }

        if (options.blockCookieBanners) {
            params.block_cookie_banners = 'true';
        }

        return params;
    }
}
