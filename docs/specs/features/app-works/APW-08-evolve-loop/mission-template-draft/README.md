---
name: Build on an open-source app
description: >
    Build my own {product} for {business} on top of {appWork}: a weekly, budgeted, approval-gated Mission that
    keeps filing small, reviewable changes on an App Work and follows each one until it is live.
---

# Build on an open-source app

> **Draft** — Mission template for the App Works program (APW-08). Placeholders `{product}`, `{business}` and
> `{appWork}` are filled from the template form when the Mission is created.

**Mission:** Build my own **{product}** for **{business}** on top of **{appWork}**.

You already run an open-source application as an App Work. This Mission turns "make it ours" into a steady loop:
every Monday it looks at what {business} needs from {product}, files up to two small Tasks on {appWork}, and —
once you approve them — an Agent implements each one as a pull request against the branch the app deploys from.
Each Task stays open until its change is live.

## What you get

| Setting        | Value                          | Why                                                         |
| -------------- | ------------------------------ | ----------------------------------------------------------- |
| Cadence        | Mondays 08:00 UTC              | One planning moment a week; reviews fit a normal week.      |
| Output         | Tasks on the attached App Work | Changes, not new Works.                                     |
| Tasks per week | up to 2                        | Small batches merge; big batches rot.                       |
| Open Tasks cap | 4                              | The Mission pauses filing while four of its Tasks are open. |
| Approval       | New Tasks wait in **Backlog**  | Nothing starts spending until you move a Task to **To do**. |
| Budget         | $15.00 per agent run           | A runaway run stops at the cap.                             |
| Relation       | _Improves_ {appWork}           | Product changes. Add _Operates_ for maintenance Tasks too.  |

## Guardrails this template recommends for the app itself

These live in the App spec in {appWork}'s repository, not in the Mission. The template offers **Propose these
rules**, which opens a Task that changes the App spec by pull request for you to review:

- **Schema changes are merged by a person** — `agents.requireHumanMergePaths`: `**/migrations/**`,
  `**/prisma/schema.prisma`, `**/*.sql`, `**/schema.rb`. Agents may prepare them; only you merge them.
- **Pull requests stay reviewable** — `agents.maxPullRequestChangedLines: 400`. Larger work is split into
  sub-Tasks before coding; above 1,200 lines no pull request is opened.
- **License and notice files are off-limits** — `display.protectedPaths`: `LICENSE*`, `NOTICE*`.

Always enforced by the platform regardless of this template: branch-per-Task, the App spec's checks, protected
paths, the merge policy (by default agents never merge), and follow-up Tasks when a merged change fails to build
or deploy (at most 2 per change).

## Success metrics

The template creates two **draft** delivery Goals scoped to {appWork}. Activate them when you are ready.

| Metric                            | Target                                 | Where you see it                     |
| --------------------------------- | -------------------------------------- | ------------------------------------ |
| First customised feature live     | within 21 days of creating the Mission | Goal "First customised feature live" |
| Changes live per month            | ≥ 4                                    | Goal "Four changes live in a month…" |
| Changes closed without deploying  | 0 per month                            | Tasks tab → Delivery filter          |
| Merge-to-live time                | median ≤ 30 minutes                    | Task **Delivery** timeline           |
| Follow-up Tasks per merged change | ≤ 1 on average                         | Tasks related as follow-up           |
| Agent spend per month             | ≤ 8 runs × $15.00 = $120.00            | Budgets & usage                      |

## How the weekly tick plans

The planner reads this README, `prompts/product-brief.md` and `prompts/task-planning.md`, the App Work's name and
description, and the titles of its 20 most recent Tasks. It proposes at most two Tasks, drops any whose title
matches an open Task, and files the rest in Backlog.

## Before you start

1. Fill in `prompts/product-brief.md` in the Mission's knowledge base: who uses {product} at {business}, the three
   jobs it must do better than the stock app, and what must never change.
2. Make sure {appWork} has a Fleet node or an isolated run environment set up — App Work Tasks run nowhere else.
3. Review the App spec checks for {appWork} and admit them for your machines if you use a Fleet node.
