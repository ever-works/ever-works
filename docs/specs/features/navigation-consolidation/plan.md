# Navigation consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold Meetings into the Memory page, turn the Agents sidebar entry into a "Teams" hub with tabs Teams | Agents | Sessions | Archived (Teams content in tab 1, an Agents Chart on tab 2), and fold the Skills catalog into the Agents tab — with no URL renames for detail pages and redirects for the two retired index routes.

**Architecture:** `apps/web` only (Next.js 16 App Router, React 19, next-intl, Tailwind 4, vitest, Playwright). Existing server pages keep their fetch/whitelisting posture; existing client components gain `variant`/`basePath` props instead of being duplicated. The org-chart renderer is reused for the Agents Chart by stripping `members` from the payload. Sidebar active-state matching gains `matchPrefixes`.

**Tech Stack:** Next.js 16.1.5, React 19, next-intl (`@/i18n/navigation` `Link`/`useRouter`/`redirect`), lucide-react, vitest (`pnpm --filter ever-works-web test`), Playwright e2e specs under `apps/web/e2e` (cannot run locally here — update by reading the DOM contract).

Spec: [`spec.md`](./spec.md) (same folder). Worktree: `E:\Coding\_wt-nav-teams-memory`, branch `feat/nav-teams-memory-consolidation` (based on `origin/develop`).

## Global Constraints

- Package manager **pnpm only**. Run web checks from `apps/web`: `pnpm type-check`, `pnpm lint`, `pnpm test` (vitest).
- **Prettier**: tabs, width 4, single quotes, semicolons, arrow parens always, print width 120 (root `package.json` config wins). Run `pnpm prettier --write <files>` on touched files.
- **No-removal rule**: retired index routes become **redirects**, never deleted. Keep every existing `ROUTES.*` constant and every existing i18n key. Keep every existing `data-testid`.
- **i18n**: add new copy to `apps/web/messages/en.json` only (other locales deep-merge from `en`).
- **Server components by default**; `'use client'` only where interactivity exists (existing files already tell you which).
- **Conventional commits** (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`), one commit per task, from the worktree root.
- Do not touch `apps/api`, `packages/*`, or any migration.
- Never invent test ids used by e2e without also updating the e2e spec that asserts them (and vice versa).

---

## File map

| Area                                     | Create                                                                                                                                                           | Modify                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundations                              | `src/components/icons/HumanAgentIcon.tsx`, `src/components/icons/HumanAgentIcon.unit.spec.tsx`, `src/components/agents/AgentsPageTabs.unit.spec.tsx`             | `src/lib/constants.ts`, `messages/en.json`, `src/components/agents/AgentsPageTabs.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Meetings → Memory                        | `src/components/memory/MemoryMeetingsPanel.tsx`, `src/components/meetings/MeetingsList.unit.spec.tsx`, `src/lib/api/meetings-page-params.ts` (+ `.unit.spec.ts`) | `src/components/meetings/MeetingsList.tsx`, `src/components/memory/MemoryShell.tsx`, `src/components/memory/index.ts`, `src/app/[locale]/(dashboard)/memory/page.tsx`, `src/app/[locale]/(dashboard)/meetings/page.tsx` (→ redirect), `src/components/meetings/MeetingDetailClient.tsx`, `src/components/meetings/MeetingForm.tsx`, `e2e/flow-meetings-ui-journey.spec.ts`, `e2e/flow-memory-ui-journey.spec.ts` (only if it asserts panel order)                                                                 |
| Skills → Agents                          | `src/components/skills/SkillsSection.tsx`, `src/lib/skills-page-data.ts` (+ `.unit.spec.ts`), `src/components/skills/SkillsSection.unit.spec.tsx`                | `src/components/skills/SkillsPageClient.tsx`, `src/components/skills/SkillDetailClient.tsx`, `src/app/[locale]/(dashboard)/skills/page.tsx` (→ redirect), `src/app/[locale]/(dashboard)/skills/templates/page.tsx`, `src/app/actions/skills.ts`, `src/app/actions/agent-capabilities.ts`, `e2e/flow-skill-bulk-operations.spec.ts`, `e2e/flow-skill-crud-scoping.spec.ts`, `e2e/flow-skill-marketplace-share.spec.ts`, `e2e/skills.spec.ts`, `e2e/skills-list-filter.spec.ts` (only where they open `/skills` UI) |
| Teams hub + Agents tab + chart + sidebar | `src/app/[locale]/(dashboard)/agents/chart/page.tsx`, `src/components/dashboard/DashboardSidebar.unit.spec.tsx` (if none exists; else extend)                    | `src/app/[locale]/(dashboard)/teams/page.tsx`, `src/app/[locale]/(dashboard)/agents/page.tsx`, `src/components/agents/AgentsList.tsx`, `src/components/dashboard/DashboardSidebar.tsx`, `e2e/flow-teams-ui-journey.spec.ts`, `e2e/flow-agents-ui-journey.spec.ts`                                                                                                                                                                                                                                                 |
| Docs                                     | —                                                                                                                                                                | `docs/features/agents-catalog.md`, `docs/features/skills-catalog.md`, `docs/features/index.md`, `docs/advanced/teams-and-organizations.md`, meetings/memory feature doc if present (`grep -ril "meetings" docs/features`)                                                                                                                                                                                                                                                                                         |

Paths are relative to `apps/web/` unless they start with `docs/`.

---

## Phase 0 — Foundations (sequential; everything else depends on it)

### Task 0.1: ROUTES constants + i18n keys

**Files:**

- Modify: `src/lib/constants.ts` (ROUTES block around lines 145–195)
- Modify: `messages/en.json`

**Produces:** `ROUTES.DASHBOARD_AGENTS_CHART = '/agents/chart'`, `ROUTES.DASHBOARD_AGENTS_SKILLS = '/agents#skills'`, `ROUTES.DASHBOARD_MEMORY_MEETINGS = '/memory#meetings'`; i18n keys listed below.

- [ ] **Step 1: Add constants** — inside the ROUTES object, next to the related entries:

```ts
    // Navigation consolidation (docs/specs/features/navigation-consolidation):
    // the Skills catalog now renders as a block on the Agents tab, and the
    // Meetings catalog as a block on the Memory page. `/skills` and
    // `/meetings` (index only) redirect here; detail routes are unchanged.
    DASHBOARD_AGENTS_SKILLS: '/agents#skills',
    DASHBOARD_MEMORY_MEETINGS: '/memory#meetings',
    // Agents Chart — the org chart with human members stripped.
    DASHBOARD_AGENTS_CHART: '/agents/chart',
```

- [ ] **Step 2: Add i18n keys to `messages/en.json`** (find each parent object; keep alphabetical-ish placement near siblings):

```jsonc
// dashboard.agentsPage.pageTabs  (existing object with agents/sessions/archived)
"teams": "Teams",

// dashboard.agentsPage  (top-level of that object)
"agentsChartCta": "Agents Chart",
"skillsBlock": {
    "title": "Skills",
    "subtitle": "Skills your Agents can use — installed, available in the catalog, and custom ones you wrote."
},

// dashboard  (new sibling of agentsPage / orgChartPage)
"agentsChartPage": {
    "title": "Agents Chart",
    "subtitle": "How your Agents are organised — teams and reporting lines, without human members.",
    "backToAgents": "Back to Agents",
    "empty": "No Agents yet. Create an Agent and it will appear here.",
    "noOrg": "Create an Organization first — the Agents Chart is drawn per Organization."
},

// dashboard.memoryPage  (existing object)
"meetings": {
    "hint": "Meetings are one of the richest things the platform learns from — every transcript and summary is ingested straight into Memory."
}
```

- [ ] **Step 3: Verify JSON + types** — `cd apps/web && node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'))" && pnpm type-check`
- [ ] **Step 4: Commit** — `git commit -m "feat(web): routes + i18n keys for navigation consolidation"`

### Task 0.2: `HumanAgentIcon`

**Files:**

- Create: `src/components/icons/HumanAgentIcon.tsx`
- Test: `src/components/icons/HumanAgentIcon.unit.spec.tsx`

**Produces:** `export function HumanAgentIcon(props: React.SVGProps<SVGSVGElement> & { strokeWidth?: number })` — a lucide-compatible 24×24 stroke icon (accepts `className`, `strokeWidth`), usable as `<item.icon className="w-5 h-5" strokeWidth={1.5} />` and as `PageHeader`'s `icon` prop (typed as `LucideIcon` — export the component typed as `LucideIcon` via `as unknown as LucideIcon` re-export `HumanAgentLucideIcon` if the PageHeader prop type rejects it; prefer making the component's props structurally compatible: `(props: LucideProps) => JSX.Element`).

- [ ] **Step 1: Failing test** (`vitest` + `@testing-library/react` are already used by sibling `*.unit.spec.tsx` files — copy their imports):

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HumanAgentIcon } from './HumanAgentIcon';

describe('HumanAgentIcon', () => {
	it('renders a lucide-compatible svg with the given class and stroke width', () => {
		const { container } = render(<HumanAgentIcon className="w-5 h-5" strokeWidth={1.5} />);
		const svg = container.querySelector('svg');
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
		expect(svg?.getAttribute('class')).toContain('w-5');
		expect(svg?.getAttribute('stroke-width')).toBe('1.5');
		expect(svg?.getAttribute('aria-hidden')).toBe('true');
		// both halves present: a person head (circle) and a bot head (rect)
		expect(container.querySelector('circle')).not.toBeNull();
		expect(container.querySelector('rect')).not.toBeNull();
	});
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/components/icons/HumanAgentIcon.unit.spec.tsx` → FAIL (module not found).
- [ ] **Step 3: Implement**

```tsx
import type { LucideProps } from 'lucide-react';

/**
 * Human + Agent — sidebar icon for the merged "Teams" hub (people AND
 * agents). Hand-drawn in lucide's 24×24 stroke grammar so it sits next to
 * lucide icons without a visible seam: left half is lucide `user` (head +
 * shoulders), right half is lucide `bot`'s head (rounded rect, antenna,
 * two eyes). Accepts the same props as a lucide icon.
 */
export function HumanAgentIcon({ strokeWidth = 2, className, ...rest }: LucideProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={24}
			height={24}
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden="true"
			{...rest}
		>
			{/* person (left) */}
			<circle cx="7.5" cy="7" r="3" />
			<path d="M2 21v-2a4.5 4.5 0 0 1 4.5-4.5h2A4.5 4.5 0 0 1 13 19v2" />
			{/* bot head (right) */}
			<rect x="13" y="10" width="9" height="8" rx="2" />
			<path d="M17.5 10V7" />
			<circle cx="17.5" cy="6" r="1" />
			<path d="M15.5 14v1" />
			<path d="M19.5 14v1" />
		</svg>
	);
}
```

- [ ] **Step 4: Run test** → PASS. `pnpm type-check` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): HumanAgentIcon for the merged Teams sidebar entry"`

### Task 0.3: Tab strip gets a first "Teams" tab

**Files:**

- Modify: `src/components/agents/AgentsPageTabs.tsx`
- Test: `src/components/agents/AgentsPageTabs.unit.spec.tsx`

**Produces:** `AgentsPageTabs({ active }: { active: 'teams' | 'agents' | 'sessions' | 'archived' })`, plus `export const TeamsPageTabs = AgentsPageTabs;`. Tab order: Teams (`ROUTES.DASHBOARD_TEAMS`), Agents, Sessions, Archived. Test ids unchanged: `agents-page-tabs`, `agents-page-tab-<key>`.

- [ ] **Step 1: Failing test** — mock `next-intl` (`useTranslations: () => (k) => k`) and `@/i18n/navigation` (`Link: ({href, children, ...p}) => <a href={href} {...p}>{children}</a>`) the way other `*.unit.spec.tsx` in `components/agents` do (look at `AgentCard.unit.spec.tsx` for the exact mocking idiom):

```tsx
it('renders Teams | Agents | Sessions | Archived in that order and marks the active one', () => {
	render(<AgentsPageTabs active="teams" />);
	const tabs = screen.getAllByRole('link');
	expect(tabs.map((a) => a.getAttribute('data-testid'))).toEqual([
		'agents-page-tab-teams',
		'agents-page-tab-agents',
		'agents-page-tab-sessions',
		'agents-page-tab-archived'
	]);
	expect(tabs[0].getAttribute('href')).toBe('/teams');
	expect(tabs[0].className).toContain('border-primary');
	expect(tabs[1].className).not.toContain('border-primary');
});
```

- [ ] **Step 2: Run** → FAIL (3 links, no teams tab).
- [ ] **Step 3: Implement** — extend the `active` union, prepend `{ key: 'teams', href: ROUTES.DASHBOARD_TEAMS, label: t('teams') }`, update the doc comment ("Teams hub tab strip: Teams | Agents | Sessions | Archived — rendered on `/teams`, `/agents`, `/agents/sessions`, `/agents/archived`"), add `export const TeamsPageTabs = AgentsPageTabs;` at the bottom.
- [ ] **Step 4: Run test** → PASS. `pnpm type-check`.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): Teams tab first in the Agents/Teams hub tab strip"`

---

## Phase 1 — Two independent lanes (may run in parallel; disjoint files)

### Lane A — Meetings → Memory

#### Task A.1: Shared meetings page-param helper

**Files:**

- Create: `src/lib/api/meetings-page-params.ts`
- Test: `src/lib/api/meetings-page-params.unit.spec.ts`

**Produces:**

```ts
export const MEETINGS_PAGE_SIZE = 12;
export interface MeetingsPageQuery {
	source?: MeetingSource;
	workId?: string;
	offset: number;
}
export function parseMeetingsSearchParams(params: Record<string, string | string[] | undefined>): MeetingsPageQuery;
export function buildMeetingsHref(
	basePath: string,
	input: { source?: MeetingSource; workId?: string; offset?: number },
	hash?: string
): string;
```

`parseMeetingsSearchParams` = the whitelisting the old `/meetings/page.tsx` did (source ∈ `MEETING_SOURCES`, workId must match the uuid regex, offset ≥ 0 int). `buildMeetingsHref('/memory', {source:'zoom'}, '#meetings')` → `'/memory?source=zoom#meetings'`; `buildMeetingsHref('/meetings', {})` → `'/meetings'`.

- [ ] **Step 1: Failing tests** covering: unknown source dropped; non-uuid workId dropped; negative/NaN offset → 0; href with/without qs and hash.
- [ ] **Step 2: Run** → FAIL. **Step 3:** implement (move the regex + `firstParam` from `meetings/page.tsx`). **Step 4:** PASS. **Step 5:** commit `refactor(web): extract meetings page-param parsing`.

#### Task A.2: `MeetingsList` gains `variant` + `basePath`

**Files:**

- Modify: `src/components/meetings/MeetingsList.tsx`
- Test: `src/components/meetings/MeetingsList.unit.spec.tsx` (create)

**Produces:** `MeetingsListProps` gains `variant?: 'page' | 'panel'` (default `'page'`), `basePath?: string` (default `'/meetings'`), `hash?: string` (default `''`). In `'panel'` variant: no `PageHeader`; instead a card wrapper `<section id="meetings" data-testid="meetings-shell" className="rounded-lg border p-4 bg-card dark:bg-card-primary-dark border-card-border dark:border-white/9 flex flex-col gap-4">` with a compact header row (Video icon tile `w-8 h-8 rounded-md bg-info/10 border border-info/20`, `<h2 className="text-sm font-semibold">{t('title')}</h2>`, subtitle `text-xs text-text-muted`, right-aligned **New meeting** button `href="/meetings/new"`), then the (optional) `hint` prop paragraph, then everything else as today. The filter `<form action={basePath + hash}>` (GET) and the **Reset** button href → `basePath + hash`; pagination hrefs are passed in already-built by the caller (unchanged). Keep every existing test id.

- [ ] **Step 1: Failing test**: render `variant="panel" basePath="/memory" hash="#meetings"` with one meeting → asserts no `h1`, presence of `#meetings` section, form `action="/memory#meetings"`, reset link href `/memory#meetings`, `meetings-grid` present. Mock `next-intl`, `@/i18n/navigation`, and `./MeetingCard` (`() => <div data-testid="meeting-card" />`).
- [ ] **Step 2** FAIL → **Step 3** implement → **Step 4** PASS + `pnpm type-check` → **Step 5** commit `feat(web): MeetingsList panel variant with rebased hrefs`.

#### Task A.3: `MemoryMeetingsPanel` + `MemoryShell` + `MemoryPage` + `/meetings` redirect + back-links

**Files:**

- Create: `src/components/memory/MemoryMeetingsPanel.tsx`
- Modify: `src/components/memory/index.ts` (export it), `src/components/memory/MemoryShell.tsx`, `src/app/[locale]/(dashboard)/memory/page.tsx`, `src/app/[locale]/(dashboard)/meetings/page.tsx`, `src/components/meetings/MeetingDetailClient.tsx` (lines ~460, ~473), `src/components/meetings/MeetingForm.tsx` (lines ~156, ~335)

**Produces:**

```ts
// MemoryMeetingsPanel.tsx ('use client')
export interface MemoryMeetingsData {
	meetings: Meeting[];
	works: MeetingWorkOption[];
	loadError: string | null;
	filters: { source?: MeetingSource; workId?: string };
	pagination: { offset: number; hasPrevious: boolean; hasNext: boolean; previousHref: string; nextHref: string };
}
export function MemoryMeetingsPanel({ data }: { data: MemoryMeetingsData }): JSX.Element;
// renders <MeetingsList variant="panel" basePath={ROUTES.DASHBOARD_MEMORY} hash="#meetings" hint={t('meetings.hint')} {...data} />
```

`MemoryShellProps` gains `meetings?: MemoryMeetingsData`; when present render `<MemoryMeetingsPanel data={meetings} />` **directly after `<AgentMemoryPanel />`** (before the consolidation error/preview blocks).

`MemoryPage({ searchParams })`: `const q = parseMeetingsSearchParams(await searchParams)`; fetch `memoryAPI.get` (as today) and, in parallel, `meetingsAPI.list({ ...q, limit: MEETINGS_PAGE_SIZE + 1 })` (try/catch → `loadError`) and `workAPI.getAll({ limit: 100 })` mapped to `{id,name}` with `.catch(() => [])`; build `pagination` with `buildMeetingsHref(ROUTES.DASHBOARD_MEMORY, {...}, '#meetings')`; pass `meetings` to `MemoryShell`.

`meetings/page.tsx` becomes:

```tsx
import { redirect } from '@/i18n/navigation';
import { getLocale } from 'next-intl/server';
import { buildMeetingsHref, parseMeetingsSearchParams } from '@/lib/api/meetings-page-params';
import { ROUTES } from '@/lib/constants';

/**
 * `/meetings` (index) — retired as a standalone page (navigation
 * consolidation): the Meetings catalog now lives as a block on the Memory
 * page. Kept as a redirect so bookmarks and older deep links keep working;
 * `/meetings/new` and `/meetings/[id]` are unchanged.
 */
export default async function MeetingsIndexRedirect({
	searchParams
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const q = parseMeetingsSearchParams(await searchParams);
	const locale = await getLocale();
	redirect({ href: buildMeetingsHref(ROUTES.DASHBOARD_MEMORY, q, '#meetings'), locale });
}
```

(Check `src/i18n/navigation.ts` for the exact `redirect` signature — next-intl v3 uses `redirect(href)` in some setups and `redirect({href, locale})` in others; use whatever the file exports and other pages already use — `grep -rn "redirect(" src/app | head`.)

Back-links: replace `ROUTES.DASHBOARD_MEETINGS` / `"/meetings"` in `MeetingDetailClient.tsx` (both) and `MeetingForm.tsx` (both) with `ROUTES.DASHBOARD_MEMORY_MEETINGS`.

- [ ] **Step 1: Failing unit test** for `MemoryShell` (extend or create `MemoryShell.unit.spec.tsx`): with `meetings` prop, `#meetings` section renders after `agent-memory-panel` in DOM order (`compareDocumentPosition`); without it, no `#meetings`. Mock the heavy panels (`./MemoryFilesPanel` etc.) with stubs — see how `MemoryFilesPanel.unit.spec.tsx` mocks fetch.
- [ ] **Step 2** FAIL → **Step 3** implement all files above → **Step 4** PASS, `pnpm type-check`, `pnpm lint` → **Step 5** commit `feat(web): Meetings catalog moves into the Memory page; /meetings redirects`.

#### Task A.4: e2e updates (meetings)

**Files:** `e2e/flow-meetings-ui-journey.spec.ts` (and `e2e/flow-memory-ui-journey.spec.ts` only if it enumerates panel order).

- [ ] Replace `page.goto('/en/meetings…')` for the **index** with `page.goto('/en/memory…#meetings')` keeping the same query strings; keep `/en/meetings/new` and `/en/meetings/<id>` as-is.
- [ ] Rewrite the "sidebar Meetings link routes to the catalog" test (line ~822) into two: (a) sidebar has **no** link whose href ends with `/meetings`; (b) `page.goto('/en/meetings?source=zoom')` ends at a URL matching `/\/en\/memory\?source=zoom(#meetings)?$/` (Playwright drops hashes from `page.url()` inconsistently — assert `new URL(page.url()).pathname === '/en/memory'` and `searchParams.get('source') === 'zoom'`).
- [ ] Any assertion on `h1` "Meetings" → assert `getByTestId('meetings-shell')` and `getByRole('heading', { name: /meetings/i })`.
- [ ] Commit `test(e2e): meetings journey follows the Memory page block`.

### Lane C — Skills → Agents tab block

#### Task C.1: `loadSkillsPageData` helper

**Files:**

- Create: `src/lib/skills-page-data.ts`, `src/lib/skills-page-data.unit.spec.ts`

**Produces:**

```ts
export const SKILLS_PAGE_SIZE = 50;
export type SkillsSection = 'installed' | 'available' | 'custom';
export interface SkillsPageFilters {
	section: SkillsSection;
	search: string;
	installedOffset: number;
	catalogOffset: number;
}
export function parseSkillsSearchParams(params: Record<string, string | string[] | undefined>): SkillsPageFilters;
export function buildSkillsHref(basePath: string, filters: SkillsPageFilters, hash?: string): string; // omits defaults, e.g. '/agents?section=custom#skills'
export interface SkillsPageData {
	installed: Skill[];
	installedMeta: { total: number; limit: number; offset: number };
	catalog: SkillCatalogEntry[];
	catalogTotal: number;
	catalogLimit: number;
	loadErrors: { installed: string | null; catalog: string | null };
}
export async function loadSkillsPageData(filters: SkillsPageFilters): Promise<SkillsPageData>; // the exact Promise.all + .then/.catch from the old skills/page.tsx
```

- [ ] Tests for `parseSkillsSearchParams` (bad section → installed, negative offset → 0, arrays take first) and `buildSkillsHref` (default filters → basePath+hash only; non-default → query). `loadSkillsPageData` is a thin wrapper over `skillsAPI` — mock `@/lib/api/skills` and assert the two error branches produce `loadErrors.installed === 'installed'` / `catalog === 'catalog'` with empty data.
- [ ] Commit `refactor(web): extract skills page data loading + param parsing`.

#### Task C.2: `SkillsPageClient.basePath` + `SkillsSection`

**Files:**

- Modify: `src/components/skills/SkillsPageClient.tsx` (props + `updateUrl` line ~88)
- Create: `src/components/skills/SkillsSection.tsx`, `src/components/skills/SkillsSection.unit.spec.tsx`

**Produces:**

- `SkillsPageClientProps` gains `basePath?: string` (default `ROUTES.DASHBOARD_SKILLS`) and `hash?: string` (default `''`); `updateUrl` → `router.replace(\`${basePath}${params.size ? \`?${params}\` : ''}${hash}\`)`.
- `SkillsSection({ data, filters }: { data: SkillsPageData; filters: SkillsPageFilters })` (client or server — it has no state of its own, so a **server** component is fine; `SkillsPageClient` inside is the client island): renders

```tsx
<section
	id="skills"
	data-testid="agents-skills-section"
	className="mt-10 rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 sm:p-6"
>
	<PageHeader
		icon={Sparkles}
		title={t('skillsBlock.title')}
		subtitle={t('skillsBlock.subtitle')}
		tone="success"
		actions={
			<>
				<Button href={ROUTES.DASHBOARD_SKILL_TEMPLATES} variant="secondary" size="sm">
					{tSkills('list.browseTemplates')}
				</Button>
				<Button href={ROUTES.DASHBOARD_SKILL_NEW} size="sm">
					<Plus className="w-3.5 h-3.5" aria-hidden="true" />
					{tSkills('list.newSkill')}
				</Button>
			</>
		}
	/>
	<SkillsPageClient {...data} filters={filters} basePath={ROUTES.DASHBOARD_AGENTS} hash="#skills" />
</section>
```

with `t = getTranslations('dashboard.agentsPage')`, `tSkills = getTranslations('dashboard.skillsPage')` (server) — if `PageHeader` renders an `h1`, pass a smaller heading: check `PageHeader` and, if it hard-codes `h1`, add an optional `as?: 'h1' | 'h2'` prop (default `'h1'`) and use `as="h2"` here so the Agents page keeps a single `h1`.

- [ ] **Step 1: Failing test** for `SkillsPageClient`: mock `@/i18n/navigation` `useRouter` → `{ replace: vi.fn() }`; render with `basePath="/agents" hash="#skills"`; click the "custom" tab; expect `replace` called with `'/agents?section=custom#skills'`. Second test: default props → `'/skills?section=custom'`.
- [ ] **Step 2** FAIL → **Step 3** implement → **Step 4** PASS → **Step 5** commit `feat(web): SkillsSection block + SkillsPageClient basePath`.

#### Task C.3: `/skills` redirect, back-links, revalidatePath, e2e

**Files:**

- Modify: `src/app/[locale]/(dashboard)/skills/page.tsx` → redirect to `buildSkillsHref(ROUTES.DASHBOARD_AGENTS, parseSkillsSearchParams(await searchParams), '#skills')` (same `redirect` idiom as Task A.3; doc comment mirrors it).
- Modify: `src/components/skills/SkillDetailClient.tsx` (~77 href, ~951 `router.push`) and `src/app/[locale]/(dashboard)/skills/templates/page.tsx` (~24) → `ROUTES.DASHBOARD_AGENTS_SKILLS`.
- Modify: `src/app/actions/skills.ts` (5 sites) and `src/app/actions/agent-capabilities.ts` (1 site): after each `revalidatePath('/skills')` add `revalidatePath('/agents')`.
- e2e: in `flow-skill-bulk-operations.spec.ts:714`, `flow-skill-crud-scoping.spec.ts:721`, `flow-skill-marketplace-share.spec.ts:578` change `goto('/skills')` → `goto('/agents#skills')` (keep `${origin}` prefix where used) and re-target any `h1`/title assertions to `getByTestId('agents-skills-section')`; grep `skills.spec.ts`, `skills-list-filter.spec.ts`, `sec-pin-skills-scoping.spec.ts` for `goto(` on `/skills` index (they looked API-only — confirm and leave alone if so).
- [ ] `pnpm type-check && pnpm lint && pnpm test -- skills` green → commit `feat(web): Skills catalog moves into the Agents tab; /skills redirects`.

---

## Phase 2 — Teams hub, Agents tab, Agents Chart, sidebar (after Phase 1 lane C, because it integrates `SkillsSection`)

### Task B.1: `/teams` becomes tab 1 of the hub

**Files:** `src/app/[locale]/(dashboard)/teams/page.tsx`

- [ ] Import `TeamsPageTabs` from `@/components/agents/AgentsPageTabs`; wrap **both** return branches: outer `<div className="w-full">` (replace `p-6 max-w-screen-2xl mx-auto`), first child `<TeamsPageTabs active="teams" />`, then the existing content unchanged. Header icon: swap `Users` for `HumanAgentIcon` from `@/components/icons/HumanAgentIcon` in the `PageHeader` only (keep `Users` for cards/empty states). Update the doc comment: "Teams hub — tab 1 of Teams | Agents | Sessions | Archived".
- [ ] `pnpm type-check` → commit `feat(web): Teams page renders as the first hub tab`.

### Task B.2: Agents tab — Agents Chart button + Skills block

**Files:** `src/app/[locale]/(dashboard)/agents/page.tsx`, `src/components/agents/AgentsList.tsx`

- [ ] `AgentsList` PageHeader: add `actions={<Button href={ROUTES.DASHBOARD_AGENTS_CHART} variant="secondary" size="sm" className="gap-1.5" data-testid="agents-chart-link"><Network className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />{t('agentsChartCta')}</Button>}` (import `Network` from lucide). Confirm `Button` forwards `data-testid` (grep `components/ui/button.tsx`); if not, wrap in a `<span data-testid>`.
- [ ] `AgentsPage({ searchParams })`: parse `parseSkillsSearchParams(await searchParams)`; add `loadSkillsPageData(filters)` to the existing `Promise.all`; render `<SkillsSection data={skills} filters={filters} />` after `<AgentsList … />`. Update the doc comment.
- [ ] Unit test (create `AgentsList.unit.spec.tsx` or extend an existing one): renders `agents-chart-link` with href `/agents/chart`.
- [ ] `pnpm type-check && pnpm lint` → commit `feat(web): Agents tab gets the Agents Chart button and the Skills block`.

### Task B.3: `/agents/chart` page

**Files:** Create `src/app/[locale]/(dashboard)/agents/chart/page.tsx`

- [ ] Copy `teams/org-chart/page.tsx` structure; translations `dashboard.agentsChartPage`; back-link `← {t('backToAgents')}` → `ROUTES.DASHBOARD_AGENTS`; test ids `agents-chart-no-org` / `agents-chart-empty`; `const agentsOnly = payload ? { ...payload, members: [] } : null; const isEmpty = !agentsOnly || agentsOnly.agents.length === 0;` then `<OrgChartClient payload={agentsOnly} />`. Doc comment: "Agents Chart — the org chart with human members stripped; teams still group agents and `reportsToAgentId` chains still nest (all in `buildOrgTree`, untouched)."
- [ ] `pnpm type-check` → commit `feat(web): Agents Chart page (org chart without human members)`.

### Task B.4: Sidebar

**Files:** `src/components/dashboard/DashboardSidebar.tsx` (navigation array lines 115–154, active check line ~307), unit spec (create `DashboardSidebar.unit.spec.tsx` if absent — check first: `ls src/components/dashboard/*.spec.tsx`).

- [ ] Navigation becomes (comments preserved/adapted):

```ts
const navigation: Array<{
	name: string;
	href: string;
	icon: LucideIcon | typeof HumanAgentIcon;
	matchPrefixes?: string[];
}> = [
	{ name: t('navigation.dashboard'), href: ROUTES.DASHBOARD, icon: Home },
	{ name: t('navigation.missions'), href: ROUTES.DASHBOARD_MISSIONS, icon: Target },
	{ name: t('navigation.goals'), href: '/goals', icon: Gauge },
	{ name: t('navigation.ideas'), href: ROUTES.DASHBOARD_IDEAS, icon: Lightbulb },
	{ name: t('navigation.works'), href: ROUTES.DASHBOARD_WORKS, icon: FolderClosed },
	{ name: t('navigation.tasks'), href: ROUTES.DASHBOARD_TASKS, icon: ListChecks },
	// Navigation consolidation — "Teams" is the hub for people AND agents
	// (tabs Teams | Agents | Sessions | Archived); Skills live on the Agents
	// tab. Active for /teams/*, /agents/*, /skills/* (skill detail pages).
	{
		name: t('navigation.teams'),
		href: ROUTES.DASHBOARD_TEAMS,
		icon: HumanAgentIcon,
		matchPrefixes: [ROUTES.DASHBOARD_TEAMS, ROUTES.DASHBOARD_AGENTS, ROUTES.DASHBOARD_SKILLS]
	},
	// Memory now also hosts the Meetings catalog; meeting detail/new pages
	// keep Memory highlighted.
	{
		name: t('navigation.memory'),
		href: ROUTES.DASHBOARD_MEMORY,
		icon: Brain,
		matchPrefixes: [ROUTES.DASHBOARD_MEMORY, ROUTES.DASHBOARD_MEETINGS]
	},
	{ name: t('navigation.templates'), href: ROUTES.DASHBOARD_TEMPLATES, icon: LayoutTemplate },
	{ name: t('navigation.plugins'), href: ROUTES.DASHBOARD_PLUGINS, icon: Plug },
	{ name: t('navigation.activity'), href: ROUTES.DASHBOARD_ACTIVITY, icon: Activity },
	{ name: t('navigation.settings'), href: ROUTES.DASHBOARD_SETTINGS, icon: Settings }
];
```

and the active check: `const prefixes = item.matchPrefixes ?? [item.href]; const isActive = prefixes.some((p) => pathname === p || pathname?.startsWith(p + '/'));`. Remove now-unused lucide imports (`Bot`, `Users`, `Sparkles`, `Video`) only if lint flags them (they are unused → yes, drop them; that is lint hygiene, not feature removal). Keep `key={item.name}` unique (Teams appears once).

- [ ] Unit test: mock `@/i18n/navigation` (`usePathname` → configurable, `Link` → `a`, `useRouter`), `next-intl`, `../works/detail/WorkDetailContext` (`useWorkDetail: () => ({ config: {} })`), `../layout/WorkspaceSwitcher`, `./RunnerStatusPill`, `./SidebarActivityIndicator`, `@/components/ai/ChatPanel` (`ChatPanelExpandButton: () => null`), `@/lib/hooks/use-mounted` (`() => true`), `@/app/actions/auth`. Render with a minimal `user`; assert link texts contain no `navigation.meetings` / `navigation.skills` / `navigation.agents`, contain `navigation.teams` exactly once with an `svg` child containing a `rect` (HumanAgentIcon), and that with `usePathname` = `/agents/abc` the Teams link has the active class (`bg-surface-secondary`), and with `/meetings/xyz` the Memory link does.
- [ ] `pnpm test -- DashboardSidebar && pnpm type-check && pnpm lint` → commit `feat(web): sidebar — Teams hub replaces Agents/Teams/Skills entries, Meetings folds into Memory`.

### Task B.5: e2e (teams/agents)

**Files:** `e2e/flow-teams-ui-journey.spec.ts`, `e2e/flow-agents-ui-journey.spec.ts`

- [ ] Teams journey: on `/en/teams` additionally `await expect(page.getByTestId('agents-page-tab-teams')).toBeVisible()`; any assertion on the page wrapper padding/`h1` unchanged (PageHeader stays).
- [ ] Agents journey: on `/en/agents` add `expect(page.getByTestId('agents-chart-link')).toHaveAttribute('href', /\/agents\/chart$/)` and `expect(page.getByTestId('agents-skills-section')).toBeVisible()`; add a test `page.goto('/en/agents/chart')` → either `agents-chart-empty` or the chart container is visible and `page.locator('[data-kind="member"]')` count is 0 (check `OrgChartClient` for how member cards are marked — if there is no attribute, add `data-node-kind={node.kind}` to the card wrapper in `OrgChartClient.tsx`; that is an additive attribute).
- [ ] Commit `test(e2e): teams hub tabs, agents chart, skills block`.

---

## Phase 3 — Verify, review, docs, PR

### Task V.1: Whole-app checks

- [ ] From `apps/web`: `pnpm type-check` · `pnpm lint` · `pnpm test` (all vitest) — all green; paste the summary lines into the PR body.
- [ ] `pnpm build` **only if** the machine has the RAM (Next build of this app is heavy); otherwise rely on type-check + the CI build.

### Task V.2: Docs

- [ ] `docs/features/agents-catalog.md`, `docs/features/skills-catalog.md`, `docs/features/index.md`, `docs/advanced/teams-and-organizations.md`, and the meetings/memory feature doc(s) found by `grep -ril "meetings" docs/features docs/advanced` — add/adjust one short paragraph each: where the feature now lives in the sidebar/tabs (`Teams → Agents tab → Skills block`, `Memory → Meetings block`, `Teams hub tabs`), and note that `/skills` and `/meetings` redirect. Commit `docs: navigation consolidation (Teams hub, Meetings in Memory, Skills in Agents)`.

### Task V.3: Review + PR

- [ ] Two independent review passes on the full diff (`git diff origin/develop...HEAD`): (1) correctness/regressions (redirects, params, RSC boundaries, i18n keys exist, test ids), (2) UX consistency vs spec (order of tabs, block placement, icon). Fix findings, re-run V.1.
- [ ] Push branch, open PR to `develop` titled `feat(web): navigation consolidation — Teams hub, Meetings in Memory, Skills in Agents`, body = spec §2 + §3.1 table + verification output. Do **not** merge; the owner reviews. Report the PR URL.

---

## Self-review (done while writing)

- Spec coverage: §3.1 (redirects A.3/C.3), §3.2 (B.4), §3.3 (0.3), §3.4 (B.1), §3.5 (B.2, C.1–C.3), §3.6 (B.3), §3.7 (A.1–A.4), §3.8 (0.1), §3.9 (0.1), §3.10 (per-task tests + A.4/B.5/C.3), §3.11 (V.2). ✔
- Type consistency: `SkillsPageData`/`SkillsPageFilters` (C.1) are what `SkillsSection` (C.2) and `AgentsPage` (B.2) consume; `MemoryMeetingsData` (A.3) is what `MemoryShell` consumes; `TeamsPageTabs` alias (0.3) used in B.1. ✔
