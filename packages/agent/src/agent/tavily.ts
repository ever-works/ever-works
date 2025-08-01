import { Logger } from '@nestjs/common';
import { config } from '@src/config';
import { tavily } from '@tavily/core';

interface SearchResults {
    url: string;
    score: number;
}

export async function searchWeb(query: string) {
    Logger.log(`Searching the web with query "${query}"`, 'Agent');
    const tvly = tavily({ apiKey: config.tavily.getApiKey() });
    const searches = await tvly.search(query, {});

    return searches.results.map((result) => ({ url: result.url, score: result.score }));
}

export function aggregateSearchResults(results: SearchResults[], max = 10) {
    const urls = results.sort((a, b) => b.score - a.score).map((r) => r.url);

    return Array.from(new Set(urls)).slice(0, max); // deduplicate
}

export async function extractContent(urls: string[]) {
    Logger.log('Extracting URLs', 'Agent');
    const tvly = tavily({ apiKey: config.tavily.getApiKey() });
    const contents = await tvly.extract(urls, {});

    return contents.results;
}

export async function extractContentFrom(url: string) {
    Logger.log(`Extracting content from ${url}`, 'Agent');
    const tvly = tavily({ apiKey: config.tavily.getApiKey() });
    const contents = await tvly.extract([url], {});

    return contents.results[0];
}
