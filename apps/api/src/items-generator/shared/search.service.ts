import { Injectable, Logger } from '@nestjs/common';
import { tavily, TavilyClient } from '@tavily/core';
import { ConfigDto } from '../dto/create-items-generator.dto';
import { search, OrganicResult, DictionaryResult, OrganicResultNode } from 'google-sr';

import * as cheerio from 'cheerio';
import * as TurndownService from 'turndown';
import axios from 'axios';

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
        this.isTavilyConfigured = !!process.env.TAVILY_API_KEY;

        if (this.isTavilyConfigured) {
            this.tavilyClient = tavily({
                apiKey: process.env.TAVILY_API_KEY,
            });
        }

        this.turndownService = new TurndownService();

        this.logger.log(
            `Extract content service configured: ${
                process.env.EXTRACT_CONTENT_SERVICE || 'Tavily'
            }`,
        );

        this.logger.log(
            `Web search service configured: ${process.env.WEB_SEARCH_SERVICE || 'Tavily'}`,
        );
    }

    /**
     * Check if the naive search service is configured
     */
    isNaiveExtractContentConfigured(): boolean {
        return process.env.EXTRACT_CONTENT_SERVICE === 'naive';
    }

    /**
     * Check if the Google search service is configured
     */
    isGoogleSearchConfigured(): boolean {
        return process.env.WEB_SEARCH_SERVICE === 'google-sr';
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
        if (this.isGoogleSearchConfigured() || !this.tavilyClient) {
            return this.webSearchUsingGoogle(query, config);
        }

        return this.webSearchUsingTavily(query, config);
    }

    /**
     * Perform a web search using tavily
     * @param query The search query
     * @param config Optional configuration
     */

    async webSearchUsingTavily(query: string, config?: Partial<ConfigDto>) {
        const DEFAULT_MAX_RESULTS = 20;

        const searches = await this.tavilyClient.search(query, {
            maxResults: config?.max_results_per_query || DEFAULT_MAX_RESULTS,
        });

        return searches.results.sort((a, b) => b.score - a.score);
    }

    /**
     * Perform a web search using Google
     * @param query The search query
     * @param config Optional configuration
     */
    async webSearchUsingGoogle(query: string, config?: Partial<ConfigDto>) {
        let results = await search({
            query,
            resultTypes: [OrganicResult, DictionaryResult],
            requestConfig: {
                params: {
                    safe: 'active',
                },
            },
        });

        results = results.slice(0, config?.max_results_per_query || 20);

        return results.map((result: OrganicResultNode) => ({
            title: result.title,
            url: result.link,
            score: 1,
            publishedDate: new Date().toISOString(),
        }));
    }

    /**
     * Extract content from a URL using Tavily
     * @param url The URL to extract content from
     */
    async extractContent(url: string) {
        if (this.isNaiveExtractContentConfigured() || !this.tavilyClient) {
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

    async extractContentUsingNaive(url: string) {
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

        return this.extractTextFromHtml(response.data);
    }

    private extractTextFromHtml(htmlContent: string): string {
        try {
            const $ = cheerio.load(htmlContent);
            // Remove script and style elements
            $(
                'script, style, noscript, iframe, header, footer, nav, aside, form, [aria-hidden="true"], .noprint',
            ).remove();

            // Get text from the body, attempt to normalize whitespace
            let html = $('body').html() || '';
            html = html.replace(/\s\s+/g, ' ').trim();

            return this.turndownService.turndown(html);
        } catch (error) {
            this.logger.error(`Error extracting text with Cheerio: ${error.message}`);
            return '';
        }
    }
}
