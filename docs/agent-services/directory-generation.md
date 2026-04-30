---
id: directory-generation
title: Directory Generation Service
sidebar_label: Directory Generation
sidebar_position: 2
---

# Directory Generation Service

The `DirectoryGenerationService` is the central orchestrator for all content generation operations within a directory. It coordinates data generation, markdown rendering, website scaffolding, item submission, image capture, and scheduled updates.

**Source:** `packages/agent/src/services/directory-generation.service.ts`

## Overview

This service handles both initial generation (creating items from scratch) and incremental updates (adding new items or refreshing existing ones). It supports both synchronous (in-process) and asynchronous (dispatched to Trigger.dev) execution modes.

| Operation | Required Role | Description |
|-----------|--------------|-------------|
| `generateItems` | Editor | Triggers initial item generation from a prompt |
| `updateItemsGenerator` | Editor | Re-runs generation with updated parameters |
| `submitItem` | Editor | Submits a single item to the directory |
| `removeItem` | Editor | Removes a single item from the directory |
| `updateItemMetadata` | Editor | Updates metadata (featured, order) on an existing item |
| `regenerateMarkdown` | Editor | Recreates the markdown repository from data |
| `updateReadme` | Editor | Updates the README from markdown templates |
| `updateWebsiteRepository` | Editor | Pushes latest changes to the website repository |
| `bulkCaptureImages` | Editor | Captures screenshots for items missing images |
| `updateDomainType` | Editor | Sets the domain classification for a directory |
| `runScheduledUpdate` | System | Executes a scheduled generation run |

## Generation Pipeline

### Initial Generation (`generateItems`)

The `generateItems` method performs these steps:

1. **Access check** -- Verifies the user has Editor or higher role via `ownershipService.ensureCanEdit()`.
2. **Provider preparation** -- Auto-enables selected plugins, validates providers, and processes form configuration.
3. **History record** -- Creates a `DirectoryGenerationHistory` entry with status `GENERATING`.
4. **Dispatch or run** -- Based on `awaitCompletion`, either runs in-process or dispatches to the background task system.
5. **Returns** an `ItemsGeneratorResponseDto` with status `pending` and the history ID.

```typescript
const result = await generationService.generateItems(
    directoryId,
    {
        name: 'AI Tools Directory',
        prompt: 'Find the best AI developer tools',
        generation_method: GenerationMethod.CREATE_UPDATE,
        providers: { ai: 'openai', search: 'exa' },
    },
    user,
    true, // awaitCompletion
);
```

### Update Generation (`updateItemsGenerator`)

The update path reuses previous configuration merged with new overrides:

1. Loads `last_request_data` from the data repository config.
2. For scheduled triggers, uses `initial_prompt` instead of the last run prompt to prevent drift.
3. Applies safe per-run defaults: `generation_method: CREATE_UPDATE`, `update_with_pull_request: true`.
4. Deep-merges provider overrides.
5. For schedule-triggered runs, applies conservative config limits (e.g., `max_search_queries: 10`).

### Trigger Context

Every generation carries a `GenerationTriggerContext`:

```typescript
interface GenerationTriggerContext {
    triggeredBy: 'user' | 'api' | 'schedule';
    scheduleId?: string;
    billingMode?: DirectoryScheduleBillingMode;
}
```

This context determines error handling behavior, billing, and whether the run updates schedule state.

## Execution Modes

### In-Process Generation

When `awaitCompletion` is `true`, the full pipeline runs within the request lifecycle:

1. Sets directory status to `GENERATING`.
2. Calls `dataGenerator.initialize()` to run the AI pipeline.
3. On success with new/updated items, triggers `markdownGenerator.initialize()`.
4. If items exist, triggers `websiteGenerator.initialize()`.
5. Updates status to `GENERATED` or `ERROR` based on outcome.

### Background Dispatch

When `awaitCompletion` is `false`:

1. Immediately sets directory status to `GENERATING` for instant UI feedback.
2. Builds a `DirectoryGenerationPayload` and dispatches via `generationDispatcher`.
3. If dispatch fails, falls back to in-process execution (sequential for schedules, fire-and-forget for user triggers).

```typescript
interface DirectoryGenerationPayload {
    directoryId: string;
    userId: string;
    mode: 'create' | 'update';
    dto: CreateItemsGeneratorDto;
    historyId: string;
    historyStartedAt: string;
    triggerSource: string;
    scheduleId?: string;
}
```

## Item Operations

### Submit Item

Delegates to `ItemSubmissionService.submitItem()`, which creates a new item in the data repository. On success, triggers markdown regeneration with either `RECREATE` (if auto-merged) or `CREATE_UPDATE` method.

### Remove Item

Delegates to `ItemSubmissionService.removeItem()`, which removes an item directory from the data repository and triggers markdown regeneration with `CREATE_UPDATE` method.

### Update Item Metadata

Delegates to `ItemSubmissionService.updateItem()` for changing `featured` status or `order` on existing items.

## Bulk Image Capture

The `bulkCaptureImages` method processes multiple items to capture screenshots:

| Mode | Behavior |
|------|----------|
| `missing` | Only processes items without existing images |
| `all` | Processes all items with source URLs |

Items can be filtered by `itemSlugs`. The method returns aggregated statistics:

```typescript
interface BulkCaptureImagesResponseDto {
    status: 'success' | 'partial' | 'error';
    results: BulkCaptureResultDto[];
    totalProcessed: number;
    successCount: number;
    errorCount: number;
}
```

## Scheduled Updates

The `runScheduledUpdate` method handles schedule-triggered generation:

1. Resolves the user and validates plan entitlements.
2. For directories with a `sourceRepository`, delegates to `runScheduledSync()` which performs an import sync.
3. For standard directories, calls `updateItemsGenerator()` with schedule-specific overrides.

### Scheduled Sync Flow

Directories imported from external sources (e.g., awesome-lists) use a sync flow:

1. Creates a history record with `type: 'sync'`.
2. Sets directory status to `GENERATING` with step `syncing`.
3. Calls `directoryImportService.syncDirectory()`.
4. On success/failure, updates both the schedule and directory status.

## Error Handling and Notifications

Generation errors are classified using `classifyGenerationError()` and, for account-level issues, trigger notifications via `NotificationService.notifySchedulePaused()`. Error classifications help distinguish between transient failures (API rate limits), configuration issues (missing API keys), and unknown errors.

## Events

On generation completion (success or failure), the service emits:

```typescript
this.eventEmitter.emit(
    DirectoryGenerationCompletedEvent.EVENT_NAME,
    new DirectoryGenerationCompletedEvent(directory),
);
```

Downstream listeners can use this event to trigger post-generation workflows such as deployment or cache invalidation.
