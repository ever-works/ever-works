---
id: fleet-sessions
title: Sessions on computers (terminals that keep running)
sidebar_label: Fleet sessions
description: Start a shell, Claude Code or Codex on one of your computers and come back to it from anywhere — your own sessions, Agent sessions with their own Run, watching and driving from the browser or the terminal, recording and re-watch.
---

# Sessions on computers

A **session** is an interactive terminal on one of your [Fleet](./fleet.md) computers — a shell, Claude Code or Codex in a folder of yours — that **keeps running when nobody is watching**. Close the tab, lose the network, restart the node: the process belongs to the computer's **session daemon**, not to the browser and not to the node process, so you come back to it as you left it. Open the computer's **Sessions** tab in the [Fleet hub](./fleet-hub.md), or a session's own page.

:::info Status: shipped behind a flag

Sessions are available with `FLEET_SESSIONS_ENABLED=true` (default off). They ride the [node link](./fleet-node-link.md), so the deployment also needs `FLEET_NODE_LINK_ENABLED=true`. With the flag off the Sessions tab, its routes and the tools are not there at all. A session spends no Ever Works tokens unless an Agent works in it (see below).

:::

What each session is doing right now — working, needs you, done, idle — and answering what it asks from the card, the
Inbox or My Decisions is described in [Session status and the Sessions board](./fleet-session-status.md).

## Two kinds

| Kind              | Who works in it                          | Needs on the computer            | Runs as                                                                                     | Cost                                         |
| ----------------- | ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Your session**  | You                                      | `ever-works-node start --manage` | You, in your own login, with your own CLI configuration                                     | Your own CLI login; Ever Works bills nothing |
| **Agent session** | One of your Agents (it owns one **Run**) | `ever-works-node start --work`   | Isolated, exactly as a Task run: its own configuration home, no MCP server or hook of yours | The Run carries the cost, in Activity → Runs |

An Agent session waits for a free slot when the computer is busy (it counts against `--concurrency` like any Task run) and says so; ending the session ends its Run, and ending the Run ends the session. An Agent session never runs in your own configuration: a computer that cannot give it the Task-run isolation refuses it and says why. For now Agent sessions run on your own computers (not ones shared with you through an Organization).

## Starting one

**New session ▾** in the computer's header (or `N` on its page) opens the start dialog: **who** (you, or one of your Agents), **what** (Claude Code, Codex or a shell — a CLI the computer does not have is greyed "not installed on build-01"), **where** (a folder in your home folder, with the folders of your last ten sessions one click away), and a **first message** (optional for your own CLI session, required for an Agent's). A computer holds at most **eight** of your own sessions at once.

## Watching and driving

A session's page shows its terminal live — the last 2 000 lines first, then everything as it happens. The person who started a session drives it; anyone else in the computer's `sessions` audience watches and may **Take the keyboard** (several people may drive a terminal). At most **five** browsers are attached to one session. The footer says who is driving, how many are watching, the terminal size and what the tab is receiving.

- **Esc Esc** leaves the terminal (it is the only key the page keeps while you drive); `T` takes the keyboard, `W` watches only, `R` renames, `E` ends, `?` lists the keys.
- If the connection drops, the page says "Reconnecting to build-01…" and keeps what you typed; once it is back you are **offered** to send it — it is never sent on its own.
- While all computers are stopped (the fleet kill switch), input is blocked and the page says so; the session keeps running.
- A drain warns every session 60 seconds before it ends it.

From your own terminal:

```bash
ever-works fleet session list            # --node <id>, --state live|ended, --json
ever-works fleet session attach <id>     # --watch to only watch; Ctrl-] then d detaches
```

## Ending, restarting, the last screen

**End…** stops the process (terminate, then kill after 5 seconds) after one confirmation; its screen is kept. An ended session shows the last screen the computer kept and why it ended ("exited with code 0", "build-01 restarted — the screen above is the last one it kept"). **Restart** starts a new session with the same kind, CLI, folder and title.

## Recording and re-watch

A session can be **recorded**: Agent sessions are by default, your own when the computer's owner switched on recording for watched sessions, and any live session from its footer (**Record** / **Stop recording**). What the terminal prints is stored with secrets redacted and kept **14 days**. **Re-watch** plays it back — idle pauses shortened, 1× 2× 4×, ten-second jumps, and who drove when marked on the timeline. A Run receipt of an Agent session links to the session and to its recording.

## For Agents and tools

An Agent works with its own sessions through `fleet_sessions_list`, `fleet_sessions_read`, `fleet_sessions_start` (always an Agent session of that Agent), `fleet_sessions_send`, `fleet_sessions_rename` and `fleet_sessions_end` (destructive — it needs a confirmation). The MCP server offers the REST-backed five for a person's own client.

## Related

- [Fleet](./fleet.md) — enrolling computers and what they run.
- [Fleet hub](./fleet-hub.md) — the computer page the Sessions tab sits on.
- [Fleet node link](./fleet-node-link.md) — the consents (`--manage`, `--work`) and the one connection sessions ride.
- [Agent terminals](./agent-terminals.md) — the terminal of a Run on the job runtime.

See also [Session git & actions](./fleet-session-git.md) — the branch, the diff, the pull request and one-click actions of a session.
