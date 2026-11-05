---
id: mission-templates
title: Mission Templates
sidebar_label: Mission Templates
---

# Mission Templates

A **Mission Template** is a pre-built [Mission](./missions.md) setup someone has packaged for re-use. It comes with a description, a recommended cadence, default guardrails, and (optionally) a seed knowledge-base the spawned Mission inherits at fork time.

If you've ever wanted to start a Mission without having to write the prompt + tune the cap + pick a cadence from scratch, that's what a template is for.

## Where templates live

The **Templates Catalog** at `/templates` shows both Work templates and Mission templates. Switch between the two via the **Kind** chip at the top.

A Mission template card shows:

- The template's **name** + **description**.
- A **Use this Template** primary action.
- The source repo (templates are backed by a Git repo, just like Work templates).

## Curated vs custom

| Kind         | Where it comes from                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Built-in** | Ships with the platform — currently `starter-business`, `starter-content` and `build-on-open-source-app`. Seeded on first boot, immutable from the UI. |
| **Custom**   | Forked or imported into your account. Edit via the standard Template flow.                                                                             |

Both render in the same catalog; the only difference at use-time is provenance.

## Using a template

Click **Use this Template** on a Mission template card. You'll land on `/new?type=mission&template=<id>` with:

- The **Mission chip** pre-selected.
- The prompt pre-filled with the template's `name\n\ndescription`.
- The new Mission tagged with `missionTemplateRepo` so it carries a back-link to the source template.

You can edit the prompt before submitting — the template is a starting point, not a contract. Once you submit, the spawned Mission inherits, for every value you did not set yourself:

- The template's **cadence** (`defaults.cadence` in the manifest — written as a 5-field cron string). It applies to a **scheduled** Mission only: a Mission you create as one-shot stays one-shot.
- The template's **auto-build flag** and **outstanding-Ideas cap** if set.
- The template's **guardrails** (max-Works-per-run, max-budget, approval requirements).
- The template's **Output** — whether the Mission files Ideas, Tasks on its attached App Works, or both — and its Task limits (`defaults.outputMode`, `defaults.taskOutput`; see [Missions → Output](./missions.md#output)).

Your own create-time values **override** template defaults — the manifest is a starting point, not enforcement. If you pass `schedule: null` explicitly, the template's cadence is also cleared (explicit nulls aren't clobbered by defaults).

### How the defaults are read

For the **built-in** templates, the platform reads the template's `.works/mission.yml` when the Mission is created, through the git provider, at the branch the template's catalog row records, with **your own** git connection. If the file cannot be read — no git connection, no such repository or file, or a manifest that is not valid — the Mission is still created with exactly the values you gave, and the answer carries one warning, `templateManifestUnreadable`. Nothing is guessed.

A custom template's manifest is not read yet: a Mission made from one keeps exactly the values you give.

You can also open the plain Mission form on a template: `/missions/new?template=<id>`.

### Templates about an App Work

A template whose manifest has an `appWork` section is about one [App Work](./app-works.md) you already run. Its **Use this Template** opens the Mission form with three more fields — **Product**, **Business** and **App Work** (one of your App Works) — and a summary of what the template sets. The form needs the template's manifest: when it cannot be read, **Use this Template** falls back to the plain prompt, and the Mission it creates says the template could not be read. On create:

- the Mission's title is _Build my own {product} for {business} on top of {appWork}_ unless you type one;
- the App Work is attached to the Mission with the template's relation (_Improves_ by default);
- each of the template's `suggestedGoals` becomes a **draft** delivery [Goal](./goals.md) on that App Work, attached to the Mission. Activate them when you are ready.

The template also lists the **app rules** it recommends (`appWork.recommendedAppSpec`). The platform never writes them into the App spec: **Propose these rules** files one change request on the App Work, and the change reaches the App spec as a pull request you review.

The built-in **Build on an open-source app** template is one: every Monday at 08:00 UTC it plans up to 2 Tasks on the App Work (at most 4 open), new Tasks wait in **Backlog** for your approval, each agent run is capped at $15.00, and it files no Ideas. It recommends that schema changes are merged by a person and that pull requests stay under 400 changed lines.

## The `.works/mission.yml` manifest

Each Mission template repo carries a `.works/mission.yml` file that describes everything beyond the catalog row. Here's a typical one:

```yaml
version: 1
defaults:
    cadence: '0 9 * * *' # daily at 09:00 UTC
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

A template about an App Work adds its Output, the App Work section and the draft Goals:

```yaml
defaults:
    cadence: '0 8 * * 1'
    outputMode: tasks
    taskOutput:
        tasksPerTick: 2
        openTasksCap: 4
appWork:
    requiredRelation: improves
    recommendedAppSpec:
        agents:
            maxPullRequestChangedLines: 400
            requireHumanMergePaths:
                - '**/migrations/**'
suggestedGoals:
    - title: 'First customised feature live'
      goalKind: delivery
      dodCriteria:
          - 'At least one Task filed by this Mission reached Live on {appWork}'
```

| Section                        | What it does                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `version`                      | Manifest schema version. Bump it when making breaking changes.                                    |
| `defaults`                     | Mission-row defaults the fork carries unless you override.                                        |
| `defaults.cadence`             | 5-field cron string. Omit (or `null`) = the Mission stays one-shot.                               |
| `defaults.outstandingIdeasCap` | Cap on un-built Ideas. `-1` = unlimited; omit = inherit account default.                          |
| `defaults.guardrails`          | WorkAgent guardrails the Mission's builds inherit.                                                |
| `defaults.outputMode`          | `ideas`, `tasks` or `both` — what the Mission's tick files.                                       |
| `defaults.taskOutput`          | `tasksPerTick` (1–3) and `openTasksCap` (1–10) for Tasks on attached App Works.                   |
| `kb.seedPaths`                 | Files from the template repo the scaffolder copies into the new Mission's repo at fork time.      |
| `recommendedWorkTemplates`     | Work-template IDs the Idea→Work scaffolder pre-picks when building Ideas spawned by this Mission. |
| `appWork.requiredRelation`     | `improves` or `operates` — how the chosen App Work is attached. Present = the form asks for one.  |
| `appWork.recommendedAppSpec`   | App spec rules the template recommends; offered as **Propose these rules**, never applied.        |
| `suggestedGoals`               | Up to 10 draft delivery Goals (`title`, `goalKind: delivery`, 1–10 `dodCriteria`).                |

The manifest is **optional**: empty / null / comment-only manifests count as the all-defaults case, not a schema error. A manifest the platform cannot find is treated like one it cannot read — the Mission keeps the values you gave and the answer carries `templateManifestUnreadable` (a missing file and a repository your git connection cannot see look the same from outside).

`{product}`, `{business}` and `{appWork}` in a suggested Goal's title or criteria are filled from the form. A template's guardrails and Task output are narrowed to what you could set yourself (the same keys and ranges as the Mission form; never an Agent).

### Forward compatibility

Unknown top-level keys + unknown nested keys are **tolerated**, not rejected. A future template version can add fields without breaking older agent versions. The trade-off is that typos in field names pass silently — if a manifest field doesn't seem to do anything, double-check the spelling against the schema above.

## Authoring a template

A template is a Git repo with:

- A clear **README.md** describing the Mission's goal.
- A `.works/mission.yml` with the defaults you want users to inherit.
- Any files referenced in `kb.seedPaths` (prompts, briefs, style guides — whatever the Mission's WorkAgent should read at build time).

To publish, fork it into your account via the Templates Catalog and toggle it visible. The catalog row pulls `name` + `description` from your `package.json` or `README` frontmatter.

## Where to go next

- [Missions](./missions.md) — the lifecycle a forked template enters once you click **Use this Template**.
- [Website Templates](./website-templates.md) — the Work-level equivalent. Mission templates can pre-select these via `recommendedWorkTemplates`.
- [Budgets & Usage](./budgets-and-usage.md) — caps that gate every Mission spawned from a template.
