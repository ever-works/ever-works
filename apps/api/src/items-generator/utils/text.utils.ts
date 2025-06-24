import * as cheerio from 'cheerio';
import * as TurndownService from 'turndown';
import { Logger } from '@nestjs/common';
import axios from 'axios';

const logger = new Logger('TextUtils');
const turndownService = new TurndownService();

export async function extractTextFromSourceURL(source_url: string): Promise<string> {
    const response = await axios.get(source_url, {
        headers: {
            'User-Agent': `ItemsGeneratorBuilder/ever-works (Node.js/Axios; +https://github.com/ever-works)`,
        },
        timeout: 15000, // 15-second timeout
        validateStatus: (status) => status >= 200 && status < 400, // Only consider 2xx and 3xx as success
    });

    if (
        response.headers['content-type'] &&
        !response.headers['content-type'].includes('text/html') &&
        !response.headers['content-type'].includes('text/plain')
    ) {
        logger.warn(
            `[extractTextFromSourceURL] Skipping non-HTML/text content at ${source_url} (Content-Type: ${response.headers['content-type']})`,
        );
        return '';
    }

    return extractTextFromHtml(response.data);
}

function extractTextFromHtml(htmlContent: string): string {
    try {
        const $ = cheerio.load(htmlContent);
        // Remove script and style elements
        $(
            'script, style, noscript, iframe, header, footer, nav, aside, form, [aria-hidden="true"], .noprint',
        ).remove();
        // Get text from the body, attempt to normalize whitespace
        let html = $('body').html() || '';
        html = html.replace(/\s\s+/g, ' ').trim();

        return turndownService.turndown(html);
    } catch (error) {
        logger.error(`Error extracting text with Cheerio: ${error.message}`);
        return ''; // Return empty string on error
    }
}

export function slugifyText(text: string): string {
    return text
        .toString()
        .normalize('NFKD') // Normalize accented characters
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-');
}
