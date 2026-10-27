---
id: fleet-schedules
title: Schedules on computers
sidebar_label: Fleet schedules
description: Run a command on one of your computers on a timer — every N minutes, daily, on weekdays, on chosen days or by cron — on the computer's own clock, even while the platform is unreachable.
---

# Schedules on computers

"Run the tests there every night and tell me only if they fail." A **schedule on a computer** is a command, one
computer and a time. The definition is copied to the computer, and the node runs it from its own timer — in your login
shell on that machine, one run at a time — whether or not it can reach Ever Works at that moment. When the link is
back, the runs it made appear with their real start time, duration, exit code and the first and last 64 KiB of what
they printed.

```
 COMPUTER › build-01 › Schedules
 build-01 keeps time in Europe/Paris · you are in America/New_York                          [ New schedule ]
 ● Nightly tests      pnpm test               weekdays 02:00   next Tue 02:00 (Mon 20:00 yours)   last ✓   Synced to build-01
 ● Pull all checkouts git pull --ff-only      every 30 min     next Tue 14:30 (08:30 yours)       last ✓   Synced to build-01
 ⏸ Rebuild docs       pnpm docs:build         daily 03:00      paused by you
 ⚠ Disk report        df -h | mail …          hourly           NEVER RUNS · needs --manage
```

:::info Status: shipped behind a flag

Schedules ride Commands' flag: `FLEET_COMMANDS_ENABLED=true` on the deployment (default off), and the
[node link](./fleet-node-link.md) (`FLEET_NODE_LINK_ENABLED=true`) to send definitions to the computer and read its runs
back. The computer must run the node with `--manage` for command schedules, and with `--work` for Agent-session
schedules.

:::

## Where

- **The computer page → Schedules** (`/fleet/computers/<id>?tab=schedules`) lists that computer's schedules. Press
  **N** for a new one; select a row to read its history.
- **Activity → Schedules** shows them beside every other kind of schedule, with the source chip **Computer**; Run now,
  Pause and Resume work there too.
- **Fleet → Commands** has **Schedule this…** next to the run button: the same command, on a cadence, on the one
  computer you picked.
- The CLI: `ever-works fleet schedules …` (below).

## When it runs

| Form            | Example             | Notes                                                            |
| --------------- | ------------------- | ---------------------------------------------------------------- |
| Every N minutes | every 30 min        | 1–59 minutes; restarts every hour (every 25 min = :00, :25, :50) |
| Hourly          | hourly              | on the hour                                                      |
| Daily           | daily 08:30         |                                                                  |
| Weekdays        | weekdays 02:00      | Monday to Friday                                                 |
| Specific days   | Mon, Wed, Fri 09:00 |                                                                  |
| Cron            | `0 2 1 * *`         | five fields: minute hour day month weekday                       |

Every time is the **computer's** own (its time zone is reported by the node); the tab and the dialog show yours beside
it. On a day the clocks jump forward, a time that does not exist (02:30) runs as far past the jump (03:30); on a day
they fall back, a repeated time runs once.

## What happens on the computer

- **Login shell, as the machine owner, no input** — exactly like a [one-off command](./fleet-commands.md), from your
  home folder or a folder the machine's owner allowed. A folder outside those is refused when the computer receives the
  schedule.
- **One run at a time.** A fire that arrives while the previous run is still going is recorded "Skipped — the previous
  run was still going".
- **Six hours at most.** A run still going at 6 h is ended and recorded as a timeout.
- **Asleep at fire time.** If the computer wakes (or the node starts) within 60 minutes of a fire, that fire runs once;
  later, it is recorded "Skipped — build-01 was asleep past the grace window". Several missed fires never produce
  several catch-up runs.
- **The last 30 runs' full output stays on the computer.** **Open full output** in the history downloads it while the
  computer is online.
- **Kill switch.** While Fleet's kill switch is on, the computer stops firing within 10 seconds and ends any run in
  flight; clearing it resumes the timer without replaying old fires.

So that a closed laptop lid still runs them, run the node as a service (the systemd unit
`apps/node/packaging/systemd/` on Linux, `apps/node/packaging/windows/` on Windows): the timer
lives inside the node, not in cron, launchd or Task Scheduler.

## An Agent, every morning

Choose **An Agent session** in the dialog to schedule an Agent instead of a command: the Agent (only Agents **pinned**
to this computer are offered — pin one on its Capabilities tab; the dialog never pins one for you), what it should do
(the prompt), the agent CLI (Claude Code or Codex) and, optionally, a checkout on the computer. It is stored as a
recurring Task of that Agent; at each time the platform starts it as an **Agent session on that computer**, visible on
its Sessions tab while it runs, and each run appears in Runs with its cost like any other run.

> Runs happen on build-01 using the Claude Code or Codex sign-in — or the API key — that is set up on that computer.
> Ever Works keeps no copy of it. If that sign-in expires, the next run fails and this schedule appears under Needs a
> look until someone signs in on build-01 again.

Agent-session schedules tick on the platform (each fire creates a Run), so they need the platform reachable; command
schedules tick on the computer. In **Activity → Schedules** an Agent's recurring Task keeps its own source and shows the
computer it is pinned to.

## Pause all

**Pause all** on a computer's Schedules tab pauses every command schedule on it (the computer's owner pauses all of
them; anyone else their own), says how many and how many runs are in flight (they finish; nothing new starts), and
offers **Undo** for 15 minutes. Nothing is deleted.

## When the node is not a service

Started from a terminal rather than as a service, the node runs its schedules only while it is open. Start it with
`ever-works-node start --manage --native-schedules` and it also hands every schedule to the operating system's own
scheduler, which starts `ever-works-node schedule-run <id>` at each time even when nobody has the node open:

| System  | Where                                                                        |
| ------- | ---------------------------------------------------------------------------- |
| Linux   | a marked block in your crontab (`# >>> ever-works-node schedules` … `# <<<`) |
| macOS   | one LaunchAgent per schedule (`works.ever.node.schedule.<id>`)               |
| Windows | Task Scheduler folder `\EverWorks\`, one task per schedule                   |

While a node process is running, `schedule-run` leaves the fire to it, so nothing runs twice. A cron expression that
launchd or Task Scheduler cannot express is left to the node's own clock (the node logs which). `unenroll` removes
everything the fallback wrote; nothing else in your crontab, LaunchAgents or Task Scheduler is touched. Running as a
service does not need it.

## Told only when it fails

Two failures in a row put the schedule under **Needs a look** in the Fleet hub ("Nightly tests failed twice on
build-01"). Five in a row **pause** it ("Paused after 5 failures in a row") and leave a notice in your Inbox; resume it
when it is fixed. A passing run clears it.

## Never runs

| Says                              | Why                                         | What to do                                            |
| --------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| NEVER RUNS · needs --manage       | the node was not started with `--manage`    | run `ever-works-node start --manage` on that computer |
| NEVER RUNS · update the node on … | the node is older than schedules            | update the node                                       |
| NEVER RUNS · computer removed     | the computer was removed from Fleet         | edit the schedule and pick another computer           |
| Will sync when build-01 is back   | it was saved while the computer was offline | nothing — it reaches the computer when it reconnects  |

## Confirmations, limits and audit

- Creating a schedule, moving it to another computer, changing what it runs, deleting it and **Run now** each show what
  will run where — the shell, the user, the folder, the next three fires — and "These are real machines, not a
  sandbox." Pause and Resume do not ask.
- A computer holds at most **50** schedules; a name is at most 120 characters, a command at most 8 KiB; at most 30
  schedule changes a minute.
- A command that looks like it contains a secret is refused: keep the secret in a file or an environment variable on
  the computer and refer to that.
- Every change writes a Fleet audit row (`node.schedule.create|update|delete|run|pause|resume`); every run the computer
  made is audited as `node.command.run` with `requestedBy: schedule:<id>`.
- A command schedule spends **no model tokens or credits**.

## Agents and MCP

An Agent has `fleet_schedules_list`, `_get`, `_runs` (read-only), `_pause`, `_resume` (applied at once) and
`fleet_schedules_create`, `_update`, `_delete`, `_run` — which never act by themselves: each is held for your approval in
My Decisions and applied, as that Agent, when you approve it. The MCP server exposes the same nine names over the
`/api/fleet/schedules` routes below (writes need `confirm: true`). An Agent sees only the schedules Agents asked for.

## CLI

```bash
ever-works fleet schedules create --on build-01 --name "Pull all" --every 30m --command "git pull --ff-only"
ever-works fleet schedules create --on build-01 --name "Nightly tests" --at 02:00 --weekdays --command "pnpm test" --folder ~/code/api
ever-works fleet schedules list --on build-01
ever-works fleet schedules runs <id>
ever-works fleet schedules run <id>        # Run now (asks; --yes to skip)
ever-works fleet schedules pause <id>
ever-works fleet schedules resume <id>
ever-works fleet schedules update <id> --on build-02   # move it
ever-works fleet schedules delete <id>
```

Every verb takes `--json` (the web's shapes). Exit codes: `0` ok, `1` refused or failed, `2` usage.

## API

| Method     | Path                                                                             | What                                                                |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| POST       | `/api/fleet/commands` with `cadence` and `name`                                  | create (201); without `confirm: true` → 409 `confirmation_required` |
| GET        | `/api/fleet/commands/:id`                                                        | one schedule                                                        |
| PATCH      | `/api/fleet/commands/:id`                                                        | edit, or move with `nodeId`                                         |
| DELETE     | `/api/fleet/commands/:id`                                                        | delete (`confirm: true`)                                            |
| GET        | `/api/fleet/commands/:id/runs`                                                   | the last 30 runs                                                    |
| GET        | `/api/schedules/page?sourceType=node_schedule&node=<id>`                         | the schedules on one computer                                       |
| POST       | `/api/schedules/node_schedule:<id>/run-now`                                      | Run now (`confirm: true`)                                           |
| POST       | `/api/schedules/node_schedule:<id>/pause` · `/resume`                            | pause, resume                                                       |
| GET · POST | `/api/fleet/schedules` · GET · PATCH · DELETE `/api/fleet/schedules/:id`         | the same schedules as a resource (Agent, MCP, CLI)                  |
| GET        | `/api/fleet/schedules/:id/runs` · POST `/:id/run` · `/:id/pause` · `/:id/resume` | runs, Run now (`confirm`), pause, resume                            |
| POST       | `/api/fleet/nodes/:id/schedules/pause-all` · `/resume-all`                       | Pause all (`confirm`) and its 15-minute Undo (`breakerAt`)          |
| GET        | `/api/fleet/nodes/:id/schedules/agents`                                          | the Agents an Agent-session schedule here may use                   |
| POST       | `/api/fleet/nodes/:id/schedules/agent-session`                                   | create an Agent-session schedule (`confirm`)                        |
