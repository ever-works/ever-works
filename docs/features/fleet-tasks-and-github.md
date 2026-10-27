---
id: fleet-tasks-and-github
title: Tasks and GitHub on your computers
sidebar_label: Fleet tasks & GitHub
description: Hand a Task to an Agent on the computer you choose, see where it is being worked on, turn GitHub review requests and assignments into Tasks, and fix a computer's git identity in one click.
---

# Tasks and GitHub on your computers

"This issue just came in — put Nina on it, on my build box, in a fresh worktree, and show me where she is." Tasks
stay the hand-off unit; this page is how a Task reaches one of your computers.

```
 TASK T-42 · Login form drops the session cookie                      from GitHub · acme/api#910
 [ Run with agent ▾ ]  [ Fix with an agent on this computer ]
 ┌ Computer ──────────────────────────────────────────────┐
 │ build-01 · Nina · ● Working 4 min            Open  End │
 │ …/checkouts/acme-api/task-login-form  ⎇ +12 −3 · 2 files │
 │ no PR yet                                              │
 └────────────────────────────────────────────────────────┘
```

:::info Status: shipped behind flags

The hand-off needs `FLEET_SESSIONS_ENABLED=true` and `FLEET_CHECKOUTS_ENABLED=true` (both default off), plus the
[node link](./fleet-node-link.md). The git identity card needs `FLEET_CHECKOUTS_ENABLED=true`. With the flags off
nothing on the Task page changes.

:::

## Fix with an agent on this computer

**Run with agent** dispatches a headless Task run wherever the routing rules put it. **Fix with an agent on this
computer** (on Task detail — or press `F` — and on every board card) starts a persistent
[session](./fleet-sessions.md) on a computer **you** choose, so you can watch, steer and finish it:

1. **Computer** — every computer you can see, with online state, OS and the agent CLIs it has. A computer that cannot
   take the Task says why: offline, needs `--work`, missing the Agent's CLI, no free agent slot, not the Agent's
   pinned computer, all computers stopped, or not one of your computers. When the Agent is pinned to a computer, that
   one is preselected and the only selectable one — the pin is never changed here.
2. **Agent** — the same candidates **Run with agent** offers (assignee, Task agent, Work default).
3. **Checkout** — a new worktree of a checkout of the Task's repository on the Task's branch (the default when one
   exists on that computer), that checkout as it is, or a fresh clone. A checkout already on the Task's branch is
   reused. A Task without a repository starts in a checkout you pick or in the home folder.
4. **First message** — prefilled with the Task title, a description excerpt (up to 2 000 characters), its acceptance
   checks and the link it came from; edit it before you start.
5. **Git on the computer** — whether its git name and email are set, and whether Ever Works can push for agents there.
6. The cost sentence: whose model, on which computer, where the cost appears.

The session's Run carries the Task, so the Task's run history, its board state and its chat follow it. A second start
for the same Task and Agent is refused while the first is running — the dialog links the session that exists.

## The Computer block and the Task chip

The Task page's **Computer** block shows the Task's latest session on a computer: the computer, the Agent, the state
and how long it has run (**Open** / **End**), the checkout with its git line, and the pull request. After the session
ends it reads "ended 2 h ago" and keeps the checkout and the pull request. Every session card carries a `T-42` chip
that opens its Task.

## GitHub: things for me

On the Triggers page, **GitHub: things for me** creates one event Trigger in one click: review requested from you,
assigned to you, and pull requests you opened — matched against the GitHub account linked to you (connect it first;
the Trigger needs to know who "me" is). Each event becomes a Task in the Backlog with a `github` label and the link; a
later event about the same pull request or issue posts on that Task instead of making another. Any event Trigger can
use the same **About me** group under its event matcher, and shows a `for me` badge.

A Task made from a pull request checks out the pull request's own branch (a fresh clone of it); a pull request from a
fork is read-only for the Agent unless the fork allows maintainer edits, and the first message asks the Agent to review
and address the comments.

## Git identity on a computer

Each computer's **Settings** tab has a **Git on <computer>** card: the global `user.name`, `user.email`, whether a
credential helper is set, and whether Ever Works can push for agents there (the scoped push capability and a GitHub
App installation that covers a repository), with the reason when it cannot. The values are shown to the computer's
owner only; everyone else sees set / not set. It needs `--manage` on the computer.

**Use my Ever Works identity** sets the global name to your display name and the email to your GitHub no-reply
address (your account email when no GitHub account is linked — the confirmation says it will appear in public
commits). It acts only when you confirm, only on that computer, only on your own computers, and writes exactly those
two values — never a credential, a token or a helper. One audit row records which fields were set, never the email.
Agent commits are unaffected: they are already attributed to the Agent.

## From an Agent, MCP and the CLI

| Tool                                                    | What                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `fleet_tasks_handoff_options`                           | The computers, checkouts and first message for a Task (read-only). |
| `fleet_sessions_start` with `taskId` (and `checkoutId`) | The hand-off itself — the one session-start tool.                  |
| `fleet_nodes_git_identity_get`                          | A computer's git identity (read-only).                             |
| `fleet_nodes_git_identity_set`                          | Use my Ever Works identity (`confirm: true` to set).               |

```
ever-works fleet session start --task <taskId> --node <id> [--agent <id>] [--worktree | --clone | --checkout <id>] [--message-file <path>] [--json]
ever-works fleet nodes git-identity <nodeId> [--set [--confirm]] [--json]
```

## Related

- [Sessions on computers](./fleet-sessions.md) · [Checkouts on computers](./fleet-checkouts.md) ·
  [Tasks](./tasks.md) · [Inbound Triggers](./inbound-triggers.md)
