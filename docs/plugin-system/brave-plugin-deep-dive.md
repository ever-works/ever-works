---
id: brave-plugin-deep-dive
title: 'Brave Search Plugin Deep Dive'
sidebar_label: 'Brave Search Deep Dive'
sidebar_position: 56
---

# Brave Search Plugin Deep Dive

## Overview

The Brave Search plugin provides privacy-focused web search capabilities using the Brave Search API. Unlike search engines that rely on third-party indexes, Brave maintains its own independent web index. The plugin uses plain `fetch()` calls against the Brave REST API, requiring no SDK dependency. It supports pagination, regional filtering, language selection, safe search, and time-range filtering.

## Architecture

The plugin implements two interfaces: `IPlugin` and `ISearchPlugin`. It communicates directly with the Brave Search REST API using the global `fetch()` function, making it one of the lightest plugins in the system with zero external SDK dependencies.

```
BraveSearchPlugin
  |-- fetch() (built-in)
       |-- Brave Search REST API (https://api.search.brave.com)
```

No persistent client or SDK instance is maintained. Each search request constructs a fresh URL with query parameters and sends it with the API key in the `X-Subscription-Token` header.

## Configuration

### Environment Variables

| Variable               | Required | Description                         |
| ---------------------- | -------- | ----------------------------------- |
| `PLUGIN_BRAVE_API_KEY` | Yes      | Brave Search API subscription token |

### Settings Schema

```typescript
interface BraveSearchSettings {
	apiKey: string; // Brave Search API key (x-secret, x-envVar, user-scoped, required)
	maxResults: number; // Default max results per search (default: 10, max: 20)
}
```

- `configurationMode`: `hybrid` -- the admin can set a shared API key via environment variable, or individual users can provide their own.
- `maxResults` is capped at the Brave API maximum of 20 results per request.

## Capabilities

| Capability | Description                                              |
| ---------- | -------------------------------------------------------- |
| `search`   | Privacy-focused web search with filtering and pagination |

## API Reference

### Search

| Method             | Signature                                             | Description                           |
| ------------------ | ----------------------------------------------------- | ------------------------------------- |
| `search`           | `(options: SearchOptions) => Promise<SearchResponse>` | Searches the web via Brave Search     |
| `isAvailable`      | `() => Promise<boolean>`                              | Always returns `true`                 |
| `getRateLimitInfo` | `() => Promise<RateLimitInfo>`                        | Returns `-1` (not tracked internally) |

### SearchOptions Support

| Option       | Brave API Parameter | Description                                                    |
| ------------ | ------------------- | -------------------------------------------------------------- |
| `query`      | `q`                 | Search query string                                            |
| `limit`      | `count`             | Results per page (max 20)                                      |
| `page`       | `offset`            | Pagination (max 9 pages)                                       |
| `region`     | `country`           | Country code filter                                            |
| `language`   | `search_lang`       | Language filter                                                |
| `safeSearch` | `safesearch`        | `off`, `moderate`, or `strict`                                 |
| `timeRange`  | `freshness`         | `day` -> `pd`, `week` -> `pw`, `month` -> `pm`, `year` -> `py` |

## Implementation Details

### Request Construction

Each search builds a `URLSearchParams` object with the query, result count, and optional filters. The request is sent to `https://api.search.brave.com/res/v1/web/search` with the API key passed as the `X-Subscription-Token` header.

```typescript
const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
	headers: {
		'X-Subscription-Token': apiKey,
		Accept: 'application/json'
	}
});
```

### Pagination

Pagination is 0-based offset with a maximum of 9 page offsets:

```typescript
const MAX_PAGE_OFFSET = 9;
const offset = Math.min((page - 1) * limit, MAX_PAGE_OFFSET * limit);
```

The `hasMore` flag is derived from the Brave API's `query.more_results_available` boolean, and `nextPage` is set to `page + 1` when more results are available.

### Time Range Mapping

Time ranges are mapped from human-readable values to Brave's `freshness` parameter codes:

```typescript
const FRESHNESS_MAP: Record<string, string> = {
	day: 'pd', // past day
	week: 'pw', // past week
	month: 'pm', // past month
	year: 'py' // past year
};
```

### Result Mapping

Each web result is mapped to a `SearchResult` with:

- `title` and `url` from the result
- `snippet` from the `description` field
- `faviconUrl` from the `favicon` field
- `publishedDate` from the `age` field
- `metadata` containing `language` and `familyFriendly` flags

## Usage Examples

```typescript
// Basic search
const results = await bravePlugin.search({
	query: 'open source work builders',
	limit: 10,
	settings: { apiKey: braveApiKey }
});

// Search with filters
const filteredResults = await bravePlugin.search({
	query: 'AI startups',
	limit: 15,
	region: 'US',
	language: 'en',
	safeSearch: 'moderate',
	timeRange: 'month',
	settings: { apiKey: braveApiKey }
});

// Paginated search
const page2 = await bravePlugin.search({
	query: 'AI startups',
	limit: 10,
	page: 2,
	settings: { apiKey: braveApiKey }
});
```

## Rate Limiting & Quotas

- **Free tier**: 2,000 queries per month with 1 request per second rate limit.
- **Paid tiers**: Higher monthly quotas and concurrent request allowances depending on the subscription level.
- **Max results per request**: 20 (enforced by `MAX_RESULTS_LIMIT`).
- **Max pagination depth**: 9 pages of results (`MAX_PAGE_OFFSET`).
- The plugin does not implement internal rate-limit tracking. HTTP 429 responses from Brave propagate as errors.

## Error Handling

- **Missing API key**: Throws a descriptive error: `'Brave Search API key not configured. Set it in plugin settings or via PLUGIN_BRAVE_API_KEY environment variable.'`
- **HTTP errors**: Non-OK responses are caught and re-thrown with the status code and response body text, e.g., `'Brave Search request failed (429): Rate limit exceeded'`.
- **Logging**: All search failures are logged via `context.logger.error` before re-throwing.
- **No silent failures**: Unlike content extraction plugins, search failures always throw to signal the issue to the pipeline.

## Related Plugins

- [Exa Plugin Deep Dive](./exa-plugin-deep-dive) -- AI-native search with neural and keyword modes.
- [Firecrawl Plugin Deep Dive](./firecrawl-plugin-deep-dive) -- search with integrated content extraction.
- [Brave Search Plugin](./brave-search-plugin) -- overview documentation for the Brave Search plugin.
