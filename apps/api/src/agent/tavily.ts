import { Logger } from '@nestjs/common';
import { tavily } from '@tavily/core';

interface SearchResults {
  url: string;
  score: number;
}

export async function searchWeb(query: string) {
  Logger.log(`Searching the web with query "${query}"`, 'Agent');
  const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
  const searches = await tvly.search(query, {});

  return searches.results.map((result) => ({
    url: result.url,
    score: result.score,
  }));
}

export function aggregateSearchResults(results: SearchResults[], max = 10) {
  const urls = results.sort((a, b) => b.score - a.score).map((r) => r.url);

  return Array.from(new Set(urls)).slice(0, max); // deduplicate
}

// function filterUrls and return only the URLs that doesn't return error http status code 4xx or 5xx
export async function filterUrls(urls: string[]) {
  const fetchedUrls = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(url);
        return response.ok ? url : null;
      } catch (error) {
        return null;
      }
    }),
  );

  return fetchedUrls.filter((url) => url !== null);
}

export async function extractContent(urls: string[]) {
  Logger.log('Extracting URLs', 'Agent');
  const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
  const contents = await tvly.extract(urls, {});

  return contents.results;
}

export async function extractContentFrom(url: string) {
  Logger.log(`Extracting content from ${url}`, 'Agent');
  const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
  const contents = await tvly.extract([url], {});

  return contents.results[0];
}
