# Build on an open-source app

> **Catalog README** (added 2026-09-17 — EXT-13). The catalog's layout is
> `templates/<slug>/{mission.yml,BRIEF.md,README.md}` plus a manifest row; this file is the README for a
> human-facing listing under `ever-works/missions`. The template's **runtime** content — the `.works/mission.yml`
> the platform actually reads, its `prompts/`, and the long-form README — lives in the standalone seed repository
> `ever-works/build-on-open-source-app-mission-template`, sourced from
> `docs/specs/features/app-works/APW-08-evolve-loop/mission-template-draft/` in this repository and published by
> APW-08 T41. Nothing here replaces either file.

## What this template is

A weekly Mission for an App Work you already run: it proposes small product changes on your own copy of an
open-source application, waits for your approval, and keeps each change open until it is actually live.

## What you choose

| Field    | Meaning                                                                  |
| -------- | ------------------------------------------------------------------------ |
| Product  | What you are building for your business, e.g. "clinic booking".          |
| Business | Who it is for, e.g. "Riverside Physio".                                  |
| App Work | The App Work this Mission improves — it must already exist and be yours. |

## What it sets up

| Setting        | Value                          |
| -------------- | ------------------------------ |
| Cadence        | Mondays 08:00 UTC              |
| Output         | Tasks on the attached App Work |
| Tasks per week | up to 2                        |
| Open Tasks cap | 4                              |
| Approval       | New Tasks wait in **Backlog**  |
| Budget         | $15.00 per agent run           |
| Relation       | _Improves_ the chosen App Work |
| Goals          | two delivery Goals, in _Draft_ |

## What it recommends for the app itself

`agents.requireHumanMergePaths` for schema and migration paths, `agents.maxPullRequestChangedLines: 400`, and
`display.protectedPaths` for `LICENSE*` and `NOTICE*`. **Propose these rules** opens a Task that changes the App spec
by pull request; the template never edits it directly.

## Related files

- `mission.yml` — the catalog entry for this listing.
- `BRIEF.md` — the one-page brief.
- `manifest-row.json` — the row to add to the catalog's `manifest.json`.
- Runtime manifest and full README: `ever-works/build-on-open-source-app-mission-template`
  (source: `docs/specs/features/app-works/APW-08-evolve-loop/mission-template-draft/`).
