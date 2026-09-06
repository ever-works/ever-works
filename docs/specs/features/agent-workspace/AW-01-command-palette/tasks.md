# AW-01 — Command palette & global search · Task List

**Epic:** `AW-01-command-palette` · **Program:** [Agent Workspace](../README.md)
**Status:** Draft v1 · **Date:** 2026-09-06
**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Ordered top to bottom. Every task names the exact files to create or modify and what "done"
means. An engineer or a coding agent should be able to execute these in order without guessing.

**Conventions this repo enforces** (get these wrong and CI reds):
kebab-case filenames · PascalCase classes · camelCase functions · tabs, width 4, 120 columns,
single quotes, semicolons, no trailing commas · conventional commits · `pnpm` only ·
every i18n leaf key camelCase with **no literal dot** · PRs target `develop`, never `stage`
or `main`.

---

## Phase P1 — Palette, live fan-out, no schema change

### P1-A · Contracts

**T-1 — Create the shared contract types.**
Create `packages/contracts/src/api/workspace-search/workspace-search.types.ts` with
`WorkspaceSearchKind`, `WorkspaceSearchMatchReason`, `WorkspaceSearchHit`,
`WorkspaceSearchGroup`, `WorkspaceSearchResponse` exactly as in
[plan.md §4.1](plan.md#41-get-apiworkspace-search).
Create `packages/contracts/src/api/workspace-search/index.ts` re-exporting them.
Modify `packages/contracts/src/api/index.ts` to export the new folder.
**Done:** `turbo build --filter=@ever-works/contracts` passes and the types are importable from
both `apps/api` and `apps/web`.

### P1-B · Agent package — the search engine

**T-2 — Scaffold the module.**
Create `packages/agent/src/workspace-search/` with `index.ts`, `workspace-search.module.ts`,
`workspace-search.types.ts` (scope, filters, internal candidate shape).
Modify `packages/agent/package.json` to add `"./workspace-search"` to `exports`, copying the
`"./schedules"` entry byte-for-byte and changing only the path.
**Done:** `import { WorkspaceSearchModule } from '@ever-works/agent/workspace-search'` type-checks
from `apps/api`.

**T-3 — Pure fold helper.**
Create `packages/agent/src/workspace-search/fold.ts` exporting `fold(input: string): string`
(trim → lower-case → NFD-normalise → strip combining marks → NFC). No NestJS, no TypeORM.
**Done:** exported, pure, zero imports outside the standard library.

**T-4 — Pure ranking module.**
Create `packages/agent/src/workspace-search/ranking.ts` exporting `scoreCandidate(...)`
implementing the [spec FR-14](spec.md#42-querying) score table plus the `+10` recent-open and
`+5` freshness boosts capped at 100, and `compareHits(...)` implementing the FR-15 tie-break
chain (score → `updatedAt` desc → kind priority → name asc), plus `KIND_PRIORITY`.
No NestJS, no TypeORM, no database types.
**Done:** both functions are pure and total; `KIND_PRIORITY` lists all 15 kinds.

**T-5 — Unit-test ranking and folding first.**
Create `packages/agent/src/workspace-search/__tests__/ranking.spec.ts` (table-driven: one case
per score band, both boosts, the cap, every tie-break, the promote-a-100-group rule) and
`__tests__/fold.spec.ts` (case, diacritics, non-Latin pass-through, empty/whitespace).
**Done:** `cd packages/agent && npx jest --testPathPattern='workspace-search'` green with the two
specs failing-then-passing against T-3/T-4.

**T-6 — The eight P1 sources.**
Create `packages/agent/src/workspace-search/sources/` with `mission.source.ts`,
`task.source.ts`, `agent.source.ts`, `work.source.ts`, `idea.source.ts`, `skill.source.ts`,
`team.source.ts`, `knowledge.source.ts`, plus `sources/index.ts` exporting a
`kind → sourceFn` registry.
Every source: one exported function with the identical signature `(deps, scope, folded, cap)`;
scoped by `userId` always and by `organizationId` per the active scope; matching built with
`buildCaseInsensitiveLikeClause` + `prepareCaseInsensitiveContainsPattern` from
`packages/agent/src/database/utils/db.utils.ts`.
`knowledge.source.ts` additionally restricts to Works the caller owns or is a member of
(spec FR-33). **No `ILike`, no raw `ILIKE`, no `to_tsvector` anywhere.**
**Done:** every source compiles, is registered in `sources/index.ts`, and contains no
Postgres-only SQL operator.

**T-7 — The orchestrating service.**
Create `packages/agent/src/workspace-search/workspace-search.service.ts` with
`search(scope, filters)`: fold the query, run each requested source inside its own `try/catch`
(a throwing source pushes its kind onto `degradedKinds` and contributes zero rows — mirroring
`packages/agent/src/schedules/schedules.service.ts`), cap each source at `perKindLimit * 5`
candidates, score and sort with `ranking.ts`, cut to `perKindLimit` per group and `limit`
overall, and return `WorkspaceSearchResponse` with `servedBy: 'fanout'` and `tookMs`.
Wire repositories in `workspace-search.module.ts` via `TypeOrmModule.forFeature`.
**Done:** service resolves under Nest DI and returns a well-formed response for a seeded fixture.

**T-8 — Backend specs.**
Create `packages/agent/src/workspace-search/__tests__/workspace-search.service.spec.ts`
(fan-out, per-source cap, group ordering, total cap, one throwing source → `degradedKinds` and
still 200), `__tests__/workspace-search.scope.spec.ts` (`userId` always; Organization filter;
`organizationId IS NULL` in personal scope; Knowledge restricted to member Works), and
`__tests__/no-hardcoded-plugin-ids.spec.ts` (reads this epic's own source tree and fails if any
known plugin identifier appears — Constitution II).
**Done:** all three green.

**T-9 — SQLite portability spec (non-negotiable).**
Create
`packages/agent/src/workspace-search/__tests__/workspace-search.sqlite-portability.integration.spec.ts`,
copying the harness from
`packages/agent/src/user-research/__tests__/work-proposal.search-portability.integration.spec.ts`:
in-memory `better-sqlite3` DataSource over `ENTITIES`, `PRAGMA case_sensitive_like = ON`, a
query logger that captures emitted SQL.
Assert: every P1 source returns rows on SQLite; matching is case-insensitive; a `%` in the
query matches a literal percent sign, not everything; **no captured SQL contains `ILIKE`,
`to_tsvector`, `websearch_to_tsquery` or `~*`**.
**Done:** green, and it fails if any source is rewritten to a Postgres-only operator.

### P1-C · API

**T-10 — Query DTO.**
Create `apps/api/src/workspace-search/dto/workspace-search-query.dto.ts` with `q` (required,
trimmed, 2–128, longer truncated not rejected), `kinds` (repeated, unknown values ignored),
`limit` (1–60, default 60), `perKindLimit` (1–25, default 5), using `class-validator` and
`class-transformer` the way `apps/api/src/schedules/dto/schedules-query.dto.ts` does.
**Done:** validation pipe accepts the valid matrix and rejects only genuinely malformed input.

**T-11 — Controller and module.**
Create `apps/api/src/workspace-search/workspace-search.controller.ts`
(`@Controller('api/workspace-search')`, `@ApiTags('Workspace Search')`,
`@ApiBearerAuth('JWT-auth')`, `@Get()`, `@CurrentUser()`, `ScopeContextService`,
`@Throttle({ long: { limit: 120, ttl: 60_000 } })`) and
`apps/api/src/workspace-search/workspace-search.module.ts` importing the agent-side
`WorkspaceSearchModule` — both modelled directly on `apps/api/src/schedules/`.
Modify `apps/api/src/api.module.ts`: import and register `WorkspaceSearchModule` next to
`SchedulesModule` (~line 224).
**Done:** `GET /api/workspace-search?q=ab` returns 200 for an authenticated caller and 401
without auth; the route appears in the OpenAPI document.

**T-12 — Controller spec.**
Create `apps/api/src/workspace-search/workspace-search.controller.spec.ts`: auth guard;
`q` shorter than 2 → empty response with **no** service call; `limit`/`perKindLimit` clamped;
unknown `kinds` ignored rather than 400; scope threaded from `ScopeContextService`; throttle
metadata present; response matches the contract.
**Done:** `cd apps/api && pnpm test -- workspace-search` green.

### P1-D · Web BFF

**T-13 — The browser-facing route.**
Create `apps/web/src/app/api/workspace-search/route.ts`, wrapped in `bffProxy(handler)` from
`apps/web/src/lib/api/bff-proxy.ts` with the **default** `scope: 'workspace'` (never
`scope: 'none'`). Read and clamp `q`/`kinds`/`limit`/`perKindLimit`; short-circuit
`q.trim().length < 2` to `{ query, groups: [], degradedKinds: [], servedBy: 'fanout', tookMs: 0 }`
without touching upstream; forward with `cache: 'no-store'`; pass the upstream status through.
Model the body on `apps/web/src/app/api/works/[id]/kb/search/route.ts`.
**Done:** the route answers 400 without a workspace selector, 401 without auth, 200 otherwise.

**T-14 — BFF route spec.**
Create `apps/web/src/app/api/workspace-search/route.unit.spec.ts`: scope forwarding; fail-closed
400; clamping; short-circuit; upstream error passthrough.
**Done:** green under `cd apps/web && npx vitest run src/app/api/workspace-search`.

### P1-E · Palette UI

**T-15 — Registry types and the Screens registry.**
Create `apps/web/src/components/command-palette/registry/types.ts` and
`registry/screens.ts`. Build every entry from `ROUTES` in `apps/web/src/lib/constants.ts` —
one per navigable dashboard screen including all Settings sub-pages and all Work sub-pages,
each `{ id, titleKey, breadcrumbKeys, href, predicate? }`.
**Explicitly exclude** `ROUTES.DASHBOARD_NOTIFICATIONS` with an inline comment citing the
"soft-404s" note in `constants.ts`; point at `DASHBOARD_SETTINGS_NOTIFICATIONS` instead.
Reuse existing `dashboard.sidebar.navigation.*` / `metadata.pages.*` keys where one exists.
**Done:** registry exports a typed array; no literal path strings.

**T-16 — The P1 command registry.**
Create `apps/web/src/components/command-palette/registry/commands.ts` with the eight command
families in [spec FR-22](spec.md#44-commands). Each entry: stable `id`, `labelKey`,
`aliasesKey` (≥ 2 aliases, FR-25), icon, optional `predicate`, and a `handler` taking
`{ router, openHelp, toggleTheme, setSidebarCollapsed, setChatOpen, organizations, works }`.
Nothing in this file performs a server mutation.
**Done:** every command is reachable by at least two alias strings; no `fetch` in the file.

**T-17 — Hooks.**
Create `apps/web/src/components/command-palette/hooks/use-workspace-search.ts` (150 ms debounce;
2-char floor; single `AbortController` aborting older requests; discard out-of-order responses;
3 500 ms timeout; `navigator.onLine` short-circuit; a "last good results" buffer),
`hooks/use-palette-recents.ts` (12-entry cap, move-to-top on repeat, every
`localStorage` access in `try/catch` — follow `apps/web/src/lib/hooks/use-theme.ts`), and
`hooks/use-palette-keyboard.ts` (the whole [FR-41](spec.md#48-accessibility-and-input) key map,
skipping disabled rows, `Esc`'s three-step precedence).
**Done:** all three exported and independently testable without a DOM-heavy harness.

**T-18 — Components.**
Create `apps/web/src/components/command-palette/`: `CommandPaletteProvider.tsx`,
`CommandPalette.tsx` (the `cmdk` dialog — `cmdk@^1.1.1` is already a dependency),
`CommandPaletteTrigger.tsx`, `PaletteGroup.tsx`, `PaletteRow.tsx`, `PaletteFooter.tsx`.
Render every state in [spec §6](spec.md#6-ux): empty, too-short, loading, results, filtered,
no-results, partial-failure, timeout, offline, throttled, disabled-row.
Accessibility: modal dialog with a focus trap, combobox input + listbox, active-descendant,
polite `{count} results` announcement, 3:1 focus ring in both themes, full-screen and 44 px rows
below 768 px.
**Done:** every state renders; no string literal appears outside a translation call.

**T-19 — Mount in the shell.**
Modify `apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`: wrap the shell body in
`<CommandPaletteProvider>` **inside** `ChatProvider`, and render `<CommandPalette />` as a
sibling of `<HelpDrawer />` (~line 528). Pass the provider's opener into
`useKeyboardShortcuts` (~line 360) exactly as `onOpenHelp` is passed today.
**Done:** the palette opens on every dashboard route; the sidebar, chat panel, header and help
drawer behave identically to before.

**T-20 — Header trigger.**
Modify `apps/web/src/components/dashboard/DashboardHeader.tsx`: insert
`<CommandPaletteTrigger />` between `<WorkSwitcher />` and the right-hand cluster
(`NotificationDropdown` / `ThemeToggle` / Help). Move nothing else.
**Done:** the trigger renders at ≥ 768 px, collapses to an icon below it, and opens the palette.

**T-21 — Re-bind the shortcuts.**
Modify `apps/web/src/lib/hooks/use-keyboard-shortcuts.ts`: add an `onOpenPalette` option;
`Ctrl/Cmd+K` calls it instead of `router.push('/works?focus=search')` (line 38); add the `/`
binding under the existing input/textarea/select/contenteditable guard. Leave the `C` and `?`
bindings byte-for-byte unchanged. Update the file's doc comment.
**Done:** `Ctrl+K` no longer navigates; `Search Works` in the command registry reaches
`/works?focus=search` and the Works page still focuses its filter (spec FR-4).

**T-22 — Web unit specs.**
Create `apps/web/src/components/command-palette/CommandPalette.unit.spec.tsx`,
`hooks/use-palette-keyboard.unit.spec.ts`, `hooks/use-workspace-search.unit.spec.ts`,
`hooks/use-palette-recents.unit.spec.ts`, `registry/screens.unit.spec.ts`,
`registry/commands.unit.spec.ts`, and
`apps/web/src/lib/hooks/use-keyboard-shortcuts.unit.spec.ts`.
Coverage per [plan.md §10.3](plan.md#103-unit--web-vitest). The screens spec must assert every
href traces back to a `ROUTES` value or builder and that the dead notifications route is absent.
**Done:** `cd apps/web && npx vitest run` green.

### P1-F · i18n

**T-23 — Add the namespace to English.**
Modify `apps/web/messages/en.json`: add the full `dashboard.commandPalette` tree from
[plan.md §8](plan.md#8-i18n). Change **values only** for
`dashboard.header.help.shortcuts.search` (`"Search works"` → `"Open search & commands"`) and add
sibling keys `shortcuts.palette`, `shortcuts.paletteSlash`, `shortcuts.paletteNavigate`,
`shortcuts.paletteFilter`. Rename or delete **no** existing key.
**Done:** valid JSON; every new leaf key is camelCase and contains no literal `.`.

**T-24 — Mirror into the 20 sibling locales.**
Modify `apps/web/messages/{ar,bg,de,es,fr,he,hi,id,it,ja,ko,nl,pl,pt,ru,th,tr,uk,vi,zh}.json`
with translated values, identical key structure, no missing leaf.
**Done:** every locale parses; a key-shape diff against `en.json` is empty.

**T-25 — Update the Help drawer's Shortcuts tab.**
Modify `apps/web/src/components/dashboard/HelpDrawer.tsx` to render the new shortcut rows
(palette open, `/`, navigate, filter, `?`, `C`) from the keys added in T-23. Remove no existing
row and no existing key.
**Done:** the Shortcuts tab lists the real bindings; `?` still opens the drawer.

### P1-G · End-to-end

**T-26 — Golden-path e2e.**
Create `apps/web/e2e/command-palette.spec.ts`: `Ctrl+K` from Home, a Mission detail and Settings;
type a seeded name; assert grouped results; `Enter` navigates; the top-bar trigger opens the same
overlay; `Esc` closes and restores focus. Use the fixtures in `apps/web/e2e/helpers/api.ts`.
**Done:** green locally and in CI.

**T-27 — Keyboard e2e.**
Create `apps/web/e2e/command-palette-keyboard.spec.ts`: arrows, `Home`/`End`, `Tab` filter chip,
`Shift+Tab`, `Ctrl/Cmd+Enter` new tab, `Ctrl/Cmd+1..9`, `/` inside vs outside a text field, and
`Ctrl+K` inside the AI chat composer inserting no character.
**Done:** green.

**T-28 — Commands e2e.**
Create `apps/web/e2e/command-palette-commands.spec.ts`: `new mission` navigates to Mission
creation; `help` opens the drawer without navigating; `Search Works` lands on the Works list with
its filter focused (the preserved legacy destination).
**Done:** green.

**T-29 — Recent e2e.**
Create `apps/web/e2e/command-palette-recents.spec.ts`: open two records from the palette; reopen
the palette; both appear newest-first; re-opening one moves it to the top without duplicating.
**Done:** green.

**T-30 — Scope-isolation e2e.**
Create `apps/web/e2e/command-palette-scope-isolation.spec.ts`: seed a Mission in Organization B;
search from Organization A → zero rows; switch scope → the same query returns it (spec S-16).
**Done:** green; the assertion is a hard `toHaveCount(0)`, never a tolerated-either-way check.

**T-31 — Degraded-state e2e.**
Create `apps/web/e2e/command-palette-degraded.spec.ts` using Playwright route interception:
force one kind to fail → other groups render + partial banner; hold the endpoint past 3.5 s →
prior results dimmed + timeout banner, `Enter` retries; go offline → local-only + offline banner;
return 429 → throttled banner.
**Done:** green.

**T-32 — Accessibility e2e.**
Create `apps/web/e2e/command-palette-a11y.spec.ts`: run the accessibility audit on the open
palette in light and dark; assert the focus trap, the dialog/combobox/listbox roles, the
active-descendant, and one polite `{count} results` announcement per settled result set.
**Done:** zero serious or critical violations.

**T-33 — P1 exit gate.**
Run `pnpm lint`, `pnpm type-check`, `cd packages/agent && pnpm test`, `cd apps/api && pnpm test`,
`cd apps/web && npx vitest run`, and the e2e suite. Verify by inspection that this phase changed
**no** entity, **no** migration, **no** existing route constant, and **no** i18n key name.
**Done:** all green; open PR(s) against `develop`.

---

## Phase P2 — Index, server-side Recent, remaining kinds

### P2-A · Entities and the migration

**T-34 — The two entities.**
Create `packages/agent/src/entities/search-index-entry.entity.ts` (`@Entity('search_index_entries')`,
class `SearchIndexEntry`) and `packages/agent/src/entities/workspace-search-recent.entity.ts`
(`@Entity('workspace_search_recents')`, class `WorkspaceSearchRecent`) with exactly the columns
and indexes in [plan.md §3.2](plan.md#32-p2--two-new-tables). Both declare **`tenantId` and
`organizationId`** so the existing scope-stamping subscriber fills them on insert.
**Done:** both compile and are exported from `packages/agent/src/entities/index.ts`.

**T-35 — The three inventory files (or CI reds).**
Modify `packages/agent/src/database/_entities-inventory.ts` (concrete per-file import + an
`ENTITIES` entry — **never** the barrel), `packages/agent/src/database/_entity-names.ts` (both
class names), and `packages/agent/src/entities/index.ts` (barrel export).
Modify `packages/agent/src/entities/__tests__/tier-c.tenants-orgs.spec.ts` to expect both new
tables in the scope-stamped set.
**Done:** the entity-barrel drift spec in `database.module.spec.ts` and the Tier C spec are green.

**T-36 — The forward-only migration (same PR as T-34).**
Create `apps/api/src/migrations/1789600000000-AddWorkspaceSearchIndex.ts`, class
`AddWorkspaceSearchIndex1789600000000`. Two existence-guarded `CREATE TABLE`s plus their
indexes, expressed with TypeORM `Table`/`TableIndex` objects (portable — CI and e2e run
`better-sqlite3`, production runs Postgres). No `ALTER`, no `DROP`, no data movement on any
existing table. `down()` drops exactly the two tables it created.
Follow the doc-comment style of `apps/api/src/migrations/1789100000000-AddTaskGraphFanout.ts`.
**Done:** `pnpm typeorm migration:run` applies cleanly on an empty DB **and** on a DB where it
already ran; the API boots with `RUN_MIGRATIONS=true`.

### P2-B · Index maintenance

**T-37 — The projection maintainer.**
Create `packages/agent/src/workspace-search/index-maintainer.service.ts` with
`project(kind, sourceId)` (read the source row → upsert a `current` projection),
`markStale(kind, sourceIds)` and `tombstone(kind, sourceIds)`.
**Done:** each of the 15 kinds has a projector; secret-bearing columns are never read
(spec FR-34).

**T-38 — Dispatcher symbol and producer interface.**
Create `packages/agent/src/workspace-search/workspace-search-index.dispatcher.ts` exporting
`WORKSPACE_SEARCH_INDEX_DISPATCHER` and `WorkspaceSearchIndexDispatcher`
(`dispatchIndexRefresh(payload): Promise<string | null>`), modelled on
`packages/agent/src/tasks/kb-reembed-work-dispatcher.ts`.
**Done:** the symbol is the **only** thing call sites import; no third-party SDK import anywhere in
this module (Constitution IV).

**T-39 — Write-path subscriber.**
Create `packages/agent/src/workspace-search/search-index.subscriber.ts`: on insert / update /
soft-delete of any indexed entity, synchronously mark the projection `stale` / `tombstoned`
(one cheap `UPDATE`), then dispatch a batched refresh (max 200 ids per dispatch). Swallow and
log dispatch failures — the reconcile sweep is the safety net.
**Done:** a stale row is still returned with its old title; a tombstoned row is invisible
immediately, with or without the job running.

**T-40 — Reconcile service.**
Create `packages/agent/src/workspace-search/index-reconcile.service.ts` with `reconcile()`:
refresh `stale` rows older than 60 s; hard-delete `tombstoned` rows older than 24 h; on the
nightly pass, back-fill source rows with no projection; delete `workspace_search_recents` older
than 90 days; return counters. Guard overlapping ticks with `DistributedTaskLockService`
(`packages/agent/src/cache/distributed-task-lock.service.ts`).
**Done:** idempotent; a second concurrent run is a no-op.

**T-41 — The two jobs.**
Create `packages/tasks/src/tasks/trigger/workspace-search-index-refresh.task.ts` and
`packages/tasks/src/tasks/trigger/workspace-search-reconcile.task.ts`
(`schedules.task({ id: 'workspace-search-reconcile', cron: '*/15 * * * *' })` plus a nightly full
pass at `'23 4 * * *'`, offset from the existing 03:17 / 03:42 crons). Both use
`withWorkerContext(...)` and delegate to the agent-package services, following
`packages/tasks/src/tasks/trigger/kb-reconcile.task.ts`.
Register both in `packages/tasks/src/tasks/trigger/index.ts`.
Bind the dispatcher symbol to the provider in the API module wiring.
**Done:** `pnpm build:plugins && pnpm build` green; the tasks appear in the task registry.

**T-42 — Maintenance specs.**
Create `packages/agent/src/workspace-search/__tests__/index-maintainer.service.spec.ts` (insert →
`current`; update → `stale` then refreshed; delete → `tombstoned`; a tombstoned row is never
returned) and `__tests__/index-reconcile.service.spec.ts` (stale refresh, 24 h tombstone GC,
90-day Recent GC, back-fill, counters, lock behaviour).
**Done:** green.

### P2-C · Read path and the remaining kinds

**T-43 — Index-backed read with fan-out fallback.**
Modify `packages/agent/src/workspace-search/workspace-search.service.ts`: try the index first;
fall back to the P1 fan-out per-kind when the index is unavailable or a kind has no coverage;
set `servedBy` to `index` / `fanout` / `mixed`. Ranking still goes through the **same**
`ranking.ts`, so the two back ends cannot disagree about order.
**Done:** with the index table emptied the endpoint still returns correct results under 600 ms,
and `servedBy` reports `fanout`.

**T-44 — The seven P2 kinds.**
Create `packages/agent/src/workspace-search/sources/` entries for `run`, `decision`, `memory`,
`goal`, `meeting`, `node` and `connection` (see [spec FR-18](spec.md#43-what-is-searchable)),
plus their projectors in the maintainer.
`connection.source.ts` resolves installed integrations through the existing plugin
registry/capability facade — **no hardcoded plugin identifier** (Constitution II; the T-8 spec
enforces it).
**Done:** all 15 kinds return rows for a seeded fixture; the no-hardcoded-plugin-ids spec still
passes.

**T-45 — Recents endpoints.**
Create `apps/api/src/workspace-search/workspace-search-recents.controller.ts`
(`GET` capped at 12, `POST` upserting on `(userId, organizationId, kind, sourceId)` and trimming
to 12, `DELETE /:kind/:sourceId`), register it in the existing
`apps/api/src/workspace-search/workspace-search.module.ts`, and create
`apps/api/src/workspace-search/workspace-search-recents.controller.spec.ts`.
Create `apps/web/src/app/api/workspace-search/recents/route.ts` (`GET` + `POST`, `bffProxy`,
`scope: 'workspace'`).
**Done:** a repeat open updates rather than duplicates; every route filters by `userId`.

**T-46 — Client prefers the server list.**
Modify `apps/web/src/components/command-palette/hooks/use-palette-recents.ts` to read/write the
server endpoints when reachable and keep the `localStorage` list as the offline fallback
(spec FR-30). A failure on either path must never throw into render.
Modify `apps/web/src/components/command-palette/CommandPalette.tsx` to `POST` a Recent entry when
a **record** row is opened (never for a Command — spec FR-26) and to `DELETE` the entry when a
target turns out to be gone (spec FR-29, S-14).
**Done:** Recent survives a browser change for the same user; blocked storage degrades silently.

**T-47 — i18n for the new groups.**
Modify `apps/web/messages/en.json` and the 20 sibling locales: add
`dashboard.commandPalette.groups.{runs,decisions,memory,goals,meetings,computers,connections}`.
**Done:** all 21 files parse; key shapes identical.

**T-48 — Freshness e2e.**
Create `apps/web/e2e/command-palette-index-freshness.spec.ts`: create a record → it is findable;
rename it → the new name is findable and the old one is not; delete it → it is never returned.
**Done:** green within the 60 s freshness window.

**T-49 — P2 exit gate.**
Full lint / type-check / all test suites, plus a migration replay on a fresh database and on an
already-migrated database.
**Done:** all green; PR against `develop`.

---

## Phase P3 — Acting from the palette

**T-50 — State-changing command registry.**
Create `apps/web/src/components/command-palette/registry/commands-stateful.ts` with
`Pause Agent…`, `Resume Agent…`, `Run Agent now…`, `Pause Mission…`, `Resume Mission…`,
`Run Work schedule now…`, `Run Task…` ([spec FR-23](spec.md#44-commands)). Each declares a target
picker, a `confirm` descriptor, a permission `predicate`, and an existing endpoint from
[plan.md §4.3](plan.md#43-endpoints-deliberately-not-created). **No new endpoint is created.**
**Done:** every entry maps to an endpoint that already exists on `develop`.

**T-51 — Confirmation step.**
Create `apps/web/src/components/command-palette/PaletteConfirm.tsx` and wire it into
`CommandPalette.tsx`: selecting a state-changing command replaces the list with the confirmation
(spec §6.9); `Esc` returns to the results without acting; only the explicit confirm issues the
call; a failure toasts and returns to the results.
**Done:** no state-changing command can fire on a single `Enter`.

**T-52 — Two-step target picker.**
Modify `CommandPalette.tsx` so `Pause Agent…` opens a second step listing matching Agents,
searchable with the same input and navigable with the same keys.
**Done:** `pause ivy` reaches the confirmation in two keystroke groups.

**T-53 — Disabled-state rendering.**
Modify `PaletteRow.tsx` and `use-palette-keyboard.ts`: a row whose `predicate` fails renders
dimmed with a trailing reason, is skipped by arrow navigation, and cannot be activated by
`Enter` or by click (spec FR-24, S-15).
**Done:** a non-owner sees `Needs owner access` and cannot fire the command.

**T-54 — P3 tests.**
Create `apps/web/src/components/command-palette/PaletteConfirm.unit.spec.tsx` and
`registry/commands-stateful.unit.spec.ts` (every entry has a confirmation, a predicate and an
existing endpoint), plus `apps/web/e2e/command-palette-actions.spec.ts` (pause an Agent from the
palette → confirm → the Agent's status becomes paused; `Esc` at the confirmation changes nothing).
**Done:** green.

**T-55 — P3 exit gate.**
Full lint / type-check / all suites. Verify no endpoint was added and no schema changed in this
phase.
**Done:** all green; PR against `develop`.

---

## Cross-cutting checklist (verify before each PR merges)

- [ ] No entity, route constant, component, endpoint or i18n **key** was removed or renamed
      (program rule #1, NN #20). The only value changes are the Help-drawer shortcut strings.
- [ ] `Ctrl/Cmd+K`'s old destination is still reachable as the `Search Works` command, and the
      Works page still honours its own focus-the-filter entry point (spec FR-4).
- [ ] Every matching clause goes through `buildCaseInsensitiveLikeClause` /
      `prepareCaseInsensitiveContainsPattern`; no `ILike`, `ILIKE`, `to_tsvector` or `~*`.
- [ ] Every new i18n leaf key is camelCase and contains **no literal `.`**; all 21 locale files
      have the same key shape.
- [ ] The raw query string appears in no log line and no analytics payload (spec FR-36).
- [ ] No secret-bearing column is read into the search read model or the index (spec FR-34).
- [ ] No hardcoded plugin identifier in this epic's source tree (Constitution II).
- [ ] Background work is dispatched only through `WORKSPACE_SEARCH_INDEX_DISPATCHER` and the
      configured job-runtime provider's cron (Constitution IV).
- [ ] The schema change ships with its forward-only migration in the **same** PR
      (Constitution V, program rule #6).
- [ ] PRs target `develop`; the source branch is deleted after merge.
- [ ] Green CI: `pnpm lint`, `pnpm type-check`, agent Jest, API Jest, web Vitest, Playwright.

---

## Follow-ups deliberately **not** done here

1. **Portability fix for the existing Missions list filter.**
   `packages/agent/src/missions/missions.service.ts` lines 232–236 use TypeORM's `ILike`, which
   is not portable to the SQLite-backed deployments (demo stack, OSS self-hosts, local dev, the
   e2e harness) — the same defect class the Ideas search already hit. This epic's Missions
   **source** does not use that path. Fixing the list filter is a separate, small PR.
2. **Deduplicating the two Work-scoped Knowledge-Base palettes** (one built on the palette
   library, one hand-rolled to avoid it). Out of scope per spec §7.3.
3. **Making the sidebar nav data-driven** so it and the Screens registry share one source. The
   nav array is hardcoded inside a 628-line component; refactoring it would make this epic
   subtractive.

---

## Tracker linkage

Add the epic and its three phases to [`../TRACKER.md`](../TRACKER.md) and mark AW-01 as
spec-complete when this folder merges. JIRA Epic and per-phase Story keys live in the `EW`
project and are filled in once the issues exist:

- **Epic:** EW-TBD — Command palette & global search
    - P1 — Palette, live fan-out, no schema change: EW-TBD
    - P2 — Index, server-side Recent, remaining kinds: EW-TBD
    - P3 — Acting from the palette: EW-TBD
