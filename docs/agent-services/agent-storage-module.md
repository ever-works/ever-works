---
id: agent-storage-module
title: Storage & Content Module
sidebar_label: Storage & Content
sidebar_position: 28
---

# Storage & Content Module

## Overview

The Storage & Content module in `@ever-works/agent` provides unified facades for external content acquisition -- search, screenshots, content extraction, and data sources. These facades abstract over plugin-based providers to deliver consistent interfaces for gathering, capturing, and transforming content from the web.

Each facade follows the same `BaseFacadeService` pattern: dynamic provider resolution from the plugin registry, 4-level settings hierarchy, and capability-based plugin matching. Together they form the content acquisition layer that feeds into the generation pipeline.

## Module Structure

```
packages/agent/src/
  facades/
    search.facade.ts                # Web search facade
    screenshot.facade.ts            # Screenshot/image capture facade
    content-extractor.facade.ts     # Web page content extraction facade
    data-source.facade.ts           # External data source aggregation facade
    base.facade.ts                  # Abstract base class
    facades.module.ts               # Module registration
  facades/__tests__/
    search.facade.spec.ts
    screenshot.facade.spec.ts
    content-extractor.facade.spec.ts
    data-source.facade.spec.ts
```

Plugin implementations (in `packages/plugins/`):

```
packages/plugins/
  exa/                     # Exa search provider
  tavily/                  # Tavily search provider
  serpapi/                 # SerpAPI search provider
  brave/                   # Brave Search provider
  screenshotone/           # ScreenshotOne capture provider
  urlbox/                  # Urlbox capture provider
  local-content-extractor/ # Local content extraction
  notion-extractor/        # Notion page extraction
```

## Key Classes and Services

### `SearchFacadeService`

Extends `BaseFacadeService` and implements `ISearchFacade`. Provides web search capabilities through search provider plugins.

**Capability:** `PLUGIN_CAPABILITIES.SEARCH`

**Operations:**

- **`search(query, options, facadeOptions)`** -- execute a web search query and return structured results
- **`isConfigured()`** -- check if any search provider is available
- **`getAvailableProviders()`** -- list registered search providers

Search results include title, URL, snippet, and optionally full page content depending on the provider.

### `ScreenshotFacadeService`

Extends `BaseFacadeService` and implements `IScreenshotFacade`. Captures website screenshots through screenshot provider plugins.

**Capability:** `PLUGIN_CAPABILITIES.SCREENSHOT`

**Operations:**

- **`capture(url, options, facadeOptions)`** -- capture a screenshot of a URL. Returns image data (buffer or URL) with metadata.
- **`isConfigured()`** -- check if any screenshot provider is available
- **`getAvailableProviders()`** -- list registered screenshot providers

Screenshot options include viewport dimensions, format (PNG/JPEG), full-page capture, delay before capture, and device emulation.

### `ContentExtractorFacadeService`

Extends `BaseFacadeService` and implements `IContentExtractorFacade`. Extracts structured content from web pages and documents.

**Capability:** `PLUGIN_CAPABILITIES.CONTENT_EXTRACTION`

**Operations:**

- **`extract(url, options, facadeOptions)`** -- extract text content, metadata, and structured data from a URL
- **`isConfigured()`** -- check if any content extraction provider is available
- **`getAvailableProviders()`** -- list registered extraction providers

Extraction results typically include: title, description, main text content, author, publish date, images, and structured data (OpenGraph, JSON-LD).

### `DataSourceFacadeService`

Implements `IDataSourceFacade`. Aggregates items from external data source plugins. Unlike other facades that delegate to a single provider, the data source facade queries **all enabled data source plugins** and merges their results.

**Capability:** `PLUGIN_CAPABILITIES.DATA_SOURCE`

**Core operations:**

- **`queryAll(options)`** -- query all enabled data source plugins and aggregate results. Returns a unified `DataSourceFacadeResult` with items, categories, tags, brands, source mapping, and any errors from individual sources.
- **`getEnabledSources(directoryId, userId)`** -- list data sources enabled for a specific directory
- **`isConfigured()`** -- check if any data source plugin is available
- **`getAvailableProviders()`** -- list all registered data source providers

**Per-plugin enablement:**

Data source plugins can be enabled at the directory level. The facade checks both:
1. Request-level plugin config overrides (`pluginConfig[pluginId].enabled === true`)
2. Registry scope resolution (`isPluginEnabledForScope`)

```typescript
interface DataSourceFacadeResult {
    items: MutableItemData[];
    sourceMap: Map<string, string>;  // item slug -> plugin ID
    errors: Array<{ sourceId: string; error: string }>;
    categories?: Category[];
    tags?: Tag[];
    brands?: Brand[];
}
```

### `BaseFacadeService` (Shared Base)

All content facades inherit from `BaseFacadeService` which provides:

- **Provider resolution:** `resolvePlugin(providerOverride?, userId?, directoryId?)` -- resolves the appropriate plugin via: explicit override > directory active plugin > `defaultForCapabilities` > first enabled plugin
- **Settings resolution:** `getResolvedSettings(pluginId, options)` -- merges from Directory > User > Admin > Plugin defaults
- **Enable checking:** `isPluginEnabled(pluginId, directoryId, userId)` -- scope-aware enablement
- **Typed settings helpers:** `getSettingTyped()`, `getSettingRequired()`, `getSettingWithDefault()`

## API Reference

### SearchFacadeService

```typescript
search(
    query: string,
    options?: {
        maxResults?: number;
        includeContent?: boolean;
    },
    facadeOptions?: FacadeOptions
): Promise<SearchResult[]>

isConfigured(): boolean
getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }>
```

### ScreenshotFacadeService

```typescript
capture(
    url: string,
    options?: {
        width?: number;
        height?: number;
        format?: 'png' | 'jpeg';
        fullPage?: boolean;
        delay?: number;
    },
    facadeOptions?: FacadeOptions
): Promise<ScreenshotResult>

isConfigured(): boolean
getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }>
```

### ContentExtractorFacadeService

```typescript
extract(
    url: string,
    options?: ExtractOptions,
    facadeOptions?: FacadeOptions
): Promise<ExtractedContent>

isConfigured(): boolean
getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }>
```

### DataSourceFacadeService

```typescript
queryAll(options: DataSourceFacadeOptions): Promise<DataSourceFacadeResult>
getEnabledSources(directoryId: string, userId: string): Promise<EnabledDataSource[]>
isConfigured(): boolean
getAvailableProviders(): Array<{ id: string; name: string; sourceName: string; enabled: boolean }>
getDefaultProvider(capability: string, directoryId?: string, userId?: string): Promise<{ id: string; name: string } | null>
```

## Configuration

### Plugin Settings Pattern

All content provider plugins define their settings via JSON Schema with custom extensions:

```json
{
    "everworks.plugin": {
        "settings": {
            "apiKey": {
                "type": "string",
                "x-secret": true,
                "x-envVar": "EXA_API_KEY",
                "description": "API key for the service"
            },
            "maxResults": {
                "type": "number",
                "default": 10,
                "x-widget": "slider"
            }
        }
    }
}
```

**Custom JSON Schema extensions:**

| Extension | Purpose |
|---|---|
| `x-secret` | Marks the field as sensitive (encrypted storage, masked in UI) |
| `x-envVar` | Environment variable name for fallback value |
| `x-widget` | UI widget hint (`slider`, `toggle`, `textarea`, `select`) |

### Available Providers by Capability

| Capability | Plugins |
|---|---|
| `search` | exa, tavily, serpapi, brave |
| `screenshot` | screenshotone, urlbox |
| `content-extraction` | local-content-extractor, notion-extractor |
| `data-source` | Any plugin implementing `IDataSourcePlugin` |

## Dependencies

| Dependency | Purpose |
|---|---|
| `@ever-works/plugin` | Facade interfaces, capability constants, plugin types |
| `@ever-works/agent/plugins` | `PluginRegistryService`, `PluginSettingsService`, `DirectoryPluginRepository` |
| `@ever-works/agent/database` | `DirectoryPluginRepository` for directory-level plugin config |

## Usage Examples

### Web Search

```typescript
import { SearchFacadeService } from '@ever-works/agent/facades';

const results = await searchFacade.search(
    'best open source code editors 2025',
    { maxResults: 10, includeContent: true },
    { userId: user.id, directoryId: directory.id },
);

results.forEach((r) => {
    console.log(`${r.title}: ${r.url}`);
});
```

### Screenshot Capture

```typescript
import { ScreenshotFacadeService } from '@ever-works/agent/facades';

const screenshot = await screenshotFacade.capture(
    'https://example.com',
    { width: 1280, height: 720, format: 'png' },
    { userId: user.id },
);
```

### Content Extraction

```typescript
import { ContentExtractorFacadeService } from '@ever-works/agent/facades';

const content = await contentExtractorFacade.extract(
    'https://example.com/product',
    {},
    { userId: user.id },
);

console.log(content.title);
console.log(content.mainText);
```

### Data Source Aggregation

```typescript
import { DataSourceFacadeService } from '@ever-works/agent/facades';

const result = await dataSourceFacade.queryAll({
    directoryId: directory.id,
    userId: user.id,
    limit: 100,
    pluginConfig: {
        'my-data-source': { enabled: true },
    },
});

console.log(`Collected ${result.items.length} items from data sources`);
result.errors.forEach((e) => {
    console.warn(`Source ${e.sourceId} failed: ${e.error}`);
});
```
