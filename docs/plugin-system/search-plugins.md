---
id: search-plugins
title: Search Provider Plugins
sidebar_label: Search Providers
sidebar_position: 9
---

# Search Provider Plugins

Search plugins enable the platform to discover items during directory generation. They implement the `ISearchPlugin` interface and provide a unified way to query multiple search engines with consistent parameters and result formatting.

## ISearchPlugin Interface

Every search plugin must implement these core methods:

```typescript
interface ISearchPlugin extends IPlugin {
  readonly providerName: string;

  search(options: SearchOptions): Promise<SearchResponse>;
  isAvailable(): Promise<boolean>;

  // Optional
  getRateLimitInfo?(): Promise<RateLimitInfo>;
  getSupportedRegions?(): readonly string[];
  getSupportedLanguages?(): readonly string[];
}
```

## Search Options

All search plugins accept the same `SearchOptions` interface, ensuring consistent behavior regardless of the underlying provider:

```typescript
interface SearchOptions {
  query: string;              // Search query string
  limit?: number;             // Number of results (default varies by plugin)
  page?: number;              // Pagination
  language?: string;          // Language/locale filter
  region?: string;            // Country/region for results
  safeSearch?: 'off' | 'moderate' | 'strict';
  timeRange?: 'day' | 'week' | 'month' | 'year' | 'all';
  site?: string;              // Restrict to a specific site
  fileType?: string;          // File type filter
  excludeDomains?: string[];  // Domains to exclude
  includeDomains?: string[];  // Domains to include
  settings?: PluginSettings;  // Resolved plugin settings (API keys, etc.)
}
```

## Search Response

Results follow a standardized format:

```typescript
interface SearchResponse {
  results: SearchResult[];     // Array of results
  totalResults?: number;       // Estimated total
  query: string;               // Original query
  duration?: number;           // Search duration in ms
  nextPage?: number | string;  // Pagination token
  hasMore: boolean;            // Whether more results exist
  relatedSearches?: string[];  // Related query suggestions
}

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  displayUrl?: string;
  faviconUrl?: string;
  publishedDate?: string;
  position: number;
  source?: string;
  metadata?: Record<string, unknown>;
}
```

## Available Search Plugins

### Exa

| Property | Value |
|---|---|
| Package | `@ever-works/exa-plugin` |
| Capabilities | `search`, `content-extractor` |
| SDK | `exa-js` |
| Configuration Mode | `hybrid` |

Exa is an AI-native search engine offering three search modes:

- **auto** (default) -- lets Exa choose the optimal strategy per query
- **neural** -- semantic search that understands meaning, not just keywords
- **keyword** -- traditional keyword matching

**Unique features:**
- Category filtering: restrict results to `company`, `research paper`, `news`, `tweet`, `personal site`, or `github`
- Domain inclusion/exclusion lists
- Time range filtering via `startPublishedDate`
- Also implements `IContentExtractorPlugin` for pulling clean text from URLs via `getContents()`

**Settings:**

| Setting | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string (secret) | -- | Exa API key |
| `searchType` | enum | `auto` | Search mode: auto, neural, keyword |
| `maxResults` | number | `10` | Default result count per query |
| `category` | enum | `""` | Optional category filter |

### Tavily

| Property | Value |
|---|---|
| Package | `@ever-works/tavily-plugin` |
| Capabilities | `search`, `content-extractor` |
| SDK | `@tavily/core` |
| Configuration Mode | `hybrid` |

Tavily is a search API built specifically for AI agents and RAG applications. It returns clean, relevant results optimized for LLM consumption.

**Unique features:**
- Search depth control (`basic` or `advanced`)
- Built-in content extraction alongside search results
- Domain include/exclude filtering
- Optimized for AI-agent workflows

**Settings:**

| Setting | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string (secret) | -- | Tavily API key |
| `searchDepth` | enum | `basic` | Search depth: basic or advanced |
| `maxResults` | number | `10` | Default result count |

### SerpAPI

| Property | Value |
|---|---|
| Package | `@ever-works/serpapi-plugin` |
| Capabilities | `search` |
| SDK | Direct HTTP API |
| Configuration Mode | `hybrid` |

SerpAPI provides access to multiple search engines (Google, Bing, Yahoo, and more) through a unified API. It returns structured data extracted from real search engine result pages.

**Unique features:**
- Multi-engine support (Google, Bing, Yahoo, Baidu, etc.)
- Rich snippet data (knowledge graph, local results, shopping)
- Geographic targeting with `gl` (country) and `hl` (language) parameters

**Settings:**

| Setting | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string (secret) | -- | SerpAPI key |
| `engine` | string | `google` | Search engine to use |

### Brave

| Property | Value |
|---|---|
| Package | `@ever-works/brave-plugin` |
| Capabilities | `search` |
| SDK | Direct HTTP API |
| Configuration Mode | `hybrid` |

Brave Search is a privacy-focused search engine with its own independent index (not proxied from other engines).

**Unique features:**
- Independent search index (not based on Google/Bing)
- Privacy-first approach with no user tracking
- Goggles for custom re-ranking of results

**Settings:**

| Setting | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string (secret) | -- | Brave Search API key |
| `maxResults` | number | `10` | Default result count |

## Provider Comparison

| Feature | Exa | Tavily | SerpAPI | Brave |
|---|:---:|:---:|:---:|:---:|
| Neural/semantic search | Yes | No | No | No |
| Content extraction | Yes | Yes | No | No |
| Category filtering | Yes | No | No | No |
| Multi-engine support | No | No | Yes | No |
| Privacy focus | No | No | No | Yes |
| Domain filtering | Yes | Yes | Limited | Limited |
| Time range filtering | Yes | Yes | Yes | Yes |
| AI-optimized results | Yes | Yes | No | No |
| Free tier | Limited | Yes | Yes | Yes |

## How Search Plugins Are Used

During directory generation, the active search plugin is invoked by the pipeline's Web Search step:

1. The **Search Query Generation** step produces optimized queries based on the directory prompt
2. The **Web Search** step calls `search()` on the active search plugin for each query
3. Results are passed to the **Content Retrieval** step for full-page extraction
4. The **Item Extraction** step processes the extracted content into directory items

The search plugin is selected per-directory in the generator form. If no search plugin is explicitly selected, the platform uses the default provider (determined by `defaultForCapabilities` in the manifest or the first configured provider).

## Rate Limiting

Search plugins can optionally report rate limit information:

```typescript
interface RateLimitInfo {
  remaining: number;    // Requests remaining
  limit: number;        // Total limit
  resetsAt?: number;    // Unix timestamp for reset
  period?: string;      // Limit period (e.g., 'day', 'month')
}
```

The platform uses this information to pace requests and avoid hitting provider limits during large generation runs.
