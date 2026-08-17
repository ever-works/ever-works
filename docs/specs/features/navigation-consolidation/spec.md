# Navigation consolidation — Meetings → Memory, Agents → Teams hub, Skills → Agents

**Status:** approved (owner request, 2026-08-17) · **Owner:** Ever Works platform · **Scope:** `apps/web` only (no API changes)

## 1. Problem

The dashboard sidebar has grown one entry per feature. Three of them are really facets of a bigger
concept and read as clutter:

| Today (sidebar)              | Really is …                                                             |
| ---------------------------- | ----------------------------------------------------------------------- |
| **Meetings** (`/meetings`)   | a memory source — transcripts + AI summaries ingest straight into Memory |
| **Agents** + **Teams**       | one org — the same people/agents hierarchy seen from two doors           |
| **Skills** (`/skills`)       | something Agents own — nobody browses skills without an agent in mind    |

## 2. Goal (owner's words, normalised)

1. **Meetings** — remove from the sidebar; the Meetings catalog becomes a **block on the Memory page**.
2. **Agents → Teams** — rename the sidebar entry to **Teams** with a **human/agent** icon. The page has
   tabs **Teams | Agents | Sessions | Archived**. The old `/teams` page content moves into the first tab.
   The **Agents** tab gets an **"Agents Chart"** button (agent hierarchy, no human members). The **Teams**
   tab keeps its **Org Chart** (humans + agents).
3. **Skills** — remove from the sidebar; the Skills catalog becomes a **block inside the Agents tab**.

Non-goals: no API/schema changes; no URL renames of detail pages (`/agents/[id]`, `/teams/[id]`,
`/skills/[id]`, `/meetings/[id]`); no change to per-agent Skills bindings (`/agents/[id]/skills`).

## 3. Design decisions

### 3.1 URLs stay; the sidebar and tab strip are what change

Deep links, e2e matrices, docs, and the AI/MCP tools all reference `/agents/*`, `/teams/*`,
`/skills/*`, `/meetings/*`. Moving routes would be churn with no user value. So:

- **`/teams`** = hub, tab **Teams** (old Teams page content). Sidebar "Teams" links here.
- **`/agents`** = tab **Agents** (existing catalog) + **Skills block** + **Agents Chart** button.
- **`/agents/sessions`**, **`/agents/archived`** = tabs 3–4, unchanged content.
- **`/agents/chart`** = new page, "Agents Chart".
- **`/memory`** = Memory page + **Meetings block** (anchor `#meetings`).
- **`/meetings`** (index only) → **redirect** to `/memory?<same query>#meetings`.
  `/meetings/new`, `/meetings/[id]` untouched.
- **`/skills`** (index only) → **redirect** to `/agents?<same query>#skills`.
  `/skills/new`, `/skills/[id]`, `/skills/templates` untouched.

Redirects (not deletions) honour the no-removal rule and keep every bookmark working.

### 3.2 Sidebar

New order (removed: Agents-as-is, Meetings, Skills, old Teams; added: merged **Teams**):

`Dashboard · Missions · Goals · Ideas · Works · Tasks · **Teams** · Memory · Templates · Plugins · Activity · Settings`

- **Teams** takes the slot Agents had (after Tasks); `href = ROUTES.DASHBOARD_TEAMS`.
- Active-state matching gains optional `matchPrefixes`:
  - Teams: `['/teams', '/agents', '/skills']`
  - Memory: `['/memory', '/meetings']`
- **Icon** — new `HumanAgentIcon` (`components/icons/HumanAgentIcon.tsx`): a lucide-style 24×24 stroke
  SVG, left half a person (head circle + shoulders, from lucide `user`), right half a bot head (rounded
  rect + antenna + two eyes, from lucide `bot`). Same `strokeWidth`/`className` contract as lucide icons so
  it drops into the nav item's `<item.icon>` slot. Also used as the Teams hub PageHeader icon.

### 3.3 Tab strip

`AgentsPageTabs` → extended in place (file kept, exported name kept, plus a new alias `TeamsPageTabs`) with
`active: 'teams' | 'agents' | 'sessions' | 'archived'`, first tab **Teams** → `/teams`. Test ids stay
`agents-page-tabs` / `agents-page-tab-<key>` (adds `agents-page-tab-teams`). Rendered on `/teams`, `/agents`,
`/agents/sessions`, `/agents/archived`. Sub-pages (`/teams/new`, `/teams/[id]`, `/teams/org-chart`,
`/agents/[id]/*`, `/agents/chart`) do not render it (same as today for agent detail).

### 3.4 Teams tab (`/teams`)

Existing `TeamsPage` body, unchanged in behaviour, wrapped as `<div className="w-full"><TeamsPageTabs
active="teams" /> …existing content… </div>` (drop the page-local `p-6 max-w-screen-2xl mx-auto` wrapper so
it matches the other tabs' width). Both the no-org state and the empty state still render under the tabs.
Header keeps org chip · **Org Chart** · **New team**.

### 3.5 Agents tab (`/agents`)

- `AgentsList` PageHeader gains `actions` = **Agents Chart** secondary button (lucide `Network` icon) →
  `ROUTES.DASHBOARD_AGENTS_CHART` (`/agents/chart`), `data-testid="agents-chart-link"`.
- Below the agent grid: **Skills block** (`components/skills/SkillsSection.tsx`, client wrapper):
  a card (`rounded-xl border … bg-card`) with `id="skills"`, header (Sparkles icon tile, title
  `skillsPage.title`, subtitle, actions **Browse templates** + **New skill** — same buttons as the old page),
  then the existing `SkillsPageClient` unchanged in behaviour.
- `SkillsPageClient` gains an optional `basePath` prop (default `ROUTES.DASHBOARD_SKILLS`) used by
  `updateUrl` → on `/agents` it replaces to `/agents?section=…&search=…#skills`.
- `AgentsPage` reads the same search params the old Skills page did (`section`, `search`,
  `installedOffset`, `catalogOffset`) and server-fetches installed + catalog with the same defensive
  `.then/.catch` shape (extract the fetch into a small shared helper `lib/skills-page-data.ts` so `/skills`'s
  logic is not duplicated — the redirect route no longer needs it, but the helper is where the parsing
  lives).
- `revalidatePath('/skills')` calls in `app/actions/skills.ts` and `agent-capabilities.ts` gain a sibling
  `revalidatePath('/agents')` (additive).
- Back-links: `SkillDetailClient` (2 places) and `skills/templates/page.tsx` point at
  `ROUTES.DASHBOARD_AGENTS_SKILLS` (`/agents#skills`) instead of `/skills`.

### 3.6 Agents Chart (`/agents/chart`)

New server page mirroring `teams/org-chart/page.tsx`: resolve org, fetch `teamsAPI.orgChart(org.id)`, then
render `OrgChartClient` with `payload = { ...payload, members: [] }` — teams still group, agents nest by
`reportsToAgentId` exactly as `buildOrgTree` already does, humans are omitted. Title/subtitle/back-link copy
under `dashboard.agentsChartPage.*`; back-link → `/agents`. Empty state when there are no agents.
Test ids: `agents-chart-no-org`, `agents-chart-empty`. No new tree logic; `buildOrgTree` untouched.

### 3.7 Meetings block on Memory (`/memory#meetings`)

- New `components/memory/MemoryMeetingsPanel.tsx` (client, same card chrome as `AgentMemoryPanel`):
  header (Video icon, title `meetingsPage.title`, subtitle, **New meeting** button → `/meetings/new`),
  the connect hint, the source/Work filter form (plain GET form, `action="/memory#meetings"`), the
  `MeetingCard` grid, load-error box, empty state, prev/next pagination — i.e. `MeetingsList` minus the
  `PageHeader`, with all hrefs rebased to `/memory…#meetings`. Implement by giving `MeetingsList` two props:
  `variant: 'page' | 'panel'` (panel = card chrome + no PageHeader) and `basePath` (default `/meetings`),
  and have the panel render `<MeetingsList variant="panel" basePath="/memory" … />`. Existing test ids
  (`meetings-shell`, `meetings-grid`, `meetings-empty`, `meetings-load-error`, `meetings-source-filter`,
  `meetings-work-filter`, `meetings-connect-hint`) are preserved so the e2e journey only changes its URLs.
- `MemoryPage` reads `searchParams` (`source`, `workId`, `offset` — same names and same whitelisting the old
  Meetings page did; move `buildMeetingsHref` + parsing into `lib/api/meetings.shared.ts` or a sibling
  helper so both the redirect route and the panel share it), server-fetches meetings (`PAGE_SIZE = 12`,
  `+1` look-ahead) and the Work options, and passes them to `MemoryShell` as a new optional `meetings` prop.
- Placement in `MemoryShell`: directly after `AgentMemoryPanel` (memory sources together), before the
  consolidation surface and the document search/list.
- Sidebar Memory item is active on `/meetings/*` (detail/new pages).
- Back-links: `MeetingDetailClient` (2 places), `MeetingForm` (2 places) → `ROUTES.DASHBOARD_MEMORY_MEETINGS`
  (`/memory#meetings`).

### 3.8 Constants (`lib/constants.ts`)

Add: `DASHBOARD_AGENTS_CHART: '/agents/chart'`, `DASHBOARD_AGENTS_SKILLS: '/agents#skills'`,
`DASHBOARD_MEMORY_MEETINGS: '/memory#meetings'`. Keep every existing constant.

### 3.9 i18n (`messages/en.json` only — other locales deep-merge from `en`)

- `dashboard.sidebar.navigation.teams` — keep "Teams" (already exists). `navigation.agents/meetings/skills`
  keys stay (unused now, harmless; other surfaces may reference them).
- `dashboard.agentsPage.pageTabs.teams: "Teams"`.
- `dashboard.agentsPage.agentsChartCta: "Agents Chart"`.
- `dashboard.agentsChartPage.{title,subtitle,backToAgents,empty,noOrg}`.
- `dashboard.memoryPage.meetings.{title?}` — reuse `dashboard.meetingsPage.*` for all copy; only add
  `dashboard.memoryPage.meetingsBlockHint` if a Memory-specific one-liner is wanted (optional).
- `dashboard.agentsPage.skillsBlock.subtitle` (optional; default to `skillsPage.subtitle`).

### 3.10 Tests

- **Unit (vitest):** `AgentsPageTabs` (4 tabs, active state, teams first) · `HumanAgentIcon` renders an svg ·
  `MeetingsList` panel variant rebases hrefs to `/memory…#meetings` and hides the PageHeader ·
  `SkillsPageClient` `basePath` drives `router.replace` · sidebar: no Meetings/Skills/Agents entries, Teams
  present with the merged icon, active on `/agents/x` and `/skills/x`; Memory active on `/meetings/x`.
- **e2e (Playwright) updates:** `flow-meetings-ui-journey.spec.ts` (URLs `/en/meetings…` →
  `/en/memory…#meetings`; the "sidebar Meetings link" test becomes "sidebar has no Meetings link; `/meetings`
  redirects to `/memory#meetings`"), `flow-teams-ui-journey.spec.ts` (tab strip present, `agents-page-tab-teams`
  active), `flow-agents-ui-journey.spec.ts` (Skills block + Agents Chart link on `/en/agents`), the `/skills`
  gotos in `flow-skill-bulk-operations`, `flow-skill-crud-scoping`, `flow-skill-marketplace-share`
  (→ `/agents#skills`, or assert the redirect), `skills.spec.ts` / `skills-list-filter.spec.ts` if they touch
  the index UI. New: `/en/agents/chart` renders and contains no `member` cards.
- **Type-check + lint + unit** must be green in `apps/web`. e2e cannot run locally in this session (needs the
  API + DB); the updated specs are reviewed for correctness against the new DOM/test ids instead.

### 3.11 Docs

Update the user-facing feature docs that describe the sidebar/pages: `docs/features/agents-catalog.md`,
`docs/features/skills-catalog.md`, `docs/features/index.md`, `docs/advanced/teams-and-organizations.md`, and
the Meetings/Memory feature doc if one exists — one short "where to find it" paragraph each; no rewrites.

## 4. Out of scope / follow-ups

- Merging `/agents/*` under `/teams/*` URLs (deliberately not done).
- A dedicated agent-only reports-to chart that ignores teams (the Agents Chart keeps team grouping).
- Removing the now-unused `navigation.meetings/skills/agents` i18n keys.
