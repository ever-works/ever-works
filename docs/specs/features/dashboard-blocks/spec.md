# Dashboard Blocks — Product Spec

**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-07-18
**Audience:** Product, Engineering (frontend + backend), Design
**Internal codename:** "Home cockpit"
**Related code today:**

- Home server page (data fetch): [`apps/web/src/app/[locale]/(dashboard)/(home)/page.tsx`](<../../../../apps/web/src/app/[locale]/(dashboard)/(home)/page.tsx>) — the `Promise.all` fan-out (`:28-92`) and the `<DashboardClient>` mount (`:103-127`)
- Home client shell (layout): [`apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx`](<../../../../apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-client.tsx>) — the `divide-y` section stack (`:117-194`)
- Stat cards: [`apps/web/src/components/dashboard/StatsOverview.tsx`](../../../../apps/web/src/components/dashboard/StatsOverview.tsx) — `statCards` array (`:90-166`), grid (`:169`), tile markup (`:171-217`)
- Missions preview block: [`apps/web/src/components/missions/MissionsPreviewSection.tsx`](../../../../apps/web/src/components/missions/MissionsPreviewSection.tsx) — section-header pattern (`:72-110`)
- Work-stats server action: [`apps/web/src/app/actions/dashboard/works.ts`](../../../../apps/web/src/app/actions/dashboard/works.ts) `getWorkStats()` (`:690`) → `workAPI.getStats()`
- Work-stats backend: [`apps/api/src/works/works.controller.ts`](../../../../apps/api/src/works/works.controller.ts) `getWorkStats()` (`:276`) → [`packages/agent/src/services/work-query.service.ts`](../../../../packages/agent/src/services/work-query.service.ts) `getStats()` (`:153`) → `workRepository.getAccessibleStats()`
- Severity tone tokens to reuse: [`apps/web/src/components/dashboard/RecentTasks.tsx`](../../../../apps/web/src/components/dashboard/RecentTasks.tsx) `STATUS_TONES` / `PRIORITY_TONES` (`:11-27`) — `bg-danger/10 text-danger`, `bg-warning/10 text-warning`
- Schedule source entity: [`packages/agent/src/entities/work-schedule.entity.ts`](../../../../packages/agent/src/entities/work-schedule.entity.ts) — `nextRunAt`, `lastRunStatus`, `failureCount`, `maxFailureBeforePause`, `status`; composite index `@Index(['status', 'nextRunAt'])` (`:20`)
- Schedule status enum: [`packages/contracts/src/api/work/schedule.enum.ts`](../../../../packages/contracts/src/api/work/schedule.enum.ts) `WorkScheduleStatus` = `disabled | active | paused | canceled`
- Agent status enum: [`packages/agent/src/entities/agent.entity.ts`](../../../../packages/agent/src/entities/agent.entity.ts) `AgentStatus` = `draft | active | running | paused | error | archived`; `errorCount`, `pauseAfterFailures`, `lastRunStatus`
- Scheduled Missions: [`packages/agent/src/entities/mission.entity.ts`](../../../../packages/agent/src/entities/mission.entity.ts) — `type = SCHEDULED`, `schedule` (cron), `status = ACTIVE`
- i18n root: [`apps/web/messages/en.json`](../../../../apps/web/messages/en.json) `dashboard.stats.*` (`:1852-1865`) — 21 locale files
- Route constants: [`apps/web/src/lib/constants.ts`](../../../../apps/web/src/lib/constants.ts) `ROUTES.DASHBOARD_TEAMS = '/teams'` (`:127`, present once the Teams PR lands)

> **Scope of this document:** additive dashboard-home changes only — a new stat card, a denser stat-card layout, and two new signal blocks (Attention, Soon). This document EXTENDS the existing Dashboard home; it renames nothing, removes no card, no section, and no prop. Every new prop is optional with a safe default so existing render paths keep working. The phased execution plan lives in the sibling [plan.md](plan.md); the task checklist in [tasks.md](tasks.md).
>
> **Hard rule (additive by default):** The existing 8 stat cards, the Missions/Ideas/Works/Tasks/Agents section stack, and every current prop stay exactly as they are. The Teams card is a 9th card. Attention and Soon are two new blocks inserted _above_ the Missions list; when they have nothing to show they render nothing (no empty shell, no divider gap). No existing string, route, or component is renamed.

---

## 0. TL;DR

Three additive changes to the Dashboard home, plus a compaction of the stat strip so the extra density reads clean:

1. **Teams count card** — a 9th stat tile showing the number of Teams in the active Organization (depends on the Teams feature, PR #1647).
2. **Compact stat cards** — collapse each tile from a loose 3-row block to a tight **2-line** block: line 1 = `[icon] [count]`, line 2 = subtitle with the qualifier kept inline on the card (`Agents (0 active)`, `Tasks in flight`). Smaller, denser, no third line.
3. **Attention block** — red signal cards ABOVE the Missions list, rendered only when non-empty: errored agents, failed/paused schedules, failed generations, tasks needing input or overdue, budget exceeded.
4. **Soon block** — the next 3 upcoming scheduled runs (soonest `nextRunAt`), below Attention, reusing the `GET /api/schedules` aggregation from the Schedules front (cross-spec dependency).

```
apps/web/.../(home)/dashboard-client.tsx  —  section stack (divide-y)
┌─────────────────────────────────────────────────────────────┐
│  Page header  (Welcome back, {username}!)                    │
├─────────────────────────────────────────────────────────────┤
│  StatsOverview — 9 COMPACT tiles                             │
│  ┌────────┬────────┬────────┬────────┐   each tile:         │
│  │Missions│ Ideas  │ Works  │ Items  │   ┌───────────────┐  │
│  ├────────┼────────┼────────┼────────┤   │ [icon]  12    │  │  line 1
│  │ Sites  │ Spend  │ Agents │ Tasks  │   │ • Agents (0…) │  │  line 2
│  ├────────┼────────┴────────┴────────┤   └───────────────┘  │
│  │ Teams  │  ← 9th (Teams PR #1647)                          │
│  └────────┘                                                  │
├─────────────────────────────────────────────────────────────┤
│  ▸ ATTENTION   (red)   — only if non-empty     [P2]  ◄── NEW │
│  ▸ SOON        (upcoming runs) — only if any    [P3] ◄── NEW │
├─────────────────────────────────────────────────────────────┤
│  Missions preview   (unchanged)                             │
│  Ideas · Works · Recent Tasks · Agents   (unchanged)        │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Concepts

| Concept             | Meaning                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stat tile**       | One card in `StatsOverview`. Today there are 8; this spec adds a 9th (Teams) and compacts all of them.                                                             |
| **Qualifier**       | The parenthetical secondary fact on a stat tile (`(0 active)`, `(2 blocked)`). Today it lives on a separate third line; this spec folds it into the subtitle line. |
| **Attention item**  | A single thing that needs the user's action right now — an errored agent, a paused schedule, an overdue task, a blown budget. Rendered as a red card.              |
| **Soon item**       | A single upcoming scheduled run, identified by its soonest `nextRunAt` across the schedule sources.                                                                |
| **Schedule source** | Any entity that has a recurring `nextRunAt`: a `WorkSchedule`, a scheduled `Mission` (`type = SCHEDULED`). Unified by the Schedules front's `GET /api/schedules`.  |
| **Non-empty guard** | Both new blocks render nothing (not even their wrapper/divider) when they have zero items — a healthy account sees a quieter dashboard, not empty shells.          |

---

## 2. Data model

**No schema changes.** Every signal this feature surfaces already exists as a column on a shipped entity. This section is the read-side contract only; there are no migrations in this feature's PRs.

### 2.1 Signals already on entities (read-only)

| Signal                     | Source entity / field                                                                          | "Needs attention" when                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Errored agent              | `agent.status` (`AgentStatus.ERROR`), `agent.errorCount`, `agent.pauseAfterFailures`           | `status === 'error'` (agent auto-paused after `pauseAfterFailures`) |
| Failed schedule run        | `work_schedules.lastRunStatus` (`GenerateStatusType` failure)                                  | last run failed                                                     |
| Paused-on-failure schedule | `work_schedules.status` (`WorkScheduleStatus.PAUSED`), `failureCount`, `maxFailureBeforePause` | `status === 'paused' && failureCount >= maxFailureBeforePause`      |
| Failed generation (Idea)   | `work_proposals.status === 'failed'`                                                           | proposal build failed                                               |
| Blocked / needs-input task | `task.status === 'blocked'` (already fetched as `tasksBlocked`)                                | task blocked                                                        |
| Overdue task               | `task.dueDate` (if present) `< now` and status not terminal                                    | past due, still open                                                |
| Budget exceeded            | `usageAPI.accountWide()` `currentSpendCents` vs the account cap                                | spend ≥ cap                                                         |
| Upcoming run               | `work_schedules.nextRunAt` (index `['status','nextRunAt']`), scheduled `Mission.schedule` cron | `status === 'active'` and `nextRunAt` in the future                 |

> The composite index `@Index(['status', 'nextRunAt'])` on `work_schedules` (`work-schedule.entity.ts:20`) is exactly the index the Soon query needs — `WHERE status = 'active' ORDER BY nextRunAt ASC LIMIT 3` is index-covered.

### 2.2 Read DTOs (new, wire-only — no persistence)

```ts
// Attention aggregation item (GET /api/dashboard/attention)
type AttentionKind =
	| 'agent-error'
	| 'schedule-failed'
	| 'schedule-paused'
	| 'generation-failed'
	| 'task-blocked'
	| 'task-overdue'
	| 'budget-exceeded';

interface AttentionItem {
	id: string; // stable per underlying row (e.g. `agent:${agentId}`)
	kind: AttentionKind;
	severity: 'danger' | 'warning'; // maps to RecentTasks tone tokens
	title: string; // "Agent “Researcher” errored"
	subtitle?: string; // "3 consecutive failures — paused"
	href: string; // deep link to the offending entity
	occurredAt?: string; // ISO — for sorting most-recent-first
}

// Soon item — a projection of the Schedules front's schedule row
interface SoonRunItem {
	id: string;
	sourceKind: 'work-schedule' | 'mission';
	title: string; // Work or Mission title
	nextRunAt: string; // ISO
	href: string;
}
```

---

## 3. API surface

### 3.1 Teams count (change 1)

Teams are **Organization-scoped** (`team.entity.ts` carries `organizationId`; the web mirror is `teamsAPI` in `apps/web/src/lib/api/teams.ts`). The card shows "Teams in the active Organization". Two wiring options:

- **P1 (cheap, web-only) — recommended for the first cut:** fetch inside the existing home `Promise.all` (`page.tsx:47`):

    ```ts
    teamsAPI
    	.listOrganizations()
    	.then((orgs) => Promise.all(orgs.map((o) => teamsAPI.list(o.id))).then((lists) => lists.flat().length))
    	.catch(() => 0);
    ```

    Pass the resolved number as a new `teamsTotal` prop. When the org-switcher context lands (see [tenants-and-organizations](../tenants-and-organizations/spec.md)), narrow `orgs` to the active Organization instead of summing all.

- **Cleaner (backend) — follow-up:** add `teamsCount` to `workRepository.getAccessibleStats()` (`work-query.service.ts:153`) so it rides the existing `getStats()` round-trip and `getWorkStats()` DTO (`works.ts:690`, fallback `:708-716`). No new client fetch.

> **Cross-feature dependency — Teams (PR #1647).** `teamsAPI`, `team.entity.ts`, the `/organizations/:id/teams` endpoint, and `ROUTES.DASHBOARD_TEAMS` are delivered by the Teams feature and are NOT present on this branch until PR #1647 merges. The Teams card MUST degrade gracefully: `teamsTotal` is an **optional** prop; when it is `undefined` (Teams not wired) the card is **omitted entirely** — the grid falls back to 8 tiles with no error. This lets the compact-cards change (change 2) ship independently of Teams.

### 3.2 Attention aggregation (change 3)

- **P2 first cut — server-component compose (no new endpoint).** Everything Attention needs is already fetched or one cheap fetch away in `page.tsx`. Compose an `AttentionItem[]` server-side from:
    - errored agents → add `agentsAPI.list({ status: 'error', limit: 5 })` to the `Promise.all`;
    - failed generations → filter the already-fetched `allIdeas` for `status === 'failed'`;
    - blocked tasks → already fetched as `tasksBlocked` (`page.tsx:79-81`); fetch the rows (`limit: 5`) not just the count;
    - budget → already fetched via `usageAPI.accountWide()` (`page.tsx:69`).
- **Consolidation follow-up — `GET /api/dashboard/attention`.** Once the signal set is stable, move the compose behind one authenticated endpoint returning `AttentionItem[]` (max ~10, `danger` before `warning`, then `occurredAt` desc). This keeps the schedule-derived signals (failed/paused schedules) — which the home page does not fetch today — in one place rather than adding three more fetches to the page fan-out.

    ```
    GET /api/dashboard/attention        → { items: AttentionItem[] }
      auth: @CurrentUser (owner-scoped, same posture as getWorkStats)
      caps items to 10; sorts danger-first, then occurredAt desc
    ```

### 3.3 Soon (change 4)

- **REUSE `GET /api/schedules`** from the Schedules front (does not exist on this branch yet — see §7). The Soon block calls it with the same aggregation the Schedules view uses, then takes the soonest 3:

    ```
    GET /api/schedules?status=active&sort=nextRunAt:asc&limit=3
      → { items: SoonRunItem[], total: number }
    ```

    The block renders `items` and, when `total > 3`, a `+{total - 3} more` link to `/activity?view=schedules`.

- Until the Schedules front ships, Soon is **not rendered** (its data source is absent). This is why Soon is phased last (P3) and gated on the cross-spec dependency.

---

## 4. Web UI

### 4.1 Change 1 — Teams count card (`StatsOverview.tsx`)

Add an optional prop and one `statCards` entry. New prop on `StatsOverviewProps` (`:19-50`) and the destructure (`:64-76`):

```ts
teamsTotal?: number; // undefined ⇒ Teams feature not wired ⇒ card omitted
```

New entry appended to the `statCards` array (`:90-166`), guarded so it only appears when `teamsTotal` is defined:

```tsx
...(teamsTotal !== undefined
	? [
			{
				title: t('teams'),
				value: teamsTotal,
				icon: Users, // add `Users` to the lucide-react import (:5-15)
				dotColor: 'bg-teal-500',
				change: '+0%',
				changeType: 'neutral' as const,
				href: ROUTES.DASHBOARD_TEAMS,
				sublabel: t('teamsSubtitle') // e.g. "in your org" — see §4.2 uniform subtitle rule
			}
		]
	: []),
```

Wire the prop through `dashboard-client.tsx` (`DashboardClientProps` + the `<StatsOverview>` mount `:102-114`) and `page.tsx` (the `Promise.all` fetch from §3.1 + the `<DashboardClient>` mount `:104-127`).

**Grid decision (8 → 9 tiles).** The grid is `grid grid-cols-2 @xl/main:grid-cols-4 gap-3` (`:169`). Nine tiles is a ragged `4 + 4 + 1` at the wide breakpoint. Options:

- **(a) Recommended:** keep `@xl/main:grid-cols-4`; accept the ragged last row. The compact cards (change 2) make a lone 9th tile visually fine, and it leaves room for a future 10th (`Companies`, "Soon").
- **(b)** switch the wide breakpoint to `@xl/main:grid-cols-3` for a clean `3 × 3`. Trade-off: each card gets wider; less "strip", more "grid".

Pick (a) for v1; revisit if a 10th card lands.

### 4.2 Change 2 — compact 2-line cards (`StatsOverview.tsx:171-217`)

**Goal:** every tile is exactly two lines — line 1 `[icon] [count]`, line 2 `[dot] subtitle` — with the qualifier kept **inline on the subtitle line** (never a third line). Cards get smaller and denser.

**Current markup (`:171-217`)** — up to three rows (icon+value, dot+title, optional sublabel):

```tsx
<div className="group relative flex flex-col gap-2 rounded-xl px-4 py-4 h-full overflow-hidden ...">
	<div className="card-top-accent ..." />
	{/* Row 1 — icon + value */}
	<div className="flex items-end gap-2 min-w-0">
		<div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ...">
			<stat.icon className="w-4 h-4 ..." strokeWidth={1.4} />
		</div>
		<p className="text-2xl font-semibold tracking-tight tabular-nums ... leading-none truncate">{stat.value}</p>
	</div>
	{/* Row 2 — dot + title, plus OPTIONAL Row 3 — sublabel */}
	<div className="min-w-0">
		<div className="flex items-center gap-1.5">
			<span className={cn('w-1.5 h-1.5 rounded-full shrink-0', stat.dotColor)} />
			<p className="text-xs ... truncate">{stat.title}</p>
		</div>
		{stat.sublabel ? <p className="mt-0.5 pl-3 text-[11px] ... truncate opacity-70">{stat.sublabel}</p> : null}
	</div>
</div>
```

**Target compact markup** — exactly two lines; the qualifier is folded into the subtitle string, so the separate third-line `<p>` is deleted. Padding, gap, value size, and icon box all shrink:

```tsx
<div className="group relative flex flex-col gap-1.5 rounded-xl px-3 py-3 h-full overflow-hidden ...">
	<div className="card-top-accent ..." />
	{/* Line 1 — icon + value */}
	<div className="flex items-end gap-2 min-w-0">
		<div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ...">
			<stat.icon className="w-3.5 h-3.5 ..." strokeWidth={1.4} />
		</div>
		<p className="text-xl font-semibold tracking-tight tabular-nums ... leading-none truncate">{stat.value}</p>
	</div>
	{/* Line 2 — dot + subtitle (qualifier inline, NEVER a 3rd line) */}
	<div className="flex items-center gap-1.5 min-w-0">
		<span className={cn('w-1.5 h-1.5 rounded-full shrink-0', stat.dotColor)} />
		<p className="text-xs ... truncate">
			{stat.title}
			{stat.qualifier ? <span className="opacity-70"> ({stat.qualifier})</span> : null}
		</p>
	</div>
</div>
```

**Data shape change.** Rename the per-card `sublabel` field to `qualifier` (semantics: the parenthetical fact only). Migrate the two cards that use it today:

- Agents (`:151`): `sublabel: t('agentsActive', { count })` → `qualifier: t('agentsActive', { count })` → renders `Agents (0 active)`.
- Tasks (`:161-164`): keep the blocked/no-blockers logic → `qualifier` → renders `Tasks in flight (2 blocked)`; when `tasksBlocked === 0`, omit the qualifier so it reads plain `Tasks in flight` (do NOT render `(no blockers)` — a healthy card stays clean).

> **Uniform-height note.** With the qualifier inline, cards with a qualifier and cards without one are the **same height** (both are 2 lines) — no need to give every card a filler subtitle. This is simpler than the earlier "give every tile a sublabel" idea and keeps the copy honest. Line 2 is always the title; the qualifier is optional decoration on that same line.

This change is **single-file** (`StatsOverview.tsx`) except for the field rename; no `page.tsx` / `dashboard-client.tsx` / data change.

### 4.3 Change 3 — Attention block (new `apps/web/src/components/dashboard/AttentionSection.tsx`)

- Mirrors the section-header pattern from `MissionsPreviewSection.tsx:72-110` (icon box + `text-xl font-semibold` h2), header icon `AlertTriangle` (lucide), heading `t('dashboard.attention.title')` ("Needs attention").
- Body: a vertical list (or 2-col grid at `@lg`) of red cards. Each card reuses the danger/warning tone tokens from `RecentTasks.tsx:11-27`:
    - `severity: 'danger'` → `border-danger/30 bg-danger/5`, title `text-danger`;
    - `severity: 'warning'` → `border-warning/30 bg-warning/8`, title `text-warning`.
- Each card = `[kind icon] [title] [subtitle]` and is a `<Link href={item.href}>` to the offending entity (agent detail, schedule/work detail, task detail, billing).
- **Non-empty guard:** the component returns `null` when `items.length === 0`; the wrapper `<div>` in `dashboard-client.tsx` is itself conditional so no divider/gap appears (see §4.5).
- Client component taking `items: AttentionItem[]` as a prop (server-composed in `page.tsx`); no client fetch in the first cut.

### 4.4 Change 4 — Soon block (new `apps/web/src/components/dashboard/SoonSection.tsx`)

- Same section-header pattern; header icon `CalendarClock` (already used in `MissionsPreviewSection`), heading `t('dashboard.soon.title')` ("Coming up").
- Body: up to 3 compact rows, each `[title] [relative nextRunAt] [source chip]`, sorted `nextRunAt` asc. Row is a `<Link>` to the underlying Work/Mission.
- Footer: when `total > 3`, a `+{total - 3} more` link → `/activity?view=schedules` (the Schedules view from the Schedules front). Copy key `t('dashboard.soon.more', { n })`.
- **Non-empty guard:** returns `null` when there are no upcoming runs (including when the Schedules endpoint is absent → treat as empty).
- Takes `items: SoonRunItem[]` + `total: number` as props (server-fetched in `page.tsx` via the reused `GET /api/schedules`).

### 4.5 Change 5 — layout / exact insertion points (`dashboard-client.tsx`)

The section stack today (`:117-194`):

```tsx
<div className="mt-10 divide-y divide-border/30 dark:divide-white/6">
	<div className="py-8 lg:py-10">
		<MissionsPreviewSection ... />   {/* :118-120 */}
	</div>
	<div className="py-8"> <WorkProposalsSection ... /> </div>
	...
</div>
```

Insert Attention then Soon as the **first two children** of the `divide-y` stack, immediately after the opening `<div className="mt-10 divide-y ...">` (`:117`) and **before** the Missions `<div>` (`:118`). Each is wrapped so an empty block contributes no divider:

```tsx
<div className="mt-10 divide-y divide-border/30 dark:divide-white/6">
	{/* NEW — P2: only render the wrapper when there is something to show */}
	{attentionItems.length > 0 && (
		<div className="py-8 lg:py-10">
			<AttentionSection items={attentionItems} />
		</div>
	)}
	{/* NEW — P3: gated on the Schedules front's aggregation */}
	{soonItems.length > 0 && (
		<div className="py-8 lg:py-10">
			<SoonSection items={soonItems} total={soonTotal} />
		</div>
	)}
	{/* existing — unchanged */}
	<div className="py-8 lg:py-10">
		<MissionsPreviewSection missions={initialMissions} allIdeas={initialAllIdeas} />
	</div>
	...
</div>
```

Resulting order: **Attention → Soon → Missions → Ideas → Works → Recent Tasks → Agents.** New props on `DashboardClientProps`: `attentionItems?: AttentionItem[]` (default `[]`), `soonItems?: SoonRunItem[]` (default `[]`), `soonTotal?: number` (default `0`), `teamsTotal?: number`.

---

## 5. Plugin points

None. This feature reads existing entities and renders existing-scoped data; it introduces no plugin contract, no capability, and no settings schema.

---

## 6. Security

- **Owner-scoped reads only.** The Attention aggregation and the Teams count run behind `@CurrentUser` / `getAuthFromCookie()` at the server-action / controller boundary — same posture as `getWorkStats()` (`works.ts:691-696`). No cross-user data is aggregated. Attention items are filtered to entities the requesting user owns / can access (agents, schedules, tasks, proposals already go through owner-scoped repositories).
- **Deep links carry no authority.** `AttentionItem.href` / `SoonRunItem.href` point at existing owner-scoped routes; the destination page re-authorizes. The href is derived server-side from owned rows, never from client input.
- **No new writes.** Both blocks are read-only surfaces. There is no mutation endpoint in this feature.
- **Graceful absence, not error leakage.** Missing Teams API or missing Schedules endpoint resolves to "omit the card / render nothing", never a 500 surfaced to the home page — each fetch is `.catch()`-defended exactly like the existing home fan-out (`page.tsx:50-91`).

---

## 7. Naming

| Thing                   | Name                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| Stat qualifier field    | `qualifier` (was `sublabel` on the per-card object)                  |
| Teams card i18n keys    | `dashboard.stats.teams` = "Teams", `dashboard.stats.teamsSubtitle`   |
| Attention component     | `AttentionSection` (`components/dashboard/AttentionSection.tsx`)     |
| Attention i18n root     | `dashboard.attention.*` (`title` = "Needs attention", per-kind copy) |
| Attention endpoint      | `GET /api/dashboard/attention` (consolidation follow-up)             |
| Soon component          | `SoonSection` (`components/dashboard/SoonSection.tsx`)               |
| Soon i18n root          | `dashboard.soon.*` (`title` = "Coming up", `more` = "+{n} more")     |
| Soon data source        | `GET /api/schedules` (owned by the Schedules front)                  |
| Activity schedules view | `/activity?view=schedules` (owned by the Schedules front)            |

i18n keys are added to `apps/web/messages/en.json` under `dashboard.*` and mirrored across all 21 locale files (English copy as the fallback value).

---

## 8. Phasing

- **P1 — Compact cards + Teams count.**
    - 8-tile compaction (`StatsOverview.tsx` only; `sublabel` → `qualifier`, 2-line markup, denser spacing). Ships independently of everything else.
    - Teams card wired via the web-only `teamsAPI` fetch (§3.1), **gated on Teams PR #1647** — the card is omitted while `teamsTotal` is `undefined`, so P1 is not blocked by Teams landing.
- **P2 — Attention block.** `AttentionSection` + server-component compose in `page.tsx` from agents(error)/proposals(failed)/tasks(blocked)/budget. Optional consolidation into `GET /api/dashboard/attention`.
- **P3 — Soon block.** `SoonSection` + reuse of `GET /api/schedules`. **Depends on the Schedules front** shipping that aggregation and the `/activity?view=schedules` view; until then Soon renders nothing.

**Cross-spec dependencies:**

- **Teams** (PR #1647) — provides `teamsAPI`, `team.entity.ts`, `/organizations/:id/teams`, `ROUTES.DASHBOARD_TEAMS`. Blocks the Teams card only.
- **Schedules front** (`docs/specs/features/schedules/`, task #6) — provides `GET /api/schedules` and `/activity?view=schedules`. Blocks the Soon block (P3) only.

---

## 9. Open questions

1. **Grid at 9 tiles** — accept the ragged `4 + 4 + 1` (option a) or move the wide breakpoint to `grid-cols-3` (option b)? Recommendation: (a), and add a 10th `Companies` "Soon" tile later to fill the row.
2. **Active-Org scope for Teams** — the home page is account-wide today; "Teams in the active Organization" needs the org-switcher context ([tenants-and-organizations](../tenants-and-organizations/spec.md)). Until then, sum Teams across the user's Organizations. Confirm the summed count is the acceptable v1 semantic.
3. **Overdue tasks** — does the Task entity expose a `dueDate` we can compare to `now`? If not, drop `task-overdue` from the Attention kinds for v1 and keep only `task-blocked`.
4. **Budget cap source** — is the account cap on `usageAPI.accountWide()` payload, or does the Attention compose need a second call to the budget settings? Confirm before wiring `budget-exceeded`.
5. **Attention max count** — cap at 10 items with a "+N more" affordance to `/activity`, or show all? Recommendation: cap at ~6 on the dashboard, link the rest to Activity.
6. **Soon empty vs. absent** — when the Schedules endpoint is absent (front not shipped) vs. present-but-empty, both render nothing. Confirm no "no upcoming runs" empty state is wanted on the home page (keeps a healthy dashboard quiet).

---

## 10. Cross-references

- Implementation plan: [plan.md](plan.md)
- Task checklist: [tasks.md](tasks.md)
- Teams feature (dependency): PR #1647
- Schedules front (dependency): `docs/specs/features/schedules/spec.md` (task #6 — Schedules view + Activity rename)
- Org scope context: [tenants-and-organizations](../tenants-and-organizations/spec.md)
- Retrospective schedule behavior: [scheduled-updates](../scheduled-updates/spec.md)
- Retrospective activity log: [activity-log](../activity-log/spec.md)
