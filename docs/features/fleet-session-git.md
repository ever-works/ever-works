---
id: fleet-session-git
title: Session git & actions — the branch, the diff, the pull request, one click each
sidebar_label: Session git & actions
description: Every session on your computers shows the branch it works on, what changed, what is pushed and the pull request with its checks. Agent sessions start in their own worktree, the Actions menu types commit / push / pull request / review / recap prompts into the session, and pull requests are opened by Ever Works through the GitHub App.
---

# Session git & actions

A [session on a computer](./fleet-sessions.md) usually works in a [checkout](./fleet-checkouts.md). This page is about
that relationship: _which branch is Nina on, is it pushed, is there a pull request, are the checks green — and how do I
tell her to commit and open one — without opening a terminal?_

:::info Status: shipped behind a flag

Session git & actions ship with `FLEET_SESSIONS_ENABLED=true` and `FLEET_CHECKOUTS_ENABLED=true` (both default off).
Nothing new is stored: the pull request lives on the checkout's git line, the action templates in the Agent's own
`agent.yml`, the record of what was sent on the session's Run (Agent sessions) or in the fleet audit (your own sessions).

:::

## The git line

Every session card and the session page show one line:

```
acme/api · nina/fix-login ⎇ · +214 −38 · 6 files · ↑3 ↓0 · 2 uncommitted · PR #912 open ✓ · 41 s ago
```

- the repository and the branch (`⎇` marks a worktree — hover it for the folder it is a worktree of);
- lines added and removed and files changed, not committed yet; commits ahead of and behind the remote;
- the **pull request** whose head is this branch, with its state (open, draft, merged, closed) and its checks (✓
  passing, ⏳ running, ✗ failing). Ever Works asks GitHub through the GitHub App at most once a minute per checkout;
  click the pill to open the pull request;
- how old the line is — amber past five minutes, dimmed while the computer is offline. While a session works the line is
  recomputed on the computer every minute, and once more when it stops. **↻** recomputes it now.

When GitHub cannot be reached the pill keeps the last answer and says _PR: unknown (GitHub unreachable 3 min)_.

## New sessions start in their own worktree

In **New session → Where**, pick one of the computer's checkouts, then:

| Choice                | What happens                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Existing checkout** | The session works in that folder as it is (the default for your own sessions).                               |
| **New worktree**      | A new worktree of it, on its own branch — the default for an Agent: two agents in one folder overwrite each other. |
| **Fresh clone**       | A new clone of the same repository, on its own branch.                                                        |

The branch is proposed as `<prefix>/<slug>`: the prefix is the Agent's slug (or your handle), the slug comes from the
first message, else the title, else a short generated name. A name the repository ever had — on the remote, or on any
checkout of it, the bin included — gets `-2`, `-3`, … and the dialog says why (_"nina/fix-login exists — using
nina/fix-login-2"_). A session started from a Task keeps the Task's own branch.

## Changes

**Changes** (or `D` on the session page) opens the uncommitted diff, read on the computer: every changed file with its
added and removed lines, each patch behind a disclosure, as plain text. It refreshes every 10 seconds while the session
works, and stops at 1 MiB (64 KiB per file), saying how many files and bytes it left out.

## Actions

**Actions ▾** beside **End** (or `A`, then `1`–`7`) offers what you do around an agent's work:

| Action                       | Offered when                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Commit                       | the session is in a checkout                                                 |
| Commit and push              | on a branch — never to a protected branch for an Agent (you get a warning)    |
| Open / Update the pull request | on a branch that is not the default one                                    |
| Review the changes           | the session is in a checkout (the prompt forbids changing code)               |
| Fix the review comments (n)  | an open pull request has unresolved review comments                          |
| Resolve conflicts            | the open pull request cannot be merged cleanly                               |
| Write a recap                | always — the only one outside a checkout                                     |

Picking one shows its prompt — the Agent's own template, or the Ever Works default — with the branch, base, pull request
and Task filled in. You may edit it; **Send** types it into the session exactly as if you had typed it. The agent still
asks before running anything it was not allowed. While a session waits on an answer the sheet warns that your action
will be read as the answer (an Agent's own action never answers a permission prompt). A shell session has no agent to
prompt: only Changes and Clean up apply.

At most one action every 2 seconds and 10 a minute per session. **Actions so far** under the terminal lists each one with
the pull request it produced and its cost once the usage scan attributed it (your own sessions show the session's total
only). An action the computer could not confirm reads _not delivered_ and can be sent again — never twice silently.

## Pull requests are opened by Ever Works

The computer pushes the branch; **Ever Works opens the pull request through the GitHub App**. In an Agent session the
agent asks for it with the `fleet_checkouts_open_pull_request` tool (title, body, draft) — only with its owner's _may open
pull requests_ permission, and only for its own checkout. In your own session a dialog asks for the title and body. When
one is already open for the branch it is **updated**, never doubled. A session working on a Task records the pull request
on the Task and moves it to **In review**, exactly like a Task run. Nothing here ever merges: the merge policy decides
that, and a protected branch is never merged by an agent.

## Clean up

Once the pull request is merged or closed and no session uses the worktree, **Clean up** appears on the session card and
the checkout row. It removes the worktree folder (with the checkout's changes-check: type the folder's name when work
would be lost) and **keeps the branch**: _"Worktree removed · branch nina/fix-login kept"_.

## How an Agent writes its prompts

**Agents → Instructions → agent.yml → Fleet actions** lists the seven templates and the branch prefix, each beside its
default. Saving writes the Agent's `agent.yml`:

```yaml
fleet:
    branchPrefix: nina
    actions:
        commit: 'Commit {branch} using conventional commits; explain why.'
```

`{branch}`, `{base}`, `{pull}` and `{task}` are filled in when the action is sent; any other word in braces is typed as it
is (the editor warns).

## Tools, MCP and the CLI

| Agent / MCP tool                    | CLI                                                      |
| ----------------------------------- | -------------------------------------------------------- |
| `fleet_sessions_actions_list`       | `ever-works fleet session actions <sessionId>`            |
| `fleet_sessions_action`             | `ever-works fleet session action <sessionId> <actionId>`  |
| `fleet_checkouts_changes`           | `ever-works fleet checkout changes <checkoutId>`          |
| `fleet_checkouts_open_pull_request` | `ever-works fleet checkout pull-request <checkoutId> --title …` |
| `fleet_checkouts_delete` (clean up) | `ever-works fleet checkout delete <checkoutId> --clean-up` |

## When something is refused

| You see                            | Why                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------- |
| _build-01 is offline_              | Actions, Changes and Clean up need the computer; the git line stays as last known. |
| _All computers are stopped_        | The fleet kill switch is on; a pull request already asked for still completes. |
| _Not allowed on this computer_     | The computer needs `--manage` (your session) or `--work` (an Agent's).      |
| _Not possible — not available on main_ | The action does not apply here; the menu never offered it.             |
| _branch is not pushed yet_         | Push first; the pull request is opened from what is on GitHub.              |
| _Nina may not open pull requests_  | Allow it on the Agent, or open it yourself from the dialog.                 |

See also: [Sessions on computers](./fleet-sessions.md) · [Session status](./fleet-session-status.md) ·
[Checkouts on computers](./fleet-checkouts.md) · [Task isolation](./task-isolation.md).
