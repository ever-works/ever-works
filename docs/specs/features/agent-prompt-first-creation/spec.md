# Feature Specification: Agent prompt-first creation & template chips

**Feature ID**: `agent-prompt-first-creation`
**Branch**: `session/agent-prompt-first`
**Status**: `Draft`
**Created**: 2026-05-29
**Last updated**: 2026-05-29
**Owner**: Product (Ruslan)
**Jira**: Epic [EW-705](https://evertech.atlassian.net/browse/EW-705) — stories EW-706 (prompt-first + Or block), EW-707 (chips + View All), EW-708 (wizard fix + template step), EW-709 (catalog backend)

**Related code today**:

- Agents catalog page: `apps/web/src/app/[locale]/(dashboard)/agents/page.tsx`, `apps/web/src/components/agents/AgentsList.tsx`
- Manual create wizard: `apps/web/src/components/agents/NewAgentDialog.tsx` (rendered at `/agents/new`)
- Template browser (existing): `apps/web/src/app/[locale]/(dashboard)/agents/templates/page.tsx`
- Template client helper (fallback catalog today): `apps/web/src/lib/api/agent-templates.ts`
- Prompt-first primitives reused verbatim: `apps/web/src/components/common/PromptComposer.tsx`, `apps/web/src/components/common/PromptChipsRow.tsx`, `apps/web/src/lib/hooks/use-start-from-prompt.tsx`, `apps/web/src/lib/hooks/use-chat-panel.tsx`
- Reference implementations of the prompt-first list page: `apps/web/src/components/ideas/IdeasPageClient.tsx`, the unified `apps/web/src/components/new/NewPageClient.tsx`, and the Works manual/`Or` block in `apps/web/src/components/works/CreationBlockTrio.tsx`

> **Scope of this document:** the _creation UX_ for Agents — what the user sees and does when they create an Agent from the `/agents` page. It layers a prompt-first ("just describe it") entry point on top of the existing manual wizard, surfaces a community **template catalog** (CEO, CTO, Lead Engineer, Copywriter, Sales, Brand Specialist, …) as quick-pick chips, and fixes a wizard dead-end. It does **not** redefine what an Agent _is_, its runtime, scope cascade, budgets, or tabs — that lives in [`features/agents/spec.md`](../agents/spec.md). Implementation detail is in [plan.md](./plan.md); the task breakdown is in [tasks.md](./tasks.md).
>
> **Hard rule (additive only — [Workspace AGENTS.md NN #20](file:///C:/Coding/Workspace/AGENTS.md)):** Everything that ships today stays. The manual `NewAgentDialog` wizard is _kept_ and _improved_, never removed. The only thing that moves is the placement + label of one button (`+ New Agent` → `+ Create Agent Manually`), which the operator requested explicitly. The existing `/agents/templates` browser stays. New surfaces are added; nothing is renamed away.

---

## 1. Overview

Today the only way to create an Agent from `/agents` is the top-right **`+ New Agent`** button, which opens a two-step manual wizard (pick scope → name it). Every _other_ creatable entity in the product — Missions, Ideas, Works — opens with a **prompt-first** surface: a big `PromptComposer` where the user types what they want in plain language, the chat AI builds it, and a Canvas lets them edit in parallel. Agents are the odd one out.

This feature brings Agents to parity:

1. **Prompt-first on `/agents`.** A `PromptComposer` at the top of the page: the user types _"a research assistant that fetches AI-safety papers and summarises them weekly"_ and the chat AI takes it from there (Chat UI + Canvas), exactly like Missions/Ideas. (FR-1…FR-6)
2. **`Or` block + `+ Create Agent Manually`.** Below the composer, an `Or` divider and a single **`+ Create Agent Manually`** button (the relabelled, repositioned former `+ New Agent`) routes to the existing wizard for users who'd rather fill a form. Mirrors the Works page's `Or` treatment. (FR-7…FR-9)
3. **Template chips + `View All` catalog.** A horizontally-scrolling chip row under the prompt input shows agent-template names sourced from the community repo [`ever-works/agents`](https://github.com/ever-works/agents) (per [ADR-011](../../decisions/011-agent-templates-in-separate-repo.md)) — `CEO`, `CTO`, `Lead Engineer`, `Copywriter`, `Sales`, `Brand Specialist`, … The **first chip is `View All`**, which expands an inline catalog of _all_ repo templates **plus the user's own previously-created Agent templates**. Picking a chip seeds the prompt so the user can elaborate ("CTO who also owns our incident process…"). The catalog is globally cached so chips render instantly. (FR-10…FR-19)
4. **Wizard fix + optional template step.** The wizard's "Next does nothing" dead-end is fixed (FR-20…FR-22), and the wizard gains an **optional first step that lists the same templates** so the manual path can also start from a template. (FR-23…FR-25)

### Why now

The operator's instruction (2026-05-29):

> "In the Agents page, can we add our standard prompt there to create new Agent … same flow like we have on Missions / Ideas. The current button `+ New Agent` should just become `+ Create Agent Manually` and be positioned in the `Or` block, same as we did it in Works page. … do we have there a step that display existing Agents templates for user to select (optionally)? If not, we should have it because we should have a repo `github.com/ever-works/agents` … put `Chips` below input prompt … display names of agents templates … cached globally … first Chip as `View All` … expand full catalog of all Agents we have in the repo and also all agent templates user created before."

This spec records that instruction end-to-end so it can be implemented without re-deriving the intent.

---

## 2. User Scenarios

### 2.1 Primary scenarios

**S1 — Create an Agent from a free-text prompt.**
_Given_ a signed-in user on `/agents`,
_When_ they type _"PR triage agent that labels new community PRs and suggests reviewers"_ into the prompt composer and press ⏎ (or click Send),
_Then_ the chat side-panel opens with the message `I want to create a Agent. PR triage agent…` already sent, the user is routed to the Agent Canvas (`/agents/new`), and from there the chat AI guides creation while the Canvas form stays editable in parallel. (Mirrors `NewPageClient` agent-chip behaviour exactly.)

**S2 — Fall back to the manual wizard.**
_Given_ the same page,
_When_ the user ignores the prompt and clicks **`+ Create Agent Manually`** in the `Or` block,
_Then_ they land on the existing `NewAgentDialog` wizard at `/agents/new`.

**S3 — Quick-pick a template via a chip.**
_Given_ the chip row under the prompt shows `View All · CEO · CTO · Lead Engineer · Copywriter · Sales · Brand Specialist · …`,
_When_ the user clicks the **CTO** chip,
_Then_ the prompt input is seeded with a CTO-flavoured starter (the template's title + one-line description) and focused so the user can elaborate, and the chip row does not retain a persistent "selected" highlight.

**S4 — Browse the full catalog.**
_Given_ the chip row,
_When_ the user clicks the first chip **`View All`**,
_Then_ an inline panel expands below the composer showing two sections: **All templates** (every entry from `ever-works/agents`) and **Your templates** (Agents the user created before / saved as templates), each a responsive card grid. Clicking a card seeds the prompt (S3) or routes to the manual wizard pre-filled with that template (`/agents/new?from=<slug>`), and the panel collapses. Clicking `View All` again collapses the panel.

**S5 — Instant chips on a cold page.**
_Given_ a user opening `/agents` for the first time in a session,
_When_ the page renders,
_Then_ the template chips appear without a perceptible loading delay because the catalog is served from a globally-shared cache (server: `cache_entries`, 1h TTL per ADR-011; client: a module-level in-memory cache + revalidate).

**S6 — Start the manual wizard from a template.**
_Given_ the user clicked `+ Create Agent Manually`,
_When_ the wizard opens,
_Then_ its first (optional) step lists the same templates with a prominent **"Start from scratch"** escape hatch; picking a template pre-fills the name + title and advances to the scope step.

**S7 — Fresh account, Mission-scope, no Missions (the bug today).**
_Given_ a brand-new user with zero Missions/Works/Ideas in the manual wizard,
_When_ they select the **Mission** scope and look for a way forward,
_Then_ they see a clear inline explanation ("You don't have any Missions yet — create one first, or choose Workspace scope"), the disabled **Next** button carries a tooltip explaining why it's disabled, and choosing **Workspace** scope (always available) lets them proceed. (Today: Next is silently disabled with no path forward — see §E1.)

### 2.2 Edge cases & failures

**E1 — Wizard dead-end (the reported bug).** On `develop` today, selecting a non-`tenant` scope when the corresponding catalog is empty renders no parent `<select>` (it only renders when `parentOptions.length > 0`, [`NewAgentDialog.tsx:255`](../../../apps/web/src/components/agents/NewAgentDialog.tsx)), so `parentId` can never be set, `canAdvance` stays `false` ([`:173`](../../../apps/web/src/components/agents/NewAgentDialog.tsx)), and the **Next** button is permanently disabled with no feedback. The user perceives "clicking Next does nothing." **MUST be fixed** (FR-20).

**E2 — Catalog unreachable.** If `ever-works/agents` can't be fetched and the cache is cold, the chip row degrades to the built-in fallback list (still includes CEO/CTO/… so the feature is never empty) and `View All` shows only "Your templates". No error toast; a subtle "Showing built-in templates" note is acceptable. (Mirrors ADR-011 §Consequences/Negative mitigation.)

**E3 — User has no saved templates.** The `View All` panel's "Your templates" section renders an empty-state nudge ("Agents you create can be saved as templates and will appear here") rather than an empty grid.

**E4 — Prompt too short.** The composer enforces the same min-length guard the other surfaces use (`< 10` chars → inline toast `hints.minLength`), so a stray ⏎ on an empty box doesn't dispatch a chat message.

**E5 — Chip seed overwrites a typed prompt.** If the user already typed something and then clicks a chip, the seed is **appended/merged**, not destructively replaced, OR a confirm is skipped in favour of prepending the role label — see [plan.md §Chip seed semantics](./plan.md). Default: if the box is empty, seed fully; if non-empty, prepend the role label only (`CTO — <existing text>`).

**E6 — Locale without translated strings.** New UI strings ship in all 21 `apps/web/messages/*.json` locale files (English placeholder values where not yet translated) so non-`en` locales don't hit missing-message fallbacks.

---

## 3. Functional Requirements

Numbered, atomic, testable. `MUST` / `SHOULD` / `MUST NOT` per Spec Kit convention.

### 3.1 Prompt-first surface on `/agents`

- **FR-1** The `/agents` page MUST render a `PromptComposer` above the Agent list, using the shared component (`@/components/common/PromptComposer`) — the same primitive Missions/Ideas/`/new` use.
- **FR-2** The composer MUST cycle Agent-specific placeholder examples (reuse the four agent placeholders already defined in `NewPageClient` `PLACEHOLDERS_BY_CHIP.agent`).
- **FR-3** On submit the page MUST call `useStartFromPrompt()(description, { intent: 'Agent', attachments })` and then `router.push(ROUTES.DASHBOARD_AGENT_NEW)` — i.e. dispatch the prompt into the chat AI and route to the Agent Canvas. It MUST NOT re-create the Agent twice or pass `?prompt=` to the canvas.
- **FR-4** The composer MUST enforce the shared `< 10`-char min-length guard before dispatching.
- **FR-5** The composer MUST support attachments via the existing `+` affordance and forward them through `buildAttachmentRefs`.
- **FR-6** The Agent list (cards grid + empty state) MUST continue to render below the new surface, unchanged in behaviour.

### 3.2 `Or` block + manual button

- **FR-7** The page MUST render an **`Or`** divider between the prompt-first surface and a manual-create affordance, visually consistent with the Works page treatment.
- **FR-8** The former header button labelled `+ New Agent` MUST be relabelled **`+ Create Agent Manually`** and MUST live in the `Or` block (not the page header). It MUST route to `ROUTES.DASHBOARD_AGENT_NEW` (the existing wizard).
- **FR-9** No other entry point to the wizard is removed — sidebar, deep links, and `/agents/new` direct navigation MUST all keep working.

### 3.3 Template chips

- **FR-10** Below the prompt input the page MUST render a horizontally-scrolling chip row using the shared `PromptChipsRow` look-and-feel (arrow paging, edge gradients, keyboard a11y).
- **FR-11** The chip row's **first** chip MUST be **`View All`** (distinct icon, e.g. `LayoutGrid`).
- **FR-12** Subsequent chips MUST be agent-template names from the catalog (`CEO`, `CTO`, `Lead Engineer`, `Copywriter`, `Sales`, `Brand Specialist`, …), in catalog order.
- **FR-13** Clicking a template chip MUST seed the prompt (per §E5 semantics) and focus the composer input. It MUST NOT immediately create an Agent and MUST NOT leave a persistent selected-chip highlight.
- **FR-14** Clicking `View All` MUST toggle an inline catalog panel (FR-16). While open, `View All` MAY render as the active chip.
- **FR-15** The catalog used for chips MUST come from `listAstTemplates('agent')` (the stable client helper), which returns repo data when available and a built-in fallback otherwise (E2). Chips MUST render from cache with no perceptible delay (FR-30/NFR-1).

### 3.4 `View All` catalog panel

- **FR-16** Expanding `View All` MUST show two labelled sections: **All templates** (catalog entries from `ever-works/agents`) and **Your templates** (Agents the signed-in user created before / saved as templates).
- **FR-17** Each catalog entry MUST render as a card (icon + title + one-line description + optional category tag). Clicking a card MUST either seed the prompt (default) or route to `/agents/new?from=<slug>` (the wizard pre-fill path the dialog already supports), then collapse the panel.
- **FR-18** The "Your templates" section MUST render an empty-state nudge when the user has none (E3).
- **FR-19** The panel MUST be keyboard-navigable and dismissible (collapse via `View All` or `Esc`).

### 3.5 Wizard fix + optional template step

- **FR-20** The `NewAgentDialog` MUST NOT present a dead-end: when a non-`tenant` scope is selected but has zero parent candidates, the dialog MUST (a) show an inline explanation, (b) give the disabled **Next** a `title`/tooltip stating why it's disabled, and (c) keep **Workspace** scope selectable so the user can always advance.
- **FR-21** The dialog SHOULD surface a one-line helper near the **Next** button whenever `!canAdvance`, telling the user what to do (pick a parent, or switch to Workspace).
- **FR-22** The fix MUST NOT change the happy path: with the default `tenant` scope, **Next** stays enabled and advances exactly as today.
- **FR-23** The wizard MUST gain an **optional** template-selection step shown first (skipped when the dialog is `pinned` to a scope-parent). It MUST list the same `agent` templates as the chips plus a prominent **"Start from scratch"** option.
- **FR-24** Selecting a template in the wizard MUST pre-fill `name` (template title) and `title` (template description, truncated) and advance to the scope step. "Start from scratch" MUST advance with empty fields.
- **FR-25** The existing `?from=<slug>` deep-link behaviour (pre-fill from the `/agents/templates` browser) MUST continue to work.

### 3.6 Catalog source, caching, and backend

- **FR-26** Agent templates MUST be sourced from the [`ever-works/agents`](https://github.com/ever-works/agents) repo per [ADR-011](../../decisions/011-agent-templates-in-separate-repo.md) — **not** hard-coded in the platform monorepo as the long-term source ([ADR-014](../../decisions/014-no-hardcoded-catalogs.md)). The built-in list in `agent-templates.ts` is an explicitly-documented fallback bridge only (E2), not the source of truth.
- **FR-27** The backend MUST expose `GET /agent-templates?entity=agent` (auth-optional read) returning the catalog as `AstTemplateEntry[]` (stable shape already defined in `agent-templates.ts`), backed by an `AgentTemplateService` that `git clone --depth 1`s the repo (pinned by `EVER_WORKS_AGENTS_REF`, default `main`; local override `EVER_WORKS_AGENTS_PATH`), caches the parsed list in `cache_entries` for 1h, and validates each template folder against a schema (bad folders skipped with a warning).
- **FR-28** `listAstTemplates('agent')` MUST be swapped to call the new endpoint (via a server action so the web client bundle stays clean — see the note in `agent-templates.ts`) while keeping its return type stable so the chips, the `View All` panel, and the wizard step need no change when the swap lands.
- **FR-29** "Your templates" MUST be sourced from the user's existing Agents (and, when the save-as-template capability lands, explicitly-saved templates). v1 MAY derive it from `agentsAPI.list()` filtered to a `isTemplate`/draft marker; the exact source is a [plan.md](./plan.md) decision, but the UI contract (a list of `AstTemplateEntry`-shaped cards) is fixed here.
- **FR-30** The client MUST cache the catalog globally for the session (module-level cache keyed by entity type) so re-renders and route revisits don't refetch within the TTL.

---

## 4. Non-Functional Requirements

- **NFR-1** Template chips MUST paint within the first render of `/agents` (server-fetched + passed as props, or hydrated from the global cache) — no spinner on the chip row in the common case.
- **NFR-2** The prompt-first surface MUST NOT regress `/agents` server-render time meaningfully; the template fetch MUST be defensive (`.catch(() => fallback)`) so a flaky catalog never 500s the page (mirrors the existing `agentsAPI.list().catch(...)`).
- **NFR-3** The `AgentTemplateService` clone/cache MUST be resilient: cold cache + unreachable repo → fallback, never a hard failure (E2). Network calls MUST have a timeout.
- **NFR-4** All new user-facing strings MUST exist in every `apps/web/messages/*.json` locale file (E6).
- **NFR-5** No secrets/credentials are introduced; the repo clone is public/unauthenticated read (NN #6 — credentials assumed handled; nothing logged).
- **NFR-6** Accessibility: chips and catalog cards MUST be keyboard-operable and screen-reader labelled, consistent with `PromptChipsRow`'s existing a11y.

---

## 5. Key Entities & Domain Concepts

| Concept                    | One-line definition                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prompt-first surface**   | The `PromptComposer` + chips block at the top of `/agents` that turns a free-text description into a chat-driven Agent build.                                                                |
| **`Or` block**             | A divider + `+ Create Agent Manually` button offering the manual wizard as the explicit alternative to the prompt.                                                                           |
| **Agent template**         | A reusable Agent definition (`agent.yml` + `SOUL.md`/`AGENTS.md`/`HEARTBEAT.md`/`TOOLS.md`) living in `ever-works/agents`; surfaced as a chip and a catalog card. Shape: `AstTemplateEntry`. |
| **Template chip**          | A quick-pick pill (`CEO`, `CTO`, …) that seeds the prompt. The first chip `View All` instead expands the catalog.                                                                            |
| **`View All` catalog**     | The inline expand showing all repo templates + the user's own templates.                                                                                                                     |
| **`AgentTemplateService`** | The backend service that clones + caches `ever-works/agents` and serves the catalog (ADR-011).                                                                                               |

---

## 6. Out of Scope (this slice)

- A full standalone "Hire an Agent" marketplace with search, ratings, install counts (the broader catalog vision; this slice only adds chips + an inline `View All`). Tracked separately under [`features/agents/spec.md §6`](../agents/spec.md).
- The community-contribution / PR-review lifecycle of `ever-works/agents` (curation policy, schema CI, tagged releases) — owned by ADR-011 ops notes, not this UX slice.
- A "save this Agent as a template" authoring flow. v1 derives "Your templates" from existing Agents; explicit save-as-template is a follow-up (FR-29 leaves the hook).
- Changing what an Agent _is_, its runtime, scope cascade, budgets, or detail tabs.

---

## 7. Acceptance Criteria

- [ ] `/agents` shows a prompt composer; submitting a ≥10-char prompt opens chat with `I want to create a Agent. …` and routes to `/agents/new`.
- [ ] The header no longer shows `+ New Agent`; an `Or` block shows `+ Create Agent Manually` routing to the wizard.
- [ ] A chip row renders under the prompt with `View All` first, then `CEO/CTO/Lead Engineer/Copywriter/Sales/Brand Specialist/…`; clicking a template chip seeds + focuses the prompt.
- [ ] Clicking `View All` expands a catalog with "All templates" + "Your templates"; clicking a card seeds the prompt (or opens the wizard pre-filled) and collapses the panel.
- [ ] Chips render with no spinner on a warm cache; with the catalog unreachable, built-in fallback chips still render.
- [ ] In the wizard, selecting Mission scope with zero Missions shows a clear hint + disabled-Next tooltip, and Workspace scope still advances. The `tenant` happy path is unchanged.
- [ ] The wizard's optional template step lists templates + "Start from scratch"; picking one pre-fills name/title and advances; `?from=<slug>` still pre-fills.
- [ ] `GET /agent-templates?entity=agent` returns the catalog; `listAstTemplates('agent')` consumes it with the fallback intact; all existing Agent tests still pass.
- [ ] New strings exist in all 21 locale files.

---

## 8. Open Questions

- **[NEEDS CLARIFICATION: Q1]** Chip seed semantics when the prompt box is non-empty — prepend role label vs. append vs. replace-with-confirm. **Default for v1:** seed fully if empty, prepend `"<Role> — "` if non-empty (E5).
- **[NEEDS CLARIFICATION: Q2]** "Your templates" source in v1 — derive from `agentsAPI.list()` (all the user's Agents as re-usable starting points) vs. only Agents explicitly marked `isTemplate`. **Default:** show the user's existing Agents as starting points; refine when save-as-template ships (FR-29).
- **[NEEDS CLARIFICATION: Q3]** Does clicking a catalog card seed the prompt or jump straight to the wizard pre-filled? **Default:** seed the prompt (keeps the prompt-first flow primary); offer a secondary "Open in wizard" affordance on the card.
- **[NEEDS CLARIFICATION: Q4]** Should the `ever-works/agents` repo be created + seeded with the named roles (CEO, CTO, …) as part of this work, or is the fallback list sufficient for v1 launch while the repo is populated separately? **Operator decision needed** — repo creation is a shared-state action.

## 9. Constitution Gates

- [x] **I — Plugin-First**. No new plugin. Reuses AI facade + chat. `AgentTemplateService` is a core service (cold-path catalog read), consistent with ADR-011.
- [x] **III — Source-of-Truth Repositories**. Templates live in `ever-works/agents`, not the monorepo (ADR-011/014). Fallback is a documented bridge only.
- [x] **V — Forward-Only Migrations**. No schema change required (reuses existing `cache_entries`); if any column is added for "Your templates" it ships with an additive migration (NN #16).
- [x] **IX — Behaviour-First Specs**. This spec is behaviour; implementation is in plan.md.
- [x] **X — Backwards Compatibility**. Additive only; the wizard and `/agents/templates` browser stay; one button is relabelled/repositioned per explicit operator request.

## 10. References

- Plan: [`./plan.md`](./plan.md)
- Tasks: [`./tasks.md`](./tasks.md)
- Parent feature: [`../agents/spec.md`](../agents/spec.md)
- Prompt-first precedent: [`../missions-ideas-works/spec.md`](../missions-ideas-works/spec.md)
- ADR-011 (agent templates repo): [`../../decisions/011-agent-templates-in-separate-repo.md`](../../decisions/011-agent-templates-in-separate-repo.md)
- ADR-014 (no hardcoded catalogs): [`../../decisions/014-no-hardcoded-catalogs.md`](../../decisions/014-no-hardcoded-catalogs.md)
