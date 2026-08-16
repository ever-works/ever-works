# feat-cma-scale — Cloud Managed Agents at scale

Branch: `session/feat-cma-scale`. Scope: `packages/plugins/claude-managed-agent` only
(plus the root `pnpm-lock.yaml` for the SDK dependency move).

Goal: run Claude Managed Agents (CMA) efficiently at scale — a persistent control plane
instead of create-and-delete per run, a bounded-concurrency fan-out service, per-session
budget caps, and token/cost figures that actually reach the platform's usage rollups.

## What shipped

### 1. SDK dependency

`@anthropic-ai/sdk` moved from **devDependencies `0.91.1`** to **dependencies `^0.117.1`**.
It was already the transport on `develop` (`AnthropicManagedAgentsClient` wraps
`client.beta.*`), but as a dev dependency the published/bundled plugin declared no runtime
dependency on it — tsup keeps it external, so the import would have been unresolved for
any consumer installing the package. 0.117.x is also the first version with the typed
`limited` networking policy, `budget`, `initial_events` and `agent_with_overrides` shapes
this branch relies on.

There are **no left-behind non-SDK call sites** — every CMA request goes through
`AnthropicManagedAgentsClient`, and `utils/cma-sdk.ts` is the single construction seam
(API key + base URL resolution) used by the pipeline, the control plane and the fan-out.

> Deviation from the brief: the brief assumed `managed-agents-client.ts` was a hand-rolled
> REST client to be left alone while new code went through a new SDK wrapper. It was
> already SDK-based, so the wrapper stayed in place and was extended instead of duplicated.

### 2. Persistent control plane — `utils/control-plane.ts`

New user-scope, `x-hidden`, plugin-written settings: `managedAgentId`,
`managedAgentConfigHash`, `managedEnvironmentId`, `managedEnvironmentConfigHash`
(persisted through `context.updateSettings('user', …)`).

- `ensureManagedAgent` — no stored id → create; stored id + matching hash → reuse; hash
  drift → `agents.update` (new immutable version upstream); stored id missing/archived →
  recreate. The config hash deliberately **excludes the model**: sessions pin the model per
  run via `agent_with_overrides`, so a model change must not churn agent versions.
- `ensureManagedEnvironment` — same matrix against the resolved networking policy. The
  policy comes from the optional serializable `execContext.runtimeEnvironment` object when
  the platform provides one (Environments feature, parallel branch — read defensively, the
  entity is **not** imported), else the existing `CLAUDE_MANAGED_AGENT_EGRESS_HOSTS`
  env-var fallback.
- Persisting state is best-effort: a failed write logs and the run continues with the
  resolved ids.

New setting `reuseControlPlane` (boolean, default **true**). When false the plugin falls
back to today's ephemeral behavior: work-scoped agent + environment created per run and
torn down at cleanup. In reuse mode the run's session is **archived** (not deleted) and the
agent/environment are never touched.

### 3. Fan-out — `utils/fan-out.ts` + `ClaudeManagedAgentPlugin.runSessions()`

`runManagedSessions(client, {prompts, agentId, environmentId, concurrency = 5,
perSessionBudgetUsd?, timeoutMs?, resources?, agentOverrides?, signal?, archiveSessions?})`
→ per-prompt `{id, status, output?, sessionId?, tokens?, costUsd?, error?}`, in prompt
order. Simple index-cursor worker pool (no dependencies); a failing session never aborts
its siblings; every created session is archived best-effort; `timeoutMs` is converted into
a poll-attempt bound over the existing `waitForSessionIdle` polling (the events stream has
no replay, so poll-to-idle stays the mechanism).

Two entry points:

- **Pipeline step `run-variant-sessions`** (optional, `steps.ts`): active only when the
  generation form's `variant_sessions` > 1. Each variant gets a single combined prompt
  (`buildVariantSessionPrompt` — bootstrap / generate / collect phases in one message),
  results are parsed independently and merged with de-duplication
  (`mergeVariantOutputs`: item key = lowercased `name::source_url`, first variant wins).
  A failed variant becomes a warning; only an all-failed batch fails the run. With
  `variant_sessions` at its default of 1 the step is skipped and the single-session path is
  unchanged.
- **`plugin.runSessions({prompts, userId, workId?, concurrency?, perSessionBudgetUsd?,
timeoutMs?, resources?, signal?})`** for API-side / Trigger.dev callers. Resolves
  settings (work-scoped when `workId` is given, else user-scoped), ensures the control
  plane, runs the batch, and tears down an ephemeral control plane afterwards.

Registration: `onLoad` publishes the service on the platform's custom-capability registry
under `CMA_FAN_OUT_CAPABILITY` (`'claude-managed-agent.fan-out'`), so callers can reach it
via `CustomCapabilityRegistryService.getImplementation(CMA_FAN_OUT_CAPABILITY)` without
holding the plugin instance. Registration is guarded (partial contexts, duplicate-name
throw on re-load) and never fatal to loading the plugin; the lifecycle manager already
unregisters by provider on unload.

### 4. Budget caps

New form field `per_session_budget_usd` (1..500). `budget` is create-only upstream, so it
is passed to `sessions.create` as `{type:'limit', max_list_cost:{amount:'<cents>',
currency:'USD'}}` — integer minor units, never floats.

The ceiling is enforced by a single helper, `clampPerSessionBudgetUsd` (form-schema.ts),
applied on **all three** paths that can reach `sessions.create`: form validation, a raw
`GenerationRequest` reaching `execute()` directly, and the programmatic `runSessions()`.
`variant_sessions` (1..8) and `target_items` (1..250) are clamped the same way.

### 5. Usage accounting — `utils/usage-metrics.ts`

`buildManagedAgentMetrics()` writes `tokenUsage.total.totalTokens` and `totalCost` at the
**metrics root**, plus a per-session breakdown under `custom` for logs.

> This was the branch's one real defect. The interrupted session put those keys inside the
> `custom` bag (via the plugin-runtime `buildMetrics()` helper, which nests whatever it is
> given under `metrics.custom`), while the platform's consumer,
> `extractPipelineUsageMetrics` in `packages/agent/src/utils/metrics.util.ts`, only reads
> `metrics.tokenUsage.total.totalTokens`, `metrics.totalCost` and per-step
> `steps[*].custom.totalTokens|totalCost`. Every token and dollar the plugin reported was
> therefore dropped from the rollup — wired but dead, and pinned that way by a test.
> The shape now matches the `agent-pipeline` plugin's convention, and the contract is
> asserted with a faithful replica of the consumer in the plugin spec (plugin packages
> cannot import `@ever-works/agent`).

Per-session cost comes from `usage.list_cost` (integer minor units, USD-only; non-USD or
malformed amounts yield `undefined` rather than a wrong number).

Token counting goes through one seam, `toManagedSessionTokenUsage()`, shared by the
fan-out and single-session paths. `totalTokens` counts **every billed token class**:
`input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
The two cache counters are reported by the sessions API _outside_ `input_tokens`, and
managed-agent sessions re-read a large cached prefix on every turn, so omitting them
under-reported the rollup by orders of magnitude (see review findings below).

**No `plugin_usage_events` ledger row is emitted.** That was checked, not assumed:
`PluginUsageService` is an API/agent-side Nest provider reached only through the
`*.facade.ts` seams (ai / search / screenshot / extractor / email / notification /
metrics). `PluginContext` exposes no usage seam and `PluginEventName` has no usage event,
so a pipeline plugin cannot reach the ledger. Per the brief this falls back to reporting
figures in the pipeline metrics — see follow-ups.

## Data model / endpoints / UI

None. No entities, no migration, no controllers, no web routes, no i18n keys. The two new
form fields and `reuseControlPlane` render from the plugin's existing JSON-schema/form
provider surfaces.

## Test commands

```bash
cd packages/plugins/claude-managed-agent
pnpm type-check          # tsc --noEmit
pnpm test                # vitest run — 6 files, 55 tests
npx vitest run src/utils/usage-metrics.spec.ts
npx vitest run src/utils/control-plane.spec.ts
npx vitest run src/utils/fan-out.spec.ts
npx vitest run src/claude-managed-agent.plugin.spec.ts

# from repo root
npx turbo build --filter=@ever-works/claude-managed-agent-plugin...
npx prettier --check "packages/plugins/claude-managed-agent/src/**/*.ts"
```

Coverage added on this branch: ensure-agent create/reuse/version-bump/recreate matrix;
ensure-environment with and without the `runtimeEnvironment` context object; fan-out pool
concurrency ceiling, budget pass-through, failure isolation, archive behavior, timeout
derivation and cancellation; ephemeral-mode fallback end to end; capability registration
(including double-load); budget clamping on the programmatic path; and the usage-metrics
shape against a replica of the platform consumer.

## Pre-merge review findings (fixed on this branch)

1. **Cached input tokens were dropped from the usage rollup.** `mapSession()` mapped
   `cache_creation_input_tokens` / `cache_read_input_tokens` onto `ManagedAgentsUsage`,
   but nothing read them: both the fan-out `toTokenUsage()` and the single-session
   metrics block computed `totalTokens = input_tokens + output_tokens`. Anthropic
   reports both cache counters _outside_ `input_tokens`, so a session using
   `{input 1200, output 800, cache_creation 24000, cache_read 640000}` reported
   `total_tokens_used: 2000` instead of 666,000. The `custom.usage` bag was also a
   regression against `develop`, which at least carried the raw usage object. Fixed by
   a single shared mapper (`toManagedSessionTokenUsage`) used by both paths, with the
   cache counters summed into `totalTokens` and broken out in `custom.usage`.
2. **Ephemeral runs ignored the runtime environment's networking policy.** The
   `reuseControlPlane === false` branch of `execute()` built its environment inline with
   `createEnvironment({ name })` and never consulted `execContext.runtimeEnvironment`, so
   `resolveNetworking()` never ran on that path — an explicit `limited` egress allow-list
   was silently downgraded to the env-var default (`unrestricted`). The reuse path and
   `ensureControlPlane`'s own ephemeral branch both honored it; only this duplicated
   inline copy did not. Networking is a security control, so both modes now resolve it.
3. **The fan-out concurrency test asserted nothing.** `expect(peakActive)
.toBeLessThanOrEqual(2)` also passes for a fully serial pool, so a regression to
   one-session-at-a-time would have stayed green. Tightened to `toBe(2)`.

Regression coverage added for all three, plus the previously unasserted per-session
budget cap on the single-session path.

## Known follow-ups

1. **Ledger rows.** To get real `plugin_usage_events` rows for pipeline runs, the seam has
   to be added platform-side: a `PluginUsageCapability.PIPELINE` enum value (additive,
   the column is varchar — no migration) and a `PluginUsageService.record()` call from
   `DataGeneratorService.convertPipelineMetrics()`, which already has the work/user scope
   and the extracted totals. Deliberately out of scope here: it is a cross-cutting change
   affecting every pipeline plugin, not just this one.
2. **Session runtime cost.** `usage.list_cost` covers model tokens; the $0.08/hour session
   runtime charge is not broken out by the API response the plugin sees, so `totalCost`
   under-reports wall-clock-heavy runs.
3. ~~**`runtimeEnvironment` producer.**~~ RESOLVED at integration. The Environments branch
   shipped `RuntimeEnvironmentData` (`@ever-works/plugin`), whose networking fields are
   FLAT (`networkingMode`, `allowedHosts`, `allowPackageManagers`). This plugin's local
   `ManagedRuntimeEnvironment` guess had a NESTED `networking` object, so it never matched
   real data and every configured Environment silently fell back to the env-var policy.
   The local type is deleted; `resolveNetworking()` now delegates to
   `resolveEnvironmentNetworking()` and both share `ManagedEnvironmentNetworking` as the
   single output type (the legacy `{type:'allowlist', hosts}` variant, unverifiable against
   the pinned SDK, is retired). Integration-level assertions live in
   `claude-managed-agent.plugin.runtime-environment.spec.ts`.
4. **Fan-out concurrency is not exposed on the generation form.** Variant runs use the
   default of 5; only the programmatic `runSessions()` caller can tune it.
5. **No SSE consumption.** Sessions are still polled to idle. If the events stream gains
   replay, `waitForSessionIdle` is the single place to swap.
