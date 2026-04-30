# Trigger.dev Integration

## Overview

Ever Works uses [Trigger.dev](https://trigger.dev) for background job execution. The directory generation pipeline runs as a Trigger.dev task, allowing long-running operations (up to 5 hours) without blocking the API.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Layer                                │
│                                                                  │
│  DirectoryGenerationService.startGeneration()                   │
│      │                                                          │
│      ├── Create DirectoryGenerationHistory record               │
│      ├── Build DirectoryGenerationPayload                       │
│      └── Dispatch to Trigger.dev                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Trigger.dev                                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              directoryGenerationTask                      │   │
│  │                                                           │   │
│  │  id: 'directory-generation'                              │   │
│  │  maxDuration: 5 hours                                    │   │
│  │  machine: configurable (micro → large-2x)                │   │
│  │                                                           │   │
│  │  run(payload) → TriggerGenerationOrchestrator.run()      │   │
│  │  onCancel() → Handle cancellation                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Tags: ['directory-generation', mode, directoryId]              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  TriggerGenerationOrchestrator                   │
│                                                                  │
│  1. DataGeneratorService.initialize()                           │
│  2. MarkdownGeneratorService.initialize()                       │
│  3. WebsiteGeneratorService.initialize()                        │
│  4. Update DirectoryGenerationHistory with results              │
└─────────────────────────────────────────────────────────────────┘
```

## Payload Structure

```typescript
// /packages/agent/src/tasks/directory-generation.types.ts

export type DirectoryGenerationPayload = {
	directoryId: string; // UUID of directory
	userId: string; // UUID of user who triggered
	mode: DirectoryGenerationMode; // 'create' | 'update'
	dto: CreateItemsGeneratorDto; // Generation parameters
	historyId: string; // UUID for tracking
	historyStartedAt?: string; // ISO timestamp
	triggerSource?: 'user' | 'schedule' | 'api';
	scheduleId?: string; // If triggered by schedule
};
```

## Task Definition

```typescript
// /packages/tasks/src/tasks/trigger/directory-generation.task.ts

import { task } from '@trigger.dev/sdk/v3';

export const directoryGenerationTask = task({
	id: 'directory-generation',
	maxDuration: 3600 * 5, // 5 hours

	onCancel: async ({ payload }) => {
		// Update history status to CANCELLED
		// Clean up resources
	},

	run: async (payload: DirectoryGenerationPayload) => {
		const orchestrator = new TriggerGenerationOrchestrator();
		return orchestrator.run(payload);
	}
});
```

## Dispatch Service

```typescript
// /packages/tasks/src/trigger/trigger.service.ts

@Injectable()
export class TriggerService {
	async dispatchGeneration(
		payload: DirectoryGenerationPayload,
		options?: DispatchOptions
	): Promise<{ taskId: string }> {
		const handle = await tasks.trigger('directory-generation', payload, {
			tags: ['directory-generation', payload.mode, payload.directoryId],
			machine: options?.machine || 'medium-1x'
		});

		return { taskId: handle.id };
	}

	async cancelGeneration(taskId: string): Promise<void> {
		await runs.cancel(taskId);
	}

	async getRunStatus(taskId: string): Promise<RunStatus> {
		return runs.retrieve(taskId);
	}
}
```

## Machine Types

| Machine     | vCPU | Memory | Use Case          |
| ----------- | ---- | ------ | ----------------- |
| `micro`     | 0.25 | 256MB  | Testing           |
| `small-1x`  | 0.5  | 512MB  | Small directories |
| `small-2x`  | 1    | 1GB    | Default           |
| `medium-1x` | 1    | 2GB    | **Recommended**   |
| `medium-2x` | 2    | 4GB    | Large directories |
| `large-1x`  | 2    | 8GB    | Very large        |
| `large-2x`  | 4    | 16GB   | Maximum           |

## Status Tracking

Generation status is tracked in `DirectoryGenerationHistory`:

```typescript
enum GenerateStatusType {
	NOT_STARTED = 'not_started',
	GENERATING = 'generating',
	GENERATED = 'generated',
	ERROR = 'error',
	CANCELLED = 'cancelled'
}
```

Status updates happen at:

1. **Start**: API sets `GENERATING`
2. **Success**: Orchestrator sets `GENERATED`
3. **Failure**: Orchestrator sets `ERROR` with message
4. **Cancel**: `onCancel` sets `CANCELLED`

## Environment Variables

```bash
# Required for Trigger.dev
TRIGGER_SECRET_KEY=tr_dev_xxx      # API key
TRIGGER_API_URL=https://api.trigger.dev  # API endpoint

# Optional
TRIGGER_MACHINE=medium-1x          # Default machine type
```

## Cancellation Handling

Users can cancel running generations:

```typescript
// API endpoint
@Delete('directories/:id/generation')
async cancelGeneration(@Param('id') id: string) {
    const history = await this.historyService.getLatest(id);
    if (history?.triggerTaskId) {
        await this.triggerService.cancelGeneration(history.triggerTaskId);
    }
}

// In task definition
onCancel: async ({ payload }) => {
    await updateHistoryStatus(payload.historyId, 'cancelled');
    await cleanupResources(payload.directoryId);
}
```

## Retry Behavior

Trigger.dev automatically retries failed tasks:

- **Default**: 3 retries with exponential backoff
- **Custom**: Can be configured per task

```typescript
export const directoryGenerationTask = task({
	id: 'directory-generation',
	retry: {
		maxAttempts: 3,
		factor: 2,
		minTimeoutInMs: 1000,
		maxTimeoutInMs: 30000
	}
	// ...
});
```

## Scheduled Runs

For scheduled directories, Trigger.dev cron jobs dispatch generations:

```typescript
// Schedule configuration stored in Directory entity
interface DirectorySchedule {
	enabled: boolean;
	cadence: 'hourly' | 'daily' | 'weekly' | 'monthly';
	maxFailures: number;
	failureCount: number;
	lastRun?: Date;
	nextRun?: Date;
}
```

## File Locations

```
/packages/tasks/src/
├── tasks/
│   └── trigger/
│       └── directory-generation.task.ts   # Task definition
├── trigger/
│   ├── trigger.service.ts                 # Dispatch service
│   ├── trigger-generation.orchestrator.ts # Orchestration
│   └── trigger-worker.module.ts           # NestJS module
└── index.ts                               # Exports
```

## Development vs Production

### Development

```bash
# Start Trigger.dev dev server
pnpm dev:trigger

# Tasks run locally with hot reload
```

### Production

```bash
# Deploy tasks to Trigger.dev cloud
pnpm deploy:trigger

# Tasks run in Trigger.dev infrastructure
```

## Monitoring

### Trigger.dev Dashboard

- View running tasks
- Check task logs
- Monitor resource usage
- Cancel tasks manually

### Application Monitoring

- DirectoryGenerationHistory records
- Task status in database
- Error logging via Sentry

## See Also

- [Pipeline Overview](./pipeline-overview.md)
- [Data Generator Spec](../features/data-generator/spec.md)
