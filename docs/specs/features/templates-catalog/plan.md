# Implementation Plan: Templates Catalog

**Feature ID**: `templates-catalog`
**Spec**: `./spec.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-08

---

## 1. Architecture

```mermaid
flowchart TD
    Client[HTTP client] -->|7 endpoints under /api/templates*| Ctrl[TemplateCatalogController]
    Ctrl --> Auth[AuthSessionGuard\n(global)]
    Ctrl --> Svc[TemplateCatalogService\n(@ever-works/agent/template-catalog)]
    Svc -->|onModuleInit| Seed[seedBuiltInTemplates\n=> listWebsiteTemplates]
    Svc -->|listTemplatesForUser\n(kind=website + stale)| Discover[syncDiscoveredWebsiteTemplatesIfStale\n=> syncDiscoveredWebsiteTemplatesForUser]
    Discover --> Git[GitFacadeService\nlistRepositories / listPublicRepositories\nfilter /template$/i]
    Svc --> TplRepo[(templates)]
    Svc --> PrefRepo[(user_template_preferences)]
    Svc --> WorkRepo[(works)\ncountByUserAndWebsiteTemplateId\ncountByUserAndInheritedWebsiteTemplateSelection]
    Svc -->|forkTemplateForUser| Git2[GitFacadeService\ngetUser / getOrganizations / forkRepository]
    Ctrl -->|fire-and-forget .catch(() => {})| ActLog[ActivityLogService.log\n5 mutating endpoints]
```

## 2. Tech Choices

| Concern                   | Choice                                                                                                            | Rationale                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- | ------ | -------------------------------------------------------------------------------------- |
| HTTP surface              | NestJS controller `apps/api/src/template-catalog/template-catalog.controller.ts`                                  | Same per-endpoint shape as the rest of the API; SwaggerUI tags applied                                 |
| Auth                      | Global `AuthSessionGuard` (no `@Public()` on any endpoint)                                                        | Templates are per-user resources                                                                       |
| Validation                | `class-validator` DTOs in `dto/list-templates.dto.ts`                                                             | `@IsIn(['website','work'])` on `kind`; `@IsUrl({ protocols, require_protocol })` on URLs               |
| Persistence (catalog)     | TypeORM `templates` table, varchar PK (`built-in id` or `'custom-<uuid>'`)                                        | Single table for built-in + custom; `sourceType` discriminates; `ownerUserId` carries custom ownership |
| Persistence (default)     | TypeORM `user_template_preferences` table, `(userId, kind)` unique                                                | Per-kind default; falls back to env-driven `getDefaultWebsiteTemplateId()` when missing                |
| Built-in seed             | `WebsiteTemplateConfig` array (`Classic` always, `Minimal` env-gated) → `upsert(template)`                        | Idempotent; runs on every boot; tolerates partial seed failure via try/catch wrap in `onModuleInit`    |
| Discovery                 | `GitFacadeService.listRepositories({ owner, type: 'org' })` walked up to 50 × 100 with name filter `/template$/i` | TTL-gated (1 h via `WEBSITE_DISCOVERY_SYNC_TTL_MS`) so list endpoint stays fast in steady state        |
| Id reconciliation         | `findBuiltInByRepositoryCoordinates` (canonical wins) → `repository.name.toLowerCase()` (discovered)              | Avoids drift when an operator renames a discovered repo; deactivates duplicate discovered rows         |
| Custom-template id scheme | `'custom-' + randomUUID()`                                                                                        | Never collides with built-in ids; explicit prefix for fast scan in DB tooling                          |
| URL parsing               | `parseGitHubRepositoryUrl` from `@ever-works/contracts`                                                           | Single source of truth for canonical form (`https://github.com/<owner>/<repo>` w/ `.git` stripped)     |
| Branch defaults           | `branch ??= 'main'`, `syncBranches ??= [branch]`                                                                  | Matches the most common GitHub default; users can override                                             |
| Update field policy       | `field === undefined ? existing : (field.trim()                                                                   |                                                                                                        | existing | null)` | Explicit-undefined preserves; explicit-empty clears (or preserves for `name`/`branch`) |
| Fork flow                 | `gitFacade.getUser` + `getOrganizations` (parallel) → target check → `forkRepository` → upsert + `setDefault`     | Personal-vs-organization detection by case-insensitive `login` match                                   |
| Activity-log emission     | `activityLogService.log({...}).catch(() => {})` in controller                                                     | Fire-and-forget; mutations never fail because audit emission failed                                    |
| Error vocabulary          | `BadRequestException` / `ConflictException` / `NotFoundException` w/ `{ status, message }` body                   | Matches the rest of the API's error envelope shape                                                     |

## 3. Data Model

```sql
-- templates (TypeORM entity: Template)
CREATE TABLE templates (
    id varchar(120) PRIMARY KEY,                      -- 'classic' | 'minimal' | 'custom-<uuid>' | discovered repo lower-name
    kind varchar(32) NOT NULL,                        -- 'website' | 'work'
    "sourceType" varchar(32) NOT NULL DEFAULT 'built_in',  -- 'built_in' | 'custom'
    "ownerUserId" varchar NULL,                       -- non-null only for sourceType='custom'
    name varchar(120) NOT NULL,
    description text NULL,
    framework varchar(80) NULL,                       -- e.g. 'Astro' | 'Next.js' | NULL
    "previewImageUrl" varchar(2048) NULL,
    "repositoryUrl" varchar(2048) NULL,               -- canonical https://github.com/<owner>/<repo>
    "repositoryOwner" varchar(255) NOT NULL,
    "repositoryName" varchar(255) NOT NULL,
    branch varchar(255) NOT NULL DEFAULT 'main',
    "syncBranches" text NOT NULL DEFAULT '[]',        -- simple-json
    "betaBranch" varchar(255) NULL,
    "isActive" boolean NOT NULL DEFAULT true,
    metadata text NOT NULL DEFAULT '{}',              -- simple-json (forkedFromX audit fields, discoveredFromOrganization)
    "createdAt" timestamp NOT NULL DEFAULT now(),
    "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX templates_kind_source_active_idx ON templates(kind, "sourceType", "isActive");
CREATE INDEX templates_owner_kind_idx          ON templates("ownerUserId", kind);
```

```sql
-- user_template_preferences (TypeORM entity: UserTemplatePreference)
CREATE TABLE user_template_preferences (
    id uuid PRIMARY KEY,
    "userId" varchar NOT NULL,
    kind varchar(32) NOT NULL,
    "templateId" varchar(120) NOT NULL,
    "createdAt" timestamp NOT NULL DEFAULT now(),
    "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_template_pref_user_kind_idx ON user_template_preferences("userId", kind);
CREATE INDEX        user_template_pref_template_idx ON user_template_preferences("templateId");
```

## 4. HTTP Surface

| Method | Path                                        | Body / Query                                                                                       | Activity log emitted                    | Notes                                                                                          |
| ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/templates`                            | `?kind=website                                                                                     | work`                                   | —                                                                                              | Triggers discovery pass when stale (kind=website only) |
| POST   | `/api/templates/custom`                     | `{ kind, repositoryUrl, name?, description?, framework?, previewImageUrl?, branch?, betaBranch? }` | `template.added`                        | `parseGitHubRepositoryUrl` validates URL                                                       |
| PUT    | `/api/templates/custom/:templateId`         | `{ kind, name?, description?, framework?, previewImageUrl?, branch?, betaBranch? }`                | `template.updated`                      | undefined → preserve, empty-string → clear/preserve per FR-10                                  |
| POST   | `/api/templates/custom/:templateId/archive` | `{ kind }`                                                                                         | `template.archived`                     | Soft delete via `isActive=false` + remove preference row                                       |
| PUT    | `/api/templates/default`                    | `{ kind, templateId }`                                                                             | `template.default_set`                  | Refuses invisible/kind-mismatched template                                                     |
| POST   | `/api/templates/fork`                       | `{ kind, templateId, targetOwner }`                                                                | `template.forked` (only when `created`) | Built-in only; short-circuits to existing fork row when (kind,user,targetOwner,repoName) match |
| POST   | `/api/templates/refresh`                    | `{ kind }`                                                                                         | —                                       | Unconditional discovery (kind=website); falls through for kind=work                            |

## 5. Discovery Algorithm (Website Kind)

```
syncDiscoveredWebsiteTemplatesIfStale(userId):
    catalogOwner = config.websiteTemplate.getCatalogOrganization()
    updatedSince = now - 1h (WEBSITE_DISCOVERY_SYNC_TTL_MS)
    has = templateRepository.hasRecentDiscoveredBuiltInTemplates(
              'website', catalogOwner, updatedSince)
    if !has: await syncDiscoveredWebsiteTemplatesForUser(userId)

syncDiscoveredWebsiteTemplatesForUser(userId):
    accessToken = await gitFacade.getAccessToken({userId, providerId: 'github'})
    repositories = []
    for page in 1..50:
        pageRepos = accessToken
            ? gitFacade.listRepositories({providerId, userId, token: accessToken}, page, 100, {owner: catalogOwner, type: 'org'})
            : gitFacade.listPublicRepositories(providerId, page, 100, {owner: catalogOwner, type: 'org'})
        repositories.push(...pageRepos)
        if pageRepos.length < 100: break
    if hit 50-page cap: warn-log

    for repo in repositories where isStandardTemplateRepository(repo.name):
        canonical = await templateRepository.findBuiltInByRepositoryCoordinates('website', repo.owner, repo.name)
        canonicalId = canonical?.id || repo.name.toLowerCase()
        if !canonical:
            existing = await templateRepository.findById(repo.name.toLowerCase())
            if existing && (existing.kind !== 'website' || existing.sourceType !== 'built_in'
                            || existing.repositoryOwner !== repo.owner
                            || existing.repositoryName !== repo.name):
                warn-log(`Skipping … id "<discoveredId>" already used by …`); continue
        await templateRepository.upsert({
            id: canonicalId, kind: 'website', sourceType: 'built_in',
            name: humanizeRepositoryName(repo.name),
            description: repo.description || null,
            framework: inferFrameworkFromRepository(repo.name),
            repositoryUrl: repo.url, repositoryOwner: repo.owner, repositoryName: repo.name,
            branch: repo.defaultBranch || 'main',
            syncBranches: [repo.defaultBranch || 'main'],
            betaBranch: null,
            isActive: true,
            metadata: { discoveredFromOrganization: catalogOwner, fullName: repo.fullName },
        })
        if canonicalId !== repo.name.toLowerCase():
            duplicate = await templateRepository.findById(repo.name.toLowerCase())
            if duplicate && duplicate.id !== canonicalId
                && duplicate.kind === 'website' && duplicate.sourceType === 'built_in'
                && duplicate.repositoryOwner === repo.owner
                && duplicate.repositoryName === repo.name
                && duplicate.isActive:
                await templateRepository.updateById(duplicate.id, { isActive: false })
```

The whole algorithm is wrapped in a try/catch that warn-logs
(`Failed to sync discovered website templates for user <userId>: <msg>`).

## 6. Fork Algorithm

```
forkTemplateForUser({ kind, templateId, targetOwner }, userId):
    template = await templateRepository.findVisibleById(templateId, userId)
    if !template || template.kind !== kind:
        throw NotFoundException('Template not found for this user and kind.')
    if template.sourceType !== 'built_in':
        throw BadRequestException('Only standard templates can be forked.')

    target = targetOwner.trim()
    if !target: throw BadRequestException('A target account or organization is required.')

    [gitUser, organizations] = await Promise.all([
        gitFacade.getUser({ userId, providerId: 'github' }),
        gitFacade.getOrganizations({ userId, providerId: 'github' }),
    ])
    isPersonal = gitUser.login.toLowerCase() === target.toLowerCase()
    org = organizations.find(o => o.login.toLowerCase() === target.toLowerCase())
    if !isPersonal && !org:
        throw BadRequestException('The selected fork target is not available for this GitHub connection.')

    existing = await templateRepository.findOwnedCustomByRepositoryCoordinates(
        kind, userId, target, template.repositoryName)
    if existing:
        await userTemplatePreferenceRepository.upsertDefault(userId, kind, existing.id)
        return { defaultTemplateId: existing.id, template: toCatalogItem(existing, existing.id),
                 repository: { owner, name, fullName, url }, created: false }

    forked = await gitFacade.forkRepository(
        template.repositoryOwner, template.repositoryName,
        { organization: isPersonal ? undefined : org.login },
        { userId, providerId: 'github' })
    if !forked: throw BadRequestException('Forking the selected template failed.')

    created = await templateRepository.upsert({
        id: 'custom-' + randomUUID(),
        kind, sourceType: 'custom', ownerUserId: userId,
        name: template.name,
        description: template.description || null,
        framework: template.framework || null,
        previewImageUrl: template.previewImageUrl || null,
        repositoryUrl: forked.url || gitFacade.getWebUrl('github', forked.owner, forked.name),
        repositoryOwner: forked.owner,
        repositoryName: forked.name,
        branch: forked.defaultBranch || template.branch,
        syncBranches: template.syncBranches.length > 0
            ? template.syncBranches
            : [forked.defaultBranch || template.branch],
        betaBranch: template.betaBranch || null,
        isActive: true,
        metadata: {
            forkedFromTemplateId: template.id,
            forkedFromRepositoryUrl: template.repositoryUrl,
            forkedFromOwner: template.repositoryOwner,
            forkedFromRepositoryName: template.repositoryName,
            forkTargetType: isPersonal ? 'personal' : 'organization',
        },
    })
    await userTemplatePreferenceRepository.upsertDefault(userId, kind, created.id)
    return { defaultTemplateId: created.id, template: toCatalogItem(created, created.id),
             repository: { owner, name, fullName, url }, created: true }
```

## 7. Configuration Surface

| Knob                                              | Env var                                | Default                              | Used by                                               |
| ------------------------------------------------- | -------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| `config.websiteTemplate.getCatalogOrganization()` | `WEBSITE_TEMPLATE_CATALOG_ORG`         | `'ever-works'`                       | Discovery owner filter                                |
| `config.websiteTemplate.getDefaultTemplateId()`   | `WEBSITE_TEMPLATE_DEFAULT_ID`          | `'classic'`                          | `getDefaultWebsiteTemplateId` fallback                |
| `config.websiteTemplate.getBetaBranch()`          | `WEBSITE_TEMPLATE_BETA_BRANCH`         | `'stage'`                            | `Classic` template `betaBranch`                       |
| `config.websiteTemplate.getMinimalOwner()`        | `WEBSITE_TEMPLATE_MINIMAL_OWNER`       | `'ever-works'`                       | `Minimal` template owner (only when minimal repo set) |
| `config.websiteTemplate.getMinimalRepo()`         | `WEBSITE_TEMPLATE_MINIMAL_REPO`        | unset (omitted from seed when unset) | `Minimal` template repo                               |
| `config.websiteTemplate.getMinimalBranch()`       | `WEBSITE_TEMPLATE_MINIMAL_BRANCH`      | `'main'`                             | `Minimal` template branch                             |
| `config.websiteTemplate.getMinimalBetaBranch()`   | `WEBSITE_TEMPLATE_MINIMAL_BETA_BRANCH` | `null`                               | `Minimal` template beta branch                        |
| `WEBSITE_DISCOVERY_SYNC_TTL_MS` (constant)        | — (in-code, 1 h)                       | `1000 * 60 * 60`                     | Discovery freshness gate                              |

## 8. Module Wiring

`packages/agent/src/template-catalog/template-catalog.module.ts`:

```ts
@Module({
	imports: [DatabaseModule, GitFacadeModule /* WorkRepository deps */],
	providers: [TemplateCatalogService],
	exports: [TemplateCatalogService]
})
export class TemplateCatalogModule {}
```

`apps/api/src/template-catalog/template-catalog.module.ts`:

```ts
@Module({
	imports: [AgentTemplateCatalogModule, ActivityLogModule],
	controllers: [TemplateCatalogController]
})
export class TemplateCatalogModule {}
```

`AppModule` imports `TemplateCatalogModule`, ensuring
`TemplateCatalogService.onModuleInit()` runs on every boot.

## 9. Test Surface

| Layer      | File                                                                   | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller | `apps/api/src/template-catalog/template-catalog.controller.spec.ts`    | Each of the 7 endpoints' positional service args, response envelope, activity-log emission shape (`actionType` / `action` / `summary` / `metadata`), and `result.created` gate on `template.forked`.                                                                                                                                                                                                                                                                                                          |
| Service    | `packages/agent/src/template-catalog/template-catalog.service.spec.ts` | `seedBuiltInTemplates` upsert calls, `listTemplatesForUser` ordering + discovery gate, `addCustomTemplate` URL/duplicate/defaults, `updateCustomTemplateForUser` undefined-vs-empty rules, `archiveCustomTemplateForUser` usage / inheriting-default refusal copy, `setDefaultTemplateForUser` 404 + upsert, `forkTemplateForUser` six error classes + short-circuit + happy path metadata, `getDefaultTemplateIdForUser` four-level resolution, discovery dedup + canonical-vs-discovered id reconciliation. |

## 10. Risks & Trade-offs

| Risk                                                                                     | Mitigation                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery walk burns GitHub rate budget for every cold list call                         | 1-hour TTL gate via `hasRecentDiscoveredBuiltInTemplates` keeps steady-state at zero discovery calls; the 50-page cap protects against unbounded walks.                                                          |
| Discovered template id collides with an unrelated built-in id                            | Skip-with-warn-log path in `syncDiscoveredWebsiteTemplatesForUser`; the canonical row by coordinates always wins.                                                                                                |
| `addCustomTemplate` accepts unreachable / private URLs                                   | OQ-3; documented. Today the failure surfaces in the website-generator's clone path, not the catalog.                                                                                                             |
| `getDefaultTemplateIdForUser` falls back to seed default even after the user archives it | OQ-4; documented. Low-impact because users almost never archive the seed default.                                                                                                                                |
| Fork flow hard-codes `providerId = 'github'`                                             | OQ-1; acceptable today since GitHub is the only git-provider plugin. When a second lands, the fork flow needs a per-template `providerId` field on the source row.                                               |
| Re-fork against a new target owner produces an entirely separate row                     | Intentional: re-forking into a different org/account is treated as a new template the user owns; the existing-fork short-circuit only triggers when `(kind, userId, targetOwner, repositoryName)` match exactly. |

## 11. Migration & Forward-Only Schema

Both tables are additive. New `TemplateKind` values extend the union;
adding `'data'` (for example) requires only:

1. Extending `TemplateKind` in `packages/agent/src/entities/template.entity.ts`.
2. Extending `TEMPLATE_KINDS` in `apps/api/src/template-catalog/dto/list-templates.dto.ts`.
3. Optionally adding a discovery path in `TemplateCatalogService` (today only `website` has one).

`origin_type` is computed at projection time, not stored, so adding new
`originType` values does not require a schema change.

## 12. References

- API reference: `docs/api/templates.md` (if present; otherwise the
  Spec Kit feature spec is the canonical reference).
- Operator reference: `docs/features/website-templates.md`.
- Landing PR: #459.
