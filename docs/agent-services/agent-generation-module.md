---
id: agent-generation-module
title: Data Generation Module
sidebar_label: Data Generation
sidebar_position: 22
---

# Data Generation Module

## Overview

The Data Generation module orchestrates the core content generation pipeline in `@ever-works/agent`. It manages the process of generating, updating, and enriching work items using AI-powered pipelines. This module coordinates between the pipeline execution system, data repositories, markdown generation, website building, and deployment -- handling both initial generation runs and incremental scheduled updates.

The module supports two execution modes: in-process execution (for development and small works) and dispatched execution via Trigger.dev (for production workloads).

## Module Structure

```
packages/agent/src/
  generators/
    data-generator/
      data-generator.service.ts       # Main orchestration service
      data-generator.module.ts        # NestJS module definition
      data-repository.ts              # Git-backed data repository abstraction
    markdown-generator/
      markdown-generator.service.ts   # Markdown/README generation
      markdown-generator.module.ts
    website-generator/
      website-generator.service.ts    # Website repository management
      website-generator.module.ts
  services/
    work-generation.service.ts   # High-level generation coordination
  tasks/
    work-generation-dispatcher.ts    # Dispatcher interface
    work-generation.types.ts         # Payload types
```

## Key Classes and Services

### `WorkGenerationService`

The high-level coordination service (~1148 lines) that manages all generation-related operations. It serves as the primary entry point for the API layer.

**Core operations:**

- **`generateItems(work, user, options)`** -- initiates a full generation run. Prepares providers, updates generation status, dispatches to Trigger.dev or runs in-process, and tracks history.
- **`updateItemsGenerator(work, user, options)`** -- incremental update of existing items with new AI-enriched content.
- **`submitItem(work, user, itemData)`** -- add a single item to the work.
- **`removeItem(work, user, itemSlug)`** -- remove an item.
- **`updateItemMetadata(work, user, slug, metadata)`** -- update item metadata (featured status, order, etc.).
- **`extractItemDetails(work, user, url)`** -- use AI to extract item information from a URL.

**Supporting operations:**

- **`bulkCaptureImages(work, user, options)`** -- capture screenshots for all items using the screenshot facade. Returns `BulkCaptureResultDto` with success/failure counts.
- **`updateDomainType(work, user)`** -- use AI to classify the work's content domain (`software`, `ecommerce`, `services`, `general`).
- **`regenerateMarkdown(work, user)`** -- regenerate all markdown files from current data.
- **`updateReadme(work, user)`** -- update only the README.md file.
- **`updateWebsiteRepository(work, user)`** -- sync website repository with latest data.
- **`runScheduledUpdate(work, user)`** -- execute a scheduled update cycle (generate, markdown, deploy).

**Generation history tracking:**

Each generation run creates a `WorkGenerationHistory` record with timestamps, status, error details, and item counts. Status updates are persisted to the `generateStatus` JSON column on the work entity throughout the run.

### `DataGeneratorService`

The lower-level orchestration service that manages pipeline execution for data generation:

- **`initialize(work, user)`** -- set up a new data repository with config and work structure.
- **`initializeWithImportedData(work, user, importData)`** -- initialize from imported data (used by the import system).
- **`generate(work, user, options)`** -- run the generation pipeline, writing results to the data repository.
- **`saveCategories(...)` / `saveTags(...)` / `saveCollections(...)`** -- persist taxonomy data to the data repository.

**Types:**

```typescript
interface InitializeResult {
    success: true;
} | {
    success: false;
    error: InitializeError;
}

interface GenerationStats {
    itemsGenerated: number;
    itemsUpdated: number;
    itemsFailed: number;
    duration: number;
}
```

### `DataRepository`

A file-system abstraction over a Git-cloned data repository. Provides methods to read/write items, categories, tags, collections, and configuration in the standard Ever Works data format (YAML config, item works with `data.json` and `content.md`).

### `MarkdownGeneratorService`

Generates and manages the markdown/README repository:

- **`initialize(work, user)`** -- create the markdown repository from a template.
- **`regenerate(work, user)`** -- rebuild all markdown files from current data.
- **`updateReadme(work, user)`** -- regenerate only the README.

### `WebsiteGeneratorService`

Manages the Next.js website repository:

- **`initialize(work, user)`** -- create the website repository from a template.
- **`updateFromData(work, user)`** -- sync website content with the latest data repository state.

## API Reference

### WorkGenerationService

```typescript
generateItems(
    work: Work,
    user: User,
    options?: { aiProviderOverride?: string; inProcess?: boolean }
): Promise<{ runId?: string; inProcess?: boolean }>

updateItemsGenerator(
    work: Work,
    user: User,
    options?: UpdateItemsGeneratorOptions
): Promise<void>

submitItem(work: Work, user: User, itemData: SubmitItemDto): Promise<void>
removeItem(work: Work, user: User, itemSlug: string): Promise<void>
updateItemMetadata(work: Work, user: User, slug: string, metadata: object): Promise<void>
extractItemDetails(work: Work, user: User, url: string): Promise<ExtractedItemDetails>

bulkCaptureImages(
    work: Work,
    user: User,
    options: BulkCaptureImagesDto
): Promise<BulkCaptureImagesResponseDto>

updateDomainType(work: Work, user: User): Promise<void>
regenerateMarkdown(work: Work, user: User): Promise<void>
updateReadme(work: Work, user: User): Promise<void>
updateWebsiteRepository(work: Work, user: User): Promise<void>
runScheduledUpdate(work: Work, user: User): Promise<void>
```

### DataGeneratorService

```typescript
initialize(work: Work, user: User): Promise<InitializeResult>
initializeWithImportedData(
    work: Work,
    user: User,
    data: ImportedData
): Promise<InitializeResult>
generate(work: Work, user: User, options?: GenerateOptions): Promise<GenerationStats>
saveCategories(work: Work, user: User, categories: Category[]): Promise<void>
saveTags(work: Work, user: User, tags: Tag[]): Promise<void>
saveCollections(work: Work, user: User, collections: Collection[]): Promise<void>
```

## Configuration

### Generation Status Tracking

The `generateStatus` JSON field on the Work entity tracks progress per phase:

```typescript
interface GenerateStatus {
	phase: 'initializing' | 'generating' | 'enriching' | 'capturing' | 'finalizing' | 'complete' | 'error';
	progress?: number; // 0-100 percentage
	message?: string; // Human-readable status message
	error?: string; // Error message if phase === 'error'
	itemsProcessed?: number;
	itemsTotal?: number;
}
```

### Dispatch Configuration

Generation can be dispatched to background workers via the `DIRECTORY_GENERATION_DISPATCHER` token:

```typescript
interface WorkGenerationPayload {
	workId: string;
	userId: string;
	options?: {
		aiProviderOverride?: string;
	};
}
```

The dispatcher is injected via a Symbol token, allowing the API layer to provide the Trigger.dev implementation.

### BulkCaptureImagesDto

```typescript
interface BulkCaptureImagesDto {
	overwrite?: boolean; // Re-capture existing screenshots
	limit?: number; // Max items to capture
	filter?: 'missing' | 'all';
}
```

## Dependencies

| Dependency                        | Purpose                                               |
| --------------------------------- | ----------------------------------------------------- |
| `@ever-works/agent/pipeline`      | Pipeline orchestration for generation steps           |
| `@ever-works/agent/facades`       | AI, Git, Screenshot, Search, ContentExtractor facades |
| `@ever-works/agent/database`      | Work, GenerationHistory repositories                  |
| `@ever-works/agent/notifications` | Error and completion notifications                    |
| `@ever-works/agent/subscriptions` | Plan-based generation limits                          |
| `isomorphic-git`                  | Local git operations for data repositories            |
| `Trigger.dev`                     | Background job dispatch (via dispatcher interface)    |

## Usage Examples

### Running a Full Generation

```typescript
import { WorkGenerationService } from '@ever-works/agent/services';

// Dispatched to Trigger.dev (production)
const { runId } = await generationService.generateItems(work, user, {
	aiProviderOverride: 'openai'
});

// In-process execution (development)
await generationService.generateItems(work, user, {
	inProcess: true
});
```

### Bulk Screenshot Capture

```typescript
const result = await generationService.bulkCaptureImages(work, user, {
	filter: 'missing', // Only capture items without screenshots
	limit: 50
});

console.log(`Captured: ${result.captured}, Failed: ${result.failed}`);
```

### Scheduled Update Cycle

```typescript
// Executed by the scheduler -- runs generation, markdown rebuild, and deployment
await generationService.runScheduledUpdate(work, user);
```
