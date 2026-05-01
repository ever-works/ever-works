---
id: directory-operations-module
title: Directory Operations Module
sidebar_label: Directory Operations
sidebar_position: 41
---

# Directory Operations Module

The Directory Operations Module (`@ever-works/agent/directory-operations`) provides a centralized service layer for managing directory lifecycle state during content generation. It handles generation status tracking, pull request metadata, generation timing, event emission, and generation history persistence.

## Overview

| Property                | Value                                      |
| ----------------------- | ------------------------------------------ |
| **Import path**         | `@ever-works/agent/directory-operations`   |
| **Source location**     | `packages/agent/src/directory-operations/` |
| **NestJS module**       | `DirectoryOperationsModule`                |
| **Primary service**     | `DirectoryOperationsService`               |
| **Database dependency** | `DatabaseModule` (TypeORM repositories)    |

The module acts as the single point of truth for all directory state mutations that occur during AI-powered content generation, import operations, and scheduled updates. Other modules -- such as the generators, import system, and pipeline -- depend on this module to record progress and outcomes.

## Module Structure

```
packages/agent/src/directory-operations/
├── index.ts                              # Barrel exports
├── directory-operations.module.ts        # NestJS module definition
└── directory-operations.service.ts       # Core service + helper functions
```

## Module Registration

`DirectoryOperationsModule` imports `DatabaseModule` and provides `DirectoryOperationsService` as an injectable singleton:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { DirectoryOperationsService } from './directory-operations.service';

@Module({
	imports: [DatabaseModule],
	providers: [DirectoryOperationsService],
	exports: [DirectoryOperationsService, DatabaseModule]
})
export class DirectoryOperationsModule {}
```

Both `DirectoryOperationsService` and the underlying `DatabaseModule` are re-exported so consumers gain access to repository classes without importing `DatabaseModule` separately.

## Key Classes and Services

### DirectoryOperationsService

The central `@Injectable()` service that coordinates directory state changes. It depends on three injected collaborators:

| Dependency                             | Description                                                     |
| -------------------------------------- | --------------------------------------------------------------- |
| `DirectoryRepository`                  | TypeORM repository for the `directories` table                  |
| `DirectoryGenerationHistoryRepository` | TypeORM repository for the `directory_generation_history` table |
| `EventEmitter2` (optional)             | NestJS event emitter for broadcasting lifecycle events          |

The `EventEmitter2` dependency is marked `@Optional()`, which allows the service to function in contexts where the event-emitter module is not registered (such as unit tests or CLI tools).

## API Reference

### DirectoryOperationsService Methods

| Method                       | Signature                                                                                          | Description                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updateDirectory`            | `(id: string, updateData: Partial<Directory>) => Promise<void>`                                    | Applies a partial update to any fields on the `Directory` entity.                                                                                 |
| `getGenerateStatus`          | `(id: string) => Promise<GenerateStatus \| undefined>`                                             | Retrieves the current generation status object for a directory. Returns `undefined` if the directory is not found.                                |
| `updateGenerateStatus`       | `(id: string, status: GenerateStatus) => Promise<void>`                                            | Persists a new generation status. Automatically deduplicates the `warnings` array if present.                                                     |
| `updateLastPullRequest`      | `(id: string, payload: { main?: PRUpdate; data?: PRUpdate }) => Promise<void>`                     | Records metadata about the most recent pull request(s) created during generation.                                                                 |
| `recordGenerationStartTime`  | `(id: string, startedAt: Date) => Promise<void>`                                                   | Stamps the `generationStartedAt` timestamp on the directory record.                                                                               |
| `recordGenerationFinishTime` | `(id: string, finishedAt: Date) => Promise<void>`                                                  | Stamps the `generationFinishedAt` timestamp on the directory record.                                                                              |
| `emitGenerationCompleted`    | `(directoryId: string) => Promise<void>`                                                           | Emits a `DirectoryGenerationCompletedEvent` via the event emitter. No-ops gracefully if the emitter is unavailable or the directory is not found. |
| `updateGenerationHistory`    | `(directoryId: string, historyId: string, updates: GenerationHistoryUpdateInput) => Promise<void>` | Updates a specific generation history entry with status, item counts, metrics, and timing data.                                                   |

### Helper Functions

Two standalone utility functions convert generation results into the `GenerationHistoryUpdateInput` shape:

#### `buildStatsUpdate`

```typescript
function buildStatsUpdate(
	stats: GenerationStats | null | undefined
): Pick<GenerationHistoryUpdateInput, 'newItemsCount' | 'updatedItemsCount' | 'totalItemsCount' | 'metrics'>;
```

Transforms a `GenerationStats` object (from `data-generator`) into a partial update suitable for `updateGenerationHistory`. Defaults numeric fields to `0` when the input is null or undefined.

#### `buildImportStatsUpdate`

```typescript
function buildImportStatsUpdate(
	result: DirectoryImportResult | null | undefined
): Pick<GenerationHistoryUpdateInput, 'newItemsCount' | 'updatedItemsCount' | 'totalItemsCount' | 'metrics'>;
```

Transforms a `DirectoryImportResult` (from the import system) into the same partial update shape. Extracts token usage and cost metrics from the import result when available.

### GenerationHistoryUpdateInput Type

The type used to update generation history entries:

```typescript
type GenerationHistoryUpdateInput = {
	status?: GenerateStatusType;
	newItemsCount?: number;
	updatedItemsCount?: number;
	totalItemsCount?: number;
	startedAt?: Date | null;
	finishedAt?: Date | null;
	durationInSeconds?: number | null;
	errorMessage?: string | null;
	metrics?: GenerationMetrics | null;
	parameters?: Record<string, any> | null;
};
```

### GenerationMetrics Type

Tracks resource consumption for a generation run:

```typescript
type GenerationMetrics = {
	urls_scanned?: number;
	pages_processed?: number;
	items_extracted_current_run?: number;
	new_items_added_to_store?: number;
	total_items_in_store?: number;
	total_tokens_used?: number;
	total_cost?: number;
};
```

## Events

The module emits the following event when generation completes:

| Event                            | Constant                                       | Payload                                                                    |
| -------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `directory.generation.completed` | `DirectoryGenerationCompletedEvent.EVENT_NAME` | `DirectoryGenerationCompletedEvent` containing the full `Directory` entity |

Listeners can subscribe via the NestJS `@OnEvent()` decorator:

```typescript
import { OnEvent } from '@nestjs/event-emitter';
import { DirectoryGenerationCompletedEvent } from '@ever-works/agent/events';

@Injectable()
export class NotificationListener {
	@OnEvent(DirectoryGenerationCompletedEvent.EVENT_NAME)
	handleGenerationCompleted(event: DirectoryGenerationCompletedEvent) {
		const directory = event.directory;
		// Send notification, update dashboards, etc.
	}
}
```

## Configuration

The module itself requires no explicit configuration. It inherits database connection settings from the `DatabaseModule` that it imports. Ensure that the following entities are registered in your TypeORM configuration:

- `Directory` (table: `directories`)
- `DirectoryGenerationHistory` (table: `directory_generation_history`)

## Dependencies

| Dependency                                          | Type                       | Purpose                                                                   |
| --------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `DatabaseModule`                                    | NestJS module              | Provides `DirectoryRepository` and `DirectoryGenerationHistoryRepository` |
| `@nestjs/event-emitter`                             | Peer dependency (optional) | Enables `emitGenerationCompleted` event broadcasting                      |
| `@src/entities/directory.entity`                    | Entity                     | The `Directory` TypeORM entity                                            |
| `@src/entities/directory-generation-history.entity` | Entity                     | The `DirectoryGenerationHistory` TypeORM entity                           |
| `@src/events`                                       | Event classes              | `DirectoryGenerationCompletedEvent`                                       |
| `@src/generators/data-generator`                    | Type import                | `GenerationStats` type                                                    |
| `@src/tasks/directory-import.types`                 | Type import                | `DirectoryImportResult` type                                              |

## Usage Examples

### Recording a Full Generation Lifecycle

```typescript
import { DirectoryOperationsService, buildStatsUpdate } from '@ever-works/agent/directory-operations';

@Injectable()
export class GenerationOrchestrator {
	constructor(private readonly dirOps: DirectoryOperationsService) {}

	async runGeneration(directoryId: string, historyId: string) {
		const startedAt = new Date();

		// Mark generation as started
		await this.dirOps.recordGenerationStartTime(directoryId, startedAt);
		await this.dirOps.updateGenerateStatus(directoryId, {
			type: 'generating',
			message: 'Content generation in progress'
		});

		try {
			// ... perform generation, obtain stats ...
			const stats = await this.generate(directoryId);

			// Record completion
			const finishedAt = new Date();
			await this.dirOps.recordGenerationFinishTime(directoryId, finishedAt);
			await this.dirOps.updateGenerationHistory(directoryId, historyId, {
				status: 'completed',
				finishedAt,
				durationInSeconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
				...buildStatsUpdate(stats)
			});

			// Notify listeners
			await this.dirOps.emitGenerationCompleted(directoryId);
		} catch (error) {
			await this.dirOps.updateGenerationHistory(directoryId, historyId, {
				status: 'failed',
				errorMessage: error.message,
				finishedAt: new Date()
			});
		}
	}
}
```

### Recording Import Results

```typescript
import { buildImportStatsUpdate } from '@ever-works/agent/directory-operations';

// After an import completes
const importResult = await importService.importDirectory(source);

await dirOps.updateGenerationHistory(directoryId, historyId, {
	status: 'completed',
	finishedAt: new Date(),
	...buildImportStatsUpdate(importResult)
});
```

### Updating Pull Request Metadata

```typescript
await dirOps.updateLastPullRequest(directoryId, {
	main: { number: 42, url: 'https://github.com/org/repo/pull/42' },
	data: { number: 43, url: 'https://github.com/org/repo-data/pull/43' }
});
```

## Exports

The barrel `index.ts` re-exports all public API:

- `DirectoryOperationsService` -- The injectable service
- `DirectoryOperationsModule` -- The NestJS module
- `GenerationHistoryUpdateInput` -- Type for history updates
- `buildStatsUpdate` -- Helper for generation stats
- `buildImportStatsUpdate` -- Helper for import stats
