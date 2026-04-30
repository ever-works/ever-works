---
id: tasks-package
title: Tasks Package
sidebar_label: Tasks Package
sidebar_position: 1
---

# Tasks Package

The `@ever-works/trigger-tasks` package provides background task execution for the Ever Works platform using [Trigger.dev](https://trigger.dev). It handles long-running directory generation and import operations outside the main API process, enabling reliable multi-hour workflows with automatic failure recovery, cancellation handling, and schedule-based dispatching.

## Package Overview

| Property            | Value                                                    |
| ------------------- | -------------------------------------------------------- |
| **Package name**    | `@ever-works/trigger-tasks`                              |
| **Location**        | `platform/packages/tasks/`                               |
| **Runtime**         | Node.js (Trigger.dev worker)                             |
| **Max duration**    | 5 hours (generation), 2 hours (import)                   |
| **Default machine** | `medium-1x`                                              |
| **Retry strategy**  | Up to 3 attempts with exponential backoff (configurable) |

## Architecture

The tasks package operates in two distinct contexts:

1. **API-side** -- The `TriggerModule` and `TriggerService` run inside the NestJS API, dispatching payloads to Trigger.dev.
2. **Worker-side** -- Task definitions, orchestrators, and worker modules run inside Trigger.dev's isolated execution environment.

```
API Process                          Trigger.dev Worker
-----------                          ------------------
TriggerService                       directoryGenerationTask
  .dispatchDirectoryGeneration() --> withWorkerContext()
                                       createTaskContext()
                                       TriggerGenerationOrchestrator.run()
```

## Task Definitions

Tasks are defined in `src/tasks/trigger/` using the Trigger.dev SDK.

### Directory Generation Task

The primary task that orchestrates AI-powered directory content generation.

```typescript
// src/tasks/trigger/directory-generation.task.ts
export const directoryGenerationTask = task({
	id: 'directory-generation',
	maxDuration: 3600 * 5, // 5 hours
	onFailure: async ({ payload, error }) => {
		/* ... */
	},
	onCancel: async ({ payload }) => {
		/* ... */
	},
	run: async (payload: DirectoryGenerationPayload) => {
		return withWorkerContext('DirectoryGeneration', async (appContext) => {
			const { orchestrator, directory, user } = await createTaskContext(
				appContext,
				payload,
				TriggerGenerationOrchestrator
			);
			await orchestrator.run({
				directory,
				user,
				dto: payload.dto,
				historyId: payload.historyId,
				historyStartedAt: payload.historyStartedAt
			});
			return { status: 'completed', directoryId: payload.directoryId };
		});
	}
});
```

### Directory Import Task

Handles importing directory content from external sources such as GitHub repositories.

```typescript
export const directoryImportTask = task({
	id: 'directory-import',
	maxDuration: 3600 * 2, // 2 hours
	run: async (payload: DirectoryImportPayload) => {
		return withWorkerContext('DirectoryImport', async (appContext) => {
			const { orchestrator, directory, user, gitToken } = await createTaskContext(
				appContext,
				payload,
				TriggerImportOrchestrator
			);
			await orchestrator.run({ directory, user, payload, gitToken });
			return { status: 'completed', directoryId: payload.directoryId };
		});
	}
});
```

### Schedule Dispatcher Task

A cron-based task that polls for due scheduled directory generations and dispatches them.

```typescript
export const directoryScheduleDispatcherTask = schedules.task({
	id: 'directory-schedule-dispatcher',
	cron: `*/${interval} * * * *`, // configurable interval
	run: async () => {
		const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
		const dispatcher = appContext.get(DirectoryScheduleDispatcherService);
		const dispatched = await dispatcher.dispatchDue();
		return { dispatched, intervalMinutes: interval };
	}
});
```

## TriggerService (API-Side Dispatcher)

The `TriggerService` runs in the NestJS API and implements both `DirectoryGenerationDispatcher` and `DirectoryImportDispatcher` interfaces. It lazily configures the Trigger.dev SDK on first use.

| Method                                 | Description                                       |
| -------------------------------------- | ------------------------------------------------- |
| `dispatchDirectoryGeneration(payload)` | Triggers a generation task with tags for tracking |
| `dispatchDirectoryImport(payload)`     | Triggers an import task with source-type tags     |

The service supports configurable machine sizes: `micro`, `small-1x`, `small-2x`, `medium-1x`, `medium-2x`, `large-1x`, `large-2x`.

## Worker Context Utilities

### `withWorkerContext`

Bootstraps a full NestJS application context inside the Trigger.dev worker, executes the provided function, and ensures cleanup.

```typescript
async function withWorkerContext<T>(
	loggerName: string,
	fn: (appContext: INestApplicationContext) => Promise<T>,
	module: Type<any> = TriggerWorkerModule
): Promise<T>;
```

### `createTaskContext`

Shared bootstrap logic that hydrates plugins, fetches directory context from the API, and resolves the orchestrator instance.

```typescript
async function createTaskContext<T>(
	appContext: INestApplicationContext,
	payload: { directoryId: string; userId: string },
	orchestratorClass: Type<T>
): Promise<{ user: User; directory: Directory; orchestrator: T; gitToken?: string }>;
```

## Orchestrators

Orchestrators manage the execution lifecycle of tasks including status tracking, error handling, and notifications.

### BaseOrchestrator

Abstract base class providing common functionality:

| Method                                            | Description                                            |
| ------------------------------------------------- | ------------------------------------------------------ |
| `handleFailure(options)`                          | Records error state, updates history, emits completion |
| `handleCancellation(options)`                     | Records cancelled state with duration calculation      |
| `handleErrorNotification(error, user, directory)` | Classifies errors and sends notifications              |

### TriggerGenerationOrchestrator

Coordinates the full generation pipeline:

1. Records generation start time and status
2. Runs data generation via `DataGeneratorService`
3. Generates markdown via `MarkdownGeneratorService`
4. Generates website via `WebsiteGeneratorService`
5. Updates history with stats and warnings
6. Handles errors with classified notifications

### TriggerImportOrchestrator

Coordinates directory imports from external sources:

1. Records import start and status
2. Delegates to `ImportExecutorService` based on source type
3. Updates directory item count on success
4. Records import statistics in generation history

## Worker Services

### TriggerInternalApiClient

HTTP client for communication between the Trigger.dev worker and the main API. Uses shared secret authentication and SuperJSON serialization.

| Method                                       | Description                                        |
| -------------------------------------------- | -------------------------------------------------- |
| `fetchDirectoryContext(directoryId, userId)` | Fetches directory and user data from the API       |
| `callRemote(name, method, args)`             | Forwards method calls to API-side services via RPC |

Features automatic retry with exponential backoff (3 attempts, 500ms base delay) for 5xx errors and network failures.

### TriggerPluginHydratorService

Initializes the plugin system from the filesystem within the worker environment by calling `PluginBootstrapService.bootstrap({ force: true })`.

### LocalPluginStore

An in-memory `Map`-based store for plugin metadata used during worker bootstrap. Write operations (create, upsert, update, delete) execute locally while read operations fall through to the remote proxy.

## Remote Proxy

The `createRemoteProxy` function creates a JavaScript `Proxy` that transparently forwards method calls to the API via `TriggerInternalApiClient.callRemote()`. Uses SuperJSON for serialization to preserve Date, Map, Set, and other complex types across the network boundary.

## Build Configuration

The `trigger.config.ts` configures the Trigger.dev deployment:

- **TypeScript decorators** enabled via `emitDecoratorMetadata()` extension
- **Plugin artifacts** bundled via `additionalFiles({ files: ['./plugins/**'] })`
- **Plugin dependencies** collected and installed via `collectPluginDependencies()`
- **External packages** exclude unused NestJS optional dependencies (websockets, microservices, gRPC, Kafka, MQTT, NATS, AMQP)

## TriggerLogger

A custom `LoggerService` implementation that forwards NestJS logs to Trigger.dev's structured logger, making them visible in the Trigger.dev dashboard. Supports all log levels: `log`, `error`, `warn`, `debug`, `verbose`, and `fatal`.

## Module Structure

| Module                     | Purpose                                |
| -------------------------- | -------------------------------------- |
| `TriggerWorkerModule`      | Root module for worker context         |
| `TriggerInternalModule`    | Minimal module for schedule dispatcher |
| `TriggerFacadesModule`     | Facade services with remote proxies    |
| `TriggerPipelineModule`    | Pipeline execution services            |
| `TriggerPluginsModule`     | Plugin system with local store         |
| `TriggerRemoteCacheModule` | Cache services via remote proxy        |
