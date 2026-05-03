---
id: creating-data-source-plugin
title: 'Creating a Data Source Plugin'
sidebar_label: 'Data Source Plugin'
sidebar_position: 11
---

# Creating a Data Source Plugin

Data source plugins import items from external services into Ever Works works. They transform external data -- from web scraping platforms, APIs, databases, or files -- into the `ItemData` format that the generation pipeline consumes.

## What Data Source Plugins Do

During work generation, the platform's `DataSourceFacade` calls `query()` on each enabled data source plugin. The returned items are merged into the generation pipeline alongside items discovered by search and AI. This allows users to seed works with pre-existing data rather than relying entirely on AI-generated content.

A data source plugin:

1. Connects to an external service using configured credentials.
2. Fetches raw data (items, records, rows).
3. Maps the external data schema to the Ever Works `ItemData` format.
4. Optionally filters items by relevance to the work's topic.
5. Returns structured results that the pipeline can process.

## The IDataSourcePlugin Interface

All data source plugins implement the `IDataSourcePlugin` interface from `@ever-works/plugin`:

```typescript
interface IDataSourcePlugin extends IPlugin {
	/** Data source identifier, e.g., 'Apify', 'Airtable' */
	readonly sourceName: string;

	/** Query items from the data source (required) */
	query(options?: DataSourceQueryOptions): Promise<DataSourceQueryResult>;

	/** Get a single item by ID or URL (optional) */
	getItem?(id: string): Promise<ItemData | null>;

	/** Sync data from the source (optional) */
	sync?(): Promise<DataSourceSyncResult>;

	/** Get metadata about the data source (optional) */
	getMetadata?(): Promise<DataSourceMetadata>;

	/** Check if the data source is available (required) */
	isAvailable(): Promise<boolean>;

	/** Get supported query filters (optional) */
	getSupportedFilters?(): readonly string[];
}
```

### Query Options

The `query()` method receives a `DataSourceQueryOptions` object with pagination, filtering, and context:

```typescript
interface DataSourceQueryOptions {
	readonly query?: string;
	readonly limit?: number;
	readonly offset?: number;
	readonly category?: string;
	readonly tags?: readonly string[];
	readonly sortBy?: string;
	readonly sortOrder?: 'asc' | 'desc';
	readonly filters?: Record<string, unknown>;

	/** Resolved plugin settings (API keys, field mappings, etc.) */
	readonly settings?: PluginSettings;

	/** Context for filtering items by relevance to the work topic */
	readonly filterContext?: DataSourceFilterContext;
}
```

:::info Settings in Query Options
The `settings` field in `DataSourceQueryOptions` contains the fully resolved settings for this operation, including user-scoped secrets like API tokens. This is passed by the `DataSourceFacade` and includes both admin-level settings and per-generation form values merged together.
:::

### Query Result

```typescript
interface DataSourceQueryResult {
	readonly items: readonly ItemData[];
	readonly total?: number;
	readonly hasMore: boolean;
	readonly categories?: readonly Category[];
	readonly tags?: readonly Tag[];
	readonly brands?: readonly Brand[];
}
```

### Filter Context

When relevance filtering is enabled, the facade passes a `DataSourceFilterContext` so the plugin can narrow results to items relevant to the work:

```typescript
interface DataSourceFilterContext {
	readonly prompt?: string; // Work description/prompt
	readonly subject?: string; // Work subject/topic
	readonly keywords?: readonly string[]; // Pre-extracted keywords
}
```

## Complete Implementation Example

This section walks through the Apify plugin as a reference implementation. It demonstrates all the patterns you need for a production data source plugin.

### Project Setup

Create the plugin package:

```
packages/plugins/your-source/
  src/
    index.ts
    your-source.plugin.ts
    __tests__/
      your-source.plugin.spec.ts
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
```

Your `package.json` must include the `everworks.plugin` metadata:

```json
{
	"name": "@ever-works/your-source-plugin",
	"version": "1.0.0",
	"private": true,
	"type": "module",
	"main": "./dist/index.cjs",
	"module": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js",
			"require": "./dist/index.cjs"
		}
	},
	"scripts": {
		"build": "tsup",
		"test": "vitest run"
	},
	"peerDependencies": {
		"@ever-works/plugin": "workspace:*"
	},
	"devDependencies": {
		"@ever-works/plugin": "workspace:*",
		"@ever-works/contracts": "workspace:*",
		"tsup": "^8.4.0",
		"typescript": "^5.7.3",
		"vitest": "^3.0.0"
	},
	"everworks": {
		"plugin": {
			"id": "your-source",
			"name": "Your Source",
			"version": "1.0.0",
			"category": "data-source",
			"capabilities": ["data-source", "form-schema-provider"],
			"description": "Import items from Your Source into works",
			"author": { "name": "Your Name" },
			"license": "MIT",
			"systemPlugin": false,
			"builtIn": false,
			"isDefault": false
		}
	}
}
```

:::note Dual Capabilities
Data source plugins almost always implement both `data-source` and `form-schema-provider` capabilities. The first provides the data; the second provides the UI fields where users configure what data to import.
:::

### Full Plugin Implementation

```typescript
import type {
	IPlugin,
	IDataSourcePlugin,
	IFormSchemaProvider,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	DataSourceQueryOptions,
	DataSourceQueryResult,
	DataSourceMetadata,
	ConnectionValidationResult
} from '@ever-works/plugin';
import { extractKeywords } from '@ever-works/plugin/keywords';
import type { FormFieldDefinition, FormFieldGroup, ItemData } from '@ever-works/contracts';

/**
 * Field mapping from external data fields to ItemData fields.
 */
interface FieldMapping {
	name?: string;
	description?: string;
	source_url?: string;
	category?: string;
	image_url?: string;
	[key: string]: string | undefined;
}

export class YourSourcePlugin implements IPlugin, IDataSourcePlugin, IFormSchemaProvider {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'your-source';
	readonly name = 'Your Source';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'data-source';
	readonly capabilities: readonly string[] = ['data-source', 'form-schema-provider'];
	readonly sourceName = 'Your Source';
	readonly handledConfigFields: readonly string[] = [];

	/**
	 * Settings schema for admin/user-level configuration.
	 * API tokens and default field mappings are set here.
	 */
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiToken: {
				type: 'string',
				title: 'API Token',
				description: 'Your Source API token',
				'x-secret': true,
				'x-scope': 'user'
			},
			defaultFieldMapping: {
				type: 'object',
				title: 'Default Field Mapping',
				description: 'Map external fields to item fields',
				properties: {
					name: { type: 'string', default: 'title' },
					description: { type: 'string', default: 'description' },
					source_url: { type: 'string', default: 'url' },
					category: { type: 'string', default: 'category' },
					image_url: { type: 'string', default: 'image' }
				}
			}
		}
	};

	private context?: PluginContext;

	// ============================================================================
	// IFormSchemaProvider -- Generator Form Fields (Level 3 config)
	// ============================================================================

	getFormFields(): FormFieldDefinition[] {
		return [
			{
				name: 'yoursource_collectionId',
				type: 'text',
				label: 'Collection ID',
				description: 'The collection or dataset ID to import from',
				placeholder: 'e.g., abc123',
				group: 'your-source'
			},
			{
				name: 'yoursource_maxItems',
				type: 'number',
				label: 'Maximum Items',
				description: 'Limit the number of items to import (0 = no limit)',
				defaultValue: 100,
				group: 'your-source',
				validation: { min: 0, max: 10000 }
			},
			{
				name: 'yoursource_filterByRelevance',
				type: 'boolean',
				label: 'Filter by Relevance',
				description: 'Only import items relevant to the work prompt',
				defaultValue: true,
				group: 'your-source'
			}
		];
	}

	getFormGroups(): FormFieldGroup[] {
		return [
			{
				name: 'your-source',
				title: 'Your Source',
				description: 'Import items from Your Source collections',
				collapsible: true,
				collapsed: true,
				order: 100
			}
		];
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		const collectionId = values['yoursource_collectionId'] as string | undefined;
		if (!collectionId) {
			return {
				valid: false,
				errors: [
					{
						path: 'yoursource_collectionId',
						message: 'Collection ID is required'
					}
				]
			};
		}
		return { valid: true };
	}

	transformFormValues(values: Record<string, unknown>): Record<string, unknown> {
		return {
			...values,
			yoursource: {
				collectionId: values['yoursource_collectionId'],
				maxItems: values['yoursource_maxItems'] ?? 100,
				filterByRelevance: values['yoursource_filterByRelevance'] ?? true
			}
		};
	}

	getDefaultValues(): Record<string, unknown> {
		return {
			yoursource_maxItems: 100,
			yoursource_filterByRelevance: true
		};
	}

	// ============================================================================
	// IDataSourcePlugin -- Data Retrieval
	// ============================================================================

	async query(options?: DataSourceQueryOptions): Promise<DataSourceQueryResult> {
		const settings = options?.settings as Record<string, unknown> | undefined;

		// 1. Get credentials from resolved settings
		const apiToken = settings?.apiToken as string | undefined;
		if (!apiToken) {
			this.context?.logger.error('API token not configured');
			return { items: [], hasMore: false };
		}

		// 2. Get collection ID from settings (passed via pluginConfig from form values)
		const collectionId = settings?.collectionId as string | undefined;
		const maxItems = (settings?.maxItems as number) ?? 100;
		const filterByRelevance = (settings?.filterByRelevance as boolean) ?? true;

		if (!collectionId) {
			this.context?.logger.error('No collection ID provided');
			return { items: [], hasMore: false };
		}

		try {
			// 3. Fetch data from the external API
			const response = await fetch(
				`https://api.yoursource.com/v1/collections/${collectionId}/items?limit=${maxItems}`,
				{ headers: { Authorization: `Bearer ${apiToken}` } }
			);

			if (!response.ok) {
				throw new Error(`API error: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			if (!Array.isArray(data.items)) {
				throw new Error('Unexpected API response format');
			}

			// 4. Get field mapping (from settings or use defaults)
			const fieldMapping = (settings?.defaultFieldMapping as FieldMapping) ?? {
				name: 'title',
				description: 'description',
				source_url: 'url',
				category: 'category',
				image_url: 'image'
			};

			// 5. Map external items to ItemData format
			let items = data.items.map((item: Record<string, unknown>) => this.mapToItemData(item, fieldMapping));

			this.context?.logger.log(`Fetched ${items.length} items from collection`);

			// 6. Filter by relevance if enabled
			if (filterByRelevance && options?.filterContext) {
				const originalCount = items.length;
				items = this.filterByRelevance(items, options.filterContext);
				this.context?.logger.log(`Filtered from ${originalCount} to ${items.length} relevant items`);
			}

			return {
				items: items as unknown as readonly ItemData[],
				total: items.length,
				hasMore: false
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`Query failed: ${message}`);
			return { items: [], hasMore: false };
		}
	}

	async getMetadata(): Promise<DataSourceMetadata> {
		return {
			name: 'Your Source',
			description: 'Import items from Your Source collections'
		};
	}

	async isAvailable(): Promise<boolean> {
		if (!this.context) return false;
		const settings = await this.context.getSettings();
		return Boolean(settings?.apiToken);
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const apiToken = settings.apiToken as string | undefined;
		if (!apiToken) {
			return { success: false, message: 'API token is not configured.' };
		}

		try {
			const response = await fetch('https://api.yoursource.com/v1/me', {
				headers: { Authorization: `Bearer ${apiToken}` }
			});
			if (!response.ok) {
				return {
					success: false,
					message: `Connection failed (${response.status}): ${response.statusText}`
				};
			}
			return { success: true, message: 'Connection verified.' };
		} catch (error) {
			return {
				success: false,
				message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private mapToItemData(item: Record<string, unknown>, mapping: FieldMapping): Partial<ItemData> {
		const getValue = (key: string): string | undefined => {
			const mappedKey = mapping[key];
			if (!mappedKey) return undefined;
			const value = item[mappedKey];
			return typeof value === 'string' ? value : undefined;
		};

		const name = getValue('name') || String(item.title || item.name || 'Untitled');
		const imageUrl = getValue('image_url');

		return {
			name,
			slug: this.generateSlug(name),
			description: getValue('description') || '',
			source_url: getValue('source_url') || '',
			category: getValue('category'),
			images: imageUrl ? [imageUrl] : undefined
		};
	}

	private generateSlug(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.substring(0, 100);
	}

	private filterByRelevance(
		items: Partial<ItemData>[],
		filterContext: NonNullable<DataSourceQueryOptions['filterContext']>
	): Partial<ItemData>[] {
		const { prompt, subject, keywords } = filterContext;

		const keywordSet = new Set<string>();
		if (keywords) {
			keywords.forEach((k) => keywordSet.add(k.toLowerCase()));
		}
		if (subject || prompt) {
			const extracted = extractKeywords([subject, prompt].filter(Boolean).join(' '), { maxKeywords: 15 });
			extracted.forEach((k) => keywordSet.add(k));
		}

		if (keywordSet.size === 0) {
			return items;
		}

		return items.filter((item) => {
			const text = `${item.name} ${item.description}`.toLowerCase();
			return Array.from(keywordSet).some((keyword) => text.includes(keyword));
		});
	}

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Your Source Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Your Source plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Import items from Your Source into works',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Your Name' },
			license: 'MIT',
			builtIn: false,
			systemPlugin: false,
			icon: {
				type: 'lucide',
				value: 'Database'
			}
		};
	}
}

export default YourSourcePlugin;
```

## Form Schema Provider for UI Fields

The `IFormSchemaProvider` interface is what makes your data source configurable per-generation in the UI. Ever Works uses a three-level configuration model:

| Level       | Where              | What                         | Interface                      |
| ----------- | ------------------ | ---------------------------- | ------------------------------ |
| **Level 1** | Settings > Plugins | API tokens, default mappings | `settingsSchema` on `IPlugin`  |
| **Level 2** | Work > Apps        | Enable/disable per work      | `WorkPlugin` entity (platform) |
| **Level 3** | Generator Form     | Per-generation options       | `IFormSchemaProvider`          |

Your `getFormFields()` method returns Level 3 fields only. Enable/disable is handled at Level 2 by the platform.

### Form Field Definitions

```typescript
getFormFields(): FormFieldDefinition[] {
  return [
    {
      name: 'yoursource_collectionId',  // Prefix with plugin name to avoid conflicts
      type: 'text',                      // 'text' | 'number' | 'boolean' | 'select' | etc.
      label: 'Collection ID',
      description: 'Help text shown below the field',
      placeholder: 'e.g., abc123',
      group: 'your-source',             // Links to a FormFieldGroup
      validation: { required: true }
    },
    {
      name: 'yoursource_maxItems',
      type: 'number',
      label: 'Maximum Items',
      defaultValue: 100,
      group: 'your-source',
      validation: { min: 0, max: 10000 }
    }
  ];
}
```

:::tip Field Naming Convention
Always prefix form field names with your plugin ID (e.g., `apify_datasetId`, `yoursource_maxItems`). This prevents collisions when multiple plugins contribute fields to the same generator form.
:::

### Form Field Groups

Groups organize your fields into collapsible sections in the UI:

```typescript
getFormGroups(): FormFieldGroup[] {
  return [
    {
      name: 'your-source',
      title: 'Your Source',
      description: 'Import items from Your Source collections',
      collapsible: true,
      collapsed: true,     // Collapsed by default
      order: 100           // Show after core pipeline fields
    }
  ];
}
```

### Validation

The `validateFormInput()` method runs before generation starts. Return `{ valid: true }` when everything is acceptable, or provide specific error messages:

```typescript
validateFormInput(values: Record<string, unknown>): ValidationResult {
  const collectionId = values['yoursource_collectionId'] as string | undefined;
  const maxItems = values['yoursource_maxItems'] as number | undefined;

  const errors: Array<{ path: string; message: string }> = [];

  if (!collectionId) {
    errors.push({
      path: 'yoursource_collectionId',
      message: 'Collection ID is required'
    });
  }

  if (maxItems !== undefined && maxItems < 0) {
    errors.push({
      path: 'yoursource_maxItems',
      message: 'Maximum items must be 0 or greater'
    });
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
```

### Transforming Form Values

The `transformFormValues()` method converts flat form values into the structured format your `query()` method expects:

```typescript
transformFormValues(values: Record<string, unknown>): Record<string, unknown> {
  return {
    ...values,
    yoursource: {
      collectionId: values['yoursource_collectionId'],
      maxItems: values['yoursource_maxItems'] ?? 100,
      filterByRelevance: values['yoursource_filterByRelevance'] ?? true
    }
  };
}
```

## Field Mapping

Field mapping is the mechanism that translates external data schemas to the Ever Works `ItemData` format. Different data sources use different field names for the same concepts (e.g., `title` vs. `name` vs. `heading`), so mapping is essential.

### The ItemData Target Schema

Every data source must map its items to (at minimum) these `ItemData` fields:

| Field         | Type     | Required | Description              |
| ------------- | -------- | -------- | ------------------------ |
| `name`        | string   | Yes      | Display name of the item |
| `slug`        | string   | Yes      | URL-safe identifier      |
| `description` | string   | No       | Item description         |
| `source_url`  | string   | No       | Original source URL      |
| `category`    | string   | No       | Category name            |
| `images`      | string[] | No       | Array of image URLs      |

### Implementing Field Mapping

Define a mapping configuration type and a `mapToItemData` helper:

```typescript
interface FieldMapping {
  name?: string;         // External field that maps to ItemData.name
  description?: string;  // External field that maps to ItemData.description
  source_url?: string;   // External field that maps to ItemData.source_url
  category?: string;     // External field that maps to ItemData.category
  image_url?: string;    // External field that maps to ItemData.images[0]
}

private mapToItemData(
  item: Record<string, unknown>,
  mapping: FieldMapping
): Partial<ItemData> {
  const getValue = (key: string): string | undefined => {
    const mappedKey = mapping[key];
    if (!mappedKey) return undefined;
    const value = item[mappedKey];
    return typeof value === 'string' ? value : undefined;
  };

  const name = getValue('name') || String(item.title || item.name || 'Untitled');
  const imageUrl = getValue('image_url');

  return {
    name,
    slug: this.generateSlug(name),
    description: getValue('description') || '',
    source_url: getValue('source_url') || '',
    category: getValue('category'),
    images: imageUrl ? [imageUrl] : undefined
  };
}
```

### Configurable Mappings

Allow users to customize field mapping through the settings schema:

```typescript
readonly settingsSchema: JsonSchema = {
  type: 'object',
  properties: {
    apiToken: {
      type: 'string',
      title: 'API Token',
      'x-secret': true,
      'x-scope': 'user'
    },
    defaultFieldMapping: {
      type: 'object',
      title: 'Default Field Mapping',
      description: 'Map your data fields to work item fields',
      properties: {
        name:        { type: 'string', default: 'title' },
        description: { type: 'string', default: 'description' },
        source_url:  { type: 'string', default: 'url' },
        category:    { type: 'string', default: 'category' },
        image_url:   { type: 'string', default: 'image' }
      }
    }
  }
};
```

Then in `query()`, resolve the mapping with a fallback to sensible defaults:

```typescript
const fieldMapping = (settings?.defaultFieldMapping as FieldMapping) ?? {
	name: 'title',
	description: 'description',
	source_url: 'url',
	category: 'category',
	image_url: 'image'
};
```

### Relevance Filtering

Use `extractKeywords` from `@ever-works/plugin/keywords` to build a keyword set from the work prompt, then filter items that match at least one keyword:

```typescript
import { extractKeywords } from '@ever-works/plugin/keywords';

private filterByRelevance(
  items: Partial<ItemData>[],
  filterContext: DataSourceFilterContext
): Partial<ItemData>[] {
  const { prompt, subject, keywords } = filterContext;

  const keywordSet = new Set<string>();
  if (keywords) {
    keywords.forEach((k) => keywordSet.add(k.toLowerCase()));
  }
  if (subject || prompt) {
    const extracted = extractKeywords(
      [subject, prompt].filter(Boolean).join(' '),
      { maxKeywords: 15 }
    );
    extracted.forEach((k) => keywordSet.add(k));
  }

  if (keywordSet.size === 0) return items;

  return items.filter((item) => {
    const text = `${item.name} ${item.description}`.toLowerCase();
    return Array.from(keywordSet).some((kw) => text.includes(kw));
  });
}
```

:::caution Filtering is Optional
Relevance filtering should be controlled by a boolean form field (e.g., `filterByRelevance`). Some users want all items imported regardless of relevance. Always check the flag before filtering.
:::

## Testing

### Contract Tests

The `@ever-works/plugin/testing` package provides `testBasePluginContract` for verifying the base interface. There is no specific data source contract test suite yet, but you should verify the base contract and test data source behavior manually:

```typescript
import { describe, it, expect } from 'vitest';
import { testBasePluginContract } from '@ever-works/plugin/testing';
import { createMockPluginContext } from '@ever-works/plugin/testing';
import { YourSourcePlugin } from '../your-source.plugin.js';

describe('YourSourcePlugin', () => {
	it('passes base plugin contract', async () => {
		const plugin = new YourSourcePlugin();
		const results = await testBasePluginContract(plugin);
		for (const result of results) {
			expect(result.passed).toBe(true);
		}
	});

	it('has correct capabilities', () => {
		const plugin = new YourSourcePlugin();
		expect(plugin.capabilities).toContain('data-source');
		expect(plugin.capabilities).toContain('form-schema-provider');
		expect(plugin.category).toBe('data-source');
	});

	it('reports unavailable when no API token', async () => {
		const plugin = new YourSourcePlugin();
		const context = createMockPluginContext({
			pluginId: 'your-source',
			settings: {}
		});
		await plugin.onLoad(context);
		expect(await plugin.isAvailable()).toBe(false);
	});

	it('reports available when API token is set', async () => {
		const plugin = new YourSourcePlugin();
		const context = createMockPluginContext({
			pluginId: 'your-source',
			settings: { apiToken: 'test-token-123' }
		});
		await plugin.onLoad(context);
		expect(await plugin.isAvailable()).toBe(true);
	});
});
```

### Testing the Query Method

Mock the external API call and verify item mapping:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockPluginContext } from '@ever-works/plugin/testing';
import { YourSourcePlugin } from '../your-source.plugin.js';

describe('YourSourcePlugin.query', () => {
	let plugin: YourSourcePlugin;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		plugin = new YourSourcePlugin();
		const context = createMockPluginContext({
			pluginId: 'your-source',
			settings: { apiToken: 'test-token' }
		});
		await plugin.onLoad(context);

		fetchSpy = vi.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it('returns empty items when no API token', async () => {
		const result = await plugin.query({ settings: {} });
		expect(result.items).toHaveLength(0);
	});

	it('maps external items to ItemData format', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				items: [
					{ title: 'Item One', description: 'First item', url: 'https://example.com/1' },
					{ title: 'Item Two', description: 'Second item', url: 'https://example.com/2' }
				]
			})
		} as Response);

		const result = await plugin.query({
			settings: {
				apiToken: 'test-token',
				collectionId: 'col-123',
				maxItems: 10,
				filterByRelevance: false
			}
		});

		expect(result.items).toHaveLength(2);
		expect(result.items[0]).toMatchObject({
			name: 'Item One',
			description: 'First item',
			source_url: 'https://example.com/1'
		});
	});

	it('filters by relevance when enabled', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				items: [
					{ title: 'React Framework', description: 'A JavaScript library' },
					{ title: 'Cooking Recipes', description: 'Best pasta dishes' }
				]
			})
		} as Response);

		const result = await plugin.query({
			settings: {
				apiToken: 'test-token',
				collectionId: 'col-123',
				filterByRelevance: true
			},
			filterContext: {
				prompt: 'JavaScript frameworks and libraries',
				keywords: ['javascript', 'react', 'framework']
			}
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].name).toBe('React Framework');
	});
});
```

### Testing Form Schema

```typescript
describe('YourSourcePlugin form schema', () => {
	it('returns form fields', () => {
		const plugin = new YourSourcePlugin();
		const fields = plugin.getFormFields();
		expect(fields.length).toBeGreaterThan(0);
		expect(fields.every((f) => f.name.startsWith('yoursource_'))).toBe(true);
	});

	it('returns form groups', () => {
		const plugin = new YourSourcePlugin();
		const groups = plugin.getFormGroups?.();
		expect(groups).toBeDefined();
		expect(groups!.length).toBeGreaterThan(0);
	});

	it('validates missing collection ID', () => {
		const plugin = new YourSourcePlugin();
		const result = plugin.validateFormInput({});
		expect(result.valid).toBe(false);
		expect(result.errors).toBeDefined();
	});

	it('validates valid input', () => {
		const plugin = new YourSourcePlugin();
		const result = plugin.validateFormInput({
			yoursource_collectionId: 'col-123'
		});
		expect(result.valid).toBe(true);
	});

	it('transforms form values', () => {
		const plugin = new YourSourcePlugin();
		const transformed = plugin.transformFormValues?.({
			yoursource_collectionId: 'col-123',
			yoursource_maxItems: 50
		});
		expect(transformed?.yoursource).toEqual({
			collectionId: 'col-123',
			maxItems: 50,
			filterByRelevance: true
		});
	});
});
```

### Testing Connection Validation

```typescript
describe('YourSourcePlugin.validateConnection', () => {
	it('rejects empty token', async () => {
		const plugin = new YourSourcePlugin();
		const result = await plugin.validateConnection({});
		expect(result.success).toBe(false);
	});

	it('reports success for valid token', async () => {
		const plugin = new YourSourcePlugin();
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: async () => ({})
		} as Response);

		const result = await plugin.validateConnection({ apiToken: 'valid-token' });
		expect(result.success).toBe(true);

		fetchSpy.mockRestore();
	});
});
```

## Plugin Checklist

Use this checklist before submitting your data source plugin:

### Package Structure

- [ ] Package created in `packages/plugins/<name>/` with standard structure
- [ ] `package.json` includes `everworks.plugin` metadata with `category: "data-source"`
- [ ] `capabilities` array includes both `"data-source"` and `"form-schema-provider"`
- [ ] `@ever-works/plugin` listed as peer dependency
- [ ] `@ever-works/contracts` listed as dev dependency (for `ItemData`, `FormFieldDefinition` types)
- [ ] `tsup.config.ts` and `vitest.config.ts` present
- [ ] `index.ts` exports the plugin class as default export

### IDataSourcePlugin

- [ ] `sourceName` property set to a human-readable identifier
- [ ] `query()` method fetches data, applies field mapping, and returns `DataSourceQueryResult`
- [ ] `query()` gracefully returns `{ items: [], hasMore: false }` on errors
- [ ] `isAvailable()` checks that required credentials are configured
- [ ] `getMetadata()` returns source name and description
- [ ] `validateConnection()` verifies the API token is valid

### IFormSchemaProvider

- [ ] `getFormFields()` returns fields prefixed with the plugin ID
- [ ] `getFormGroups()` returns at least one group with `collapsible: true`
- [ ] `validateFormInput()` validates required fields and returns specific error messages
- [ ] `transformFormValues()` converts flat form values to structured format
- [ ] `getDefaultValues()` provides sensible defaults

### Field Mapping

- [ ] Default field mapping defined in `settingsSchema`
- [ ] `mapToItemData()` maps external fields to `ItemData` using the mapping config
- [ ] Fallback values used when mapped fields are missing (e.g., `'Untitled'` for name)
- [ ] `slug` generated from `name` using URL-safe transformation

### Relevance Filtering

- [ ] Filtering is controlled by a boolean form field
- [ ] `extractKeywords` from `@ever-works/plugin/keywords` used for keyword extraction
- [ ] Both `filterContext.keywords` and extracted keywords from `prompt`/`subject` are combined
- [ ] Items without any keyword match are excluded when filtering is enabled
- [ ] All items are returned when no keywords are available

### Settings

- [ ] API token marked with `'x-secret': true` and `'x-scope': 'user'`
- [ ] `configurationMode` not set (defaults to user-configurable) or explicitly set
- [ ] `systemPlugin: false` and `builtIn: false` for community/optional plugins

### Testing

- [ ] Base plugin contract tests pass
- [ ] Capability and category assertions present
- [ ] `isAvailable()` tested with and without API token
- [ ] `query()` tested with mocked fetch responses
- [ ] Field mapping verified with sample data
- [ ] Relevance filtering tested with keyword matching
- [ ] Form field validation tested for both valid and invalid input
- [ ] `transformFormValues()` tested
- [ ] `validateConnection()` tested for empty and valid tokens

### General

- [ ] `pnpm install` run after adding the package
- [ ] `pnpm build:plugins` passes
- [ ] `vitest run` passes in the plugin work
- [ ] `pnpm type-check` passes
