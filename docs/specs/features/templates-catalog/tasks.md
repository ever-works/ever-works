# Task Breakdown: Templates Catalog

**Feature ID**: `templates-catalog`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## Phase 1 — Schema & Repositories

- [x] T1. `Template` entity at
      `packages/agent/src/entities/template.entity.ts` with varchar(120)
      PK, `kind` / `sourceType` discriminators, optional `ownerUserId`,
      catalog metadata fields, `branch` (default `main`),
      `syncBranches` (`simple-json`), `betaBranch`, `isActive`, `metadata`
      (`simple-json`). Indexes `(kind, sourceType, isActive)` and
      `(ownerUserId, kind)`.
- [x] T2. `UserTemplatePreference` entity at
      `packages/agent/src/entities/user-template-preference.entity.ts`
      with uuid PK, `(userId, kind)` unique, FK-style `templateId`.
- [x] T3. `TemplateRepository` at
      `packages/agent/src/database/repositories/template.repository.ts`
      with `findById`, `findVisibleByKind` (built-in + own-custom union,
      `sourceType DESC, name ASC`), `findVisibleById`,
      `findOwnedCustomById`, `findOwnedCustomByRepositoryUrl`,
      `findOwnedCustomByRepositoryCoordinates`,
      `findBuiltInByRepositoryCoordinates`,
      `hasRecentDiscoveredBuiltInTemplates` (Raw `metadata LIKE` filter
      on `discoveredFromOrganization`), `upsert` (conflict path on
      `id`), `updateById`.
- [x] T4. `UserTemplatePreferenceRepository` at
      `packages/agent/src/database/repositories/user-template-preference.repository.ts`
      with `findByUserAndKind`, `upsertDefault` (conflict path on
      `(userId, kind)`), `deleteByUserKindAndTemplateId`.

## Phase 2 — Service Surface

- [x] T5. `TemplateCatalogService` at
      `packages/agent/src/template-catalog/template-catalog.service.ts`
      injecting `TemplateRepository`,
      `UserTemplatePreferenceRepository`, `WorkRepository`,
      `GitFacadeService`. Implements `OnModuleInit`. Constant
      `WEBSITE_DISCOVERY_SYNC_TTL_MS = 1000 * 60 * 60` (1 h).
- [x] T6. `onModuleInit` wraps `seedBuiltInTemplates()` in a try/catch
      and warn-logs on failure (`Failed to seed built-in templates
  during startup: <msg>`).
- [x] T7. `seedBuiltInTemplates`: maps `listWebsiteTemplates()` (which
      returns `Classic` always, plus `Minimal` env-gated) through
      `toBuiltInWebsiteTemplateRecord`, and `Promise.all`-`upsert`s each.
      Logs `Ensured <N> built-in templates are present` at debug.
- [x] T8. `listTemplatesForUser(kind, userId)`: when `kind === 'website'`,
      runs `syncDiscoveredWebsiteTemplatesIfStale(userId)` BEFORE
      `findVisibleByKind` + `getDefaultTemplateIdForUser` parallel
      reads. Returns `{ defaultTemplateId, templates: TemplateCatalogItem[] }`.
- [x] T9. `addCustomTemplate(input, userId)`:
      `parseGitHubRepositoryUrl` → BadRequest `'Only valid GitHub
  repository URLs are supported for custom templates.'`;
      `findOwnedCustomByRepositoryUrl(kind, userId, canonicalUrl)` →
      Conflict `'You already added this template repository.'`;
      otherwise `upsert({ id: 'custom-' + randomUUID(), sourceType:
  'custom', ownerUserId: userId, name: input.name?.trim() ||
  humanizeRepositoryName(repo), description: input.description?.trim()
  || null, framework: input.framework?.trim() ||
  inferFrameworkFromRepository(repo), previewImageUrl:
  input.previewImageUrl?.trim() || null, repositoryUrl:
  canonicalUrl, repositoryOwner: owner, repositoryName: repo,
  branch: input.branch?.trim() || 'main', syncBranches:
  input.syncBranches?.length ? input.syncBranches : [branch],
  betaBranch: input.betaBranch?.trim() || null, isActive: true,
  metadata: {} })`.
- [x] T10. `updateCustomTemplateForUser({ kind, templateId, name?,
  description?, framework?, previewImageUrl?, branch?, betaBranch? },
  userId)`: `findOwnedCustomById` then guard
      `(template.kind === input.kind && template.isActive)` →
      NotFound `'Custom template not found for this user and kind.'`.
      Field rules per FR-10: `name` empty-string preserves existing,
      `description`/`framework`/`previewImageUrl`/`betaBranch`
      empty-string clear to `null`, `branch` empty-string preserves
      existing; when `branch` changes, `syncBranches.length === 1` is
      rewritten to `[newBranch]`, otherwise the existing branch entry
      is replaced in-place.
- [x] T11. `archiveCustomTemplateForUser({ kind, templateId }, userId)`:
      same `findOwnedCustomById` guard; for `kind: 'website'`
      run `workRepository.countByUserAndWebsiteTemplateId(userId,
  template.id)` — Conflict (singular vs. plural copy) when `> 0`;
      then if the template is the user's current default, run
      `workRepository.countByUserAndInheritedWebsiteTemplateSelection(
  userId)` — Conflict (singular vs. plural copy) when `> 0`. On
      success: `updateById({ isActive: false })` then
      `userTemplatePreferenceRepository.deleteByUserKindAndTemplateId(
  userId, kind, template.id)`. Returns `{ templateId, archived:
  true }`.
- [x] T12. `setDefaultTemplateForUser(kind, templateId, userId)`:
      `findVisibleById` + kind match → NotFound `'Template not found
  for this user and kind.'`. Otherwise
      `userTemplatePreferenceRepository.upsertDefault(userId, kind,
  templateId)`. Returns `{ defaultTemplateId: templateId }`.
- [x] T13. `forkTemplateForUser({ kind, templateId, targetOwner },
  userId)`: six error classes per FR-16; existing-fork short-circuit
      per FR-17; failed `gitFacade.forkRepository` → BadRequest
      `'Forking the selected template failed.'` (FR-18); success
      upserts the row with the seven `metadata.forkedFromX` audit
      fields per FR-19; sets the new fork as the user's default per
      FR-20.
- [x] T14. `getVisibleTemplateForUser(kind, templateId, userId)`:
      `findVisibleById` + kind match → returns
      `TemplateCatalogItem` or `null` (no exception — read-only
      lookup helper).
- [x] T15. `getDefaultTemplateIdForUser(kind, userId)`:
      `userTemplatePreferenceRepository.findByUserAndKind` → if
      `findVisibleById(preference.templateId, userId)` resolves to a
      visible kind-matched row, return its id. Otherwise: for `kind:
  'website'` return `getDefaultWebsiteTemplateId()` (env-driven,
      `'classic'` fallback); for `kind: 'work'` return `null`.
- [x] T16. `refreshTemplatesForUser(kind, userId)`: when `kind ===
  'website'` run `syncDiscoveredWebsiteTemplatesForUser(userId)`
      unconditionally; then return `listTemplatesForUser(kind, userId)`.

## Phase 3 — Discovery

- [x] T17. `syncDiscoveredWebsiteTemplatesIfStale(userId)`:
      `templateRepository.hasRecentDiscoveredBuiltInTemplates('website',
  catalogOwner, now - 1h)` → only when `false` runs
      `syncDiscoveredWebsiteTemplatesForUser(userId)`.
- [x] T18. `syncDiscoveredWebsiteTemplatesForUser(userId)`: tries to
      get `accessToken = await gitFacade.getAccessToken({ userId,
  providerId: 'github' })`; walks pages 1..50 of 100 repos via
      `listRepositories({ providerId, userId, token: accessToken },
  page, 100, { owner: catalogOwner, type: 'org' })` (token path)
      OR `listPublicRepositories(providerId, page, 100, ...)` (no-token
      fallback). Breaks early when `pageRepositories.length < 100`.
      Warn-logs the 50-page safety cap.
- [x] T19. Filter discovered repositories via
      `isStandardTemplateRepository(repo)` (`/template$/i.test(repo.trim())`).
- [x] T20. Reconcile discovered ids: prefer
      `findBuiltInByRepositoryCoordinates('website', repo.owner,
  repo.name)`'s id as the canonical id; otherwise
      `repo.name.toLowerCase()`. When the discovered id collides with
      an existing row whose coordinates differ, SKIP with warn log
      (`Skipping discovered template "<fullName>" because id
  "<discoveredId>" is already used by …`).
- [x] T21. Upsert each discovered template with `id: canonicalId,
  kind: 'website', sourceType: 'built_in', name:
  humanizeRepositoryName(repo.name), description: repo.description
  || null, framework: inferFrameworkFromRepository(repo.name),
  repositoryUrl: repo.url, repositoryOwner / Name, branch:
  repo.defaultBranch || 'main', syncBranches:
  [repo.defaultBranch || 'main'], betaBranch: null, isActive:
  true, metadata: { discoveredFromOrganization: catalogOwner,
  fullName: repo.fullName }`.
- [x] T22. Deactivate the duplicate row when
      `canonicalId !== discoveredId` AND a discovered-id row exists
      with matching coordinates AND is currently active.
- [x] T23. Outer try/catch: warn-log
      `Failed to sync discovered website templates for user <userId>:
  <msg>` and resolve so the calling list endpoint still completes.

## Phase 4 — HTTP Surface

- [x] T24. `TemplateCatalogController` at
      `apps/api/src/template-catalog/template-catalog.controller.ts`
      mounted on `/api`, behind the global `AuthSessionGuard`,
      injecting `TemplateCatalogService` + `ActivityLogService`.
- [x] T25. `GET /api/templates` accepts `?kind=<website|work>` via
      `ListTemplatesQueryDto`; runs
      `templateCatalogService.listTemplatesForUser(query.kind,
  auth.userId)`; returns `{ status: 'success', kind,
  defaultTemplateId, templates }`.
- [x] T26. `POST /api/templates/custom` accepts `AddCustomTemplateDto`;
      after success emits fire-and-forget activity-log
      `{ actionType: TEMPLATE_ADDED, action: 'template.added', status:
  COMPLETED, summary: 'Added <kind> template: <name>', metadata:
  { templateId, kind } }.catch(() => {})`.
- [x] T27. `PUT /api/templates/custom/:templateId` accepts
      `UpdateCustomTemplateDto`; emits
      `TEMPLATE_UPDATED` / `template.updated` activity-log entry on
      success.
- [x] T28. `POST /api/templates/custom/:templateId/archive` accepts
      `ArchiveCustomTemplateDto`; emits `TEMPLATE_ARCHIVED` /
      `template.archived` on success; returns `{ status: 'success',
  templateId, archived: true }`.
- [x] T29. `PUT /api/templates/default` accepts
      `SetDefaultTemplateDto`; emits `TEMPLATE_DEFAULT_SET` /
      `template.default_set`; returns `{ status: 'success', kind,
  defaultTemplateId }`.
- [x] T30. `POST /api/templates/fork` accepts `ForkTemplateDto`; emits
      `TEMPLATE_FORKED` / `template.forked` ONLY when `result.created
  === true` (gated by `if (result.created)` in the controller);
      returns `{ status: 'success', kind, defaultTemplateId, template,
  repository, created }`.
- [x] T31. `POST /api/templates/refresh` accepts `RefreshTemplatesDto`;
      runs `refreshTemplatesForUser`; returns `{ status: 'success',
  kind, defaultTemplateId, templates }`. NO activity-log emission.
- [x] T32. DTOs in `apps/api/src/template-catalog/dto/list-templates.dto.ts`
      with `@IsString` + `@IsIn(['website','work'])` on every `kind`
      field; `@IsUrl({ protocols: ['http','https'], require_protocol:
  true })` on `repositoryUrl` / `previewImageUrl`; `@IsOptional()`
      on every optional field.

## Phase 5 — Tests

- [x] T33. `template-catalog.controller.spec.ts` (apps/api) — covers
      all 7 endpoints' positional service args, `AuthService` /
      activity-log fire-and-forget pattern, `result.created` gate on
      `template.forked`, error propagation.
- [x] T34. `template-catalog.service.spec.ts` (packages/agent) —
      covers seed, list-with-stale-discovery gate, all six error
      classes on `forkTemplateForUser`, the existing-fork
      short-circuit, the seven `metadata.forkedFromX` audit fields,
      the discovered-id collision skip, the deactivate-duplicate
      branch, the singular-vs-plural archive refusal copy, and the
      `getDefaultTemplateIdForUser` fallback chain.
- [ ] T35. **FOLLOW-UP** — Postgres-container integration test that
      walks the full happy path: seed runs, user adds a custom
      template, sets it as default, archives it (Conflict on assigned
      work, success after detach). Currently covered only at unit
      level with mocked repositories.
- [ ] T36. **FOLLOW-UP** — e2e test against
      `GET/POST /api/templates*` endpoints, asserting the
      `AuthSessionGuard` 401 path, the `@IsIn` 400 path on `kind`,
      and the round-trip add-fork-archive cycle with a real GitHub
      stub.

## Phase 6 — Open Questions / Outstanding Work

- [ ] T37. **OQ-1** — Generalise the fork flow to non-GitHub git
      providers. Today `providerId = 'github'` is a literal in
      `forkTemplateForUser` and `syncDiscoveredWebsiteTemplatesForUser`.
- [ ] T38. **OQ-2** — Decide the `kind: 'work'` discovery convention
      (e.g. `*work-template` GitHub-name suffix vs.
      separate organization).
- [ ] T39. **OQ-3** — Add an early reachability check (HTTP HEAD on
      `repositoryUrl`) in `addCustomTemplate` so users can't register
      private / non-existent repos that fail downstream in the
      website-generator clone path.
- [ ] T40. **OQ-4** — Skip the `getDefaultWebsiteTemplateId()`
      fallback in `getDefaultTemplateIdForUser` when the resolved
      seed default is no longer active (archived by the operator).
- [ ] T41. **OQ-5** — Decide whether `template.refreshed` should be
      logged for audit. Refreshes mutate persisted rows on a
      successful discovery pass.

## Definition of Done

- All FRs in `spec.md` map to a passing test.
- All 7 endpoints have controller-level coverage.
- `TemplateCatalogService` has agent-package unit coverage of every
  branch in `addCustomTemplate` / `updateCustomTemplateForUser` /
  `archiveCustomTemplateForUser` / `forkTemplateForUser` /
  `getDefaultTemplateIdForUser`.
- Discovery covers the canonical-vs-discovered id reconciliation
  branch and the duplicate-deactivation branch.
- `COVERAGE-TRACKER.md` reflects the spec landing under
  "Pending — Medium Priority → Spec Kit features that need a spec".
