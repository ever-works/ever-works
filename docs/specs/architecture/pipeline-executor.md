# Architecture: Pipeline Executor

**Status**: `Active`
**Last updated**: 2026-05-01
**Audience**: AI agents and engineers writing pipeline plugins or steps,
debugging step-state transitions, or building modifiers that inject
work into existing pipelines.

---

## 1. Purpose

Every directory generation that runs through the **Standard Pipeline**
flows through a single executor — `ExecutablePipelineRunner`. The
executor is provided by `@ever-works/plugin/pipeline` (so step plugins
can construct pipelines outside NestJS), wrapped on the platform side
by NestJS-aware orchestrators (`PipelineOrchestratorService`,
`StepPipelineExecutorService`, `FullPipelineExecutorService`,
`PipelineFacadeService`).

This spec covers the executor's **state machine**, **step lifecycle**,
**modifier injection**, **runtime events**, **cancellation propagation**,
and the way it interacts with checkpointing — separately from the
pipeline-as-a-feature description in [`pipeline-overview`](./pipeline-overview.md).

> Pipeline plugins like `claude-code`, `claude-managed-agent`, `codex`,
> `gemini`, `opencode`, `make`, `sim-ai`, and `zapier` **don't** use
> this executor — they each replace the entire pipeline with their own
> logic. The executor described here is the substrate for the
> Standard Pipeline plus its modifiers.

## 2. Layered Surface

```
                       ┌─ Trigger.dev directory-generation task
                       │
            DirectoryGenerationService.runScheduledUpdate()
                       │
       ┌───────────────┼─────────────────────────────────────────┐
       │               │                                          │
       ▼               ▼                                          ▼
 PipelineFacadeService (DI)                       Pipeline plugin (whole-pipeline replacement)
       │
 PipelineOrchestratorService.run(...)
       │
 FullPipelineExecutorService / StepPipelineExecutorService
       │
 ExecutablePipelineRunner   ← runtime substrate (in @ever-works/plugin)
       │
 step.run(input, ctx) ... step.run(...) ...
```

- **Facade / orchestrators** are NestJS services in
  `packages/agent/src/pipeline/` that handle DI, history record
  management, error mapping to platform-side outcomes
  (`completed` / `failed` / `skipped` / `cancelled`), and wiring of
  plugin-context dependencies.
- **`ExecutablePipelineRunner`** is the pure runtime — it knows nothing
  about NestJS or DB.
- **Step plugins** are dropped into the runner as
  `PipelineStepDefinition` entries.

## 3. The Step Contract

A step is an instance of a class extending `BasePipelineStep` (in
`@ever-works/plugin/abstract`):

```ts
abstract class BasePipelineStep<I, O> {
	abstract readonly name: string; // 'web-search'
	abstract readonly description: string; // 'Run search queries...'
	abstract readonly category: StepCategory; // 'discovery' | 'extraction' | ...
	abstract run(input: I, ctx: StepContext): Promise<O>;

	// Optional capability advertised to modifiers
	readonly modifiable?: boolean;
	readonly checkpoint?: boolean;
}
```

Steps consume the previous step's output and produce input for the
next. The executor enforces type alignment at runtime (when each step
declares its input/output schema via `@ever-works/plugin/pipeline`).

The Standard Pipeline assembles ~15 such steps into a fixed sequence:

1. Prompt comparison
2. Prompt processing
3. Domain detection
4. AI first items generation
5. Search queries generation
6. Web search
7. Content retrieval
8. Content filtering
9. Items extraction
10. Deduplication & data aggregation
11. Categories & tags processing
12. Sources validation
13. Badges processing
14. Image capture
15. Markdown generation

The exact list is owned by the `standard-pipeline` plugin; the executor
doesn't care how many steps there are.

## 4. State Machine

Each step transitions through a fixed lifecycle:

```
            ┌────────┐
            │ pending │
            └────┬────┘
                 │ execute
                 ▼
            ┌──────────┐
            │  running │──── error ─────┐
            └────┬─────┘                ▼
                 │ success         ┌────────┐
                 ▼                 │ failed │
            ┌───────────┐          └────────┘
            │ completed │
            └───────────┘

  Cancel signal at any point:
    pending  → skipped
    running  → cancelled
```

The runner emits two events on every transition:

| Event                          | Payload                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `pipeline:state-changed`       | Full `PipelineState` snapshot (every step + overall status) |
| `pipeline:step-status-changed` | `{stepName, previousStatus, newStatus, metrics?, error?}`   |

These events are consumed by:

- The activity-log writer (records step-level changelog entries).
- The dashboard's live-progress view (over WebSocket / SSE).
- The Trigger.dev wrapper's run logs (each step status change is a
  Trigger.dev log line).

## 5. Step Metrics

Each completed step attaches a `StepMetrics` block to its `StepState`:

```ts
interface StepMetrics {
	durationMs: number;
	inputSize?: number; // approximate input bytes
	outputSize?: number; // approximate output bytes
	aiUsage?: {
		inputTokens: number;
		outputTokens: number;
		cost?: number; // USD when the model catalog has pricing
		model: string;
		provider: string;
	};
	httpRequests?: number; // outbound HTTP calls
	cacheHits?: number;
}
```

Metrics flow into the activity-log changelog so the History tab can
show per-step duration and cost. The `aiUsage` block aggregates across
multiple AI calls inside one step.

## 6. Modifier Plugins

Plugins implementing `IPipelineModifierPlugin` can **inject steps**
into the Standard Pipeline at hook points without owning the whole
pipeline. The executor consults its modifier registry at construction
time:

```ts
interface IPipelineModifierPlugin {
	modifierName: string;
	targetSteps: readonly string[]; // step names to attach to
	hook: 'before' | 'after' | 'replace';
	modifier: (input, ctx) => Promise<{ output; skipNext? }>;
}
```

Use cases shipped today:

- **Comparison generator** modifies the post-markdown step to enqueue
  comparisons for newly added items.
- **Source validation** runs `after: image-capture` to validate every
  item's `source_url`.
- **Cost tracking** runs `after: <every step>` to accumulate AI usage
  into the run's cost report.

The executor enforces a deterministic merge order — modifiers attach in
the order they were registered, with `replace` modifiers running before
`before`/`after` modifiers on the same target step.

## 7. Cancellation Propagation

When a user cancels a generation (see
[`features/generation-cancellation/spec`](../features/generation-cancellation/spec.md)),
the cancellation reaches the executor through one of two paths:

1. **Trigger.dev cancellation** — the run carries a Trigger.dev
   cancellation signal that surfaces as `AbortSignal` on the
   `StepContext.signal`.
2. **In-process cancellation token** — the dispatcher signals an
   in-memory cancellation that the orchestrator reads.

The executor:

1. Aborts the **currently running step** by triggering its `signal`.
2. Marks all `pending` steps as `skipped`.
3. Marks the running step as `cancelled` once it observes the signal.
4. Emits a final `state-changed` event and resolves the runner with
   `{outcome: 'cancelled'}`.

Step authors are expected to **honour `ctx.signal`** in any long-running
operation (HTTP, AI, file IO). The Standard Pipeline's HTTP client and
AI facade both do this automatically.

## 8. Checkpointing

For long-running generations a step can opt in to **checkpointing** by
declaring `checkpoint: true`. Before the step runs, the executor:

1. Computes a **checkpoint key** from the directory id, run id, and
   step name.
2. Looks up the cache (TypeORM-backed `cache_entries` table) for a
   cached result.
3. If a fresh cached result exists, uses it without running the step
   (emits `step-status-changed` with `cached: true`).
4. Otherwise runs the step, stores the result with a TTL, and proceeds.

This makes retries of a failed run cheap — you skip everything that
already succeeded. See
[`decisions/001-pipeline-checkpointing`](../decisions/001-pipeline-checkpointing.md)
for the rationale and tuning notes.

## 9. Error Mapping

When a step throws, the executor:

1. Marks the step `failed` with the typed error class name + message
   in `StepState.error`.
2. Skips remaining steps (marks them `skipped`).
3. Resolves the runner with `{outcome: 'failed', failedStep, reason}`.
4. The orchestrator wraps that into a platform-side
   `ScheduleRunOutcome` and calls `finalizeScheduleRun(...)` (see
   [Schedule Dispatcher](../../agent-services/directory-schedule-dispatcher.md)
   for the dispatcher's mirror).

Step errors are **not retried** by the executor itself. Scheduled
updates retry the whole run after 15 minutes (see
[`features/scheduled-updates/spec`](../features/scheduled-updates/spec.md)).

## 10. Concurrency & Resource Guards

- **Within a run**, steps execute sequentially. The executor never runs
  two steps concurrently.
- **Across runs**, the dispatcher sequences runs per-worker (see
  [Schedule Dispatcher §6](../../agent-services/directory-schedule-dispatcher.md#sequential-processing--limits)).
- AI calls inside a step can fan out. The executor doesn't enforce a
  concurrency cap — that's the step's responsibility (the
  `Promise.allSettled` pattern).

## 11. The `StepContext`

Every step receives a `StepContext` that carries:

| Field                    | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `signal`                 | `AbortSignal` for cancellation                                 |
| `directory`              | The current directory entity                                   |
| `user`                   | The triggering user                                            |
| `pluginContext`          | The plugin's own `PluginContext` (logger, cache, http, events) |
| `aiFacade`               | Resolved `IAiFacade`                                           |
| `searchFacade`           | Resolved search facade                                         |
| `extractorFacade`        | Resolved content-extractor facade                              |
| `gitFacade`              | Resolved git facade                                            |
| `screenshotFacade`       | Resolved screenshot facade                                     |
| `state`                  | Read-only `PipelineState` for the run                          |
| `metrics`                | Mutable `StepMetrics` accumulator (steps update during run)    |
| `report(line)`           | Append a structured progress line to the run log               |
| `checkpoint(key, value)` | Manually persist intermediate state (optional)                 |

The context is **per-step**, constructed fresh each step. Steps that
need to share data do so by emitting it as their `output` for the next
step's `input` — no global state.

## 12. Pipeline Builder

`PipelineBuilderService` (in `packages/agent/src/pipeline/`) constructs
a runtime executor from a pipeline plugin's step registry, resolved
modifiers, and the directory's settings:

```ts
const runner = await pipelineBuilder.build({
	pipelinePluginId: 'standard-pipeline',
	directory,
	user,
	overrides: schedule.providerOverrides,
	cancellationSignal
});
const result = await runner.run(initialInput);
```

The builder:

1. Resolves the pipeline plugin via
   [Plugin SDK §11 cascade](./plugin-sdk.md#11-provider-selection).
2. Asks the plugin for its step registry.
3. Asks every active modifier plugin for its modifiers.
4. Merges modifiers with steps in deterministic order (§6).
5. Constructs the `StepContext` template.
6. Returns a configured `ExecutablePipelineRunner`.

Tests can swap the builder for a `MockPipelineBuilder` that returns a
runner with stubbed steps — see `__tests__/mock-pipeline-plugin.ts`.

## 13. Constitution Reconciliation

| Principle                   | How the executor respects it                                                    |
| --------------------------- | ------------------------------------------------------------------------------- |
| I — Plugin-first            | Pipelines and steps are plugins; the executor is just substrate.                |
| II — Capability-driven      | Steps consume facades by capability; never plugin id.                           |
| III — Source-of-truth repos | Steps that write data go through `GitFacadeService`.                            |
| IV — Trigger.dev            | Production runs are wrapped by Trigger.dev tasks.                               |
| V — Forward-only migrations | Step state is jsonb on `directory_generation_history` — additive.               |
| VI — Tests                  | Executor + builder + every shipped step has a Jest suite.                       |
| VII — Secret hygiene        | StepContext exposes facades; secret values never appear in `state`.             |
| VIII — Plugin counts        | N/A.                                                                            |
| IX — Behaviour-first        | This spec describes observable behaviour; step implementations live in plugins. |
| X — Backwards-compat        | `BasePipelineStep` is versioned with the SDK.                                   |

## 14. References

- Source:
    - `packages/plugin/src/pipeline/` (executor primitives)
    - `packages/plugin/src/abstract/base-pipeline-step.ts`
    - `packages/agent/src/pipeline/` (NestJS orchestrators)
    - `packages/plugins/standard-pipeline/src/steps/` (canonical step set)
- Related specs:
    - [`pipeline-overview`](./pipeline-overview.md) (high-level flow)
    - [`trigger-integration`](./trigger-integration.md)
    - [`plugin-sdk`](./plugin-sdk.md)
    - [`features/generation-cancellation/spec`](../features/generation-cancellation/spec.md)
    - [`decisions/001-pipeline-checkpointing`](../decisions/001-pipeline-checkpointing.md)
- User docs: [`docs/ai-agents/`](../../ai-agents/),
  [`docs/plugin-system/pipeline-plugins.md`](../../plugin-system/pipeline-plugins.md)
