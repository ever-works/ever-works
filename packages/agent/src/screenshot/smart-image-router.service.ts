import { Injectable, Logger } from '@nestjs/common';
import { ScreenshotOneService } from './screenshot-one.service';
import { ImageScraperService } from './image-scraper.service';
import { User } from '../entities/user.entity';
import { DomainType } from '../items-generator/interfaces/items-generator.interfaces';

export type ImageSource = 'screenshot' | 'scraped';

export interface SmartImageRequest {
    url: string;
    domainType: DomainType;
    itemName?: string;
    user?: User;
}

export interface SmartImageResult {
    primaryImage: string | null;
    source: ImageSource;
    confidence?: number;
    error?: string;
}

export interface BulkImageRequest {
    url: string;
    itemName?: string;
    itemSlug?: string;
}

export interface BulkImageResult extends SmartImageResult {
    itemSlug?: string;
    itemName?: string;
}

// Delay between bulk requests to avoid rate limiting
const BULK_REQUEST_DELAY_MS = 500;

// Minimum score threshold for scraped images to be considered reliable
const MIN_SCRAPED_IMAGE_SCORE = 80;

@Injectable()
export class SmartImageRouterService {
    private readonly logger = new Logger(SmartImageRouterService.name);

    constructor(
        private readonly screenshotService: ScreenshotOneService,
        private readonly imageScraperService: ImageScraperService,
    ) {}

    /**
     * Get a smart image for an item based on directory domain type.
     *
     * Routing logic:
     * - SOFTWARE/SERVICES: Always use screenshot (best representation of the app/website)
     * - ECOMMERCE/GENERAL: Try to find a high-quality scraped image first (og:image, JSON-LD product image),
     *   fall back to screenshot if no suitable image found
     */
    async getSmartImage(request: SmartImageRequest): Promise<SmartImageResult> {
        const { url, domainType, itemName, user } = request;

        this.logger.debug(
            `Smart image routing for ${url}, domain type: ${domainType}, item: ${itemName}`,
        );

        try {
            // SOFTWARE/SERVICES: Always use screenshot
            if (domainType === DomainType.SOFTWARE || domainType === DomainType.SERVICES) {
                return this.captureScreenshot(url, user);
            }

            // ECOMMERCE/GENERAL: Try to find a high-quality scraped image first
            const scrapedResult = await this.tryGetScrapedImage(url);
            if (scrapedResult.primaryImage && scrapedResult.confidence! >= 0.8) {
                return scrapedResult;
            }

            // Fallback to screenshot
            return this.captureScreenshot(url, user);
        } catch (error) {
            this.logger.error(
                `Smart image routing failed for ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );

            // Final fallback: try screenshot
            try {
                return this.captureScreenshot(url, user);
            } catch {
                return {
                    primaryImage: null,
                    source: 'screenshot',
                    error: 'Failed to capture image',
                };
            }
        }
    }

    /**
     * Get smart images for multiple items in bulk
     */
    async bulkGetSmartImages(
        requests: BulkImageRequest[],
        domainType: DomainType,
        user?: User,
    ): Promise<BulkImageResult[]> {
        const results: BulkImageResult[] = [];

        for (const request of requests) {
            try {
                const result = await this.getSmartImage({
                    url: request.url,
                    domainType,
                    itemName: request.itemName,
                    user,
                });

                results.push({
                    ...result,
                    itemSlug: request.itemSlug,
                    itemName: request.itemName,
                });

                // Add delay between requests to avoid rate limiting
                if (requests.indexOf(request) < requests.length - 1) {
                    await this.delay(BULK_REQUEST_DELAY_MS);
                }
            } catch (error) {
                this.logger.error(
                    `Bulk image capture failed for ${request.url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                );

                results.push({
                    primaryImage: null,
                    source: 'screenshot',
                    itemSlug: request.itemSlug,
                    itemName: request.itemName,
                    error: error instanceof Error ? error.message : 'Unknown error',
                });
            }
        }

        return results;
    }

    /**
     * Try to get a high-quality image from page scraping.
     * Uses ImageScraperService heuristics which prioritize:
     * - og:image (score 100)
     * - twitter:image (score 95)
     * - JSON-LD product images (score 90)
     * - JSON-LD software images (score 85)
     * - In-content product images (score 70+)
     */
    private async tryGetScrapedImage(url: string): Promise<SmartImageResult> {
        try {
            // Scrape images from the page
            const scrapedImages = await this.imageScraperService.scrapeImages(url);

            if (scrapedImages.length === 0) {
                this.logger.debug(`No images found on page: ${url}`);
                return {
                    primaryImage: null,
                    source: 'scraped',
                    confidence: 0,
                };
            }

            // Filter to product candidates (removes icons, tracking pixels, etc.)
            const candidates = this.imageScraperService.filterProductCandidates(scrapedImages);

            if (candidates.length === 0) {
                this.logger.debug(`No product candidates found on page: ${url}`);
                return {
                    primaryImage: null,
                    source: 'scraped',
                    confidence: 0,
                };
            }

            // Images are already sorted by score in scrapeImages()
            // Take the highest-scored image
            const bestImage = candidates[0];

            // Only return if the image has a high enough score (og:image, JSON-LD, etc.)
            if (bestImage.score >= MIN_SCRAPED_IMAGE_SCORE) {
                this.logger.debug(
                    `Selected scraped image for ${url}: ${bestImage.url} (score: ${bestImage.score})`,
                );
                return {
                    primaryImage: bestImage.url,
                    source: 'scraped',
                    confidence: bestImage.score / 100, // Normalize to 0-1
                };
            }

            // Score too low, suggest screenshot fallback
            return {
                primaryImage: null,
                source: 'scraped',
                confidence: bestImage.score / 100,
            };
        } catch (error) {
            this.logger.error(
                `Image scraping failed for ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            return {
                primaryImage: null,
                source: 'scraped',
                confidence: 0,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * Capture a screenshot using ScreenshotOne.
     * Actually fetches the image (not just URL) for reliability.
     */
    private async captureScreenshot(url: string, user?: User): Promise<SmartImageResult> {
        if (!this.screenshotService.isAvailable(user)) {
            this.logger.warn('Screenshot service not available');
            return {
                primaryImage: null,
                source: 'screenshot',
                error: 'Screenshot service not available',
            };
        }

        const result = await this.screenshotService.capture(
            {
                url,
                blockAds: true,
                blockTrackers: true,
                blockCookieBanners: true,
            },
            user,
        );

        if (!result.success) {
            return {
                primaryImage: null,
                source: 'screenshot',
                error: result.error || 'Failed to capture screenshot',
            };
        }

        // Prefer cache URL (clean CDN URL without access key) over API URL
        const imageUrl = result.cacheUrl || result.imageUrl || null;

        return {
            primaryImage: imageUrl,
            source: 'screenshot',
            confidence: 1.0, // Screenshot is always reliable once captured
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
