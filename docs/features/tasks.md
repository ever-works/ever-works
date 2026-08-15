---
id: tasks
title: Tasks
sidebar_label: Tasks
---

# Tasks

A **Task** is one trackable unit of work — a fix, a review, a chore — with a status, a priority, labels, and optionally an Agent that executes it. Where a Work is a finished website and a Mission is a standing goal that keeps proposing new ones, a Task is the small, concrete thing somebody (or some Agent) actually does next.

Reach for a Task when you know what needs doing and want it tracked to completion. Tasks live at `/tasks`.

## When to use a Task vs a Work, Mission or Idea

| You want to…                                                   | Use a…                           |
| -------------------------------------------------------------- | -------------------------------- |
| Track one concrete piece of work through to done               | **Task**                         |
| Hand a piece of work to an Agent and watch the run             | **Task** with an Agent           |
| Publish a whole site / directory / blog from a prompt          | [**Work**](./creating-a-work.md) |
| Have the platform keep finding new angles on a topic over time | [**Mission**](./missions.md)     |
| Park a proposed Work until you decide whether to build it      | [**Idea**](./ideas.md)           |

A Task is not exclusive to any one of those. The same Task can belong to a Work **and** carry a Mission or Idea association at the same time — these are independent, additive associations, not a single "parent" choice.

## Creating a Task

Go to `/tasks` → **New Task**, or straight to `/tasks/new`. (**Browse templates**, beside it in the page header, opens the template catalog described below.)

| Field                 | Required | What it does                                                                                                                                 |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**             | Yes      | Up to **200 characters** — the input stops accepting more, and the API rejects anything longer. **Create** stays disabled while it is blank. |
| **Description**       | No       | Free text. Rejected with a 400 if it contains a secret-like value (API keys and similar) — credentials belong in plugin settings.            |
| **Work**              | No       | Files the Task under a Work. Attachments only work on a Work-scoped Task, so pick one here if you plan to attach anything.                   |
| **Priority**          | No       | `p0`–`p4`. Defaults to **P3**.                                                                                                               |
| **Labels**            | No       | Comma-separated. Blank entries are dropped and each label is trimmed. See the auto-derive rule below.                                        |
| **Acceptance checks** | No       | Collapsed section. Plus a **Max gate attempts** picker (_Inherit from Work_, or 1–5). Left empty, the Task inherits the Work's defaults.     |

A new Task is created in **Backlog** — the form has no status picker. It is given a per-account slug (`T-1`, `T-2`, …) that shows on every card, row and board tile. Slugs are numbered per account, so two accounts can each hold a `T-1`.

### Labels are derived from the title until you touch them

The Labels field mirrors the **slugified title** as you type: lowercase, every run of characters outside `a`–`z` and `0`–`9` collapsed to a single `-`, no leading or trailing hyphen. `Redesign onboarding flow` becomes `redesign-onboarding-flow`. Accented and non-Latin letters fall outside that set, so `Café update` derives `caf-update`, and a title written entirely in a non-Latin script derives nothing — type the label yourself there. The moment you edit the Labels field yourself, the mirroring stops for good and your text is used verbatim.

The derived label is also **truncated to 80 characters**, cut on a hyphen boundary where one lands past the halfway mark and with any trailing hyphen stripped. So a long title no longer produces an uncreatable Task — it produces a shortened label.

:::caution A label you type yourself is still capped at 80
The 80-character cap is enforced by the API on every label, not just the derived one. Auto-derivation stays inside it; a longer label you type (or paste from a template) is rejected and the Task is not created.
:::

:::warning The Task chip on `/new` does not pre-fill this form
Typing a prompt on `/new` and picking the **Task** chip sends your prompt to the AI chat and drops you on an **empty** `/tasks/new`. Nothing is carried into the fields. Type the title here, or use the chat conversation it just started.
:::

:::caution On a narrow window, the AI chat panel covers the form
Below 768px — phones and split-screen — the AI chat stops being a side panel and opens as a full-screen overlay on top of the page, backdrop and all. Close it (or widen the window) if **Create** looks unreachable.
:::

### Starting from a template

`/tasks/templates` lists pre-built Task shapes. **Use template** lands you on `/tasks/new?from=<slug>` with the title, description and the template's tags pre-filled into Labels (which counts as "touched", so the title no longer drives them). The form shows a notice whenever it was pre-filled from a URL — read the content before creating.

## Priorities

Five levels, `p0` (most urgent) through `p4`, defaulting to `p3`.

**Priority is a filter and a label — nothing more.** No list, board or queue is ordered by it: every Task list is sorted by **most recently updated, descending**, unconditionally, and the board columns keep that same order. Priority does not change execution order and gates nothing.

The five levels also do not read the same everywhere. What each surface renders:

| Where                                                         | What you see                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Cards, Table, Kanban cards, and Recent Tasks on the dashboard | `P0`–`P4` — the stored value, upper-cased by CSS                               |
| The **Priority** dropdown in the `/tasks` filter bar          | `P0`–`P4`                                                                      |
| The **Details** rail on a Task's detail page                  | **Urgent · High · Medium · Normal · Low**                                      |
| The **Add existing Task** picker on a scope's Tasks tab       | **URGENT · HIGH · MEDIUM · NORMAL · LOW** — the same words, upper-cased by CSS |
| The **Priority** picker on `/tasks/new`                       | `P0 — urgent`, `P1`, `P2`, `P3 — default`, `P4 — low`                          |

The colour is consistent even where the wording is not: P0 and P1 are both the danger tone (P0 louder), P2 is the warning tone, and P3 and P4 are deliberately neutral so only the urgent rows pull the eye.

## Scoping a Task to a Work, Mission or Idea

There are three ways a Task ends up under a scope:

- **At create time** — the **Work** picker on `/tasks/new`. Mission and Idea have no picker on the form; they are set only by the `?missionId=` / `?ideaId=` the Tasks tab on a Mission or Idea adds for you.
- **From the scope's Tasks tab** — **New Task** carries the scope through, and **Add existing** opens a picker of your other Tasks. The picker reads up to 200 of your most recently updated Tasks, drops cancelled ones and any already on this scope, and has its own search box.
- **On the Task detail page** — the **Work** row in the right rail is an editable picker. Changing it re-files the Task immediately.

Each per-row overflow menu on a scoped Tasks tab also offers a detach, behind a confirmation dialog. It clears just that one owner and leaves the others alone; the Task itself survives and returns to the global list.

:::caution A Task with sub-tasks cannot be re-filed
Changing the owners of a Task that has sub-tasks is refused: _"Task … has N sub-task(s); re-file or detach them before changing its owners so parent and child scopes cannot diverge."_ Move or detach the children first.
:::

:::note Mission and Idea associations are read-only after creation
The detail page shows the Mission or Idea a Task belongs to, but only Work is editable there. To change a Mission or Idea association from the UI, use **Add existing** on that Mission's or Idea's Tasks tab.
:::

## The list, its views and its filters

`/tasks` loads **50 Tasks per page**, most recently updated first, with Previous / Next below the list once there is more than one page.

The filter bar at the top is a real form — set what you want and press **Apply** (or **Reset** to clear it):

| Filter       | Behaviour                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **Search**   | Case-insensitive substring match against **title, slug and description**.                      |
| **Status**   | One status, or Any status.                                                                     |
| **Priority** | One priority, or Any priority.                                                                 |
| **Label**    | Matches a whole label, case-insensitively — `bug` finds a Task labelled `Bug`, but not `bugs`. |

Below the bar, a segmented control switches between three views of whatever the page loaded. The choice is **not remembered** — every reload starts on Cards.

| View       | What it shows                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| **Cards**  | A grid of cards: slug, priority badge, title, a two-line description, the status chip and up to three labels. |
| **Table**  | Slug · Title · Status · Priority · Updated.                                                                   |
| **Kanban** | One column per status, drag-and-drop, run controls and per-Task run / branch / PR / gate chips.               |

Cards and Table additionally get a row of **status pills** for quick client-side narrowing, and the count badge reads `shown / total`. Those pills disappear once you have picked a Status in the filter bar (the server already filtered) and are hidden in Kanban, where the columns are the status filter; in both of those cases the badge falls back to a plain count.

:::caution The board only holds the page you loaded
Kanban lays out the current page — at most 50 Tasks — not your whole backlog, and each column renders 15 cards before a **Show N more** button. Column counts are counts of what was loaded, not totals. Use the filter bar to bring the slice you care about onto the page.
:::

### Working on the board

Columns read **Backlog · Todo · In Progress · In Review · Blocked · Done · Cancelled**.

- **Drag a card** to another column to transition it. Columns that the state machine does not allow simply refuse the drop.
- **Move →** on a card lists the same legal destinations as a menu.
- **Run** dispatches the Task to an Agent (see below). With a card focused, pressing **`r`** does the same thing.
- **Run all** appears in the Backlog, Todo and In Progress column headers only, and only while that column holds at least one card. It runs at most **20** Tasks from the top of that column. Each one reports its own outcome — one failing never stops the others — and the column prints a `started/total` summary underneath its header.
- Cards carrying a branch, a pull request or a change count show a **± diff** affordance that opens a preview of the branch's changes.

## Statuses and transitions

Seven statuses, with a strict lattice. Anything not in this table is refused.

| From            | Can move to                           |
| --------------- | ------------------------------------- |
| **Backlog**     | To do, Cancelled                      |
| **To do**       | In progress, Blocked, Cancelled       |
| **In progress** | In review, Blocked, Done, Cancelled   |
| **In review**   | In progress, Blocked, Done, Cancelled |
| **Blocked**     | To do, In progress, Cancelled         |
| **Done**        | In progress (re-open)                 |
| **Cancelled**   | — terminal, nothing leaves it         |

On the Task detail page every status is rendered as a button: the current one is highlighted, the legal destinations are clickable, and the rest are visibly disabled. That row is the honest picture of what you can do next.

Side effects worth knowing:

- Moving to **In progress** stamps the start time the first time it happens, and dispatches an Agent run (see [Running a Task](#running-a-task-with-an-agent)).
- Moving to **Blocked** stashes the status the Task came from. When the last blocking Task reaches Done or Cancelled, the platform moves the blocked Task back to that stashed status — or to **To do** if nothing was stashed.
- Moving to **Done** stamps a completion time.

:::caution A Task blocked out of In review does not come back on its own
The automatic restore is a normal transition, so it has to be legal from **Blocked** — and Blocked can only reach To do, In progress and Cancelled. A Task that was blocked while in **In review** therefore has _In review_ stashed, the restore is refused, and the Task stays in Blocked until you move it yourself.
:::

### What can refuse a transition

| Gate                 | When it fires                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open blockers**    | Moving to **In progress** or **Done** while any blocking Task is still open. This is an integrity rule and cannot be overridden.                                                                                      |
| **Approvers**        | Moving to **Done** when the Task requires all approvers and not all of them have approved. A Task with no approvers configured passes freely.                                                                         |
| **Red quality gate** | An **Agent** moving a Task from In progress to In review while the latest run's gate is red or skipped and the Work requires passing acceptance checks. A person moving the Task themselves is never blocked by this. |

### Who can move a Task

Every Task endpoint matches on the Task's own **`userId`** — single reads go through an id-and-user lookup, and `task.userId = :userId` is the first predicate of the list query. Another account's Task is not visible, listable or transitionable; it reads as _not found_ rather than _forbidden_.

That column is who the Task **belongs to**, which is a different field from who raised it. A Task an Agent creates through its own tool is recorded as agent-created but still belongs to that Agent's owner, and is reachable only by them.

Agents move Tasks too, as part of a run, and that is the one case with an extra gate: the red-gate refusal above only applies when the mover is an Agent.

:::note No screen sends the `force` override
The API accepts `force: true` on a transition to bypass the approver gate and the agent red-gate refusal (never the blocker gate). No screen in the app sends it, so a blocked-by-approvers Task has to be resolved rather than forced.
:::

## Running a Task with an Agent

There are two different paths that start a run, and they resolve the Agent differently.

### Run

**Run** — on a kanban card, or beside the title on Task detail — hands the Task to an Agent. The Agent is resolved in this order:

1. the Agent you pick explicitly in the picker,
2. an Agent **assignee** on the Task,
3. the Task's own **Agent** field,
4. an Agent scoped to the Task's Work.

If exactly one candidate resolves, the run starts. If several do, or none, the picker opens and tells you which it is — each option is tagged **Assigned**, **Task agent** or **Work default**. With no candidate at all you get: _"No Agent is assigned to this Task and its Work has no default Agent."_

### Moving to In progress

Entering **In progress** — by drag, by the Move menu, or by the status buttons — dispatches on its own. It uses the Task's **Agent assignee rows** when it has any, and falls back to the **Task's own Agent** when it has none. A Task with neither dispatches nothing.

The right rail's **Agent** picker on Task detail writes that Task-level Agent, so assigning there is enough to make the move start a run.

:::caution The Work's default Agent is not part of this fan-out
**Run** will fall back to a Work-scoped Agent; moving the Task to In progress will not. That is why the board opens the agent picker whenever you move a card into In Progress — by drag or from the card's **Move →** menu, both go through the same handler — unless the Task has an assignee row or its own Agent. A Work default alone would move the card and start nothing.
:::

:::note This path was silently broken until EW-054
The fan-out used to iterate assignee rows only and give up when there were none. Assignee rows can only be created through the API, so the ordinary flow — pick an Agent on the detail page, move the Task to In progress — moved the card and started nothing, with no error and no log. It now falls back to the Task's own Agent.
:::

Other things that happen around a run:

- **A run already in flight** for the same Task and Agent is a refusal, not a second run: _"A run is already in flight for this Agent."_ Steer or cancel the live run instead.
- If too many runs are already in flight, the run is accepted but **parked**, and it starts when a slot frees. Clicking **Run** reports _"Queued — waiting for capacity"_ in the run menu; a run parked by the move-to-In-progress fan-out says nothing about capacity — the card shows only a **Queued** chip.

:::warning No screen assigns a person
The Task detail page has an **Agent** picker and nothing else. Reviewers, approvers, blockers, relations, and assignees of either kind (`user` or `agent`) exist in the data model and in the API, but no screen creates them. Add an assignee with `POST /api/tasks/:id/assignees`, passing `assigneeType` (`user` or `agent`) and `assigneeId`. Watchers exist as a table only — there is no endpoint for them either.
:::

## Acceptance checks (quality gates)

A Task can declare its own acceptance checks — commands that must exit `0` before an Agent's work on it counts as finished. Declare them in the collapsible **Acceptance checks** section on `/tasks/new`, or edit them later in the **Checks** section on Task detail.

Leave the section empty and the Task inherits the Work's `checkDefaults` untouched. **Max gate attempts** (_Inherit from Work_, or 1–5) caps how many times a red gate sends the Agent back to fix it **within a single run**. When the cap is reached that run stops retrying and finalizes with its gate still red; the Task's own status is not changed by the budget.

:::caution The check editor does not enforce the 20-check cap
The API rejects more than **20** acceptance checks on a Task, on both create and update. The editor has no such stop — it will keep adding rows, and the save fails when you submit. Keep the list under 20.
:::

The full model — how a Task's checks merge over the Work's defaults, what `off` / `warn` / `required` mean, and how to read a gate result — is in [Quality Gates](./quality-gates.md).

## Editing a Task afterwards

The detail page can edit the **description** (inline, with Save/Cancel), the **Work**, the **Agent**, the **acceptance checks** and attempt budget, the **Task isolation** override, and the **recurring** schedule.

:::caution The detail page shows title, priority and labels read-only
No form on the Task detail page changes a Task's title, its priority or its labels once it exists. The API supports changing all three via `PATCH /api/tasks/:id`.
:::

Attachments require a Work: the upload control is disabled on a Task that is not filed under one, and the API refuses the attach.

## Recurring Tasks

The **Recurring schedule** panel in the detail page's right rail turns a Task into a template. **Promote to recurring** opens the picker: a frequency of Daily, Weekly, Monthly or a custom RRULE, an optional end date, and an optional maximum number of occurrences (1–9999). It shows the rule it will send as a preview, and refuses to save an invalid one — or one that yields no future occurrence.

The platform then spawns instances on that schedule, each pointing back at the template. **Demote to one-off** turns the template back into a plain Task, behind a browser confirmation; existing instances stay, and no new ones spawn.

## Deleting a Task

**Delete** on the detail page opens a confirmation dialog naming the Task's slug. Nothing happens on the first click; the deletion runs only when you confirm, and you are returned to `/tasks`.

## Related

- [Creating a Work](./creating-a-work.md) — the scope most Tasks are filed under.
- [Missions](./missions.md) and [Ideas](./ideas.md) — the other two things a Task can be associated with.
- [Agents](./agents.md) — what actually executes a Task.
- [Quality Gates](./quality-gates.md) — the acceptance checks a Task declares.
- [Task Isolation](./task-isolation.md) — the per-Task branch an agent run works on.
- [Merge Policy](./merge-policy.md) — what happens to that branch afterwards.
