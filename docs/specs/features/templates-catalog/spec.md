# Feature Specification: Templates Catalog

**Feature ID**: `templates-catalog`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The templates catalog is the platform's per-user, per-kind registry of
website and work templates. It exposes seven HTTP endpoints
(`GET /api/templates`, `POST /api/templates/custom`,
`PUT /api/templates/custom/:templateId`,
`POST /api/templates/custom/:templateId/archive`,
`PUT /api/templates/default`, `POST /api/templates/fork`,
`POST /api/templates/refresh`) that let an authenticated user list the
templates visible to them (built-in + their own custom rows), add a
custom template from a GitHub URL, fork a built-in standard template
into their own GitHub account or organization, set a per-kind default,
update or archive a custom template, and refresh the catalog by
re-syncing GitHub-discovered built-in templates. The platform seeds the
canonical website templates on every module bootstrap (`Classic` always,
plus `Minimal` when `WEBSITE_TEMPLATE_MINIMAL_REPO` is set), runs an
on-demand discovery pass for any repository in
`WEBSITE_TEMPLATE_CATALOG_ORG` (default `ever-works`) whose name ends in
`*template` — gated by a 1-hour TTL so back-to-back list calls don't
re-hit GitHub — and emits a fire-and-forget activity-log entry for the
five mutating endpoints (`add` / `update` / `archive` /
`set default` / `fork-when-newly-created`).

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I am an authenticated user, **when** I call
  `GET /api/templates?kind=website`, **then** the response is
  `{ status: 'success', kind: 'website', defaultTemplateId, templates }`
  where `templates` is the union of `(sourceType='built_in' AND
  isActive=true)` rows and `(sourceType='custom' AND ownerUserId=me AND
  isActive=true)` rows, sorted by `sourceType DESC` (custom first) then
  `name ASC`.
- **Given** the website-template GitHub catalog
  (`WEBSITE_TEMPLATE_CATALOG_ORG`, default `ever-works`) was last
  re-synced more than 1 hour ago (the `WEBSITE_DISCOVERY_SYNC_TTL_MS`
  window), **when** I call `GET /api/templates?kind=website`, **then**
  the controller calls `listTemplatesForUser`, which calls
  `syncDiscoveredWebsiteTemplatesIfStale(userId)` BEFORE the read; that
  walks GitHub up to 50 pages × 100 repos, filters to
  `*template`-suffixed repository names (case-insensitive trailing
  `template`), and upserts each one with the canonical id (existing
  built-in by `(repositoryOwner, repositoryName)` wins; otherwise
  `repository.name.toLowerCase()`).
- **Given** I add a custom template, **when** I call
  `POST /api/templates/custom` with `{ kind: 'website', repositoryUrl:
  'https://github.com/me/my-template', name: 'My Template' }`, **then**
  the service `parseGitHubRepositoryUrl`s the URL, refuses non-GitHub
  URLs with `BadRequestException('Only valid GitHub repository URLs
  are supported for custom templates.')`, refuses duplicate adds with
  `ConflictException('You already added this template repository.')`,
  and otherwise upserts a row keyed by `id = 'custom-<uuid>'` with
  `sourceType: 'custom'`, `ownerUserId: me`, normalised
  `branch: 'main'` (when omitted), `syncBranches: [branch]` (when
  omitted), and a humanised `name` (`humanizeRepositoryName(repo)`)
  fallback. A `template.added` activity-log entry is emitted
  fire-and-forget.
- **Given** I fork a standard template, **when** I call
  `POST /api/templates/fork` with `{ kind: 'website', templateId:
  'classic', targetOwner: 'me' }`, **then** the service rejects with
  `NotFoundException` if the template is not visible to me, with
  `BadRequestException('Only standard templates can be forked.')` if
  the template is already custom, with
  `BadRequestException('A target account or organization is
  required.')` on empty `targetOwner`, and with
  `BadRequestException('The selected fork target is not available for
  this GitHub connection.')` if the resolved login is neither my
  GitHub user nor a connected organization. On the happy path it calls
  `gitFacade.forkRepository`, upserts a `custom-<uuid>` row that
  inherits the source template's `name`/`description`/`framework`/
  `previewImageUrl`/`syncBranches`/`betaBranch`, sets
  `metadata.forkedFromTemplateId` plus three audit fields, and sets the
  fork as the user's default for that kind.
- **Given** I have already forked a standard template into the same
  target before, **when** I call `POST /api/templates/fork` again with
  the same `{ kind, templateId, targetOwner }`, **then** the service
  short-circuits — it does NOT re-call `gitFacade.forkRepository` —
  re-adopts the existing custom row as my default, returns
  `{ defaultTemplateId, template, repository, created: false }`, and
  emits NO `template.forked` activity-log entry (the gate is
  `if (result.created)`).
- **Given** I set a default, **when** I call `PUT /api/templates/default`
  with `{ kind: 'website', templateId: '<id>' }`, **then** the service
  refuses with `NotFoundException` when the template is not visible to
  me or the kind does not match, otherwise upserts a
  `user_template_preferences` row (`(userId, kind)` unique) and emits a
  `template.default_set` activity-log entry. The next
  `GET /api/templates?kind=website` reflects the new
  `defaultTemplateId`.
- **Given** I update a custom template, **when** I call
  `PUT /api/templates/custom/:templateId` with `{ kind: 'website', name,
  description, framework, previewImageUrl, branch, betaBranch }`, **then**
  the service refuses with `NotFoundException('Custom template not
  found for this user and kind.')` when the row is not active, not
  custom, not mine, or does not match `kind`. On the happy path each
  field follows the "undefined → preserve, empty-string → null/preserve"
  rules pinned in §3 FR-9 / FR-10, the row is updated, and a
  `template.updated` activity-log entry is emitted.
- **Given** I archive a custom template, **when** I call
  `POST /api/templates/custom/:templateId/archive` with
  `{ kind: 'website' }`, **then** the service refuses with
  `NotFoundException` when the row is not active / mine / matching kind,
  refuses with `ConflictException('This template is still assigned to
  N work(s). Reassign … before archiving the template.')` when the
  template is currently assigned to one or more works (singular vs
  plural copy), additionally refuses with `ConflictException('This
  template is your current default and N work(s) inherit it. Reassign
  those works or change your default template before archiving.')` when
  it is the user's default AND any works are inheriting it (only checked
  when not currently assigned to a specific work), then sets
  `isActive = false` and removes the matching `user_template_preferences`
  row before emitting a `template.archived` activity-log entry.
- **Given** I want a fresh catalog, **when** I call
  `POST /api/templates/refresh` with `{ kind: 'website' }`, **then**
  the service unconditionally re-syncs GitHub-discovered website
  templates (no TTL check), then returns the list as
  `listTemplatesForUser` would.

### 2.2 Edge cases & failures

- **Given** the GitHub discovery call fails (rate limit, connectivity,
  invalid token), **when** `syncDiscoveredWebsiteTemplatesForUser` runs,
  **then** the error is caught and logged at warn level
  (`Failed to sync discovered website templates for user <id>: <msg>`)
  — the user-facing list call still succeeds and falls back to the
  already-persisted templates.
- **Given** the catalog walk hits 50 pages without exhausting the
  `pageRepositories.length < perPage` exit, **when** the loop ends,
  **then** the service logs at warn level
  (`Template discovery for org <owner> hit the 50-page safety cap;
  some repositories may be missing from the catalog.`).
- **Given** a discovered repository would collide with an existing row
  whose id matches `repository.name.toLowerCase()` but does NOT match
  `(repositoryOwner, repositoryName)`, **when**
  `syncDiscoveredWebsiteTemplatesForUser` projects that repository,
  **then** the row is SKIPPED with a warn log
  (`Skipping discovered template "<fullName>" because id "<discoveredId>"
  is already used by <owner>/<name>.`).
- **Given** the canonical built-in template id (e.g. `classic`) differs
  from the discovered id (e.g. `directory-web-template`), **when**
  `syncDiscoveredWebsiteTemplatesForUser` upserts the canonical row,
  **then** any duplicate active row keyed by the discovered id that
  carries the same coordinates is deactivated (`isActive: false`) so
  the user only sees one entry.
- **Given** the user has no `user_template_preferences` row for a
  given kind, **when** `getDefaultTemplateIdForUser('website',
  userId)` runs, **then** it falls back to
  `getDefaultWebsiteTemplateId()` (env-driven via
  `WEBSITE_TEMPLATE_DEFAULT_ID`, fallback `'classic'`); for `kind:
  'work'`, it returns `null` (no fallback).
- **Given** `seedBuiltInTemplates` throws during `onModuleInit`,
  **when** the module boots, **then** the service catches and warns
  (`Failed to seed built-in templates during startup: <msg>`); the
  module finishes booting. Subsequent calls re-attempt the seed
  on-demand (via the discovery pass for `website` kind).
- **Given** I add a custom template with the same canonical
  `repositoryUrl` as an already-active row I own, **when**
  `addCustomTemplate` runs, **then** it short-circuits with
  `ConflictException` BEFORE the upsert.
- **Given** activity-log emission fails (DB error), **when** any
  mutating endpoint completes, **then** the controller's
  `.catch(() => {})` swallows the rejection so the user-facing call
  still returns 200.

## 3. Functional Requirements

- **FR-1** The system MUST seed all built-in website templates on
  `SubscriptionService`-style `onModuleInit`, idempotently, via
  `TemplateRepository.upsert`, sourced from `listWebsiteTemplates()`
  (`Classic` is always present; `Minimal` only when
  `WEBSITE_TEMPLATE_MINIMAL_REPO` is set).
- **FR-2** The system MUST expose `GET /api/templates?kind=<website|work>`
  returning `{ status: 'success', kind, defaultTemplateId, templates }`
  with `templates` as `findVisibleByKind(kind, userId)` mapped to
  `TemplateCatalogItem`s and ordered `sourceType DESC, name ASC`.
- **FR-3** The system MUST run
  `syncDiscoveredWebsiteTemplatesIfStale(userId)` BEFORE the read on
  `GET /api/templates?kind=website` when no built-in website template
  has an `updatedAt >= now() - 1h` AND
  `metadata.discoveredFromOrganization = catalogOwner`.
- **FR-4** The system MUST cap the GitHub discovery walk at 50 pages × 100
  repositories per page, logging a warn line when the cap is hit.
- **FR-5** The system MUST filter discovered repositories to those whose
  name ends in `template` (case-insensitive trailing match), using
  `isStandardTemplateRepository` (`/template$/i.test(name.trim())`).
- **FR-6** The system MUST resolve discovered template ids by:
  (a) `findBuiltInByRepositoryCoordinates(kind, owner, name)` — if a
  canonical row exists, reuse its id; otherwise (b)
  `repository.name.toLowerCase()`. The canonical id wins; the discovered
  id is deactivated when it duplicates the canonical row's coordinates.
- **FR-7** The system MUST refuse non-GitHub URLs in
  `addCustomTemplate` with `BadRequestException({ status: 'error',
  message: 'Only valid GitHub repository URLs are supported for custom
  templates.' })` (uses `parseGitHubRepositoryUrl` from
  `@ever-works/contracts`).
- **FR-8** The system MUST refuse duplicate `addCustomTemplate` calls
  by the same user against the same `parseGitHubRepositoryUrl`-canonical
  URL with `ConflictException({ status: 'error', message: 'You already
  added this template repository.' })`.
- **FR-9** The system MUST default `branch` to `'main'` and
  `syncBranches` to `[branch]` when those fields are omitted from
  `addCustomTemplate`'s body. `name` defaults to
  `humanizeRepositoryName(repository.repo)`. `framework` defaults to
  `inferFrameworkFromRepository(repository.repo)` (`'Astro'` /
  `'Next.js'` / `null`).
- **FR-10** The system MUST honour the "undefined → preserve, empty
  string → null/preserve" semantics for every optional field of
  `updateCustomTemplateForUser`: `name` empty-string preserves the
  existing value, `description` empty-string clears to `null`,
  `framework` empty-string clears to `null`, `previewImageUrl`
  empty-string clears to `null`, `betaBranch` empty-string clears to
  `null`, `branch` empty-string preserves the existing value. When
  `branch` is changed, `syncBranches` of length 1 is rewritten to
  `[newBranch]`; otherwise the existing branch entry is replaced
  in-place inside `syncBranches`.
- **FR-11** The system MUST refuse `updateCustomTemplateForUser` and
  `archiveCustomTemplateForUser` when the row is not
  `(active AND custom AND owned-by-me AND kind-matching)` with
  `NotFoundException({ status: 'error', message: 'Custom template not
  found for this user and kind.' })`.
- **FR-12** The system MUST refuse archive when the template is
  currently assigned to one or more works
  (`workRepository.countByUserAndWebsiteTemplateId(userId, templateId)
  > 0`) for `kind: 'website'`, with singular vs. plural copy
  (`'1 work. … the template'` vs `'<N> works. … the template'`).
- **FR-13** The system MUST refuse archive when the template is the
  user's current default AND inheriting works exist
  (`workRepository.countByUserAndInheritedWebsiteTemplateSelection(userId)
  > 0`) — only checked AFTER the per-template usage check passed.
- **FR-14** The system MUST set `isActive = false` (soft delete) on
  archive and remove the matching
  `user_template_preferences (userId, kind, templateId)` row.
- **FR-15** The system MUST refuse `setDefaultTemplateForUser` when
  the template is not visible to the user or `kind` does not match
  with `NotFoundException({ status: 'error', message: 'Template not
  found for this user and kind.' })`. On success it upserts the
  `(userId, kind, templateId)` row.
- **FR-16** The system MUST refuse `forkTemplateForUser` with
  `NotFoundException` for invisible / kind-mismatched templates,
  `BadRequestException('Only standard templates can be forked.')` for
  custom templates, `BadRequestException('A target account or
  organization is required.')` for empty `targetOwner` (after `.trim()`),
  and `BadRequestException('The selected fork target is not available
  for this GitHub connection.')` when the target is neither the user's
  GitHub login nor a connected organization (case-insensitive match).
- **FR-17** The system MUST short-circuit `forkTemplateForUser` when
  `findOwnedCustomByRepositoryCoordinates(kind, userId, targetOwner,
  template.repositoryName)` returns a row: re-adopt it as the default
  via `userTemplatePreferenceRepository.upsertDefault`, return
  `{ defaultTemplateId, template, repository, created: false }`, and
  do NOT call `gitFacade.forkRepository`.
- **FR-18** The system MUST refuse a failed
  `gitFacade.forkRepository` (returns falsy) with
  `BadRequestException('Forking the selected template failed.')`.
- **FR-19** The system MUST upsert the forked-template row with
  `id: 'custom-<uuid>'`, `sourceType: 'custom'`, `ownerUserId: userId`,
  inherited `name`/`description`/`framework`/`previewImageUrl`/
  `syncBranches`/`betaBranch` from the source template, and metadata
  `{ forkedFromTemplateId, forkedFromRepositoryUrl, forkedFromOwner,
  forkedFromRepositoryName, forkTargetType: 'personal'|'organization' }`.
- **FR-20** The system MUST set the fork as the user's default for that
  kind via `userTemplatePreferenceRepository.upsertDefault`.
- **FR-21** The system MUST emit fire-and-forget activity-log entries
  via `activityLogService.log({ userId, actionType, action, status,
  summary, metadata }).catch(() => {})` for the five mutating endpoints:
  `template.added`, `template.updated`, `template.archived`,
  `template.default_set`, `template.forked` (the last only when
  `result.created === true`).
- **FR-22** The system MUST NOT emit any activity-log entry for
  `listTemplates` or `refreshTemplates` (read endpoints).
- **FR-23** The system MUST resolve the user's default template id by
  consulting `user_template_preferences` first; if the preference's
  template is not visible (archived / kind mismatch / not in the
  user's visible set), fall back to `getDefaultWebsiteTemplateId()`
  for `kind: 'website'` and `null` for `kind: 'work'`.
- **FR-24** The system MUST attach `originType` to every
  `TemplateCatalogItem`: `'standard'` for `sourceType='built_in'`,
  `'forked'` when `metadata.forkedFromTemplateId` is set, `'custom_url'`
  otherwise.

## 4. Non-Functional Requirements

- **Performance**: `GET /api/templates?kind=website` is gated by a 1-hour
  TTL on the discovery pass; in steady state it is two DB reads
  (`findVisibleByKind` + `getDefaultTemplateIdForUser`). After the TTL
  expires, the next call walks GitHub up to 50 × 100 repositories
  before responding — operators on a large catalog should expect
  multi-second latency for this single warm-cache call.
- **Reliability**: Built-in seed runs on every boot but is wrapped in
  a try/catch in `onModuleInit`; a seed failure does NOT crash the
  module (`Failed to seed built-in templates during startup` warn log).
  Discovery also has its own try/catch with warn log; the user-facing
  list still resolves on discovery failure.
- **Security & privacy**: All endpoints sit behind the global
  `AuthSessionGuard` (no `@Public()`); per-row visibility is enforced
  via `findVisibleByKind` (only own `custom` + every `built_in`).
  `addCustomTemplate` / `forkTemplateForUser` accept arbitrary
  GitHub URLs but `parseGitHubRepositoryUrl` rejects non-GitHub
  hosts. Activity-log entries record `templateId`/`kind` only —
  no token / repository content material.
- **Observability**: `template.added` / `template.updated` /
  `template.archived` / `template.default_set` /
  `template.forked` actions land in `activity_logs`. Three warn-level
  log lines surface in normal operation: seed failure, discovery
  failure, 50-page cap hit, id-collision skip.
- **Compatibility**: `TemplateKind` is currently `'website' | 'work'`;
  adding a new kind means extending the union and the
  `TEMPLATE_KINDS` const in `list-templates.dto.ts`. The custom-id
  scheme (`custom-<uuid>`) is forward-compatible — built-in ids
  collide only when the discovery pass picks up a repository whose
  lowercased name matches a canonical built-in id.

## 5. Key Entities & Domain Concepts

| Entity / concept                | Description                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Template`                      | Single registry row keyed by `id` (varchar PK, 120). Stores `kind`, `sourceType` (`built_in` / `custom`), optional `ownerUserId`, `name`, `description`, `framework`, `previewImageUrl`, `repositoryUrl`, `repositoryOwner`, `repositoryName`, `branch` (default `main`), `syncBranches[]`, `betaBranch`, `isActive`, `metadata` JSON. |
| `UserTemplatePreference`        | Per-user, per-kind default selection — row keyed by `(userId, kind)` unique. Holds `templateId` pointing to the chosen `Template.id`.                                     |
| `TemplateCatalogItem`           | DTO returned by every list / mutation: `{ id, kind, sourceType, originType, name, description, framework, previewImageUrl, repositoryUrl, repositoryOwner, repositoryName, branch, syncBranches[], betaBranch, isActive, isDefault, ownerUserId }`. |
| `TemplateKind`                  | Closed union: `'website'` (web-output template) or `'work'` (work-data template). Currently only the `website` kind has discovery / `Minimal` / `Classic` seeds.          |
| `TemplateSourceType`            | Closed union: `'built_in'` (seed-or-discovery owned) or `'custom'` (user-owned, possibly forked).                                                                         |
| `originType`                    | Computed at projection time: `'standard'` (built-in), `'forked'` (custom + `metadata.forkedFromTemplateId`), `'custom_url'` (custom otherwise).                          |
| `WebsiteTemplateConfig`         | Hard-coded per-deploy structure consumed by `seedBuiltInTemplates`: `{ id, name, description, owner, repo, branch, syncBranches[], betaBranch }`. Today: `Classic` always, plus `Minimal` when `WEBSITE_TEMPLATE_MINIMAL_REPO` is set. |
| `getDefaultWebsiteTemplateId()` | Resolves the env-driven default (`WEBSITE_TEMPLATE_DEFAULT_ID`, fallback `'classic'`) only when the resolved id matches a configured template; otherwise `'classic'`.    |

## 6. Out of Scope

- The website-generator's runtime template execution (rendering, build,
  deploy) — covered in [`features/website-generator/spec`](../website-generator/spec.md).
- The `WebsiteTemplateSchedulerService` cron job that updates
  `Work.websiteTemplateLastCommit` and tracks template-update
  notifications — covered in `WebsiteTemplateSchedulerService` (a
  scheduler in `apps/api/src/works/tasks/`).
- Switching a work's website template (`switchWebsiteTemplate` in
  `works.controller.ts`) — covered in
  [`features/website-generator/spec`](../website-generator/spec.md).
- Email / Handlebars templates under `apps/api/src/templates/*.hbs` —
  unrelated to the templates catalog despite the directory name overlap;
  see [`features/mail-providers/spec`](../mail-providers/spec.md).
- Template marketplaces / publishing flows — out of scope; the
  catalog is per-user only today.

## 7. Acceptance Criteria

- [ ] `GET /api/templates?kind=website` returns the union of built-in +
      own-custom rows, ordered by `sourceType DESC, name ASC`, with the
      correct `defaultTemplateId` from `user_template_preferences`
      (fallback to `getDefaultWebsiteTemplateId()` when no preference).
- [ ] `GET /api/templates?kind=website` triggers a discovery pass
      ONLY when no built-in website template was updated in the last
      hour AND its `metadata.discoveredFromOrganization` matches
      `catalogOwner`.
- [ ] `POST /api/templates/custom` rejects non-GitHub URLs and
      duplicate adds with the exact 400 / 409 messages.
- [ ] `POST /api/templates/custom` populates `branch = 'main'` and
      `syncBranches = ['main']` when omitted; populates `name` from
      `humanizeRepositoryName(repo)` when omitted; populates
      `framework` from `inferFrameworkFromRepository(repo)` when
      omitted.
- [ ] `PUT /api/templates/custom/:templateId` honours the
      "undefined → preserve, empty-string → null/preserve" rules per
      FR-10, including `syncBranches` rewrite when `branch` changes.
- [ ] `POST /api/templates/custom/:templateId/archive` rejects with
      409 + singular vs. plural copy when works currently use the
      template, rejects with 409 + the "current default … N work(s)
      inherit" copy when applicable, and on success sets
      `isActive = false` AND removes the matching preference row.
- [ ] `PUT /api/templates/default` rejects invisible / kind-mismatched
      templates with 404 and emits a `template.default_set`
      activity-log entry on success.
- [ ] `POST /api/templates/fork` rejects each error class with the
      exact pinned message; the happy path forks the repository,
      upserts the row with the seven `metadata.forkedFromX` audit
      fields, and sets the fork as the user's default.
- [ ] `POST /api/templates/fork` short-circuits when an existing fork
      row matches `(kind, userId, targetOwner, repositoryName)` and
      does NOT call `gitFacade.forkRepository` again, returns
      `created: false`, and emits NO `template.forked` activity-log
      entry.
- [ ] `POST /api/templates/refresh` re-syncs unconditionally (no TTL
      gate) and returns the catalog as `listTemplatesForUser` would.
- [ ] All five mutating endpoints emit fire-and-forget activity-log
      entries with `.catch(() => {})`; activity-log failures NEVER
      propagate to the user.
- [ ] `seedBuiltInTemplates` is idempotent (`upsert` with `id` conflict
      path), and `onModuleInit` swallows seed failures with a warn log.
- [ ] All functional requirements have at least one passing unit or
      e2e test.

## 8. Open Questions

- `[NEEDS CLARIFICATION: OQ-1 — The fork flow hard-codes `providerId = 'github'`. When a non-GitHub git provider lands (GitLab, Bitbucket), the flow needs a per-template `providerId` field on the source template row, not a literal.]`
- `[NEEDS CLARIFICATION: OQ-2 — The `kind: 'work'` discovery / seed path is empty (only `website` has built-in templates today). When work-template content lands, do we follow the same `*template` GitHub-name suffix convention or a different one (e.g. `*work-template`)?]`
- `[NEEDS CLARIFICATION: OQ-3 — `addCustomTemplate` does NOT do an HTTP HEAD on `repositoryUrl` to validate that the repository actually exists / is accessible. A user can register a template pointing at a private repo they cannot read, then fail downstream when the website-generator tries to clone. Should the catalog do an early reachability check?]`
- `[NEEDS CLARIFICATION: OQ-4 — `getDefaultTemplateIdForUser` falls back to `getDefaultWebsiteTemplateId()` even when the user has explicitly archived the seed default. Today this means the user's UI keeps showing `classic` as default even after they archive it via discovery. Worth a follow-up to skip the fallback when the resolved id is no longer active.]`
- `[NEEDS CLARIFICATION: OQ-5 — There is no controller-level activity-log emission for `template.refreshed`. Should refreshes be logged for audit? They mutate persisted rows on a successful discovery pass.]`

## 9. Constitution Gates

- [x] Plugin-first if introducing an external integration (Principle I) — N/A: GitHub access flows through the existing `GitFacadeService` plugin abstraction.
- [x] Capability-driven resolution if touching cross-plugin behaviour (Principle II) — `gitFacade.forkRepository` / `getOrganizations` / `listRepositories` use the `git-provider` capability.
- [x] Source-of-truth repos preserved (Principle III) — templates live in user-owned GitHub repos; the catalog only persists pointers + display metadata.
- [x] Long-running work via Trigger.dev (Principle IV) — N/A: discovery is on-demand and gated by a 1-hour TTL.
- [x] Schema changes ship as forward-only migrations (Principle V) — `templates` and `user_template_preferences` are additive; new `TemplateKind` values extend the union without a migration.
- [x] Tests accompany the change (Principle VI) — `template-catalog.controller.spec.ts` (apps/api) + `template-catalog.service.spec.ts` (packages/agent) cover the surface.
- [x] Secrets handled per `x-secret` rules (Principle VII) — GitHub access tokens flow through `GitFacadeService.getAccessToken({ userId, providerId })`; no token material lands in `templates.metadata`.
- [x] Plugin counts touch the canonical doc only (Principle VIII) — N/A.
- [x] Behaviour-first — no implementation in this spec (Principle IX) — implementation lives in `plan.md`.
- [x] Backwards-compatible API/SDK/schema changes (Principle X) — endpoints are additive; the `originType` field is computed, not stored.

## 10. References

- Source:
    - `apps/api/src/template-catalog/template-catalog.controller.ts`
    - `apps/api/src/template-catalog/template-catalog.module.ts`
    - `apps/api/src/template-catalog/dto/list-templates.dto.ts`
    - `packages/agent/src/template-catalog/template-catalog.service.ts`
    - `packages/agent/src/template-catalog/template-catalog.module.ts`
    - `packages/agent/src/entities/template.entity.ts`
    - `packages/agent/src/entities/user-template-preference.entity.ts`
    - `packages/agent/src/database/repositories/template.repository.ts`
    - `packages/agent/src/database/repositories/user-template-preference.repository.ts`
    - `packages/agent/src/generators/website-generator/config/website-template.config.ts`
- Related features:
    - [`features/website-generator/spec`](../website-generator/spec.md)
    - [`features/creating-a-work/spec`](../creating-a-work/spec.md)
    - [`features/git-operations/spec`](../git-operations/spec.md)
- User-facing docs:
    - [`docs/features/website-templates.md`](../../../features/website-templates.md)
    - PR #459 (`templates-catalog` landing PR)
