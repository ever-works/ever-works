---
id: data-management
title: Data Management (Export / Import / GitHub Sync)
sidebar_label: Data Management
sidebar_position: 11
---

# Data Management

Data Management lets you export your entire account configuration, import it into another instance, and optionally keep a live backup synced to a private GitHub repository. This covers works (including items, comparisons, site config, schedules, and advanced prompts), user plugins, and profile data.

:::tip When to use this
Use data management to migrate between Ever Works instances, create backups of your configuration, or share work setups across environments (staging, production).
:::

## Prerequisites

- A registered Ever Works account
- For GitHub Sync: a connected GitHub account via Git Providers settings

## Overview

The data management system has three parts:

| Feature         | Description                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| **Export**      | Download a JSON file containing your full account data                       |
| **Import**      | Upload a previously exported JSON file to restore or migrate data            |
| **GitHub Sync** | Push/pull configuration to a private GitHub repository for continuous backup |

All three are accessible from **Settings > Data** in the web dashboard.

## Export

### What Gets Exported

The export produces a versioned JSON file (currently v1) containing:

| Data                              | Details                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| **Profile**                       | Username, email, avatar                                            |
| **Works**                         | Name, slug, description, git/deploy provider, settings             |
| **Work Items**                    | Full item data from the data repository (YAML), including markdown |
| **Categories, Tags, Collections** | Taxonomy data from the data repository                             |
| **Comparisons**                   | Comparison data with dimensions, scores, and markdown content      |
| **Site Config**                   | Per-work website configuration                                     |
| **Markdown Templates**            | Header and footer markdown templates                               |
| **Schedules**                     | Update cadence, status, billing mode, failure thresholds           |
| **Advanced Prompts**              | Custom AI prompt overrides for each pipeline step                  |
| **Members**                       | Work member user IDs and roles                                     |
| **Custom Domains**                | Domain name, environment, verification status                      |
| **User Plugins**                  | Plugin ID, enabled state, settings                                 |
| **Work Plugins**                  | Per-work plugin configuration, capability, priority                |

### Secret Handling

**Real secret values are never included in exports.** This is a core security principle.

- **Include secrets checked**: Secret settings are exported as **masked** values with a `MASKED:` prefix (e.g., `MASKED:sk-***1234`). The key names are preserved so users know which values need to be filled in.
- **Include secrets unchecked**: Secret settings are omitted entirely.

The masked format shows the first 3 and last 4 characters of the original value for identification purposes. Short values (8 characters or fewer) are fully masked as `MASKED:********`.

### Export Format

```json
{
	"version": 1,
	"exportedAt": "2026-03-10T18:00:00.000Z",
	"includesSecrets": true,
	"data": {
		"profile": {
			"username": "myuser",
			"email": "user@example.com"
		},
		"works": [
			{
				"name": "My Work",
				"slug": "my-work",
				"description": "...",
				"gitProvider": "github",
				"items": [],
				"categories": [],
				"tags": [],
				"collections": [],
				"comparisons": [],
				"siteConfig": {},
				"markdownTemplate": { "header": "...", "footer": "..." },
				"schedule": { "cadence": "weekly", "status": "active" },
				"advancedPrompts": { "itemGeneration": "..." },
				"members": [],
				"customDomains": [],
				"workPlugins": [
					{
						"pluginId": "openai",
						"enabled": true,
						"settings": { "model": "gpt-4o" },
						"secretSettings": {
							"apiKey": "MASKED:sk-***abcd"
						}
					}
				]
			}
		],
		"userPlugins": []
	}
}
```

### API Endpoint

```
POST /api/account/export
```

**Query parameters:**

| Parameter        | Type    | Default | Description                                  |
| ---------------- | ------- | ------- | -------------------------------------------- |
| `includeSecrets` | boolean | `false` | Include masked secret settings in the export |

**Response**: JSON file download with `Content-Disposition: attachment`.

## Import

Import is a two-step process: **preview** then **apply**.

### Step 1: Preview

Upload a JSON file to analyze its contents before making any changes. The preview returns:

| Field              | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `valid`            | Whether the file is a valid export                              |
| `version`          | Export format version                                           |
| `includesSecrets`  | Whether the file contains secret settings                       |
| `hasMaskedSecrets` | Whether secret values are masked (need replacing before import) |
| `workCount`        | Number of works in the file                                     |
| `totalItemCount`   | Total items across all works                                    |
| `userPluginCount`  | Number of user plugins                                          |
| `conflicts`        | Works whose slugs match existing works                          |
| `missingPlugins`   | Plugin IDs not installed on this instance                       |

### Masked Secrets Detection

If the import file contains masked secret values (`MASKED:...`), the preview sets `hasMaskedSecrets: true` and the UI displays a warning:

> This file contains masked secret values (MASKED:\*\*\*). Please open the JSON file and replace all masked values with your real API keys and credentials before importing. Masked values will be skipped during import.

During import, any secret settings that still contain masked values are **skipped** (not written to the database), and a per-plugin warning is added to the result.

### Step 2: Conflict Resolution

When a work slug in the import file matches an existing work, you choose a resolution strategy:

| Strategy      | Behavior                                               |
| ------------- | ------------------------------------------------------ |
| **Skip**      | Keep the existing work, do not import the incoming one |
| **Overwrite** | Update the existing work with the imported data        |
| **Rename**    | Import with a new slug (e.g., `my-dir-imported`)       |

### Step 3: Apply

Once conflicts are resolved, the import creates/updates:

1. **Works** — creates new or updates existing based on resolution
2. **Work relations** — members, custom domains, plugins, advanced prompts, schedules
3. **Repository data** — clones the data repo, writes items, categories, tags, collections, comparisons, site config, and markdown templates, then commits and pushes
4. **User plugins** — upserts plugin configurations

### API Endpoints

```
POST /api/account/import/preview
POST /api/account/import/apply
```

**Preview body**: The full JSON export payload.

**Apply body**:

```json
{
  "payload": { ... },
  "resolutions": [
    { "slug": "my-dir", "strategy": "overwrite" }
  ]
}
```

**Response**: `ImportResult` with counts of created/updated/skipped works, imported plugins, and any warnings or errors.

## GitHub Sync

GitHub Sync pushes your account configuration to a private GitHub repository and can pull it back. This provides continuous backup and enables migration between instances.

### Setup

1. Connect your GitHub account in **Settings > Git Providers**
2. Go to **Settings > Data > GitHub Sync**
3. Either create a new private repository (`ever-works-config`) or connect an existing one

### Repository Structure

When you push to GitHub, the sync creates a structured file layout:

```
manifest.json                    # Version and timestamp
profile.json                     # Username, email, avatar
plugins/
  user-plugins.json              # User plugin configurations
works/
  my-work/
    config.json                  # Work settings
    members.json                 # Work members
    domains.json                 # Custom domains
    plugins.json                 # Work plugin configurations
    prompts.json                 # Advanced prompt overrides
    schedule.json                # Update schedule settings
    site-config.json             # Website configuration
    markdown-template.json       # Header/footer markdown
    items.json                   # Work items
    categories.json              # Categories
    tags.json                    # Tags
    collections.json             # Collections
    comparisons.json             # Comparison data
```

### Secret Handling in GitHub Sync

GitHub Sync follows the same security model as export:

- **Push with secrets enabled**: Secret values are written as **masked** placeholders (`MASKED:...`). Real credentials are never stored in the repository.
- **Push with secrets disabled**: Secret settings are omitted.
- **Pull (import from GitHub)**: Secret values are **always ignored** during import from GitHub, regardless of what is in the repository. This prevents masked values from overwriting real credentials in the database.

### Push

Exports all account data, writes the structured files to the repository, commits, and pushes.

### Pull

Reads the structured files from the repository, reconstructs an export payload, and presents it as an import preview. The same conflict resolution flow applies.

### API Endpoints

```
GET  /api/account/sync/status
POST /api/account/sync/configure
POST /api/account/sync/push
POST /api/account/sync/pull
POST /api/account/sync/apply-pull
DELETE /api/account/sync
```

## Security Considerations

| Concern                        | Mitigation                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Secret leakage via export      | Secrets are always masked with `MASKED:` prefix; real values never leave the API  |
| Secret leakage via GitHub      | Push always writes masked values; pull always ignores secret values               |
| Masked values imported as real | Import detects `MASKED:` prefix and skips those values with a warning             |
| Path traversal in sync         | Work slugs are validated with `path.basename()` on both write and read operations |
| Repository tampering           | Pull operations use the same preview/conflict flow as file import                 |

## Dashboard UI

The Data Management section in Settings provides three panels:

1. **Export Data** — download button with optional "include secrets (masked)" checkbox
2. **Import Data** — file upload with drag-and-drop, preview summary, conflict resolution, and apply flow
3. **GitHub Sync** — repository setup, push/pull buttons, secrets toggle, status display with last sync timestamps

All operations provide toast notifications for success/failure and display detailed warnings in the import results.

## Data Repository Instant Sync (EW-628)

When a Work is split across a **data repository** (Markdown + YAML edited directly by humans) and a **main repository** (rendered HTML/SSR build output), edits to the data repo can flow into the main repo on a sub-minute path instead of waiting for the next full generation tick.

Two transports drive the sync:

- **Webhook (default when the Ever Works GitHub App is installed)** — push events on the data repo's default branch debounce for 30 seconds, then call `MarkdownGeneratorService.syncFromDataRepo()` and push the resulting diff to the main repo. End-to-end latency is typically well under one minute.
- **Poller (fallback when the App is not installed)** — `WorkScheduleDispatcherService` ticks every minute and, for each Work whose `lastDataRepoCheckedAt` is older than `syncIntervalMinutes`, calls GitHub to compare the data-repo HEAD against `lastSyncedDataRepoSha`. A delta enqueues the same `syncFromDataRepo` path used by the webhook.

Both transports share a single `runExclusive` mutex on the Work, so an in-progress generation pipeline blocks a sync (and vice versa) — the deferred attempt is reflected as a `data-sync.skipped { reason: "generation-in-progress" }` row in the activity feed and resumes on the next tick.

Two feature flags gate the runtime:

- `DATA_SYNC_WEBHOOK_ENABLED` (default `false`) — when `true`, the GitHub App webhook handler routes `push` payloads through the data-sync queue.
- `DATA_SYNC_DISPATCHER_ENABLED` (default `false`) — when `true`, the scheduler ticks for Works without the App installed.

A force-sync endpoint is also exposed for operators and dashboards:

```
POST /api/works/:id/sync
```

It returns `202` with either `{ status: "enqueued", activityRowId }` or `{ status: "skipped", reason }` (the latter when the mutex / generation pipeline blocks the run). It never throws on the "already in progress" path — that is a normal, expected outcome.

For the full design — debounce / lock TTL tunables, telemetry contract, render-parity guarantees, and acceptance matrix — see [`docs/specs/features/data-repo-instant-sync/spec.md`](../specs/features/data-repo-instant-sync/spec.md) and the linked decision record [`docs/specs/decisions/005-cache-and-lock-pluggability.md`](../specs/decisions/005-cache-and-lock-pluggability.md).
