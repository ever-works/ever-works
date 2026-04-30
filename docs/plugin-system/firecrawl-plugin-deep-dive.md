---
id: firecrawl-plugin-deep-dive
title: "Firecrawl Plugin Deep Dive"
sidebar_label: "Firecrawl Deep Dive"
sidebar_position: 55
---

# Firecrawl Plugin Deep Dive

## Overview

The Firecrawl plugin provides web search and content extraction capabilities using the Firecrawl API. It can search the web for structured results and scrape any web page into clean markdown, handling JavaScript rendering and anti-bot protections automatically. The plugin implements both `ISearchPlugin` and `IContentExtractorPlugin`, making it a dual-purpose tool for directory generation pipelines.

## Architecture

The plugin implements three interfaces: `IPlugin`, `ISearchPlugin`, and `IContentExtractorPlugin`. It uses the official `@mendable/firecrawl-js` SDK to communicate with the Firecrawl API.

```
FirecrawlPlugin
  |-- FirecrawlApp (@mendable/firecrawl-js)
       |-- Firecrawl REST API
```

A new `FirecrawlApp` client is instantiated per-request from the settings-resolved API key. This stateless approach ensures each request uses the correct credentials without shared state.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PLUGIN_FIRECRAWL_API_KEY` | Yes | Firecrawl API key (fallback from environment) |

### Settings Schema

```typescript
interface FirecrawlSettings {
  apiKey: string;  // Firecrawl API key (x-secret, x-envVar, user-scoped, required)
}
```

- `configurationMode`: `hybrid` -- the admin can set a shared API key via environment variable, or individual users can provide their own key.
- The API key can be set either in plugin settings or via the `PLUGIN_FIRECRAWL_API_KEY` environment variable.

## Capabilities

| Capability | Description |
|------------|-------------|
| `search` | Web search returning structured results with titles, URLs, and snippets |
| `content-extractor` | Scrapes web pages into clean markdown with metadata |

## API Reference

### Search

| Method | Signature | Description |
|--------|-----------|-------------|
| `search` | `(options: SearchOptions) => Promise<SearchResponse>` | Searches the web via Firecrawl |
| `getRateLimitInfo` | `() => Promise<RateLimitInfo>` | Returns rate limit info (currently returns -1 for unknown) |

### Content Extraction

| Method | Signature | Description |
|--------|-----------|-------------|
| `extract` | `(options: ContentExtractionOptions) => Promise<ContentExtractionResult>` | Scrapes a single URL to markdown |
| `extractBatch` | `(urls: readonly string[], options?) => Promise<readonly ContentExtractionResult[]>` | Batch scrapes multiple URLs |
| `canExtract` | `(url: string) => Promise<boolean>` | Returns `true` for HTTP/HTTPS URLs |
| `getSupportedFormats` | `() => readonly ('text' \| 'html' \| 'markdown')[]` | Returns `['markdown']` |
| `isAvailable` | `() => Promise<boolean>` | Always returns `true` (availability checked at API call time) |

## Implementation Details

### Search Response Mapping

The `search` method calls `client.search(query, { limit })` and maps the response's `web` array to `SearchResult` objects. Each result includes:

- `title` -- from the search result's title field
- `url` -- the result URL
- `snippet` -- derived from `description` or `markdown` content
- `position` -- 1-based index
- `source` -- hostname extracted from the URL

### Single URL Extraction

The `extract` method calls `client.scrape(url, { formats: ['markdown'] })` and returns:

- `content` and `markdown` -- the extracted markdown text
- `title` -- from `doc.metadata.title`
- `finalUrl` -- if the page redirected to a different URL
- `wordCount` -- calculated by splitting on whitespace
- `readingTime` -- estimated at 200 words per minute

If the scrape returns empty markdown, the method returns `success: false` with an appropriate error message.

### Batch Extraction

`extractBatch` first attempts the Firecrawl batch API (`client.batchScrape`) for efficiency. If the batch API fails or returns empty results, it falls back to sequential extraction using `Promise.allSettled` to ensure partial failures don't block successful extractions.

```
Attempt batch API (client.batchScrape)
  |-- Success: map batch results
  |-- Failure: fall back to sequential
       |-- Promise.allSettled(urls.map(extract))
```

### Per-Request Client

A new `FirecrawlApp` instance is created for each operation via the `getClient(settings)` helper. This avoids holding a long-lived reference and ensures the latest API key from resolved settings is always used.

## Usage Examples

```typescript
// Search the web
const searchResults = await firecrawlPlugin.search({
  query: 'best project management tools 2025',
  limit: 10,
  settings: { apiKey: firecrawlApiKey }
});

// Extract content from a single URL
const content = await firecrawlPlugin.extract({
  url: 'https://example.com/article',
  settings: { apiKey: firecrawlApiKey }
});
if (content.success) {
  console.log(content.markdown);
}

// Batch extract multiple URLs
const results = await firecrawlPlugin.extractBatch(
  ['https://example.com/page1', 'https://example.com/page2'],
  { settings: { apiKey: firecrawlApiKey } }
);
```

## Rate Limiting & Quotas

- **Firecrawl plans**: Rate limits depend on the Firecrawl subscription tier. The free tier provides limited scrape credits per month; paid tiers offer higher concurrency and credit pools.
- **Batch scraping**: The batch API is more efficient for multiple URLs as it processes them concurrently on Firecrawl's infrastructure.
- `getRateLimitInfo` currently returns `-1` for both `remaining` and `limit`, indicating the plugin does not track rate limits internally. Firecrawl API errors (e.g., 429) propagate directly.

## Error Handling

- **Missing API key**: Throws a descriptive error: `'Firecrawl API key not configured. Set it in plugin settings or via PLUGIN_FIRECRAWL_API_KEY environment variable.'`
- **Search failures**: Logged via `context.logger.error` and re-thrown to the caller.
- **Extraction failures**: Returned as `{ success: false, error: '...' }` rather than throwing, allowing callers to handle partial failures gracefully.
- **Batch fallback**: If `batchScrape` fails, the plugin silently falls back to sequential extraction using `Promise.allSettled`, ensuring maximum data recovery.
- **Empty content**: Explicitly checked -- if a scrape returns no markdown, the result is marked as unsuccessful.

## Related Plugins

- [Exa Plugin Deep Dive](./exa-plugin-deep-dive) -- alternative search and content extraction provider with neural search.
- [Brave Plugin Deep Dive](./brave-plugin-deep-dive) -- alternative privacy-focused search provider.
- [Firecrawl Plugin](./firecrawl-plugin) -- overview documentation for the Firecrawl plugin.
