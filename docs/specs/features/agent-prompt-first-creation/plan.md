# Implementation Plan: Agent prompt-first creation & template chips

Companion to [spec.md](./spec.md). This is the _how_. Reuse-first: every prompt-first primitive already exists and is used by Missions/Ideas/`/new` — we wire them onto `/agents`, add one new chips component, fix the wizard, and land the backend catalog service.

## A. Frontend — prompt-first `/agents` page

**Files**

- `apps/web/src/app/[locale]/(dashboard)/agents/page.tsx` (server) — additionally fetch the template catalog and pass it down:
    ```ts
    const [agentsResult, templates] = await Promise.all([
      agentsAPI.list({ limit: 50 }).catch(() => ({ data: [], meta: { total: 0, limit: 50, offset: 0 } })),
      listAstTemplates('agent').catch(() => []),       // NFR-2: defensive
    ]);
    return <AgentsList agents={agentsResult.data} templates={templates} />;
    ```
- `apps/web/src/components/agents/AgentsList.tsx` (client) — becomes the prompt-first page client:
    - Add `PromptComposer` (model: `IdeasPageClient.tsx`) with `placeholderExamples` = the agent placeholders from `NewPageClient`.
    - `submit()` mirrors `NewPageClient`'s agent path: `startFromPrompt(description, { intent: 'Agent', attachments })` then `router.push(ROUTES.DASHBOARD_AGENT_NEW)`. Min-length guard `< 10`.
    - `chipsBelow={<AgentTemplateChips … />}` (new component, §B).
    - Move the `+ New Agent` button out of `PageHeader.actions`; render the `Or` block + `+ Create Agent Manually` below the composer.
    - Keep the existing cards grid + empty-state untouched below.
    - Auto-collapse the chat panel on mount (`useChatPanel().setOpen(false)`) like `NewPageClient`, so the prompt gets the column on first land.

**`Or` block** — match the Works treatment. A thin presentational block: a centered `Or` rule (flex with `before:`/`after:` borders) and the `+ Create Agent Manually` `Button` (`href={ROUTES.DASHBOARD_AGENT_NEW}`, `variant="secondary"`, `Plus` icon). Keep it inline in `AgentsList` (small) rather than a new shared component, unless the Works `CreationBlockTrio` already exposes a reusable `Or` — if so, reuse it.

## B. Frontend — `AgentTemplateChips` (new component)

`apps/web/src/components/agents/AgentTemplateChips.tsx` (client).

**Props**

```ts
interface AgentTemplateChipsProps {
	templates: AstTemplateEntry[]; // repo/fallback catalog
	userTemplates?: AstTemplateEntry[]; // "Your templates" (FR-16/29)
	onPick: (tpl: AstTemplateEntry) => void; // seed the prompt (FR-13)
}
```

**Behaviour**

- Build a `PromptChip[]` array: `[{ value: VIEW_ALL, label: t('chips.viewAll'), Icon: LayoutGrid }, ...templates.map(tpl => ({ value: tpl.slug, label: tpl.title, Icon: resolveIcon(tpl.iconName) }))]`.
- Render `<PromptChipsRow chips={chips} value={expanded ? VIEW_ALL : null} onChange={onChange} />`.
- `onChange(v)`: if `v === VIEW_ALL` → toggle `expanded`; else if `v` → `onPick(bySlug(v))` (do **not** persist selection — value stays `null` so no sticky highlight).
- When `expanded`, render the catalog panel: two `<section>`s ("All templates", "Your templates") each a card grid. Card click → `onPick(tpl)` + collapse (default), with a secondary "Open in wizard" link to `/agents/new?from=<slug>`. `Esc` collapses.
- Icon resolution: a small map from the curated lucide names used in `agent-templates.ts` (`ClipboardList`, `Code2`, `BookOpen`, plus the role icons we add — `Crown`/`Briefcase` for CEO, `Cpu`/`Wrench` for CTO, etc.). Fallback `Bot`.

**Chip seed semantics (spec Q1 default):** in `onPick`, the parent (`AgentsList`) sets the composer value: empty → `tpl.description` (or `"${tpl.title} — ${tpl.description}"`); non-empty → prepend `"${tpl.title} — "`. Then focus the input (`PromptComposer` exposes `inputId`; focus by id).

## C. Frontend — catalog client helper + global cache

`apps/web/src/lib/api/agent-templates.ts`:

- Keep the stable `AstTemplateEntry` shape and `listAstTemplates(entity)` signature (FR-28).
- **Extend the built-in fallback** `AGENT_TEMPLATES` with the named roles the operator listed — additive, keep PM/Coder/Researcher: add `CEO`, `CTO`, `Lead Engineer`, `Copywriter`, `Sales`, `Brand Specialist` (each with slug, title, description, category, iconName, tags). This guarantees the chips are populated _today_ (E2) before the repo lands.
- Add a **module-level cache** (FR-30): `const cache = new Map<AstTemplateEntityType, { at: number; data: AstTemplateEntry[] }>()` with a short client TTL; `listAstTemplates` checks it first. (Server reads go through the service's `cache_entries`.)
- Leave the documented swap-to-server-action path (per the existing file comment) — when the endpoint lands (§D) the fallback becomes the catch path.

## D. Backend — `AgentTemplateService` + endpoint (ADR-011)

**Service** `packages/agent/src/services/agent-template.service.ts` (or the agents module if one exists):

- `listTemplates(entity='agent'): Promise<AstTemplateEntry[]>`.
- Resolve source: `EVER_WORKS_AGENTS_PATH` (local clone) if set, else `git clone --depth 1 --branch $EVER_WORKS_AGENTS_REF(github.com/ever-works/agents)` into a temp dir (reuse `isomorphic-git`/existing git facade if it fits; otherwise a thin clone util). Use the official client / existing git util — **no hand-rolled HTTP** (NN #22).
- Parse each top-level folder: read `agent.yml` for `title`/`description`/`category`/`icon`/`tags`; validate against a Zod schema; skip + warn on invalid folders.
- Cache the parsed list in `cache_entries` keyed `agent-templates:agent:<ref>` with 1h TTL. Cache-first read; clone only on miss.
- Resilience (NFR-3): timeout the clone; on failure return `[]` (controller layer or client falls back).

**Endpoint** `apps/api/src/...` — `GET /agent-templates?entity=agent` → `AstTemplateEntry[]`. `@Public()` read is fine (catalog is public). Thin controller → service.

**Web wiring** — a server action `listAstTemplatesFromCatalogAction(entity)` that `serverFetch('/agent-templates?entity=…')`; `listAstTemplates` calls it and falls back to the built-in list on error (keeps the client bundle clean per the existing file's webpack note).

**Repo creation** — `ever-works/agents` may not exist yet. Creating/seeding it is a **shared-state action requiring operator approval** (spec Q4). The service + fallback are designed so the feature ships and works regardless; populating the repo flips chips from fallback to live with no code change.

## E. Wizard — `NewAgentDialog.tsx`

**Bug fix (FR-20/21/22)** — minimal, surgical:

- Add an inline helper under the scope list / above the buttons when `!canAdvance && !pinned`: e.g. `t('pickParentHint', { scope })` ("Pick a {scope} to continue, or choose Workspace scope").
- Add `title={canAdvance ? undefined : t('nextDisabledReason')}` to the Next `Button` so the disabled state is explained on hover/focus.
- Do **not** touch the `canAdvance` happy path for `tenant`.
- (The empty-scope hint already exists at `:245`; we make its consequence — disabled Next — legible.)

**Optional template step (FR-23/24/25)** — extend the step machine:

- Change `step` from `1 | 2` to a union `'template' | 'scope' | 'details'`. Initial: `pinned ? 'details' : 'template'`. Keep `?from=<slug>` → set template + `'details'` (current behaviour preserved).
- New prop `templates?: AstTemplateEntry[]` passed from `/agents/new` page (server-fetch `listAstTemplates('agent')`).
- `template` step: a card grid of templates + a prominent **"Start from scratch"** button. Selecting a template → `setTemplateSlug`, prefill `name`/`title`, → `'scope'`. "Start from scratch" → `'scope'`.
- Back navigation: `details → scope → template`.
- Guard: if `templates` is empty, skip the template step entirely (initial step becomes `'scope'`) so we never show an empty step.

`/agents/new/page.tsx` — add `templates={await listAstTemplates('agent').catch(() => [])}` to the `<NewAgentDialog>` props (alongside the existing missions/works/ideas fetch).

## F. i18n

Add keys under `dashboard.agentsPage` (e.g. `promptLabel`, `orDivider`, `createManually`, `chips.viewAll`, `catalog.allTemplates`, `catalog.yourTemplates`, `catalog.yourTemplatesEmpty`) and `dashboard.agentsPage.newDialog` (`templateStepTitle`, `startFromScratch`, `pickParentHint`, `nextDisabledReason`). Relabel `newAgent` is kept (still used as the manual button text) and add `createManually` = "Create Agent Manually". Write to **all 21** `apps/web/messages/*.json` (English placeholder where untranslated — NFR-4). Script the injection with a small node merge.

## G. Tests

- Unit: `AgentTemplateChips` (renders View All first; chip click calls `onPick`; View All toggles panel). Co-locate `*.unit.spec.tsx` like neighbours.
- Unit: `NewAgentDialog` — Workspace happy path still advances; Mission+empty shows hint and Next disabled with `title`; template step pre-fills + advances; `pinned` skips template step.
- Unit/`agent-templates.spec.ts`: fallback includes the named roles; `listAstTemplates('agent')` returns them; cache hit path.
- Backend: `AgentTemplateService` cache-hit / clone-miss / invalid-folder-skip / unreachable→[] (mock git + cache).
- E2E (Playwright) smoke: `/agents` renders composer + chips; `+ Create Agent Manually` routes to wizard. (Match existing agents e2e if present.)

## H. Sequencing / PRs

1. **PR 1 (frontend, no backend dep):** §A + §B + §C(fallback+cache) + §E + §F + §G(frontend). Delivers the full visible feature off the extended fallback catalog. Self-contained, reviewable.
2. **PR 2 (backend):** §D — `AgentTemplateService` + endpoint + server-action swap + §G(backend). Flips chips to live repo data. Depends on operator creating/seeding `ever-works/agents` (Q4) for non-fallback content, but ships safely either way.

Both target `develop`. Migrations only if "Your templates" needs a column (FR-29) — default v1 derives from existing Agents, so likely none.
