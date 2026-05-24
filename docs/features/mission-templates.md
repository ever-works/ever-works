---
id: mission-templates
title: Mission Templates
sidebar_label: Mission Templates
---

# Mission Templates

A **Mission Template** is a pre-built [Mission](./missions) setup someone has packaged for re-use. It comes with a description, a recommended cadence, default guardrails, and (optionally) a seed knowledge-base the spawned Mission inherits at fork time.

If you've ever wanted to start a Mission without having to write the prompt + tune the cap + pick a cadence from scratch, that's what a template is for.

## Where templates live

The **Templates Catalog** at `/templates` shows both Work templates and Mission templates. Switch between the two via the **Kind** chip at the top.

A Mission template card shows:

- The template's **name** + **description**.
- A **Use this Template** primary action.
- The source repo (templates are backed by a Git repo, just like Work templates).

## Curated vs custom

| Kind         | Where it comes from                                                          |
| ------------ | ---------------------------------------------------------------------------- |
| **Built-in** | Ships with the platform — currently `starter-business` and `starter-content`. Seeded on first boot, immutable from the UI. |
| **Custom**   | Forked or imported into your account. Edit via the standard Template flow.   |

Both render in the same catalog; the only difference at use-time is provenance.

## Using a template

Click **Use this Template** on a Mission template card. You'll land on `/new?type=mission&template=<id>` with:

- The **Mission chip** pre-selected.
- The prompt pre-filled with the template's `name\n\ndescription`.
- The new Mission tagged with `missionTemplateRepo` so it carries a back-link to the source template.

You can edit the prompt before submitting — the template is a starting point, not a contract. Once you submit, the spawned Mission inherits:

- The template's **cadence** (`defaults.cadence` in the manifest — written as a 5-field cron string).
- The template's **auto-build flag** and **outstanding-Ideas cap** if set.
- The template's **guardrails** (max-Works-per-run, max-budget, approval requirements).

Your own create-time values **override** template defaults — the manifest is a starting point, not enforcement. If you pass `schedule: null` explicitly, the template's cadence is also cleared (explicit nulls aren't clobbered by defaults).

## The `.works/mission.yml` manifest

Each Mission template repo carries a `.works/mission.yml` file that describes everything beyond the catalog row. Here's a typical one:

```yaml
version: 1
defaults:
    cadence: "0 9 * * *"          # daily at 09:00 UTC
    autoBuildWorks: false
    outstandingIdeasCap: 10
    guardrails:
        maxWorksPerRun: 3
        maxBudgetCentsPerRun: 5000
        requireApprovalBeforeCreate: false
kb:
    seedPaths:
        - README.md
        - prompts/seed-ideas.md
recommendedWorkTemplates:
    - directory-classic
    - blog-modern
```

| Section                    | What it does                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `version`                  | Manifest schema version. Bump it when making breaking changes.                                        |
| `defaults`                 | Mission-row defaults the fork carries unless you override.                                            |
| `defaults.cadence`         | 5-field cron string. Omit (or `null`) = the Mission stays one-shot.                                   |
| `defaults.outstandingIdeasCap` | Cap on un-built Ideas. `-1` = unlimited; omit = inherit account default.                          |
| `defaults.guardrails`      | WorkAgent guardrails the Mission's builds inherit.                                                    |
| `kb.seedPaths`             | Files from the template repo the scaffolder copies into the new Mission's repo at fork time.          |
| `recommendedWorkTemplates` | Work-template IDs the Idea→Work scaffolder pre-picks when building Ideas spawned by this Mission.     |

The manifest is **optional** — a template with no `.works/mission.yml` is valid; the spawned Mission just gets all-defaults. Empty / null / comment-only manifests count as the all-defaults case, not a schema error.

### Forward compatibility

Unknown top-level keys + unknown nested keys are **tolerated**, not rejected. A future template version can add fields without breaking older agent versions. The trade-off is that typos in field names pass silently — if a manifest field doesn't seem to do anything, double-check the spelling against the schema above.

## Authoring a template

A template is a Git repo with:

- A clear **README.md** describing the Mission's goal.
- A `.works/mission.yml` with the defaults you want users to inherit.
- Any files referenced in `kb.seedPaths` (prompts, briefs, style guides — whatever the Mission's WorkAgent should read at build time).

To publish, fork it into your account via the Templates Catalog and toggle it visible. The catalog row pulls `name` + `description` from your `package.json` or `README` frontmatter.

## Where to go next

- [Missions](./missions) — the lifecycle a forked template enters once you click **Use this Template**.
- [Website Templates](./website-templates) — the Work-level equivalent. Mission templates can pre-select these via `recommendedWorkTemplates`.
- [Budgets & Usage](./budgets-and-usage) — caps that gate every Mission spawned from a template.
