---
id: apify-plugin-deep-dive
title: 'Apify Plugin Deep Dive'
sidebar_label: 'Apify Deep Dive'
sidebar_position: 58
---

# Apify Plugin Deep Dive

## Overview

The Apify plugin imports items from Apify web scraping datasets into Ever Works works. It implements both `IDataSourcePlugin` for querying external data and `IFormSchemaProvider` for contributing form fields to the work generation UI. Users provide an Apify API token and a dataset or actor run ID, and the plugin fetches, transforms, and optionally filters the scraped items by relevance to the work topic.

## Architecture

The plugin implements three interfaces: `IPlugin`, `IDataSourcePlugin`, and `IFormSchemaProvider`. It communicates directly with the Apify REST API using the global `fetch()` function.

```
ApifyPlugin
  |-- fetch() (built-in)
  |    |-- Apify Dataset API (https://api.apify.com/v2/datasets/{id}/items)
  |    |-- Apify Actor Run API (https://api.apify.com/v2/actor-runs/{id}/dataset/items)
  |
  |-- extractKeywords (@ever-works/plugin/keywords) [for relevance filtering]
```

The plugin operates at three configuration levels:

1. **Level 1 -- API token**: Configured in Settings > Plugins (admin or user scope).
2. **Level 2 -- Enable/disable**: Toggled per-work via the `WorkPlugin` entity.
3. **Level 3 -- Dataset ID and filters**: Provided through the GeneratorForm via `IFormSchemaProvider`.

## Configuration

### Environment Variables

| Variable | Required | Description                       |
| -------- | -------- | --------------------------------- |
| N/A      | --       | No environment-variable fallbacks |

### Settings Schema

```typescript
interface ApifySettings {
	apiToken: string; // Apify API token (x-secret, user-scoped)
	defaultFieldMapping?: {
		name: string; // Apify field for item name (default: 'title')
		description: string; // Apify field for description (default: 'description')
		source_url: string; // Apify field for source URL (default: 'url')
		category: string; // Apify field for category (default: 'category')
		image_url: string; // Apify field for image URL (default: 'image')
	};
}
```

- The plugin is **not** a system plugin and must be explicitly enabled by the user.
- `defaultFieldMapping` allows administrators to customize how Apify dataset fields map to work item fields.

## Capabilities

| Capability             | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `data-source`          | Queries items from Apify datasets and actor runs    |
| `form-schema-provider` | Contributes form fields to the work generation form |

## API Reference

### Data Source

| Method        | Signature                                                              | Description                                         |
| ------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `query`       | `(options?: DataSourceQueryOptions) => Promise<DataSourceQueryResult>` | Fetches and transforms items from an Apify dataset  |
| `getMetadata` | `() => Promise<DataSourceMetadata>`                                    | Returns `{ name: 'Apify', description: '...' }`     |
| `isAvailable` | `() => Promise<boolean>`                                               | Always returns `true` (token checked at query time) |

### Form Schema Provider

| Method                | Signature                                                      | Description                                                      |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `getFormFields`       | `() => FormFieldDefinition[]`                                  | Returns 4 form fields for the GeneratorForm                      |
| `getFormGroups`       | `() => FormFieldGroup[]`                                       | Returns the "Apify" collapsible group definition                 |
| `validateFormInput`   | `(values: Record<string, unknown>) => ValidationResult`        | Validates that dataset ID or actor run ID is provided            |
| `transformFormValues` | `(values: Record<string, unknown>) => Record<string, unknown>` | Transforms flat form values to nested `apify` object             |
| `getDefaultValues`    | `() => Record<string, unknown>`                                | Returns `{ apify_maxItems: 100, apify_filterByRelevance: true }` |

### Form Fields

| Field Name                | Type    | Default | Description                              |
| ------------------------- | ------- | ------- | ---------------------------------------- |
| `apify_datasetId`         | text    | --      | Apify dataset ID to import from          |
| `apify_actorRunId`        | text    | --      | Actor run ID (alternative to dataset ID) |
| `apify_maxItems`          | number  | 100     | Maximum items to import (0-10000)        |
| `apify_filterByRelevance` | boolean | true    | Filter items by work topic relevance     |

## Implementation Details

### Data Fetching

The `query` method constructs the Apify REST API URL based on whether a `datasetId` or `actorRunId` is provided:

- **Dataset**: `https://api.apify.com/v2/datasets/{datasetId}/items?token={apiToken}&limit={maxItems}`
- **Actor run**: `https://api.apify.com/v2/actor-runs/{actorRunId}/dataset/items?token={apiToken}&limit={maxItems}`

The response is expected to be a JSON array of objects.

### Field Mapping

Each Apify item is transformed to the `ItemData` format using configurable field mapping. The default mapping is:

| ItemData Field | Apify Field   | Fallbacks                               |
| -------------- | ------------- | --------------------------------------- |
| `name`         | `title`       | `item.title`, `item.name`, `'Untitled'` |
| `description`  | `description` | `''`                                    |
| `source_url`   | `url`         | `''`                                    |
| `category`     | `category`    | `undefined`                             |
| `images`       | `image`       | `[]` (wrapped in array if present)      |
| `slug`         | (generated)   | Slugified from `name`, max 100 chars    |

### Relevance Filtering

When `filterByRelevance` is enabled and a `filterContext` is provided (containing `prompt`, `subject`, and/or `keywords`), the plugin filters items using keyword matching:

1. Keywords are collected from the explicit `keywords` array, the `subject`, and the `prompt`.
2. The `extractKeywords` utility from `@ever-works/plugin/keywords` extracts up to 15 keywords from the combined text.
3. Items are retained only if their `name` or `description` contains at least one keyword (case-insensitive).

### Slug Generation

Slugs are generated by lowercasing the name, replacing non-alphanumeric characters with hyphens, trimming leading/trailing hyphens, and truncating to 100 characters.

### Form Value Transformation

`transformFormValues` converts flat form field values (prefixed with `apify_`) into a nested `apify` object for the pipeline:

```typescript
{
  apify: {
    datasetId: values['apify_datasetId'],
    actorRunId: values['apify_actorRunId'],
    maxItems: values['apify_maxItems'] ?? 100,
    filterByRelevance: values['apify_filterByRelevance'] ?? true
  }
}
```

## Usage Examples

```typescript
// Query items from an Apify dataset
const result = await apifyPlugin.query({
	settings: {
		apiToken: 'apify_api_...',
		datasetId: '5uxB4x3zYjV5S7nFd',
		maxItems: 50,
		filterByRelevance: true
	},
	filterContext: {
		prompt: 'AI tools for developers',
		subject: 'developer tools',
		keywords: ['AI', 'developer', 'tools']
	}
});

console.log(`Imported ${result.items.length} items`);
for (const item of result.items) {
	console.log(`- ${item.name}: ${item.source_url}`);
}

// Validate form input
const validation = apifyPlugin.validateFormInput({
	apify_datasetId: '',
	apify_actorRunId: ''
});
// { valid: false, errors: [{ path: 'apify_datasetId', message: 'Either Dataset ID or Actor Run ID is required' }] }
```

## Rate Limiting & Quotas

- **Apify API**: Rate limits depend on the Apify subscription plan. The free tier allows limited API calls per month.
- **Item limits**: Configurable via `maxItems` (default 100, max 10,000). Setting to 0 removes the limit.
- **Single request**: All items are fetched in a single API call (no pagination). Large datasets may require the `limit` parameter to avoid timeouts.
- The plugin does not implement internal rate-limit tracking.

## Error Handling

- **Missing API token**: Logs an error via `context.logger.error` and returns `{ items: [], hasMore: false }` without throwing.
- **Missing dataset/actor run ID**: Logs an error and returns empty results.
- **API errors**: Caught and logged; returns empty results rather than throwing to prevent pipeline failure.
- **Invalid response format**: If the API response is not a JSON array, throws `'Unexpected Apify API response format'`.
- **Form validation**: Returns `{ valid: false, errors: [...] }` when neither dataset ID nor actor run ID is provided.
- The design philosophy is to degrade gracefully: data source failures return empty results rather than crashing the generation pipeline.

## Related Plugins

- [Notion Extractor Plugin Deep Dive](./notion-plugin-deep-dive) -- another supplementary data source for Notion content.
- [Apify Plugin](./apify-plugin) -- overview documentation for the Apify plugin.
