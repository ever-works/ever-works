---
id: trigger-dev
title: Trigger.dev Integration
sidebar_label: Trigger.dev
sidebar_position: 5
---

# Trigger.dev Integration

Ever Works uses [Trigger.dev](https://trigger.dev/) for background job processing. Long-running work generation and import tasks are offloaded to Trigger.dev workers, keeping the API responsive while heavy AI pipeline work runs asynchronously.

## Architecture

The Trigger.dev integration lives in `packages/tasks/` and consists of three layers:

| Layer                | Location                                        | Purpose                                       |
| -------------------- | ----------------------------------------------- | --------------------------------------------- |
| **Task definitions** | `packages/tasks/src/tasks/trigger/`             | Trigger.dev task configurations with handlers |
| **Dispatcher**       | `packages/tasks/src/trigger/trigger.service.ts` | NestJS service that dispatches tasks          |
| **Worker utilities** | `packages/tasks/src/trigger/worker/`            | Context bootstrapping and orchestration       |

## TriggerService

The `TriggerService` is the main NestJS service that dispatches background jobs. It implements two dispatcher interfaces:

```typescript
@Injectable()
export class TriggerService implements WorkGenerationDispatcher, WorkImportDispatcher {
	// ...
}
```

### Lazy Configuration

Trigger.dev is configured lazily on first use, not at startup:

```typescript
private ensureConfigured(): boolean {
    if (!config.trigger.shouldUseTrigger()) {
        return false;
    }
    if (this.configured) {
        return true;
    }
    const accessToken = config.trigger.getSecretKey();
    const baseURL = config.trigger.getApiUrl();
    configure({ accessToken, baseURL });
    this.configured = true;
    return true;
}
```

If Trigger.dev is not enabled or the secret key is missing, dispatch calls return `null` and the application falls back to in-process execution.

### Machine Size Configuration

The service supports configurable machine sizes for task execution:

```typescript
private supportedMachines = [
    'medium-1x', 'micro', 'small-1x', 'small-2x',
    'medium-2x', 'large-1x', 'large-2x',
];
```

The machine size is set via the `TRIGGER_MACHINE` environment variable. If the configured value is not in the supported list, no machine preference is sent (Trigger.dev uses its default).

### Dispatch Methods

#### Work Generation

```typescript
async dispatchWorkGeneration(
    payload: WorkGenerationPayload
): Promise<string | null>
```

Dispatches a work generation task with tags for filtering:

- `work-generation` (task type)
- Generation mode (e.g., `recreate`, `append`)
- Work ID

Returns the Trigger.dev run ID on success, or `null` if dispatch fails.

#### Work Import

```typescript
async dispatchWorkImport(
    payload: WorkImportPayload
): Promise<string | null>
```

Dispatches a work import task with tags:

- `work-import` (task type)
- Source type (e.g., `data_repo`, `awesome_readme`)
- Work ID

## Task Definitions

### Work Generation Task

**File**: `tasks/trigger/work-generation.task.ts`
**Task ID**: `work-generation`
**Max Duration**: 5 hours (`3600 * 5` seconds)

This is the primary background task for AI-powered work content generation.

#### Lifecycle Handlers

| Handler     | Purpose                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `run`       | Main execution: bootstraps NestJS context, runs the generation orchestrator |
| `onFailure` | Captures error, updates work state, marks scheduled run as failed      |
| `onCancel`  | Updates work state to cancelled, marks scheduled run as failed         |

#### Run Handler

The `run` handler:

1. Bootstraps a standalone NestJS application context using `withWorkerContext()`.
2. Creates a task context with the orchestrator, work, and user references.
3. Executes the generation pipeline via `TriggerGenerationOrchestrator`.
4. If triggered by a schedule, marks the schedule run as completed.

```typescript
run: async (payload: WorkGenerationPayload) => {
    return withWorkerContext('WorkGeneration', async (appContext) => {
        const { orchestrator, work, user } = await createTaskContext(
            appContext, payload, TriggerGenerationOrchestrator,
        );
        await orchestrator.run({
            work, user,
            dto: payload.dto,
            historyId: payload.historyId,
            historyStartedAt: payload.historyStartedAt,
        });
        return { status: 'completed', workId: payload.workId };
    });
},
```

#### Failure Handler

On failure, the handler:

1. Boots a new NestJS context (the original context may be corrupted).
2. Normalizes the error message.
3. Updates the generation history with the error.
4. Marks any associated schedule run as failed.

The failure handler uses `try/catch` around the entire body -- if context bootstrapping fails, it silently exits since there is nothing more it can do.

### Work Schedule Dispatcher Task

**File**: `tasks/trigger/work-schedule-dispatcher.task.ts`

A cron-triggered task that checks for schedules that need to run and dispatches generation tasks for each.

## Worker Context

### withWorkerContext

The `withWorkerContext()` utility bootstraps a standalone NestJS application context for Trigger.dev workers:

```typescript
async function withWorkerContext<T>(name: string, fn: (appContext: INestApplicationContext) => Promise<T>): Promise<T>;
```

This creates a full NestJS module tree with database access, facades, and services, then executes the provided function with the application context.

### createTaskContext

The `createTaskContext()` utility resolves the work, user, and orchestrator from the task payload:

```typescript
async function createTaskContext<T>(
	appContext: INestApplicationContext,
	payload: WorkGenerationPayload,
	OrchestratorClass: Type<T>
): Promise<{ orchestrator: T; work: Work; user: User }>;
```

## Environment Variables

| Variable                  | Purpose                                | Default                 |
| ------------------------- | -------------------------------------- | ----------------------- |
| `TRIGGER_ENABLED`         | Enable Trigger.dev integration         | `false`                 |
| `TRIGGER_SECRET_KEY`      | API secret key for authentication      | -                       |
| `TRIGGER_API_URL`         | Trigger.dev API URL                    | Trigger.dev cloud       |
| `TRIGGER_MACHINE`         | Machine size for task execution        | Default (no preference) |
| `TRIGGER_INTERNAL_SECRET` | Internal secret for webhook validation | -                       |

## Deployment

Trigger.dev workers are deployed separately from the main API:

```bash
# Deploy Trigger.dev tasks
pnpm deploy:trigger

# Run Trigger.dev dev server locally
pnpm dev:trigger
```

The dev server connects to Trigger.dev cloud and registers local task handlers, enabling local development and debugging of background tasks.

## Fallback Behavior

When Trigger.dev is disabled (`TRIGGER_ENABLED=false` or missing `TRIGGER_SECRET_KEY`):

1. `ensureConfigured()` returns `false`.
2. Dispatch methods return `null`.
3. The API falls back to running generation tasks in-process.

This enables development without a Trigger.dev account while using the same code paths.
