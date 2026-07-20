# Dashboard Blocks — Task Checklist

**Status:** Draft v1 · **Date:** 2026-07-18
**Spec:** [spec.md](spec.md) · **Plan:** [plan.md](plan.md)

Granular checklist agents and reviewers tick off as work lands. Grouped by the three phases in [plan.md](plan.md).

---

## Phase 1 — Compact stat cards + Teams count

### Compaction (`StatsOverview.tsx` — single file)

- [ ] Rename per-card field `sublabel` → `qualifier` in the `statCards` type (`:88-89`).
- [ ] Migrate Agents call site (`:151`): `sublabel` → `qualifier: t('agentsActive', { count })`.
- [ ] Migrate Tasks call site (`:161-164`): `qualifier: t('tasksBlocked', { count })` when `tasksBlocked > 0`, else `undefined` (render plain `Tasks in flight`, drop `tasksNoBlockers`).
- [ ] Replace tile markup (`:171-217`) with the 2-line target (spec §4.2): line 1 `[icon] [count]`; line 2 `[dot] {title}{qualifier ? ' (' + qualifier + ')' : ''}`.
- [ ] Delete the separate third-line sublabel `<p>` (`:211-215`).
- [ ] Density: `px-4 py-4`→`px-3 py-3`, `gap-2`→`gap-1.5`, value `text-2xl`→`text-xl`, icon box `w-8 h-8`→`w-7 h-7`, icon `w-4 h-4`→`w-3.5 h-3.5`.

### Teams card (`StatsOverview.tsx` + wiring)

- [ ] `import { Users } from 'lucide-react'` (`:5-15`).
- [ ] Add optional `teamsTotal?: number` to `StatsOverviewProps` (`:19-50`) + destructure (`:64-76`) — no default.
- [ ] Append guarded `statCards` entry (only when `teamsTotal !== undefined`): `{ title: t('teams'), value: teamsTotal, icon: Users, dotColor: 'bg-teal-500', href: ROUTES.DASHBOARD_TEAMS, qualifier: t('teamsSubtitle') }`.
- [ ] Keep grid `@xl/main:grid-cols-4` (spec §4.1 option a).
- [ ] `dashboard-client.tsx` — add `teamsTotal?: number` to `DashboardClientProps`; pass into `<StatsOverview>` (`:102-114`).
- [ ] `page.tsx` — import `teamsAPI` from `@/lib/api/teams`; add the Teams fetch to the `Promise.all` (`:47`) with `.catch(() => undefined)`; pass `teamsTotal` into `<DashboardClient>` (`:104-127`).

### i18n

- [ ] `apps/web/messages/en.json` — add `dashboard.stats.teams` = "Teams", `dashboard.stats.teamsSubtitle` = "in your org".
- [ ] Mirror both keys across the other 20 locale files (English fallback value).

### Tests

- [ ] `StatsOverview` — 8 tiles when `teamsTotal` undefined, 9 when defined.
- [ ] `StatsOverview` — every tile is exactly 2 lines; `Agents (0 active)`; `Tasks in flight` (no qualifier at 0 blocked), `Tasks in flight (2 blocked)` at >0.

### Dependency

- [ ] Teams (PR #1647): if `teamsAPI` / `ROUTES.DASHBOARD_TEAMS` absent, land compaction + prop plumbing now, wire the `page.tsx` fetch in a follow-up.

---

## Phase 2 — Attention block

### Types

- [ ] Add `AttentionItem` + `AttentionKind` (spec §2.2), e.g. in `apps/web/src/lib/api/dashboard.ts` (new).

### Component

- [ ] New `apps/web/src/components/dashboard/AttentionSection.tsx` (client) — props `{ items: AttentionItem[] }`; returns `null` when empty.
- [ ] Header mirrors `MissionsPreviewSection.tsx:72-110` (icon `AlertTriangle`, `text-xl font-semibold` h2, `t('dashboard.attention.title')`).
- [ ] Cards reuse danger/warning tones from `RecentTasks.tsx:11-27`; each card is a `<Link href={item.href}>`; danger before warning.

### Server compose (`page.tsx`)

- [ ] Add `agentsAPI.list({ status: 'error', limit: 5 })` to the `Promise.all` → `agent-error` items.
- [ ] Filter already-fetched `allIdeas` for `status === 'failed'` → `generation-failed` items.
- [ ] Add `tasksAPI.list({ status: 'blocked', limit: 5 })` row fetch → `task-blocked` items.
- [ ] Compare `accountWide.currentSpendCents` to cap → `budget-exceeded` (pending open question §9.4).
- [ ] Build `attentionItems`: sort danger-first then `occurredAt` desc, cap ~6.

### Client wiring (`dashboard-client.tsx`)

- [ ] Add `attentionItems?: AttentionItem[]` (default `[]`) to props.
- [ ] Render conditional wrapper `{attentionItems.length > 0 && (<div className="py-8 lg:py-10"><AttentionSection .../></div>)}` as the **first** child of the `divide-y` stack, before Missions (spec §4.5).

### i18n

- [ ] `dashboard.attention.title` = "Needs attention" + per-kind title/subtitle copy, all locale files.

### Consolidation follow-up (optional)

- [ ] `GET /api/dashboard/attention` — owner-scoped (`@CurrentUser`), returns `{ items: AttentionItem[] }` (≤10, danger-first), including schedule-failed / schedule-paused kinds. Move the compose behind it; drop the extra per-signal fetches from `page.tsx`.

### Tests

- [ ] `AttentionSection` renders `null` for `[]`; danger cards before warning; each links to `item.href`.
- [ ] Compose unit — fixtures produce expected sorted `AttentionItem[]`.

---

## Phase 3 — Soon block (depends on Schedules front)

### Component

- [ ] New `apps/web/src/components/dashboard/SoonSection.tsx` (client) — props `{ items: SoonRunItem[]; total: number }`; returns `null` when empty.
- [ ] Header icon `CalendarClock`, `t('dashboard.soon.title')`.
- [ ] Up to 3 rows `[title] [relative nextRunAt] [source chip]`, each a `<Link>` to the Work/Mission.
- [ ] Footer `+{total - 3} more` → `/activity?view=schedules` when `total > 3`.

### Data (`page.tsx`)

- [ ] Fetch `GET /api/schedules?status=active&sort=nextRunAt:asc&limit=3` via the Schedules front's web client; `.catch(() => ({ items: [], total: 0 }))`.
- [ ] Map to `SoonRunItem[]` + `total`.

### Client wiring (`dashboard-client.tsx`)

- [ ] Add `soonItems?: SoonRunItem[]` (default `[]`) + `soonTotal?: number` (default `0`).
- [ ] Render conditional wrapper as the **second** child of the `divide-y` stack, after Attention, before Missions (spec §4.5).

### i18n

- [ ] `dashboard.soon.title` = "Coming up", `dashboard.soon.more` = "+{n} more", all locale files.

### Dependency

- [ ] Schedules front (task #6) ships `GET /api/schedules` (unifying `work_schedules` + scheduled `missions`, sortable by `nextRunAt`) and `/activity?view=schedules`. Soon stays empty/omitted until then.

### Tests

- [ ] `SoonSection` renders `null` for `[]`; ≤3 rows sorted by `nextRunAt`; `+{n} more` only when `total > 3`.
- [ ] `page.tsx` fetch degrades to empty (no throw) when the endpoint is absent.

---

## JIRA linkage

- Epic: _TBD_ (Ever Works platform fronts).
- Story P1 — Compact cards + Teams count · Story P2 — Attention block · Story P3 — Soon block.
- Cross-links: Teams PR #1647; Schedules front (task #6, `docs/specs/features/schedules/`).
