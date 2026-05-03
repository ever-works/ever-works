---
id: exa-plugin-deep-dive
title: 'Exa Plugin Deep Dive'
sidebar_label: 'Exa Deep Dive'
sidebar_position: 60
---

# Exa Plugin Deep Dive

## Overview

The Exa plugin provides AI-native search and content extraction capabilities using the Exa API. Unlike traditional search engines that match keywords, Exa uses neural embeddings to find results based on semantic meaning. The plugin supports three search modes (auto, neural, keyword), category filtering, domain filtering, time range filtering, and clean text extraction from web pages. It implements both `ISearchPlugin` and `IContentExtractorPlugin`, making it a dual-purpose tool for work generation pipelines.

## Architecture

The plugin implements three interfaces: `IPlugin`, `ISearchPlugin`, and `IContentExtractorPlugin`. It uses the official `exa-js` SDK to communicate with the Exa API.

```
ExaSearchPlugin
  |-- Exa (exa-js)
       |-- Exa REST API (https://api.exa.ai)
```

A new `Exa` client is instantiated per-request from the settings-resolved API key via the `getClient(settings)` helper. This stateless approach ensures each request uses the correct credentials without shared state.

## Configuration

### Environment Variables

| Variable             | Required | Description                             |
| -------------------- | -------- | --------------------------------------- |
| `PLUGIN_EXA_API_KEY` | Yes      | Exa API key (fallback from environment) |

### Settings Schema

```typescript
interface ExaSettings {
	apiKey: string; // Exa API key (x-secret, x-envVar, user-scoped, required)
	searchType: string; // Search mode: 'auto' (default), 'neural', or 'keyword'
	maxResults: number; // Default max results per search (default: 10, range: 1-100)
	category: string; // Category filter (default: '', options: company, research paper, news, tweet, personal site, github)
}
```

- `configurationMode`: `hybrid` -- the admin can set a shared API key via environment variable, or individual users can provide their own key.
- The API key can be set either in plugin settings or via the `PLUGIN_EXA_API_KEY` environment variable.

## Capabilities

| Capability          | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `search`            | AI-native web search with neural, keyword, and auto modes |
| `content-extractor` | Extracts clean text content from web page URLs            |

## API Reference

### Search

| Method             | Signature                                             | Description                           |
| ------------------ | ----------------------------------------------------- | ------------------------------------- |
| `search`           | `(options: SearchOptions) => Promise<SearchResponse>` | Searches the web via Exa              |
| `isAvailable`      | `() => Promise<boolean>`                              | Always returns `true`                 |
| `getRateLimitInfo` | `() => Promise<RateLimitInfo>`                        | Returns `-1` (not tracked internally) |

### Content Extraction

| Method                | Signature                                                                            | Description                             |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------- | -------------- | ------------------ |
| `extract`             | `(options: ContentExtractionOptions) => Promise<ContentExtractionResult>`            | Extracts text content from a single URL |
| `extractBatch`        | `(urls: readonly string[], options?) => Promise<readonly ContentExtractionResult[]>` | Batch extracts text from multiple URLs  |
| `canExtract`          | `(url: string) => Promise<boolean>`                                                  | Returns `true` for HTTP/HTTPS URLs      |
| `getSupportedFormats` | `() => readonly ('text'                                                              | 'html'                                  | 'markdown')[]` | Returns `['text']` |

## Implementation Details

### Search Modes

Exa supports three search types, configured via the `searchType` setting:

- **`auto`** (default): Exa automatically selects the best approach for the query -- neural for conceptual queries, keyword for specific terms.
- **`neural`**: Semantic search that finds results based on meaning. Particularly useful for conceptual queries like "tools for building web works" where keyword matching would miss relevant results.
- **`keyword`**: Traditional keyword-based search for precise term matching.

The search type is passed directly to the Exa SDK as the `type` parameter.

### Category Filtering

Results can be restricted to a specific category via the `category` setting:

| Category         | Description                        |
| ---------------- | ---------------------------------- |
| `company`        | Company websites and profiles      |
| `research paper` | Academic and research publications |
| `news`           | News articles                      |
| `tweet`          | Twitter/X posts                    |
| `personal site`  | Personal websites and blogs        |
| `github`         | GitHub repositories and pages      |

An empty string (the default) applies no category filter.

### Domain Filtering

The `search` method supports domain inclusion and exclusion lists from `SearchOptions`:

- `includeDomains`: Only return results from these domains.
- `excludeDomains`: Never return results from these domains.

Both are passed as arrays to the Exa SDK.

### Time Range Filtering

Time ranges are converted from human-readable values to ISO 8601 `startPublishedDate` values:

```typescript
const TIME_RANGE_DAYS: Record<string, number> = {
	day: 1, // past 24 hours
	week: 7, // past 7 days
	month: 30, // past 30 days
	year: 365 // past 365 days
};
```

The start date is calculated as `Date.now() - days * 24 * 60 * 60 * 1000` and sent as an ISO timestamp. The special value `'all'` disables time filtering.

### Search Result Mapping

Each Exa result is mapped to a `SearchResult` with:

- `title` -- from the result's title field
- `url` -- the result URL
- `publishedDate` -- from the `publishedDate` field
- `source` -- from the `author` field
- `faviconUrl` -- from the `favicon` field
- `position` -- 1-based index

Note: Unlike some search plugins, the Exa plugin does not extract a `snippet` from search results. The search response always sets `hasMore: false` since Exa does not provide pagination metadata.

### Content Extraction

The `extract` method uses Exa's `getContents` API to fetch clean text from a URL:

```typescript
const response = await client.getContents([url], { text: true, livecrawl: 'fallback' });
```

Key behaviors:

- `text: true` requests plain text extraction.
- `livecrawl: 'fallback'` uses live page crawling as a fallback if the cached version is unavailable.
- `wordCount` is calculated by splitting the extracted text on whitespace.
- If `result.url` differs from the requested URL, the response includes `finalUrl` to indicate a redirect.

### Batch Extraction

`extractBatch` sends all URLs in a single `getContents` call for efficiency:

```typescript
const response = await client.getContents([...urls], { text: true, livecrawl: 'fallback' });
```

If the batch call fails entirely, all URLs are returned as failed results with the error message. This differs from Firecrawl's approach of falling back to sequential extraction -- Exa's batch either succeeds or fails as a unit.

### Per-Request Client

A new `Exa` client is created for each operation via the `getClient(settings)` helper. This avoids holding a long-lived reference and ensures the latest API key from resolved settings is always used.

## Usage Examples

```typescript
// Basic search
const results = await exaPlugin.search({
	query: 'open source work builders',
	limit: 10,
	settings: { apiKey: exaApiKey }
});

// Neural search with category filter
const companyResults = await exaPlugin.search({
	query: 'AI startups building developer tools',
	limit: 20,
	settings: {
		apiKey: exaApiKey,
		searchType: 'neural',
		category: 'company'
	}
});

// Search with domain and time filters
const filteredResults = await exaPlugin.search({
	query: 'work software',
	limit: 15,
	includeDomains: ['github.com', 'producthunt.com'],
	timeRange: 'month',
	settings: { apiKey: exaApiKey }
});

// Extract content from a single URL
const content = await exaPlugin.extract({
	url: 'https://example.com/article',
	settings: { apiKey: exaApiKey }
});
if (content.success) {
	console.log(content.content); // Clean text
	console.log(content.wordCount); // Word count
}

// Batch extract multiple URLs
const batchResults = await exaPlugin.extractBatch(['https://example.com/page1', 'https://example.com/page2'], {
	settings: { apiKey: exaApiKey }
});
```

## Rate Limiting & Quotas

- **Exa API plans**: Rate limits and monthly quotas depend on the Exa subscription tier. The free tier provides limited search credits per month.
- **Max results per request**: Configurable up to 100 via the `maxResults` setting.
- **No pagination**: The plugin does not support paginated search results. Each search returns a single page of results.
- `getRateLimitInfo` returns `-1` for both `remaining` and `limit`, indicating the plugin does not track rate limits internally. Exa API errors (e.g., 429) propagate directly.

## Error Handling

- **Missing API key**: Throws a descriptive error: `'Exa API key not configured. Set it in plugin settings or via PLUGIN_EXA_API_KEY environment variable.'`
- **Search failures**: Logged via `context.logger.error` and re-thrown to the caller. Search errors always propagate to signal the issue to the pipeline.
- **Single extraction failures**: Returned as `{ success: false, error: '...' }` rather than throwing, allowing callers to handle failures gracefully.
- **Batch extraction failures**: If the `getContents` call fails, all URLs are returned as `{ success: false, error: '...' }` entries. There is no fallback to sequential extraction.
- **Empty content**: If `getContents` returns no results for a URL, the extraction is marked as unsuccessful with the error `'No content extracted'`.

## Related Plugins

- [Firecrawl Plugin Deep Dive](./firecrawl-plugin-deep-dive) -- alternative search and content extraction with JavaScript rendering support.
- [Brave Plugin Deep Dive](./brave-plugin-deep-dive) -- privacy-focused keyword search provider.
- [Exa Plugin](./exa-search-plugin) -- overview documentation for the Exa plugin.
