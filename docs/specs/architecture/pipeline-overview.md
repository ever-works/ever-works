# Architecture: Pipeline Overview

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers reasoning about how a directory
generation request flows from API to GitHub repos. The companion
[`pipeline-executor`](./pipeline-executor.md) covers the runtime
substrate (state machine, modifiers, cancellation, checkpointing);
this spec is the wide-angle view across **all** pipeline categories.

---

## 1. Purpose

A directory generation transforms a user's prompt + configuration
into three GitHub repositories: a **data repo** (YAML config + JSON
items), a **markdown repo** (README + per-item detail pages), and a
**website repo** (Next.js application). The pipeline is the unit of
work that produces the items; the data/markdown/website generators
persist them.

Crucially, **"the pipeline" is plural** — the platform ships several
distinct pipeline plugins. Some run a fixed sequence of steps inside
the platform's executor; others delegate the entire generation to an
external system and report back. This spec covers the full taxonomy
and the routing logic that picks one per run.

## 2. Generation as a Three-Stage Orchestrator

```
                       User / Schedule / API
                              │
                              ▼
       DirectoryGenerationService.startGeneration(...)
                              │   creates DirectoryGenerationHistory
                              │   builds DirectoryGenerationPayload
                              ▼
                 DIRECTORY_GENERATION_DISPATCHER
                              │
                              ▼
                 Trigger.dev directoryGenerationTask
                              │
                              ▼
              TriggerGenerationOrchestrator.run({...})
                              │
       ┌──────────────────────┼──────────────────────────┐
       ▼                      ▼                          ▼
 DataGeneratorService    MarkdownGeneratorService   WebsiteGeneratorService
       │                      │                          │
       │                      │                          │
       ▼                      ▼                          ▼
   data repo             markdown repo               website repo
   (commit/PR)            (commit/PR)              (auto-init or sync)
```

Stage gating inside the orchestrator (see
`packages/tasks/src/trigger/worker/orchestrators/trigger-generation.orchestrator.ts`):

| Stage              | Runs when                                                |
| ------------------ | -------------------------------------------------------- |
| Data generator     | Always                                                   |
| Markdown generator | `newItemsCount > 0 \|\| updatedItemsCount > 0`           |
| Website generator  | `newItemsCount > 0 \|\| hasExistingItems` (skip if none) |

Cancellation flows through `signal: AbortSignal` — every stage and
every step inside `DataGeneratorService` checks
`throwIfGenerationCancelled(signal)` at safe boundaries.

## 3. Where the Pipeline Plugin Plugs In

`DataGeneratorService.initialize` is the entry point that **invokes
a pipeline**. It hands off to `ItemsGeneratorService.generateItems`,
which routes through `PipelineOrchestratorService.execute`:

```ts
// packages/agent/src/pipeline/pipeline-orchestrator.service.ts
const plugin = await this.resolvePipelinePlugin(pipelineId, directoryId, userId);
const mode = isStepOrchestratablePipeline(plugin) ? 'step' : 'full';

if (mode === 'step') {
	return this.stepExecutor.execute(plugin, directory, request, existing, options, onProgress);
}
return this.fullExecutor.execute(plugin, directory, request, existing, options, onProgress);
```

Two execution modes, set by the pipeline plugin's own type signature
(`isStepOrchestratablePipeline(plugin)`):

| Mode     | Executor                      | Used by                                                                           |
| -------- | ----------------------------- | --------------------------------------------------------------------------------- |
| **step** | `StepPipelineExecutorService` | `standard-pipeline` (the only built-in step-orchestratable pipeline today)        |
| **full** | `FullPipelineExecutorService` | Every other pipeline plugin — they own their entire flow and report a result back |

All pipeline plugins implement `IPipelinePlugin` from
`@ever-works/plugin`. Step-orchestratable plugins additionally
implement `IStepOrchestratablePipelinePlugin` and expose a
**step registry** the executor walks.

## 4. The Four Pipeline Categories Today

```
pipeline-plugin (capability)
│
├── step-orchestratable
│   └── standard-pipeline      ← 15-step canonical pipeline (this spec's §6)
│
├── agent-driven (full mode)
│   ├── agent-pipeline         ← Vercel AI SDK ToolLoopAgent over the same facades
│   ├── claude-managed-agent   ← Anthropic's Agents SDK
│   ├── claude-code            ← Spawn Claude Code CLI in a worker subprocess
│   ├── codex                  ← Spawn OpenAI Codex CLI
│   ├── gemini                 ← Spawn Google Gemini CLI
│   └── opencode               ← Spawn opencode CLI
│
└── external-platform (full mode)
    ├── make                   ← Trigger a Make.com scenario
    ├── sim-ai                 ← Sim.ai workflow
    └── zapier                 ← Zapier zap
```

All ten pipeline plugins are first-party packages under
`packages/plugins/`. They're selectable per directory via the
plugin-settings cascade described in
[`plugin-sdk` §11](./plugin-sdk.md#11-provider-selection):
**directory override → user default → platform default**, with
`standard-pipeline` as the platform default.

The choice surfaces in the dashboard's "Generation method" picker
on the directory detail page; settings hygiene (secrets, `x-secret`,
plugin enable/disable) is handled by
[`settings-system`](./settings-system.md).

## 5. Pipeline Plugin Selection Cascade

```
1. directory-pinned plugin id     (most specific — set per directory)
2. user-default plugin id         (set on the user's profile)
3. platform default               (standard-pipeline)
```

`PipelineOrchestratorService.resolvePipelinePlugin` walks this
cascade. If the resolved plugin is disabled or missing, the resolver
falls through to the next level rather than failing the run; if no
level resolves, the run errors with a clear "no pipeline available"
message rather than silently picking a different one.

Provider overrides on `request.providers` (per-run) are applied
**inside** the chosen pipeline — they pick which AI / search /
extractor / screenshot plugins the steps use, not which pipeline
runs.

## 6. The Standard Pipeline (15 Steps)

The `standard-pipeline` plugin owns the canonical step set. The
`PipelineExecutor` runs steps **sequentially** and stops on first
failure. Steps live in
`packages/plugins/standard-pipeline/src/steps/` and are registered
in that package's `steps/index.ts`.

| #   | Step file                         | Purpose                                                         |
| --- | --------------------------------- | --------------------------------------------------------------- |
| 1   | `prompt-comparison.step.ts`       | Compare new prompt vs the last run's prompt for similarity      |
| 2   | `prompt-processing.step.ts`       | Extract subject, categories, keywords from prompt               |
| 3   | `domain-detection.step.ts`        | Classify domain type (SOFTWARE, ECOMMERCE, etc.)                |
| 4   | `ai-item-generation.step.ts`      | Generate items directly from AI (when AI-first mode is enabled) |
| 5   | `search-query-generation.step.ts` | Generate search queries for web crawling                        |
| 6   | `web-search.step.ts`              | Execute search queries via the search facade                    |
| 7   | `content-retrieval.step.ts`       | Fetch raw content from each result URL                          |
| 8   | `content-filtering.step.ts`       | Filter pages by relevance threshold (LLM-judge)                 |
| 9   | `item-extraction.step.ts`         | Extract structured items from filtered pages (LLM)              |
| 10  | `data-aggregation.step.ts`        | Deduplicate, merge with existing items by slug                  |
| 11  | `category-processing.step.ts`     | Assign categories and tags                                      |
| 12  | `source-validation.step.ts`       | Validate source URLs are official + reachable                   |
| 13  | `badge-processing.step.ts`        | Evaluate and assign badges (when badge eval is enabled)         |
| 14  | `image-capture.step.ts`           | Capture screenshots / smart images via the screenshot facade    |
| 15  | `markdown-generation.step.ts`     | Generate per-item markdown for the markdown repo                |

The executor enforces type alignment between adjacent steps via the
`PipelineStepDefinition` schemas; see
[`pipeline-executor` §3](./pipeline-executor.md#3-the-step-contract).

### Step categories (for filtering / gating)

| Category     | Steps          |
| ------------ | -------------- |
| `analysis`   | 1, 2, 3        |
| `discovery`  | 4, 5, 6, 7     |
| `extraction` | 8, 9, 10       |
| `enrichment` | 11, 12, 13, 14 |
| `output`     | 15             |

Modifier plugins target steps by name; see
[`pipeline-executor` §6](./pipeline-executor.md#6-modifier-plugins)
for the modifier mechanism.

## 7. Agent-Driven Pipelines

Agent-based pipelines hand the entire generation problem to an LLM
agent loop instead of a fixed sequence of steps. They share the
**input/output contract** with the standard pipeline (same
`GenerationRequest` in, same `PipelineResult` out) but skip the
step executor entirely.

| Plugin                 | What it runs                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `agent-pipeline`       | A Vercel AI SDK `ToolLoopAgent` armed with the platform's facades as tools — search, extract, screenshot, etc. |
| `claude-managed-agent` | Anthropic's Agents API with the same facade tools                                                              |
| `claude-code`          | Spawns the Claude Code CLI in a worker subprocess; agent reads/writes files in a scratch dir                   |
| `codex`                | Spawns the OpenAI Codex CLI similarly                                                                          |
| `gemini`               | Spawns the Google Gemini CLI similarly                                                                         |
| `opencode`             | Spawns the opencode CLI similarly                                                                              |

The CLI-based plugins (`claude-code`, `codex`, `gemini`, `opencode`)
are functionally similar — they shell out to a code-agent CLI binary
with a directory-scoped working tree, watch stdout for structured
output, and translate the result back into items + categories +
tags. The plugins differ in which CLI they shell out to and how they
parse the CLI's progress output.

The **API-based** agent plugins (`agent-pipeline`,
`claude-managed-agent`) run in-process: no subprocess, no shell, no
filesystem scratch. They use facades exposed as agent tools and let
the LLM decide which tool to call when.

## 8. External-Platform Pipelines

`make`, `sim-ai`, `zapier` delegate the work to an off-platform
workflow engine:

1. The plugin packages the `GenerationRequest` into the platform's
   webhook format.
2. Triggers the user's pre-configured workflow on the external
   platform.
3. Polls (or receives webhook callback) for the result.
4. Translates the result back into a `PipelineResult`.

These are useful when teams already have a Make scenario or Zapier
zap that does the bulk of their data work — the platform integrates
with the existing automation rather than asking them to recreate it
inside the platform.

## 9. The `GenerationRequest` and `PipelineResult` Contract

Both step and full executors take the same input shape:

```ts
interface GenerationRequest {
	directoryId: string;
	userId: string;
	prompt: string;
	mode: 'create' | 'update';
	config: {
		max_search_queries?: number; // Standard pipeline only
		max_results_per_query?: number;
		max_pages_to_process?: number;
		relevance_threshold_content?: number;
		ai_first_generation_enabled?: boolean;
		content_filtering_enabled?: boolean;
		badge_evaluation_enabled?: boolean;
		// ... full DTO in CreateItemsGeneratorDto
	};
	providers?: {
		pipeline?: string; // pipeline plugin id override
		ai?: string; // AI provider plugin id
		search?: string;
		screenshot?: string;
		contentExtractor?: string;
	};
}

interface PipelineResult {
	items: ItemData[];
	categories: Category[];
	tags: Tag[];
	brands: Brand[];
	metrics: ItemsGeneratorMetrics; // tokens, cost, durations
	warnings?: string[];
	contentCache?: Map<string, string>;
}
```

This shared contract is why a directory can switch from
`standard-pipeline` to `claude-code` (or vice versa) without any
schema migration — the data repository writer doesn't know or care
which pipeline produced the items.

## 10. Bound Facades for Pipeline Execution

`PipelineFacadeService` constructs a per-run `StepExecutionContext`
where every facade (AI, search, screenshot, content-extractor,
data-source, prompt) is **bound** to the directory + user + provider
overrides. Step authors call `ctx.aiFacade.askJson(prompt, schema)`
without ever passing `directoryId` / `userId` themselves:

```ts
// packages/agent/src/pipeline/pipeline-facade.service.ts
createStepExecutionContext(directory, providerOverrides, aiModelOverride, signal): StepExecutionContext {
    return {
        aiFacade: this.createBoundAiFacade(facadeContext),
        searchFacade: this.createBoundSearchFacade(facadeContext),
        screenshotFacade: this.createBoundScreenshotFacade(facadeContext),
        contentExtractorFacade: this.createBoundContentExtractorFacade(facadeContext),
        dataSourceFacade: this.createBoundDataSourceFacade(facadeContext),
        promptFacade: this.createBoundPromptFacade(facadeContext),
        logger: stepLogger,
        directory,
        user: directory.user,
        signal,
    };
}
```

This isolation is what lets full-mode pipelines (agent / external)
share infrastructure with the standard pipeline — they receive the
same bound facades and the same cancellation signal.

## 11. Run Lifecycle and Persistence

```
DirectoryGenerationService.startGeneration
  ├── insert DirectoryGenerationHistory(historyId, NOT_STARTED)
  ├── build DirectoryGenerationPayload
  └── DIRECTORY_GENERATION_DISPATCHER.dispatch(payload)
       │
       ▼ (Trigger.dev)
TriggerGenerationOrchestrator.run({ directory, user, dto, historyId, ... })
  ├── recordGenerationStartTime + updateGenerateStatus(GENERATING)
  ├── DataGeneratorService.initialize(...)         ← runs the pipeline
  │     ├── ItemsGeneratorService.generateItems
  │     │     └── PipelineOrchestratorService.execute
  │     ├── merge with existing data + write data repo
  │     └── return { stats, prUpdate?, warnings }
  ├── if items changed → MarkdownGeneratorService.initialize(...)
  ├── if items exist  → WebsiteGeneratorService.initialize(...)
  └── updateGenerateStatus(GENERATED) + updateGenerationHistory(...)
```

Three classes of progress signal flow back during the run:

1. **Step-status events** (per-step start/end, metrics) — emitted by
   the executor; consumed by the activity-log writer and the
   dashboard's progress view.
2. **Recent logs** ring buffer — written to `directory.recentLogs`
   for the live tail.
3. **Trigger.dev run logs** — every NestJS log line surfaces in the
   Trigger.dev dashboard via `createTriggerLogger(...)`.

On completion, the history row stores the per-step metrics (cost,
tokens, durations) so the user can see exactly what each step cost.

## 12. Configuration Surface

The user-tunable knobs live in `CreateItemsGeneratorDto`. The most
impactful ones for the standard pipeline:

| Field                                | Default       | Effect                                 |
| ------------------------------------ | ------------- | -------------------------------------- |
| `max_search_queries`                 | 10            | Limits step 5 fan-out                  |
| `max_results_per_query`              | 5             | Limits step 6 search-result list size  |
| `max_pages_to_process`               | 10            | Caps content retrieval after filtering |
| `relevance_threshold_content`        | 0.6           | LLM relevance gate in step 8           |
| `ai_first_generation_enabled`        | false         | Skip web search; rely on step 4 only   |
| `content_filtering_enabled`          | true          | Toggle step 8 entirely                 |
| `badge_evaluation_enabled`           | false         | Toggle step 13                         |
| `generation_method`                  | CREATE_UPDATE | RECREATE wipes items before write      |
| `update_with_pull_request`           | false         | Push direct vs open PR                 |
| `website_repository_creation_method` | DUPLICATE     | Used by stage 3 (website generator)    |

Plus the seven advanced-prompt overrides (see
[`features/advanced-prompts`](../features/advanced-prompts/spec.md))
which append per-step custom instructions for steps 4, 5, 8, 9, 10,
11, and 12.

## 13. Reading Order for Newcomers

1. **This spec** — wide-angle: stages, categories, routing.
2. **[`pipeline-executor`](./pipeline-executor.md)** — runtime
   substrate: state machine, modifiers, cancellation, checkpointing.
3. **[`plugin-sdk`](./plugin-sdk.md)** — how plugins are loaded,
   selected, and given context.
4. **[`trigger-integration`](./trigger-integration.md)** — how the
   Trigger.dev wrapper delivers payloads to the orchestrator.
5. **[`features/data-generator`](../features/data-generator/spec.md)**,
   **[`features/markdown-generator`](../features/markdown-generator/spec.md)**,
   **[`features/website-generator`](../features/website-generator/spec.md)** —
   the three stages in detail.

## 14. File Index

```
apps/api/src/directories/services/
├── directory-generation.service.ts         # Entry point, history record creation

packages/agent/src/
├── tasks/
│   ├── directory-generation-dispatcher.ts  # DI symbol for dispatch interface
│   └── directory-generation.types.ts       # Payload typings
├── items-generator/
│   ├── items-generator.service.ts          # Calls into the orchestrator
│   └── interfaces/pipeline.interface.ts    # GenerationContext + AdvancedPromptsContext
├── pipeline/
│   ├── pipeline-orchestrator.service.ts    # Step vs full mode routing
│   ├── pipeline-builder.service.ts         # Builds executor + modifier merge
│   ├── pipeline-facade.service.ts          # Bound facades for steps
│   ├── step-pipeline-executor.service.ts   # Wraps standard pipeline
│   └── full-pipeline-executor.service.ts   # Wraps full-mode pipelines
├── data-generator/
│   ├── data-generator.service.ts           # Stage 1
│   └── data-repository.ts
├── markdown-generator/
│   ├── markdown-generator.service.ts       # Stage 2
│   ├── readme-builder.ts
│   └── markdown-repository.ts
└── website-generator/
    ├── website-generator.service.ts        # Stage 3
    ├── website-update.service.ts
    └── branch-sync.service.ts

packages/plugins/standard-pipeline/src/
├── standard-pipeline.plugin.ts             # IStepOrchestratablePipelinePlugin impl
└── steps/                                  # 15 step implementations

packages/plugins/{agent-pipeline,claude-code,claude-managed-agent,codex,gemini,opencode,make,sim-ai,zapier}/
└── *.plugin.ts                             # IPipelinePlugin impls (full mode)

packages/tasks/src/
├── tasks/trigger/directory-generation.task.ts          # Trigger.dev task
└── trigger/worker/orchestrators/trigger-generation.orchestrator.ts  # 3-stage orchestrator
```

## 15. See Also

- [`pipeline-executor`](./pipeline-executor.md) — runtime substrate
- [`plugin-sdk`](./plugin-sdk.md) — plugin loading + capability dispatch
- [`trigger-integration`](./trigger-integration.md) — task-side wiring
- [`trigger-worker`](./trigger-worker.md) — worker bootstrap pattern
- [`features/data-generator`](../features/data-generator/spec.md),
  [`features/markdown-generator`](../features/markdown-generator/spec.md),
  [`features/website-generator`](../features/website-generator/spec.md)
- [`features/advanced-prompts`](../features/advanced-prompts/spec.md) — the
  seven per-step prompt overrides
- [`features/generation-cancellation`](../features/generation-cancellation/spec.md) —
  cancellation signal flow into the executor
- [`features/scheduled-updates`](../features/scheduled-updates/spec.md) — the
  cron path that triggers the same orchestrator
- [`decisions/001-pipeline-checkpointing`](../decisions/001-pipeline-checkpointing.md)
