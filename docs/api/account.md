---
id: account
title: Account Transfer API
sidebar_label: Account Transfer
sidebar_position: 26
---

# Account Transfer API

The account-transfer module exports an authenticated user's account state to
a portable JSON payload, imports a payload back (with conflict resolution),
and synchronizes both halves with a GitHub repository so a user can keep
their account in version control.

The exported payload covers the full user surface: profile, every work
they own (with items, categories, tags, collections, comparisons,
schedules, advanced prompts, custom domains, and per-work plugin
configuration) and their account-level plugin settings.

## Architecture

```
apps/api/src/account/
  account.controller.ts   # 8 endpoints under /api/account/*
  account.module.ts       # Wires the three agent services

packages/agent/src/account-transfer/
  account-export.service.ts   # Snapshots a user's data into AccountExportPayload
  account-import.service.ts   # Validates a payload and applies it
  github-sync.service.ts      # Round-trips the payload to/from a GitHub repo
  types.ts                    # Versioned payload shape + conflict types
  ...
```

`AccountExportPayload` is a versioned JSON document. The current version is
`1`; all importers MUST check `payload.version` and refuse anything they
don't recognise.

## REST endpoints

All endpoints sit behind the global `AuthSessionGuard` and resolve the user
from `auth.userId`. The endpoints do NOT emit activity-log rows by design —
they're operator-driven account-level actions, not per-work events.

### `GET /api/account/export`

Snapshot the current user's data into an `AccountExportPayload`.

**Query:** `?includeSecrets=true|false` (default: `false`).

When `includeSecrets=false` (default), every value in `secretSettings`
records is replaced with a masked placeholder of the form
`MASKED:abc***1234` (first 3 + last 4 characters, short values fully
masked). Real secret values are NEVER exported in this mode.

**Response 200:** An `AccountExportPayload`:

```json
{
	"version": 1,
	"exportedAt": "2026-05-08T12:34:56.789Z",
	"includesSecrets": false,
	"data": {
		"profile": { "username": "...", "email": "...", "avatar": "..." },
		"works": [
			/* ExportedWork[] — see types.ts */
		],
		"userPlugins": [
			/* ExportedUserPlugin[] */
		]
	}
}
```

**Security:** the `includesSecrets` flag in the payload echoes the request
mode. Treat any `includesSecrets: true` payload as a credentials-bearing
artefact — store it encrypted, ship it through E2EE channels only, and never
commit it to a public repository.

### `POST /api/account/import/preview`

Validate a payload and surface conflicts BEFORE applying anything.

**Request body:** an `AccountExportPayload`.

**Response 200:** `ImportPreview`:

```json
{
	"valid": true,
	"errors": [],
	"version": 1,
	"includesSecrets": false,
	"hasMaskedSecrets": true,
	"profile": {
		/* ExportedProfile */
	},
	"workCount": 3,
	"totalItemCount": 142,
	"userPluginCount": 7,
	"conflicts": [{ "slug": "my-work", "existingName": "My Work (current)", "incomingName": "My Work (incoming)" }],
	"missingPlugins": ["serpapi"]
}
```

The `conflicts` array lists works whose `slug` is already owned by the
user. The `missingPlugins` array lists plugin ids referenced by the payload
but not currently installed in the platform — those entries will be skipped
on apply unless the operator installs the missing plugin first.

`hasMaskedSecrets: true` warns the operator that some `secretSettings`
entries are masked placeholders — the user must replace them with real
values after import or those plugins won't function.

### `POST /api/account/import/apply`

Apply a previously-previewed payload.

**Request body:**

```json
{
	"payload": {
		/* AccountExportPayload */
	},
	"resolutions": [
		{ "slug": "my-work", "strategy": "skip" },
		{ "slug": "other-work", "strategy": "rename", "newSlug": "other-work-v2" },
		{ "slug": "third-work", "strategy": "overwrite" }
	]
}
```

`resolutions` enumerates `ConflictResolution` per slug:

| `strategy`  | Semantics                                                        |
| ----------- | ---------------------------------------------------------------- |
| `skip`      | Leave the existing work untouched and drop the incoming one.     |
| `overwrite` | Replace the existing work's contents with the incoming payload.  |
| `rename`    | Create the incoming work under `newSlug` (which MUST be unique). |

If a conflict is reported in the preview but missing from `resolutions`, the
service treats it as `skip` (safe-by-default). Slugs that aren't conflicts
are imported normally.

**Response 200:** `ImportResult`:

```json
{
	"success": true,
	"worksCreated": 2,
	"worksUpdated": 1,
	"worksSkipped": 1,
	"userPluginsImported": 7,
	"errors": [],
	"warnings": ["Plugin serpapi is not installed; configuration skipped."]
}
```

### `GET /api/account/sync/status`

Return the current GitHub-sync configuration for the user.

**Response 200:** `SyncStatus`:

```json
{
	"configured": true,
	"hasOAuth": true,
	"repoOwner": "my-user",
	"repoName": "ever-works-account",
	"lastPushAt": "2026-05-08T12:00:00.000Z",
	"lastPullAt": "2026-05-07T18:30:00.000Z",
	"lastSyncError": null
}
```

`configured: false` means the user hasn't selected a sync repo yet.
`hasOAuth: false` means the user has no GitHub OAuth connection — they need
to connect one via `/api/oauth` before sync can run.

### `POST /api/account/sync/configure`

Select an existing GitHub repository for sync, OR create a new one.

**Request body:**

| Mode              | Body                               | Effect                                                                                 |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| Use existing repo | `{ "repoFullName": "owner/repo" }` | Saves the coordinate to the user's sync config. The repo must already exist on GitHub. |
| Create a new repo | `{ "createNew": true }`            | Creates a new private repo under the user's GitHub account using a default name.       |

**Response 200:** the updated `SyncStatus` (same shape as `GET /sync/status`).

### `POST /api/account/sync/push`

Export the user's current account state and push it to the configured sync
repo as JSON files. A push is rejected (with an error in `lastSyncError`)
if `configured: false` or `hasOAuth: false`.

**Request body:** `{ "includeSecrets": true | false }` (default: `false`,
same masking rules as `GET /api/account/export`).

**Response 200:** `{ "status": "success" }`.

### `POST /api/account/sync/pull`

Read the JSON files from the configured sync repo and produce an
`ImportPreview` against the current user's account. This does NOT mutate
state — the operator must call `POST /api/account/sync/pull/apply` to
commit.

**Response 200:** `ImportPreview` (same shape as
`POST /api/account/import/preview`).

### `POST /api/account/sync/pull/apply`

Apply a previously-previewed pull, with explicit conflict resolutions.

**Request body:**

```json
{
	"resolutions": [
		/* ConflictResolution[] */
	]
}
```

**Response 200:** `ImportResult` (same shape as
`POST /api/account/import/apply`).

### `DELETE /api/account/sync`

Remove the user's GitHub-sync configuration. The repository on GitHub is
NOT touched — this just disconnects the platform side.

**Response 200:** `{ "status": "success" }`.

## Secret masking

Account export distinguishes settings (`settings`) from secret settings
(`secretSettings`) on every plugin. The masking rules:

| Mode (`includeSecrets`) | Behaviour                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `false` (default)       | Every `secretSettings` value is replaced via `maskSecretValue` (`MASKED:abc***1234` for length > 8). |
| `true`                  | `secretSettings` is exported verbatim. The payload is then a credentials artefact.                   |

On import, `containsMaskedSecrets(secretSettings)` flags any plugin whose
secrets are still placeholders, and the preview / result includes a
`hasMaskedSecrets` warning so the operator can re-supply real values.

## Module registration

```typescript
@Module({
	imports: [AuthModule, AccountTransferModule],
	controllers: [AccountController]
})
export class AccountModule {}
```

The agent-level `AccountTransferModule` provides
`AccountExportService`, `AccountImportService`, and `GitHubSyncService`.

## Related

- See [Authentication](/api/authentication) for the `AuthSessionGuard`
  semantics that protect every endpoint.
- See [OAuth Capability](/api/oauth-capability) for the GitHub connection
  flow that `hasOAuth: true` depends on.
- See [Activity Log](/api/activity-log) for the audit trail (account
  endpoints intentionally do NOT emit activity-log rows).
- Type definitions: `packages/agent/src/account-transfer/types.ts`.
