# ADR-011: Agent templates live in a separate community repo, not in the platform monorepo

## Status

**Proposed — 2026-05-25.** Operator instruction during round 5 review of UX-DESIGN doc.

## Date

2026-05-25

## Context

The Agents feature ships with starter templates (CEO, CTO, Researcher, PR-Reviewer, Editor, Designer, …) so first-time users hit the "wow moment" without authoring `SOUL.md` from a blank page. Each template is a folder containing `agent.yml` + `SOUL.md` + `AGENTS.md` + `HEARTBEAT.md` + `TOOLS.md`, and (optionally) a `skills/` subfolder with bundled skills.

Two storage strategies were considered:

1. **In the platform monorepo** — `apps/api/src/agents/starters/<slug>/`, read at boot, version-locked with platform code. Same posture as **Skills catalog** (ADR-007).
2. **In a separate GitHub repo** `ever-works/agents` — cloned/cached at runtime, versioned independently, community-PR friendly. Same posture as **Mission Templates** (which are also external repos that get forked).

The operator's instruction (round 5 review of `UX-DESIGN-agents-skills-tasks.md`):

> "Default starter agents — we don't want to store them in `apps/api/src/agents/starters/<slug>/`, instead let's use separate repo `https://github.com/ever-works/agents` for example. We can store there tons of prebuilt agents templates etc."

This ADR records that decision.

## Decision

**Agent templates live in the separate repo [`ever-works/agents`](https://github.com/ever-works/agents).**

Concrete arrangement:

- The repo's top level holds one folder per template: `ceo/`, `cto/`, `researcher/`, `pr-reviewer/`, `editor/`, `designer/`, …
- Each folder is a complete Agent definition: `agent.yml` (metadata + sensible defaults for cadence/permissions) + `SOUL.md` + `AGENTS.md` + `HEARTBEAT.md` + `TOOLS.md`. Optional `skills/<slug>.md` bundled skills.
- The repo has its own `README.md` documenting the format + contribution guide.
- The platform's `AgentTemplateService` (new) `git clone --depth 1` the repo on demand (cached for 1 hour in `cache_entries`), lists templates, and **copies** the chosen folder into the user's target storage on selection.
- When the user picks a template, the chosen template's files are copied into:
    - `<missionRepo>/.works/agents/<slug>/` for Mission-scoped Agents, OR
    - `<workDataRepo>/.works/agents/<slug>/` for Work-scoped Agents, OR
    - DB-inline columns on the `agents` row for Tenant-scoped Agents without a control repo (per [ADR-008](./008-tenant-control-repo-deferred-to-v2.md)).
- Modifications to the user's local copy never propagate back to the source repo. The template is a starting point, not a live subscription.

The repo is **MIT-licensed** so the templates can be reused widely (including by non-AGPL projects) and to maximize the community contribution surface. **Note: the platform itself is AGPLv3** (see `LICENSE`) — the catalog content is intentionally licensed under a more permissive scheme so it's separable from platform code. This split is documented further in [ADR-014 §"License posture"](./014-no-hardcoded-catalogs.md).

## Why this diverges from ADR-007 (Skills in-monorepo)

ADR-007 keeps the Skill catalog inside the platform monorepo. ADR-011 puts Agent templates in a separate repo. They look superficially similar — why the split?

| Aspect                              | Skills catalog (ADR-007)                                 | Agent templates (this ADR)                                                              |
| ----------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Unit shape**                      | Single MD file                                            | Folder with 5 files + optional sub-tree of bundled skills                               |
| **Expected volume at maturity**     | ~1000+ entries                                            | ~100+ entries                                                                            |
| **Read pattern**                    | Read at every Agent run's prompt-assembly (hot path)      | Read only at template selection time (cold path; once per Agent create)                  |
| **Versioning per entry**            | Frequent — skills evolve as platform AI capabilities do  | Infrequent — Agent personas are mostly stable                                            |
| **Atomic deploy with platform code** | Important — Skill body format may evolve with code        | Not important — Agent template format is stable                                          |
| **Community contribution velocity** | Lower; skills are tighter to platform semantics           | Higher; "I made an Agent for X profession" is broadly approachable                       |
| **Fork-on-use semantics**           | No — install copies the body, but it's still bound to catalog | Yes — pick once, then user-owned forever; never re-pulled                                 |

The decisive differences: **Agent templates are cold-path** (read once per Agent create, not per AI call), and **community velocity matters more** for personas than for skills. Putting Agent templates in a separate repo gives community contributors a low-friction surface (PR to a small repo) without exposing them to the platform's build/test apparatus.

The Mission Templates infrastructure (already on develop) has exactly this shape: separate repos cloned + forked. Agent templates re-use that mental model.

## Consequences

### Positive

- **Community contribution surface.** Anyone can PR a new template — "Compliance Officer", "Children's Author", "Investor Relations" — without touching the platform repo.
- **No monorepo bloat.** As templates grow into the hundreds, the platform repo stays small.
- **Aligns with Mission Templates precedent.** One mental model for "templates I can pick from"; both Mission Templates and Agent templates work the same way.
- **Independent versioning.** A template can ship a v1.1 without a platform release.
- **Easier for AI assistants to read.** The repo is small + focused; an LLM can scan all templates to suggest one matching the user's intent.

### Negative

- **One more repo to maintain.** Ever Works team owns curation; lifecycle for community PRs (review, merge, deprecation) needs to be established.
- **Network dependency at runtime.** If `github.com` is unreachable during the 1h cache window, template selection fails. Mitigated by: cache persists; UI surfaces a clear error if cache is empty AND network is down ("Templates unavailable — create from scratch").
- **Diverges from Skills catalog posture.** Two storage strategies for similar-looking concepts. Mitigated by: the differences are documented (table above) and the in-monorepo vs separate-repo lines are drawn intentionally.

### Mitigations

- **Cache-first reads** — `AgentTemplateService` reads from `cache_entries` first; falls back to repo clone only when cache is empty/stale.
- **Repo schema validation** — each template folder validated against a Zod schema on read; bad folders skipped with a warning.
- **Pinning** — `AgentTemplateService` reads from a specific tagged release of `ever-works/agents` (configurable env var `EVER_WORKS_AGENTS_REF`, default `main`). Platform deploys can pin to a known-good ref.
- **Local override** — for self-hosted users who want to run without internet, `EVER_WORKS_AGENTS_PATH` env var can point at a local clone.

## Alternatives Considered

### 1. In-monorepo (parallel to ADR-007)

**Rejected per operator instruction.** The volume + community-contribution case favors a separate repo.

### 2. Hybrid — ship 6 curated starters in-monorepo, community templates in the external repo

**Rejected.** Adds a "where does this template live?" branch in every read path. Operator's instruction picks one strategy.

### 3. DB-seeded catalog

**Rejected.** Same trade-offs as in ADR-007 — loses Git review, harder to diff in PRs, requires migration for every catalog change.

### 4. NPM package

**Rejected.** Heavier than needed for static markdown. NPM also doesn't have a natural community-contribution UX.

## Operational notes

- Repo: [`ever-works/agents`](https://github.com/ever-works/agents) — to be created if not yet present.
- License: MIT (intentionally permissive for content reuse — the platform itself is AGPLv3; see ADR-014 §"License posture").
- Top-level files: `README.md` (format + contribution guide), `LICENSE`, `.github/` workflows (lint MD + validate `agent.yml` against schema).
- Each template folder: `agent.yml` + `SOUL.md` + `AGENTS.md` + `HEARTBEAT.md` + `TOOLS.md` (+ optional `skills/`).
- Tagged releases — semver per template aggregate; platform `EVER_WORKS_AGENTS_REF` env var picks the ref.

## Related

- ADR-007: [Skill catalog in-monorepo](./007-skill-catalog-in-monorepo.md) — sibling decision, opposite outcome (for documented reasons).
- ADR-008: [Tenant control repo deferred](./008-tenant-control-repo-deferred-to-v2.md) — where Tenant Agent files land when no control repo.
- ADR-010: [Templates stay independent](./010-templates-stay-independent-for-v1.md) — meta-decision about catalog unification.
- [`features/UX-DESIGN-agents-skills-tasks.md §4.1`](../features/UX-DESIGN-agents-skills-tasks.md) — the create-Agent dialog flow that consumes templates.
- [`architecture/implementation-reuse-map.md`](../architecture/implementation-reuse-map.md) — the `AgentTemplateService` row.
- Mission Templates precedent: [`packages/agent/src/missions/mission-template.config.ts`](../../packages/agent/src/missions/mission-template.config.ts) — separate repos, fork-on-use.
