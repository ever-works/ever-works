# Task Breakdown: Skills shelf

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and
> ships with tests per **Constitution VI**. The schema task ships its migration in the same PR
> per **Constitution V**.

**Epic ID**: `AW-08-skills-shelf`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. An implementer should never have to
  guess a path.
- "Done when" is stated explicitly for every task and is checkable without reading the diff.
- Add new tasks at the bottom rather than renumbering.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of
  each phase.
- Repo commands run from the monorepo root unless a task says otherwise. Migrations are
  authored from `apps/api/`.

---

# Phase P1 — The shelf reads true

*Delivers spec FR-1…FR-32 and FR-51…FR-62: the shelf, tags, the off switch, readiness badges,
the requirements enumeration, the detail panels, and the hourly sweep. No repair, no capture.*

## P1.1 — Contracts

- [ ] **T1. Readiness and tag contracts.**
  **Create** `packages/contracts/src/skills/readiness.ts` with `SKILL_READINESS_STATES`,
  `SkillReadinessState`, `SKILL_CARD_STATES`, `SkillCardState`, `SkillRequirementKind`,
  `SkillRequirementStatus`, `SkillRequirement`, `SkillReadinessDetail`, and the constants
  `SKILL_TAG_MAX_LENGTH = 40`, `SKILL_TAGS_PER_SKILL_MAX = 12`, `SKILL_TAG_FACET_LIMIT = 200`,
  `SKILL_TAG_CHIPS_SHOWN = 12`, `SKILL_TAG_FILTER_MAX = 6`,
  `SKILL_READINESS_TTL_MS = 3_600_000`, `SKILL_READINESS_SWEEP_BATCH = 500`,
  `SKILL_READINESS_SWEEP_PER_USER = 200`, `SKILL_CAPTURE_BODY_MAX_CHARS = 16_000`,
  `SKILL_CAPTURE_BODY_MIN_CHARS = 200`, `SKILL_CAPTURE_BUDGET_MS = 90_000`
  (exact shapes in [plan §3.3](./plan.md)).
  **Modify** `packages/contracts/src/skills/index.ts` to add `export * from './readiness.js';`.
  **Test**: extend `packages/contracts/src/skills/__tests__/` with a spec pinning the two state
  unions (so a state cannot be added without a deliberate edit) and asserting every numeric
  constant.
  **Done when**: `pnpm --filter @ever-works/contracts build` emits declarations and
  `import { SkillCardState } from '@ever-works/contracts'` resolves from `apps/api`.

- [ ] **T2 (parallel with T1). Export the first-party provider id from its own plugin.**
  **Modify** `packages/plugins/everworks-skills/src/index.ts` to export
  `export const EVERWORKS_SKILLS_PROVIDER_ID = 'everworks-skills';` (reusing whatever literal
  the plugin already declares as its id — do not introduce a second copy).
  **Test**: extend `packages/plugins/everworks-skills/src/everworks-skills.plugin.spec.ts` with
  an assertion that the exported constant equals the plugin's own `id`.
  **Done when**: nothing outside `packages/plugins/everworks-skills/` contains the string
  literal `'everworks-skills'` after T13 lands (Constitution II).

## P1.2 — Entity, table, migration

- [ ] **T3. `SkillTag` entity.**
  **Create** `packages/agent/src/entities/skill-tag.entity.ts` exactly as specified in
  [plan §3.2](./plan.md): `id`, `skillId` (`@ManyToOne(() => Skill, { onDelete: 'CASCADE' })`),
  `userId` (`@ManyToOne(() => User, { onDelete: 'CASCADE' })`), `tag` (`varchar(40)`),
  `tenantId`/`organizationId` (nullable uuid, **no** `@ManyToOne` — cycle avoidance, see the
  EW-654 note in `packages/agent/src/entities/user.entity.ts`), `createdAt`.
  Indexes: `uq_skill_tags_skill_tag` (unique on `skillId,tag`), `idx_skill_tags_user_tag`,
  `idx_skill_tags_skill`.
  **Modify** `packages/agent/src/entities/index.ts` — add `export * from './skill-tag.entity';`
  next to the three existing skill exports.
  **Modify** `packages/agent/src/database/_entity-names.ts` — add `'SkillTag'` to
  `AGENT_ENTITY_NAMES` in the Skills family block.
  **Modify** `packages/agent/src/database/_entities-inventory.ts` — import `SkillTag` and add it
  to `ENTITIES` beside `SkillFile`.
  **Test**: `packages/agent/src/entities/__tests__/skill-tag.entity.spec.ts` — asserts the three
  index names, that both scope columns exist (so
  `apps/api/src/scope/scope-stamping.subscriber.ts` will stamp it), and that `createdAt` uses
  the portable date column helper from `packages/agent/src/entities/_types.ts`.
  **Done when**: the drift specs in `packages/agent/src/database/database.module.spec.ts` and
  `database.config.spec.ts` pass without a magic-number edit.

- [ ] **T4. Six additive columns on `Skill`.**
  **Modify** `packages/agent/src/entities/skill.entity.ts` — append `disabledAt`
  (`PortableDateColumn({ nullable: true })`), `readiness` (`varchar(24)`, default `'unknown'`),
  `readinessDetail` (`simple-json`, nullable), `readinessCheckedAt` (portable, nullable),
  `reviewState` (`varchar(16)`, nullable), `capturedFromRunId` (uuid, nullable, **no** FK).
  Append the three new `@Index` declarations from [plan §3.1](./plan.md).
  Append **only** — never insert into the existing column order.
  **Test**: `packages/agent/src/entities/__tests__/skill.entity.spec.ts` (create if absent) —
  asserts the six columns, their defaults, and that no pre-existing column changed type.
  **Done when**: `pnpm --filter @ever-works/agent build` is clean.

- [ ] **T5. Migration + backfill.**
  **Create** `apps/api/src/migrations/1791080000000-AddSkillShelfReadinessAndTags.ts`.
  Generate the skeleton with
  `cd apps/api && pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/AddSkillShelfReadinessAndTags`,
  then hand-write the tag backfill described in [plan §3.4](./plan.md) — normalised in SQL,
  capped at 12 tags per skill, `ON CONFLICT ("skillId", tag) DO NOTHING`, branched on
  `queryRunner.connection.options.type` so SQLite dev/test databases skip the JSON expansion.
  `readiness` lands as `NOT NULL DEFAULT 'unknown'` — **do not** backfill it to `'ready'`.
  `down()` drops only what `up()` created.
  **Test**: `apps/api/src/migrations/__tests__/AddSkillShelfReadinessAndTags.spec.ts` — the
  directory's naming convention is `<MigrationName>.spec.ts`. Asserts the migration is
  re-runnable (a second `up()` inserts zero additional tag rows) and that `up()` contains no
  `DROP COLUMN` or rename of a pre-existing column.
  **Done when**: a fresh database and a database with existing skills both migrate cleanly, and
  every pre-existing Skill reads `readiness = 'unknown'` immediately after.

## P1.3 — Repositories and the readiness service

- [ ] **T6. `SkillTagRepository`.**
  **Create** `packages/agent/src/database/repositories/skill-tag.repository.ts` with
  `replaceForSkill(skillId, userId, tags, scope)` (delete-then-insert inside the caller's
  transaction), `findBySkillIds(skillIds, userId)`,
  `facets(userId, scope, limit = 200)` → `Array<{ tag, count }>` ordered count-desc then
  alphabetical, and `skillIdsMatchingAll(userId, tags, scope)` implementing AND semantics with
  a `GROUP BY … HAVING count(DISTINCT tag) = :n`.
  **Create** `packages/agent/src/database/repositories/skill-tag-normalize.ts` — the pure
  normaliser (trim → lower-case → whitespace to single hyphen → strip anything outside
  `[a-z0-9-]` → clamp to 40 → drop empties → dedupe → cap at 12, returning `{ tags, dropped }`).
  **Modify** `packages/agent/src/database/index.ts` — add
  `export * from './repositories/skill-tag.repository';`.
  **Modify** `packages/agent/src/skills/index.ts` — re-export `SkillTagRepository` alongside the
  other skill repositories.
  **Test**: `packages/agent/src/skills/__tests__/skill-tags.spec.ts` (normaliser table test:
  case, spaces, illegal characters, 40-char clamp, dedupe, 12-cap with `dropped` reported) and
  `packages/agent/src/database/repositories/__tests__/skill-tag.repository.spec.ts` (facet
  ordering, the 200 cap, AND semantics for 1/2/3 tags).
  **Done when**: both specs pass and `pnpm --filter @ever-works/agent test` is green.

- [ ] **T7. Extend `SkillRepository.findByUserIdFiltered`.**
  **Modify** `packages/agent/src/database/repositories/skill.repository.ts` — grow
  `ListSkillsFilter` with `tags?: string[]`, `readiness?: SkillCardState | 'attention'`,
  `provenance?`, `enabled?: boolean`, `sort?: 'updated' | 'name' | 'attention'`.
  Add the tag `INNER JOIN` (only when `tags` is present), the readiness predicate (derived: a
  request for `disabled` maps to `disabledAt IS NOT NULL`; `needs_review` to
  `reviewState = 'proposed'`; `attention` to `NOT (readiness = 'ready' AND disabledAt IS NULL
  AND reviewState IS NULL)`), the enabled predicate, the three sorts, and a `countsByCardState`
  method returning the grouped counts for the summary line.
  Keep the existing escaped-`LIKE` search helper and extend the `Brackets` block with a
  correlated `EXISTS` over `skill_tags` so search also matches a tag (FR-3).
  **Done when**: today's call with no new filters produces the identical SQL shape it produces
  now, asserted by the golden-set test in T8.

- [ ] **T8. Off switch in `resolveActive`.**
  **Modify** `packages/agent/src/database/repositories/skill-binding.repository.ts` — add
  `.andWhere('skill.disabledAt IS NULL')` and
  `.andWhere("(skill.reviewState IS NULL OR skill.reviewState <> 'proposed')"` to the
  `resolveActive` query builder. Nothing else in that method changes — not the OR-set, not the
  inject-flag predicates, not the ordering, not the dedupe.
  **Test**: `packages/agent/src/database/repositories/__tests__/skill-binding.repository.disabled.spec.ts`
  — a disabled Skill is excluded; a `proposed` Skill is excluded; a **golden-set** assertion
  that the full result for an untouched fixture is byte-identical to the pre-change result, so
  the new predicate provably narrows nothing else.
  **Done when**: the existing `flow-skill-context-assembly.spec.ts` e2e still passes unchanged.

- [ ] **T9. `SkillReadinessService`.**
  **Create** `packages/agent/src/skills/skill-readiness.service.ts`.
  Constructor injects, all `@Optional()` so unit tests and runtimes without the policy module
  keep working: `SkillBindingRepository`, `SkillRepository`, `AgentRepository`,
  `TOOL_GRANT_ENFORCER`, `CREDENTIAL_RESOLVER`, the MCP connection repository, and
  `PluginSettingsService`.
  `evaluate(skill, ctx): Promise<{ readiness, detail }>` implements exactly the ladder in
  [plan §2.1](./plan.md):
  1. count bindings for the skill; `boundTargetCount === 0` **or** every binding muted →
     `needs_setup`;
  2. resolve the grant matrix for up to 10 agents in scope and call
     `filterSkillsByToolGrants` from `packages/agent/src/policy/skill-activation.ts` — **import
     it, do not reimplement it**; suppressed for every agent → `blocked_by_access`;
  3. for each declared tool: `mcp__<server>__…` → look the connection up by name
     (`missing` / `disabled`); otherwise `requiredCredentialsForTool(name)` from
     `packages/agent/src/policy/tool-credentials.ts` → ask `CredentialResolver.resolve` for the
     key set and **diff the returned keys against the requested keys** (never read a value);
     any plugin-backed capability → ask `SettingsSchemaValidatorService` which required keys are
     unset and report the key names;
  4. any missing → `missing_requirements`; else `ready`;
  5. any thrown error in steps 2–3 → that requirement is `unknown`; a total failure → `unknown`
     for the whole skill. **Never `ready` on an error.**
  Truncate `detail.requirements` at 20 with `truncated: true`.
  **Modify** `packages/agent/src/skills/skills.module.ts` — provide and export it, and register
  `TypeOrmModule.forFeature([… SkillTag])`.
  **Modify** `packages/agent/src/skills/index.ts` — export the service.
  **Test**: `packages/agent/src/skills/__tests__/skill-readiness.service.spec.ts` and
  `skill-readiness-precedence.spec.ts` covering every branch listed in
  [plan §10.1](./plan.md).
  **Done when**: no test in the suite can produce `ready` from a thrown dependency.

- [ ] **T10. Wire readiness into the Skill write paths.**
  **Modify** `packages/agent/src/skills/skills.service.ts`:
  - `create`, `update` and `installFromCatalog` call
    `SkillTagRepository.replaceForSkill(...)` **inside the same transaction** as the Skill write
    (FR-14), deriving tags from `frontmatter.tags` through the T6 normaliser, and return the
    `dropped` list in the service result so the controller can report it (FR-10);
  - the same three methods, plus `createBinding` and `deleteBinding`, then call
    `SkillReadinessService.evaluate` and persist the three readiness columns;
  - add `enable(userId, id)` / `disable(userId, id)` — set/clear `disabledAt` via
    `SkillRepository.updateByIdAndUser` (**not** `updateById` — ownership must be in the
    `WHERE`), emit an activity row, and return the fresh card state. Both idempotent.
  **Modify** `packages/agent/src/entities/activity-log.types.ts` — append
  `SKILL_ENABLED = 'skill_enabled'` and `SKILL_DISABLED = 'skill_disabled'` to
  `ActivityActionType`, next to the existing `SKILL_*` members. Appending only; the column is a
  `varchar`, so **no migration is required** for this.
  **Test**: `packages/agent/src/skills/__tests__/skills.service.disable.spec.ts` — idempotency;
  bindings unchanged in count, target, priority and **both** inject flags; the activity row
  carries actor + direction and contains no body text.
  **Done when**: creating a Skill with 15 tags stores 12 and reports 3 dropped.

- [ ] **T11. Reflect run-time suppression back onto the shelf.**
  **Modify** `packages/agent/src/agents/agent-run.service.ts` — inside the existing
  `for (const entry of suppressed)` loop in `resolveSkillsForRun` (the loop that today only
  appends the `WARN` run log), also fire a best-effort readiness write marking that Skill
  `blocked_by_access`. Use the same `void … .catch(() => undefined)` posture as the log append:
  a readiness write must never fail a run.
  **Test**: `packages/agent/src/agents/__tests__/agent-run.skill-suppression.spec.ts` — the
  write happens; a rejecting writer does not fail the run; the `WARN` log is still appended.
  **Done when**: suppressing a Skill in a run changes its badge on the next shelf load.

## P1.4 — API

- [ ] **T12. Extend the list DTO and response.**
  **Modify** `apps/api/src/skills/dto/skill.dto.ts` — grow `ListSkillsQueryDto` with `tags`
  (comma-separated, `@Transform` to `string[]`, `@ArrayMaxSize(6)`, each matching
  `^[a-z0-9][a-z0-9-]{0,39}$`), `readiness`, `provenance`, `enabled`, `sort`, each with
  `@IsOptional()` + `@IsIn([...])` from the T1 unions.
  **Create** `apps/api/src/skills/dto/skill-shelf.dto.ts` with `SkillShelfRowDto` (the extended
  row from [plan §4.1](./plan.md)) and `SkillTagFacetDto`.
  **Done when**: a request with 7 tags returns `400` with the copy from spec FR-12 and a request
  with none behaves exactly as today.

- [ ] **T13. Provenance mapper.**
  **Create** `apps/api/src/skills/skill-provenance.ts` — a pure function
  `provenanceOf(skill): 'firstParty' | 'plugin' | 'package' | 'authored'` using
  `EVERWORKS_SKILLS_PROVIDER_ID` imported from `@ever-works/plugins-everworks-skills` (T2) and
  the `pkg:` prefix for package sources. No string literal for a plugin id in this file.
  **Test**: `apps/api/src/skills/skill-provenance.spec.ts` — beside the file, matching this
  module's existing convention (`skills.controller.spec.ts` sits beside its controller, not in
  a `__tests__` folder). Covers the four branches plus a `null`-source fallback.

- [ ] **T14. Shelf endpoints on the skills controller.**
  **Modify** `apps/api/src/skills/skills.controller.ts`:
  - extend `GET /` to pass the new filters through and to project `SkillShelfRowDto` (tags via
    `SkillTagRepository.findBySkillIds` in one batched call, `boundTargetCount` via one grouped
    count, `cardState` derived from `readiness` + `disabledAt` + `reviewState`), and to return
    `meta.counts`;
  - add `GET /tags` — **declared before every `:id` route**, next to the existing `GET invocable`
    which carries the same comment;
  - add `POST :id/enable`, `POST :id/disable` (`@Throttle({ long: { limit: 60, ttl: 60_000 } })`),
    `GET :id/readiness`, `POST :id/readiness/refresh`
    (`@Throttle({ long: { limit: 30, ttl: 60_000 } })`);
  - `@ApiOperation` on every new method.
  Cross-workspace ids answer `404` on every verb, via the existing `findByIdAndUser` path.
  **Modify** `apps/api/src/skills/skills.module.ts` — inject `SkillReadinessService` and
  `SkillTagRepository`.
  **Test**: extend `apps/api/src/skills/skills.controller.spec.ts` and **create**
  `apps/api/src/skills/skills.controller.shelf.spec.ts` covering everything in
  [plan §10.2](./plan.md) for P1 — including the route-order case where a Skill's id is
  literally `tags`.
  **Done when**: `cd apps/api && pnpm test` is green and every new endpoint has a
  cross-workspace `404` assertion.

## P1.5 — Web

- [ ] **T15. Typed client + page-data plumbing.**
  **Modify** `apps/web/src/lib/api/skills.ts` — extend the `Skill` mirror with the new fields,
  add `tags`, `cardState`, `readiness`, `readinessDetail`, `provenance`, `boundTargetCount`,
  `openRepairTaskId`; add `skillsAPI.listTags()`, `skillsAPI.readiness(id)`.
  **Modify** `apps/web/src/lib/skills-page-data.ts` — whitelist `tags`, `readiness`,
  `provenance`, `enabled`, `sort` in `parseSkillsSearchParams` (anything unknown is still
  dropped); fetch the tag facets inside the existing `Promise.all` in `loadSkillsPageData`;
  teach `buildSkillsHref` to serialise the five new params, still omitting defaults.
  **Test**: extend `apps/web/src/lib/skills-page-data.unit.spec.ts` — each new param parses,
  each malformed value falls back to the default, and `buildSkillsHref` round-trips.
  **Done when**: `/agents?tags=billing&sort=attention#skills` reloads into the same view.

- [ ] **T16. `SkillReadinessBadge`.**
  **Create** `apps/web/src/components/skills/SkillReadinessBadge.tsx` — pure presentational,
  `SkillCardState` → icon + translated title + optional enumerated requirement list + optional
  action slot. Text label always rendered; colour is never the sole carrier (FR-55).
  **Test**: `SkillReadinessBadge.unit.spec.tsx` — all seven states render their title text;
  the enumerated list renders each requirement's kind, id and status; truncation renders
  `readiness.truncated`.

- [ ] **T17. `SkillTagFilter`.**
  **Create** `apps/web/src/components/skills/SkillTagFilter.tsx` — 12 chips with counts,
  roving-tabindex (`←`/`→` move, `Space`/`Enter` toggle, `Backspace` deselects), `+{n} more`
  popover with its own search input, the 6-selection cap with the disabled seventh chip and its
  tooltip, and a `Clear` control that appears only when something is selected.
  **Test**: `SkillTagFilter.unit.spec.tsx` — selection AND-accumulates, the cap disables the
  seventh, the overflow popover filters, and the keyboard model works headlessly.

- [ ] **T18. `SkillShelfCard`.**
  **Create** `apps/web/src/components/skills/SkillShelfCard.tsx` — title, description, tag
  pills, provenance chip, version, reach line, the optimistic on/off toggle (BFF call, revert
  on failure, idempotent), the badge, and the badge's primary action slot (a no-op placeholder
  in P1, filled by T26).
  **Create** `apps/web/src/app/api/skills/[id]/enable/route.ts`,
  `apps/web/src/app/api/skills/[id]/disable/route.ts`,
  `apps/web/src/app/api/skills/[id]/readiness/route.ts` — thin BFF proxies mirroring the
  existing `apps/web/src/app/api/skills/[id]/files/route.ts`.
  **Test**: `SkillShelfCard.unit.spec.tsx` — toggle optimism and revert; badge selection by
  card state; reach pluralisation; `data-testid` present for the e2e grid queries.

- [ ] **T19. `SkillShelf` and the summary line.**
  **Create** `apps/web/src/components/skills/SkillShelf.tsx` — the grid, the sort control, the
  attention summary line (which is itself the attention filter), the three distinct empty
  states and the past-the-end state, and the URL sync using the same
  `router.replace(basePath + params + hash)` pattern `SkillsPageClient` already uses.
  **Modify** `apps/web/src/components/skills/SkillsPageClient.tsx` — `InstalledList` becomes a
  thin wrapper delegating to `SkillShelf`; `updateUrl` learns the five new params; the search
  input keeps its id and name and only its placeholder **value** changes. The `available` and
  `custom` sections are untouched.
  **Modify** `apps/web/src/components/skills/SkillsSection.tsx` — pass the tag facets through.
  **Done when**: the shelf's badges are present in the server-rendered HTML (FR-8) — verify with
  `curl` on the page, not just in the browser.

- [ ] **T20. Detail-page panels.**
  **Create** `apps/web/src/components/skills/SkillReadinessPanel.tsx` — state, "Checked {ago}",
  `Re-check` (with `useTransition`, keyboard `R` while focused), and the requirements table
  (kind · id · status), reusing `SkillReadinessBadge` so the card and the panel can never
  disagree.
  **Modify** `apps/web/src/components/skills/SkillDetailClient.tsx` — insert the readiness
  panel, the requirements table and a "Where it came from" block **above** the existing
  instructions section. Nothing below moves; the body editor, bindings, files and delete
  sections keep their current order, props and copy (FR-56).
  **Modify** `apps/web/src/app/[locale]/(dashboard)/skills/[id]/page.tsx` — fetch the readiness
  alongside the existing parallel skill/bindings/files fetch.
  **Done when**: the existing `skills.spec.ts` e2e still passes with no selector changes.

## P1.6 — Background sweep

- [ ] **T21. Sweep dispatcher.**
  **Create** `packages/agent/src/tasks/skill-readiness-sweep.types.ts` (payload) and
  `packages/agent/src/tasks/skill-readiness-sweep-dispatcher.ts` — interface +
  `export const SKILL_READINESS_SWEEP_DISPATCHER = Symbol('SKILL_READINESS_SWEEP_DISPATCHER');`
  following `packages/agent/src/tasks/kb-reembed-work-dispatcher.ts` exactly. Returns
  `string | null` (soft failure; the next tick recovers).
  **Modify** `packages/agent/src/tasks/index.ts` — export both.
  **Modify** `packages/agent/src/tasks/_tasks-symbols.ts` — add
  `'SKILL_READINESS_SWEEP_DISPATCHER'` to `TASKS_BARREL_RUNTIME_SYMBOLS`, alphabetically.
  **Test**: `packages/agent/src/tasks/__tests__/skill-dispatchers.spec.ts` — the token is
  `Symbol(...)` not `Symbol.for(...)`, its `description` matches its name, and it is listed in
  the barrel inventory.
  **Done when**: `packages/agent/src/tasks/tasks.spec.ts` passes without a magic-number edit.

- [ ] **T22. The scheduled sweep task.**
  **Create** `packages/tasks/src/tasks/trigger/skill-readiness-sweep.task.ts` — a
  `schedules.task` on cron **`17 * * * *`**, modelled on
  `packages/tasks/src/tasks/trigger/kb-reconcile.task.ts`. Select skills whose
  `readinessCheckedAt` is null or older than 60 minutes, oldest first, `LIMIT 500`, with a
  per-`userId` cap of 200 applied via `ROW_NUMBER() OVER (PARTITION BY "userId")`. Evaluate each
  and write the three readiness columns with an ownership-scoped `UPDATE`. Emit
  `skill.readiness.sweep.completed` with `{ scanned, changed, byState, durationMs }` — counters
  only.
  **Modify** `packages/tasks/src/tasks/trigger/index.ts` — export the task.
  **Modify** the API-side binding module that wires `*_DISPATCHER` symbols onto the active
  job-runtime provider so `SKILL_READINESS_SWEEP_DISPATCHER` resolves through
  `buildJobRuntimeProviders` like every other dispatcher (Constitution IV — no direct queue
  call, no vendor SDK import at a call site).
  **Test**: a unit spec beside the task asserting the cron string, both caps, and that a
  failure on one skill does not abort the tick.
  **Done when**: the cron does not collide with `kb-reconcile` (`42 3`) or
  `memory-consolidation-tick` (`37 8`), and a local dispatch updates verdicts.

## P1.7 — i18n, tests, docs

- [ ] **T23. i18n keys.**
  **Modify** `apps/web/messages/en.json` — add the `dashboard.skillsPage.shelf` and
  `dashboard.skillsPage.readiness` sub-trees from [plan §8](./plan.md) verbatim.
  Then add the same **keys** to all 20 sibling locale files in `apps/web/messages/`.
  **Every leaf key name is camelCase and contains no literal `.`** — a dot in a leaf name is
  rejected at runtime and reds several e2e shards at once.
  **Done when**: a script grep for `"[a-zA-Z]*\.[a-zA-Z]*":` inside the new sub-trees returns
  nothing, and `pnpm --filter web build` produces no missing-message warnings.

- [ ] **T24. P1 e2e.**
  **Create** `apps/web/e2e/skills-shelf-badges.spec.ts`,
  `apps/web/e2e/skills-shelf-tags.spec.ts`,
  `apps/web/e2e/skills-shelf-toggle.spec.ts`,
  `apps/web/e2e/skills-shelf-empty-states.spec.ts`,
  `apps/web/e2e/skills-shelf-a11y.spec.ts` — scenarios in [plan §10.3](./plan.md).
  Prefer `getByTestId` for the card grid; reserve `*ByRole` for the dialogs (role queries are
  the usual source of load-sensitive flakes in this workspace).
  **Done when**: the five new specs pass and `skills.spec.ts`, `skills-list-filter.spec.ts`,
  `flow-skill-crud-scoping.spec.ts`, `flow-skill-bindings-deep.spec.ts`,
  `flow-skill-context-assembly.spec.ts` and `sec-pin-skills-scoping.spec.ts` all still pass
  **unchanged** — that is the additive-only proof.

- [ ] **T25. P1 ship gate.**
  Run `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` from the root.
  Update this file's status and tick the P1 boxes.
  **Done when**: `develop` is green and the shelf is deployable with no repair and no capture.

---

# Phase P2 — Repair

*Delivers spec FR-33…FR-40: one-click repair, delegated repair as a Task, the
single-open-repair guard and the permission-denied variant.*

- [ ] **T26. Repair service.**
  **Create** `packages/agent/src/skills/skill-repair.service.ts` with
  `repair(userId, skillId, input, scope)` implementing the five actions from
  [plan §4.2](./plan.md):
  `attach` (create the binding through the existing `SkillsService.createBinding`, then
  re-evaluate readiness), `unmute` (flip `injectIntoAgent` to true on the skill's bindings),
  `enable`, `recheck`, and `delegate`.
  `delegate` creates one `Task` (`missionId: null` — the column is nullable), title
  `Fix requirements for Skill: {title}`, description enumerating every unmet requirement from
  `readinessDetail`, `agentId` set to the chosen agent, then calls the same admission path
  `POST /api/agents/:id/assign-task` uses so the run goes through the concurrency valve rather
  than around it.
  **Single open repair Task** is enforced by a scoped lookup for an open Task carrying
  `labels` containing `skill-repair:{skillId}` — reusing the existing `Task.labels` column
  rather than adding one. `restart: true` cancels the existing Task first.
  **Modify** `packages/agent/src/skills/skills.module.ts` — provide and export it.
  **Test**: `packages/agent/src/skills/__tests__/skill-repair.service.spec.ts` — each action;
  the duplicate-binding conflict; the already-open guard; `restart` cancelling then reopening;
  a delegate whose run dispatch fails leaves the Task open.

- [ ] **T27. Repair endpoint.**
  **Modify** `apps/api/src/skills/dto/skill.dto.ts` — add `RepairSkillDto` exactly as in
  [plan §4.2](./plan.md), with conditional validation (`targetId` required unless
  `targetType === 'tenant'`; `agentId` required for `delegate`).
  **Modify** `apps/api/src/skills/skills.controller.ts` — add
  `POST :id/repair` returning `202` with `{ kind, taskId?, runId?, bindingId?, readiness }`,
  `@Throttle({ long: { limit: 10, ttl: 60_000 } })`, `@ApiOperation`.
  Error codes exactly as tabulated in [plan §4.2](./plan.md).
  **Test**: extend `apps/api/src/skills/skills.controller.shelf.spec.ts` — all five actions,
  `409 repairInProgress`, `409 bindingExists`, the permission-denied path, and a
  cross-workspace `404`.
  **Done when**: the endpoint returns in under 2 seconds without awaiting the run.

- [ ] **T28. Repair and attach dialogs.**
  **Create** `apps/web/src/components/skills/SkillRepairDialog.tsx` — the enumerated missing
  items with a per-item deep link (`fixTarget.surface` → route), the agent picker, the
  `Ask {agentName} to fix this` button, the already-open variant with its
  `Cancel that and start over` action, and the permission-denied variant that disables the
  action while keeping the item's name fully visible (FR-40).
  **Create** `apps/web/src/components/skills/SkillAttachDialog.tsx` — reusing
  `loadBindingTargetOptionsAction` from `apps/web/src/app/actions/skills.ts` so the picker
  behaves identically to the one already on the Skill detail page.
  **Modify** `apps/web/src/app/actions/skills.ts` — add `repairSkillAction` with
  `revalidatePath` on the Agents route.
  **Modify** `apps/web/src/components/skills/SkillShelfCard.tsx` and
  `SkillReadinessPanel.tsx` — fill the action slot left as a placeholder in T18/T20.
  **Test**: `SkillRepairDialog.unit.spec.tsx` and `SkillAttachDialog.unit.spec.tsx` — each
  variant renders; `Esc` closes and returns focus; `Enter` fires the primary action.

- [ ] **T29. Repair i18n.**
  **Modify** `apps/web/messages/en.json` — add the `dashboard.skillsPage.repair` sub-tree from
  [plan §8](./plan.md); mirror the keys into the 20 sibling locales.

- [ ] **T30. P2 e2e.**
  **Create** `apps/web/e2e/skills-shelf-repair.spec.ts` — unbound Skill → **Attach to…** →
  badge clears in place; missing requirement → **Ask an agent** → Task created with the
  enumerated description → second attempt shows the already-open variant → `restart` reopens.
  **Done when**: the spec passes and no existing skill spec needed a selector change.

- [ ] **T31. P2 ship gate.** Root `format / lint / type-check / test / build` green; tick P2.

---

# Phase P3 — Capture from a run

*Delivers spec FR-41…FR-50: drafting a Skill from a completed run, the review state, and
accept/discard with inline attach.*

- [ ] **T32. Capture dispatcher.**
  **Create** `packages/agent/src/tasks/skill-capture.types.ts` and
  `packages/agent/src/tasks/skill-capture-dispatcher.ts` —
  `export const SKILL_CAPTURE_DISPATCHER = Symbol('SKILL_CAPTURE_DISPATCHER');`, returning
  `Promise<string>` and **propagating** dispatch errors (a dropped capture strands a
  `proposed` placeholder — the same reasoning `KbReembedWorkDispatcher` documents).
  **Modify** `packages/agent/src/tasks/index.ts` and
  `packages/agent/src/tasks/_tasks-symbols.ts` (alphabetical insertion).
  **Test**: extend `packages/agent/src/tasks/__tests__/skill-dispatchers.spec.ts`.

- [ ] **T33. Capture service.**
  **Create** `packages/agent/src/skills/skill-capture.service.ts`:
  - `start(userId, input, scope)` — validates the run belongs to the caller and is `completed`,
    returns the existing draft id when `capturedFromRunId` already matches (the partial unique
    index makes this a guarantee, not a race), otherwise creates the placeholder Skill row
    (`reviewState: 'proposed'`, minimal body) and dispatches;
  - `applyDraft(skillId, draft)` — renders the Markdown body **in code** from the structured
    draft (`## When to use this` / `## Steps` / `## Edge cases`) so the edge-cases section is
    guaranteed present, runs `assertNoSecrets` and `assertNoInjectionTokens` from
    `packages/agent/src/utils/`, enforces the 200-char floor and the 16,000-char ceiling, writes
    the body + tags (through the T6 normaliser, capped at 6 for a draft), then evaluates
    readiness;
  - `discardPlaceholder(skillId, reason)` — deletes the row and appends one `INFO`
    `agent_run_logs` line with `step: 'skill-capture'` so the run page can render the outcome
    without a new table;
  - `accept(userId, skillId)` — clears `reviewState`, re-evaluates readiness, `422` when the
    Skill is not `proposed`.
  **Test**: `packages/agent/src/skills/__tests__/skill-capture.spec.ts` — body rendering,
  both size gates, secret and control-sequence rejection, the not-usable path creating no row,
  same-run idempotency, and `accept` on a non-proposed Skill.

- [ ] **T34. The capture job.**
  **Create** `packages/tasks/src/tasks/trigger/skill-capture-from-run.task.ts` — reads the
  `AgentRun` plus up to 500 `AgentRunLog` rows (the same cap
  `apps/api/src/agents/agents.controller.ts` already applies to run detail), **fences the log
  text as untrusted input** the way `packages/agent/src/services/memory-recall.ts` fences
  recalled memory, calls `AiFacadeService` (never a provider SDK) for one structured completion
  `{ title, whenToUse, steps[], edgeCases[], tags[] }`, then calls
  `SkillCaptureService.applyDraft` or `discardPlaceholder`. `maxDuration` 90 s, 1 retry, emits
  `skill.capture.completed`.
  Also handles the housekeeping sweep from [plan §9.2](./plan.md): delete `proposed` Skills with
  an empty body older than 24 hours (a stranded placeholder).
  **Modify** `packages/tasks/src/tasks/trigger/index.ts`; wire the dispatcher through
  `buildJobRuntimeProviders` like every other symbol.
  **Test**: a spec beside the task covering the fencing, the retry idempotency (a full replace
  keyed by `skillId`), and the deleted-mid-capture case (`UPDATE … WHERE id AND userId` affects
  0 rows, job exits clean).

- [ ] **T35. Capture and accept endpoints.**
  **Modify** `apps/api/src/skills/dto/skill.dto.ts` — add `CaptureSkillFromRunDto`.
  **Modify** `apps/api/src/skills/skills.controller.ts` —
  add `POST /from-run` (**declared before every `:id` route**) returning `202`
  `{ skillId, state: 'drafting' }` with `@Throttle({ long: { limit: 10, ttl: 3_600_000 } })`,
  and `POST :id/accept` with `@Throttle({ long: { limit: 30, ttl: 60_000 } })`.
  **Test**: extend `apps/api/src/skills/skills.controller.shelf.spec.ts` — `422 runNotCompleted`
  for each non-completed status, same-run idempotency, cross-workspace `404`, `422 notProposed`.

- [ ] **T36. Run-page action and capture dialog.**
  **Create** `apps/web/src/components/skills/SkillCaptureDialog.tsx` — scope picker (defaulting
  to the run's agent), optional title, optional emphasis, submit; then the inline
  `Drafting — this takes about a minute.` state polling
  `GET /api/skills/:id/readiness` every 5 s for at most 120 s, reusing the poll cadence
  `SessionDetailClient` already runs rather than adding a second timer.
  **Modify** `apps/web/src/components/agents/SessionDetailClient.tsx` — one header action,
  enabled only for `run.status === 'completed'`, with the disabled tooltip otherwise, and the
  `View the Skill from this run` variant once a draft exists.
  **Modify** `apps/web/src/app/[locale]/(dashboard)/agents/sessions/[runId]/page.tsx` — pass
  through whether a captured Skill already exists for this run.
  **Modify** `apps/web/src/app/actions/skills.ts` — add `captureSkillFromRunAction`,
  `acceptSkillAction`, `discardSkillDraftAction`.
  **Test**: `SkillCaptureDialog.unit.spec.tsx` — enabled/disabled gating, the drafting state,
  the not-usable message, and poll teardown on unmount.

- [ ] **T37. Review banner and accept flow.**
  **Create** `apps/web/src/components/skills/SkillReviewBanner.tsx` — the
  `Needs your review` banner with `Accept` / `Discard`, the accept dialog's inline
  `Attach to…` variant when the Skill has no binding, and the discard confirmation.
  **Modify** `apps/web/src/components/skills/SkillDetailClient.tsx` — render the banner above
  the readiness panel when `reviewState === 'proposed'`; the body editor stays fully editable
  before accepting.
  **Test**: `SkillReviewBanner.unit.spec.tsx` — both accept paths and the discard confirmation.

- [ ] **T38. Capture i18n.**
  **Modify** `apps/web/messages/en.json` — add the `dashboard.skillsPage.capture` sub-tree and
  the two `dashboard.agentsPage.sessions.detail.saveAsSkill*` keys from [plan §8](./plan.md);
  mirror into the 20 sibling locales.

- [ ] **T39. P3 e2e.**
  **Create** `apps/web/e2e/skills-capture-from-run.spec.ts` — completed run → save → drafting →
  draft badged **Needs your review** → the draft is absent from a new run's context → accept
  with inline attach → the Skill is live; plus the failed-run disabled variant and the
  not-usable message.
  **Done when**: it passes and no existing agent-session spec needed a selector change.

- [ ] **T40. P3 ship gate.** Root `format / lint / type-check / test / build` green; tick P3.

---

# Cross-phase closing tasks

- [ ] **T41. Telemetry.**
  Wire the ten events from [plan §9.1](./plan.md) through the existing monitoring package,
  following the `this.posthog.capture({ distinctId, event, properties })` pattern in
  `packages/agent/src/services/knowledge-base-reconcile.service.ts`.
  **Test**: a spec asserting that no event payload contains a Skill body, a tag string, a
  credential key, a connection URL or a search query.

- [ ] **T42. Docs.**
  **Create** `docs/features/skills-shelf.md` — the user-facing page: what each badge means,
  what each repair does, and how capture works.
  **Modify** `apps/docs/sidebarsPlatform.ts` to list it (the sidebar is manual; unlisted files
  render only as orphan pages).
  **Modify** `docs/specs/features/agent-workspace/TRACKER.md` — set this epic's spec status.
  Do **not** touch `docs/plugin-system/built-in-plugins.md`; no plugin was added
  (Constitution VIII).

- [ ] **T43. Update statuses.**
  Set `spec.md`, `plan.md` and this file to `Implemented` / `Done`, and confirm every gate in
  [plan §12](./plan.md) still holds against the merged code.

---

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green
  from the repo root.
- The six pre-existing skill e2e specs named in T24 pass **unchanged**.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- Every acceptance-criteria box in [spec §8](./spec.md) has been walked against a running build.
- Every gate in [plan §12](./plan.md) is confirmed satisfied, and the three carried-forward gaps
  are still recorded there rather than silently closed.
