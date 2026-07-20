# Dashboard Blocks — Implementation Plan

**Status:** Draft v1 · **Owner:** Engineering · **Date:** 2026-07-18
**Spec:** [spec.md](spec.md) · **Tasks:** [tasks.md](tasks.md)

> This plan is **additive**. Every step adds a card, a prop, a block, or an endpoint. No existing stat card, section, prop, route, or string is removed or renamed. The compaction step (Phase 1) is a pure markup swap inside one component. New props are optional with safe defaults so the current render path keeps working while the feature lands piecemeal.

Three phases, each shipping as one PR against `develop`. **P1 is independent** and can merge first. **P2** layers the Attention block. **P3** layers the Soon block and is gated on the Schedules front's `GET /api/schedules`.

---

## Phase 1 — Compact stat cards + Teams count card

**Goal:** Collapse every stat tile to a dense 2-line block, and add a 9th Teams tile that degrades gracefully when the Teams feature is not yet wired.

**Changes:**

1. `apps/web/src/components/dashboard/StatsOverview.tsx` — compaction (single file):
    - Rename the per-card object field `sublabel` → `qualifier` in the `statCards` type (`:88-89`) and both call sites (Agents `:151`, Tasks `:161-164`).
    - Replace the tile markup (`:171-217`) with the 2-line target from [spec.md §4.2](spec.md#42-change-2--compact-2-line-cards-statsoverviewtsx171-217): line 1 `[icon] [count]`, line 2 `[dot] {title}{qualifier ? ' (' + qualifier + ')' : ''}`. Delete the separate third-line `<p>`.
    - Density tweaks: `px-4 py-4` → `px-3 py-3`; `gap-2` → `gap-1.5`; value `text-2xl` → `text-xl`; icon box `w-8 h-8` → `w-7 h-7`; icon `w-4 h-4` → `w-3.5 h-3.5`.
    - Tasks qualifier: keep the `tasksBlocked > 0` branch → `{count} blocked`; when `0`, set `qualifier` undefined (render plain `Tasks in flight`, never `(no blockers)`).
2. `apps/web/src/components/dashboard/StatsOverview.tsx` — Teams tile:
    - Add `import { Users } from 'lucide-react'` (`:5-15`).
    - Add optional prop `teamsTotal?: number` to `StatsOverviewProps` (`:19-50`) and the destructure (`:64-76`) — no default (stays `undefined` when omitted).
    - Append a guarded `statCards` entry that only exists when `teamsTotal !== undefined` (see spec §4.1): `{ title: t('teams'), value: teamsTotal, icon: Users, dotColor: 'bg-teal-500', href: ROUTES.DASHBOARD_TEAMS, qualifier: t('teamsSubtitle') }`.
    - Keep grid at `@xl/main:grid-cols-4` (spec §4.1 option a).
3. `apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx`:
    - Add `teamsTotal?: number` to `DashboardClientProps` and pass it into `<StatsOverview>` (`:102-114`).
4. `apps/web/src/app/[locale]/(dashboard)/(home)/page.tsx`:
    - Add the Teams fetch to the `Promise.all` (`:47`), `.catch(() => undefined)` so a failure omits the card rather than showing a wrong 0:
        - `teamsAPI.listOrganizations().then((orgs) => Promise.all(orgs.map((o) => teamsAPI.list(o.id))).then((a) => a.flat().length)).catch(() => undefined)`
    - Import `teamsAPI` from `@/lib/api/teams`.
    - Pass `teamsTotal={teamsCount}` into `<DashboardClient>` (`:104-127`).
5. i18n: add `dashboard.stats.teams` = "Teams" and `dashboard.stats.teamsSubtitle` = "in your org" to `apps/web/messages/en.json` and all 21 locale files.

**Dependency handling (Teams / PR #1647):** if `teamsAPI` / `ROUTES.DASHBOARD_TEAMS` are not present on the branch at implementation time, land steps 1 + 5 (compaction) and the prop plumbing (steps 2-4 minus the fetch) now; wire the fetch (step 4) in a follow-up once PR #1647 merges. The guarded card means the grid is correct in both states.

**Out of scope this phase:** Attention, Soon, any new endpoint, any backend change (the backend `teamsCount` on `getAccessibleStats()` is an optional later optimization, not P1).

**Tests:**

- `StatsOverview` render test — 8 tiles when `teamsTotal` undefined, 9 tiles when defined; each tile is 2 lines; Agents renders `Agents (0 active)`; Tasks renders `Tasks in flight` with no qualifier when `tasksBlocked === 0` and `(2 blocked)` when `> 0`.
- Snapshot/visual check that no tile exceeds two text lines.

---

## Phase 2 — Attention block

**Goal:** Surface owner-scoped "needs action now" signals as red cards above the Missions list, rendered only when non-empty.

**Changes:**

1. New `apps/web/src/components/dashboard/AttentionSection.tsx` (client component):
    - Props `{ items: AttentionItem[] }`; returns `null` when empty.
    - Header mirrors `MissionsPreviewSection.tsx:72-110` (icon box + `text-xl font-semibold` h2), icon `AlertTriangle`, heading `t('dashboard.attention.title')`.
    - Cards use danger/warning tone tokens copied from `RecentTasks.tsx:11-27`; each card is a `<Link href={item.href}>`.
2. Type `AttentionItem` (+ `AttentionKind`) in a shared web location, e.g. `apps/web/src/lib/api/dashboard.ts` (new) or co-located in the component.
3. `page.tsx` — server-compose `attentionItems: AttentionItem[]` from:
    - add `agentsAPI.list({ status: 'error', limit: 5 })` to the `Promise.all` → `agent-error` items;
    - filter already-fetched `allIdeas` for `status === 'failed'` → `generation-failed` items;
    - fetch blocked task rows (`tasksAPI.list({ status: 'blocked', limit: 5 })` — the count is already fetched at `:79-81`; add the row fetch) → `task-blocked` items;
    - compare `accountWide.currentSpendCents` to the cap → `budget-exceeded` item (pending open question §9.4).
    - Sort `danger` before `warning`, then `occurredAt` desc; cap at ~6.
4. `dashboard-client.tsx` — add `attentionItems?: AttentionItem[]` (default `[]`) to props; render the conditional wrapper as the **first** child of the `divide-y` stack, before Missions (spec §4.5).
5. i18n: `dashboard.attention.title` = "Needs attention" + per-kind title/subtitle copy across all locale files.

**Consolidation follow-up (optional, same phase or next):** move the compose behind `GET /api/dashboard/attention` (NestJS controller under `apps/api/src/works` or a new `dashboard` module) returning `{ items: AttentionItem[] }`, owner-scoped via `@CurrentUser`, so schedule-derived signals (failed/paused schedules — not fetched by the home page today) join the same source. This removes the extra per-signal fetches from the page fan-out.

**Out of scope this phase:** Soon block; the schedule-failed / schedule-paused kinds require either the consolidation endpoint or a schedules fetch — defer to the endpoint follow-up rather than adding schedule fetches to `page.tsx`.

**Tests:**

- `AttentionSection` renders `null` for `[]`; renders danger cards before warning cards; each card links to `item.href`.
- `page.tsx` compose unit — given fixture agents(error)/proposals(failed)/tasks(blocked), produces the expected sorted `AttentionItem[]`.

---

## Phase 3 — Soon block (depends on the Schedules front)

**Goal:** Show the next 3 upcoming scheduled runs below Attention, reusing the Schedules front's aggregation.

**Changes:**

1. New `apps/web/src/components/dashboard/SoonSection.tsx` (client component):
    - Props `{ items: SoonRunItem[]; total: number }`; returns `null` when `items` is empty.
    - Header icon `CalendarClock`, heading `t('dashboard.soon.title')`.
    - Up to 3 rows `[title] [relative nextRunAt] [source chip]`, each a `<Link>` to the Work/Mission.
    - Footer `+{total - 3} more` → `/activity?view=schedules` when `total > 3`.
2. `page.tsx` — fetch `GET /api/schedules?status=active&sort=nextRunAt:asc&limit=3` via the Schedules front's web client (e.g. `schedulesAPI.list(...)`), `.catch(() => ({ items: [], total: 0 }))`. Map to `SoonRunItem[]` + `total`.
3. `dashboard-client.tsx` — add `soonItems?: SoonRunItem[]` (default `[]`) + `soonTotal?: number` (default `0`); render the conditional wrapper as the **second** child of the `divide-y` stack, after Attention and before Missions (spec §4.5).
4. i18n: `dashboard.soon.title` = "Coming up", `dashboard.soon.more` = "+{n} more" across all locale files.

**Hard dependency:** the Schedules front (`docs/specs/features/schedules/`, task #6) must ship `GET /api/schedules` (unifying `work_schedules` + scheduled `missions`, sortable by `nextRunAt`) and the `/activity?view=schedules` view. Until then, Soon resolves to empty and renders nothing — the page is unaffected.

**Tests:**

- `SoonSection` renders `null` for `[]`; renders ≤3 rows sorted by `nextRunAt`; shows `+{n} more` only when `total > 3`.
- `page.tsx` fetch degrades to empty (no throw) when the schedules endpoint is absent.

---

## Sequencing & risk

| Phase | Depends on      | Can merge before dependency?                                   |
| ----- | --------------- | -------------------------------------------------------------- |
| P1    | Teams PR #1647  | Yes — compaction ships now; Teams card auto-appears when wired |
| P2    | —               | Yes — self-contained (server compose from existing fetches)    |
| P3    | Schedules front | No — Soon has no data source until `GET /api/schedules` exists |

- **Lowest risk first:** P1 compaction is a contained markup change in one file; ship it and the Teams plumbing immediately.
- **No schema, no migration** in any phase — this feature is read-only over shipped entities.
- **Every new fetch is `.catch()`-defended** matching the existing home fan-out, so a flaky dependency degrades to "card/block omitted", never a broken home page.
