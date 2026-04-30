---
id: data-management
title: Data Management (Export / Import / GitHub Sync)
sidebar_label: Data Management
sidebar_position: 11
---

# Data Management

Data Management lets you export your entire account configuration, import it into another instance, and optionally keep a live backup synced to a private GitHub repository. This covers directories (including items, comparisons, site config, schedules, and advanced prompts), user plugins, and profile data.

:::tip When to use this
Use data management to migrate between Ever Works instances, create backups of your configuration, or share directory setups across environments (staging, production).
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
| **Directories**                   | Name, slug, description, git/deploy provider, settings             |
| **Directory Items**               | Full item data from the data repository (YAML), including markdown |
| **Categories, Tags, Collections** | Taxonomy data from the data repository                             |
| **Comparisons**                   | Comparison data with dimensions, scores, and markdown content      |
| **Site Config**                   | Per-directory website configuration                                |
| **Markdown Templates**            | Header and footer markdown templates                               |
| **Schedules**                     | Update cadence, status, billing mode, failure thresholds           |
| **Advanced Prompts**              | Custom AI prompt overrides for each pipeline step                  |
| **Members**                       | Directory member user IDs and roles                                |
| **Custom Domains**                | Domain name, environment, verification status                      |
| **User Plugins**                  | Plugin ID, enabled state, settings                                 |
| **Directory Plugins**             | Per-directory plugin configuration, capability, priority           |

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
		"directories": [
			{
				"name": "My Directory",
				"slug": "my-directory",
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
				"directoryPlugins": [
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
| `directoryCount`   | Number of directories in the file                               |
| `totalItemCount`   | Total items across all directories                              |
| `userPluginCount`  | Number of user plugins                                          |
| `conflicts`        | Directories whose slugs match existing directories              |
| `missingPlugins`   | Plugin IDs not installed on this instance                       |

### Masked Secrets Detection

If the import file contains masked secret values (`MASKED:...`), the preview sets `hasMaskedSecrets: true` and the UI displays a warning:

> This file contains masked secret values (MASKED:\*\*\*). Please open the JSON file and replace all masked values with your real API keys and credentials before importing. Masked values will be skipped during import.

During import, any secret settings that still contain masked values are **skipped** (not written to the database), and a per-plugin warning is added to the result.

### Step 2: Conflict Resolution

When a directory slug in the import file matches an existing directory, you choose a resolution strategy:

| Strategy      | Behavior                                                    |
| ------------- | ----------------------------------------------------------- |
| **Skip**      | Keep the existing directory, do not import the incoming one |
| **Overwrite** | Update the existing directory with the imported data        |
| **Rename**    | Import with a new slug (e.g., `my-dir-imported`)            |

### Step 3: Apply

Once conflicts are resolved, the import creates/updates:

1. **Directories** — creates new or updates existing based on resolution
2. **Directory relations** — members, custom domains, plugins, advanced prompts, schedules
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

**Response**: `ImportResult` with counts of created/updated/skipped directories, imported plugins, and any warnings or errors.

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
directories/
  my-directory/
    config.json                  # Directory settings
    members.json                 # Directory members
    domains.json                 # Custom domains
    plugins.json                 # Directory plugin configurations
    prompts.json                 # Advanced prompt overrides
    schedule.json                # Update schedule settings
    site-config.json             # Website configuration
    markdown-template.json       # Header/footer markdown
    items.json                   # Directory items
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

| Concern                        | Mitigation                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Secret leakage via export      | Secrets are always masked with `MASKED:` prefix; real values never leave the API       |
| Secret leakage via GitHub      | Push always writes masked values; pull always ignores secret values                    |
| Masked values imported as real | Import detects `MASKED:` prefix and skips those values with a warning                  |
| Path traversal in sync         | Directory slugs are validated with `path.basename()` on both write and read operations |
| Repository tampering           | Pull operations use the same preview/conflict flow as file import                      |

## Dashboard UI

The Data Management section in Settings provides three panels:

1. **Export Data** — download button with optional "include secrets (masked)" checkbox
2. **Import Data** — file upload with drag-and-drop, preview summary, conflict resolution, and apply flow
3. **GitHub Sync** — repository setup, push/pull buttons, secrets toggle, status display with last sync timestamps

All operations provide toast notifications for success/failure and display detailed warnings in the import results.
