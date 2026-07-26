---
id: task-isolation
title: Task Isolation (worktree per Task)
sidebar_label: Task Isolation
---

# Task Isolation

When an Agent works on a [Task](../api/tasks.md), it changes files in your Work's repository. **Task isolation** gives every Task its own branch and its own checkout, so two Agents working at the same time never overwrite each other, and nothing lands on your main branch until you say so.

Turn it on and each agent-executed Task gets:

- a dedicated **branch** (`task/<slug>`) cut from a base branch you choose,
- a **private working copy** of the repository — the Agent's edits are invisible to every other Task until the branch is pushed,
- a **pull request** when the Task finishes, instead of a direct commit,
- an explicit **conflict** state when the branch can no longer merge cleanly.

## Turning it on

Isolation is a Work setting under **Work → Settings → Tasks & Branches**.

| Setting                   | Values                              | What it does                                                                      |
| ------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| `taskIsolation`           | `off` (default) · `worktree`        | Whether agent-executed Tasks under this Work get their own branch + checkout.     |
| `taskIsolationBaseBranch` | branch name                         | What each Task branch is cut from. Defaults to the repository's default branch.   |
| `taskIsolationTargetRepo` | `work-output` · `data` · `provider` | Which of the Work's repositories the branch is created in.                        |
| `taskBranchCleanup`       | `on-merge` (default) · `manual`     | Whether the nightly sweep deletes branches of finished Tasks, or you delete them. |

The same fields are writable over the API with `PATCH /api/works/:id`.

## Per-Task override

A single Task can opt in or out regardless of the Work setting. On the Task detail page, the **Branch** panel shows an isolation selector while the Task has no branch yet:

| Selection            | Stored `isolationMode` | Effect                                              |
| -------------------- | ---------------------- | --------------------------------------------------- |
| Inherit from Work    | `null`                 | Follows the Work's `taskIsolation` setting.         |
| On — isolated branch | `on`                   | This Task always gets its own branch.               |
| Off — work directly  | `off`                  | This Task writes straight to the Work repositories. |

Over the API the same field is `isolationMode` on `POST /api/tasks` and `PATCH /api/tasks/:id`.

## The Branch panel

Once a Task has a branch, the panel replaces the selector with the branch cockpit:

- the **branch name** with a copy button, and the short **base SHA** it was cut from,
- a **state** pill — `created` → `pushed` → `pr-open` → `merged`, plus `conflict`, `discarded` and `cleaned`,
- a link to the **pull request** when one is open,
- **Discard branch**, which deletes the remote branch and resets the Task's workspace identity so the next run starts clean. This is irreversible and asks for confirmation.

The same branch state appears as a chip on the Task's card on the [board](../api/tasks.md).

## When a branch conflicts

If the base branch moves on and the Task branch can no longer merge, the branch state becomes `conflict` and the panel shows a banner listing the exact conflicting paths.

**Resolve conflicts** re-runs the Task's Agent against the conflicted branch — the Agent sees the named paths and resolves them, and the Task moves back to _In progress_. If you would rather start over, **Discard branch** throws the branch away and the next run cuts a fresh one.

| Action            | API                                     | Result                                                                                         |
| ----------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Resolve conflicts | `POST /api/tasks/:id/resolve-conflicts` | 200 — branch back to `pushed`, Task back to `in_progress`. 409 if the Task is not in conflict. |
| Discard branch    | `POST /api/tasks/:id/discard-branch`    | 200 — branch deleted, workspace identity reset. Idempotent.                                    |

## Cleanup

With `taskBranchCleanup: on-merge`, a nightly sweep deletes the remote branches of Tasks that reached a terminal state (done or cancelled), plus any abandoned branch past a hard staleness cutoff. With `manual`, branches are never auto-deleted — use **Discard branch**.

## Related

- [Quality Gates](./quality-gates.md) — the checks a Task branch must pass before it is accepted.
- [Merge Policy](./merge-policy.md) — whether an Agent may land its own pull request.
- [Git Operations](./git-operations.md) — how the platform talks to your Git provider.
