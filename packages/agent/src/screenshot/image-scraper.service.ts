import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { parseHTML } from 'linkedom';

export interface ScrapedImage {
    url: string;
    alt?: string;
    width?: number;
    height?: number;
    isOpenGraph: boolean;
    isInMainContent: boolean;
    isJsonLd: boolean;
    score: number;
}

// Domains known to serve tracking pixels, ads, or icons
const BLOCKED_DOMAINS = [
    'google-analytics.com',
    'googletagmanager.com',
    'facebook.com',
    'doubleclick.net',
    'analytics',
    'pixel',
    'beacon',
    'tracking',
    'ads.',
    'ad.',
    'gravatar.com',
    'wp.com/latex',
    'shields.io',
    'badge',
    'btn_',
    'button_',
];

// Common icon/small image patterns
const ICON_PATTERNS = [
    /favicon/i,
    /icon/i,
    /logo.*small/i,
    /sprite/i,
    /avatar/i,
    /emoji/i,
    /\.svg$/i,
    /1x1/i,
    /spacer/i,
];

// Product-related class/id patterns
const PRODUCT_IMAGE_PATTERNS = [
    /product/i,
    /gallery/i,
    /main-image/i,
    /hero/i,
    /featured/i,
    /primary/i,
    /showcase/i,
    /zoom/i,
    /large/i,
    /full-size/i,
];

@Injectable()
export class ImageScraperService {
    private readonly logger = new Logger(ImageScraperService.name);

    /**
     * Scrape images from a URL
     */
    async scrapeImages(url: string): Promise<ScrapedImage[]> {
        try {
            this.logger.debug(`Scraping images from: ${url}`);

            const html = await this.fetchHtml(url);
            if (!html) {
                return [];
            }

            const { document } = parseHTML(html);
            const baseUrl = new URL(url);

            const images: ScrapedImage[] = [];

            // 1. Extract Open Graph images (highest priority)
            const ogImages = this.extractOpenGraphImages(document, baseUrl);
            images.push(...ogImages);

            // 2. Extract JSON-LD product images
            const jsonLdImages = this.extractJsonLdImages(document, baseUrl);
            images.push(...jsonLdImages);

            // 3. Extract images from <picture> elements
            const pictureImages = this.extractPictureImages(document, baseUrl);
            images.push(...pictureImages);

            // 4. Extract regular <img> elements
            const imgImages = this.extractImgElements(document, baseUrl);
            images.push(...imgImages);

            // Deduplicate by URL
            const uniqueImages = this.deduplicateImages(images);

            // Sort by score
            uniqueImages.sort((a, b) => b.score - a.score);

            this.logger.debug(`Found ${uniqueImages.length} unique images from ${url}`);

            return uniqueImages;
        } catch (error) {
            this.logger.error(
                `Failed to scrape images from ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            return [];
        }
    }

    /**
     * Filter images to find product candidates
     */
    filterProductCandidates(images: ScrapedImage[]): ScrapedImage[] {
        return images.filter((img) => {
            // Must have a valid URL
            if (!img.url) return false;

            // Skip blocked domains
            if (this.isBlockedDomain(img.url)) return false;

            // Skip small images (likely icons)
            if (img.width && img.width < 100) return false;
            if (img.height && img.height < 100) return false;

            // Skip icon patterns
            if (this.isIconPattern(img.url)) return false;

            // Prefer images with higher scores
            return img.score >= 0;
        });
    }

    private async fetchHtml(url: string): Promise<string | null> {
        try {
            const response = await axios.get(url, {
                headers: {
                    Accept: 'text/html',
                    'Accept-Encoding': 'gzip, deflate',
                    'Accept-Language': 'en-US,en',
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                },
                timeout: 15000,
                validateStatus: (status) => status >= 200 && status < 400,
                maxRedirects: 5,
            });

            const contentType = response.headers['content-type'] || '';
            if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
                this.logger.warn(`Non-HTML content at ${url}: ${contentType}`);
                return null;
            }

            return response.data;
        } catch (error) {
            this.logger.error(
                `Failed to fetch HTML from ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            return null;
        }
    }

    private extractOpenGraphImages(document: Document, baseUrl: URL): ScrapedImage[] {
        const images: ScrapedImage[] = [];

        // og:image
        const ogImage = document.querySelector('meta[property="og:image"]');
        if (ogImage) {
            const content = ogImage.getAttribute('content');
            if (content) {
                const resolvedUrl = this.resolveUrl(content, baseUrl);
                if (resolvedUrl) {
                    images.push({
                        url: resolvedUrl,
                        isOpenGraph: true,
                        isInMainContent: false,
                        isJsonLd: false,
                        score: 100, // Highest priority
                    });
                }
            }
        }

        // twitter:image
        const twitterImage = document.querySelector('meta[name="twitter:image"]');
        if (twitterImage) {
            const content = twitterImage.getAttribute('content');
            if (content) {
                const resolvedUrl = this.resolveUrl(content, baseUrl);
                if (resolvedUrl) {
                    images.push({
                        url: resolvedUrl,
                        isOpenGraph: true,
                        isInMainContent: false,
                        isJsonLd: false,
                        score: 95,
                    });
                }
            }
        }

        return images;
    }

    private extractJsonLdImages(document: Document, baseUrl: URL): ScrapedImage[] {
        const images: ScrapedImage[] = [];

        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        scripts.forEach((script) => {
            try {
                const json = JSON.parse(script.textContent || '');
                const extractedImages = this.extractImagesFromJsonLd(json, baseUrl);
                images.push(...extractedImages);
            } catch {
                // Invalid JSON, skip
            }
        });

        return images;
    }

    private extractImagesFromJsonLd(json: any, baseUrl: URL): ScrapedImage[] {
        const images: ScrapedImage[] = [];

        if (!json) return images;

        // Handle @graph array
        if (json['@graph'] && Array.isArray(json['@graph'])) {
            json['@graph'].forEach((item: any) => {
                images.push(...this.extractImagesFromJsonLd(item, baseUrl));
            });
            return images;
        }

        // Product schema
        if (json['@type'] === 'Product' || json['@type']?.includes?.('Product')) {
            if (json.image) {
                const imgUrls = Array.isArray(json.image) ? json.image : [json.image];
                imgUrls.forEach((imgUrl: any) => {
                    const url = typeof imgUrl === 'string' ? imgUrl : imgUrl?.url;
                    if (url) {
                        const resolvedUrl = this.resolveUrl(url, baseUrl);
                        if (resolvedUrl) {
                            images.push({
                                url: resolvedUrl,
                                isOpenGraph: false,
                                isInMainContent: false,
                                isJsonLd: true,
                                score: 90, // High priority for product images
                            });
                        }
                    }
                });
            }
        }

        // SoftwareApplication schema
        if (json['@type'] === 'SoftwareApplication') {
            if (json.image) {
                const resolvedUrl = this.resolveUrl(json.image, baseUrl);
                if (resolvedUrl) {
                    images.push({
                        url: resolvedUrl,
                        isOpenGraph: false,
                        isInMainContent: false,
                        isJsonLd: true,
                        score: 85,
                    });
                }
            }
            if (json.screenshot) {
                const resolvedUrl = this.resolveUrl(json.screenshot, baseUrl);
                if (resolvedUrl) {
                    images.push({
                        url: resolvedUrl,
                        isOpenGraph: false,
                        isInMainContent: false,
                        isJsonLd: true,
                        score: 85,
                    });
                }
            }
        }

        return images;
    }

    private extractPictureImages(document: Document, baseUrl: URL): ScrapedImage[] {
        const images: ScrapedImage[] = [];

        const pictures = document.querySelectorAll('picture');
        pictures.forEach((picture) => {
            const img = picture.querySelector('img');
            const sources = picture.querySelectorAll('source');

            // Prefer srcset from sources (usually higher resolution)
            sources.forEach((source) => {
                const srcset = source.getAttribute('srcset');
                if (srcset) {
                    const urls = this.parseSrcset(srcset, baseUrl);
                    const isInMain = this.isInMainContent(picture);
                    urls.forEach((url, index) => {
                        images.push({
                            url,
                            isOpenGraph: false,
                            isInMainContent: isInMain,
                            isJsonLd: false,
                            score: isInMain ? 70 - index : 50 - index,
                        });
                    });
                }
            });

            // Fallback to img src
            if (img) {
                const src = img.getAttribute('src');
                if (src) {
                    const resolvedUrl = this.resolveUrl(src, baseUrl);
                    if (resolvedUrl) {
                        const isInMain = this.isInMainContent(img);
                        images.push({
                            url: resolvedUrl,
                            alt: img.getAttribute('alt') || undefined,
                            width: parseInt(img.getAttribute('width') || '0', 10) || undefined,
                            height: parseInt(img.getAttribute('height') || '0', 10) || undefined,
                            isOpenGraph: false,
                            isInMainContent: isInMain,
                            isJsonLd: false,
                            score: isInMain ? 65 : 45,
                        });
                    }
                }
            }
        });

        return images;
    }

    private extractImgElements(document: Document, baseUrl: URL): ScrapedImage[] {
        const images: ScrapedImage[] = [];

        const imgs = document.querySelectorAll('img');
        imgs.forEach((img) => {
            const src = img.getAttribute('src');
            const dataSrc = img.getAttribute('data-src'); // Lazy loading
            const srcset = img.getAttribute('srcset');

            const imageUrl = src || dataSrc;
            if (imageUrl) {
                const resolvedUrl = this.resolveUrl(imageUrl, baseUrl);
                if (resolvedUrl) {
                    const isInMain = this.isInMainContent(img);
                    const isProductImage = this.isProductImage(img);
                    const alt = img.getAttribute('alt') || undefined;
                    const width = parseInt(img.getAttribute('width') || '0', 10) || undefined;
                    const height = parseInt(img.getAttribute('height') || '0', 10) || undefined;

                    let score = 30;
                    if (isInMain) score += 20;
                    if (isProductImage) score += 25;
                    if (alt && alt.length > 10) score += 5;
                    if (width && width > 300) score += 10;
                    if (height && height > 300) score += 10;

                    images.push({
                        url: resolvedUrl,
                        alt,
                        width,
                        height,
                        isOpenGraph: false,
                        isInMainContent: isInMain,
                        isJsonLd: false,
                        score,
                    });
                }
            }

            // Also extract from srcset
            if (srcset) {
                const urls = this.parseSrcset(srcset, baseUrl);
                const isInMain = this.isInMainContent(img);
                urls.forEach((url, index) => {
                    images.push({
                        url,
                        isOpenGraph: false,
                        isInMainContent: isInMain,
                        isJsonLd: false,
                        score: isInMain ? 35 - index : 25 - index,
                    });
                });
            }
        });

        return images;
    }

    private parseSrcset(srcset: string, baseUrl: URL): string[] {
        const urls: string[] = [];
        const parts = srcset.split(',');

        parts.forEach((part) => {
            const [url] = part.trim().split(/\s+/);
            if (url) {
                const resolvedUrl = this.resolveUrl(url, baseUrl);
                if (resolvedUrl) {
                    urls.push(resolvedUrl);
                }
            }
        });

        // Return unique URLs, preferring larger images (usually listed last)
        return [...new Set(urls)].reverse();
    }

    private resolveUrl(url: string, baseUrl: URL): string | null {
        try {
            if (!url || url.startsWith('data:')) {
                return null;
            }
            const resolved = new URL(url, baseUrl);
            return resolved.href;
        } catch {
            return null;
        }
    }

    private isInMainContent(element: Element): boolean {
        let current: Element | null = element;
        while (current) {
            const tagName = current.tagName?.toLowerCase();
            if (['main', 'article', 'section'].includes(tagName)) {
                return true;
            }

            const className = current.getAttribute('class') || '';
            const id = current.getAttribute('id') || '';
            const combined = `${className} ${id}`.toLowerCase();

            if (
                combined.includes('main') ||
                combined.includes('content') ||
                combined.includes('article') ||
                combined.includes('product')
            ) {
                return true;
            }

            current = current.parentElement;
        }
        return false;
    }

    private isProductImage(element: Element): boolean {
        const className = element.getAttribute('class') || '';
        const id = element.getAttribute('id') || '';
        const alt = element.getAttribute('alt') || '';
        const src = element.getAttribute('src') || '';

        const combined = `${className} ${id} ${alt} ${src}`.toLowerCase();

        return PRODUCT_IMAGE_PATTERNS.some((pattern) => pattern.test(combined));
    }

    private isBlockedDomain(url: string): boolean {
        const lowerUrl = url.toLowerCase();
        return BLOCKED_DOMAINS.some((domain) => lowerUrl.includes(domain));
    }

    private isIconPattern(url: string): boolean {
        return ICON_PATTERNS.some((pattern) => pattern.test(url));
    }

    private deduplicateImages(images: ScrapedImage[]): ScrapedImage[] {
        const seen = new Map<string, ScrapedImage>();

        images.forEach((img) => {
            const existing = seen.get(img.url);
            if (!existing || img.score > existing.score) {
                seen.set(img.url, img);
            }
        });

        return Array.from(seen.values());
    }
}
