import { Injectable, Logger } from '@nestjs/common';
import { tavily, TavilyClient } from '@tavily/core';
import { ConfigDto } from '../dto/create-items-generator.dto';
import TurndownService from 'turndown';
import axios from 'axios';
import { config } from '@src/config';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export type SearchResult = {
    title: string;
    url: string;
    score: number;
    publishedDate: string;
};

@Injectable()
export class SearchService {
    private readonly logger = new Logger(SearchService.name);
    private readonly tavilyClient: TavilyClient | undefined;
    private readonly isTavilyConfigured: boolean;
    private turndownService: TurndownService;

    constructor() {
        this.isTavilyConfigured = !!config.tavily.getApiKey();

        if (this.isTavilyConfigured) {
            this.tavilyClient = tavily({
                apiKey: config.tavily.getApiKey(),
            });
        }

        this.turndownService = new TurndownService();

        this.logger.log(
            `Extract content service configured: ${config.search.getExtractContentService()}`,
        );

        this.logger.log(`Web search service configured: ${config.search.getWebSearchService()}`);
    }

    /**
     * Check if the local search service is configured
     */
    isLocalExtractContentConfigured(): boolean {
        return config.search.getExtractContentService() === 'local';
    }

    /**
     * Check if the search service is properly configured
     */
    isTavilySearchConfigured(): boolean {
        return this.isTavilyConfigured;
    }

    /**
     * Get the Tavily client instance
     */
    getTavilyClient(): TavilyClient | undefined {
        return this.tavilyClient;
    }

    /**
     * Perform a web search using Tavily
     * @param query The search query
     * @param config Optional configuration
     */
    async webSearch(query: string, config?: Partial<ConfigDto>): Promise<SearchResult[]> {
        return this.webSearchUsingTavily(query, config);
    }

    /**
     * Perform a web search using tavily
     * @param query The search query
     * @param config Optional configuration
     */

    async webSearchUsingTavily(
        query: string,
        config?: Partial<ConfigDto>,
    ): Promise<SearchResult[]> {
        const DEFAULT_MAX_RESULTS = 20;

        const searches = await this.tavilyClient.search(query, {
            maxResults: config?.max_results_per_query || DEFAULT_MAX_RESULTS,
        });

        return searches.results.sort((a, b) => b.score - a.score);
    }

    /**
     * Extract content from a URL using Tavily
     * @param url The URL to extract content from
     */
    async extractContent(url: string) {
        // Change condition to use the new 'local' method
        if (this.isLocalExtractContentConfigured() || !this.isTavilySearchConfigured()) {
            const text = await this.extractTextFromSourceURL(url);

            return {
                url,
                images: [],
                rawContent: text,
            };
        }

        const response = await this.tavilyClient.extract([url], {
            maxResults: 1,
        });

        if (!response.results[0]) {
            throw new Error(`Failed to extract content from ${url}`);
        }

        return response.results[0];
    }

    // Renamed for clarity to reflect
    async extractContentUsingLocal(url: string) {
        return await this.extractTextFromSourceURL(url);
    }

    private async extractTextFromSourceURL(source_url: string): Promise<string> {
        const baseHeaders = {
            Accept: 'text/html',
            'Accept-Encoding': 'gzip, deflate',
            'Accept-Language': 'en-US,en',
            'upgrade-insecure-requests': '1',
            'Accept-language': 'en-US,en;q=0.9',
            'Cache-control': 'max-age=0',
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        };

        const response = await axios.get(source_url, {
            headers: baseHeaders,
            timeout: 15000,
            validateStatus: (status) => status >= 200 && status < 400, // Only consider 2xx and 3xx as success
        });

        if (
            response.headers['content-type'] &&
            !response.headers['content-type'].includes('text/html') &&
            !response.headers['content-type'].includes('text/plain')
        ) {
            this.logger.warn(
                `[extractTextFromSourceURL] Skipping non-HTML/text content at ${source_url} (Content-Type: ${response.headers['content-type']})`,
            );
            return '';
        }

        return this.extractTextFromHtml(source_url, response.data);
    }

    private extractTextFromHtml(url: string, htmlContent: string): string {
        try {
            // Use linkedom to create a DOM environment
            const { document } = parseHTML(htmlContent);

            // 1. Try Mozilla Readability first (best quality)
            const readabilityContent = this.extractWithReadability(url, document);
            if (readabilityContent) {
                return readabilityContent;
            }

            // 2. Fallback: Try meta description
            const metaContent = this.extractMetaDescription(url, document);
            if (metaContent) {
                return metaContent;
            }

            // 3. Final Fallback: Cleaned body content
            return this.extractBodyFallback(url, document);
        } catch (error) {
            this.logger.error(
                `Error extracting text with Readability/Linkedom for ${url}: ${error.message}`,
                error.stack,
            );
            return this.extractBodyFallback(url, null, htmlContent);
        }
    }

    private extractWithReadability(url: string, document: any): string | null {
        try {
            const reader = new Readability(document);
            const article = reader.parse();

            if (article && article.textContent && article.textContent.length > 200) {
                return this.turndownService.turndown(article.content);
            }

            return null;
        } catch (error) {
            this.logger.debug(`Readability extraction failed for ${url}: ${error.message}`);
            return null;
        }
    }

    private extractMetaDescription(url: string, document: any): string | null {
        const metaDescription =
            document.querySelector('meta[name="description"]')?.getAttribute('content') ||
            document.querySelector('meta[property="og:description"]')?.getAttribute('content');

        if (metaDescription && metaDescription.length > 0) {
            return metaDescription;
        }
        return null;
    }

    private extractBodyFallback(url: string, document?: any, originalHtml?: string): string {
        try {
            let doc = document;
            if (!doc && originalHtml) {
                doc = parseHTML(originalHtml).document;
            }

            if (!doc) {
                return '';
            }

            // Remove scripts, styles, and other non-content elements
            doc.querySelectorAll(
                'script, style, noscript, iframe, header, footer, nav, aside, form, [aria-hidden="true"], .noprint',
            ).forEach((el: any) => el.remove());

            let bodyHtml = doc.body?.innerHTML || '';
            bodyHtml = bodyHtml.replace(/\s\s+/g, ' ').trim();

            if (bodyHtml.length > 0) {
                return this.turndownService.turndown(bodyHtml);
            }
        } catch (error) {
            this.logger.error(`Error in body fallback extraction for ${url}: ${error.message}`);
        }

        this.logger.warn(`Failed to extract any meaningful content from ${url}`);
        return '';
    }
}
