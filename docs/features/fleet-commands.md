---
id: fleet-commands
title: Commands on computers
sidebar_label: Fleet commands
description: Type one command, pick the computers it should run on, and read what each one printed — from the Fleet hub or the CLI. Immediate, confirmed, audited and stoppable.
---

# Commands on computers

"Is the disk full on both build boxes?", "Which runtime version is on each machine?" — each is one shell command and a
glance at its output. The **Commands** tab of the [Fleet hub](./fleet-hub.md) runs one command on the computers you
pick and shows one output card per computer, filling as each machine answers.

```
$ df -h
On:  [✓] build-01   [✓] build-02   [ ] design-mac (management is off — start the node with --manage)
     [ ] win-lab (offline · last seen 2 h ago)        Timeout [10 min ▾]   Folder [home (~)]
⚠ These are real machines, not a sandbox. The command runs as you, in your login shell.
                                                                                   [ Run on 2 ]
┌ build-01 ──────────── ✓ 0.8 s ┐  ┌ build-02 ───────── Exit 128 · 1.2 s ┐
│ Filesystem  Size  Used …      │  │ fatal: not a git repository        │
└───────────────────────────────┘  └─────────────────────────────────────┘
1 of 2 failed · 1.2 s
RECENT   df -h · uptime · pnpm -v · …   (last 8)
```

:::info Status: shipped behind a flag

Commands need `FLEET_COMMANDS_ENABLED=true` on the deployment (default off) and the [node link](./fleet-node-link.md)
(`FLEET_NODE_LINK_ENABLED=true`). With the flag off the tab says it is switched off and every `/api/fleet/commands`
route answers 404. Running a command spends no model tokens and no credits.

:::

## How a command runs

- **Immediately, or not at all.** A command is sent over the computer's node link the moment you confirm. A computer
  that is offline, or whose link is down, fails its own card at once with when it was last seen — nothing is queued
  and nothing is retried. (A command that should run on a schedule is a Schedule, which arrives separately.)
- **As the machine's owner, in their login shell.** `$SHELL -l -c <command>` on Linux and macOS (so `PATH`, version
  managers and the profile load as they do in a terminal), PowerShell on Windows. Never as another user, never with
  `sudo`.
- **With no input.** Nothing can be typed into it: a prompt reads end-of-input and fails. Pass `-y` (or your tool's
  equivalent) to commands that would ask.
- **From your home folder** by default, or a folder you name inside your home folder (or one the machine's owner
  allowed). Anything else is refused before the command starts.
- **Bounded.** The timeout is 10 minutes by default (1, 5, 10, 30 or 60 minutes); a command that passes it is stopped
  — every process it started — and its card reads _"Timed out after 10:00"_. A machine keeps at most 10 MiB of a
  command's output; past that the card says _"Output capped at 10 MiB"_ and the exit code is still reported.
- **Without the platform's credentials.** The command's environment is the machine's ordinary one, minus anything
  named like the node's own credentials (`FLEET_*`, `EVER_WORKS_*`) or a secret.

## Who may run commands where

| Check           | Refused with                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `--manage`      | `consent_missing` — _"start the node with --manage on build-01"_                                     |
| Who may command | `permission_denied` — the computer's **commands** audience (default: its owner; Settings → Fleet)    |
| The kill switch | `kill_switch` — no new command runs; running ones are stopped (_"Stopped by the fleet kill switch"_) |
| The link        | `unreachable` — _"build-01 is offline — last seen 2 h ago"_                                          |
| An older node   | `unsupported_on_node` — _"update the node on build-01 to run commands"_                              |
| Limits          | `limit_exceeded` — a command is at most 8 KiB, runs on at most 50 computers, 8 at once, 10 a minute  |

Every run asks first: the dialog names the command, each computer, its shell, that it runs as the machine owner,
the folder and the timeout, and says _"These are real machines, not a sandbox."_ Each computer gets one audit row
(`node.command.run`) the moment it is sent or refused, naming who asked; a stop writes `node.command.cancel`. The
command line and the stored output pass the secret scanner before they are written; a line that contained a token is
stored redacted.

"Drain all" stops running commands too (_"Stopped — the fleet is draining"_). If a computer's link drops while a
command runs, the card says so; when the link comes back within two minutes the exit and the output arrive, and
after that the run ends as _"Connection lost"_ — the full output stays on the computer.

## Output kept

The platform stores the first and the last 64 KiB of each run's output (the card says _"first 64 KiB and last 64 KiB
shown"_ when there was more), so a card from yesterday can be read when the computer is off. The computer itself
keeps the full output of its last 30 runs in its node folder (`commands/`, readable only by its owner). **Recent**
holds your last eight commands; each opens with its stored cards, and **↻** (or **Run again** on an open command)
fills the composer with it and asks for the confirmation again. You see only the commands you ran. The stored head
and tail are cleared 30 days after a run ended (`FLEET_JOB_RETENTION_DAYS`); the run itself stays in the history.

When **Checkouts** are on, the folder field offers the picked computers' checkouts.

## From a computer's page

A computer's **⋯** menu has **Run a command…**, which opens the Commands tab with only that computer picked. Its
**Overview** shows the last command you ran there: _"Last command: `uptime` · ✓ 0.8 s · 3 min ago"_.

**Open full output** on a card downloads everything the computer kept of that run (up to 10 MiB), read from the
computer itself — so it needs the computer online (_"The full output is on build-02, which is offline"_ otherwise).

## Agents

An Agent has four tools: `fleet_commands_run`, `fleet_commands_list`, `fleet_commands_get` and
`fleet_commands_cancel`. **An Agent never runs a command by itself**: `fleet_commands_run` files a request in your
**My Decisions** naming the computers and the command, and only your approval runs it — as that Agent, through every
check above, with `agent:<id>` in each audit row. The Agent then reads what each computer printed with
`fleet_commands_list` (it sees only the commands Agents asked for). Without the approval queue the tool refuses. The
same four names are offered to MCP clients, which confirm like the hub (`confirm: true` after the
`confirmation_required` summary).

## From the command line

```bash
ever-works fleet commands run --on build-01,build-02 -- uptime
ever-works fleet commands run --on build-01 --timeout 60 --cwd ~/code/api --yes -- git status --short
ever-works fleet commands run --on build-01,build-02 --json -- df -h
```

`--on` takes computer names or ids. The CLI prints the same confirmation and asks before it runs (`--yes` skips the
question, which is required when there is no terminal), streams each computer's output as `build-01 ▸ <line>`, then
one end line per computer and the summary. `--json` prints one object per computer (the web's run shape) when every
run ended. Exit codes: `0` every computer succeeded, `1` any failed or was refused, `2` a usage error, `124` any
timed out.

## API

| Method | Path                                         | What                                                                                        |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| POST   | `/api/fleet/commands`                        | `{ command, nodeIds, cwd?, timeoutSec?, confirm? }` → 409 `confirmation_required`, then 202 |
| GET    | `/api/fleet/commands?limit=8`                | Your recent one-off commands with their runs                                                |
| GET    | `/api/fleet/commands/:id`                    | One command with every computer's run (read once a second while one runs)                   |
| GET    | `/api/fleet/commands/:id/runs`               | Its runs                                                                                    |
| POST   | `/api/fleet/commands/:id/cancel`             | Stop it on every computer it still runs on                                                  |
| GET    | `/api/fleet/commands/:id/runs/:runId/output` | One computer's full output, downloaded from the computer (`text/plain` attachment)          |
| GET    | `/api/fleet/nodes/:id/commands/last`         | Your latest run on that computer, or `{ last: null }`                                       |

Every refusal is `{ error: { code, hint, details } }` with the codes above.
