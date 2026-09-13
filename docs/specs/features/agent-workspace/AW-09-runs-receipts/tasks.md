# AW-09 — Runs and receipts · Task breakdown

> Ordered, executable tasks derived from [plan.md](./plan.md). Each carries explicit file paths,
> a definition of done, and its phase. Work top to bottom; nothing below requires a guess.

**Epic ID:** `AW-09-runs-receipts`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-09-06

---

## How to use

- Tasks are sequential unless marked `(parallel)`.
- Phase boundaries are release boundaries: **P1**, **P2** and **P3** each leave `develop` green
  and shippable on their own.
- `MODIFY` means an existing file changes; `CREATE` means a new file.
- Every task that changes an entity ships its migration in the **same PR** (Constitution V).
- Add new tasks at the bottom rather than renumbering.

---

# Phase 1 — The ledger

*No migration. Reads only what `agent_runs` and `agent_run_logs` already hold.*

## P1.A — Contracts

- [ ] **T1.** Add the run-ledger contract types.
    - CREATE `packages/contracts/src/runs/run-ledger.types.ts` with `RunLedgerGranularity`,
      `RunLedgerWindow`, `RunLedgerRow`, `RunLedgerPage`, `RunWindowStats`, `RunTokenSplit`,
      `RunCalendarDay`, `RunCostBreakdown`, `RunReceipt`, `UpcomingFire` exactly as shaped in
      [plan.md §3.3](./plan.md#33-contracts).
    - CREATE `packages/contracts/src/runs/index.ts` re-exporting the above.
    - MODIFY `packages/contracts/src/index.ts` — add `export * from './runs/index.js';` beside the
      existing `./agents/index.js` line.
    - Import `AgentRunTimelineEntry` from the existing agents contract; do **not** redeclare it.
    - **Done when**: `pnpm --filter @ever-works/contracts build` emits declarations with no DTS
      error, and no type in the new file duplicates one that already exists in the package.

- [ ] **T2** (parallel with T1). Add the failure-code and skill-use types to the Run entity module
      without any column change yet.
    - MODIFY `packages/agent/src/entities/agent-run.entity.ts` — export `RunFailureCode` and
      `RunSkillUse` types only (columns land in P2/P3), and add `'email'` to the
      `AgentRunTriggerKind` union with the comment that no row carries it until AW-05 writes one.
    - **Done when**: `pnpm --filter @ever-works/agent type-check` is green and no migration is
      generated (the union widens a `varchar(16)` column; nothing in the schema changes).

## P1.B — Read model (agent package)

- [ ] **T3.** Window resolution helper.
    - CREATE `packages/agent/src/agents/run-window.ts` — `resolveWindow({ granularity, anchorDate,
      timezone })` returning `RunLedgerWindow`; Monday week start; month = calendar month in the
      given timezone; clamp to `now − 12 months` … `now + 7 days` and set `clamped`.
    - CREATE `packages/agent/src/agents/__tests__/run-window.spec.ts` — Day/Week/Month boundaries,
      a DST transition in a non-UTC zone, the clamp at both ends, an invalid timezone falling back
      to UTC.
    - **Done when**: the spec passes and `resolveWindow` has no dependency on TypeORM or Nest.

- [ ] **T4.** Ledger repository reads.
    - MODIFY `packages/agent/src/database/repositories/agent-run.repository.ts` — add
      `listLedgerPage(userId, scope, window, filters, limit, cursor)`,
      `countLedger(userId, scope, window, filters)` and
      `calendarCounts(userId, scope, month, timezone, filters)`.
      Every query filters `userId = :userId` and the active `organizationId` **inside the
      repository**, exactly like `listSessionsForUser` does today. Cursor is the existing
      `<epochMillis>_<uuid>` shape.
    - CREATE `packages/agent/src/database/repositories/agent-run.ledger.spec.ts` — a second user's
      rows are unreachable through every filter permutation; cursor paging is stable when rows are
      inserted between pages.
    - **Done when**: both specs pass and no new raw cross-table SQL was introduced.

- [ ] **T5.** `RunLedgerService`.
    - CREATE `packages/agent/src/agents/run-ledger.service.ts` — `listRuns`, `getStats`,
      `getCalendar`. Resolves the window (T3), calls the repository (T4), maps rows to
      `RunLedgerRow` (resolving agent name + archived flag and mission title in one batched lookup
      each, never per row), derives `scheduleKey` (`agent_heartbeat:<agentId>` for
      `triggerKind === 'heartbeat'`; `null` otherwise in P1).
    - CREATE `packages/agent/src/agents/run-ledger.service.spec.ts` — filter composition (AND
      across dimensions, OR within), `scheduleKey` derivation, batched name resolution (assert at
      most one lookup call per entity kind for a 50-row page).
    - **Done when**: specs pass and a 50-row page issues a bounded, constant number of queries.

- [ ] **T6.** Window statistics.
    - CREATE `packages/agent/src/agents/run-window-stats.ts` — pure functions computing
      `successRate` (completed ÷ terminal, one decimal, `null` when terminal = 0), `errorCount`,
      `totalDurationMs`, `costCents`, `creditsDebited`, `tokens`, `byStatus`, `byTrigger`, and
      `repeatFailures` (group failed rows by `scheduleKey`, keep groups with **≥ 2**).
    - CREATE `packages/agent/src/agents/__tests__/run-window-stats.spec.ts` — zero terminal runs,
      exactly 1 / 2 / 3 failures per schedule, `null` values mixed into token sums.
    - **Done when**: specs pass; no function reads a repository (all inputs are rows).

- [ ] **T7.** `RunReceiptService` (P1 shape).
    - CREATE `packages/agent/src/agents/run-receipt.service.ts` — loads one run scoped to the
      caller, assembles `RunReceipt`: `row`, `counts`, `filesTouched`, `related` (mission, task,
      work, agent, schedule link), `timeline` (delegating to the existing
      `AgentRunLogRepository.findTimelineByRun` / `countByRunSteps` and setting `captureTruncated`
      from the `capture-truncated` marker), `skills: []`, `failure: null`, and a `cost` block
      carrying only the settled `totalCents`/`creditsDebited` with `detailRetained: false`.
    - CREATE `packages/agent/src/agents/run-receipt.service.spec.ts` — a foreign run id resolves to
      `null` (never a partial object); `captureTruncated` detection; a run with no mission returns
      `missionId: null` rather than omitting the key.
    - **Done when**: specs pass and the returned shape matches `RunReceipt` in the contract exactly,
      including the fields P2 will fill.

- [ ] **T8.** Wire the services into the agent module.
    - MODIFY `packages/agent/src/agents/agents.module.ts` — provide and export `RunLedgerService`
      and `RunReceiptService`.
    - MODIFY `packages/agent/src/agents/index.ts` — export both plus `resolveWindow` and the stats
      helpers.
    - **Done when**: `apps/api/src/agents/agents.module.spec.ts` still passes and the new providers
      resolve in a Nest testing module.

## P1.C — API

- [ ] **T9.** Runs module and DTOs.
    - CREATE `apps/api/src/runs/runs.module.ts` — imports the agent `AgentsModule`,
      `SchedulesModule` and `SubscriptionsModule`.
    - CREATE `apps/api/src/runs/dto/run-ledger.dto.ts` — `ListRunsQueryDto`, `RunStatsQueryDto`,
      `RunCalendarQueryDto`, `RunReceiptQueryDto` with the exact validators and bounds in
      [plan.md §4.1](./plan.md#41-get-apiruns--the-ledger-page). Every numeric query field carries
      `@Type(() => Number)` **before** `@IsInt()`.
    - MODIFY `apps/api/src/api.module.ts` — register `RunsModule`.
    - **Done when**: `pnpm --filter ever-works-api type-check` is green and the module boots in a
      Nest testing module.

- [ ] **T10.** Runs controller.
    - CREATE `apps/api/src/runs/runs.controller.ts` — `@Controller('api/runs')`,
      `@UseGuards(AuthSessionGuard)`, `@ApiTags('Runs')`, `@ApiBearerAuth('JWT-auth')`.
      Endpoints in this declaration order: `GET stats`, `GET calendar`, `GET /` (root),
      `GET :runId/receipt`. Literal segments **must** precede `:runId`. Throttles per
      [plan.md §4](./plan.md#4-api). Swagger `@ApiOperation` / `@ApiResponse` on every route.
      No route accepts a user, tenant or Organization id.
    - **Done when**: `GET /api/runs/stats` never reaches `ParseUUIDPipe`, and a missing or foreign
      `runId` both return an identical `404` body.

- [ ] **T11.** Controller specs.
    - CREATE `apps/api/src/runs/runs.controller.spec.ts` — route ordering; DTO rejection of a
      120-day window, `limit=500`, `q` of 1 character, an unknown timezone; `limit` defaults to 50;
      no parameter can widen scope.
    - CREATE `apps/api/src/runs/runs.controller.receipt.spec.ts` — identical `404` for unknown and
      foreign ids; timeline paging via cursor; the P1 cost-block shape.
    - **Done when**: both specs pass under `cd apps/api && pnpm test`.

## P1.D — Web

- [ ] **T12.** Routes, constants and navigation.
    - MODIFY `apps/web/src/lib/constants.ts` — add `DASHBOARD_RUNS: '/runs'` and
      `DASHBOARD_RUN: (runId: string) => '/runs/' + runId`.
    - MODIFY `apps/web/src/components/dashboard/DashboardSidebar.tsx` — add the Runs entry
      immediately above the existing Activity entry.
    - **Done when**: the sidebar renders Runs and its active state highlights on `/runs` and
      `/runs/<id>`.

- [ ] **T13.** Typed client, server actions and the BFF proxy.
    - CREATE `apps/web/src/lib/api/runs.shared.ts` — client-safe mirrors of the contract types plus
      `runRowCursor()`, `formatTokenSplit()`, `nextTimeLimitStep()` (pure).
    - CREATE `apps/web/src/lib/api/runs.ts` — `server-only`; `runsAPI.list/stats/calendar/receipt`
      via `serverFetch`, forwarding `X-Scope-Slug`. Mirror
      `apps/web/src/lib/api/activity-log.ts`.
    - CREATE `apps/web/src/app/actions/runs.ts` — `getRuns`, `getRunStats`, `getRunCalendar`,
      `getRunReceipt`; auth-guarded like `apps/web/src/app/actions/activity-log.ts`.
    - CREATE `apps/web/src/app/api/runs/[section]/route.ts` — cookie→Bearer proxy with a **closed**
      section allowlist (`list`, `stats`, `calendar`, `receipt`; `upcoming` added in P3) and an
      **explicit query-param allowlist** — never the raw query string. Mirror
      `apps/web/src/app/api/usage/costs/[section]/route.ts`.
    - CREATE `apps/web/src/lib/api/runs.shared.unit.spec.ts` — the pure helpers, including
      `formatTokenSplit` returning the not-measured marker for `null` and never `0`.
    - **Done when**: an unknown section 404s in the proxy before any upstream call, and an
      unlisted query param is dropped rather than forwarded.

- [ ] **T14.** Extract the timeline renderer so the receipt can reuse it.
    - CREATE `apps/web/src/components/agents/RunTimeline.tsx` — the timeline list, tool rows,
      previews, truncation markers and "Load older entries" control, lifted verbatim from
      `SessionDetailClient.tsx`.
    - MODIFY `apps/web/src/components/agents/SessionDetailClient.tsx` — import and render
      `RunTimeline` in place of the inlined markup. No behaviour change.
    - **Done when**: `apps/web/src/components/agents/SessionDetailClient.unit.spec.tsx` passes
      **unchanged** — that spec is the proof the extraction was behaviour-neutral.

- [ ] **T15.** The page shells.
    - CREATE `apps/web/src/app/[locale]/(dashboard)/runs/page.tsx` — RSC. Parses `searchParams`
      (`g`, `d`, `agent`, `kind`, `status`, `mission`, `work`, `model`, `q`, `run`), resolves the
      caller's timezone, fetches list + stats + calendar with `Promise.allSettled`, and passes each
      result with its own error flag. `generateMetadata` uses `metadata.pages.runs`.
    - CREATE `apps/web/src/app/[locale]/(dashboard)/runs/[runId]/page.tsx` — standalone receipt;
      `notFound()` when the receipt read 404s.
    - **Done when**: a forced failure of any one of the three fetches still renders the page.

- [ ] **T16.** Ledger components.
    - CREATE, under `apps/web/src/components/runs/`: `RunsClient.tsx`, `RunsCalendarBar.tsx`,
      `RunsMiniCalendar.tsx`, `RunsFilters.tsx`, `RunsTable.tsx`, `RunRow.tsx`, `RunsRail.tsx`,
      `RunsEmptyState.tsx`, `RunsShortcutSheet.tsx`, `index.ts`.
    - `RunsClient` owns granularity (persisted in `localStorage` under `runs-granularity`), the
      anchor date, filters, focused row and open-receipt id, and mirrors all of them into the URL
      via `router.replace`.
    - Polling: start only when the window includes now **and** a listed run is `queued`/`running`;
      interval 5 s; stop on `document.hidden`; merge by id preserving scroll, focus and the open
      receipt.
    - `RunsTable` renders a `<table>` with a caption naming the window and the active filters;
      outcome is an icon **plus** a text label.
    - **Done when**: the ledger renders for Day, Week and Month; the rail is a filter shortcut; the
      three empty variants and the load-error variant all render as specified in
      [spec.md §6](./spec.md#6-ux).

- [ ] **T17.** Keyboard layer.
    - MODIFY `apps/web/src/components/runs/RunsClient.tsx` — a single document-level handler
      implementing `←`, `→`, `t`, `d`, `w`, `m`, `j`, `k`, `Enter`, `o`, `Esc`, `/`, `f`, `?`,
      inert whenever an `input`, `textarea`, `select` or `contenteditable` has focus.
    - CREATE `apps/web/src/components/runs/RunsCalendarBar.unit.spec.tsx` and
      `apps/web/src/components/runs/RunsMiniCalendar.unit.spec.tsx` — stepping, today, the two
      mini-calendar marker shapes, the 12-month reach notice.
    - **Done when**: typing `d` inside the search box does not switch the view.

- [ ] **T18.** Receipt panel (P1 blocks).
    - CREATE `apps/web/src/components/runs/RunReceiptPanel.tsx` — focus-trapped dialog; blocks in
      the FR-25 order; renders `RunTimeline` (T14); "so far" labelling for non-terminal runs;
      `Esc` closes and returns focus to the originating row.
    - CREATE `apps/web/src/components/runs/RunReceiptPanel.unit.spec.tsx`.
    - **Done when**: opening from a row and opening `/runs/<id>` directly render the same blocks.

- [ ] **T19.** i18n keys.
    - MODIFY `apps/web/messages/en.json` — add every key listed in
      [plan.md §8](./plan.md#8-i18n) except the `timeLimit.*`, `failure.*`, `upcoming.*`,
      `repeatFailure.*` and `export.*` groups (those land with their phases). Confirm every **leaf**
      name is camelCase and contains no literal `.`.
    - MODIFY the 20 sibling locale files in `apps/web/messages/` — same keys; English values are
      acceptable until translation lands. A missing key is a runtime failure; an untranslated value
      is not.
    - **Done when**: `pnpm --filter web test` (the i18n key-consistency check) is green for all 21 files.

- [ ] **T20.** Cross-links into Runs (additive; nothing is removed).
    - MODIFY `apps/web/src/components/agents/AgentSessionsClient.tsx` — header link
      **"Open in Runs"** → `/runs?agent=<id>`.
    - MODIFY `apps/web/src/components/agents/SessionDetailClient.tsx` — **"Open receipt"** →
      `/runs/<runId>`.
    - MODIFY `apps/web/src/components/agents/AgentActivityClient.tsx` — **"See this agent in
      Runs"**.
    - MODIFY `apps/web/src/components/settings/costs/CostsSettings.tsx` — link each *Top runs* row to
      `/runs/<runId>`; keep `CostsSettings.unit.spec.tsx` green.
    - **Done when**: every existing spec for those four components still passes.

## P1.E — End-to-end

- [ ] **T21.** Playwright coverage for the ledger.
    - CREATE `apps/web/e2e/runs-ledger.spec.ts`, `apps/web/e2e/runs-filters.spec.ts`,
      `apps/web/e2e/runs-receipt.spec.ts`, `apps/web/e2e/runs-empty-and-errors.spec.ts`,
      `apps/web/e2e/runs-accessibility.spec.ts` — scenarios per
      [plan.md §10.4](./plan.md#104-end-to-end-playwright-appswebe2e).
    - MODIFY `apps/web/e2e/COVERAGE.md` — record the new specs and the shard they belong to.
    - Query by role and accessible name, not by test id.
    - **Done when**: all five pass locally and in CI, and the axe pass reports no violations on the
      ledger or an open receipt.

- [ ] **T22.** P1 gate.
    - Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from the repo
      root and confirm green.
    - MODIFY `docs/specs/features/agent-workspace/TRACKER.md` — set AW-09 spec `Draft`, impl
      `In progress`, note "P1 merged".
    - **Done when**: the acceptance groups *Ledger*, *Navigation*, *Filters and rail* and the
      non-cost receipt criteria in [spec.md §8](./spec.md#8-acceptance-criteria) all pass.

---

# Phase 2 — The cost breakdown

*Migration A. Makes the token split, the Skills a run loaded, and per-model cost durable.*

- [ ] **T23.** Extend the token tracker with cache figures.
    - MODIFY `packages/plugin/src/ai/token-usage.tracker.ts` — widen `TokenUsage` with optional
      `cacheReadTokens` and `cacheWriteTokens`; read them from the same tolerant field set the
      tracker already uses (`cache_read_input_tokens`, `cache_creation_input_tokens`,
      `cached_tokens`, `input_token_details.cache_read`, plus camelCase twins). Leave both
      `undefined` when nothing is reported — **never coerce to `0`**.
    - MODIFY `packages/plugin/src/ai/__tests__/token-usage.tracker.spec.ts` — one case per tolerated
      field name, plus "absent stays undefined".
    - **Done when**: no provider name appears anywhere in the file (Principle II) and the spec
      passes under `cd packages/plugin && pnpm test`.

- [ ] **T24.** Thread the split through the AI path.
    - MODIFY `packages/plugin/src/ai/ai-operations.ts` — `mapTokenUsage` passes the two optional
      fields through.
    - MODIFY `packages/agent/src/agents/agent-ai-dispatch-facade.ts` — widen the `usage` shape with
      the same two optional fields.
    - MODIFY `packages/agent/src/facades/ai.facade.ts` — pass
      `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens` into
      `pluginUsageService.record(...)`. Keep writing `metadata.promptTokens` /
      `metadata.completionTokens` for one release cycle (Principle X).
    - MODIFY `packages/agent/src/usage/plugin-usage.service.ts` — accept and forward the four
      optional fields.
    - MODIFY `packages/agent/src/database/repositories/plugin-usage.repository.ts` — persist them.
    - **Done when**: `packages/agent/src/usage/plugin-usage.service.spec.ts` covers a call with and
      without cache figures and asserts `null` (not `0`) in the absent case.

- [ ] **T25.** Entity columns + Migration A (same PR).
    - MODIFY `packages/agent/src/entities/agent-run.entity.ts` — add `inputTokens`, `outputTokens`,
      `cacheReadTokens`, `cacheWriteTokens`, `modelIds`, `primaryModelId`, `skillsUsed`,
      `toolCallCount`, `creditsDebited` exactly as typed in
      [plan.md §3.1](./plan.md#31-entity-changes).
    - MODIFY `packages/agent/src/entities/plugin-usage-event.entity.ts` — add `inputTokens`,
      `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`.
    - CREATE `apps/api/src/migrations/1791090000000-AddRunReceiptTelemetry.ts` — additive
      `ALTER TABLE` for both tables plus
      `CREATE INDEX idx_agent_runs_user_started ON agent_runs (userId, startedAt)`. Generate with
      `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddRunReceiptTelemetry`,
      then rename to the timestamp above.
    - **Done when**: the generated SQL contains no `DROP COLUMN`, no `NOT NULL` without a default
      and no type narrowing; `down()` drops only what `up()` added; a fresh boot with
      `RUN_MIGRATIONS=true` applies it cleanly and a second boot is a no-op.

- [ ] **T26.** Per-run rollups in the execution loop.
    - MODIFY `packages/agent/src/agents/agent-run.service.ts`:
        - extend the existing per-round `addRunTokens` fold to also accumulate `inputTokens`,
          `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, append `round.model` to
          `modelIds`, and increment `toolCallCount`;
        - after `selectSkillsWithinBudget(...)`, write `skillsUsed` as `RunSkillUse[]` — `loaded`
          for the selected set, `dropped` with `reason: 'skill-budget'`, `suppressed` with
          `reason: 'tool-grant'`. Keep the existing `WARN` log rows.
    - CREATE `packages/agent/src/agents/__tests__/run-skill-capture.spec.ts` and extend
      `packages/agent/src/database/repositories/agent-run.telemetry.spec.ts`.
    - **Done when**: a run that drops a Skill records it with the right reason, and token counters
      are written incrementally (visible while the run is still `running`).

- [ ] **T27.** Settlement stamps.
    - MODIFY `packages/agent/src/subscriptions/credits/run-cost-settlement.service.ts` — stamp
      `primaryModelId` (highest token count among the run's usage rows) and `creditsDebited` (the
      amount of the `CONSUMPTION` row it writes) in the same terminal-transition write.
    - MODIFY `packages/agent/src/subscriptions/credits/run-cost-settlement.service.spec.ts` — a
      retried settlement under the same `run:{runId}` idempotency key does not double-count.
    - **Done when**: the spec passes and no new write path to `credit_ledger_entries` was added.

- [ ] **T28.** Receipt cost and skills.
    - MODIFY `packages/agent/src/agents/run-receipt.service.ts` — populate `RunCostBreakdown`:
      totals, `tokens`, `byModel`, `byCapability`, `creditsDebited`, `byoKeyOnly`, and
      `detailRetained` (false once the run's `occurredAt` is older than 12 months, matching the
      `plugin_usage_events` prune window); populate `skills` from `agent_runs.skillsUsed`.
    - MODIFY `packages/agent/src/agents/run-receipt.service.spec.ts` — "not attributable" vs `0`;
      BYO-key-only detection; the retention flip; a pre-migration run rendering all-`null` tokens.
    - **Done when**: no branch can produce a fabricated number; absent data is `null`, never `0`.

- [ ] **T29.** Rail token and spend figures.
    - MODIFY `packages/agent/src/agents/run-window-stats.ts` — sum the four split counters into
      `RunTokenSplit`, treating `null` as "not measured" rather than zero when **every** row in the
      window is `null` (in which case the total is `null`).
    - MODIFY `packages/agent/src/agents/__tests__/run-window-stats.spec.ts`.
    - **Done when**: a window entirely composed of pre-migration runs shows "—", not `0`.

- [ ] **T30.** CSV export.
    - MODIFY `apps/api/src/runs/runs.controller.ts` — add `GET export` **before** the `:runId`
      route; `@Throttle({ long: { limit: 10, ttl: 60_000 } })`.
    - MODIFY `apps/api/src/runs/dto/run-ledger.dto.ts` — `RunsExportQueryDto` extending the stats
      DTO with `format`.
    - MODIFY `packages/agent/src/agents/run-ledger.service.ts` — `countLedger` guard first, then a
      batched (1,000-row) async iterator; refuse over **50,000** rows or **92** days with the
      stable code `runs.exportTooLarge` before any streaming begins.
    - CREATE `apps/web/src/app/api/runs/export/route.ts` — pipes `response.body` through; never
      buffers. Mirror `apps/web/src/app/api/credits/usage/export/route.ts`.
    - CREATE `apps/api/src/runs/runs.controller.export.spec.ts` — refusal at 50,001 rows and at 93
      days before any query; headers; streamed body.
    - **Done when**: a refused export produces no database read beyond the count.

- [ ] **T31.** Cost and skills UI.
    - CREATE `apps/web/src/components/runs/RunReceiptCost.tsx` and
      `apps/web/src/components/runs/RunReceiptSkills.tsx`.
    - CREATE `RunReceiptCost.unit.spec.tsx` — "Not reported by this provider" for `null` cache,
      the `{percent} % of input` line, the retention notice, "so far" labelling, the
      "Your own provider key" case.
    - MODIFY `apps/web/src/components/runs/RunReceiptPanel.tsx` — mount both blocks.
    - MODIFY `apps/web/src/components/runs/RunsRail.tsx` — show spend and tokens.
    - MODIFY `apps/web/src/components/runs/RunsFilters.tsx` — add the model filter, populated from
      the window's observed models.
    - MODIFY `apps/web/messages/en.json` + the 20 sibling locales — add the `receipt.*` cost and
      skills keys and the `export.*` group.
    - **Done when**: no cost surface can render a `0` where the underlying value is `null`.

- [ ] **T32.** P2 end-to-end.
    - MODIFY `apps/web/e2e/runs-receipt.spec.ts` — assert the token split, the per-model
      breakdown, a loaded/dropped Skill pair, and the not-reported cache copy.
    - CREATE `apps/web/e2e/runs-export.spec.ts` — a successful export downloads a CSV whose header
      row matches the plan's column list; an over-limit export shows the refusal dialog and starts
      no download.
    - MODIFY `apps/web/e2e/COVERAGE.md`.
    - **Done when**: both pass in CI.

- [ ] **T33.** P2 gate.
    - Root `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` green.
    - MODIFY `docs/specs/features/agent-workspace/TRACKER.md` — note "P2 merged".
    - **Done when**: the cost, token-split and Skills acceptance criteria in
      [spec.md §8](./spec.md#8-acceptance-criteria) all pass.

---

# Phase 3 — Upcoming and remediation

*Migration B. Adds failure classification, the per-Agent time limit, the Upcoming panel and the
repeat-failure banner.*

- [ ] **T34.** Entity columns + Migration B (same PR).
    - MODIFY `packages/agent/src/entities/agent-run.entity.ts` — add `failureCode` and
      `effectiveTimeoutSeconds`.
    - MODIFY `packages/agent/src/entities/agent.entity.ts` — add `maxRunDurationSeconds`
      (nullable; `null` = inherit the deployment default).
    - CREATE `apps/api/src/migrations/1791090100000-AddAgentRunFailureAndTimeout.ts`.
    - **Done when**: additive-only SQL, `down()` drops only the three new columns, and boot applies
      it cleanly twice.

- [ ] **T35.** Failure classifier.
    - CREATE `packages/agent/src/agents/run-failure-classifier.ts` — pure
      `classifyFailure({ errorMessage, errorName, elapsedMs, effectiveTimeoutSeconds, cancelledBy,
      guardrailRefused, budgetStopped, creditsExhausted })` → `RunFailureCode`.
    - CREATE `packages/agent/src/agents/__tests__/run-failure-classifier.spec.ts` — every branch;
      `timeout` **only** when elapsed ≥ the effective limit; `unknown` as the honest fallback.
    - **Done when**: the classifier has no repository or Nest dependency.

- [ ] **T36.** Resolve and stamp the effective time limit.
    - MODIFY `packages/agent/src/config/index.ts` — add
      `agents.resolveRunDurationSeconds(agentOverride?: number | null)` returning
      `agentOverride ?? getMaxRunDurationSeconds()`, clamped to 60 … 14400.
    - MODIFY `packages/tasks/src/tasks/trigger/agent-heartbeat.task.ts` and
      `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` — resolve `maxDuration` from
      the Agent's override, and stamp `agent_runs.effectiveTimeoutSeconds` at dispatch. Classify in
      `onFailure` and write `failureCode`.
    - **Done when**: neither task imports a vendor SDK at a new call site and both keep their
      existing `schedules.task()` / `task()` registration untouched (Constitution IV).

- [ ] **T37.** Classify swept runs.
    - MODIFY `packages/agent/src/agents/agent-run-sweeper.service.ts` — when reaping a stale run,
      stamp `failureCode` as `'timeout'` when elapsed exceeded `effectiveTimeoutSeconds`, else
      `'swept-stale'`, in the same CAS update it already performs.
    - MODIFY `packages/agent/src/agents/__tests__/agent-run-sweeper.service.spec.ts`.
    - **Done when**: the sweeper writes one extra column and issues no extra query.

- [ ] **T38.** The write path for raising a limit.
    - MODIFY `apps/api/src/agents/dto/agent.dto.ts` — `UpdateAgentDto.maxRunDurationSeconds?`
      with `@IsOptional() @Type(() => Number) @IsInt() @Min(60) @Max(14400)`; `null` clears the
      override.
    - MODIFY `packages/agent/src/agents/agents.service.ts` — persist it and include the **field
      name** in the existing `agent_updated` activity-log details.
    - CREATE `apps/api/src/agents/agents.controller.timeout.spec.ts` — accepts 60 and 14400,
      rejects 59 and 14401, accepts `null`, 404s cross-user.
    - **Done when**: no new endpoint, guard or ownership check was introduced.

- [ ] **T39.** Upcoming fires endpoint.
    - MODIFY `apps/api/src/runs/runs.module.ts` — import the existing `SchedulesModule`.
    - MODIFY `apps/api/src/runs/runs.controller.ts` — `GET upcoming` declared before `:runId`;
      `UpcomingFiresQueryDto` (`horizonDays` 1…7 default 7, `limit` 1…50 default 20).
      Calls `SchedulesService.getSchedules(userId, scope, { enabledOnly: true })`, drops null or
      out-of-horizon `nextRunAt`, sorts ascending, slices, maps to `UpcomingFire`, and returns
      `generatedAt` so the client computes countdowns against server time.
    - CREATE `apps/api/src/runs/runs.controller.upcoming.spec.ts` — clamps; paused/disabled/ended
      excluded; ascending order; `generatedAt` present.
    - **Done when**: no schedule query is reimplemented — the existing service is the only producer.

- [ ] **T40.** Failure, remediation and upcoming UI.
    - CREATE `apps/web/src/components/runs/RunReceiptFailure.tsx`,
      `apps/web/src/components/runs/RaiseTimeLimitDialog.tsx`,
      `apps/web/src/components/runs/UpcomingFiresPanel.tsx`,
      `apps/web/src/components/runs/RepeatFailureBanner.tsx`.
    - `RaiseTimeLimitDialog` re-reads the Agent's current limit before proposing, uses
      `nextTimeLimitStep()` over the ladder 1800 → 3600 → 7200 → 14400, handles the already-raised
      and at-ceiling cases, and disables with the permission tooltip when the viewer cannot edit
      the Agent.
    - `UpcomingFiresPanel` ticks one shared 1 s interval, pauses on `document.hidden`, refetches
      every 60 s and on focus.
    - `RepeatFailureBanner` dismissal is held in `sessionStorage`.
    - MODIFY `apps/web/src/app/actions/runs.ts` — add `getUpcomingFires` and
      `raiseAgentTimeLimit`.
    - MODIFY `apps/web/src/app/api/runs/[section]/route.ts` — add `upcoming` to the allowlist.
    - CREATE `RunReceiptFailure.unit.spec.tsx`, `RaiseTimeLimitDialog.unit.spec.tsx`,
      `UpcomingFiresPanel.unit.spec.tsx`.
    - MODIFY `apps/web/messages/en.json` + the 20 sibling locales — add the `failure.*`,
      `timeLimit.*`, `upcoming.*` and `repeatFailure.*` groups.
    - **Done when**: the shortcut appears **only** for `failureCode === 'timeout'`, and every state
      in [spec.md §6.9–6.13](./spec.md#69-receipt--a-failed-run-whose-cause-was-the-time-limit)
      renders with the exact copy.

- [ ] **T41.** P3 end-to-end.
    - CREATE `apps/web/e2e/runs-failure-remediation.spec.ts` and
      `apps/web/e2e/runs-upcoming.spec.ts` per
      [plan.md §10.4](./plan.md#104-end-to-end-playwright-appswebe2e).
    - MODIFY `apps/web/e2e/COVERAGE.md`.
    - **Done when**: both pass in CI, including the "no change made" and at-ceiling branches.

- [ ] **T42.** Analytics.
    - MODIFY `apps/web/src/components/runs/RunsClient.tsx` and the receipt components — emit
      `runs_window_changed`, `runs_filter_applied`, `runs_receipt_opened`,
      `runs_time_limit_raised`, `runs_repeat_failure_banner_shown` / `_followed`,
      `runs_export_requested` / `_refused` through the existing PostHog binding
      (`packages/monitoring/src/posthog/`).
    - **Done when**: no event payload carries a summary, an error message, a tool payload or any
      other free-text user content — ids and enums only.

- [ ] **T43.** Documentation.
    - CREATE `docs/features/runs.md` — the user-facing page: what a Run is, how to read a receipt,
      what the token split means, the weekly review habit, and the time-limit ladder.
    - MODIFY `apps/docs/sidebarsPlatform.ts` — add the page (the sidebar is manual; an unlisted
      file renders only as an orphan).
    - **Done when**: `pnpm --filter ever-works-docs build` produces no broken-link warnings.

- [ ] **T44.** P3 gate and epic close-out.
    - Root `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` green.
    - MODIFY `docs/specs/features/agent-workspace/TRACKER.md` — AW-09 impl → `Merged`, then
      `Verified` once the e2e shard is green on `develop`.
    - MODIFY `docs/specs/features/agent-workspace/AW-09-runs-receipts/spec.md` — status →
      `Implemented`; `plan.md` and `tasks.md` → `Done`.
    - **Done when**: every checkbox in [spec.md §8](./spec.md#8-acceptance-criteria) is ticked and
      every open question in §9 is either answered in the spec or moved to a follow-up issue.

---

## Definition of done for the epic

- All 44 tasks ticked.
- Both migrations applied cleanly on a fresh database and idempotent on re-boot.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` green at the
  repo root.
- All seven-plus Playwright specs green and recorded in `apps/web/e2e/COVERAGE.md`.
- All 21 locale files carry every new key; no leaf key name contains a literal `.`.
- Every constitution gate in [plan.md §12](./plan.md#12-constitution-compliance-checklist)
  re-confirmed against the merged code.
- Nothing that existed before this epic was removed, renamed or redirected.
