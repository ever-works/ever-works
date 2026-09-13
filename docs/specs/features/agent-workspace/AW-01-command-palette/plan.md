# AW-01 — Command palette & global search · Implementation Plan

**Epic:** `AW-01-command-palette` · **Program:** [Agent Workspace](../README.md)
**Status:** Draft v1 · **Owner:** Engineering · **Date:** 2026-09-06
**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md)
**Governance:** [Constitution](../../../../../.specify/memory/constitution.md)

> **Additive.** One new overlay, one new read-only API surface, one new agent-package module,
> two new tables in P2, and one deliberate re-binding of `Ctrl/Cmd+K` whose old destination is
> preserved as a palette command. No entity, route, component, endpoint, i18n key or sidebar
> entry is removed or renamed.

---

## 1. Current state in the codebase

Everything below was read in this worktree; every path resolves.

### 1.1 The shell — where the palette will hang

| File                                                                                                                                                                                                | What it does today                                                                                                                                                                                                                              | Why it matters here                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/web/src/app/[locale]/(dashboard)/layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/layout-client.tsx>)                                                               | 540-line client shell. Mounts `DashboardSidebar`, `ChatPanel`, `DashboardHeader`, `<main id="main-content">`, `Footer`, `HelpDrawer`. Calls `useKeyboardShortcuts({ onOpenHelp })` at line 360; renders `<HelpDrawer …/>` at line 528.          | The palette mounts here, as a sibling of `HelpDrawer`, inside `ChatProvider` so the "Open AI chat" command can reach the chat context.                                                                                        |
| [`apps/web/src/app/[locale]/(dashboard)/layout.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/layout.tsx>)                                                                             | Server layout; auth-gates the group, fetches profile/plugins/onboarding/version in parallel, each `.catch()`-defended.                                                                                                                          | The Screens registry needs no server data; the Organization list for `Switch workspace →` comes from the existing `useOrganizations` hook, not from here.                                                                     |
| [`apps/web/src/lib/hooks/use-keyboard-shortcuts.ts`](../../../../../apps/web/src/lib/hooks/use-keyboard-shortcuts.ts)                                                                               | Exactly three global bindings on one `document.keydown` listener: `Ctrl/Cmd+K` → `router.push('/works?focus=search')` (line 38), `C` → `/works/new`, `?` → Help drawer. Guards `input/textarea/select/contenteditable` for the unmodified keys. | **The single edit point for FR-1/FR-2/FR-4.** `Ctrl/Cmd+K` is repointed at `onOpenPalette`; `/` is added under the same input guard; `C` and `?` are untouched.                                                               |
| [`apps/web/src/components/dashboard/DashboardHeader.tsx`](../../../../../apps/web/src/components/dashboard/DashboardHeader.tsx)                                                                     | 124-line top bar: mobile hamburger, `WorkSwitcher`, onboarding pill, then `NotificationDropdown` / `ThemeToggle` / Help button. No search box.                                                                                                  | FR-3's trigger goes between `WorkSwitcher` and the right-hand cluster.                                                                                                                                                        |
| [`apps/web/src/components/dashboard/DashboardSidebar.tsx`](../../../../../apps/web/src/components/dashboard/DashboardSidebar.tsx)                                                                   | 628 lines; the nav array is hardcoded in-component (14 top-level entries, `matchPrefixes` for merged entries).                                                                                                                                  | **Not modified.** The Screens registry is a new, separate module; duplicating 14 labels there is cheaper than refactoring the sidebar to be data-driven, and keeps this epic additive. Flagged as a follow-up, not done here. |
| [`apps/web/src/components/dashboard/HelpDrawer.tsx`](../../../../../apps/web/src/components/dashboard/HelpDrawer.tsx)                                                                               | 601-line slide-over, 4 tabs; the Shortcuts tab renders exactly three entries from `header.help.shortcuts.{search,newWork,help}`.                                                                                                                | Gains the new shortcut rows (spec §6.12). Existing keys keep their names; `shortcuts.search`'s **value** changes.                                                                                                             |
| [`apps/web/src/components/dashboard/WorkSwitcher.tsx`](../../../../../apps/web/src/components/dashboard/WorkSwitcher.tsx)                                                                           | Headless UI `Combobox` over Works only, client-filters up to 1 000 rows, swaps the work-id segment in place on Work-detail routes.                                                                                                              | **Not modified.** The `Switch Work →` command reuses its route-rewrite idea but does not import it.                                                                                                                           |
| [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts)                                                                                                                     | `ROUTES` starts at line 107 — a flat object of string paths and `(id) => string` builders; `PUBLIC_ROUTES`; `routeWithParams`; `withAppUrl`. Documented dead constant `DASHBOARD_NOTIFICATIONS`.                                                | The Screens registry is built **from** `ROUTES` so paths never drift. `DASHBOARD_NOTIFICATIONS` is explicitly excluded from the registry (it soft-404s).                                                                      |
| [`apps/web/src/components/theme-toggle.tsx`](../../../../../apps/web/src/components/theme-toggle.tsx) + [`apps/web/src/lib/hooks/use-theme.ts`](../../../../../apps/web/src/lib/hooks/use-theme.ts) | Hand-written class-based dark mode, every storage access in `try/catch`.                                                                                                                                                                        | `Toggle dark mode` calls the existing hook; no new theme mechanism.                                                                                                                                                           |

### 1.2 The two existing palettes (and why neither is reused)

- [`apps/web/src/components/kb/workbench/KbSearchPalette.tsx`](../../../../../apps/web/src/components/kb/workbench/KbSearchPalette.tsx) — 517 lines, built on `cmdk`, 200 ms debounce, filter chips, `Cmd/Ctrl+K` listener on `window`, mounted only at the Knowledge-Base workbench route root. Its doc comment is explicit that it is "scoped to the current Work's KB".
- [`apps/web/src/components/works/detail/kb/KbSearchPalette.tsx`](../../../../../apps/web/src/components/works/detail/kb/KbSearchPalette.tsx) — 329 lines, a second hand-rolled implementation that deliberately avoids the `cmdk` dependency.

Both stay exactly as they are (spec §7.3). The global palette is a **third**, separate
component; FR-7 defines the coexistence rule (on the workbench route the screen-scoped
listener wins the keystroke, and the global palette is reachable from the top-bar trigger).
`cmdk@^1.1.1` is already a dependency of `apps/web` — no new package.

### 1.3 The backend patterns this epic copies

| File                                                                                                                                                                                                                                                                                                            | Pattern being reused                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/api/src/schedules/schedules.controller.ts`](../../../../../apps/api/src/schedules/schedules.controller.ts) + [`schedules.module.ts`](../../../../../apps/api/src/schedules/schedules.module.ts)                                                                                                          | Thin, read-only, scope-aware aggregation controller over an agent-package service. `@ApiTags` / `@ApiBearerAuth` / `@CurrentUser()` / `ScopeContextService`. Exactly the shape of `WorkspaceSearchController`.                                                          |
| [`packages/agent/src/schedules/schedules.service.ts`](../../../../../packages/agent/src/schedules/schedules.service.ts)                                                                                                                                                                                         | Multi-source fan-out with a `MAX_PER_SOURCE` guard, per-source `try/catch` so one bad source degrades to an empty slice instead of a 500, and a projected view type. This is the template for `WorkspaceSearchService` and directly satisfies FR-37.                    |
| [`packages/agent/src/database/utils/db.utils.ts`](../../../../../packages/agent/src/database/utils/db.utils.ts)                                                                                                                                                                                                 | `sanitizeLikePattern`, `buildCaseInsensitiveLikeClause` (`LOWER(col) LIKE :p ESCAPE '\'`, with an identifier allowlist), `prepareCaseInsensitiveContainsPattern`. Portable across Postgres / MySQL / SQLite. **Every matching clause in this epic goes through these.** |
| [`packages/agent/src/user-research/__tests__/work-proposal.search-portability.integration.spec.ts`](../../../../../packages/agent/src/user-research/__tests__/work-proposal.search-portability.integration.spec.ts)                                                                                             | The cautionary tale: the one search path that used a Postgres-only operator 500'd on every non-Postgres deployment, and the e2e suite had _encoded_ the 500 as acceptable. Its `better-sqlite3` in-memory harness is copied verbatim for our portability spec.          |
| [`apps/api/src/scope/scope-context.service.ts`](../../../../../apps/api/src/scope/scope-context.service.ts) + [`scope-stamping.subscriber.ts`](../../../../../apps/api/src/scope/scope-stamping.subscriber.ts)                                                                                                  | Request-scoped `{ tenantId, organizationId }`; the subscriber auto-stamps any entity declaring **both** columns on insert. Our two new tables declare both, so they are stamped for free.                                                                               |
| [`apps/web/src/lib/api/bff-proxy.ts`](../../../../../apps/web/src/lib/api/bff-proxy.ts)                                                                                                                                                                                                                         | `bffProxy(handler, { scope })` — resolves the auth cookie, converts the browser's per-tab workspace selector into the upstream scope header, and **fails closed with 400** when the selector is missing. Mandatory for the palette's browser-facing route.              |
| [`apps/web/src/app/api/works/[id]/kb/search/route.ts`](../../../../../apps/web/src/app/api/works/[id]/kb/search/route.ts)                                                                                                                                                                                       | The exact BFF search-proxy shape: read `q`/`limit`, clamp `limit`, short-circuit empty `q` to an empty payload, forward with `cache: 'no-store'`.                                                                                                                       |
| [`packages/tasks/src/tasks/trigger/kb-reconcile.task.ts`](../../../../../packages/tasks/src/tasks/trigger/kb-reconcile.task.ts)                                                                                                                                                                                 | Scheduled sweep: `schedules.task({ id, cron })`, `withWorkerContext(...)`, delegate to an agent-package service, return a counter summary. The template for the index reconcile job.                                                                                    |
| [`packages/agent/src/tasks/kb-reembed-work-dispatcher.ts`](../../../../../packages/agent/src/tasks/kb-reembed-work-dispatcher.ts)                                                                                                                                                                               | Producer-side dispatcher interface + DI `Symbol`. Call sites depend only on the symbol (Constitution IV).                                                                                                                                                               |
| [`packages/agent/src/database/_entities-inventory.ts`](../../../../../packages/agent/src/database/_entities-inventory.ts), [`_entity-names.ts`](../../../../../packages/agent/src/database/_entity-names.ts), [`_repository-inventory.ts`](../../../../../packages/agent/src/database/_repository-inventory.ts) | Adding an entity means editing **all three**, or CI reds on the drift specs. Called out as its own task.                                                                                                                                                                |

### 1.4 Name collision to avoid

`POST /api/search` and `GET /api/search/check-availability` already exist
([`apps/api/src/plugins-capabilities/search/search.controller.ts`](../../../../../apps/api/src/plugins-capabilities/search/search.controller.ts)) and mean
**search the web through the user's configured search plugin**. This epic must not take that
path, that controller name, or that module directory. The new surface is
**`/api/workspace-search`** throughout — endpoint, agent module, contracts folder, i18n
namespace and telemetry prefix all use the same word so nobody confuses the two again.

### 1.5 Portability landmine found while surveying

[`packages/agent/src/missions/missions.service.ts`](../../../../../packages/agent/src/missions/missions.service.ts) lines 232–236 filter Missions with TypeORM's
`ILike`, which is not portable to the SQLite-backed deployments (the demo stack, OSS
self-hosts, local dev, and the e2e harness). It is the same defect class the Ideas search
already had. The Missions **source in this epic** will not reuse that path — it goes through
`buildCaseInsensitiveLikeClause` like every other source. Fixing the existing Missions list
filter is out of scope here and is called out in tasks.md as a spawned follow-up.

---

## 2. Architecture and the seam

```
  BROWSER                        apps/web (Next server)              apps/api (Nest)
  ─────────────────────────      ──────────────────────────────      ──────────────────────────

  ⌘K  ─► useKeyboardShortcuts
          │ onOpenPalette
          ▼
     <CommandPalette>            /api/workspace-search  (BFF)        GET /api/workspace-search
       ├ command registry  ────► bffProxy({scope:'workspace'})  ───► WorkspaceSearchController
       │   (pure client)         · auth cookie → bearer                │  @CurrentUser + Scope
       ├ screens registry        · tab selector → scope header         ▼
       │   (pure client,         · clamp q / limit / kinds        WorkspaceSearchService
       │    built from ROUTES)   · no-store                       (@ever-works/agent)
       │                                                               │
       └ remote results ◄────────────── JSON ◄───────────────────────  ├─ P2: index read
                                                                       │    search_index_entries
       recents:                                                        │        │ miss / disabled
         P1 localStorage                                               │        ▼
         P2 GET/POST /api/workspace-search/recents ────────────────►   └─ P1: live fan-out
                                                                            10 scoped repo reads
                                                                            (portable LOWER LIKE)

  MAINTENANCE (P2)
     entity write ─► SearchIndexSubscriber ─► mark STALE / TOMBSTONE ─► WORKSPACE_SEARCH_INDEX_DISPATCHER
                                                                                    │
     cron every 15 min ─► workspace-search-reconcile.task ──────────────────────────┘
                          (job-runtime provider; Constitution IV)
```

**The seam.** The browser never calls the Nest API directly; it calls the Next route handler,
which is the only place the auth cookie and the workspace selector are resolved. The Nest
controller is a thin shell over an agent-package service, exactly like Schedules. The service
has **two interchangeable back ends behind one method** — live fan-out (P1) and index read
(P2) — so P2 swaps the ranker without changing a single wire contract. That is the same
"swap the ranker behind a stable contract" move the Knowledge-Base search proxy already
documents.

**Why the index is P2 and not P1.** P1 must be shippable and green on its own. Fan-out over
ten scoped repository reads is correct, needs no schema change, and is well within FR-38's
600 ms budget for realistic workspaces. The index buys the 250 ms budget, cross-kind ranking
without materialising every candidate, and O(1) cost per additional kind — all of which matter
only once the P1 surface exists and is used.

---

## 3. Data model

### 3.1 P1 — no schema change at all

P1 reads existing columns through existing repositories. Zero new tables, zero new columns,
zero enum members, **no migration**.

### 3.2 P2 — two new tables

Both are Tier A/C-shaped (they declare **both** `tenantId` and `organizationId`), so the
existing scope-stamping subscriber fills them on insert automatically.

**`search_index_entries`** — new entity `SearchIndexEntry`, file
`packages/agent/src/entities/search-index-entry.entity.ts`.

| Column                    | Type          | Null | Notes                                                                                                                                                                      |
| ------------------------- | ------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | uuid PK       | no   |                                                                                                                                                                            |
| `userId`                  | uuid          | no   | owning user; every read filters on it                                                                                                                                      |
| `tenantId`                | uuid          | yes  | scope (subscriber-stamped)                                                                                                                                                 |
| `organizationId`          | uuid          | yes  | scope (subscriber-stamped)                                                                                                                                                 |
| `kind`                    | varchar(32)   | no   | `mission` \| `task` \| `agent` \| `work` \| `idea` \| `skill` \| `team` \| `knowledge` \| `run` \| `decision` \| `memory` \| `goal` \| `meeting` \| `node` \| `connection` |
| `sourceId`                | varchar(64)   | no   | primary key of the source row                                                                                                                                              |
| `workId`                  | uuid          | yes  | set for Work-scoped kinds; drives the membership filter (FR-33)                                                                                                            |
| `displayName`             | varchar(320)  | no   | the string ranked at scores 100/90/80/65/25                                                                                                                                |
| `displayNameFolded`       | varchar(320)  | no   | lower-cased, diacritics folded at write time (spec §9 open question)                                                                                                       |
| `identifier`              | varchar(160)  | yes  | slug / reference; scores 100/60                                                                                                                                            |
| `secondaryText`           | varchar(1024) | yes  | description / path / tag list, truncated; scores 40                                                                                                                        |
| `statusLabel`             | varchar(64)   | yes  | rendered as the row badge                                                                                                                                                  |
| `destination`             | varchar(512)  | no   | the route the row opens                                                                                                                                                    |
| `sourceUpdatedAt`         | timestamptz   | no   | drives the +5 freshness boost and the tie-break                                                                                                                            |
| `indexState`              | varchar(16)   | no   | `current` \| `stale` \| `tombstoned` (spec §5.2A)                                                                                                                          |
| `indexedAt`               | timestamptz   | no   | last successful refresh; the freshness metric reads this                                                                                                                   |
| `createdAt` / `updatedAt` | timestamptz   | no   | repo convention                                                                                                                                                            |

Indexes:

- `UNIQUE (kind, sourceId)` — the identity of a projection row.
- `(userId, organizationId, kind, indexState)` — the hot read path.
- `(userId, organizationId, displayNameFolded)` — prefix scans.
- `(indexState, indexedAt)` — the reconcile sweep and the tombstone sweep.

**`workspace_search_recents`** — new entity `WorkspaceSearchRecent`, file
`packages/agent/src/entities/workspace-search-recent.entity.ts`.

| Column                        | Type        | Null | Notes                      |
| ----------------------------- | ----------- | ---- | -------------------------- |
| `id`                          | uuid PK     | no   |                            |
| `userId`                      | uuid        | no   |                            |
| `tenantId` / `organizationId` | uuid        | yes  | scope (subscriber-stamped) |
| `kind`                        | varchar(32) | no   | same vocabulary as above   |
| `sourceId`                    | varchar(64) | no   |                            |
| `openedAt`                    | timestamptz | no   | ordering key               |
| `createdAt` / `updatedAt`     | timestamptz | no   |                            |

Indexes: `UNIQUE (userId, organizationId, kind, sourceId)` (so a repeat open is an update, not
a duplicate — FR-27) and `(userId, organizationId, openedAt DESC)`.

No content is stored here: display name and destination are re-resolved from the index at read
time, so a renamed record shows its new name in Recent and a deleted one simply drops out.

### 3.3 The migration (Constitution V, program rule #6)

One forward-only migration, in the **same PR** as the entities:

```
apps/api/src/migrations/1791010000000-AddWorkspaceSearchIndex.ts
```

The timestamp is AW-01 slot 00 of the program's reserved migration blocks ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)); the
implementing PR rebases on `develop` and re-stamps it before merge if a newer migration has landed.

> **Path note.** The epic brief pointed at `packages/agent/src/migrations/`. That directory
> does not exist in this repo. Migrations live in `apps/api/src/migrations/` (newest on `develop`
> at time of writing: `1790100000000-AddReleaseVerification.ts`) and are self-applied on API boot via TypeORM's
> `migrationsRun`. The entity files live in `packages/agent/src/entities/`; the migration lives
> with the API. This plan follows the repo.

Rules the migration follows, copied from `1789100000000-AddTaskGraphFanout.ts`:

- **Additive only.** Two `CREATE TABLE`s and their indexes. No `ALTER`, no `DROP`, no data
  movement on any existing table.
- **Existence-guarded** (`getTable(...)` before create) so a partially applied database
  converges.
- **Portable DDL** via TypeORM's `Table` / `TableIndex` objects rather than raw SQL, because
  CI and the e2e stack run `better-sqlite3` while production runs Postgres.
- A `down()` that drops exactly the two tables it created — safe, because they hold only
  derived data (the index is a cache; Recent degrades to the per-browser fallback).

Also required in the same PR, or CI reds on the drift specs:

- `packages/agent/src/entities/index.ts` — barrel export.
- `packages/agent/src/database/_entities-inventory.ts` — concrete import + `ENTITIES` entry.
- `packages/agent/src/database/_entity-names.ts` — the two class names.
- `packages/agent/src/entities/__tests__/tier-c.tenants-orgs.spec.ts` — both tables added to
  the Tier C expectation list (they declare both scope columns).

---

## 4. API

### 4.1 `GET /api/workspace-search`

- **Controller:** `apps/api/src/workspace-search/workspace-search.controller.ts`
- **Module:** `apps/api/src/workspace-search/workspace-search.module.ts`, registered in
  `apps/api/src/api.module.ts` alongside `SchedulesModule` (line ~224).
- **Auth:** the global session guard + `@CurrentUser()`; `@ApiTags('Workspace Search')`,
  `@ApiBearerAuth('JWT-auth')`.
- **Scope:** `ScopeContextService` (globally provided by `ScopeModule`) — `userId` always;
  `organizationId = active` when an Organization is active; `organizationId IS NULL` in
  personal scope. Isolation is structural: every source query filters `userId`, so there is no
  cross-user path to guard against (FR-31/FR-32).
- **Throttle:** `@Throttle({ long: { limit: 120, ttl: 60_000 } })` (FR-35).

Query DTO — `apps/api/src/workspace-search/dto/workspace-search-query.dto.ts`:

| Param          | Type            | Default | Validation                                                        |
| -------------- | --------------- | ------- | ----------------------------------------------------------------- |
| `q`            | string          | —       | required, trimmed, 2–128 chars; longer is truncated, not rejected |
| `kinds`        | repeated string | all     | each must be a known kind; unknown values are ignored, not 400    |
| `limit`        | int             | 60      | 1–60 total                                                        |
| `perKindLimit` | int             | 5       | 1–25 (FR-17)                                                      |

Response — `packages/contracts/src/api/workspace-search/`:

```ts
export type WorkspaceSearchKind =
	| 'mission'
	| 'task'
	| 'agent'
	| 'work'
	| 'idea'
	| 'skill'
	| 'team'
	| 'knowledge'
	| 'run'
	| 'decision'
	| 'memory'
	| 'goal'
	| 'meeting'
	| 'node'
	| 'connection';

export type WorkspaceSearchMatchReason =
	| 'exact'
	| 'prefix'
	| 'wordPrefix'
	| 'contains'
	| 'identifier'
	| 'secondary'
	| 'fuzzy';

export interface WorkspaceSearchHit {
	id: string; // `${kind}:${sourceId}` — stable client key
	kind: WorkspaceSearchKind;
	sourceId: string;
	title: string;
	subtitle: string | null; // breadcrumb / owner / path
	statusLabel: string | null;
	destination: string; // locale-agnostic app route
	score: number; // 0..100 (spec FR-14)
	matchReason: WorkspaceSearchMatchReason;
	updatedAt: string | null; // ISO 8601
}

export interface WorkspaceSearchGroup {
	kind: WorkspaceSearchKind;
	total: number; // matches before the per-kind cap — drives "Show all {n}"
	hits: WorkspaceSearchHit[];
}

export interface WorkspaceSearchResponse {
	query: string;
	groups: WorkspaceSearchGroup[];
	degradedKinds: WorkspaceSearchKind[]; // FR-37 → spec §6.8 partial-failure footer
	servedBy: 'index' | 'fanout' | 'mixed'; // FR-40 observability
	tookMs: number;
}
```

`degradedKinds` is what turns a silent zero-result group into the honest "Some results
couldn't be loaded" footer. Without it the client cannot tell "no matches" from "that source
threw", which is exactly the failure the Ideas-search regression taught us to make visible.

### 4.2 `…/recents` (P2)

| Method   | Path                                            | Body / params              | Returns                                                                                                                    |
| -------- | ----------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/workspace-search/recents`                 | `limit` (1–12, default 12) | `{ items: WorkspaceSearchHit[] }` — resolved through the index, so renamed rows show new names and deleted rows are absent |
| `POST`   | `/api/workspace-search/recents`                 | `{ kind, sourceId }`       | `204`; upsert on `(userId, organizationId, kind, sourceId)`, trims to 12                                                   |
| `DELETE` | `/api/workspace-search/recents/:kind/:sourceId` | —                          | `204`; used by FR-29's self-heal                                                                                           |

Throttle: `{ long: { limit: 240, ttl: 60_000 } }` on `POST` (one write per opened row).

### 4.3 Endpoints deliberately **not** created

P3's state-changing commands (FR-23) add **no** endpoints. They call what already exists:

| Command                | Existing endpoint                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Pause / Resume Agent   | `POST /api/agents/:id/pause` · `/resume` ([`agents.controller.ts`](../../../../../apps/api/src/agents/agents.controller.ts))            |
| Run Agent now          | `POST /api/agents/:id/run-now`                                                                                                          |
| Pause / Resume Mission | `POST /api/me/missions/:id/pause` · `/resume` ([`missions.controller.ts`](../../../../../apps/api/src/missions/missions.controller.ts)) |
| Run Work schedule now  | `POST /api/works/:id/schedule/run`                                                                                                      |
| Run Task               | `POST /api/tasks/:id/run` ([`tasks.controller.ts`](../../../../../apps/api/src/tasks/tasks.controller.ts))                              |

---

## 5. Web

### 5.1 New agent-package module

```
packages/agent/src/workspace-search/
  index.ts
  workspace-search.module.ts
  workspace-search.service.ts        # the two-backend orchestrator
  workspace-search.types.ts          # scope, filters, hit view
  ranking.ts                         # pure, exported, exhaustively unit-tested (FR-14/15)
  fold.ts                            # lower-case + diacritic folding (pure)
  sources/                           # one file per kind, all P1 fan-out sources
    mission.source.ts  task.source.ts  agent.source.ts  work.source.ts
    idea.source.ts  skill.source.ts  team.source.ts  knowledge.source.ts
  index-maintainer.service.ts        # P2 — projects a source row into the index
  index-reconcile.service.ts         # P2 — sweep + tombstone GC
  workspace-search-index.dispatcher.ts  # P2 — DI symbol + producer interface
  __tests__/
```

Add `"./workspace-search"` to `packages/agent/package.json` `exports` (the package already
declares 53 sub-path exports; `./schedules` is the closest sibling).

`ranking.ts` is deliberately a **pure module with no NestJS and no TypeORM**: FR-14's table and
FR-15's tie-breaks are then testable as a table-driven unit spec with no database at all, and
the same function ranks both back ends so P1 and P2 cannot disagree about order.

Each `sources/*.source.ts` exports one function with an identical signature — take the scope,
the folded query and a cap, return candidate rows — so adding a kind is one file plus one
registry line, and `WorkspaceSearchService` wraps each call in its own `try/catch` that pushes
the kind onto `degradedKinds` (the `SchedulesService` per-source-guard pattern).

### 5.2 Next.js BFF route

```
apps/web/src/app/api/workspace-search/route.ts            # GET
apps/web/src/app/api/workspace-search/recents/route.ts    # GET, POST  (P2)
```

Both wrapped in `bffProxy(handler)` with the default `scope: 'workspace'` — **never**
`scope: 'none'`. The palette always runs inside a workspace, so a missing selector is a bug
that must fail closed with 400 rather than silently answering from personal scope. The `GET`
handler clamps `limit`/`perKindLimit`, short-circuits `q.length < 2` to an empty payload
without touching upstream (FR-9 enforced on both sides), and forwards with `cache: 'no-store'`.

### 5.3 Components

```
apps/web/src/components/command-palette/
  CommandPalette.tsx            # the cmdk dialog; owns query, selection, filter chip, states
  CommandPaletteProvider.tsx    # open/close context so any component can open it
  CommandPaletteTrigger.tsx     # the top-bar "Search…  ⌘K" control (FR-3)
  PaletteGroup.tsx              # group header + rows + "Show all {n}"
  PaletteRow.tsx                # icon · title · subtitle · badge · disabled reason
  PaletteFooter.tsx             # keyboard hints + degraded/timeout/offline/throttled banner
  PaletteConfirm.tsx            # FR-23 inline confirmation step
  registry/
    screens.ts                  # built from ROUTES; title + breadcrumb + optional predicate
    commands.ts                 # the P1 command list (FR-22)
    commands-stateful.ts        # P3 confirming commands (FR-23)
    types.ts
  hooks/
    use-workspace-search.ts     # debounce 150ms · AbortController · 3.5s timeout · offline
    use-palette-recents.ts      # P1 localStorage → P2 server, with the local fallback kept
    use-palette-keyboard.ts     # FR-41 key map, incl. skipping disabled rows
```

**Mount point.** `<CommandPaletteProvider>` wraps the shell body inside `ChatProvider` in
[`layout-client.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/layout-client.tsx>);
`<CommandPalette />` renders as a sibling of `<HelpDrawer />` (line ~528) so it is above
everything and outside `<main>`'s scroll container. `useKeyboardShortcuts` gains an
`onOpenPalette` option and the layout passes the provider's opener — mirroring exactly how
`onOpenHelp` is threaded today.

**State and data fetching.** All client-side; no server components, no server actions. The
query lives in `CommandPalette`; `use-workspace-search` owns the debounce, a single
`AbortController` (FR-10/FR-18), a 3 500 ms timer (FR-11), a `navigator.onLine` check
(FR-13/S-13), and a "last good results" buffer so a timeout or a throttle can keep the
previous rows on screen. Screens and Commands are computed synchronously from the registries
and filtered in-process, which is why the palette is useful before any network call resolves.

`use-palette-recents` reads/writes `localStorage['workspace-search-recents']` in P1 — every
access wrapped in `try/catch`, following the precedent set by the theme hook and the
job-runtime banner, both of which document real browsers that throw on storage access. In P2
the hook prefers the server list and keeps the local list as the offline fallback (FR-30);
neither path may ever throw into render.

**Screens registry.** Derived from `ROUTES` so a renamed path cannot drift:

- One entry per navigable dashboard screen, `{ id, titleKey, breadcrumbKeys, href, predicate? }`.
- `predicate` hides an entry the current user cannot reach (e.g. admin screens for
  non-platform-admins) — FR-20.
- `ROUTES.DASHBOARD_NOTIFICATIONS` is **excluded** with an inline comment, because
  `constants.ts` documents it as a dead route that soft-404s; the registry points at
  `DASHBOARD_SETTINGS_NOTIFICATIONS` instead.
- A unit spec asserts every registry `href` is either a literal `ROUTES` value or produced by a
  `ROUTES` builder, so the registry cannot fall out of sync silently.

### 5.4 Header and shortcuts wiring

- `DashboardHeader.tsx` — insert `<CommandPaletteTrigger />` between `<WorkSwitcher />` and the
  right-hand cluster. No existing element moves out of the header.
- `use-keyboard-shortcuts.ts` — add `onOpenPalette`; `Ctrl/Cmd+K` calls it instead of pushing
  `/works?focus=search`; add the `/` binding under the existing input-field guard. `C` and `?`
  keep their current behaviour byte-for-byte.
- `HelpDrawer.tsx` — the Shortcuts tab renders the new rows. Keys `shortcuts.search`,
  `shortcuts.newWork`, `shortcuts.help` are **kept** (values updated where they now lie);
  new sibling keys are added for the palette bindings.

---

## 6. Background work (Constitution IV)

Nothing in P1 runs in the background. P2 adds exactly two jobs, both dispatched through the
job-runtime provider abstraction — call sites depend only on the DI symbol and never import a
third-party SDK.

**a. `workspace-search-index-refresh`** — one-shot fan-out.

- Producer interface + symbol: `packages/agent/src/workspace-search/workspace-search-index.dispatcher.ts`
  exporting `WORKSPACE_SEARCH_INDEX_DISPATCHER` and `WorkspaceSearchIndexDispatcher`
  (`dispatchIndexRefresh(payload): Promise<string | null>`), modelled on
  `KB_REEMBED_WORK_DISPATCHER`.
- Task: `packages/tasks/src/tasks/trigger/workspace-search-index-refresh.task.ts`, registered in
  `packages/tasks/src/tasks/trigger/index.ts`.
- Payload: `{ kind, sourceIds: string[], userId }` — batched, max 200 ids per dispatch.
- Producer: a TypeORM entity subscriber
  (`packages/agent/src/workspace-search/search-index.subscriber.ts`) that, on insert/update/
  soft-delete of any indexed entity, marks the projection `stale`/`tombstoned` **synchronously**
  (a single cheap `UPDATE`) and then dispatches the refresh. Marking first is what makes
  FR-39's 60 s p95 a _freshness_ promise and not a _correctness_ one: a stale row is still
  returned with its old title, and a tombstoned row is immediately invisible, even if the job
  never runs.
- Dispatch failures are swallowed and logged; the reconcile sweep is the safety net.

**b. `workspace-search-reconcile`** — scheduled sweep.

- Task: `packages/tasks/src/tasks/trigger/workspace-search-reconcile.task.ts`,
  `schedules.task({ id: 'workspace-search-reconcile', cron: '*/15 * * * *' })`, plus a nightly
  full pass at `'23 4 * * *'` (offset from the existing 03:17 / 03:42 / 04:00 crons so the four
  do not collide on the database).
- Body: `withWorkerContext('WorkspaceSearchReconcile', …)` → `IndexReconcileService.reconcile()`
  which (1) refreshes every `stale` row older than 60 s, (2) hard-deletes `tombstoned` rows
  older than 24 h, (3) on the nightly pass, walks each source table for rows with no projection
  and back-fills them, (4) deletes `workspace_search_recents` rows older than 90 days (FR-28),
  and (5) returns counters.
- Mutual exclusion across overlapping ticks: `DistributedTaskLockService`, since the sweep owns
  no single row to `UPDATE … WHERE` against.

---

## 7. Plugin boundaries

- **No new external integration.** Search is entirely over the platform's own database and the
  web app's own registries. Constitution I is not engaged by a new plugin package because there
  is nothing external to integrate.
- **The `connection` kind (P2) touches no plugin id.** The Connections group asks the existing
  plugin registry / capability facade for "the plugins installed for this scope" and renders
  whatever comes back. There is **no** hardcoded plugin identifier anywhere in
  `packages/agent/src/workspace-search/` or `apps/web/src/components/command-palette/`
  (Constitution II). A unit spec greps the epic's own source tree for known plugin ids and
  fails if one appears.
- **No plugin is ever invoked by a search.** In particular the palette never calls the
  web-search capability; `/api/search` and `/api/workspace-search` are disjoint (§1.4).

---

## 8. i18n

One new namespace, `dashboard.commandPalette`, in
[`apps/web/messages/en.json`](../../../../../apps/web/messages/en.json), then mirrored into the 20
sibling locale files (`ar, bg, de, es, fr, he, hi, id, it, ja, ko, nl, pl, pt, ru, th, tr, uk,
vi, zh`). **Every leaf key name is camelCase and contains no literal `.`** — a leaf name with a
dot is rejected at runtime and reds several e2e shards at once.

```
dashboard.commandPalette
  trigger                 "Search…"
  triggerHintMac          "⌘K"
  triggerHintOther        "Ctrl K"
  dialogLabel             "Search and commands"
  placeholder             "Search or type a command…"
  clearQuery              "Clear search"
  groups
    recent · suggested · commands · screens · missions · tasks · agents · works
    ideas · skills · teams · knowledge · runs · decisions · memory · goals
    meetings · computers · connections
  showAll                 "Show all {count}"
  filteredHeader          "{group} · showing {shown} of {total}"
  openFullList            "Open the {group} screen for the full list"
  loading                 "Searching…"
  tooShort                "Keep typing — 2 characters minimum."
  announceResults         "{count} results"
  noResults
    title                 "No matches for “{query}”"
    hint                  "Try a shorter word, or one of these:"
    askChat               "Ask the AI chat panel about “{query}”"
    createTask            "Create a Task from “{query}”"
    openHelp              "Open Help"
  banner
    partial               "Some results couldn't be loaded. Showing what we have."
    timeout               "Search took too long. Press Enter to try again."
    offline               "You're offline. Showing recent items only."
    throttled             "Too many searches. Try again in a moment."
  gone                    "That {kind} no longer exists. It's been removed from Recent."
  linkCopied              "Link copied"
  disabledOwnerOnly       "Needs owner access"
  footer
    navigate · open · newTab · filterGroup · removeFilter · close
  commands
    newMission · newIdea · newWork · newTask · newAgent · newTeam · newSkill
    newGoal · newMeeting · searchWorks · openHelp · keyboardShortcuts
    toggleTheme · collapseSidebar · expandSidebar · openChat · closeChat
    copyPageLink · switchWorkspace · switchWork · signOut
    pauseAgent · resumeAgent · runAgentNow · pauseMission · resumeMission
    runWorkSchedule · runTask
  commandAliases
    (one string per command; comma-separated aliases, translated — FR-25)
  confirm
    pauseAgentTitle · pauseAgentBody · cancel · confirm
```

Also changed — **values only, keys preserved** (spec §6.12):
`dashboard.header.help.shortcuts.search` from `"Search works"` to `"Open search & commands"`,
plus new sibling keys `shortcuts.palette`, `shortcuts.paletteSlash`, `shortcuts.paletteNavigate`,
`shortcuts.paletteFilter`.

Screen titles for the Screens registry reuse the **existing** `dashboard.sidebar.navigation.*`
and `metadata.pages.*` keys wherever one already exists; only genuinely unnamed sub-pages get a
new key under `dashboard.commandPalette.screens`.

---

## 9. Telemetry and failure modes

### 9.1 Analytics (PostHog)

Client events via `posthog-js` (already initialised in
[`PostHogProvider.tsx`](../../../../../apps/web/src/components/posthog/PostHogProvider.tsx));
server events via `AnalyticsService`
([`packages/monitoring/src/services/analytics.service.ts`](../../../../../packages/monitoring/src/services/analytics.service.ts)),
following the typed-helper shape of `packages/monitoring/src/posthog/kb-events.ts`.

| Event                                | Properties                                                                               | Why                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `workspace_search_palette_opened`    | `source: shortcut \| trigger \| slash`                                                   | Is `/` (spec §9 open question) actually used? Is the trigger discoverable? |
| `workspace_search_query_settled`     | `queryLength`, `resultCount`, `groupCount`, `latencyMs`, `servedBy`, `degradedKindCount` | The FR-38 budget and the FR-40 fallback rate                               |
| `workspace_search_result_opened`     | `kind`, `rank`, `score`, `matchReason`, `hadQuery`, `fromRecent`                         | Is ranking right? Do users pick rank 1?                                    |
| `workspace_search_command_run`       | `commandId`, `requiredConfirm`, `confirmed`                                              | Which commands earn their place                                            |
| `workspace_search_no_results`        | `queryLength`                                                                            | The gap between what users look for and what we index                      |
| `workspace_search_source_degraded`   | `kind`, `reason` (server)                                                                | Per-kind reliability                                                       |
| `workspace_search_index_lag_seconds` | p50/p95/max (server, from the reconcile job)                                             | The FR-39 60 s promise                                                     |

**The raw query string is never sent** (FR-36) — only its length. This is enforced by the event
helper's own types (the payload type has no query field to put it in) and asserted by a unit
spec, the same defensive shape `kb-events.ts` already uses for body-like fields.

### 9.2 Errors (Sentry)

Endpoint failures are captured with a `kind` tag so a single misbehaving source is
distinguishable from a whole-endpoint outage. Per-source `try/catch` failures are captured at
`warning` level with the kind and the driver error code — not `error`, because the request
still succeeded from the user's point of view. Repeated same-kind degradation is what should
page someone, not one occurrence.

### 9.3 Failure modes and the chosen behaviour

| Failure                                     | Behaviour                                                                   | Where specified |
| ------------------------------------------- | --------------------------------------------------------------------------- | --------------- |
| One source query throws                     | Kind omitted, listed in `degradedKinds`, footer banner                      | FR-37 / S-11    |
| Whole endpoint 5xx                          | Keep last good results, show the timeout banner, `Enter` retries            | S-12            |
| Request > 3 500 ms                          | Client aborts → same as above                                               | FR-11           |
| Throttled (429)                             | Banner + 5 s client-side pause                                              | FR-35           |
| Browser offline                             | No request; Recent + Commands only                                          | FR-13 / S-13    |
| Storage access throws                       | Recent is empty; palette renders normally                                   | FR-30           |
| Index unavailable / kind not indexed        | Silent fallback to fan-out; `servedBy` records it                           | FR-40           |
| Index stale                                 | Stale title shown, row still opens correctly                                | §5.2A `STALE`   |
| Target deleted after indexing               | Tombstoned → never returned; if reached via Recent, self-heals with a toast | FR-29 / S-14    |
| Scope changes mid-query                     | In-flight request aborted, query re-run in the new scope                    | S-17            |
| Missing workspace selector on the BFF route | 400, fail closed                                                            | §5.2            |

---

## 10. Test plan (Constitution VI)

### 10.1 Unit — agent package (Jest)

| File                                                                                                    | Covers                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/src/workspace-search/__tests__/ranking.spec.ts`                                         | Every FR-14 score band; both boosts and the 100 cap; every FR-15 tie-break, including the promote-a-100-group rule                                                                                                                      |
| `packages/agent/src/workspace-search/__tests__/fold.spec.ts`                                            | Case folding, diacritic folding, non-Latin pass-through, empty/whitespace input                                                                                                                                                         |
| `packages/agent/src/workspace-search/__tests__/workspace-search.service.spec.ts`                        | Fan-out over all P1 sources; per-source cap; a throwing source lands in `degradedKinds` and does not fail the call; group ordering; total cap; a query matching a Mission and a Task yields two distinct groups, never one merged group |
| `packages/agent/src/workspace-search/__tests__/workspace-search.scope.spec.ts`                          | `userId` always filtered; Organization filter when active; `organizationId IS NULL` in personal scope; Knowledge restricted to member Works                                                                                             |
| `packages/agent/src/workspace-search/__tests__/workspace-search.sqlite-portability.integration.spec.ts` | The whole fan-out runs on an in-memory `better-sqlite3` DataSource with `PRAGMA case_sensitive_like = ON` — the harness from the Ideas portability spec. Asserts no emitted SQL contains a Postgres-only operator                       |
| `packages/agent/src/workspace-search/__tests__/no-hardcoded-plugin-ids.spec.ts`                         | Constitution II: the epic's source tree contains no known plugin identifier                                                                                                                                                             |
| `packages/agent/src/workspace-search/__tests__/index-maintainer.service.spec.ts` (P2)                   | Insert → `current`; update → `stale` then refreshed; delete → `tombstoned`; a `tombstoned` row is never returned                                                                                                                        |
| `packages/agent/src/workspace-search/__tests__/index-reconcile.service.spec.ts` (P2)                    | Stale refresh; 24 h tombstone GC; 90-day Recent GC; back-fill of missing projections; counter summary                                                                                                                                   |
| `packages/agent/src/entities/__tests__/tier-c.tenants-orgs.spec.ts` (extend)                            | Both new tables are recognised as scope-stamped                                                                                                                                                                                         |

### 10.2 Controller spec — API (Jest)

| File                                                                             | Covers                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/workspace-search/workspace-search.controller.spec.ts`              | Auth guard; `q` under 2 chars → empty, no service call; `limit`/`perKindLimit` clamping; unknown `kinds` ignored not 400; scope threaded from `ScopeContextService`; throttle metadata present; response shape matches the contract |
| `apps/api/src/workspace-search/workspace-search-recents.controller.spec.ts` (P2) | `GET` cap of 12; `POST` upsert-not-duplicate; `DELETE` removes; every route scoped by `userId`                                                                                                                                      |

### 10.3 Unit — web (Vitest)

| File                                                                              | Covers                                                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/command-palette/CommandPalette.unit.spec.tsx`            | All render states: empty, too-short, loading, results, filtered, no-results, partial, timeout, offline, throttled, confirm         |
| `apps/web/src/components/command-palette/hooks/use-palette-keyboard.unit.spec.ts` | The whole FR-41 key map, including skipping disabled rows and `Esc`'s three-step precedence                                        |
| `apps/web/src/components/command-palette/hooks/use-workspace-search.unit.spec.ts` | 150 ms debounce; 2-char floor; abort-on-newer; out-of-order response discarded; 3.5 s timeout; offline short-circuit               |
| `apps/web/src/components/command-palette/hooks/use-palette-recents.unit.spec.ts`  | 12-row cap; move-to-top on repeat; a throwing storage API does not throw into render                                               |
| `apps/web/src/components/command-palette/registry/screens.unit.spec.ts`           | Every href traces to `ROUTES`; the dead notifications route is absent; predicates hide unreachable screens                         |
| `apps/web/src/components/command-palette/registry/commands.unit.spec.ts`          | Every command has ≥ 2 aliases, a translation key, and a permission predicate; every state-changing command declares a confirmation |
| `apps/web/src/lib/hooks/use-keyboard-shortcuts.unit.spec.ts`                      | `Ctrl/Cmd+K` calls `onOpenPalette` and does not navigate; `/` fires only outside text fields; `C` and `?` unchanged                |
| `apps/web/src/app/api/workspace-search/route.unit.spec.ts`                        | `bffProxy` scope wiring; 400 without a selector; clamping; short-circuit on `q.length < 2`; upstream error passthrough             |

### 10.4 E2E (Playwright, `apps/web/e2e/`)

| File                                                   | Covers                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/e2e/command-palette.spec.ts`                 | Golden path: `Ctrl+K` from three different screens → type → grouped results (a term seeded on both a Mission and a Task shows a `Missions` group and a `Tasks` group) → `Enter` navigates; the top-bar trigger opens the same overlay; `Esc` restores focus |
| `apps/web/e2e/command-palette-keyboard.spec.ts`        | Arrow/Home/End/Tab/Shift+Tab/`Ctrl+Enter`/`Ctrl+1..9`; `/` inside vs outside a text field; `Ctrl+K` inside the chat composer inserts nothing                                                                                                                |
| `apps/web/e2e/command-palette-commands.spec.ts`        | `new task` and `new mission` reach their own creation screens; `help` opens the drawer without navigating; `Search Works` reaches the Works list with its filter focused (the preserved legacy path, FR-4)                                                  |
| `apps/web/e2e/command-palette-recents.spec.ts`         | Open two records → reopen the palette → both in Recent, newest first, no duplicate on re-open                                                                                                                                                               |
| `apps/web/e2e/command-palette-scope-isolation.spec.ts` | Seed a Mission in Organization B; search in Organization A → absent; switch scope → present (S-16)                                                                                                                                                          |
| `apps/web/e2e/command-palette-degraded.spec.ts`        | Route-level fault injection: one kind fails → other groups render + banner; endpoint held past 3.5 s → prior results dimmed + timeout banner; offline → local-only                                                                                          |
| `apps/web/e2e/command-palette-a11y.spec.ts`            | Accessibility audit on the open palette in both themes; focus trap; combobox/listbox roles; polite result-count announcement                                                                                                                                |

Existing `apps/web/e2e/keyboard-shortcuts.spec.ts` currently asserts only that `Ctrl+K` and `/`
do not break the page. Those assertions stay true and are **not** loosened; the new specs assert
the real behaviour on top.

---

## 11. Phasing

Each phase is one or two PRs against `develop`, ships independently, and leaves `develop` green.

### P1 — The palette, live fan-out, no schema change _(the whole user-visible win)_

Contracts → agent `workspace-search` module (ranking, fold, 8 sources, service) → API
controller/module → BFF route → palette components + registries + hooks → header trigger →
shortcut re-binding → Help-drawer copy → i18n (en + 20 locales) → all P1 tests.

Ships FR-1 – FR-17, FR-18 (P1 kinds), FR-19 – FR-29 (Recent on local storage), FR-31 – FR-38,
FR-41 – FR-46. **No migration. No background job. No new entity.**

Suggested split: **PR 1** = contracts + agent module + API + BFF + backend tests;
**PR 2** = palette UI + registries + shortcuts + i18n + web/e2e tests. PR 1 is dead code until
PR 2 lands, which keeps each diff reviewable and each merge green.

### P2 — The index, server-side Recent, and the remaining kinds

Two entities + the forward-only migration + the three inventory files → maintainer/subscriber →
reconcile service → dispatcher symbol + two job-runtime tasks → service reads the index with a
fan-out fallback → 7 more kinds (FR-18 P2 rows) → recents endpoints → the client prefers the
server list.

Ships FR-18 (P2 kinds), FR-30, FR-39, FR-40 and the FR-38 250 ms budget. The wire contract does
not change; the client needs no coordinated release.

### P3 — Acting from the palette

`commands-stateful.ts` + `PaletteConfirm` + target-picker second step, wired to the **existing**
control endpoints (§4.3). Permission predicates render the disabled state (FR-24).

Ships FR-23 and FR-24's confirming half. No new endpoint, no schema change.

| Phase | Depends on             | New tables | New endpoints | New jobs |
| ----- | ---------------------- | ---------- | ------------- | -------- |
| P1    | —                      | 0          | 1             | 0        |
| P2    | P1 (service seam only) | 2          | 3             | 2        |
| P3    | P1                     | 0          | 0             | 0        |

---

## 12. Constitution compliance

| Gate                                                | Status | Justification                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I — Plugin-first**                                | ✅ n/a | No external integration is added. Search runs entirely over the platform's own database and the web app's own registries.                                                                                                                                               |
| **II — Capability-driven, no hardcoded plugin ids** | ✅     | The P2 `connection` kind resolves installed plugins through the existing registry/facade. A dedicated spec fails the build if a known plugin id appears in this epic's source tree.                                                                                     |
| **III — Source-of-truth repositories**              | ✅     | The palette indexes _platform metadata_ (names, titles, paths, destinations) only. A Work's generated items live in the user's repositories and are explicitly out of scope (spec §7.6).                                                                                |
| **IV — Job runtime**                                | ✅     | The only background work is P2's refresh + reconcile, both dispatched via `WORKSPACE_SEARCH_INDEX_DISPATCHER` and a `schedules.task` cron on the configured provider. No call site imports a third-party SDK.                                                           |
| **V — Forward-only migrations**                     | ✅     | P1 has no schema change. P2 ships `apps/api/src/migrations/1791010000000-AddWorkspaceSearchIndex.ts` in the same PR as the entities — two guarded `CREATE TABLE`s, no `ALTER`, no `DROP`, portable DDL, a `down()` that only drops what it created.                     |
| **VI — Tests are a prerequisite**                   | ✅     | §10: 9 agent unit/integration specs, 2 controller specs, 8 web unit specs, 7 e2e specs — including a SQLite portability spec that exists precisely because a previous search path shipped a Postgres-only operator.                                                     |
| **VII — Secrets**                                   | ✅     | FR-34: no secret-bearing column enters the read model or the index. FR-36: the raw query never reaches a log or an analytics event, enforced by the event payload's type.                                                                                               |
| **VIII — Plugin counts doc**                        | ✅ n/a | No plugin is added or removed; the canonical list is untouched.                                                                                                                                                                                                         |
| **IX — Behaviour-first spec**                       | ✅     | [spec.md](spec.md) contains no class name, file path or code. Every implementation detail lives here.                                                                                                                                                                   |
| **X — Backwards compatibility**                     | ✅     | `/api/workspace-search` is new and additive; no existing DTO field is renamed. The one behaviour change (`Ctrl/Cmd+K`) preserves its old destination as a named command and leaves the Works page's own entry point intact.                                             |
| **Program rule #1 — additive**                      | ✅     | Sidebar, Work switcher, both KB palettes, every list filter and every route survive untouched.                                                                                                                                                                          |
| **Program rule #2 — no duplicate nouns**            | ✅     | Two new records, both internal (Search Index Entry, Workspace Search Recent), justified in spec §5.2 and invisible to the user. Group labels are the program's own vocabulary — Missions, Tasks, Agents, Runs, My Decisions, Memory, Knowledge, Computers, Connections. |
| **Program rule #8 — i18n**                          | ✅     | §8: one namespace, camelCase leaves, no literal dot in any leaf name, 21 locale files.                                                                                                                                                                                  |
| **Program rule #9 — "what did it cost?"**           | ✅ n/a | The palette spends no money and no tokens: it issues database reads only and never invokes a model or a plugin.                                                                                                                                                         |
