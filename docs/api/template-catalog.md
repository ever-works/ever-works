---
id: template-catalog
title: Template Catalog API
sidebar_label: Template Catalog
sidebar_position: 25
---

# Template Catalog API

The template catalog manages the set of website and work scaffolding
templates available to a user. It mixes built-in templates (seeded on module
boot), repositories discovered via the user's GitHub installation, and
arbitrary custom templates added by repository URL. Each user has a per-kind
default that drives the new-work and new-website flows.

The catalog is rendered as a gallery in the platform dashboard's
**Templates** section.

## Architecture

```
apps/api/src/template-catalog/
  template-catalog.controller.ts   # 7 REST endpoints under /api/templates*
  template-catalog.module.ts       # Wires controller, agent module, activity-log
  dto/list-templates.dto.ts        # 7 DTOs (List/Add/Update/Archive/SetDefault/Fork/Refresh)

packages/agent/src/template-catalog/
  template-catalog.service.ts      # Seed, discovery, CRUD, fork, refresh
  ...
```

The agent-package `TemplateCatalogService` owns persistence and the GitHub
discovery pass (filtered to `*template`-suffix repositories under the user's
installations). The API controller is a thin layer that adds activity-log
emission on the five mutating endpoints.

## Template kinds

Every endpoint is parameterised by `kind`:

| Kind      | Purpose                                                       |
| --------- | ------------------------------------------------------------- |
| `website` | Templates for the public-facing website repository.           |
| `work`    | Templates for the work content repository (work scaffolding). |

The `kind` is validated via `class-validator`'s `@IsIn(['website', 'work'])`
on every DTO.

## Built-in seeds

`TemplateCatalogService.onModuleInit()` upserts two built-in templates on
boot, wrapped in `try/catch + warn-log` so a seed failure never blocks app
startup:

| Template  | Required env var                | Notes                                                                           |
| --------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `Classic` | always                          | The canonical default for new websites.                                         |
| `Minimal` | `WEBSITE_TEMPLATE_MINIMAL_REPO` | Optional; only seeded when the env var points at a `<owner>/<repo>` coordinate. |

Built-in templates are kept in sync across reboots via
`findBuiltInByRepositoryCoordinates(owner, repo)` so reseeding is idempotent.

## REST endpoints

All endpoints sit behind the global `AuthSessionGuard` and resolve the user
exclusively from `auth.userId`. Five of the seven endpoints fire-and-forget
an activity-log row via `.catch(() => {})` so an audit-write failure does
not break the user-facing endpoint.

### `GET /api/templates`

List templates visible to the current user for one kind.

**Query:** `?kind=website` or `?kind=work`.

**Response 200:**

```json
{
	"status": "success",
	"kind": "website",
	"defaultTemplateId": "tmpl-classic",
	"templates": [
		{
			"id": "tmpl-classic",
			"name": "Classic",
			"description": "...",
			"framework": "Next.js",
			"previewImageUrl": "https://...",
			"repositoryUrl": "https://github.com/ever-works/website-classic-template",
			"branch": "main",
			"originType": "standard",
			"kind": "website",
			"isActive": true
		}
	]
}
```

The `originType` field discriminates display rules in the UI:

| `originType` | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `standard`   | Built-in seed (`Classic` / `Minimal`).                             |
| `forked`     | A fork the user created from a built-in template via this catalog. |
| `custom_url` | A custom template added via `POST /api/templates/custom`.          |

### `POST /api/templates/custom`

Add a custom template from a GitHub repository URL.

**Request body:**

```json
{
	"kind": "website",
	"repositoryUrl": "https://github.com/owner/my-template",
	"name": "My Template",
	"description": "...",
	"framework": "Next.js",
	"previewImageUrl": "https://...",
	"branch": "main",
	"betaBranch": "beta"
}
```

Only `kind` + `repositoryUrl` are required (the URL is validated as `http`
or `https`). Defaults applied when fields are omitted:

- `branch` → `'main'`.
- `name` → `humanizeRepositoryName(repo)` (e.g. `my-template` → `My Template`).
- `framework` → inferred from the repository contents
  (`inferFrameworkFromRepository`).
- `description` / `previewImageUrl` / `betaBranch` → `null`.

**Errors:**

- `400 Bad Request` — `repositoryUrl` is not a valid GitHub URL parsable by
  `parseGitHubRepositoryUrl`. Message:
  `Only valid GitHub repository URLs are supported for custom templates.`
- `409 Conflict` — duplicate. Message:
  `You already added this template repository.`

**Activity log:** `template_added` / `template.added` /
`Added <kind> template: <name>` with `metadata: { templateId, kind }`.

### `PUT /api/templates/custom/:templateId`

Update a custom template's editable metadata. The owner is derived from
`auth.userId`; cross-user updates return `404`.

The DTO follows three rules for each optional field:

- `undefined` → preserve the existing value.
- empty-string → set to `null` (clear) for nullable fields, otherwise
  preserve.
- any other value → write it.

If `branch` changes, the service re-runs `syncBranches` so beta-vs-main
detection stays consistent.

**Activity log:** `template_updated` / `template.updated`.

### `POST /api/templates/custom/:templateId/archive`

Soft-delete a custom template via `isActive=false`. The service refuses
the archive when the template is:

- assigned as the default for one or more works (singular vs plural copy),
- inheriting-default for one or more works (singular vs plural copy).

Both cases return `409 Conflict` with a user-readable message naming the
blocking work(s). On success the per-user preference row is removed too,
so the user falls back to whatever `getDefaultTemplateIdForUser` resolves
next.

**Activity log:** `template_archived` / `template.archived`.

### `PUT /api/templates/default`

Set the default template for the current user × kind. The service verifies
the template is visible to the user before writing the preference row.

**Request body:** `{ "kind": "website", "templateId": "tmpl-classic" }`

**Activity log:** `template_default_set` / `template.default_set`.

### `POST /api/templates/fork`

Fork a built-in (`originType: 'standard'`) template to the user's GitHub
account or an organization, then auto-set the new fork as the user's default
for that kind.

**Request body:** `{ "kind": "website", "templateId": "tmpl-classic", "targetOwner": "my-org" }`

**Errors:**

- `404 Not Found` — template is invisible to the user, or the template's
  `kind` doesn't match the request.
- `400 Bad Request` — template is not a built-in (only `originType: 'standard'`
  may be forked), or `targetOwner` is empty / unavailable.
- `400 Bad Request` — `gitFacade.forkRepository` failed (the GitHub API
  returned an error or the user has no GitHub connection).

**Idempotency:** if a matching fork already exists
(`(kind, userId, targetOwner, repositoryName)` quadruple), the service
re-adopts it as the default and returns `created: false` WITHOUT emitting
the `template.forked` activity-log row. Otherwise a new row is created with
seven `metadata.forkedFromX` audit fields and the activity log is emitted.

**Activity log:** `template_forked` / `template.forked`. Only emitted when
`created: true`.

**Response 200:**

```json
{
	"status": "success",
	"kind": "website",
	"created": true,
	"template": { "id": "tmpl-fork-1", "name": "...", "originType": "forked" },
	"repository": { "fullName": "my-org/website-classic-template" },
	"defaultTemplateId": "tmpl-fork-1"
}
```

### `POST /api/templates/refresh`

Trigger a discovery pass that scans the user's GitHub installations for
`*template`-suffix repositories. Discovery is gated by a 1-hour TTL
(`WEBSITE_DISCOVERY_SYNC_TTL_MS`) plus a 50-page × 100-result safety cap.
Repositories whose canonical IDs match a built-in are reconciled in favor of
the built-in (otherwise `repo.name.toLowerCase()` is used). Duplicate IDs
trigger a deactivation branch.

The endpoint does NOT emit an activity-log row by design (see follow-up
T41 in the Spec Kit feature).

**Request body:** `{ "kind": "website" }`

**Response 200:** identical to `GET /api/templates` (same envelope).

## Default-template resolution

`getDefaultTemplateIdForUser(kind, userId)` follows a four-level fallback:

1. The user's explicit per-kind preference row.
2. The user's preference target only if it's still visible (not archived /
   deleted / cross-user). If invalid, the preference is cleaned up.
3. The kind-specific seed default — `getDefaultWebsiteTemplateId()` for
   `website`, `null` for `work`.
4. `null` when nothing matches.

A pending follow-up (T40) tracks the edge case where the kind-specific seed
default is itself archived; today the fallback still returns it.

## Configuration

| Env var                         | Purpose                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `WEBSITE_TEMPLATE_MINIMAL_REPO` | Optional `<owner>/<repo>` coordinate for the `Minimal` website seed. |
| `WEBSITE_DISCOVERY_SYNC_TTL_MS` | TTL for the discovery pass. Default 1 hour. Lower for development.   |

## Module registration

```typescript
@Module({
	imports: [AuthModule, AgentTemplateCatalogModule, AgentActivityLogModule],
	controllers: [TemplateCatalogController]
})
export class TemplateCatalogModule {}
```

The agent-level `AgentTemplateCatalogModule` provides
`TemplateCatalogService`; importing it from another feature module is the
recommended way to consume catalog state outside this controller (e.g.
`onboarding-work.adapter.ts` reads default-template ids when scaffolding a
new work).

## Related

- Spec Kit feature: `docs/specs/features/templates-catalog/{spec,plan,tasks}.md`
  — canonical source of truth, including the 24 functional requirements and
  outstanding follow-ups (T35 Postgres-container integration test, T36 e2e,
  T37 generalising `providerId='github'`, T38 `kind:'work'` discovery
  convention, T39 HTTP HEAD reachability check, T40 archived-default
  fallback, T41 `template.refreshed` activity log).
- See [Activity Log](/api/activity-log) for the five mutating endpoints'
  audit-row shape.
- See [Authentication](/api/authentication) for `AuthSessionGuard` semantics.
