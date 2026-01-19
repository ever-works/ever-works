# Data Generator

## Overview

The Data Generator manages the **data repository** for each directory - a GitHub repository containing YAML configuration and JSON item data. It orchestrates the items generation pipeline and persists results to GitHub.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    DataGeneratorService                          │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    initialize()                          │    │
│  │                                                          │    │
│  │  1. Load existing data from GitHub                       │    │
│  │  2. Call ItemsGeneratorService.generateItems()           │    │
│  │  3. Merge new items with existing                        │    │
│  │  4. Write updated data to GitHub                         │    │
│  │  5. Create PR if configured                              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Uses: DataRepository (YAML/JSON file operations)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Data Repository                        │
│                                                                  │
│  {owner}/{directory-slug}-data/                                 │
│  ├── config.yml           # Directory configuration             │
│  ├── items/               # Item JSON files                     │
│  │   ├── item-slug-1.json                                       │
│  │   ├── item-slug-2.json                                       │
│  │   └── ...                                                    │
│  ├── categories.yml       # Category definitions                │
│  ├── tags.yml             # Tag definitions                     │
│  └── brands.yml           # Brand definitions                   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
TriggerGenerationOrchestrator
    │
    ▼
DataGeneratorService.initialize(payload)
    │
    ├── Clone/pull data repository
    │
    ├── Read existing config.yml, items/, categories.yml, tags.yml
    │
    ├── Call ItemsGeneratorService.generateItems()
    │   └── Returns: {items, categories, tags, brands, metrics, contentCache}
    │
    ├── Merge results with existing data
    │   ├── Update existing items (if same slug)
    │   ├── Add new items
    │   ├── Preserve manual edits (featured, order)
    │
    ├── Write to repository
    │   ├── Update config.yml (increment version)
    │   ├── Write item JSON files
    │   ├── Update categories.yml
    │   ├── Update tags.yml
    │   ├── Update brands.yml
    │
    └── Commit & Push (or create PR)
        │
        ▼
    Returns: {success, prUpdate?, stats}
```

## DataRepository Class

The `DataRepository` class handles all file operations for the data repository.

### Key Methods

```typescript
class DataRepository {
	// Configuration
	readConfig(): Promise<DirectoryConfig>;
	writeConfig(config: DirectoryConfig): Promise<void>;

	// Items
	readItems(): Promise<ItemData[]>;
	writeItem(item: ItemData): Promise<void>;
	removeItem(slug: string): Promise<void>;

	// Categories
	readCategories(): Promise<Category[]>;
	writeCategories(categories: Category[]): Promise<void>;

	// Tags
	readTags(): Promise<Tag[]>;
	writeTags(tags: Tag[]): Promise<void>;

	// Brands
	readBrands(): Promise<Brand[]>;
	writeBrands(brands: Brand[]): Promise<void>;

	// Git operations
	clone(): Promise<void>;
	pull(): Promise<void>;
	commit(message: string): Promise<void>;
	push(): Promise<void>;
	createBranch(name: string): Promise<void>;
	switchBranch(name: string): Promise<void>;
}
```

## Repository Structure

### config.yml

```yaml
name: "My Directory"
description: "A curated list of tools..."
slug: "my-directory"
version: 3                          # Auto-incremented on each update
metadata:
  initial_prompt: "Find the best..."
  last_request_data:
    prompt: "Find the best..."
    config:
      max_search_queries: 10
      ...
  created_at: "2024-01-15T10:30:00Z"
  updated_at: "2024-01-16T14:20:00Z"
```

### items/item-slug.json

```json
{
	"name": "Tool Name",
	"slug": "tool-name",
	"description": "A powerful tool for...",
	"source_url": "https://tool.example.com",
	"category": "monitoring",
	"tags": ["open-source", "cloud-native"],
	"featured": false,
	"order": null,
	"badges": {
		"open_source": true
	},
	"brand": "company-name",
	"brand_logo_url": "https://...",
	"images": ["https://..."],
	"markdown": "## Tool Name\n\n..."
}
```

### categories.yml

```yaml
- id: 'monitoring'
  name: 'Monitoring'
  priority: 1

- id: 'logging'
  name: 'Logging'
  priority: 2

- id: 'other'
  name: 'Other'
```

### tags.yml

```yaml
- id: 'open-source'
  name: 'Open Source'

- id: 'cloud-native'
  name: 'Cloud Native'

- id: 'self-hosted'
  name: 'Self Hosted'
```

### brands.yml

```yaml
- id: 'datadog'
  name: 'Datadog'
  logo_url: 'https://...'

- id: 'grafana'
  name: 'Grafana'
  logo_url: 'https://...'
```

## Interfaces

### DataGeneratorService Input

```typescript
interface DataGeneratorPayload {
	directoryId: string;
	userId: string;
	mode: 'create' | 'update';
	dto: CreateItemsGeneratorDto;
	historyId: string;
}
```

### DataGeneratorService Output

```typescript
interface DataGeneratorResult {
	success: boolean;
	prUpdate?: {
		branch: string;
		title: string;
		body: string;
		number: number;
		url: string;
	};
	stats: {
		newItemsCount: number;
		updatedItemsCount: number;
		totalItemsCount: number;
		metrics: ItemsGeneratorMetrics;
	};
	error?: string;
}
```

### DirectoryConfig

```typescript
interface DirectoryConfig {
	name: string;
	description: string;
	slug: string;
	version: number;
	metadata: {
		initial_prompt?: string;
		last_request_data?: CreateItemsGeneratorDto;
		created_at: string;
		updated_at: string;
	};
}
```

## Generation Modes

### CREATE_UPDATE (Default)

- Merges new items with existing
- Updates existing items if slug matches
- Preserves manual edits (featured, order)
- Increments version

### RECREATE

- Deletes all existing items
- Writes only newly generated items
- Resets categories and tags
- Preserves config metadata

## Pull Request Mode

When `update_with_pull_request: true`:

1. Creates new branch: `ever-update-{timestamp}`
2. Commits changes to branch
3. Creates PR to main branch
4. Returns PR details in result

```typescript
// PR creation
const prUpdate = {
	branch: 'ever-update-1705330800',
	title: 'Ever Works: Update directory items',
	body: `## Changes\n\n- Added ${newCount} new items\n- Updated ${updatedCount} items`,
	number: 42,
	url: 'https://github.com/user/repo/pull/42'
};
```

## Version Management

The `version` field in config.yml auto-increments on each update:

```typescript
// In DataGeneratorService
async updateConfig(config: DirectoryConfig) {
    config.version = (config.version || 0) + 1;
    config.metadata.updated_at = new Date().toISOString();
    await this.dataRepository.writeConfig(config);
}
```

This allows:

- Tracking update frequency
- Cache invalidation on website
- Rollback identification

## Item Merging Logic

```typescript
function mergeItems(existing: ItemData[], newItems: ItemData[]): ItemData[] {
	const merged = new Map<string, ItemData>();

	// Add existing items
	for (const item of existing) {
		merged.set(item.slug, item);
	}

	// Merge new items
	for (const newItem of newItems) {
		const existing = merged.get(newItem.slug);
		if (existing) {
			// Update but preserve manual edits
			merged.set(newItem.slug, {
				...newItem,
				featured: existing.featured, // Preserve
				order: existing.order // Preserve
			});
		} else {
			merged.set(newItem.slug, newItem);
		}
	}

	return Array.from(merged.values());
}
```

## Error Handling

| Error             | Handling                                  |
| ----------------- | ----------------------------------------- |
| Git clone fails   | Retry with backoff, fail if persistent    |
| Write fails       | Rollback changes, report error            |
| Push fails        | Check permissions, retry, fail gracefully |
| PR creation fails | Fall back to direct commit                |

## File Locations

```
/packages/agent/src/data-generator/
├── data-generator.service.ts   # Main service
├── data-repository.ts          # File operations
├── texts.ts                    # License, legal text
└── interfaces/
    └── data-generator.interfaces.ts
```

## Configuration

| Option                     | Description                        |
| -------------------------- | ---------------------------------- |
| `update_with_pull_request` | Create PR instead of direct commit |
| `generation_method`        | CREATE_UPDATE or RECREATE          |

## Integration Points

- **Input**: `ItemsGeneratorService.generateItems()` result
- **Output**: GitHub data repository
- **Consumer**: MarkdownGenerator, Website

## See Also

- [Items Generation Spec](../items-generation/spec.md)
- [Markdown Generator Spec](../markdown-generator/spec.md)
- [Pipeline Overview](../../architecture/pipeline-overview.md)
