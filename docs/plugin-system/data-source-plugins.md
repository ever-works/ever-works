---
id: data-source-plugins
title: Data Source Plugins
sidebar_label: Data Sources
sidebar_position: 12
---

# Data Source Plugins

Data source plugins import pre-existing items from external APIs and data services into a directory. Unlike search plugins (which discover items from web results), data source plugins pull structured data from specific platforms and transform it into the `ItemData` format used by the Ever Works platform.

## IDataSourcePlugin Interface

```typescript
interface IDataSourcePlugin extends IPlugin {
  readonly sourceName: string;

  query(options?: DataSourceQueryOptions): Promise<DataSourceQueryResult>;
  isAvailable(): Promise<boolean>;

  // Optional
  getItem?(id: string): Promise<ItemData | null>;
  sync?(): Promise<DataSourceSyncResult>;
  getMetadata?(): Promise<DataSourceMetadata>;
  validateConnection?(): Promise<boolean>;
  getSupportedFilters?(): readonly string[];
}
```

## Query Options

```typescript
interface DataSourceQueryOptions {
  query?: string;                   // Search query within the data source
  limit?: number;                   // Number of items to return
  offset?: number;                  // Pagination offset
  category?: string;                // Category filter
  tags?: string[];                  // Tag filters
  sortBy?: string;                  // Sort field
  sortOrder?: 'asc' | 'desc';
  filters?: Record<string, unknown>;  // Custom provider-specific filters
  settings?: PluginSettings;        // Resolved plugin settings (API keys, etc.)
  filterContext?: DataSourceFilterContext;  // Relevance filtering context
}
```

### Filter Context

Data source plugins receive a `DataSourceFilterContext` that helps them return only items relevant to the directory being generated:

```typescript
interface DataSourceFilterContext {
  prompt?: string;      // Directory description/prompt
  subject?: string;     // Directory subject/topic
  keywords?: string[];  // Keywords extracted from prompt
}
```

Plugins should use this context to filter their results, ensuring that only relevant items are returned for the directory's domain.

## Query Result

```typescript
interface DataSourceQueryResult {
  items: ItemData[];           // Items in the standard platform format
  total?: number;              // Total available items
  hasMore: boolean;            // Whether pagination has more results
  categories?: Category[];     // Categories from the data source
  tags?: Tag[];                // Tags from the data source
  brands?: Brand[];            // Brands from the data source
}
```

Data sources return items alongside any taxonomy data (categories, tags, brands) that can be used to organize the imported items in the directory.

## Available Plugins

### Apify

| Property | Value |
|---|---|
| Package | `@ever-works/apify-plugin` |
| Category | `data-source` |
| Capabilities | `data-source` |
| Dependencies | `stopword` |
| Configuration Mode | `hybrid` |

Apify is a web scraping and automation platform with a marketplace of pre-built "Actors" (scraping templates). The Apify plugin imports items from Apify datasets into Ever Works directories.

**How it works:**
1. Users configure an Apify dataset ID or Actor run ID
2. The plugin fetches results from the Apify dataset API
3. Items are transformed from the Apify format into `ItemData`
4. The `filterContext` is used to filter items by relevance using keyword matching (with stopword removal)

**Settings:**

| Setting | Type | Description |
|---|---|---|
| `apiKey` | string (secret) | Apify API token |
| `datasetId` | string | Apify dataset ID to import from |

### Bright Data

| Property | Value |
|---|---|
| Package | `@ever-works/brightdata-plugin` |
| Category | `data-source` |
| Capabilities | `search`, `content-extractor` |
| SDK | `@brightdata/sdk` |
| Configuration Mode | `hybrid` |

Bright Data provides web data collection infrastructure including proxy networks, browser automation, and pre-built data collection templates. The plugin provides both search and content extraction capabilities.

**Key features:**
- Web Scraper API for structured data extraction
- Proxy network integration for reliable scraping
- SERP API for search engine results
- Pre-built collectors for common data sources

**Settings:**

| Setting | Type | Description |
|---|---|---|
| `apiKey` | string (secret) | Bright Data API token |
| `zone` | string | Proxy zone for requests |

### Scrapfly

| Property | Value |
|---|---|
| Package | `@ever-works/scrapfly-plugin` |
| Category | `data-source` |
| Capabilities | `screenshot`, `content-extractor` |
| SDK | `scrapfly-sdk` |
| Configuration Mode | `hybrid` |

Scrapfly provides web scraping infrastructure with anti-bot bypass, JavaScript rendering, and screenshot capabilities. It implements both screenshot and content extraction interfaces.

**Key features:**
- Anti-bot bypass technology
- JavaScript rendering for dynamic pages
- Screenshot capture alongside extraction
- Proxy rotation and geographic targeting
- Structured data extraction with CSS/XPath selectors

**Settings:**

| Setting | Type | Description |
|---|---|---|
| `apiKey` | string (secret) | Scrapfly API key |

### Valyu

| Property | Value |
|---|---|
| Package | `@ever-works/valyu-plugin` |
| Category | `data-source` |
| Capabilities | `search`, `content-extractor` |
| SDK | `valyu-js` |
| Configuration Mode | `hybrid` |

Valyu provides web search and content extraction through its unified API, offering both data discovery and retrieval capabilities.

**Settings:**

| Setting | Type | Description |
|---|---|---|
| `apiKey` | string (secret) | Valyu API key |

## Data Synchronization

Data source plugins can optionally implement a `sync()` method for periodic data synchronization:

```typescript
interface DataSourceSyncResult {
  status: 'idle' | 'syncing' | 'completed' | 'failed';
  itemsAdded: number;
  itemsUpdated: number;
  itemsRemoved: number;
  duration: number;       // Sync duration in ms
  error?: string;
  syncedAt: string;       // ISO timestamp
}
```

This allows directories to be kept up-to-date with their external data sources through scheduled sync operations.

## Data Source Metadata

Plugins can expose metadata about their data source:

```typescript
interface DataSourceMetadata {
  name: string;
  description?: string;
  totalItems?: number;        // How many items are available
  categories?: string[];
  tags?: string[];
  lastUpdated?: string;
  sourceUrl?: string;
}
```

This metadata is used by the platform to display information about the data source in the UI and help users understand what data is available.

## How Data Sources Integrate with the Pipeline

Data source plugins are consumed by the pipeline during the data aggregation phase:

1. The pipeline identifies configured data source plugins for the directory
2. It calls `query()` with the directory's prompt/subject as filter context
3. Returned items are merged with items discovered through search
4. Deduplication logic ensures no duplicate items across search results and data sources
5. The combined items proceed through the rest of the pipeline (category processing, badge processing, etc.)

## Creating a Custom Data Source Plugin

To create a data source plugin for a new external service:

```typescript
import type { IDataSourcePlugin, DataSourceQueryOptions, DataSourceQueryResult } from '@ever-works/plugin';
import { BasePlugin } from '@ever-works/plugin/abstract';

export class MyDataSourcePlugin extends BasePlugin implements IDataSourcePlugin {
  readonly id = 'my-data-source';
  readonly name = 'My Data Source';
  readonly version = '1.0.0';
  readonly category = 'data-source' as const;
  readonly capabilities = ['data-source'] as const;
  readonly sourceName = 'my-source';

  async query(options?: DataSourceQueryOptions): Promise<DataSourceQueryResult> {
    const apiKey = options?.settings?.apiKey as string;
    // Fetch data from your external API
    // Transform into ItemData format
    // Apply filterContext for relevance
    return { items: [], hasMore: false };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
```

The key responsibility is transforming external data into the standard `ItemData` format, including fields like `name`, `description`, `url`, `logo`, `features`, `pricing`, and `tags`.
