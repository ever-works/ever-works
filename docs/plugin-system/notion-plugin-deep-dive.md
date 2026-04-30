---
id: notion-plugin-deep-dive
title: 'Notion Extractor Plugin Deep Dive'
sidebar_label: 'Notion Extractor Deep Dive'
sidebar_position: 57
---

# Notion Extractor Plugin Deep Dive

## Overview

The Notion Extractor plugin extracts content from Notion pages and converts it to clean markdown for use as source material during directory generation. It supports both public pages (via the free Splitbee API) and private pages (via the official Notion API with an integration key). The plugin is additive -- it only handles Notion URLs (`notion.so`, `notion.site`) and delegates all other URLs to the default content extractor.

## Architecture

The plugin implements two interfaces: `IPlugin` and `IContentExtractorPlugin`. It delegates Notion-specific logic to a dedicated service:

- **`NotionService`** -- handles page ID extraction from URLs, content fetching via two API backends, and block-to-markdown conversion.

```
NotionExtractorPlugin
  |-- NotionService
       |-- Splitbee API (https://notion-api.splitbee.io)  [public pages]
       |-- Official Notion API (https://api.notion.com)   [private pages]
```

The plugin is **not** a system plugin and must be explicitly enabled by the user. It is marked as `supplementary: true`, meaning it augments rather than replaces the default content extractor. The `canExtract` method is the key routing mechanism: it returns `true` only for Notion URLs, allowing non-Notion URLs to fall through to other extractors.

## Configuration

### Environment Variables

| Variable | Required | Description                       |
| -------- | -------- | --------------------------------- |
| N/A      | --       | No environment-variable fallbacks |

### Settings Schema

```typescript
interface NotionExtractorSettings {
	apiKey?: string; // Notion integration API key (optional, x-secret, user-scoped)
	useSplitbeeForPublicPages: boolean; // Use Splitbee API for public pages (default: true)
	timeout: number; // HTTP request timeout in ms (default: 30000, range: 5000-120000)
}
```

- `configurationMode`: defaults to standard plugin settings resolution.
- `apiKey` is optional -- public pages can be extracted without any key.
- The 4-level settings hierarchy applies: directory > user > admin > environment.

## Capabilities

| Capability          | Description                              |
| ------------------- | ---------------------------------------- |
| `content-extractor` | Extracts Notion page content as markdown |

Supported output formats: `text` and `markdown`.

## API Reference

### Content Extraction

| Method                | Signature                                                                            | Description                                           |
| --------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `canExtract`          | `(url: string) => Promise<boolean>`                                                  | Returns `true` for `notion.so` and `notion.site` URLs |
| `extract`             | `(options: ContentExtractionOptions) => Promise<ContentExtractionResult>`            | Extracts a single Notion page                         |
| `extractBatch`        | `(urls: readonly string[], options?) => Promise<readonly ContentExtractionResult[]>` | Sequentially extracts multiple Notion pages           |
| `isAvailable`         | `() => Promise<boolean>`                                                             | Always returns `true`                                 |
| `getSupportedFormats` | `() => readonly ('text' \| 'html' \| 'markdown')[]`                                  | Returns `['text', 'markdown']`                        |

## Implementation Details

### URL Detection

The `canExtract` method uses a regex to match Notion URLs:

```typescript
/^([\w-]+\.)?notion\.(so|site)$/.test(parsed.hostname);
```

This matches `notion.so`, `notion.site`, `www.notion.so`, and any subdomain like `myworkspace.notion.site`.

### Page ID Extraction

`NotionService.extractNotionPageId(url)` parses Notion URLs in multiple formats:

- Standard 32-character hex IDs (e.g., `notion.so/Page-Title-abc123def456...`)
- UUIDs with dashes (e.g., `12345678-1234-1234-1234-123456789012`)
- IDs embedded in complex URL paths with query parameters

The extracted ID is normalized to UUID format with dashes for API compatibility.

### Dual API Strategy

The extraction flow depends on configuration:

1. **Splitbee API (default for public pages)**: Calls `https://notion-api.splitbee.io/v1/page/{pageId}` which returns the full block tree as JSON. The `NotionService` then recursively converts blocks to markdown.

2. **Official Notion API (for private pages)**: When an API key is provided and `useSplitbeeForPublicPages` is `false`, the plugin uses `https://api.notion.com/v1/pages/{pageId}` for page metadata and `https://api.notion.com/v1/blocks/{blockId}/children` for block content. Blocks are fetched recursively up to 10 levels deep with cursor-based pagination.

3. **Fallback**: If the official API fails, the plugin falls back to the Splitbee API for public pages.

### Block-to-Markdown Conversion

The `NotionService` converts Notion blocks to markdown, supporting:

- Headings (`header`, `sub_header`, `sub_sub_header` / `heading_1`, `heading_2`, `heading_3`)
- Paragraphs and text with rich formatting (bold, italic, strikethrough, code, links)
- Bulleted and numbered lists with nesting
- To-do items with checkboxes
- Code blocks with language detection
- Quotes and callouts
- Images, videos, embeds, and bookmarks
- Toggle blocks (converted to `<details>` elements)
- Dividers
- Collection views / databases (rendered as markdown tables)
- Equations

### Cycle Prevention

Both the Splitbee and official API extraction paths maintain a `processingHistory` set of already-visited block/page IDs to prevent infinite recursion in pages with circular references.

### Batch Extraction

`extractBatch` processes URLs sequentially (not in parallel) with a 200ms delay between requests to avoid rate limiting the Notion/Splitbee APIs.

## Usage Examples

```typescript
// Check if a URL is a Notion page
const isNotion = await notionPlugin.canExtract('https://notion.so/My-Page-abc123...');
// true

// Extract a public Notion page (no API key needed)
const result = await notionPlugin.extract({
	url: 'https://myworkspace.notion.site/My-Public-Page-abc123...',
	settings: {}
});
if (result.success) {
	console.log(result.title); // Extracted page title
	console.log(result.markdown); // Full page as markdown
}

// Extract a private Notion page
const privateResult = await notionPlugin.extract({
	url: 'https://notion.so/Private-Page-abc123...',
	settings: {
		apiKey: 'ntn_...',
		useSplitbeeForPublicPages: false
	}
});

// Batch extract multiple Notion pages
const results = await notionPlugin.extractBatch(['https://notion.so/Page-1-...', 'https://notion.so/Page-2-...'], {
	settings: { apiKey: 'ntn_...' }
});
```

## Rate Limiting & Quotas

- **Splitbee API**: No documented rate limits, but a 200ms delay between batch requests is applied as a courtesy.
- **Official Notion API**: 3 requests per second per integration. The plugin respects this by processing batch extractions sequentially.
- **Recursive depth**: Block fetching is limited to 10 levels deep to prevent excessive API calls on deeply nested pages.
- **Pagination**: The official API uses cursor-based pagination, fetching all children blocks per parent.

## Error Handling

- **Not a Notion URL**: Returns `{ success: false, error: 'Not a Notion URL...' }` if the URL does not match Notion domains.
- **Invalid page ID**: Returns `{ success: false, error: 'Could not extract Notion page ID from URL' }`.
- **Service not initialized**: Returns `{ success: false }` if the plugin was not properly loaded.
- **Official API failures**: Caught and logged; the plugin falls back to the Splitbee API for public pages. Specific error codes handled:
    - `401`: Invalid API key or insufficient permissions
    - `404`: Page not found or not shared with the integration
- **Empty or private pages via Splitbee**: Throws a descriptive error when no data is returned.
- All errors in `extract` are caught and returned as `{ success: false, error: message }` rather than thrown, ensuring the pipeline can continue with other sources.

## Related Plugins

- [Firecrawl Plugin Deep Dive](./firecrawl-plugin-deep-dive) -- general-purpose web content extractor.
- [Exa Plugin Deep Dive](./exa-plugin-deep-dive) -- search and content extraction with neural capabilities.
- [Notion Plugin](./notion-plugin) -- overview documentation for the Notion Extractor plugin.
