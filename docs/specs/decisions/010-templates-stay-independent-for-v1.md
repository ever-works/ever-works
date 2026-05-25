# ADR-010: Templates stay independent for v1 (no unified "Workshop Templates" catalog)

## Status

**Proposed — 2026-05-25.** Pending operator review on [QUESTIONS R1](../QUESTIONS-agents-skills-tasks.md#r1--unified-workshop-templates-catalog).

## Date

2026-05-25

## Context

By the end of this spec set, the platform will have at least five "template-like" catalogs / starter sets:

1. **Mission Templates** — already on develop. In-repo TS constants at `packages/agent/src/missions/mission-template.config.ts`; surfaced via `TemplateCatalogService` on `/templates` page.
2. **Website / Work Templates** — already on develop. Same `TemplateCatalogService`; users can fork.
3. **Skill catalog** — proposed in [features/skills/spec.md](../features/skills/spec.md). In-repo MD files at `apps/api/src/skills/catalog/<slug>/<slug>.md`.
4. **Agent templates** — proposed in [features/UX-DESIGN-agents-skills-tasks.md §4.1](../features/UX-DESIGN-agents-skills-tasks.md). Stored in a **separate community repo** [`ever-works/agents`](https://github.com/ever-works/agents) — one folder per template with `agent.yml` + `SOUL.md` + `AGENTS.md` + `HEARTBEAT.md` + `TOOLS.md`. ~6 starters at launch (CEO, CTO, Researcher, PR-Reviewer, Editor, Designer); community can PR more. See [ADR-011](./011-agent-templates-in-separate-repo.md) for why this diverges from Skill catalog's in-monorepo posture.
5. **Task templates** — proposed in [features/task-tracking/spec.md §5.4](../features/task-tracking/spec.md), deferred. 3 starters envisioned (bug-report, pr-review, weekly-status).

This pattern emerged organically as each feature shipped its own catalog. The natural architectural question: **should we unify them under a single "Workshop Templates" registry**?

Pros of unifying:
- Single mental model for users browsing for starters.
- One UI surface (`/templates` already has tabs by kind via TemplatesCatalog kind-switch, recent PR W) — could host all five.
- Shared lifecycle: versioning, installed-vs-available pattern, "Update available" prompt.
- Shared catalog repo path (potentially out-of-monorepo if the Skill catalog grows past 1k entries).

Cons of unifying:
- Each kind has different semantics: Mission Templates are FORKED (cloned repo), Skills are INSTALLED (copied bytes), Agents are SCAFFOLDED (copied files into existing repo), Task templates are PREFILLED (form pre-population). Forcing them through one interface either (a) creates an awkward union type that handles all four poorly, or (b) collapses real differences.
- Mission Templates and Work Templates already share infra; adding 3 more kinds means a larger refactor.
- Each catalog has a different governance model: Mission Templates are curated by Ever Works team; Skills will likely accept community PRs; Agent starters are platform-controlled.

## Decision

**For v1: independent services per catalog kind, but the `/templates` page provides a unified browse experience via a kind-selector — AND each feature page (`/agents`, `/skills`, `/tasks`) also has its own templates browser scoped to its kind.** Both UIs read from the same per-kind backend services; the user can manage templates from whichever surface is convenient.

Per operator instruction (round 6):
> "Such Templates can be all managed on 'Templates' page, yes. I.e. I would prefer there to add selector for many different types of templates. However, also it's best to have ability to manage separately Agent templates on Agents page, same as Skills templates (catalog) on Skills page and so on. So it's fine to have in few places."

### Concrete arrangement

**Backend services — independent per kind:**
- `TemplateCatalogService` (existing) — Mission + Work Templates.
- `AgentTemplateService` (new) — clones + caches [`ever-works/agents`](https://github.com/ever-works/agents); copies a chosen template into a Mission/Work repo or DB-inline storage.
- **`SkillsFacadeService` + `"Ever Works Skills"` plugin** (per [ADR-012](./012-skills-as-plugin.md)) — Skill catalog comes from the plugin, which reads [`ever-works/skills`](https://github.com/ever-works/skills).
- **`TasksFacadeService` + `"Ever Works Task Tracker"` plugin** (per [ADR-013](./013-task-tracking-as-plugin.md)) — Task templates come from [`ever-works/task-templates`](https://github.com/ever-works/task-templates), bundled into the first-party tracker plugin.

**Frontend surfaces — both unified hub AND per-feature pages:**
- **`/templates` page** — unified hub with a kind-selector (Mission / Work / Agent / Skill / Task). Tab strip or dropdown switches the visible kind. Each tab calls the relevant backend service.
- **`/agents` page** — has its own "Browse templates" section / button surfacing Agent templates from `AgentTemplateService`.
- **`/skills` page** — surfaces the Skill catalog from `SkillsFacadeService`.
- **`/tasks` page / New Task dialog** — surfaces Task templates from `TasksFacadeService`.

Both surfaces are first-class — the user picks whichever flow is convenient. Implementation cost is small: shared `<TemplatesBrowser kind="..." />` React component used in all surfaces.

### Why this isn't "unified into one entity"

The DB-level union into a single `WorkshopTemplate` table is still rejected. The frontend hub + per-feature pages read from the same per-kind backend services — they don't share a storage shape. The UI is convergent; the data is not. This avoids the half-typed-column anti-pattern from [ADR-009 §3.3](./009-tasks-vs-items-vs-kb-distinction.md).

## Consequences

### Positive

- **Each catalog evolves at its own pace.** Skills can sprout a contribution PR template without affecting Mission Templates' fork workflow.
- **No premature abstraction.** Avoids a `BaseTemplate` interface that's never quite right for all four.
- **Smaller v1 surface.** No new "/workshop" page; no new entity table.
- **Each feature spec stays self-contained.** Easier review.

### Negative

- **No "browse all templates" experience.** A user looking for "ways to start" hits 3 different pages. Mitigated by: each surface CTAs to the most relevant first; cross-links between them.
- **Some duplication of UX patterns.** "Installed / Available" appears in `/templates`, `/skills`, `/plugins`. Mitigated by: extracting a shared `<CatalogGrid>` component if patterns truly converge.
- **Future consolidation will be a refactor.** Not free.

### Mitigations

- All four catalog services expose a similar minimal interface (`list()`, `getById(id)`, `install(id)`) so a v2 unifier can wrap them without invasive changes.
- The `/templates` page's tab strip is structured so adding a "Skills" or "Agents" tab later is a small UI change.

## Alternatives Considered

### 1. Unify into one `WorkshopTemplate` table from day one

**Rejected.** Discriminator-union pattern (per [ADR-009 §3.3](./009-tasks-vs-items-vs-kb-distinction.md)) tends to produce half-typed columns nobody fully uses. Mission Templates and Skills have ~zero shared columns once we strip kind.

### 2. Ship Mission + Work + Skill via the existing `TemplateCatalogService`; keep Agent starters + Task templates separate

**Rejected for v1.** Mid-strategy. Either commit fully (option 1) or stay independent. Mixing draws complexity without payoff.

### 3. No catalog for Agents — users always start from blank

**Rejected.** The wow-moment design ([UX-DESIGN §1](../features/UX-DESIGN-agents-skills-tasks.md)) depends on starters. Without them, first-Agent setup is too high-friction.

## Related

- ADR-007: Skill catalog in-monorepo (parallel decision for one of the catalogs).
- [`features/UX-DESIGN-agents-skills-tasks.md` §4.1`](../features/UX-DESIGN-agents-skills-tasks.md).
- Mission Templates: [`packages/agent/src/missions/mission-template.config.ts`](../../packages/agent/src/missions/mission-template.config.ts).
- Existing `/templates` page: [`apps/web/src/components/templates/TemplatesCatalog.tsx`](../../apps/web/src/components/templates/TemplatesCatalog.tsx).
