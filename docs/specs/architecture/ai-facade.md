# Architecture: AI Facade

**Status**: `Active`
**Last updated**: 2026-05-01
**Audience**: AI agents and engineers debugging AI provider routing, model
selection, structured output, or streaming chat.

---

## 1. Purpose

`AiFacadeService` is the single platform-side entry point for **every**
LLM call the platform makes — generation pipelines, AI conversations,
content extraction validation, comparison generation, item enrichment,
and dashboard test calls. It resolves which AI provider plugin should
handle the call, picks the right model tier for the task, applies
provider-specific routing (reasoning, JSON mode, embedding shape), and
provides graceful degradation across plugins.

Plugins themselves are **OpenAI-shape-compatible** — every AI provider
plugin (`openai`, `anthropic`, `google`, `groq`, `ollama`, `mistral`,
`openrouter`, `vercel-ai-gateway`, plus the various aggregator
implementations) wraps a LangChain client behind the same
`IAiProviderPlugin` contract. The facade handles _which_ plugin and
_which_ model; the plugin handles the wire protocol.

## 2. Public Surface (`IAiFacade`)

```ts
interface IAiFacade {
	chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResponse>;
	streamChatCompletion(opts: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk>;
	askJson<T>(opts: AskJsonOptions<T>): Promise<AskJsonResponse<T>>;
	askJsonCompletion<T>(opts: AskJsonOptions<T>): Promise<AskJsonCompletionResponse<T>>;
	embeddings(opts: EmbeddingsOptions): Promise<EmbeddingsResponse>;
	listModels(opts: { providerId?: string }): Promise<AiModel[]>;
	getProviderConfig(providerId: string): Promise<AiProviderConfig>;
	validateConnection(providerId: string): Promise<ConnectionValidationResult>;
}
```

Every method accepts a `FacadeOptions` block carrying `userId`,
`directoryId?`, optional explicit `providerId`, and `routing` overrides.
Without these the facade falls back to the cascade (§3).

## 3. Provider Resolution Cascade

The facade resolves a request to a plugin in this order:

1. **Explicit `providerId`** in the options (admin tool calls, "test
   this provider" button).
2. **Per-directory binding** — `directory_plugins.aiProvider` row.
3. **Per-user binding** — `user_plugins.aiProvider` row.
4. **`defaultFor: 'ai-provider'` plugin** — today: `openrouter`.
5. **Throw `AiFacadeError("no provider")`** — caller handles.

The cascade is the same one defined in
[Plugin SDK §11](./plugin-sdk.md#11-provider-selection) and shared with
every other facade.

## 4. Model Tier Routing

Every AI provider plugin declares **four model aliases** in its settings
schema:

| Alias          | Typical use                                          | Default cost target |
| -------------- | ---------------------------------------------------- | ------------------- |
| `simpleModel`  | Tags, slugs, short labels, classifications           | Cheapest tier       |
| `mediumModel`  | Item summaries, descriptions, reformatting           | Mid tier            |
| `complexModel` | Full-page generation, multi-step analysis, reasoning | Top tier            |
| `defaultModel` | Used when no `complexity` is specified               | Mid tier (typical)  |

The facade accepts a `complexity: TaskComplexity` hint
(`'simple' | 'medium' | 'complex'`) and resolves the right alias from
the plugin's resolved settings. The plugin substitutes the alias for
the actual model id (e.g. `simpleModel: 'gpt-5-nano'`) before calling
LangChain.

Pipelines pick complexity per step:

- Domain detection → `simple`
- Item summary → `medium`
- Whole-page generation → `complex`
- Reasoning (deep analysis) → `complex` with `routing.reasoningEffort`

## 5. Model Catalog

`fetchModelCatalog()` and `matchModelCatalogEntry()` (in
`packages/agent/src/facades/model-catalog.ts`) provide a **provider-agnostic
model registry** the facade caches per process for one hour. The
catalog tracks:

- `id` — provider-namespaced model id (e.g. `anthropic/claude-sonnet-4-5`).
- `provider` — the upstream provider.
- `family` — model family (Claude Sonnet 4, GPT-5.1, etc.).
- `pricing` — per-token in/out (when known).
- `contextWindow` — max tokens.
- `capabilities` — `chat`, `tools`, `vision`, `reasoning`, `json`,
  `embeddings`.
- `reasoningSupport` — explicit reasoning-effort tier when supported.

The catalog drives:

- The dashboard's model picker (filtered by capability).
- Cost estimation in pipelines (per-run cost reporting).
- Model validation (does the configured model actually support the
  capability the pipeline needs?).

The catalog is sourced from a static JSON snapshot embedded in the
agent package, periodically refreshed via a separate task. Plugins can
override or extend entries by declaring them in their manifest's
`models` array.

## 6. Structured Output (`askJson`)

`askJson<T>` is the canonical way to get a typed object back from an
LLM:

```ts
const { result, model, usage } = await aiFacade.askJson(
	{
		schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
		prompt: 'Extract metadata from: ' + html,
		complexity: 'medium'
	},
	{ userId, directoryId }
);
```

The facade:

1. Converts the **Zod schema** to a JSON Schema via `zod-to-json-schema`.
2. Calls the plugin's `askJson` method with the JSON Schema.
3. The plugin uses provider-native structured output if available
   (OpenAI `response_format: json_schema`, Anthropic tool use, Gemini
   `responseSchema`).
4. Otherwise it falls back to system-prompt instructions + `jsonrepair`
   (best-effort parser for malformed JSON from older models).
5. The facade re-validates the result against the original Zod schema
   before returning.

If the result fails Zod validation, the facade retries up to 2 times
with the validation error fed back into the prompt — this catches
"forgot a field" and "wrong type" errors that fixed-prompt variants
struggle with.

## 7. Streaming Chat

`streamChatCompletion` returns an async iterable of
`ChatCompletionChunk`s, each containing a delta. The facade handles:

- **Usage accumulation** — final chunk emits a `usage` block with
  `inputTokens` / `outputTokens` / `cost` (cost computed from the
  model catalog if available).
- **Error normalisation** — provider-specific errors are wrapped in
  `AiFacadeError` with `operation: 'stream'`, `provider`, `cause`.
- **Cancellation** — the consumer can `break` out of the iterable; the
  facade signals the underlying plugin to abort.

This is what powers the AI Conversation feature — the API streams NDJSON
on top of this iterable.

## 8. Reasoning & Routing Overrides

`AiRoutingOptions` (passed via `opts.routing`) carries:

| Field             | Effect                                                                         |
| ----------------- | ------------------------------------------------------------------------------ |
| `reasoningEffort` | `'low' \| 'medium' \| 'high'`. Picks reasoning-tier model + sets effort param. |
| `temperature`     | Override the plugin's default temperature.                                     |
| `maxTokens`       | Override the plugin's default max tokens.                                      |
| `tools`           | Tool definitions (for tool-calling models).                                    |
| `forceModel`      | Bypass tier resolution, use this exact model.                                  |
| `responseFormat`  | `'text' \| 'json_object' \| 'json_schema'`.                                    |

`reasoning.utils.ts` (in `@ever-works/plugin/ai`) holds the canonical
mapping between the platform's reasoning levels and provider-native
parameters. Adding reasoning support for a new model is a single map
entry — the facade and plugins both consult it.

## 9. Caching

`AiFacadeService.CACHE_TTL = 3_600_000` (1 hour). The facade caches:

- The resolved provider plugin per `(userId, directoryId)` tuple.
- The resolved provider config per `(userId, directoryId, providerId)`.
- The model catalog (process-wide, 1 h).

The cache invalidates automatically on `onSettingsUpdated` events that
match the plugin id or capability. Cache keys are not the place to
debug stale settings — use `PluginSettingsService.resolveWithSources`
(see [Settings System spec](./settings-system.md#9-setting-resolution-api))
to see what each tier returned.

## 10. Validation

`validateConnection(providerId)` is the platform's "are these creds and
this model wired up correctly?" call. It:

1. Resolves the plugin and its settings (errors if not enabled).
2. For each tier (`simpleModel`, `mediumModel`, `complexModel`,
   `defaultModel`):
    - Fires a tiny `chatCompletion` ("ping" prompt).
    - Records `success`, `responseTime`, optional `error`.
3. Returns a `ConnectionValidationResult` with overall success +
   per-tier `modelResults`.

The dashboard renders this as the test-button output on the plugin
settings page. Pipelines call it as a pre-flight check before kicking
off long generations — `'failed: anthropic.complexModel
claude-sonnet-4-5 returned 401'` is much friendlier than a 30-minute
generation that dies halfway through.

## 11. Embeddings

`embeddings(opts)` is the same cascade for embedding-capable plugins.
Used by the comparison generator and the keyword extractor. The facade
returns `Float32Array[]` to keep the bus small; dimensions vary by
model.

## 12. Error Hierarchy

All facade errors inherit from `AiFacadeError extends FacadeError`:

| Class                   | When                                                    |
| ----------------------- | ------------------------------------------------------- |
| `AiFacadeError`         | Base class. Carries `operation`, `provider?`, `cause?`. |
| Wrapped provider errors | Plugin throws → wrapped with operation context.         |

Callers can branch on `error.operation` (`'chatCompletion'`, `'askJson'`,
`'stream'`, `'validate'`) and `error.provider` to surface targeted
recovery hints.

## 13. Performance & Cost

- **Cache hit** path adds < 5 ms. Cold path adds DB roundtrip + plugin
  instantiation.
- **Streaming** has no extra buffering — chunks flow straight through.
- **Cost** is reported in the final usage block when the model catalog
  has pricing for the model. Pipelines aggregate per-run cost into
  the activity log changelog.

## 14. Constitution Reconciliation

| Principle                   | How the AI facade respects it                                                         |
| --------------------------- | ------------------------------------------------------------------------------------- |
| I — Plugin-first            | All AI calls flow through plugin contracts.                                           |
| II — Capability-driven      | Resolution by capability, never plugin id.                                            |
| III — Source-of-truth repos | AI facade is in-memory; no data persistence.                                          |
| IV — Trigger.dev            | Heavy generation runs as background jobs that _use_ the facade.                       |
| V — Forward-only migrations | No DB.                                                                                |
| VI — Tests                  | Facade + each AI provider plugin has full Vitest / Jest coverage with mock LangChain. |
| VII — Secret hygiene        | API keys flow via `PluginSettings`; never logged; never serialised in errors.         |
| VIII — Plugin counts        | The catalog reports counts dynamically.                                               |
| IX — Behaviour-first        | This spec describes observable behaviour.                                             |
| X — Backwards-compat        | `IAiFacade` is versioned with the SDK.                                                |

## 15. References

- Source:
    - `packages/agent/src/facades/ai.facade.ts`
    - `packages/agent/src/facades/model-catalog.ts`
    - `packages/plugin/src/contracts/capabilities/ai-provider.interface.ts`
    - `packages/plugin/src/abstract/base-ai-provider.ts`
    - `packages/plugin/src/ai/`
- Related specs:
    - [`plugin-sdk`](./plugin-sdk.md)
    - [`settings-system`](./settings-system.md)
    - [`pipeline-overview`](./pipeline-overview.md)
- User docs: [`docs/ai-agents/`](../../ai-agents/)
- AI provider plugin docs:
  [`docs/plugin-system/built-in-plugins#ai-providers`](../../plugin-system/built-in-plugins.md#ai-providers)
