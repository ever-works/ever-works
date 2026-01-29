import { Injectable, Logger } from '@nestjs/common';
import * as screenshotone from 'screenshotone-api-sdk';
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
    cache?: boolean;
    cacheTtl?: number;
}

export interface ScreenshotResult {
    success: boolean;
    imageUrl?: string;
    cacheUrl?: string;
    imageBuffer?: Buffer;
    error?: string;
}

export interface ScreenshotValidationResult {
    valid: boolean;
    message?: string;
}

export interface ScreenshotKeys {
    accessKey: string;
    secretKey?: string;
}

@Injectable()
export class ScreenshotOneService {
    private readonly logger = new Logger(ScreenshotOneService.name);

    resolveKeys(user?: User): ScreenshotKeys | null {
        const accessKey = user?.screenshotoneAccessKey || config.screenshotone.getAccessKey();
        if (!accessKey) {
            return null;
        }

        const secretKey = user?.screenshotoneSecretKey || config.screenshotone.getSecretKey();
        return { accessKey, secretKey: secretKey || undefined };
    }

    isAvailable(user?: User): boolean {
        return this.resolveKeys(user) !== null;
    }

    private createClient(keys: ScreenshotKeys): screenshotone.Client {
        return new screenshotone.Client(keys.accessKey, keys.secretKey || '');
    }

    private buildTakeOptions(
        options: ScreenshotOptions,
        enableCache = true,
    ): screenshotone.TakeOptions {
        const takeOptions = screenshotone.TakeOptions.url(options.url)
            .viewportWidth(options.viewportWidth || config.screenshotone.getDefaultViewportWidth())
            .viewportHeight(
                options.viewportHeight || config.screenshotone.getDefaultViewportHeight(),
            )
            .format(options.format || config.screenshotone.getDefaultFormat());

        if (options.fullPage) {
            takeOptions.fullPage(true);
        }

        if (options.delay !== undefined && options.delay > 0) {
            takeOptions.delay(options.delay);
        }

        if (options.blockAds) {
            takeOptions.blockAds(true);
        }

        if (options.blockTrackers) {
            takeOptions.blockTrackers(true);
        }

        if (options.blockCookieBanners) {
            takeOptions.blockCookieBanners(true);
        }

        // Enable caching by default (7 days = 604800 seconds)
        if (enableCache && options.cache !== false) {
            takeOptions.cache(true);
            takeOptions.cacheTtl(options.cacheTtl || 604800);
        }

        return takeOptions;
    }

    async capture(options: ScreenshotOptions, user?: User): Promise<ScreenshotResult> {
        const keys = this.resolveKeys(user);

        if (!keys) {
            this.logger.warn('ScreenshotOne capture attempted without API key');
            return {
                success: false,
                error: 'No ScreenshotOne API key configured',
            };
        }

        try {
            const client = this.createClient(keys);
            const takeOptions = this.buildTakeOptions(options);

            this.logger.debug(
                `Capturing screenshot for URL: ${options.url} (signed: ${!!keys.secretKey}, cache: true)`,
            );

            // Generate the API URL (signed if secret key available)
            const screenshotUrl = keys.secretKey
                ? await client.generateSignedTakeURL(takeOptions)
                : await client.generateTakeURL(takeOptions);

            // Make HTTP request to capture screenshot and get cache URL from headers
            const response = await axios.get(screenshotUrl, {
                responseType: 'arraybuffer',
                timeout: 60000,
                validateStatus: (status) => status >= 200 && status < 400,
            });

            const imageBuffer = Buffer.from(response.data);

            // Extract cache URL from response headers (clean URL without access key)
            const cacheUrl = response.headers['x-screenshotone-cache-url'] as string | undefined;

            this.logger.debug(
                `Screenshot captured for ${options.url}, cache URL: ${cacheUrl ? 'obtained' : 'not available'}`,
            );

            return {
                success: true,
                imageUrl: screenshotUrl,
                cacheUrl: cacheUrl || undefined,
                imageBuffer,
            };
        } catch (error) {
            if (error instanceof screenshotone.APIError) {
                this.logger.error(
                    `ScreenshotOne API error for ${options.url}: ${error.errorMessage} (${error.errorCode})`,
                );
                return {
                    success: false,
                    error: error.errorMessage || `API error: ${error.errorCode}`,
                };
            }

            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const message = error.response?.data
                    ? Buffer.from(error.response.data).toString('utf-8')
                    : error.message;
                this.logger.error(
                    `ScreenshotOne HTTP error for ${options.url}: ${status} - ${message}`,
                );
                return {
                    success: false,
                    error: `HTTP ${status}: ${message}`,
                };
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Failed to capture screenshot for ${options.url}: ${errorMessage}`);

            return {
                success: false,
                error: errorMessage,
            };
        }
    }

    async getScreenshotUrl(options: ScreenshotOptions, user?: User): Promise<string | null> {
        const keys = this.resolveKeys(user);

        if (!keys) {
            return null;
        }

        const client = this.createClient(keys);
        const takeOptions = this.buildTakeOptions(options);

        return keys.secretKey
            ? await client.generateSignedTakeURL(takeOptions)
            : await client.generateTakeURL(takeOptions);
    }

    async validateKeys(accessKey: string, secretKey?: string): Promise<ScreenshotValidationResult> {
        if (!accessKey || typeof accessKey !== 'string') {
            return {
                valid: false,
                message: 'Access key is required',
            };
        }

        try {
            const client = new screenshotone.Client(accessKey, secretKey || '');
            const testOptions = screenshotone.TakeOptions.url('https://httpbin.org/html')
                .viewportWidth(320)
                .viewportHeight(240)
                .format('png');

            const screenshotUrl = secretKey
                ? await client.generateSignedTakeURL(testOptions)
                : await client.generateTakeURL(testOptions);

            const response = await axios.head(screenshotUrl, {
                timeout: 30000,
                validateStatus: (status) => status >= 200 && status < 500,
            });

            if (response.status === 200) {
                return {
                    valid: true,
                    message: secretKey
                        ? 'Access key and secret key are valid'
                        : 'Access key is valid',
                };
            } else if (response.status === 401 || response.status === 403) {
                return {
                    valid: false,
                    message: 'Invalid or unauthorized keys',
                };
            } else {
                return {
                    valid: false,
                    message: `Unexpected response status: ${response.status}`,
                };
            }
        } catch (error) {
            if (error instanceof screenshotone.APIError) {
                return {
                    valid: false,
                    message: error.errorMessage || 'Invalid keys',
                };
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error(`Failed to validate keys: ${errorMessage}`);

            return {
                valid: false,
                message: 'Failed to validate keys',
            };
        }
    }
}
