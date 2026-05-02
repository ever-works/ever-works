---
id: works-config
title: works.yml Configuration
sidebar_label: works.yml Config
sidebar_position: 6
---

# `works.yml` Configuration

`works.yml` is a single YAML file, committed to a work's **data repository**, that captures the work's generation configuration in source-controlled form. The platform reads it at import time to bootstrap a work's settings, and writes it back after each generation to keep it in sync.

This makes a work's configuration:

- **Portable** — the same file works across environments (local, staging, prod).
- **Reviewable** — config changes show up in repo diffs.
- **Source-of-truth-friendly** — you can hand-author it, or let the platform produce it.

:::tip When to use this
Use `works.yml` when you want to onboard an existing data repo into the platform without manually re-entering its settings, or when you maintain works outside the platform UI (e.g. via PRs, CI scripts, or config templates).
:::

## File Locations

When the platform reads from a repo it tries each of these paths in order and uses the first one that exists:

1. `works.yml`
2. `works.yaml`
3. `works_config/works.yml`
4. `works_config/works.yaml`

When the platform writes the config back after generation, it uses **`works.yml`** at the data-repository root (preserving the path it originally read from when present).

## Schema

All fields are optional. Unknown fields are preserved on round-trip (the platform only updates the fields it owns).

```yaml
# Display name for the work
name: Awesome AI Tools

# Initial natural-language prompt that drives generation
initial_prompt: |
    A curated work of open-source AI tools across LLM,
    agent, search, and developer-experience categories.

# Default model alias the platform should request from the AI provider
model: gpt-5.1

# Where the generated website should be published. Accepts:
#   "owner/repo"          — bare slug
#   "https://github.com/owner/repo"
#   "git@github.com:owner/repo.git"
website_repo: my-org/awesome-ai-tools-site

# Plugin selection per capability — overrides admin/user defaults
providers:
    ai: openai
    search: tavily
    screenshot: screenshotone
    contentExtractor: local-content-extractor
    pipeline: standard-pipeline

# Optional list of additional sub-agents (for advanced/experimental setups)
agents:
    - name: research-assistant
    - name: fact-checker

# Re-generation cadence. Either a bare cadence string or an object.
schedule: weekly
# — or —
# schedule:
#   enabled: true
#   cadence: every_8_hours
```

### Field Reference

| Field            | Type             | Aliases                                                  | Notes                                                                                                                                           |
| ---------------- | ---------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | string           | `title`                                                  | Display name for the work.                                                                                                                 |
| `initial_prompt` | string           | `initialPrompt`, `prompt`                                | Natural-language description used as the seed for generation.                                                                                   |
| `model`          | string           | —                                                        | Model alias to request from the AI provider plugin.                                                                                             |
| `website_repo`   | string           | `websiteRepo`, `website_repository`, `websiteRepository` | The website-output repo. Accepts a bare slug (`owner/repo`), HTTPS URL, or SSH URL. Trailing `/` and `.git` are stripped.                       |
| `providers`      | object           | —                                                        | Map of capability → plugin id. Recognized keys: `ai`, `search`, `screenshot`, `contentExtractor` (or `content_extractor`), `pipeline`.          |
| `agents`         | array            | —                                                        | Optional list of additional agents. Currently the platform only counts entries to show how many extra agents are configured.                    |
| `schedule`       | string \| object | —                                                        | Either a cadence string, or an object with `enabled` and `cadence` (also accepts `frequency` / `interval`). Setting `enabled: false` clears it. |

### Allowed `schedule.cadence` Values

| Value            | Meaning        |
| ---------------- | -------------- |
| `hourly`         | Every hour     |
| `every_3_hours`  | Every 3 hours  |
| `every_8_hours`  | Every 8 hours  |
| `every_12_hours` | Every 12 hours |
| `daily`          | Once per day   |
| `weekly`         | Once per week  |
| `monthly`        | Once per month |

The dash-separated forms (`every-3-hours`, `every-8-hours`, `every-12-hours`) are also accepted for compatibility. Any unrecognized cadence resolves to `null` and the schedule is treated as not configured.

## Onboarding an Existing Repo

When you import an existing work data repo, the platform:

1. Tries to fetch a `works.yml` from the candidate paths above.
2. If found, parses it and **pre-fills the import flow** with the values it contains (name, prompt, model, providers, schedule).
3. If parsing fails, surfaces the parse error to you (`Invalid works config at <path>: …`) so you can fix the file before retrying.
4. Validates referenced plugins (e.g. that `providers.ai = openai` corresponds to an installed plugin) before letting the import complete.

When you confirm the import, the platform persists the parsed `works.yml` settings to the work entity AND keeps the imported file in the data repo for future round-trips.

## Sync After Generation

Every successful generation writes a fresh `works.yml` to the data repo. The writer:

- **Preserves unknown fields** in the existing file (the platform only manages the fields it owns).
- Writes back the work's current `name`, `initial_prompt`, `model`, `website_repo`, `providers`, and `schedule`.
- Skips fields that have been explicitly cleared (e.g. clearing the model in the UI removes `model` from the file rather than writing an empty value).

If sync fails (for example, the data repo can't be cloned), the failure is logged to the activity log and surfaced in the UI — generation itself still completes successfully.

## Editing the File Manually

You can hand-edit `works.yml` in the data repo and commit the change. Two ways the platform picks it up:

1. **Re-import** the work — the new values become the work config.
2. **Trigger a generation** — at the start of generation the platform refreshes scoped settings; for fields the platform owns, the database values win.

For day-to-day tweaks (changing the prompt, swapping providers), prefer the Web Dashboard: it validates inputs and writes both the database and the file in one step. Hand-editing is most useful for bulk migrations and infrastructure-as-code workflows.

## Related

- [Work Import](./work-import) — bootstrapping a work from an existing repo
- [Scheduled Updates](./scheduled-updates) — full cadence + billing reference
- [Plugin System](/plugin-system) — the plugin ids referenced under `providers`
