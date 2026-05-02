---
id: work-operations-module
title: Work Operations Module
sidebar_label: Work Operations
sidebar_position: 41
---

# Work Operations Module

The Work Operations Module (`@ever-works/agent/work-operations`) provides a centralized service layer for managing work lifecycle state during content generation. It handles generation status tracking, pull request metadata, generation timing, event emission, and generation history persistence.

## Overview

| Property                | Value                                   |
| ----------------------- | --------------------------------------- |
| **Import path**         | `@ever-works/agent/work-operations`     |
| **Source location**     | `packages/agent/src/work-operations/`   |
| **NestJS module**       | `WorkOperationsModule`                  |
| **Primary service**     | `WorkOperationsService`                 |
| **Database dependency** | `DatabaseModule` (TypeORM repositories) |

The module acts as the single point of truth for all work state mutations that occur during AI-powered content generation, import operations, and scheduled updates. Other modules -- such as the generators, import system, and pipeline -- depend on this module to record progress and outcomes.

## Module Structure

```
packages/agent/src/work-operations/
├── index.ts                              # Barrel exports
├── work-operations.module.ts        # NestJS module definition
└── work-operations.service.ts       # Core service + helper functions
```

## Module Registration

`WorkOperationsModule` imports `DatabaseModule` and provides `WorkOperationsService` as an injectable singleton:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { WorkOperationsService } from './work-operations.service';

@Module({
	imports: [DatabaseModule],
	providers: [WorkOperationsService],
	exports: [WorkOperationsService, DatabaseModule]
})
export class WorkOperationsModule {}
```

Both `WorkOperationsService` and the underlying `DatabaseModule` are re-exported so consumers gain access to repository classes without importing `DatabaseModule` separately.

## Key Classes and Services

### WorkOperationsService

The central `@Injectable()` service that coordinates work state changes. It depends on three injected collaborators:

| Dependency                        | Description                                                |
| --------------------------------- | ---------------------------------------------------------- |
| `WorkRepository`                  | TypeORM repository for the `works` table                   |
| `WorkGenerationHistoryRepository` | TypeORM repository for the `work_generation_history` table |
| `EventEmitter2` (optional)        | NestJS event emitter for broadcasting lifecycle events     |

The `EventEmitter2` dependency is marked `@Optional()`, which allows the service to function in contexts where the event-emitter module is not registered (such as unit tests or CLI tools).

## API Reference

### WorkOperationsService Methods

| Method                       | Signature                                                                                     | Description                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `updateWork`                 | `(id: string, updateData: Partial<Work>) => Promise<void>`                                    | Applies a partial update to any fields on the `Work` entity.                                                                            |
| `getGenerateStatus`          | `(id: string) => Promise<GenerateStatus \| undefined>`                                        | Retrieves the current generation status object for a work. Returns `undefined` if the work is not found.                                |
| `updateGenerateStatus`       | `(id: string, status: GenerateStatus) => Promise<void>`                                       | Persists a new generation status. Automatically deduplicates the `warnings` array if present.                                           |
| `updateLastPullRequest`      | `(id: string, payload: { main?: PRUpdate; data?: PRUpdate }) => Promise<void>`                | Records metadata about the most recent pull request(s) created during generation.                                                       |
| `recordGenerationStartTime`  | `(id: string, startedAt: Date) => Promise<void>`                                              | Stamps the `generationStartedAt` timestamp on the work record.                                                                          |
| `recordGenerationFinishTime` | `(id: string, finishedAt: Date) => Promise<void>`                                             | Stamps the `generationFinishedAt` timestamp on the work record.                                                                         |
| `emitGenerationCompleted`    | `(workId: string) => Promise<void>`                                                           | Emits a `WorkGenerationCompletedEvent` via the event emitter. No-ops gracefully if the emitter is unavailable or the work is not found. |
| `updateGenerationHistory`    | `(workId: string, historyId: string, updates: GenerationHistoryUpdateInput) => Promise<void>` | Updates a specific generation history entry with status, item counts, metrics, and timing data.                                         |

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
	result: WorkImportResult | null | undefined
): Pick<GenerationHistoryUpdateInput, 'newItemsCount' | 'updatedItemsCount' | 'totalItemsCount' | 'metrics'>;
```

Transforms a `WorkImportResult` (from the import system) into the same partial update shape. Extracts token usage and cost metrics from the import result when available.

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

| Event                       | Constant                                  | Payload                                                          |
| --------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `work.generation.completed` | `WorkGenerationCompletedEvent.EVENT_NAME` | `WorkGenerationCompletedEvent` containing the full `Work` entity |

Listeners can subscribe via the NestJS `@OnEvent()` decorator:

```typescript
import { OnEvent } from '@nestjs/event-emitter';
import { WorkGenerationCompletedEvent } from '@ever-works/agent/events';

@Injectable()
export class NotificationListener {
	@OnEvent(WorkGenerationCompletedEvent.EVENT_NAME)
	handleGenerationCompleted(event: WorkGenerationCompletedEvent) {
		const work = event.work;
		// Send notification, update dashboards, etc.
	}
}
```

## Configuration

The module itself requires no explicit configuration. It inherits database connection settings from the `DatabaseModule` that it imports. Ensure that the following entities are registered in your TypeORM configuration:

- `Work` (table: `works`)
- `WorkGenerationHistory` (table: `work_generation_history`)

## Dependencies

| Dependency                                     | Type                       | Purpose                                                         |
| ---------------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| `DatabaseModule`                               | NestJS module              | Provides `WorkRepository` and `WorkGenerationHistoryRepository` |
| `@nestjs/event-emitter`                        | Peer dependency (optional) | Enables `emitGenerationCompleted` event broadcasting            |
| `@src/entities/work.entity`                    | Entity                     | The `Work` TypeORM entity                                       |
| `@src/entities/work-generation-history.entity` | Entity                     | The `WorkGenerationHistory` TypeORM entity                      |
| `@src/events`                                  | Event classes              | `WorkGenerationCompletedEvent`                                  |
| `@src/generators/data-generator`               | Type import                | `GenerationStats` type                                          |
| `@src/tasks/work-import.types`                 | Type import                | `WorkImportResult` type                                         |

## Usage Examples

### Recording a Full Generation Lifecycle

```typescript
import { WorkOperationsService, buildStatsUpdate } from '@ever-works/agent/work-operations';

@Injectable()
export class GenerationOrchestrator {
	constructor(private readonly dirOps: WorkOperationsService) {}

	async runGeneration(workId: string, historyId: string) {
		const startedAt = new Date();

		// Mark generation as started
		await this.dirOps.recordGenerationStartTime(workId, startedAt);
		await this.dirOps.updateGenerateStatus(workId, {
			type: 'generating',
			message: 'Content generation in progress'
		});

		try {
			// ... perform generation, obtain stats ...
			const stats = await this.generate(workId);

			// Record completion
			const finishedAt = new Date();
			await this.dirOps.recordGenerationFinishTime(workId, finishedAt);
			await this.dirOps.updateGenerationHistory(workId, historyId, {
				status: 'completed',
				finishedAt,
				durationInSeconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
				...buildStatsUpdate(stats)
			});

			// Notify listeners
			await this.dirOps.emitGenerationCompleted(workId);
		} catch (error) {
			await this.dirOps.updateGenerationHistory(workId, historyId, {
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
import { buildImportStatsUpdate } from '@ever-works/agent/work-operations';

// After an import completes
const importResult = await importService.importWork(source);

await dirOps.updateGenerationHistory(workId, historyId, {
	status: 'completed',
	finishedAt: new Date(),
	...buildImportStatsUpdate(importResult)
});
```

### Updating Pull Request Metadata

```typescript
await dirOps.updateLastPullRequest(workId, {
	main: { number: 42, url: 'https://github.com/org/repo/pull/42' },
	data: { number: 43, url: 'https://github.com/org/repo-data/pull/43' }
});
```

## Exports

The barrel `index.ts` re-exports all public API:

- `WorkOperationsService` -- The injectable service
- `WorkOperationsModule` -- The NestJS module
- `GenerationHistoryUpdateInput` -- Type for history updates
- `buildStatsUpdate` -- Helper for generation stats
- `buildImportStatsUpdate` -- Helper for import stats
