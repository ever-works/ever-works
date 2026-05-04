---
id: community-pr-service
title: 'CommunityPrProcessorService Deep Dive'
sidebar_label: 'Community PR'
sidebar_position: 17
---

# CommunityPrProcessorService Deep Dive

## Overview

The `CommunityPrProcessorService` automates the processing of community pull requests submitted to work repositories. It scans open PRs for new item submissions, uses AI to extract structured work items from PR diffs, writes them to the data repository, and optionally auto-closes processed PRs. This enables a fully automated community contribution pipeline.

## Architecture

The service operates as a batch processor, typically triggered by a cron job. It iterates over all works with community PR processing enabled, fetches their open PRs, and processes each unprocessed PR through an AI extraction pipeline.

```
Cron Job / Scheduled Task
        |
        v
CommunityPrProcessorService.processAllWorks()
        |
        +-- WorkRepository.findWithCommunityPrEnabled()
        |
        +-- For each work:
                |
                +-- processWork(work, state, autoClose)
                        |
                        +-- GitFacade.listPullRequests()  --> get open PRs
                        |
                        +-- Filter out already-processed PR numbers
                        |
                        +-- For each unprocessed PR:
                                |
                                +-- processSinglePr()
                                        |
                                        +-- GitFacade.getPullRequestFiles()
                                        +-- Build change context from patches
                                        +-- Clone/pull data repo
                                        +-- AI extraction via AiFacade.askJson()
                                        +-- Write items to DataRepository
                                        +-- Git add/commit/push
                                        +-- Comment on PR
                                        +-- Optionally close PR
```

## API Reference

### Methods

#### `processAllWorks()`

Processes open PRs for all works that have community PR processing enabled.

**Returns:** `Promise<CommunityPrProcessingResult>`

```typescript
interface CommunityPrProcessingResult {
	processed: number; // total items added across all works
	errors: Array<{
		workId: string;
		error: string;
	}>;
}
```

#### `processWork(work, state?, autoClose?)`

Processes open PRs for a single work.

| Parameter   | Type                          | Description                                                           |
| ----------- | ----------------------------- | --------------------------------------------------------------------- |
| `work`      | `Work`                        | The work entity to process                                            |
| `state`     | `CommunityPrState` (optional) | Existing processing state; loaded from work if not provided           |
| `autoClose` | `boolean` (optional)          | Whether to auto-close processed PRs; loaded from work if not provided |

**Returns:** `Promise<number>` -- total items added from all processed PRs.

## Implementation Details

### State Management

The service tracks processing state in the `communityPrState` field on the work entity:

```typescript
interface CommunityPrState {
	processedPrNumbers: number[]; // PR numbers already processed
	totalItemsAdded: number; // running total of items added
	lastProcessedAt?: string; // ISO timestamp of last processing run
	lastError?: string; // error message from last failure
}
```

### Bounded State Growth

To prevent unbounded growth of `processedPrNumbers`, the array is capped at `MAX_PROCESSED_PR_NUMBERS` (500). When exceeded, older entries are trimmed from the beginning, keeping only the most recent 500 PR numbers.

### Change Context Extraction

For each PR, the service:

1. Fetches all file changes via `GitFacade.getPullRequestFiles()`
2. Builds a change context string from file patches (diffs)
3. Caps the total context at `MAX_CHANGE_CONTEXT_LENGTH` (50,000 characters) to stay within AI token limits

### AI Item Extraction

The extraction prompt includes:

- Work name and description for context
- Existing category names for proper categorization
- PR title, body, and diff content
- Instructions to extract items with name, description, source URL, category, and tags

The output is validated against a Zod schema:

```typescript
z.object({
	items: z.array(
		z.object({
			name: z.string(),
			description: z.string(),
			source_url: z.string(),
			category: z.string(),
			tags: z.array(z.string())
		})
	)
});
```

### Data Repository Updates

Extracted items are written to the data repository using slugified names as work paths. Each item gets:

- A JSON data file with structured metadata
- A markdown file with formatted content

Changes are committed with a descriptive message and pushed to the remote.

### PR Interaction

The service posts comments on PRs at multiple stages:

- **No changes detected:** Informational comment asking contributor to ensure additions exist
- **No items extracted:** Comment explaining changes appear to be non-item updates
- **Items added:** Comment listing all added items by name
- **Auto-close:** Closes the PR after successful processing (if enabled)

## Database Interactions

| Repository       | Method                               | Purpose                                  |
| ---------------- | ------------------------------------ | ---------------------------------------- |
| `WorkRepository` | `findWithCommunityPrEnabled()`       | Find all works with community PR enabled |
| `WorkRepository` | `update(id, { communityPrState })`   | Persist updated processing state         |
| `WorkRepository` | `increment(id, 'itemsCount', count)` | Atomically increment item count          |

## Event System

This service does not emit domain events. PR processing results are tracked via the `communityPrState` on the work entity.

## Error Handling

- **Per-work isolation:** Each work is processed in its own try-catch. A failure in one work does not block others.
- **Per-PR isolation:** Each PR is processed in its own try-catch. Failed PRs have their error recorded in `state.lastError` and their PR number is still added to `processedPrNumbers` to prevent retry loops.
- **Empty patches:** PRs with no meaningful patch content receive a comment and are counted as processed.
- **AI extraction failures:** Caught and logged; the PR is marked as processed to avoid infinite retries.

## Usage Examples

```typescript
// Process all works (cron job)
const result = await communityPrProcessor.processAllWorks();
console.log(`Added ${result.processed} items`);
console.log(`Errors: ${result.errors.length}`);

// Process a single work
const itemsAdded = await communityPrProcessor.processWork(work);
```

## Configuration

| Setting                     | Value    | Description                                   |
| --------------------------- | -------- | --------------------------------------------- |
| `MAX_PROCESSED_PR_NUMBERS`  | 500      | Maximum tracked PR numbers before trimming    |
| `MAX_CHANGE_CONTEXT_LENGTH` | 50,000   | Maximum characters of diff context sent to AI |
| `communityPrEnabled`        | per-work | Feature flag on the work entity               |
| `communityPrAutoClose`      | per-work | Whether to close PRs after processing         |
| AI temperature              | 0.3      | Slightly creative for extraction flexibility  |

## Related Services

- [Work Import Service](/agent-services/work-import-service) -- alternative data ingestion path
- [Import System](/agent-services/import-system) -- used by import service for similar data extraction patterns
