# Feature Specification: Skills

**Feature ID**: `skills`
**Branch**: `feat/skills`
**Status**: `Draft`
**Created**: 2026-05-25
**Last updated**: 2026-05-25
**Owner**: Product (Ruslan)

**Related code today**:

- AI facade: `packages/agent/src/facades/ai.facade.ts`, `base.facade.ts`
- Advanced prompts (analog): `packages/agent/src/entities/work-advanced-prompts.entity.ts`, `apps/api/src/work-advanced-prompts/`
- Plugins page UI: `apps/web/src/components/plugins/PluginsList.tsx`, `apps/web/src/app/[locale]/(dashboard)/plugins/page.tsx`
- KB editor: `apps/web/src/components/works/detail/kb/KbEditor.tsx`
- Works config schema: `packages/agent/src/works-config/services/works-config.service.ts`

> **Scope**: Skills are markdown-defined, reusable, scoped capability files that Agents (see [agents/spec.md](../agents/spec.md)) attach to themselves, and that Generators inject into AI calls. They follow Anthropic's progressive-disclosure Skill shape (frontmatter `name`/`description`/`allowed-tools` + markdown body).
>
> **Hard rule (additive)**: Nothing existing changes. The `WorkAdvancedPrompts` mechanism stays. The Plugins page stays. We add a new Skills sidebar entry, a Skills tab on Work / Mission / Agent detail pages, and an injection hook in `AiFacadeService.assembleSystemMessage`.

---

## 0. Implementation packaging (per ADR-012)

**Skills are a plugin capability** — see [ADR-012](../../decisions/012-skills-as-plugin.md). The product behavior described in this spec is unchanged for end users; what changes from the round-1 design is that the catalog and CRUD layer ship as a plugin (`"Ever Works Skills"`, default first-party) rather than as in-monorepo code:

- The default catalog source: **[`ever-works/skills`](https://github.com/ever-works/skills)** Git repo (per [ADR-014](../../decisions/014-no-hardcoded-catalogs.md)).
- Plugin contract: `ISkillsProviderPlugin` in `packages/plugin/src/contracts/capabilities/skills-provider.interface.ts`.
- Facade: `SkillsFacadeService` mirrors `AiFacadeService` — UI and Agents talk only to the facade.
- Multiple providers can be enabled simultaneously; resolved skills come from the union, deduplicated by slug.

Throughout this spec, references to "the catalog" / "catalog service" / "in-monorepo files" should be read as the **first-party `"Ever Works Skills"` plugin's content**, sourced from the `ever-works/skills` repo.

## 1. Overview

A **Skill** is a markdown file shaped exactly like Anthropic Skills:

```markdown
---
name: pr-review
description: Review a pull request and post inline comments grouped by severity.
allowed-tools: [github, semgrep]
---

# Steps

1. Fetch the PR diff.
2. ...
```

Skills live in a 5-tier hierarchy:

1. **Platform catalog** — shipped with the platform under `apps/api/src/skills/catalog/`; ~1000+ entries expected over time.
2. **Tenant installed** — a user has chosen to install a catalog skill (or authored a custom skill) at the tenant level.
3. **Mission installed** — a Mission has installed a skill (visible to anything in that Mission).
4. **Work installed** / **Idea installed** — the skill is bound to a specific Work or Idea.
5. **Agent-private** — a skill attached only to one Agent; not visible to siblings.

A Skill becomes **active** when bound to an Agent (with `skill_bindings.injectIntoAgent = true`) or to a Work/Mission/Idea Generator (with `skill_bindings.injectIntoGenerator = true`). Active skills are injected into the system message of any AI call made by that Agent/Generator. By default, only the Skill's `description` + a body excerpt are injected (progressive disclosure); the AI provider can request the full body on demand.

Authoring of Skills happens in the same Tiptap editor used for KB documents. Skill files for Mission/Work scopes live in the scope's Git repo under `.works/skills/<slug>.md`; tenant skills live inline (DB-only) until a control repo exists (parallel to the Agent file-storage decision in [agents/spec.md §3.6](../agents/spec.md)).

## 2. User Scenarios

### 2.1 Primary scenarios

**S1 — Install a platform-catalog skill at tenant level.**
*Given* a user on `/skills` page seeing the platform catalog,
*When* they click "Install" on the `pr-review` skill,
*Then* a `skills` row with `ownerType='tenant'`, `ownerId=userId`, `slug='pr-review'`, `contentHash=<copy>` is created, `SKILL_INSTALLED` activity row emitted, and the skill appears in the "Installed" section of the page.

**S2 — Author a custom Skill at tenant level.**
*Given* a user clicking "+ New Skill",
*When* they fill `name`, `description`, body, optional `allowed-tools`,
*Then* the skill is saved (DB-only for tenant scope today), `SKILL_INSTALLED` row emitted.

**S3 — Attach a Skill to one Agent.**
*Given* a user on `/agents/<id>/skills`,
*When* they toggle the `pr-review` skill on,
*Then* a `skill_bindings(skillId, targetType='agent', targetId=agentId, injectIntoAgent=true)` row is created. Activity row `SKILL_ATTACHED_TO_AGENT` emitted.

**S4 — Inject a Skill into a Work generator.**
*Given* a user on the new **Skills tab** of a Work detail page (between Generator and Plugins),
*When* they enable the `pr-review` skill there,
*Then* `skill_bindings(skillId, targetType='work', targetId=workId, injectIntoGenerator=true)` is created. The next Work generation includes the skill's frontmatter description (and a body excerpt) in the system message.

**S5 — Skill body request on demand.**
*Given* an Agent run where the model determines it needs the full body of `pr-review`,
*When* the model calls a `getSkillBody({slug})` tool,
*Then* the full body is returned in the next message, `SKILL_INVOKED` activity row emitted with `details: {agentId, skillSlug, source: 'on-demand'}`.

**S6 — Mission Template ships a skill.**
*Given* a Mission Template repo whose `.works/mission.yml` declares `skills: [{slug: 'pr-review', path: '.works/skills/pr-review.md'}]`,
*When* a user instantiates a Mission from it,
*Then* the file is copied into the new mission repo, a `skills(ownerType='mission', ownerId=missionId)` row is created. The skill is auto-bound to every Agent that ships with the template (per its agent.yml `skills:` list).

**S7 — Edit a Tenant Skill that has no control repo.**
*Given* a tenant skill stored DB-only,
*When* the user opens the body in the Tiptap editor and saves changes,
*Then* the DB row body is updated, content-hash recomputed.

**S8 — Edit a Mission Skill (Git mode).**
*Given* a Mission skill at `<missionRepo>/.works/skills/pr-review.md`,
*When* the user saves edits,
*Then* `GitFacadeService.commit()` writes the file; the `skills.contentHash` is updated to the new sha256; `SKILL_FILE_EDITED` activity row emitted.

### 2.2 Edge cases & failures

**E1 — Skill slug collision within a scope.** `UNIQUE(ownerType, ownerId, slug)`. Duplicate name within scope returns 409. Same slug across scopes is allowed (a Mission skill and a Tenant skill may both be `pr-review`).

**E2 — Catalog skill installed twice at the same scope.** The "Install" action becomes idempotent — second call returns 200 with the existing row.

**E3 — Inject budget exceeded.** A single AI call has a `maxSkillContextTokens` budget (default 4000). If the bound skills' (description + excerpt) bytes would exceed the budget, the system MUST drop the lowest-priority skills first (priority = explicit field on `skill_bindings`, default 100 lower = higher priority). UI shows the truncation in a tooltip.

**E4 — Frontmatter malformed.** Save is rejected with a precise error pointing at the offending field. Same Zod validator on read.

**E5 — `allowed-tools` references unknown plugin id.** Save warns but doesn't reject; injection skips unknown tool references in `allowed-tools` to avoid a false-positive in tool resolution.

**E6 — Cross-scope visibility.** A Work skill is NOT visible to siblings (other Works). A Mission skill IS visible to all child Ideas / Works of that Mission for binding purposes. A Tenant skill is visible everywhere the user owns.

**E7 — Catalog skill source changes.** Platform catalog skills carry a `version` field. When a tenant has installed v1 and v2 ships, the user sees an "Update available" badge on `/skills` and can opt into the update (manual; no auto-update).

## 3. Functional Requirements

### 3.1 Persistence

- **FR-1** The system MUST persist a `skills` table with columns `id, slug, title, description, instructionsMd, frontmatter (jsonb), ownerType, ownerId, scope, version, contentHash, sourcePath, sourceCatalogSlug, sourceCatalogVersion, createdAt, updatedAt`.
- **FR-2** The system MUST enforce `UNIQUE(ownerType, ownerId, slug)` (E1).
- **FR-3** The system MUST persist a `skill_bindings` table linking a `skillId` to a `targetType ∈ {agent, work, mission, idea, tenant}` + `targetId` plus boolean flags `injectIntoAgent`, `injectIntoGenerator`, and integer `priority` (default 100).

### 3.2 Catalog

- **FR-4** The platform catalog MUST be shipped as files under `apps/api/src/skills/catalog/<slug>/<slug>.md` (one folder per skill so future per-skill assets can sit alongside).
- **FR-5** The catalog MUST be readable at `GET /skills/catalog` (returns a paginated list with title + description + version + tags).
- **FR-6** Catalog skills MUST never be written to from runtime; "installing" a catalog skill creates a `skills` row that **copies** the body and tracks the original via `sourceCatalogSlug` + `sourceCatalogVersion`.
- **FR-7** When the catalog version of a skill bumps, the platform MUST surface an "Update available" affordance to tenants who installed the previous version; updates are explicit (user-initiated), never automatic.

### 3.3 Hierarchy & resolution

- **FR-8** When an Agent or Generator resolves "what skills are active?", the system MUST union all `skill_bindings` rows where:
    - `targetType='agent' AND targetId=agentId` (Agent-private + Agent attachments)
    - `targetType='work' AND targetId=agent.workId` (if Agent or Generator is Work-scoped)
    - `targetType='idea' AND targetId=agent.ideaId`
    - `targetType='mission' AND targetId=agent.missionId`
    - `targetType='tenant' AND targetId=agent.userId`
- **FR-9** Resolved set MUST be de-duplicated by `slug` with priority: agent > work > idea > mission > tenant (so an Agent-private skill shadows a tenant skill of the same slug).
- **FR-10** The resolver MUST be a single repository method `SkillBindingRepository.resolveActive({agentId?, workId?, missionId?, ideaId?, userId})` with explicit unit tests for every combination.

### 3.4 Injection into AI calls

- **FR-11** `AiFacadeService.assembleSystemMessage(context)` (new public method) MUST accept `{ skills: ResolvedSkill[], maxSkillContextTokens: number }` and return a system-message string that includes a `## Skills` section containing per-skill `### <name> — <description>` blocks with the first ~200 chars of the body and a `(call getSkillBody('<slug>') for full text)` hint.
- **FR-12** Token budgeting: if the assembled section exceeds `maxSkillContextTokens`, the system MUST drop the lowest-priority skills first and emit a structured warning to the run-log.
- **FR-13** The `getSkillBody` tool MUST be auto-registered for any AI call that has resolved skills attached. Tool returns `{slug, body}` for the requested slug.
- **FR-14** When the model invokes a skill (detected heuristically by mentioning the skill's `<name>` in its reasoning or by calling `getSkillBody`), the system MUST emit a `SKILL_INVOKED` activity row.

### 3.5 File storage

- **FR-15** For Mission-scoped skills, the markdown body MUST be persisted to `<missionRepo>/.works/skills/<slug>.md` via `GitFacadeService.commit()` on every UI save.
- **FR-16** For Work/Idea-scoped skills, same pattern under the Work's data repo (`<workDataRepo>/.works/skills/<slug>.md`).
- **FR-17** For Agent-private skills, file lives under `<scopeRepo>/.works/agents/<agent-slug>/skills/<skill-slug>.md`.
- **FR-18** Tenant-scoped skills MUST be stored in `skills.instructionsMd` TEXT column inline when no control repo exists. Same DB-only fallback as Tenant Agents.

### 3.6 Web UI

- **FR-19** The sidebar MUST gain a "Skills" item directly below "Plugins".
- **FR-20** `/skills` page MUST show three sections, matching the Plugins page UX:
    - **Installed (tenant)** — `skills` rows where `ownerType='tenant'`.
    - **Available** — the platform catalog with "Install" / "Update available" / "Installed" badges.
    - **Custom** — user-authored skills (subset of Installed; surfaced separately for editing).
- **FR-21** The page MUST support filter chips by tag (frontmatter `tags: []`), a search box across `name` + `description`, and a "Show only installed" toggle.
- **FR-22** Clicking a skill MUST open `/skills/[id]` with two tabs: **Body** (Tiptap editor) and **Bindings** (lists where it's bound today, with an "Attach to..." action).
- **FR-23** The Agent detail page MUST gain a "Skills" tab showing (a) skills attached to this Agent (toggle on/off), (b) skills inherited from scope (read-only with the source labeled), (c) "+ Attach from catalog" affordance.
- **FR-24** The Work detail page MUST gain a "Skills" tab between Generator and Plugins. UI mirrors the Plugins tab visually (Installed + Available + Inherit-from-Mission/Tenant).
- **FR-25** The Mission and Idea detail pages MUST gain identical "Skills" tabs.

### 3.7 YAML cross-references

- **FR-26** `works.yml` MUST accept an optional `skills:` array of `{slug, path}` entries pointing to files in the repo.
- **FR-27** `mission.yml` (Mission Template manifest + per-Mission `.works/mission.yml`) MUST accept the same.
- **FR-28** On Mission Template instantiation, all `skills:` entries MUST be copied to the new Mission repo and matching `skills` rows materialized in DB.

### 3.8 Skill catalog scaffolding

- **FR-29** The platform MUST ship with a starter set of ≥10 example skills covering common verbs: `pr-review`, `release-notes`, `kb-summarize`, `image-alt-text`, `seo-meta`, `internal-link-suggestions`, `competitive-research`, `commit-message-format`, `test-coverage-gap`, `dependency-bump-checklist`.
- **FR-30** Catalog skill files MUST live at `apps/api/src/skills/catalog/<slug>/<slug>.md` with companion `metadata.json` (tags, default `allowed-tools`, version).

## 4. Non-Functional Requirements

### 4.1 Performance

- **NFR-1** `GET /skills/catalog?limit=50` p95 < 200 ms; catalog read is in-process file IO (or in-memory after first read).
- **NFR-2** `SkillBindingRepository.resolveActive` p95 < 30 ms for a fully-bound Agent (≤50 active skills).
- **NFR-3** System-message assembly with 50 active skills and a 4000-token budget completes within 50 ms.

### 4.2 Reliability

- **NFR-4** Catalog file IO failures MUST NOT crash the AI call — affected skills are skipped with a logged warning.
- **NFR-5** A malformed installed skill (e.g. corrupted frontmatter after a manual Git edit) MUST be flagged in the UI with a "broken" badge and excluded from active-resolution, never silently injected.

### 4.3 Security & privacy

- **NFR-6** Skill `instructionsMd` MUST be secret-scanned on every save with the same regex as Agent files.
- **NFR-7** Cross-user access to a `skills` row MUST 404.

### 4.4 Compatibility

- **NFR-8** A Work generator with no `skills:` configuration MUST behave exactly as today (no injection, no overhead).
- **NFR-9** The existing `WorkAdvancedPrompts` feature MUST be unaffected — it stays the recommended path for "tweak this Work's system prompt directly"; Skills are the path for "reusable, named, cross-scope capabilities."

## 5. Key Entities & Domain Concepts

| Concept            | Definition                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Skill**          | Markdown file with frontmatter (name/description/allowed-tools) + body. Reusable AI capability.                                                                          |
| **Skill Catalog**  | Read-only repo-shipped collection at `apps/api/src/skills/catalog/`. Source of truth for "Available" tab.                                                                |
| **SkillBinding**   | Row attaching a Skill to a target (agent/work/mission/idea/tenant) with `injectIntoAgent` and/or `injectIntoGenerator` booleans + priority.                              |
| **Active set**     | The de-duplicated, priority-resolved list of Skills available to a given AI call.                                                                                       |
| **Progressive disclosure** | Default injection mode: description + body excerpt only; full body fetched on demand via `getSkillBody` tool.                                                    |
| **maxSkillContextTokens** | Per-Agent (default 4000) / per-Generator (default 2000) token budget for the assembled `## Skills` section.                                                       |

## 6. `works.yml` / `mission.yml` schema additions

```yaml
# additive — none of the existing fields change
skills:
    - slug: pr-review
      path: .works/skills/pr-review.md
    - slug: release-notes
      path: .works/skills/release-notes.md
```

## 6.1 Skill versioning

Each `skills` row carries `version: string` (semver). Convention:

- `1.0.0` initial.
- Patch bump on body wording fix that doesn't change behavior.
- Minor bump on add-an-example, broaden-applicability changes.
- Major bump on changing the skill's contract — e.g. renaming the parameters the skill expects, dropping `allowed-tools` entries, requiring a different output format.

Catalog skills carry `version` too. On bump, tenants see "Update available" — they choose explicitly whether to update their installed copies (per [QUESTIONS E2](../../QUESTIONS-agents-skills-tasks.md#e2--skill-catalog-updates-auto-pull-new-version-or-always-manual)).

Tenant-authored skills version on every `PATCH /skills/:id` by an opt-in `?bumpVersion=patch|minor|major` query param; default is "no bump" (overwrites in place).

## 6.2 Skill composition: not in v1

Skills do NOT reference other skills in v1 (no `extends:` / `includes:` frontmatter field). Resolver stays simple. See [QUESTIONS E4](../../QUESTIONS-agents-skills-tasks.md#e4--skill-composition-can-a-skill-reference-another-skill).

## 6.3 `examples:` frontmatter

Skills may include an optional `examples` array in frontmatter — short before/after pairs that anchor the model. They're injected after the body excerpt if budget allows.

```yaml
---
name: pr-review
description: Review a pull request and post inline comments.
allowed-tools: [github, semgrep]
examples:
    - input: "PR adds a new SQL query without prepared statements."
      output: "P0 SQL-injection risk; flag inline with severity P0."
    - input: "PR renames a variable for clarity."
      output: "No findings; approve without comment."
---
```

## 6.4 `allowed-tools` mapping rules

Frontmatter `allowed-tools: [<plugin-id>]` lists plugin IDs (e.g. `github`, `semgrep`, `tavily`). v1 treats this as **descriptive** — see [QUESTIONS E3](../../QUESTIONS-agents-skills-tasks.md#e3--allowed-tools-frontmatter-enforce-as-acl-or-descriptive-only). The actual ACL is governed by:

- The host **Agent's** `permissions.canCallExternalTools` flag (global gate).
- The host **Agent's** `TOOLS.md` file (per-tool annotations).

When a Skill is bound to a Work Generator (not an Agent), `allowed-tools` are filtered against the Work's enabled plugins — if `github` plugin isn't enabled on the Work, the skill is still injected but the tool isn't registered for that call.

## 6.5 Skill localization: English-only in v1

Catalog skills ship English-only; tenant-authored skills are whatever the user writes. v2 may add per-locale frontmatter fields (`description.en`, `description.fr`) — see [QUESTIONS E5](../../QUESTIONS-agents-skills-tasks.md#e5--skill-localization-how-is-description-shown-in-users-language).

## 6.6 Testing a skill manually

The Skill detail page gains a "Try this skill" affordance: a small panel where the user types a sample input and the platform calls a quick AI completion with just that skill injected. Returns the response inline. No persistent storage — just a sanity-check.

Implementation: reuses the existing `AiFacadeService.createChatCompletion()` path with `system = assembleSystemMessage({skills: [this], maxTokens: 4000})` and `complexity: 'simple'`. Cost charged to the tenant's account.

## 7. Out of Scope (v1)

- Cross-tenant Skill sharing / marketplace (publish a Tenant Skill to others).
- Versioned diff/merge of installed skill vs catalog updates. v1 surfaces "Update available" but the merge is an overwrite.
- Per-Skill cost telemetry separate from per-Agent telemetry. v1 attributes cost to the Agent, not the Skill.
- Tool-call-graph view ("which skills triggered which tool calls in which runs"). v1 emits `SKILL_INVOKED` events; the visualization is v2.
- Auto-suggestion of skills based on Agent prompt content. v2.
- Skill-package format (multi-file skill with assets / templates). v1 = single MD file; v2 may extend.

## 8. Acceptance Criteria

- [ ] Catalog page `/skills` lists ≥10 starter skills with descriptions.
- [ ] User installs `pr-review` at tenant level → row appears in `skills`, `SKILL_INSTALLED` activity row emitted.
- [ ] User authors a custom skill → it appears under "Custom".
- [ ] User attaches `pr-review` to Agent CEO → `skill_bindings` row created; CEO's next heartbeat assembled system prompt contains a `## Skills` section.
- [ ] User enables `pr-review` on Work X's Skills tab → next Work generation injects it into its system prompt.
- [ ] Mission template that declares 1 skill produces 1 `skills` row + 1 file in the new mission repo on instantiation.
- [ ] Token budget enforcement drops lowest-priority skills when bound set exceeds the cap; warning row in `agent_run_logs`.
- [ ] `SKILL_INVOKED` row appears when an Agent calls `getSkillBody`.
- [ ] Malformed frontmatter rejected on save with a precise error.
- [ ] Existing `WorkAdvancedPrompts` behavior unchanged (regression test in apps/api).

## 9. Open Questions

- **[NEEDS CLARIFICATION: Q1]** Should the catalog be a separate repo (like Mission Templates) or in-monorepo? Default: **in-monorepo** under `apps/api/src/skills/catalog/` — fastest to ship, simplest to ship updates atomically with code. Move to a dedicated repo only if catalog grows beyond ~10 MB.
- **[NEEDS CLARIFICATION: Q2]** Are `allowed-tools` references enforced as ACL? Default: **descriptive only** in v1; the actual tool ACL is governed by Agent permissions (`TOOLS.md`). Skills can hint, not enforce.
- **[NEEDS CLARIFICATION: Q3]** Should "global tenant skills auto-attach to new Agents"? Default: **no** — explicit attachment per Agent; otherwise the prompt budget gets noisy fast.
- **[NEEDS CLARIFICATION: Q4]** Skill mention in chat: should `@skill:pr-review` in a Task chat message trigger an Agent to invoke that skill? **Defer to v2** — interesting but adds parsing surface.

## 10. Constitution Gates

- [x] **I — Plugin-First**. Skills are NOT a plugin category. The reserved future plugin capability `task-tracker` is unrelated. No new plugins shipped.
- [x] **II — Capability-Driven Resolution**. Skill injection happens inside `AiFacadeService`; no provider-specific code path.
- [x] **III — Source-of-Truth Repositories**. Skill files live in Git for Mission/Work scopes; tenant skills DB-only until control repo lands (parallel to Agents Q1).
- [x] **IV — Background Work via Trigger.dev**. N/A — skill resolution is synchronous within an AI call.
- [x] **V — Forward-Only Migrations**. Two new tables additive.
- [x] **VI — Tests Prerequisite**. Resolver unit tests, catalog read tests, end-to-end "install → bind → inject" Playwright test.
- [x] **VII — Secret Hygiene**. Same secret-scan as Agent files.
- [x] **VIII — Plugin Counts Single Source**. N/A.
- [x] **IX — Behaviour-First Specs**. This spec is behavior; plan owns implementation.
- [x] **X — Backwards Compatibility**. `skills:` arrays in YAML optional; default off.

## 11. References

- Plan: [`./plan.md`](./plan.md)
- Tasks: [`./tasks.md`](./tasks.md)
- UX spec: [`../UX-DESIGN-agents-skills-tasks.md`](../UX-DESIGN-agents-skills-tasks.md)
- Reuse map: [`../../architecture/implementation-reuse-map.md`](../../architecture/implementation-reuse-map.md)
- Architecture: [`../../architecture/agents-skills-tasks.md`](../../architecture/agents-skills-tasks.md)
- Agents feature: [`../agents/spec.md`](../agents/spec.md)
- Task-tracking feature: [`../task-tracking/spec.md`](../task-tracking/spec.md)
- AI Facade: [`../../architecture/ai-facade.md`](../../architecture/ai-facade.md)
- Constitution: [`../../../.specify/memory/constitution.md`](../../../.specify/memory/constitution.md)
