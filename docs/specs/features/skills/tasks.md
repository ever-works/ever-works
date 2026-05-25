# Task Breakdown: Skills

**Feature ID**: `skills`
**Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-05-25

---

## How to use

Phases mirror [plan.md §10](./plan.md#10-phased-rollout). Tasks sequential unless `(parallel)`. Tick boxes as commits land.

---

## Phase 1 — Data + read-only API + catalog reader

- [ ] **T1**. Create `packages/agent/src/entities/skill.entity.ts` per [plan.md §3.1](./plan.md#31-new-entities).
- [ ] **T2** (parallel). Create `packages/agent/src/entities/skill-binding.entity.ts`.
- [ ] **T3**. Register entities; generate migration `CreateSkillsTables.ts`.
- [ ] **T4**. Create repositories `SkillRepository` and `SkillBindingRepository` with key methods (`findByOwner`, `findActiveForAgent`, `findActiveForGenerator`, `resolveActive`). Unit tests cover every combination of scopes.
- [ ] **T5**. Create `apps/api/src/skills/skill-catalog.service.ts`. Reads files from `apps/api/src/skills/catalog/*/<slug>.md`, parses frontmatter with `gray-matter`, caches in memory. Watches for changes in dev only.
- [ ] **T6**. Catalog validator: zod schema for frontmatter (`name`, `description` required; `allowed-tools`, `tags` optional). Skip+warn on invalid files.
- [ ] **T7**. Controller `apps/api/src/skills/skills.controller.ts` with read routes: `GET /skills/catalog`, `GET /skills/catalog/:slug`, `GET /skills`, `GET /skills/:id`.
- [ ] **T8**. Wire `SkillsModule` into `app.module.ts`.

## Phase 2 — Mutations + UI

- [ ] **T9**. `POST /skills/install` — copies a catalog skill into a `skills` row at the requested scope. Idempotent (returns existing on collision).
- [ ] **T10**. `POST /skills` — create custom skill at any scope. Validates frontmatter via zod.
- [ ] **T11**. `PATCH /skills/:id` — edit body/frontmatter; recompute contentHash; emit `SKILL_FILE_EDITED` for Mission/Work scopes (Git mode).
- [ ] **T12**. `DELETE /skills/:id` — cascade-delete bindings.
- [ ] **T13**. Bindings CRUD: `POST /skills/:id/bindings`, `DELETE /skill-bindings/:id`. Validate the user owns the target.
- [ ] **T14**. `SkillFileService` (analog of `AgentFileService`): writes Mission/Work-scoped skill bodies to `<repo>/.works/skills/<slug>.md` via `GitFacadeService`; Tenant scope stays inline in DB.
- [ ] **T15**. Secret-scan helper applied on every body save (reuse from Agents work).
- [ ] **T16**. Build `/skills` page with three sections (Installed / Available / Custom). Filter chips + search + "Installed only" toggle. Same look as `/plugins`.
- [ ] **T17**. Build `/skills/new` create form.
- [ ] **T18**. Build `/skills/[id]` detail page with Body (Tiptap) + Bindings tabs.
- [ ] **T19**. Patch `DashboardSidebar.tsx` to add the "Skills" item below "Plugins" (i18n key already reserved in `agents/spec.md §5.1`).

## Phase 3 — Injection into AI calls

- [ ] **T20**. Implement `SkillBindingRepository.resolveActive({agentId?, workId?, missionId?, ideaId?, userId})` returning de-duplicated, priority-sorted `ResolvedSkill[]`.
- [ ] **T21**. Add `AiFacadeService.assembleSystemMessage({skills, maxTokens, mode: 'agent' | 'generator'})` returning the `## Skills` section. Uses tiktoken or token estimator (already in code via AI ops).
- [ ] **T22**. Wire the assembled section into `AgentRunService.execute()` (Phase 3 of Agents tasks) just after the WorkAdvancedPrompts content.
- [ ] **T23**. Wire the assembled section into the standard-pipeline / agent-pipeline generator paths via the same helper. Behind a feature-flag at first.
- [ ] **T24**. Register `getSkillBody` tool conditionally when bound skills are present. Return body + metadata. Emit `SKILL_INVOKED` on call.
- [ ] **T25**. Implement priority-based drop when budget exceeded. Log warning to `agent_run_logs`.

## Phase 4 — Tabs across detail pages

- [ ] **T26**. Add Skills tab to Agent detail page (toggle attached + inherited).
- [ ] **T27**. Add Skills tab to Work detail page between Generator and Plugins.
- [ ] **T28**. Add Skills tab to Mission detail page.
- [ ] **T29**. Add Skills tab to Idea detail page.
- [ ] **T30**. E2E test: install → bind to Agent → next heartbeat assembles system message containing skill description.

## Phase 5 — Mission Template integration

- [ ] **T31**. Extend the Mission scaffolder to copy `.works/skills/` from template repo.
- [ ] **T32**. Materialize matching `skills` rows + auto-bind to template-shipped agents whose `agent.yml` references the skill slugs.
- [ ] **T33**. E2E test: instantiate a template with 1 skill + 1 agent that uses it → both rows exist + skill is bound to that agent.

## Phase 6 — Account-transfer (Export / Import / GitHub Sync) extension

> Per [ADR-008](../../decisions/008-tenant-control-repo-deferred-to-v2.md). Tenant-installed catalog skills + custom user skills + their bindings to the user's Agents/Works/Missions must round-trip via the existing account-transfer surface.

- [ ] **T38**. Extend `account-transfer/types.ts` with `ExportedSkill` (slug, ownerType, ownerId, title, description, frontmatter, instructionsMd, contentHash, version, sourceCatalogSlug, sourceCatalogVersion) + `ExportedSkillBinding` (skillSlug, targetType, targetId, injectIntoAgent, injectIntoGenerator, priority).
- [ ] **T39**. Inject `SkillRepository` + `SkillBindingRepository` into `AccountExportService`. Implement `exportSkills(userId)` and `exportSkillBindings(userId)`.
- [ ] **T40**. Add `skills: ExportedSkill[]` and `skillBindings: ExportedSkillBinding[]` to `AccountExportPayload`. Bump `version`.
- [ ] **T41**. Implement `AccountImportService.importSkills(payload, options)` — create-or-update by `(ownerType, ownerId, slug)` UNIQUE key. Honor conflict-resolution.
- [ ] **T42**. Implement `AccountImportService.importSkillBindings(payload, options)` — recreate bindings post-import, skipping any targeting an entity that didn't import successfully.
- [ ] **T43**. Update `GitHubSyncService` synced layout: write tenant skills to `skills/<slug>.md`; bindings to `skill-bindings.yml` (one YAML doc).
- [ ] **T44**. Add UI toggle on `/settings/import-export`: "Include Skills in export" (default ON).
- [ ] **T45**. Activity events `SKILL_EXPORTED`, `SKILL_IMPORTED`, `SKILL_SYNCED`.
- [ ] **T46**. Round-trip Playwright test.

## Phase 7 — Starter catalog seed (renumbered from Phase 6)

- [ ] **T34**. Author the 10 starter skill files at `apps/api/src/skills/catalog/<slug>/<slug>.md`: `pr-review`, `release-notes`, `kb-summarize`, `image-alt-text`, `seo-meta`, `internal-link-suggestions`, `competitive-research`, `commit-message-format`, `test-coverage-gap`, `dependency-bump-checklist`.
- [ ] **T35**. For each, add `metadata.json` with `tags`, default `allowed-tools`, `version: "1.0.0"`.
- [ ] **T36**. Snapshot test: catalog read yields ≥10 entries, no validation errors.
- [ ] **T37**. Manual smoke: install each at tenant level → attach to a test Agent → first heartbeat references the skill.

## Definition of Done

- [ ] All boxes ticked above.
- [ ] `pnpm test` + `pnpm lint` + `pnpm type-check` green.
- [ ] Existing `WorkAdvancedPrompts` test suite still green (regression check).
- [ ] Architecture doc references updated.
- [ ] PR review-loop clean (CodeRabbit / Codex / Sonar / Snyk).
