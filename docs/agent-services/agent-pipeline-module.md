---
id: agent-pipeline-module
title: Pipeline Execution Module
sidebar_label: Pipeline Execution
sidebar_position: 23
---

# Pipeline Execution Module

## Overview

The Pipeline Execution module implements a plugin-driven, step-based execution engine within `@ever-works/agent`. It is responsible for building, ordering, and running multi-step generation pipelines that transform work configurations into enriched content. The pipeline system supports topological dependency sorting, parallel execution groups, modifier-based step injection, and two distinct execution modes (step-based and self-managed).

Pipelines are constructed from plugin-contributed steps, allowing the generation process to be customized through the plugin system without modifying core code.

## Module Structure

```
packages/agent/src/
  pipeline/
    pipeline.module.ts                # NestJS module definition
    pipeline-builder.service.ts       # Pipeline construction and ordering
    pipeline-orchestrator.service.ts  # Execution routing and mode selection
    pipeline-facade.service.ts        # Bound facade creation for pipeline context
    executable-pipeline.class.ts      # Runtime pipeline wrapper with state management
    step-pipeline-executor.service.ts # Step-by-step execution engine
    full-pipeline-executor.service.ts # Self-managed plugin execution engine
```

## Key Classes and Services

### `PipelineBuilderService`

Constructs executable pipelines from plugin-contributed steps through a 9-step build process:

1. **Get steps** -- collect `IPipelineStep` definitions from the pipeline plugin
2. **Initialize context** -- create a `BuildContext` to track modifications
3. **Get modifiers** -- collect `IPipelineModifier` contributions from modifier plugins
4. **Process modifiers** -- apply modifier positions to the build context
5. **Apply replacements** -- swap out steps that have been replaced by modifiers
6. **Apply disabling** -- remove steps that have been disabled
7. **Apply injections** -- insert new steps at specific positions (`before`, `after`)
8. **Apply prepend/append** -- add steps to the beginning (`first`) or end (`last`)
9. **Topological sort** -- order steps by their declared `dependsOn` arrays
10. **Identify parallel groups** -- group independent steps for concurrent execution
11. **Build executor map** -- create the final step-to-executor mapping

**Custom errors:**

- `CircularDependencyError` -- raised when step dependencies form a cycle
- `MissingDependencyError` -- raised when a step declares a dependency that does not exist

**Modifier positions:**

```typescript
type StepPosition = 'replace' | 'before' | 'after' | 'disable' | 'first' | 'last';
```

### `PipelineOrchestratorService`

The main entry point for pipeline execution. Routes execution to the appropriate engine based on the pipeline plugin type:

- **Step-based execution** (`StepPipelineExecutorService`) -- the orchestrator controls step execution order, parallel groups, and state transitions. Used by `agent-pipeline` plugin.
- **Self-managed execution** (`FullPipelineExecutorService`) -- the pipeline plugin itself controls the entire execution flow. Used by `standard-pipeline` plugin.

**Plugin resolution priority:**

1. Explicit `pipelineId` parameter
2. Plugin with `defaultForCapabilities` matching the requested capability
3. First loaded and enabled pipeline plugin

**Key methods:**

- `execute(work, user, options)` -- run a pipeline with automatic mode detection
- `executeWithMode(work, user, mode, options)` -- run with explicit mode
- `getRecommendedMode(workId)` -- determine the best execution mode
- `hasFullPipelinePlugin()` -- check if a self-managed pipeline plugin is available
- `resumeFromCheckpoint(work, user)` -- resume a previously interrupted pipeline
- `clearCheckpoint(workId)` -- discard saved checkpoint state
- `resumeOrExecute(work, user, options)` -- resume if checkpoint exists, otherwise start fresh

### `ExecutablePipelineRunner`

A runtime wrapper around `ExecutablePipeline` that manages execution state:

```typescript
interface PipelineState {
	status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
	steps: Map<string, StepState>;
	startedAt?: Date;
	completedAt?: Date;
	error?: string;
}

interface StepState {
	status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
	startedAt?: Date;
	completedAt?: Date;
	error?: string;
	result?: unknown;
}
```

Emits events via `PipelineRuntimeEvents`:

- `STATE_CHANGED` -- overall pipeline state transition
- `STEP_STATUS_CHANGED` -- individual step status change

Methods: `startExecution()`, `completeExecution()`, `cancelExecution()`, `startStep(stepId)`, `markStepComplete(stepId, result)`, `markStepFailed(stepId, error)`, `markStepSkipped(stepId)`.

### `PipelineFacadeService`

Creates bound facade instances for pipeline step execution. Each step receives a `StepExecutionContext` with pre-configured facades scoped to the current work and user:

```typescript
interface StepExecutionContext {
	ai: IAiFacade; // Bound AI facade
	search: ISearchFacade; // Bound search facade
	screenshot: IScreenshotFacade;
	contentExtractor: IContentExtractorFacade;
	dataSource: IDataSourceFacade;
	logger: Logger;
	work: Work;
	user: User;
	signal?: AbortSignal; // Cancellation support
}
```

The `FacadeBindingContext` binds `workId`, `userId`, and `providerOverrides` so that each facade call automatically uses the correct scope and credentials.

## API Reference

### PipelineOrchestratorService

```typescript
execute(
    work: Work,
    user: User,
    options?: {
        pipelineId?: string;
        aiProviderOverride?: string;
        signal?: AbortSignal;
    }
): Promise<PipelineResult>

executeWithMode(
    work: Work,
    user: User,
    mode: 'step' | 'full',
    options?: PipelineOptions
): Promise<PipelineResult>

getRecommendedMode(workId: string): Promise<'step' | 'full'>
hasFullPipelinePlugin(): boolean
resumeFromCheckpoint(work: Work, user: User): Promise<PipelineResult>
clearCheckpoint(workId: string): Promise<void>
resumeOrExecute(work: Work, user: User, options?: PipelineOptions): Promise<PipelineResult>
```

### PipelineBuilderService

```typescript
build(
    pipelinePlugin: IPipelinePlugin,
    modifierPlugins: IPipelineModifier[],
    context: BuildInputContext
): ExecutablePipeline
```

### PipelineFacadeService

```typescript
createStepExecutionContext(
    work: Work,
    user: User,
    options?: { providerOverrides?: Record<string, string>; signal?: AbortSignal }
): StepExecutionContext
```

## Configuration

### Pipeline Plugin Interface

Pipeline plugins declare steps via the `IPipelinePlugin` interface:

```typescript
interface IPipelinePlugin {
	getSteps(): IPipelineStep[];
	// For self-managed mode:
	execute?(context: FullPipelineContext): Promise<PipelineResult>;
}

interface IPipelineStep {
	id: string;
	name: string;
	dependsOn?: string[]; // Step IDs this step depends on
	parallel?: boolean; // Can run in parallel with siblings
	executor: StepExecutor; // The execution function
}
```

### Modifier Plugin Interface

Modifier plugins can alter the pipeline at build time:

```typescript
interface IPipelineModifier {
	getModifications(): PipelineModification[];
}

interface PipelineModification {
	targetStepId: string; // Which step to modify
	position: StepPosition; // 'replace' | 'before' | 'after' | 'disable' | 'first' | 'last'
	step?: IPipelineStep; // The replacement/injected step (not needed for 'disable')
}
```

## Dependencies

| Dependency                   | Purpose                                                |
| ---------------------------- | ------------------------------------------------------ |
| `@ever-works/plugin`         | `IPipelinePlugin`, `IPipelineModifier` interfaces      |
| `@ever-works/agent/plugins`  | `PluginRegistryService` for pipeline plugin resolution |
| `@ever-works/agent/facades`  | All facade services for step execution context         |
| `@ever-works/agent/database` | Work repository for checkpoint persistence             |
| `EventEmitter2`              | Pipeline runtime event emission                        |

## Usage Examples

### Executing a Pipeline

```typescript
import { PipelineOrchestratorService } from '@ever-works/agent/pipeline';

// Auto-detect execution mode
const result = await orchestrator.execute(work, user, {
	aiProviderOverride: 'anthropic'
});

// Explicit step-based mode
const result = await orchestrator.executeWithMode(work, user, 'step', {
	signal: abortController.signal
});
```

### Resuming from Checkpoint

```typescript
// If a previous run was interrupted, resume from where it left off
const result = await orchestrator.resumeOrExecute(work, user, {
	pipelineId: 'agent-pipeline'
});
```

### Building a Pipeline (Internal)

```typescript
import { PipelineBuilderService } from '@ever-works/agent/pipeline';

const pipeline = builder.build(pipelinePlugin, modifierPlugins, {
	work,
	user,
	options: { aiProviderOverride: 'openai' }
});

// Inspect the execution plan
console.log(pipeline.steps.map((s) => s.id));
console.log(pipeline.parallelGroups);
```
