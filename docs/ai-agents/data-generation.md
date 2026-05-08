---
id: data-generation
title: Data Generation
sidebar_label: Data Generation
sidebar_position: 3
---

# Data Generation

The Data Generation system is the core engine behind Ever Works' AI-powered work content creation. It orchestrates the full lifecycle of collecting, validating, deduplicating, and persisting structured item data into Git-backed YAML repositories.

## Architecture Overview

The data generation pipeline lives in `packages/agent/src/generators/data-generator/` and is composed of three main components:

| Component              | File                        | Purpose                                       |
| ---------------------- | --------------------------- | --------------------------------------------- |
| `DataGeneratorService` | `data-generator.service.ts` | Orchestrates the full generation workflow     |
| `DataRepository`       | `data-repository.ts`        | YAML-based file I/O for the data repository   |
| `DataGeneratorModule`  | `data-generator.module.ts`  | NestJS module wiring and dependency injection |

```
DataGeneratorModule
  imports: [FacadesModule, PipelineModule, DatabaseModule, WorkOperationsModule]
  provides: [DataGeneratorService]
```

## Data Repository File Structure

Every work in Ever Works maps to a Git repository with a standardized YAML layout:

```
<repo-root>/
  .works/works.yml            # Work configuration (name, settings, pagination, etc.)
  categories.yml        # Category definitions
  tags.yml              # Tag definitions
  collections.yml       # Collection definitions
  markdown/
    header.md           # Markdown template header
    footer.md           # Markdown template footer
  data/
    <item-slug>/
      <item-slug>.yml   # Item metadata (YAML)
      <item-slug>.md    # Item detailed description (Markdown, optional)
  comparisons/
    <comparison-slug>/
      <comparison-slug>.yml   # Comparison metadata
      <comparison-slug>.md    # Comparison content
  README.md
  LICENSE.md
```

## Configuration System

The `DataRepository` manages a `.works/works.yml` file with deep-merge semantics. The configuration schema (`IDataConfig`) includes:

```typescript
interface IDataConfig {
  company_name?: string;
  company_website?: string;
  content_table?: boolean;
  version?: string;               // Semver-based, auto-incremented
  item_name?: string;             // Singular label (e.g., "Tool")
  items_name?: string;            // Plural label (e.g., "Tools")
  copyright_year?: number;
  autoapproval?: boolean;
  settings?: SettingsConfig;      // Feature toggles
  pagination?: PaginationConfig;  // Pagination settings
  custom_menu?: CustomMenuConfig; // Custom menu items
  metadata?: {                    // Generation tracking
    initial_prompt?: string;
    pr_update?: PRUpdate | null;
    last_request_data?: CreateItemsGeneratorDto;
    comparison_state?: { ... };
  };
}
```

### Settings Configuration

The settings object controls feature availability on the generated website:

| Setting Group | Options                                                                                                                                             | Defaults                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Root**      | `categories_enabled`, `companies_enabled`, `tags_enabled`, `collections_enabled`, `surveys_enabled`, `comparisons_enabled`                          | All `true`                                 |
| **Header**    | `submit_enabled`, `pricing_enabled`, `layout_enabled`, `language_enabled`, `theme_enabled`, `layout_default`, `pagination_default`, `theme_default` | All enabled, layout=`home1`, theme=`light` |
| **Homepage**  | `hero_enabled`, `search_enabled`, `default_view`, `default_sort`                                                                                    | Enabled, view=`classic`, sort=`popularity` |
| **Footer**    | `subscribe_enabled`, `version_enabled`, `theme_selector_enabled`                                                                                    | All `true`                                 |

### Configuration Deep Merge

Configuration updates use a custom merge strategy that deduplicates arrays by content hash:

```typescript
const mergeDataConfig = (base: IDataConfig, incoming: Partial<IDataConfig>): IDataConfig =>
	mergeWith({}, base, incoming, (objValue, srcValue) => {
		if (Array.isArray(objValue) && Array.isArray(srcValue)) {
			return mergeUniqueArray(objValue, srcValue);
		}
		return undefined;
	});
```

## Generation Workflow

### Initialization Flow

The `DataGeneratorService.initialize()` method handles first-time work creation:

1. **Repository Creation** -- Creates a new Git repository via the `GitFacadeService`.
2. **Clone & Setup** -- Clones the repository locally and creates a `DataRepository` instance.
3. **Config Initialization** -- Writes default `.works/works.yml` with work metadata.
4. **Pipeline Execution** -- Delegates to the `PipelineOrchestratorService` to run the AI generation pipeline.
5. **Item Writing** -- Writes generated items to YAML files in the `data/` work.
6. **Deduplication** -- Skips writing items whose content matches existing files (no spurious Git diffs).
7. **Commit & Push** -- Stages all changes, commits, and pushes to the remote.

### Update Flow (Re-generation)

For subsequent generations, the service supports three modes controlled by `GenerationMethod`:

- **RECREATE** -- Clears all existing items and regenerates from scratch.
- **APPEND** -- Adds new items alongside existing ones (creates a PR branch).
- **UPDATE** -- Refreshes existing items with new data.

When using PR-based updates, the service:

1. Creates or checks out a feature branch (`pr_update.branch`).
2. Runs the pipeline with existing items as context.
3. Pushes changes to the branch.
4. The markdown generator later creates the PR.

### Parallel Writing

Items are written with controlled concurrency to avoid filesystem overload:

```typescript
const PARALLEL_WRITE_CONCURRENCY = 10;

await pMap(items, (item) => dataRepo.writeItem(item), {
	concurrency: PARALLEL_WRITE_CONCURRENCY
});
```

## Version Management

The data repository uses semantic versioning that auto-increments on each generation:

```typescript
async getNextVersion(config?: IDataConfig) {
    const version = semver.parse(versionStr);
    version.inc('patch');
    if (version.patch >= 100) version.inc('minor');
    if (version.minor >= 10) version.inc('major');
    return version.format();
}
```

## Items Generator Integration

The `DataGeneratorService` works with the plugin-based pipeline system via `PipelineOrchestratorService`. The pipeline:

1. Processes the user prompt (topic, description, preferences).
2. Uses the configured AI provider plugin to generate item data.
3. Returns structured `ItemData` objects with fields like `name`, `description`, `source_url`, `category`, `tags`.
4. The data generator validates and writes these to the repository.

Each item is stored as a YAML file with automatic timestamp tracking:

```yaml
name: Example Tool
description: A brief description of the tool
source_url: https://example.com
category: open-source
tags:
    - id: javascript
      name: JavaScript
updated_at: '2025-01-15 14:30'
```

## Comparison Generation

The data repository also supports comparison content stored under `comparisons/`:

- `writeComparison(comparison)` -- Writes comparison metadata as YAML.
- `writeComparisonMarkdown(slug, markdown)` -- Writes the comparison article.
- `writeComparisonExtendedMarkdown(slug, markdown)` -- Writes an extended version.
- Comparisons track generation state in `.works/works.yml` metadata to avoid regenerating pairs.

## Legal Content

Every generated repository includes:

- **LICENSE.md** -- CC BY-SA 4.0 International License.
- **README.md** -- Contains a legal notice about AI-generated content and trademark disclaimers.

## Module Dependencies

```
DataGeneratorModule
  +-- FacadesModule (GitFacadeService for Git operations)
  +-- PipelineModule (PipelineOrchestratorService for AI pipeline)
  +-- DatabaseModule (TypeORM repositories for entity persistence)
  +-- WorkOperationsModule (Work CRUD operations)
```
