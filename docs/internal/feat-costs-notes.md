# Costs dashboard — implementation notes

Branch: `session/feat-costs`. Surface: **Settings → Usage & Credits → Costs**
(`/settings/usage?tab=costs`).

## What shipped

A Costs tab beside the existing Usage & Credits overview, answering "where did
the AI spend of the last 7 / 30 / 90 days actually go":

- headline tiles — total spend, agent runs, average cost per run;
- daily spend, **stacked by Agent** (dense day axis, top 6 agents + `other` +
  `unattributed`);
- per-Agent table — cost, runs, average per run;
- per-model list — cost, share bar, units, and the window denominator;
- most-expensive-runs table — cost, agent, task, model, started, status.

Everything additive. The Overview tab's component tree, endpoints and testids
are untouched, and it stays the default arm of the page.

## What the code already had (and the brief assumed it did not)

The brief planned for two things that turned out to be present on `develop`
already. Both plans were dropped in favour of the existing implementation:

| Brief assumption                                                                           | Reality                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Model id per call may not be recorded — add `modelId` capture at the usage-emission seam" | `plugin_usage_events.modelId` already exists and `AiFacadeService` already stamps `response.model` on **every** `pluginUsageService.record(...)` call site. No emission change was needed, so none was made. |
| "Add by-model / by-agent aggregations"                                                     | Wave 13 already shipped `PluginUsageRepository.getSpendByModelForUser` / `getSpendByAgentForUser` behind `GET /api/credits/usage-summary?groupBy=`. Those are reused rather than duplicated.                 |

What was genuinely missing, and is what this branch adds: the **rolling
7/30/90-day window** (the existing period grammar is `YYYY-MM | 7d | 30d`), the
**daily × agent** cross-tab, **run counts and per-run averages**, and the
**top-runs** view.

## Cache-hit rate: deliberately omitted, not forgotten

The brief said to compute cache-hit % "if present in run-log metadata, else omit
and note a follow-up (do NOT fake it)". It is **not** present:

- `PluginUsageService.record` persists `metadata: { operation, promptTokens,
completionTokens }` — no cached-read component;
- `packages/plugin`'s `TokenUsage` is `{ promptTokens, completionTokens,
totalTokens }`; nothing on the dispatch path carries
  `cache_read_input_tokens`;
- the only code in the repo that sees the field is
  `packages/plugins/claude-managed-agent`, which surfaces it as pipeline
  `metrics` that are never persisted;
- `WorkRunsSummary` in `agent-run.repository.ts` documents the identical finding
  for its token rollup.

So the column is absent from the API and the UI, and the UI states why
(`dashboard.settings.costs.cacheHitNote`). See the follow-ups below.

## Data model

**No new entities and no new columns.** Three covering indexes only:

| Table                 | Index                                                                       | Serves                                                                                                               |
| --------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `plugin_usage_events` | `idx_plugin_usage_events_user_agent_occurred (userId, agentId, occurredAt)` | per-agent rollups, daily × agent                                                                                     |
| `plugin_usage_events` | `idx_plugin_usage_events_user_model_occurred (userId, modelId, occurredAt)` | per-model rollup                                                                                                     |
| `agent_runs`          | `idx_agent_runs_user_created (userId, createdAt)`                           | run counts, top-runs — `agent_runs` had **no** user-keyed index at all, so `listSessionsForUser` was a full scan too |

Migration: `apps/api/src/migrations/1786910000000-AddCostsDashboardIndexes.ts`
(portable `TableIndex` DDL, idempotent in both directions, skips tables that do
not exist yet). Matching `@Index()` declarations were added to
`plugin-usage-event.entity.ts` and `agent-run.entity.ts`.

## Endpoints

All owner-scoped via `@CurrentUser()`; **no endpoint accepts a user or org id**.
`windowDays` ∈ `{7, 30, 90}` (default 30), enforced by a class-validator
allow-list and re-checked in the service (`InvalidCostsWindowError` → 400).

| Method | Path                        | Returns                                             |
| ------ | --------------------------- | --------------------------------------------------- |
| GET    | `/api/usage/costs/summary`  | `totalCostCents`, `runsCount`, `avgPerRunCents`     |
| GET    | `/api/usage/costs/daily`    | `series[]` (agent + sentinels) and a dense `days[]` |
| GET    | `/api/usage/costs/by-agent` | `rows[]` — cost, runs, avg per run                  |
| GET    | `/api/usage/costs/by-model` | `totalCostCents` + `rows[]` with `sharePercent`     |
| GET    | `/api/usage/costs/top-runs` | `rows[]` (`limit` default 20, max 50)               |

Controller: `apps/api/src/subscriptions/costs.controller.ts`, registered on the
api-side `SubscriptionsModule` beside `CreditsController`.

Service: `packages/agent/src/subscriptions/credits/costs-summary.service.ts`,
exported from `@ever-works/agent/subscriptions` (barrel + module pin spec
updated).

### Semantics worth knowing

- **Window** is half-open `[from, to)`; `from` is snapped to UTC midnight so the
  first bar is a whole day, `to` is "now" so the newest events are included. A
  `7d` window is today plus the six whole days before it — seven bars, not eight.
- **`unattributed`** is real spend with `agentId IS NULL` (the Work-generator
  flow, ad-hoc facade calls). It gets its own series/row; it is never folded
  into an agent's numbers or dropped.
- **`other`** is the folded tail past the top 6 agents. Folding preserves the
  day totals.
- **Top runs excludes `costCents IS NULL`**: NULL means run-cost settlement has
  not stamped the run, i.e. "unknown", not "free". Ties break on `id` so paging
  is deterministic.
- **Dominant model per run** = the model accounting for the most spend in that
  run (units break ties), resolved in one grouped query for the whole page.
- **`sharePercent`** is computed against the sum of the returned rows, not a
  separately-queried total, so the shares always add up.

## UI

- Route: `/settings/usage?tab=costs` (`ROUTES.DASHBOARD_USAGE_COSTS`). The tab
  bar is a server component with plain links, so each tab loads only its own
  endpoints and a `?tab=costs` link is shareable and server-rendered.
- Page: `apps/web/src/app/[locale]/(dashboard)/settings/usage/page.tsx` — branches
  on `parseUsageTab`; the Overview arm is byte-for-byte the previous behaviour.
- Components: `apps/web/src/components/settings/costs/` (`CostsSettings`,
  `CostsDailyStackedChart`, `CostsByModelList`) and
  `apps/web/src/components/settings/usage/UsageTabs.tsx`.
- Charting uses **recharts**, already a dependency (same primitives as
  `UsageByDayChart`). No new dependency was added.
- Client refetch goes through `apps/web/src/app/api/usage/costs/[section]/route.ts`,
  which allow-lists both the section and the query parameters.
- i18n: `dashboard.settings.usage.tabs.*` and `dashboard.settings.costs.*`, added
  to all 21 locale files with the English string copied verbatim (no machine
  translation).

## Tests

```bash
# Aggregation semantics + window edges (mocked repositories)
cd packages/agent && npx jest --testPathPattern='costs-summary'

# The same aggregations executed against in-memory better-sqlite3 over seeded
# rows: half-open window edges, NULL-agent bucket, top-runs ordering + ties
cd packages/agent && npx jest --testPathPattern='costs-aggregations'

# Barrel + module provider/export pins (updated for CostsSummaryService)
cd packages/agent && npx jest --testPathPattern='subscriptions.module'

# Controller owner-scoping, DTO allow-list, 400 mapping
cd apps/api && npx jest --testPathPattern='costs.controller'

# Migration applied + reverted against a real database, twice each, plus the
# guard that keeps migration specs OUT of the flat `dist/migrations/*.js`
# runtime glob (a spec compiled into it crash-loops the API on boot).
cd apps/api && npx jest --testPathPattern='migrations/__tests__'

# Wire helpers, tab parsing, and the rendered panels + window picker
cd apps/web && npx vitest run src/lib/api/costs.shared.unit.spec.ts \
  src/lib/api/usage-tabs.shared.unit.spec.ts src/components/settings/costs
```

Build / type-check:

```bash
npx turbo build --filter=@ever-works/agent --filter=@ever-works/contracts
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd apps/web && npx tsc --noEmit
```

## Known follow-ups

1. **Cache-hit rate.** Needs `cache_read_input_tokens` carried end to end:
   widen `packages/plugin`'s `TokenUsage`, have `AiOperations` / the provider
   plugins report it, persist it on `plugin_usage_events` (a new nullable
   `cachedInputTokens` column), and only then add the column. Historic rows will
   read as unknown, not 0.
2. **Work column on top-runs.** `AgentRun.workId` is available but was left off
   the wire on purpose: the row would carry an id the UI has no name for. Add it
   together with `getWorkNames` resolution.
3. **`limit` on top-runs has no UI control yet** — the API and the server wrapper
   support it; the tab always requests the default 20.
4. **sqlite day bucketing.** Daily buckets are computed in JS from the round-tripped
   `occurredAt` (the existing `getDailySpendForUser` does the same) because
   `date_trunc`/`to_char` are Postgres-only. On better-sqlite3 the driver reads a
   timestamp back in the process timezone, so a midnight-UTC event can land in the
   previous day's bucket on a non-UTC runner. Production is Postgres; the
   integration spec works around it by asserting day relationships rather than
   absolute day strings. A shared portable day-bucket helper would fix both
   call sites at once.
5. **No e2e spec yet.** The Playwright journey
   (`apps/web/e2e/flow-billing-usage-ui-journey.spec.ts`) still covers only the
   Overview tab; a Costs arm (tab switch → panels mount → window toggle) is cheap
   to add once this lands.
