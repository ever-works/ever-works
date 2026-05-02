---
id: history-ui
title: Generation History
sidebar_label: History UI
sidebar_position: 18
---

# Generation History

The History UI displays a chronological record of all AI-powered work generation runs, including status, duration, item counts, token usage, and links to Trigger.dev run logs. It supports paginated loading for works with extensive generation histories.

## Component Hierarchy

```
WorkHistoryPage (server component)
  |
  +-- WorkHistoryPageClient
        |
        +-- Page header (title + subtitle)
        |
        +-- HistoryEmptyState (if no entries)
        |
        +-- HistoryTable
        |     +-- Table header row
        |     +-- Table body rows (per entry)
        |           +-- Status badge (color-coded)
        |           +-- Trigger.dev run link
        |           +-- ShowDateTime component
        |           +-- Duration (formatted)
        |           +-- New / Updated / Total item counts
        |           +-- Token usage (formatted)
        |
        +-- "Load More" button (if hasMore)
```

## Key Components

### WorkHistoryPageClient

**File**: `apps/web/src/components/works/detail/history/WorkHistoryPageClient.tsx`

The client-side container that manages paginated history loading.

```typescript
interface WorkHistoryPageClientProps {
	workId: string;
	initialHistory: WorkGenerationHistoryResponse | null;
}

interface WorkGenerationHistoryResponse {
	history: WorkGenerationHistoryEntry[];
	total: number;
	limit: number;
	offset: number;
}
```

**State Management**:

| State       | Type                           | Purpose                           |
| ----------- | ------------------------------ | --------------------------------- |
| `entries`   | `WorkGenerationHistoryEntry[]` | Accumulated history entries       |
| `total`     | `number`                       | Total count from server           |
| `limit`     | `number`                       | Page size (default: 20)           |
| `offset`    | `number`                       | Current cursor position           |
| `isPending` | `boolean`                      | Loading state via `useTransition` |

**Pagination Flow**:

1. Initial data is provided by the server component via `initialHistory` prop
2. `hasMore` is computed as `entries.length < total`
3. Clicking "Load More" calls `fetchWorkGenerationHistory(workId, { limit, offset })`
4. New entries are appended to the existing list
5. Offset is advanced by the number of returned entries

### HistoryTable

**File**: `apps/web/src/components/works/detail/history/HistoryTable.tsx`

A data table displaying generation run details with formatted metrics.

```typescript
interface HistoryTableProps {
	entries: WorkGenerationHistoryEntry[];
	locale: string;
}
```

**Table Columns**:

| Column        | Field                       | Formatting                           |
| ------------- | --------------------------- | ------------------------------------ |
| Run           | `status`, `triggerRunId`    | Color-coded badge + Trigger.dev link |
| Started At    | `startedAt` or `createdAt`  | `ShowDateTime` component             |
| Duration      | `durationInSeconds`         | `formatDuration()` (h/m/s)           |
| New Items     | `newItemsCount`             | Raw number                           |
| Updated Items | `updatedItemsCount`         | Raw number                           |
| Total Items   | `totalItemsCount`           | Raw number                           |
| Tokens        | `metrics.total_tokens_used` | `formatTokens()` (K/M suffix)        |

**Status Color Mapping**:

| Status       | Badge Colors                           |
| ------------ | -------------------------------------- |
| `generating` | Blue background, blue text             |
| `generated`  | Emerald/green background, emerald text |
| `error`      | Red background, red text               |
| `cancelled`  | Gray background, gray text             |

**Formatting Utilities**:

```typescript
// Duration: seconds -> human-readable
formatDuration(3661); // "1h 1m"
formatDuration(125); // "2m 5s"
formatDuration(45); // "45s"
formatDuration(0); // "---"

// Tokens: number -> compact notation
formatTokens(1500000); // "1.5M"
formatTokens(45000); // "45.0K"
formatTokens(500); // "500"

// Cost: number -> USD format (currently hidden in UI)
formatCost(0.0234); // "$0.0234"
```

### HistoryEmptyState

**File**: `apps/web/src/components/works/detail/history/HistoryEmptyState.tsx`

A centered empty state with a dashed border, title, and description text. Shown when no generation history exists for the work.

### WorkGenerationHistoryEntry

The data model for each history row:

```typescript
interface WorkGenerationHistoryEntry {
	id: string;
	status: 'generating' | 'generated' | 'error' | 'cancelled';
	startedAt?: string; // ISO datetime
	createdAt: string; // ISO datetime
	durationInSeconds?: number;
	newItemsCount: number;
	updatedItemsCount: number;
	totalItemsCount: number;
	triggerRunId?: string; // Links to Trigger.dev dashboard
	metrics?: {
		total_tokens_used?: number;
		total_cost?: number; // USD, currently hidden in UI
	};
}
```

## Trigger.dev Integration

When a `triggerRunId` is present on a history entry, the table renders a clickable link to the Trigger.dev run dashboard:

```
https://cloud.trigger.dev/runs/{triggerRunId}
```

This provides deep observability into the generation pipeline:

- Step-by-step task execution timeline
- Structured log output from `TriggerLogger`
- Error details and stack traces for failed runs
- Duration breakdown by orchestration step

## State Management Pattern

```
Server Component (fetches initial history)
  |
  +-- WorkHistoryPageClient
        |-- entries: WorkGenerationHistoryEntry[]  (append-only growth)
        |-- total: number                                (from server response)
        |-- offset: number                               (tracks pagination cursor)
        |-- isPending: boolean                           (useTransition loading)
        |
        +-- HistoryTable (stateless, receives entries)
        +-- HistoryEmptyState (stateless, conditional render)
```

The component uses an append-only pattern for pagination: new entries are concatenated to the existing array, and `hasMore` is recomputed from the total count. This avoids refetching already-loaded data.

## Related API Endpoints

| Action                    | Server Action Function                                  | HTTP Method |
| ------------------------- | ------------------------------------------------------- | ----------- |
| Fetch history (paginated) | `fetchWorkGenerationHistory(workId, { limit, offset })` | GET         |

## Internationalization

All strings use `next-intl` with the namespace `dashboard.workDetail.history`:

- `title`, `subtitle` -- page header
- `table.run`, `table.startedAt`, `table.duration`, `table.newItems`, `table.updatedItems`, `table.totalItems`, `table.tokens` -- column headers
- `status.generating`, `status.generated`, `status.error`, `status.cancelled` -- status labels
- `loadMore` -- pagination button
- `error` -- error toast message
- `empty.title`, `empty.description` -- empty state text

## Cross-References

- [Performance Monitoring](../devops/performance-monitoring.md) -- generation metrics in PostHog dashboards
- [Logging & Aggregation](../devops/logging-aggregation.md) -- TriggerLogger for task-level logs
- [Schedule UI](./schedule-ui.md) -- scheduled runs appear as history entries
- [Items Management UI](./items-ui.md) -- items created/updated during generation
