---
id: fleet-logs
title: Logs on computers (read what a machine wrote, live)
sidebar_label: Logs on computers
description: The Logs tab of a Fleet computer — its system log, log files, Docker containers and services, the last 500 lines then live, with filter, pause and copy; every line secret-scanned on the machine and nothing stored.
---

# Logs on computers

A computer's page in the [Fleet hub](./fleet-hub.md) has a **Logs** tab that reads the machine's logs where
they already are and shows them the way an operator expects: the last 500 lines at once, then live, with a
filter, a pause that counts what arrives, colour on errors and warnings, and copy. **Nothing is stored on the
platform**: close the viewer and the lines are gone from Ever Works. Every line passes the platform's secret
scan **on the machine**, before it leaves it.

Logs need two things:

- the deployment switched it on — `FLEET_MACHINE_FACTS_ENABLED=true` (with the hub, `FLEET_HUB_ENABLED`, and
  the node link, `FLEET_NODE_LINK_ENABLED`); off, the tab shows that it is switched off and the routes answer
  404;
- the computer started with machine management on: `ever-works-node start --manage`. Without it the tab shows
  that exact command — nothing is ever read from a machine whose owner did not switch this on.

## The sources

The left side lists everything the computer can show, in four groups, re-listed when the tab opens and every
30 seconds while it is visible:

| Group          | Linux                                  | macOS                                         | Windows                                              |
| -------------- | -------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| **System**     | the system journal, the kernel         | the unified log                               | System and Application event logs; Security as an administrator |
| **Files**      | `/var/log` and the shared folders      | `/var/log`, `/Library/Logs`, `~/Library/Logs` and the shared folders | the shared folders                     |
| **Containers** | every Docker container (running or not) | same                                         | same (Docker Desktop)                                |
| **Services**   | running and failed systemd units, failed first | running launchd jobs (and failed third-party ones) | running Windows services                    |

**Files** are regular files under the standard log folders and under the folders the computer shares —
log-looking files (`*.log`, `*.out`, `*.err`, rotated `*.log.1`, anything in a `logs/` folder), newest first,
at most 200 per folder. The shared folders are the node's workspace root, its ready checkouts, and any folder
the machine's owner names with `--files-root` (repeatable):

```bash
ever-works-node start --manage --files-root /srv/app --files-root /home/ops/code/api
```

The home directory is never shared as a whole, and a filesystem root (`/`, `C:\`) is refused. **Open a
file…** takes a typed path; it opens only when the path, with every link resolved, is under a standard log
folder or a shared folder — a symbolic link from a shared folder to `/etc` is refused.

Some sources are listed but cannot be opened, and say why: a file only `root` can read (**root only** — no
permission-changing command is suggested), or the Windows Security log on a node not running as an
administrator (**needs administrator**). On Linux, a node whose user is not in the journal group still opens
the journal with that user's own entries and shows the exact command that widens it —
`sudo usermod -aG systemd-journal <user>` — which is never run for you.

**Containers** are read through the Docker command line only, never the Docker daemon's socket. **Services**
show the lines their service manager attributes to them: the journal for a systemd unit, the job's log file
(or its process's unified-log records) for launchd, the service's provider in the event logs on Windows.

## The viewer

Opening a source shows its last **500** lines, newest at the bottom, then follows it live (`● LIVE`).

| You do                      | It does                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| type in **filter…**         | shows only the lines containing that text (any case), held and live; the footer counts them     |
| **Pause**                   | the view stops moving and counts what arrives — "Paused · 12 new lines"; **Resume** appends them |
| scroll up more than a screen | the view stops following; "↓ 8 new lines — jump to latest" takes you back                      |
| **Copy selection** / **Copy all shown** | plain text, one line per line                                                       |

Errors and warnings are coloured and carry the level in text (`✖ error`, `⚠ warn`) — from the source's own
level where it has one (journal priority, event level, unified-log message type), from the line's text
otherwise ("0 errors" is not an error). A rotated or truncated file keeps being followed without a reopen.

Keyboard: `/` focuses the filter · `Space` pauses and resumes (list focused) · `End` jumps to the latest ·
`Esc` clears the filter · `C` copies the selection.

The footer says what the view is doing and what it received: following or paused, lines held (at most
5 000 — older ones go first, and it says so), bytes read, and how many spans the secret scan replaced
(`[redacted secret]`).

### Several logs at once, and older lines

**Ctrl-click** (⌘-click on a Mac) another source to add it to the open view: up to **12** sources show in one
viewer, merged by time, each line carrying a coloured chip with its source's name; the filter applies across all
of them. A Compose project's **Logs** on the Docker tab opens its containers this way. When one of them ends (a
container removed or stopped), the others keep following.

**Load 500 earlier** adds the 500 lines before the oldest one on screen, without moving what you were reading.
It works for the system journal, the Windows event logs and files; container logs are bounded by Docker's log
driver and say so, and the macOS unified log has no earlier page here.

### Limits and what happens at them

- Live lines arrive at no more than **1 MiB/s**. A log that writes faster has its oldest unsent lines dropped
  on the machine, and the footer says "Skipped 1 240 lines — the log is faster than the link".
- One person may have **8** logs open on one computer; the ninth is refused with "Close one of the 8 open logs".
- If the computer's link drops, the badge reads `○ RECONNECTING`, the lines on screen stay, and following
  resumes when it is back; if it cannot, "Lost the live feed — reopen to continue".
- With the Fleet kill switch on, nothing opens and an open viewer stops following within seconds, keeping its
  lines ("Following stopped — all computers are stopped").
- A container that is removed, or a file deleted, ends with "acme-api is gone".

## Who can read logs

Logs are the `logs` family of a computer's control policy — by default its **owner only**. An Organization
member the policy leaves out sees the tab with its sources greyed and "Only the owner of build-01 can read its
logs". Every source opened and every follow is recorded in the computer's audit trail (`node.logs.read`,
`node.logs.follow`) with the source, who asked, and the line and redaction counts — never a log line.

## Agents, MCP and the API

An Agent can read the same sources, read-only, through two tools: `fleet_logs_sources` (the list) and
`fleet_logs_read` (at most 500 lines of one source, optionally filtered). It cannot follow a log, and it may
read only when the computer's `logs` audience includes the Agent's owner; the read is audited as the Agent.
The same two tools are offered by the MCP server. The routes, under `/api/fleet`:

| Route                                  | What                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| `GET  /nodes/:id/logs/sources`         | the four groups                                         |
| `POST /nodes/:id/logs/attach-token`    | a 60-second token for the viewer socket (`/ws/fleet/logs/<id>`) |
| `POST /nodes/:id/logs/read`            | one batch of at most 500 lines, never a follow          |

Refusals use the shared envelope `{ error: { code, hint, details } }`: `unreachable`, `consent_missing`,
`permission_denied`, `kill_switch`, `limit_exceeded`, `unsupported_on_node`, `invalid`, `not_found`,
`operation_failed`. Reading logs spends no model tokens and no credits.
