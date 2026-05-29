# Tasks: Agent prompt-first creation & template chips

Tracks [spec.md](./spec.md) / [plan.md](./plan.md). Jira Epic [EW-705](https://evertech.atlassian.net/browse/EW-705) + child stories EW-706…EW-709 (see the Epic for live status). `[x]` = landed on `develop`.

## Story 1 — Prompt-first `/agents` page + `Or` block (FR-1…FR-9) — [EW-706](https://evertech.atlassian.net/browse/EW-706)

- [ ] T1.1 `agents/page.tsx`: fetch `listAstTemplates('agent')` (defensive) + pass to `AgentsList`.
- [ ] T1.2 `AgentsList.tsx`: add `PromptComposer` with agent placeholders; `submit()` → `startFromPrompt(intent:'Agent')` + `router.push(DASHBOARD_AGENT_NEW)`; min-length 10; attachments via `buildAttachmentRefs`.
- [ ] T1.3 Move `+ New Agent` out of the header → `Or` block as `+ Create Agent Manually` (→ `DASHBOARD_AGENT_NEW`).
- [ ] T1.4 Auto-collapse chat panel on mount; keep cards grid + empty-state below.
- [ ] T1.5 Unit + e2e smoke (composer renders, manual button routes).

## Story 2 — Template chips + `View All` catalog (FR-10…FR-19) — [EW-707](https://evertech.atlassian.net/browse/EW-707)

- [ ] T2.1 `AgentTemplateChips.tsx`: `PromptChipsRow` with `View All` first + template chips; chip click → `onPick`; `View All` toggles panel.
- [ ] T2.2 `View All` panel: "All templates" + "Your templates" card grids; card click seeds prompt (+ "Open in wizard" secondary); `Esc` collapses.
- [ ] T2.3 Wire `AgentTemplateChips` into `AgentsList.chipsBelow`; implement chip-seed semantics (empty→full, non-empty→prepend role).
- [ ] T2.4 "Your templates" source from `agentsAPI.list()` (Q2 default) + empty-state nudge.
- [ ] T2.5 Unit tests.

## Story 3 — Wizard `Next` fix + optional template step (FR-20…FR-25) — [EW-708](https://evertech.atlassian.net/browse/EW-708)

- [ ] T3.1 Fix dead-end: inline hint + disabled-Next `title` + Workspace always advances; tenant happy path unchanged.
- [ ] T3.2 Step machine `'template' | 'scope' | 'details'`; initial `pinned ? 'details' : (templates.length ? 'template' : 'scope')`.
- [ ] T3.3 Template step UI: card grid + "Start from scratch"; select → prefill name/title → scope step; preserve `?from=<slug>`.
- [ ] T3.4 `/agents/new/page.tsx`: pass `templates`.
- [ ] T3.5 Unit tests (happy path, empty-scope, template prefill, pinned skip).

## Story 4 — Catalog backend: `AgentTemplateService` + endpoint (FR-26…FR-30) — [EW-709](https://evertech.atlassian.net/browse/EW-709)

- [ ] T4.1 Extend `agent-templates.ts` fallback with CEO/CTO/Lead Engineer/Copywriter/Sales/Brand Specialist (+ keep existing) and add module-level client cache.
- [ ] T4.2 `AgentTemplateService`: clone `ever-works/agents` (`EVER_WORKS_AGENTS_REF`/`_PATH`), parse + Zod-validate folders, cache in `cache_entries` 1h, fallback→[] on failure.
- [ ] T4.3 `GET /agent-templates?entity=agent` controller (`@Public()` read) → service.
- [ ] T4.4 `listAstTemplatesFromCatalogAction` server action + swap `listAstTemplates` to use it with built-in fallback on error.
- [ ] T4.5 Backend tests (cache-hit / clone-miss / invalid-skip / unreachable).
- [ ] T4.6 **Operator action (Q4):** create + seed `ever-works/agents` with the named role templates. Shared-state — needs approval; not done by the agent unilaterally.

## Cross-cutting

- [ ] X.1 i18n: add new keys to all 21 `apps/web/messages/*.json` (English placeholder where untranslated).
- [ ] X.2 `pnpm lint && pnpm type-check` clean for touched packages.
- [ ] X.3 Drive PR(s) through bot review + CI green (NN #14/#18/#19).

## Open decisions (mirror spec §8)

- Q1 chip-seed semantics (default: empty→full, non-empty→prepend role).
- Q2 "Your templates" source (default: user's existing Agents).
- Q3 catalog card → seed vs. wizard (default: seed; secondary "Open in wizard").
- Q4 create/seed `ever-works/agents` now? (operator decision — shared state).
