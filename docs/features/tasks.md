---
id: tasks
title: Tasks
sidebar_label: Tasks
---

# Tasks

A **Task** is the unit of work an [Agent](./agents.md) actually executes — "redesign the onboarding
flow", "triage this bug", "draft the release notes". Tasks are also the only channel Agents use to
hand work to each other, which is what gives every hand-off an audit trail.

You can create Tasks yourself, and Agents create them too. This page covers the human path.

## Creating a Task

Go to **`/tasks/new`** (Sidebar → **Tasks** → new Task).

| Field           | Notes                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| **Title**       | Required, up to 200 characters. The only field that gates **Create**.                       |
| **Description** | Optional context.                                                                           |
| **Work**        | Optional. Defaults to **No Work (Workspace)**.                                              |
| **Priority**    | **P0 — urgent**, **P1**, **P2**, **P3 — default**, **P4 — low**. New Tasks start at **P3**. |
| **Labels**      | Comma-separated free text.                                                                  |

### Labels derive themselves until you touch them

The **Labels** field mirrors a slugified version of the title as you type — "Redesign onboarding
flow" fills in as `redesign-onboarding-flow`. The moment you edit the field yourself the mirroring
stops for good, so your own labels are never overwritten. Separate multiple labels with commas.

### Choosing a Work

**Work** decides what the Task is scoped to. Leaving it at **No Work (Workspace)** creates a
workspace-level Task, which is fine for anything that is not about one specific
[Work](./creating-a-work.md).

One consequence is worth knowing up front, and the form says it in place: **files can only be
attached to Work-scoped Tasks.** If you expect to attach anything to this Task, pick the Work now.

Arriving from a Work's, Mission's or Idea's **Tasks** tab pre-selects that scope, and the page header
says which one — _Work-scoped task_, _Mission-scoped task_, _Idea-scoped task_.

### Acceptance checks (optional)

**Acceptance checks** is a collapsed section at the bottom of the form. Opening it lets you declare
commands that **must exit 0** before this Task's agent work is allowed to open a pull request.

**Max gate attempts** sits alongside them: **Inherit from Work**, or a fixed 1–5. Leave the whole
section alone and the Task inherits the Work's own check configuration untouched — declaring nothing
here is the normal case.

See [Quality Gates](./quality-gates.md) for what the checks do once the Task is running, and
[Task Isolation](./task-isolation.md) for the branch and private checkout each Task gets.

### If the form was pre-filled from a link

`/tasks/new` accepts `?prompt=` and `?from=` parameters, which pre-fill the form from a URL or from a
[Task template](#task-templates). When that happens the page shows a notice above the form asking you
to review the content before creating the Task. **Read it.** A link someone sent you can put whatever
it likes in those fields, and the notice exists so that never happens silently.

## Task keys

Every Task you create gets a short key — **T-1**, **T-2**, and so on — shown alongside its title.
Keys are sequential **per account**, so your first Task is `T-1` regardless of what anyone else's
Tasks are called. Use the key when referring to a Task in a chat, a commit message or a PR body.

## Task templates

`/tasks/templates` lists ready-made Tasks you can start from — **Bug triage**, **Weekly review** and
**Release checklist** on a default installation. **Use template** opens `/tasks/new` with the title,
description and labels already filled in, which you can then edit freely before creating. The exact
catalogue depends on your installation.

## Related pages

- [Agents](./agents.md) — who executes Tasks. · [Creating an Agent](./creating-an-agent.md)
- [Quality Gates](./quality-gates.md) — acceptance checks, in depth.
- [Task Isolation](./task-isolation.md) — the branch and checkout per Task.
- [Merge Policy](./merge-policy.md) — whether an Agent may land its own pull request.
- API reference: [Tasks](../api/tasks.md)
