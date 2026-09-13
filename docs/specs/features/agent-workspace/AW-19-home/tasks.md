# Task Breakdown: AW-19 — Home, the morning screen

> Ordered, granular tasks derived from [`plan.md`](./plan.md). Each task is small
> enough to land in a single PR and ships with tests per
> [Constitution Principle VI](../../../../../.specify/memory/constitution.md#vi-tests-are-a-prerequisite-not-a-follow-up).

**Feature ID**: `aw-19-home`
**Spec**: [`./spec.md`](./spec.md)
**Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are sequential by default. `(parallel)` marks a task that can run
  alongside its predecessor.
- Every task names the exact files to create or modify and what "done" means.
- Tick the checkbox as each PR lands. Add new tasks at the bottom rather than
  renumbering.
- Phase boundaries are release boundaries: `develop` must be green and shippable
  at the end of each phase.
- **Repo conventions to keep in mind while executing:** tabs at width 4, print
  width 120, single quotes, semicolons, no trailing commas; files kebab-case;
  conventional commits; `pnpm` only; never run `npx shadcn add` (this repo's
  primitive layer is Headless UI plus hand-rolled components, and the shadcn
  config is vestigial).

---

## Phase 1 — The morning read

### 1a. Contracts

- [ ] **T1.** Create the Home wire contract.
    - Create `packages/contracts/src/home/home.types.ts` with `HOME_BLOCK_IDS`,
      `HomeBlockId`, `HomeBlock<T>`, `HomeDecisionKind`, `HomeDecisionRow`,
      `HomeSignalRow`, `HomeDecisions`, `HomeGlance`, `HomeScheduleKind`,
      `HomeScheduleRow`, `HomeToday`, `HomeSpend`, `HomeRunningRow`,
      `HomeWorkingNow`, `HomeActivityRow`, `HomeSummaryDto`,
      `HomePreferencesDto` — exactly the shapes in `plan.md` §3.4.
    - Also export the caps as named constants so both sides share one number:
      `HOME_DECISIONS_PREVIEW = 5`, `HOME_ALSO_BROKEN_MAX = 6`,
      `HOME_TODAY_RAN_MAX = 3`, `HOME_TODAY_DUE_MAX = 6`,
      `HOME_WORKING_NOW_MAX = 5`, `HOME_ACTIVITY_MAX = 8`,
      `HOME_TITLE_MAX_CHARS = 120`, `HOME_ACTIVITY_MAX_CHARS = 120`,
      `HOME_RUN_ACTIVITY_MAX_CHARS = 100`, `HOME_SCHEDULE_NAME_MAX_CHARS = 60`,
      `HOME_COMPOSER_MAX_CHARS = 2000`, `HOME_COMPOSER_MIN_CHARS = 3`,
      `HOME_TASK_TITLE_MAX_CHARS = 80`, `HOME_OVERDUE_HOURS = 72`,
      `HOME_WAITING_WARN_HOURS = 24`, `HOME_LONG_RUN_MINUTES = 30`,
      `HOME_STILL_GOING_MINUTES = 120`, `HOME_REFRESH_MS = 60_000`,
      `HOME_BLOCK_BUDGET_MS = 1500`, `HOME_CACHE_TTL_MS = 10_000`,
      `HOME_SPEND_WINDOW_DAYS = 7`, `HOME_COUNTER_MAX = 999`.
    - Create `packages/contracts/src/home/index.ts` → `export * from './home.types.js';`
    - Add `export * from './home/index.js';` to `packages/contracts/src/index.ts`.
    - **Do not** touch `packages/contracts/tsup.config.ts` or the package's
      `exports` map — the root entry already covers this, the same way `./inbox`
      is handled.
    - **Done when**: `cd packages/contracts && pnpm build` emits types for the
      new symbols and `pnpm type-check` is green from the repo root.

### 1b. Agent package — the composition service

- [ ] **T2.** Create the day/window helper.
    - Create `packages/agent/src/home/home-window.ts` exporting
      `resolveTimezone(candidate, fallbackFromPreferences)` and
      `buildHomeWindow(timezone, now)` → `{ timezone, fallback, dayStart, dayEnd, weekStart }`.
    - `resolveTimezone` accepts a value listed by `Intl.supportedValuesOf('timeZone')`
      plus explicit `UTC` / `GMT`; anything else throws a typed
      `InvalidHomeTimezoneError` (the controller maps it to a 400).
    - **Test**: `packages/agent/src/home/__tests__/home-window.spec.ts` — DST
      spring-forward and fall-back days, a UTC+14 zone, a UTC-11 zone, `UTC`
      itself, and the rolling 7-day window; assert an unknown zone throws.

- [ ] **T3.** Build the decision-set builder.
    - Create `packages/agent/src/home/builders/decisions.builder.ts`.
    - Reads open Inbox items via `InboxService` / `InboxItemRepository`
      (`packages/agent/src/inbox/inbox.service.ts`,
      `packages/agent/src/database/repositories/inbox-item.repository.ts`),
      keeping `kind ∈ { question, approval, escalation }`.
    - Reads open agent action proposals via `AgentApprovalsService`
      (`packages/agent/src/agent-approvals/agent-approvals.service.ts`) and open
      escalations via `AgentEscalationRepository`
      (`packages/agent/src/database/repositories/agent-escalation.repository.ts`).
    - De-duplicates per `plan.md` §2.2 (drop any proposal whose id appears as an
      Inbox row's `proposalId`; same for `escalationId`).
    - Sorts oldest-first with the ≥72 h group floated; previews
      `HOME_DECISIONS_PREVIEW`; reports the exact total and `overdueCount`.
    - Truncates titles to `HOME_TITLE_MAX_CHARS` server-side.
    - Emits `options` only for rows that are Inbox-backed **and** carry 1–3
      options; every other row carries `href` and no `options`.
    - **Test**: `packages/agent/src/home/__tests__/decision-set.spec.ts` covering
      every bullet above plus the notice-exclusion and 0/1/3/4-option cases.

- [ ] **T4** (parallel with T3). Build the run-derived builders.
    - Create `packages/agent/src/home/builders/runs.builder.ts` producing both
      the `workingNow` block and the three run-derived glance counters.
    - Add the queries it needs to
      `packages/agent/src/database/repositories/agent-run.repository.ts`:
      `countByUserAndStatusInWindow(userId, status, from, to, scope)` and
      `listRunningForUser(userId, { limit, scope })` selecting `id`, `agentId`,
      `status`, `startedAt`, `awaitingInput`, `currentActivity` and joining the
      Agent name in one query (no per-row follow-up).
    - Rule: `running AND awaitingInput` is excluded from `workingNow` and from
      the `workingNow` counter.
    - Truncate `currentActivity` to `HOME_RUN_ACTIVITY_MAX_CHARS`; clamp counters
      at `HOME_COUNTER_MAX`.
    - **Test**: `packages/agent/src/home/__tests__/run-counters.spec.ts` — the
      `awaitingInput` split, the local-day boundaries at 23:59:59 and 00:00:00,
      `999+` clamping, longest-first ordering, the 30/120-minute chip thresholds.

- [ ] **T5** (parallel with T3). Build the Today builder.
    - Create `packages/agent/src/home/builders/today.builder.ts` calling
      `SchedulesService` (`packages/agent/src/schedules/schedules.service.ts`)
      with no source filter, then splitting into `ran` (a `lastRunAt` inside the
      local day) and `due` (a `nextRunAt` inside the local day and in the future).
    - Map every one of the seven `ScheduleSourceType` values from
      `packages/agent/src/schedules/schedule-view.types.ts` to a `HomeScheduleKind`
      — **no source may be dropped**; a `switch` with no `default` fallthrough so
      a future source type is a compile error, not a silent omission.
    - Include `active`, `paused` and `error` rows; exclude `disabled` and `ended`.
    - Exclude rows with a null `nextRunAt` from `due` and from `dueTotal`.
    - Truncate `ownerName` to `HOME_SCHEDULE_NAME_MAX_CHARS`; carry `ownerLink`
      through as `href`.
    - **Test**: `packages/agent/src/home/__tests__/today-panel.spec.ts` — all
      seven kinds, the ran/due split, null `nextRunAt`, status filtering, caps 3
      and 6, `dueTotal` correctness.

- [ ] **T6** (parallel with T3). Build the spend builder.
    - **Scope the spend read first** ([plan §3.5](./plan.md)). Today
      `CostsSummaryService.getSummary(userId, windowDays)` and
      `BudgetService.summarizeForUser(userId, prefs)` both aggregate by `userId`
      only. Add an optional trailing `scope?: OwnershipScope` to
      `PluginUsageRepository.getTotalSpendCentsForUser` (applied with
      `ownershipSqlPredicate('e', scope)` from
      `packages/agent/src/database/ownership-scope.ts`) and to
      `CostsSummaryService.getSummary`, threading it to the spend sum and the run
      count. Omitted ⇒ the SQL is unchanged, so the costs controller and budget
      enforcement keep today's totals.
    - Create `packages/agent/src/home/builders/spend.builder.ts` calling
      `CostsSummaryService.getSummary(userId, HOME_SPEND_WINDOW_DAYS, scope)`
      with the request's `OwnershipScope` for `totalCents`, `runsCount`,
      `avgPerRunCents` and `scope { kind, name }`, and the **unscoped** account-wide
      budget summary that backs `GET /me/usage/account-wide` for `accountCap`.
    - Compute `accountCap.percentUsed` from account period spend vs the account
      cap; set `blocked` and `allowOverage` from the budget summary; never derive
      a cap percentage from the scoped total. Set `everSpent` false only when the
      account has never recorded spend in any scope (so a brand-new account hides
      the panel, but an empty Organization shows `$0.00`).
    - **Test**: `packages/agent/src/home/__tests__/spend-panel.spec.ts` — the
      pinned 7-day window, a null average at zero runs, the 80% / 100%
      thresholds, blocked vs overage, `everSpent: false`, the scope passed to
      `getSummary` and not to `summarizeForUser`, and an empty Organization in a
      spending account.
    - **Test**: `packages/agent/src/database/repositories/plugin-usage.repository.scope.spec.ts`
      and `packages/agent/src/subscriptions/credits/costs-summary.service.scope.spec.ts`
      — usage in two Organizations and personal scope sums per scope; no scope
      returns the unchanged user-wide total.

- [ ] **T7** (parallel with T3). Build the recent-activity builder.
    - Create `packages/agent/src/home/builders/activity.builder.ts` reading the
      newest `HOME_ACTIVITY_MAX` rows for the caller and active scope through
      `packages/agent/src/database/repositories/activity-log.repository.ts`.
    - Resolve a link per row only from data already on the row (its `workId` or
      the ids in `metadata`); never issue a follow-up query per row. A row with no
      resolvable link carries `href: null`.
    - Truncate `summary` to `HOME_ACTIVITY_MAX_CHARS`.
    - **Test**: assertions inside `home-summary.service.spec.ts` (T8) — row count,
      ordering, truncation, `href: null` for an unlinkable row.

- [ ] **T8.** Compose the service.
    - Create `packages/agent/src/home/home-summary.service.ts` with
      `build(userId, { timezone, blocks, scope, now })`.
    - Run the six builders concurrently through `Promise.allSettled`, each raced
      against a `HOME_BLOCK_BUDGET_MS` timeout; map a rejection or a timeout to
      `{ status: 'failed', errorKey, data: null }`; never to an empty array.
    - Honour the `blocks` narrowing: unnamed blocks are omitted from the response
      rather than returned empty.
    - Wrap `build` in a `HOME_CACHE_TTL_MS` cache keyed on
      `(userId, organizationId, timezone)` using
      `packages/agent/src/cache/`; stamp `computedAt`.
    - Create `packages/agent/src/home/home.module.ts` importing the modules it
      depends on (`InboxModule`, `AgentApprovalsModule`, `SchedulesModule`,
      `SubscriptionsModule`, `DatabaseModule`) and exporting `HomeSummaryService`.
    - Create `packages/agent/src/home/index.ts` re-exporting the service, the
      module, the window helper and the builders' public types.
    - Add `"./home"` to the `exports` map in `packages/agent/package.json`
      (mirroring the `"./schedules"` entry).
    - **Test**: `packages/agent/src/home/__tests__/home-summary.service.spec.ts` —
      one builder rejecting leaves the other five `ok`; the per-block timeout
      fires; `blocks` narrowing; `computedAt`; the cache hits within TTL and
      misses across a different scope or timezone.

### 1c. API surface

- [ ] **T9.** Add the query DTO.
    - Create `apps/api/src/home/dto/home-summary-query.dto.ts` with `tz`
      (optional, `@IsString`, `@MaxLength(64)`, validated against
      `Intl.supportedValuesOf('timeZone')` plus `UTC`/`GMT` via a custom
      constraint) and `blocks` (optional CSV → array, `@IsIn(HOME_BLOCK_IDS, { each: true })`,
      `@ArrayMaxSize`).
    - Put `@ApiProperty` / `@ApiPropertyOptional` on **every** field — the API
      build runs no Swagger CLI plugin and the MCP server derives its tool schemas
      from the OpenAPI document.
    - Model the file on `apps/api/src/schedules/dto/schedules-query.dto.ts`.
    - **Test**: `apps/api/src/home/dto/home-summary-query.dto.spec.ts` — a valid
      IANA zone, `UTC`, `GMT`, garbage → 400, >64 chars → 400, CSV parsing, an
      unknown block id → 400.

- [ ] **T10.** Add the controller and module.
    - Create `apps/api/src/home/home.controller.ts` — `@Controller('api/home')`,
      `@ApiTags('Home')`, `@ApiBearerAuth('JWT-auth')`, one `@Get('summary')`
      taking `@CurrentUser()` and the DTO, reading the active scope from
      `ScopeContextService` (`apps/api/src/scope/scope-context.service.ts`), and
      setting `Cache-Control: private, no-store` on the response.
    - Map `InvalidHomeTimezoneError` to a `BadRequestException`.
    - **No user id or organization id parameter may exist on this endpoint.**
    - Create `apps/api/src/home/home.module.ts` importing the agent-side
      `HomeModule` and declaring the controller — the shape of
      `apps/api/src/schedules/schedules.module.ts`.
    - Register `HomeModule` in `apps/api/src/api.module.ts` (import at the top,
      entry in the `imports` array beside `SchedulesModule`).
    - **Test**: `apps/api/src/home/home.controller.spec.ts` — 200 with every block
      key; the cache header; block-level failure is still a 200; `blocks=today`
      narrows; a foreign scope sees nothing; no scope parameter is accepted.

- [ ] **T11.** Ship the index migration.
    - Create `apps/api/src/migrations/1791190000000-AddAgentRunHomeIndexes.ts`
      adding `idx_agent_runs_user_status (userId, status)` and
      `idx_agent_runs_user_finished (userId, finishedAt)` to `agent_runs`.
    - Use `queryRunner.getTable('agent_runs')` + an `indices.some(...)` existence
      guard and portable `TableIndex` DDL (CI and e2e run better-sqlite3;
      production runs Postgres). Follow
      `apps/api/src/migrations/1789100000000-AddTaskGraphFanout.ts`.
    - `down()` drops exactly those two indexes and nothing else.
    - **Done when**: `cd apps/api && pnpm typeorm migration:run -d typeorm.config.ts`
      applies cleanly on a fresh database and on one that already has the
      indexes; `migration:revert` removes only them.
    - **This task ships in the same PR as T4** (Constitution V: a schema change
      travels with the code that needs it).

### 1d. Web — data access

- [ ] **T12.** Add the typed server client.
    - Create `apps/web/src/lib/api/home.ts` with `'server-only'` at the top and
      `homeAPI.summary({ tz, blocks })` calling
      `serverFetch('/home/summary?…')` from `apps/web/src/lib/api/server-api.ts`.
    - The path must **not** start with `/api` — `API_URL` already ends in `/api`.
      Add a regression assertion for that, matching the double-prefix specs beside
      the other clients.
    - **Test**: `apps/web/src/lib/api/home.unit.spec.ts` — the built query string,
      the no-double-prefix assertion, and that a non-200 rejects rather than
      returning a partial object.

- [ ] **T13.** Add the server actions.
    - Create `apps/web/src/app/actions/dashboard/home.ts` with `'use server'`,
      exporting `getHomeSummaryAction(tz?)` and `refreshHomeBlockAction(blockId, tz?)`.
    - Start each with the `getAuthFromCookie()` → `redirect(ROUTES.AUTH_LOGIN)`
      guard used by `apps/web/src/app/actions/dashboard/missions.ts`.
    - Add `export * from './home';` to
      `apps/web/src/app/actions/dashboard/index.ts`.
    - **Done when**: an unauthenticated call redirects before any request is
      issued.

### 1e. Web — shared helpers and the block shell

- [ ] **T14.** Add the shared client-safe helpers.
    - Create `apps/web/src/components/home/home.shared.ts` (no directive, so both
      RSC and client components can import it) with `formatWaiting`,
      `formatElapsed`, `formatCount`, `greetingKeyForHour`, `deriveTaskTitle`,
      and a re-export of the `HOME_*` constants from `@ever-works/contracts`.
    - `deriveTaskTitle` takes the first sentence, truncates at the last word
      boundary at or before `HOME_TASK_TITLE_MAX_CHARS`, appends a single `…`
      when it truncated, and falls back to the whole text when the first sentence
      is shorter than `HOME_COMPOSER_MIN_CHARS`.
    - **Test**: `apps/web/src/components/home/home.shared.unit.spec.ts` — every
      boundary listed in `plan.md` §10.3.

- [ ] **T15.** Add the block shell.
    - Create `apps/web/src/components/home/HomeBlockShell.tsx` rendering a named
      landmark region with a heading, an optional header link, and exactly one of:
      skeleton, populated children, empty state, error card with `Retry`.
    - The skeleton must match the populated height within 8 px (spec NFR-6).
    - Empty and error must be structurally different renders, not the same card
      with different text (spec FR-62).
    - **Test**: `apps/web/src/components/home/HomeBlockShell.unit.spec.tsx`.

### 1f. Web — the blocks

- [ ] **T16.** Greeting and score line.
    - Create `apps/web/src/components/home/HomeGreeting.tsx`: locale-formatted
      date, hour-based greeting, the four-part score line as a single polite live
      region, and a placeholder slot for the freshness control (wired in P3).
    - Suppress the score line entirely when all four counters are zero; omit
      individual zero counters otherwise.

- [ ] **T17.** The composer.
    - Create `apps/web/src/components/home/HomeComposer.tsx`.
    - Auto-growing field 1→6 rows; `Enter` / `Ctrl+Enter` submit, `Shift+Enter`
      newline, `Escape` blurs; `Send` disabled under
      `HOME_COMPOSER_MIN_CHARS`; counter from 1800; hard stop at
      `HOME_COMPOSER_MAX_CHARS`.
    - Submit calls `createTaskAction` from
      `apps/web/src/app/actions/tasks.ts` with
      `{ title: deriveTaskTitle(text), description: text }` — no owner ids and no
      `status`, so the Task is unscoped and takes the entity default `backlog`.
    - Success: clear, push a chip (max 3, 60 s each) linking to the Task.
    - Failure: keep the text, restore focus, show the inline error; a `429`
      renders the throttle-specific copy.
    - Draft persistence in `localStorage` under `ew:v1:home:composer-draft`, every
      access in `try/catch` (the posture `apps/web/src/lib/hooks/use-theme.ts`
      documents for locked-down browsers).
    - Accept a `jobRuntimeConfigured` prop (threaded from the dashboard layout's
      existing health read) and append the no-runtime note to the success chip
      when it is false.
    - **Test**: `apps/web/src/components/home/HomeComposer.unit.spec.tsx` covering
      every bullet above.

- [ ] **T18.** The Needs-you block.
    - Create `apps/web/src/components/home/NeedsYouBlock.tsx`: kind chips, agent
      name, title, waiting chip with its three tones, the overdue header suffix,
      `Open all (n) →`, the `n more waiting` footer, and inline option buttons for
      1–3 options (rendering as `Open` otherwise — answering itself lands in P2).
    - Render the existing `apps/web/src/components/dashboard/AttentionSection.tsx`
      as the `Also broken` sub-list, capped at `HOME_ALSO_BROKEN_MAX`, with a new
      optional heading prop.
    - Every title renders as plain text.

- [ ] **T19** (parallel with T18). The glance counters.
    - Create `apps/web/src/components/home/GlanceCounters.tsx`: four linked
      counters, danger tone on `failedToday > 0`, `999+` clamping, a 2×2 grid
      below 768 px and a single column below 420 px.

- [ ] **T20** (parallel with T18). Extend the schedule block into **Today**.
    - Modify `apps/web/src/components/dashboard/SoonSection.tsx`: accept
      `ran` / `due` / `dueTotal`, render the `ran at {time}` markers dimmed above
      a rule, then the due rows, then `+{n} more →`; add labels for all seven
      kinds and the `paused` / `error` chips; add both empty states.
    - Modify `apps/web/src/components/dashboard/dashboard-signals.types.ts`:
      widen `SoonRunItem['sourceKind']` to all seven kinds and add `state` and
      `status`. Leave `AttentionItem` untouched.
    - Do **not** delete `getSoonRuns()` in
      `apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-data.ts`; leave it
      exported (its unit spec must keep passing) and add a doc comment pointing at
      the server-side replacement.
    - **Test**: `apps/web/src/components/dashboard/SoonSection.unit.spec.tsx`.

- [ ] **T21** (parallel with T18). The spend panel.
    - Create `apps/web/src/components/home/ThisWeekPanel.tsx`: headline total with
      the `last 7 days in {scope}` sublabel, the runs/average line (`—` at zero
      runs), then — visually separated — the account-wide cap bar labelled
      `{percent}% of your account-wide cap this billing period` with its
      neutral/amber/danger thresholds and the `capScopeNote` line, the
      blocked-or-overage line, the no-cap variant, and `Manage spend →` pointing at
      `ROUTES.DASHBOARD_USAGE_COSTS` with the `Opens account-wide spend`
      accessible description (spec FR-39a, FR-42).
    - **Test**: `apps/web/src/components/home/ThisWeekPanel.unit.spec.tsx` — the
      scope name renders in the sublabel (`Personal` without an Organization), and
      the cap bar and blocked/overage line always contain `account-wide`.
    - Render nothing at all when `everSpent` is false.

- [ ] **T22** (parallel with T18). The working-now panel.
    - Create `apps/web/src/components/home/WorkingNowPanel.tsx`: rows with agent
      name, activity line (`Working…` fallback), elapsed time, the `long run` and
      `still going` chips, `See all runs →` with the exact total, and an empty
      state whose action focuses the composer.

- [ ] **T23** (parallel with T18). The recent-activity block.
    - Create `apps/web/src/components/home/RecentActivityBlock.tsx`: 8 rows,
      `HH:mm` for today and `d MMM` for older, links where resolvable,
      `Open the feed →` pointing at `ROUTES.DASHBOARD_ACTIVITY`.

- [ ] **T24.** The workspace section.
    - Create `apps/web/src/components/home/WorkspaceSection.tsx`: a collapsible
      region titled `Your workspace`, default expanded for accounts younger than
      7 days and collapsed otherwise (persistence lands in P2), wrapping the
      existing blocks verbatim.

### 1g. Web — wiring

- [ ] **T25.** Rewire the Home route.
    - Modify `apps/web/src/app/[locale]/(dashboard)/(home)/page.tsx`: add
      `getHomeSummaryAction()` to the existing `Promise.all`, `.catch()`-defended
      like every sibling; pass the summary and the job-runtime flag to
      `DashboardClient`. **Leave the other 18 fetches in place** — they feed
      `Your workspace`.
    - Modify `apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx`:
      render the morning stack in the order of spec FR-1, then
      `<WorkspaceSection>` wrapping today's `StatsOverview` → `ApprovalsQueue` →
      `MissionsPreviewSection` → `WorkProposalsSection` → recent Works →
      `RecentTasks` → `AgentsPreviewSection` stack unchanged.
    - `AttentionSection` moves inside `NeedsYouBlock`; `SoonSection` moves into the
      morning stack as the Today panel. Nothing else moves and nothing is deleted.
    - **Done when**: every existing e2e in `apps/web/e2e/dashboard.spec.ts`,
      `dashboard-authenticated.spec.ts` and `dashboard-comprehensive.spec.ts`
      still passes with no edits.

### 1h. Phase 1 i18n and tests

- [ ] **T26.** Add the i18n keys.
    - Add the full `dashboard.home` namespace and the `dashboard.soon` /
      `dashboard.attention` additions from `plan.md` §8 to
      `apps/web/messages/en.json`.
    - Change the two `dashboard.soon` **values** ("Coming up" → "Today") — keys
      untouched.
    - Mirror every key into the other 20 locale files in `apps/web/messages/`
      (`ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk,
      vi, zh`) with real translations. No half-translated locale.
    - **Every leaf key name is camelCase and contains no literal `.`** — next-intl
      rejects dotted leaf names at runtime and the hydration spec turns that into
      a multi-shard e2e failure.
    - **Done when**: `pnpm --filter @ever-works/web test` is green and a manual
      locale switch shows no English fallback on Home.

- [ ] **T27.** Phase 1 end-to-end coverage.
    - Create `apps/web/e2e/home-morning.spec.ts` — spec scenarios S1, S4, S5, S6,
      S7: block order, the score line, the day-scoped Today panel with all seven
      kinds, the spend headline and cap bar, the working-now rows, the activity
      tail.
    - Create `apps/web/e2e/home-composer.spec.ts` — spec scenarios S2, S13, S14,
      S20: one sentence creates a Task in the Backlog lane and the chip links to
      it; a forced failure preserves the text and restores focus; the throttle
      copy; the 3 and 2000 character bounds; the no-runtime suffix.
    - **Done when**: both specs pass in the authenticated Chromium project.

- [ ] **T28.** Phase 1 gate.
    - Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`
      from the repo root and confirm green.
    - Update `docs/specs/features/agent-workspace/TRACKER.md`: AW-19 spec `Draft`,
      impl `In progress`, with the branch/PR link.

---

## Phase 2 — Answer without leaving, and personalisation

- [ ] **T29.** Inline decision answering.
    - Modify `apps/web/src/components/home/NeedsYouBlock.tsx` to call
      `replyToInboxItemAction` from
      `apps/web/src/app/actions/dashboard/inbox.ts` with the chosen `optionId`.
    - Render the `Answering…` state; on the response, map
      `InboxReplyOutcome.routed` to the toast copy in spec §6.14
      (`steered` / `resumed` / `approved` / `rejected` / `escalation-resolved` /
      `already-decided`), using `sonner`'s `toast` directly as every other call
      site does.
    - Remove the row optimistically, then force a `needsYou` re-read rather than
      decrementing locally.
    - **Test**: `apps/web/src/components/home/NeedsYouBlock.unit.spec.tsx` — every
      routed outcome, the already-decided informational path, the reconcile.

- [ ] **T30.** The Home preference entity.
    - Create `packages/agent/src/entities/user-home-preference.entity.ts` exactly
      as in `plan.md` §3.1, modelled on
      `packages/agent/src/entities/user-notification-preference.entity.ts`.
    - Register in all four places:
      - `packages/agent/src/entities/index.ts` (re-export)
      - `packages/agent/src/database/_entities-inventory.ts` (concrete import +
        `ENTITIES` entry — never the barrel; the file explains why)
      - `packages/agent/src/database/_entity-names.ts` (`'UserHomePreference'`)
      - `packages/agent/src/database/_repository-inventory.ts` (the repository)
    - Create
      `packages/agent/src/database/repositories/user-home-preference.repository.ts`
      with `findForUser`, `upsertForUser`.
    - **Test**:
      `packages/agent/src/database/repositories/__tests__/user-home-preference.repository.spec.ts`
      — owner scoping, cascade on user delete.

- [ ] **T31.** The preference migration (**same PR as T30**).
    - Create `apps/api/src/migrations/1791190100000-AddUserHomePreferences.ts`
      creating `user_home_preferences` (`userId` uuid PK, `hiddenBlocks` text
      nullable, `blockOrder` text nullable, `workspaceSectionExpanded` boolean
      nullable, `updatedAt` timestamp default now) plus a foreign key to
      `users(id)` with `ON DELETE CASCADE`.
    - Existence-guarded, portable `Table` / `TableForeignKey` DDL; `down()` drops
      the table.
    - **Done when**: `migration:run` is clean on a fresh database and idempotent
      on one that already has the table; `migration:revert` removes only it.

- [ ] **T32.** The preferences service and endpoints.
    - Create `packages/agent/src/home/home-preferences.service.ts` (validate ids
      against `HOME_BLOCK_IDS`, de-duplicate arrays, upsert on first write, ignore
      unknown ids read back from an older row) and export it from
      `packages/agent/src/home/index.ts` and its module.
    - Create `apps/api/src/home/dto/home-preferences.dto.ts` and
      `apps/api/src/home/home-preferences.controller.ts` with
      `GET /api/home/preferences` and `PUT /api/home/preferences`
      (`@Throttle({ long: { limit: 60, ttl: 60_000 } })`); declare it in
      `apps/api/src/home/home.module.ts`.
    - **Test**:
      `packages/agent/src/home/__tests__/home-preferences.service.spec.ts`,
      `apps/api/src/home/home-preferences.controller.spec.ts`,
      `apps/api/src/home/dto/home-preferences.dto.spec.ts`.

- [ ] **T33.** The block menu and persistence.
    - Extend `apps/web/src/lib/api/home.ts` with `preferences()` and
      `updatePreferences()`; extend
      `apps/web/src/app/actions/dashboard/home.ts` with
      `getHomePreferencesAction` and `updateHomePreferencesAction` (the latter
      calling `revalidatePath('/[locale]/(dashboard)/(home)', 'page')`, matching
      `missions.ts`).
    - Create `apps/web/src/components/home/HomeBlockMenu.tsx` with the show/hide
      toggles and `Reset to defaults`. The greeting and the composer are not
      listed — they cannot be hidden.
    - Modify `apps/web/src/components/home/WorkspaceSection.tsx` to persist its
      expansion through the same preference.
    - Modify `apps/web/src/app/[locale]/(dashboard)/(home)/page.tsx` to read the
      preference and pass it down, `.catch()`-defended to the documented defaults.

- [ ] **T34.** Composer `Expand`.
    - Add an `Expand` affordance to `apps/web/src/components/home/HomeComposer.tsx`
      navigating to the full Task form
      (`apps/web/src/app/[locale]/(dashboard)/tasks/new/page.tsx`), which already
      pre-fills from a `?prompt=` param (first line becomes the title, the
      remainder seeds the description), and clear the local draft only once the
      form has it.

- [ ] **T35.** Phase 2 end-to-end coverage.
    - Create `apps/web/e2e/home-decisions.spec.ts` — spec scenarios S3, S12, S15,
      S16, S17: inline answering with the routed toast, the already-decided path,
      waiting-on-input placement, the overdue float, the preview cap with an exact
      total.
    - Extend `apps/web/e2e/home-morning.spec.ts` with spec scenario S8: hiding a
      block, the choice surviving a reload, and `Reset to defaults`.

- [ ] **T36.** Phase 2 i18n.
    - Add the `dashboard.home.needsYou.toast.*` and `dashboard.home.blocks.*`
      leaves to all 21 locale files (they are listed in `plan.md` §8 and may be
      added in P1 with the rest; this task exists to make sure nothing is left
      untranslated when the UI that uses them ships).

- [ ] **T37.** Phase 2 gate.
    - `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`
      green; migrations verified forward and backward on a scratch database.

---

## Phase 3 — Keeping it live

- [ ] **T38.** The summary provider.
    - Create `apps/web/src/components/home/HomeSummaryProvider.tsx`: seed from the
      server-rendered summary, own a `HOME_REFRESH_MS` interval gated on
      `document.visibilityState`, expose `refresh()` and `refreshBlock(id)`
      (the latter calling `refreshHomeBlockAction` and merging one block back in),
      and clear the interval on unmount.
    - A refresh must not move scroll, steal focus, or clear the composer.
    - **Test**: `apps/web/src/components/home/HomeSummaryProvider.unit.spec.tsx`
      — the tick while visible, suspension while hidden, the immediate read on
      becoming visible, and the three must-nots.

- [ ] **T39.** Freshness and the new-since pill.
    - Modify `apps/web/src/components/home/HomeGreeting.tsx` to render
      `updated {n}s ago` once `computedAt` is older than 90 s, plus a manual
      refresh control.
    - Add the `{n} new since you opened this` pill above `NeedsYouBlock`, computed
      against the decision count at mount, dismissing on click (scrolling the block
      into view) and when the count returns to or below its opening value.

- [ ] **T40.** Per-block retry.
    - Wire `HomeBlockShell`'s `Retry` to `refreshBlock(id)` so a failed block
      re-reads alone via `?blocks=<id>` and no other block is refetched.

- [ ] **T41.** Keyboard affordances.
    - Modify `apps/web/src/lib/hooks/use-keyboard-shortcuts.ts` to add `n`
      (focus the composer) and `r` (refresh the summary), active only on the Home
      route, behind the same input/textarea/select/contenteditable focus guard the
      existing `c` binding uses.
    - Add both to the Shortcuts tab in
      `apps/web/src/components/dashboard/HelpDrawer.tsx` and to
      `dashboard.header.help.shortcuts.*` in all 21 locale files, so the panel's
      advertised list stays honest (it currently advertises exactly three).

- [ ] **T42.** Telemetry.
    - Emit the spans and events listed in `plan.md` §9.1 through
      `packages/monitoring`: a span per summary build with one child per block; an
      error report per failed block naming the block and the reason; the four
      product events.
    - Assert in a unit test that no event payload carries composer text, decision
      titles, activity summaries, agent names or currency amounts.

- [ ] **T43.** Degradation and accessibility coverage.
    - Create `apps/web/e2e/home-degradation.spec.ts` — spec scenarios S9, S10,
      S11, S18, S19, S21: first-run empty, one block failed with a working
      `Retry`, the whole summary failed with a live composer, the UTC footnote, an
      Organization switch leaving no stale number (seed usage in two Organizations:
      the 7-day headline and run count change, the account-wide cap bar does not and
      says so), refresh suspended on a hidden tab.
    - Create `apps/web/e2e/home-a11y.spec.ts` — landmarks and accessible names,
      keyboard-only decision answering, visible focus rings, 4.5:1 contrast in both
      themes, and a locale switch leaving no English behind.

- [ ] **T44.** Performance verification.
    - Measure the summary endpoint against a seeded account with 500 Missions,
      2000 Tasks, 5000 Runs, 200 schedules and 50 open decisions.
    - Record p50 / p95 / p99 in the PR description; p95 must be ≤ 800 ms.
    - If a block is the outlier, fix the query (add the missing composite index in
      a migration in the same PR) — do not raise the budget.

- [ ] **T45.** Docs and rollout.
    - Add a user-facing page at `docs/features/home.md` describing the morning
      screen, each block, the composer and the block menu; cross-link it from
      `docs/features/index.md` and add it to `apps/docs/sidebarsPlatform.ts` (the
      sidebar is manual — an unlisted file renders only as an orphan page).
    - Update `docs/specs/features/agent-workspace/TRACKER.md`: AW-19 spec
      `Approved`, impl `Merged` (then `Verified` once e2e is green on `develop`).
    - Set this document's status to `Done` and `spec.md`'s to `Implemented`.

- [ ] **T46.** Phase 3 gate.
    - `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`
      green.
    - `pnpm --filter ever-works-docs build` produces no broken-link warnings.

---

## Deferred, deliberately (do not do these here)

- Drag-to-reorder blocks. P2 stores an order; only show/hide and reset are
  editable in this epic.
- Deleting `apps/web/src/components/dashboard/RecentActivity.tsx` (dead, mocked,
  un-translated). It is neither rendered nor removed by this epic — removal needs
  an explicit decision (spec §9).
- Removing `getSoonRuns()` from
  `apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-data.ts`. It stays
  exported with a pointer comment; its unit spec keeps passing.
- Backing the 60-second refresh off adaptively. Revisit with real numbers.
- Replacing polling with a push transport. Platform-wide, not a Home change.
- Any change to `StatsOverview`, `MissionsPreviewSection`, `WorkProposalsSection`,
  `RecentTasks`, `AgentsPreviewSection`, `ApprovalsQueue` or `WorkList` beyond
  moving where they are mounted.

---

## Definition of Done

- Every checkbox above ticked.
- Both migrations verified forward and backward on a scratch database, and
  idempotent when re-applied.
- Every threshold in `spec.md` §4 has at least one assertion naming it.
- Every acceptance-criteria line in `spec.md` §8 has been run against a build.
- All 21 locale files carry every new key with a real translation; no leaf key
  name contains a literal `.`.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and
  `pnpm build` green from the repo root.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- The pre-existing dashboard e2e specs pass unchanged.
- The constitution gates in `spec.md` §11 and `plan.md` §13 all confirmed
  satisfied.
