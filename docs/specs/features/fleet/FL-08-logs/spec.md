# FL-08 — Logs: system, files, containers, services

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-08-logs`
**Program:** [Fleet](../README.md) · Wave 1
**Branch:** `feat/fl-08-logs`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** FL-02 (node link, `--manage`, node modules), FL-01 (computer page shell, roles) · **Related:** FL-09 (Compose merged logs, service → log hand-off), FL-11 (file roots), FL-03 ("needs a look" → log), FL-19 (tool parity), AW-11 (outbox secret scan)
**Extends (existing Ever Works nouns):** Node / Computer · Fleet · Agent · Fleet audit · Command palette

---

## 0. TL;DR

A computer page gains a **Logs** tab that reads the machine's logs where they already are — the
system journal, the standard log directories, the files under the node's allowed roots, every
Docker container, every running service — and shows them the way an operator expects: the last
500 lines at once, then live, with a filter, a pause that counts what arrives, colour on errors
and warnings, and copy. Nothing is stored on the platform; nothing leaves the machine unscanned.
Agents get the same read through one read-only tool.

```
 ← Fleet   build-01   ● online · Linux · last check 09:41                         [New session ▾] [⋯]
 ┌ Overview │ Sessions │ Desktop │ Logs │ Services │ Docker │ Processes │ Ports │ Files │ … ┐
 │ SOURCES                               │ System journal · build-01                 ● LIVE   │
 │ ▸ System                              │ [filter…            ] [⏸ Pause] [⤓ Follow] [⎘ Copy ▾]│
 │   ● System journal                    ├────────────────────────────────────────────────────┤
 │     Kernel                            │ 09:41:02 sshd[812]  Accepted publickey for ops …  │
 │ ▸ Files                               │ 09:41:04 dockerd    level=warning msg="…"          │
 │     /var/log/syslog        2 min ago  │ 09:41:05 kernel     usb 1-2: new device …          │
 │     ~/code/api/storage/logs/laravel.log│ 09:41:07 nginx      [error] upstream timed out    │
 │     /var/log/auth.log   🔒 root only  │ …                                                 │
 │ ▸ Containers (3)                      │                                                   │
 │     acme-api · running                │                                                   │
 │ ▸ Services (41)                       │                                                   │
 │     nginx · running                   ├────────────────────────────────────────────────────┤
 │     postgresql · failed ▲             │ Following · 12 new lines while paused · 1.2 MB read │
 └───────────────────────────────────────┴────────────────────────────────────────────────────┘
```

| Phase  | Ships                                                                                                                                                                                                               | Flag                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **P1** | Source discovery per OS; the viewer (last 500, follow, filter, pause, copy, colour); files under allowed roots and standard log directories; container and service logs; Logs tab; `fleet_logs_read`; palette entry | `FLEET_MACHINE_FACTS_ENABLED` |
| **P2** | Merged multi-source view (Compose hand-off to FL-09), "load 500 earlier", deep links from the Services and Docker tabs                                                                                              | same                          |
| **P3** | "Open the log" from a failed service, positioned at the failure (a "needs a look" item once CONTRACTS §4.6 has its kind), snapshot download of the lines on screen                                                  | same                          |

Each phase is independently shippable.

---

## 1. Overview

**Logs** is a read-only window into what a computer has written down. The tab lists every log
**source** the Node can read, grouped as **System**, **Files**, **Containers** and **Services**,
and opens any of them in one viewer. The viewer shows the last 500 lines, then follows the source
live until the person scrolls up, pauses, or closes it. A filter narrows what is shown; a pause
keeps counting what arrives; errors and warnings are coloured; copy takes the selection or
everything on screen.

Sources are what the operating system has: on Linux the system journal and the kernel ring, on
macOS the unified log, on Windows the System and Application event logs (Security when the node
runs elevated). **Files** are the standard log directories of that operating system plus any log
file under the node's allowed roots — never the whole disk, never the home directory by default.
**Containers** are the Docker containers the machine runs. **Services** are the running services
the Services tab (FL-09) lists; opening one shows the lines its service manager attributes to it.

Every line passes the same secret scan that already protects the live-view terminal before it
leaves the machine. Reading a log is audited. The platform keeps none of it: close the viewer and
the lines are gone from Ever Works.

Agents read the same sources through one read-only tool, so an Agent asked "why did the deploy
fail on build-01?" can look at the service log before it answers. It cannot follow, and it reads
at most what a person would see on first open.

---

## 2. Why now

### 2.1 The user's question

> _"Something broke on build-01 overnight. What did it say?"_

And, from an Agent's owner:

> _"Let Nina read the service log herself instead of me pasting it into the chat."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                                   | Today they must…                                                                             | What breaks                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "What did the machine log?"                                  | Walk to the machine, or ssh in from their own laptop, and run the journal or `tail` by hand. | Ever Works shows a computer's heartbeat, disk free and capability tags (`docs/features/fleet.md:110`) and nothing a machine has written. The node's four job kinds (`packages/contracts/src/fleet/fleet-jobs.types.ts:117-120`) read no log of any kind; the node's own log is a redacting logger to its console (`apps/node/src/core/logger.ts`).            |
| "Why did that container exit?"                               | `docker logs` on the machine.                                                                | The platform knows Docker exists only as a tag — `docker --version` exiting 0 turns `docker` on (`apps/node/src/core/capabilities.ts:278-294`). No container is listed anywhere, so there is nothing to open.                                                                                                                                                 |
| "Show me the shell on that machine and I'll tail it myself." | Open the Agent's Computer tab, terminal channel, and take over.                              | That shell runs under the Agent's own file root (`apps/node/src/core/screen/terminal-channel.ts:38-40`), needs `--attend` and a take-over grant, and streams a PTY — a tail typed into a shell is a session, not a view, and it is not what an Agent can be given read-only.                                                                                  |
| "Let the Agent read it."                                     | Paste the lines into the conversation.                                                       | The one Agent fleet tool lists nodes (`packages/agent/src/fleet/agent-fleet-tools.ts:39-77`); the MCP whitelist has eight fleet entries — five reads and three actions (set/clear affinity, drain), none of them a log (`apps/mcp/src/openapi-tools/whitelist.ts:475-530`; EXISTING-SUBSTRATE §8.2); the CLI has no fleet verbs (`apps/cli/src/main.ts:5-8`). |
| "Is it safe to show a log in the browser?"                   | Trust that no token is in it.                                                                | The machine already has the right tool: every terminal frame a live view publishes is scanned by the node's outbox (`apps/node/src/core/screen/frame-outbox.ts:61-83`) with the platform's own scanner (`packages/contracts/src/secret/secret-patterns.ts:1-11`). Nothing reuses it for anything but a live view yet.                                         |

### 2.3 What this epic closes

1. **A machine that cannot be read.** Health numbers say _that_ something is wrong; the log says
   _what_. This tab is the cheapest machine view in the program (README §6, Wave 1) and the one an
   operator opens first.
2. **A log the Agent cannot see.** Agents work on these machines (Task runs, FL-04 sessions) and
   are the first to be asked why something failed. A read-only tool closes the loop without a
   human relaying text.
3. **A secret scan with one consumer.** The outbox discipline — nothing leaves unscanned — becomes
   the rule for every machine fact that carries text, starting here.

### 2.4 Why this epic is additive only

Nothing is removed or renamed. The Agent Computer tab and its terminal channel keep working as they
do. Logs are never stored as rows (README §1: machine facts are read from the Node). The only
platform-side writes are `fleet_audit` rows for reads and follows (CONTRACTS §7). This epic has no
migration slot (CONTRACTS §13) and therefore **no schema change**.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Open the system journal.**
  **Given** `build-01` is online, started with `--manage`, and the viewer is its owner,
  **when** they open **Logs** on the computer page and click **System journal**,
  **then** within 2 seconds the viewer shows the last 500 lines, newest at the bottom, and a
  `● LIVE` badge; new lines append as they are written and the view stays scrolled to the bottom.

- **S2 — Filter while following.**
  **Given** the journal is open and following,
  **when** they type `nginx` in the filter,
  **then** only lines containing `nginx` (case-insensitive) are shown, the footer reads
  _"Showing 37 of 500 lines · filter: nginx"_, and lines arriving live are filtered the same way.

- **S3 — Pause and count.**
  **Given** the viewer is following,
  **when** they click **Pause**,
  **then** the view stops moving, the button reads **Resume**, and the footer counts arrivals —
  _"Paused · 12 new lines"_ — incrementing live; **Resume** appends them and follows again.

- **S4 — Scrolling up stops the follow.**
  **Given** the viewer is following,
  **when** they scroll up by more than one screen,
  **then** following stops, a pill reads _"↓ 8 new lines — jump to latest"_, and clicking it
  scrolls to the bottom and follows again.

- **S5 — Open a container's log.**
  **Given** `build-01` runs a container `acme-api`,
  **when** they expand **Containers** and click `acme-api`,
  **then** the viewer shows that container's last 500 lines with timestamps and follows it; the
  header reads `acme-api · container · build-01`.

- **S6 — Open a service's log.**
  **Given** the Services group lists `postgresql · failed ▲`,
  **when** they click it,
  **then** the viewer shows the lines the service manager attributes to that service, newest
  last, and the header reads `postgresql · service · build-01`.

- **S7 — Open a file under an allowed root.**
  **Given** `~/code/api` is a Checkout on `build-01` (an allowed root) and holds
  `storage/logs/laravel.log` written two minutes ago,
  **when** they expand **Files**,
  **then** that file is listed under the root with its age, newest first; clicking it tails it, and
  a rotated or truncated file is followed through the rotation without a reopen.

- **S8 — Type a path.**
  **Given** the Files group is open,
  **when** they type `/var/log/nginx/error.log` into **Open a file…** and press Enter,
  **then** the file opens when it is under a standard log directory or an allowed root, and is
  refused with _"That path is outside the folders this computer shares"_ otherwise.

- **S9 — Copy.**
  **Given** lines are on screen,
  **when** they select some and press **Copy**, or choose **Copy all shown**,
  **then** exactly the selected (or every shown, filtered) line is placed on their clipboard, as
  plain text, one line per line.

- **S10 — An Agent reads a log.**
  **Given** Agent `Nina` is working a Task on `build-01` and its owner may view that computer,
  **when** Nina calls the read-only log tool for the `nginx` service with 200 lines,
  **then** she receives those lines (scanned, truncated at 200) and the read is audited as
  requested by `agent:<Nina>`; she cannot follow and cannot ask for more than 500.

- **S11 — Merged Compose logs (P2).**
  **Given** `build-01` runs a Compose project `acme` with services `api`, `db`, `cache`,
  **when** they open **Logs** from the project's picture on the Docker tab (FL-09),
  **then** one viewer shows the three containers' lines merged by time, each line carrying a
  coloured service chip, and the filter applies across all three.

- **S12 — From a failed service to the log (P3).**
  **Given** the Services tab shows _"postgresql · failed"_ on build-01 (a "needs a look" item joins
  once CONTRACTS §4.6 has a kind for it — §8b),
  **when** they click **Open the log**,
  **then** the computer page opens on the Logs tab with that service selected and the viewer
  positioned at the time of the failure.

### 3.2 Edge cases and failures

- **U1 — Node offline.**
  **Given** `build-01` has not heartbeated within the offline threshold,
  **when** the Logs tab opens,
  **then** the source list is empty and the stage reads _"build-01 is offline — last seen 12
  minutes ago"_ with **Try again**; opening any source is refused server-side with `unreachable`.

- **U2 — Consent missing.**
  **Given** the node was started without `--manage`,
  **then** the tab shows the exact command — `ever-works-node start --manage` — and the reason
  _"Logs need machine management switched on for this computer"_; every request is refused with
  `consent_missing` and that hint. No generic error.

- **U3 — Kill switch on.**
  **Given** the Fleet kill switch is on,
  **then** no source opens, an open viewer stops following within 5 seconds with _"Following
  stopped — all computers are stopped"_, lines already on screen stay, and the page carries the
  same stop banner the hub shows. Requests are refused with `kill_switch`.

- **U4 — Permission denied.**
  **Given** an Organization member whose audience excludes logs on this node,
  **then** the Logs tab is present with its sources greyed and a line _"Only the owner of build-01
  can read its logs"_; a direct request is refused with `permission_denied` and the hint names
  the family to widen.

- **U5 — Journal needs a group.**
  **Given** a Linux node whose user is not in the journal group,
  **then** the System journal entry still opens with the lines the user may see and a notice
  _"Only this user's entries. To see the whole system log, run on build-01:_ `sudo usermod -aG
systemd-journal <user>` _and sign in again."_ The command is copyable; nothing is run for them.

- **U6 — Root-only file.**
  **Given** `/var/log/auth.log` is readable by root only,
  **then** it is listed with a `🔒 root only` badge and cannot be opened; the hint reads
  _"Readable by root only on build-01"_ and no permission-changing command is suggested.

- **U7 — Windows Security log without elevation.**
  **Given** a Windows node running without administrator rights,
  **then** **Security** is listed under System as _"needs administrator"_ and opening it is refused
  with `unsupported_on_node` and the hint _"Run the node service as an administrator to read the
  Security log"_.

- **U8 — Link drops mid-follow.**
  **Given** the node link drops while following,
  **then** the badge turns to `○ RECONNECTING`, lines on screen stay, and within the link's
  reconnect window the follow resumes from the last line seen; if the node cannot resume the
  channel, the viewer says _"Lost the live feed — reopen to continue"_ with **Reopen**.

- **U9 — Too fast to follow.**
  **Given** a source writes faster than 1 MiB/s,
  **then** the node drops the oldest unsent lines, the footer reads _"Skipped 1 240 lines — the
  log is faster than the link"_, and the viewer never falls behind by more than 1 MiB.

- **U10 — Source disappears.**
  **Given** a container being followed is removed, or a file deleted,
  **then** the viewer shows _"acme-api is gone"_ under the last line, stops following, and the
  source leaves the list on the next refresh.

- **U11 — Limit exceeded.**
  **Given** eight sources are already being followed on this node by this person,
  **when** a ninth is opened,
  **then** it is refused with `limit_exceeded` and the hint _"Close one of the 8 open logs on
  build-01"_. (Eight per viewer per Node keeps one viewer inside the link's 64-channel budget,
  CONTRACTS §10; the per-viewer number is not yet a §10 row — §8b.)

- **U12 — Secret in a line.**
  **Given** a log line contains a token-shaped string,
  **then** the line arrives with that span replaced by `[redacted]` and the footer counts
  _"3 redactions"_; the raw line never leaves the machine.

- **U13 — Not available on this kind of node.**
  **Given** the computer runs the desktop node app (before FL-02's last phase),
  **then** the tab reads _"Not available on this kind of node yet"_ (CONTRACTS R-10), with no
  spinner and no error tone.

- **U14 — Agent asks for a path outside the roots.**
  **Given** an Agent calls the read tool with `/etc/shadow`,
  **then** it is refused with `invalid` and the hint _"Only files under this computer's shared
  folders and standard log directories can be read"_; the refusal is audited.

---

## 4. Functional requirements

Every default, limit and cadence below is a number. Values marked **(C)** come from
[CONTRACTS.md](../CONTRACTS.md) and are not re-derived here.

### 4.1 P1 — Sources

- **FR-1** The Logs tab MUST list sources in four groups — **System**, **Files**, **Containers**,
  **Services** — and MUST show each group's count.
- **FR-2** On Linux, **System** MUST offer the system journal and the kernel ring as two sources.
- **FR-3** On macOS, **System** MUST offer the unified log as one source.
- **FR-4** On Windows, **System** MUST offer the System and Application event logs, and MUST offer
  the Security event log only when the node runs with administrator rights, listing it otherwise
  as _needs administrator_.
- **FR-5** **Files** MUST list regular files under the standard log directories of that operating
  system and under every allowed root (CONTRACTS R-18 **(C)**), newest modification first,
  limited to the 200 most recently written files per root, and MUST never list the home directory
  as a whole.
- **FR-6** A file the node's user cannot read MUST be listed with a _root only_ marker and MUST
  not be openable.
- **FR-7** A typed path MUST open only when it canonicalises to a location under a standard log
  directory or an allowed root; a symlink escaping those MUST be refused.
- **FR-8** **Containers** MUST list every Docker container the machine's Docker CLI reports,
  running or not, with its state; this list is read through the Docker CLI only, never the
  daemon socket.
- **FR-9** **Services** MUST list the running services the Services tab lists (FL-09), failed
  first, and MUST open the lines the service manager attributes to that service.
- **FR-10** When a source cannot be read because of group membership, the entry MUST still open
  with what is readable and MUST show the exact command that grants membership, never run it.
- **FR-11** Sources MUST be re-listed when the tab is opened and every 30 seconds while it is
  visible; a source that disappears MUST leave the list on the next refresh.

### 4.2 P1 — The viewer

- **FR-12** Opening a source MUST show its last **500** lines **(C)** within 2 seconds at the 95th
  percentile when the node is online, then follow it live.
- **FR-13** Live lines MUST be delivered at no more than **1 MiB/s** **(C)**; above that the node
  MUST drop the oldest unsent lines and report the count dropped.
- **FR-14** The viewer MUST state in prose whether it is following, paused, or stopped, and why.
- **FR-15** **Pause** MUST stop the view moving, MUST count arriving lines while paused, and
  **Resume** MUST append them and follow again.
- **FR-16** Scrolling up by more than one viewport MUST stop following and show a count of new
  lines with a one-click return to the bottom.
- **FR-17** The filter MUST be a case-insensitive substring match applied to the lines held by the
  viewer and to every live line, and the footer MUST state how many of the held lines match.
- **FR-18** Lines MUST be classified `error`, `warning` or `info` from the source's own level
  where it has one (journal priority, event level) and from the line's text otherwise, and
  `error` and `warning` MUST be coloured and MUST carry the level in text for assistive readers.
- **FR-19** **Copy** MUST copy the selection, and **Copy all shown** MUST copy every line currently
  shown after filtering, as plain text.
- **FR-20** A rotated or truncated file MUST continue to be followed from the new file without a
  reopen.
- **FR-21** The viewer MUST hold at most 5 000 lines; older lines MUST be discarded first and the
  footer MUST say so.
- **FR-22** Every line MUST pass the platform's secret scan on the node before it leaves the
  machine; a redacted span MUST read `[redacted]` and the footer MUST count redactions.
- **FR-23** The viewer MUST show the bytes it has received since the source was opened.
- **FR-24** Closing the tab, navigating away, or the browser disconnecting MUST stop the follow on
  the node within 15 seconds.

### 4.3 P1 — Consent, permission, audit, kill switch

- **FR-25** Every log action MUST require the `manage` consent **(C §1.1)**; a node without it MUST
  be refused with `consent_missing` and the exact command, and the tab MUST show that command.
- **FR-26** Reading or following a log MUST be governed by the `logs` action family of the Node's
  control policy (CONTRACTS §2.1, default audience `owner`); a caller outside the audience MUST be
  refused with `permission_denied` naming the family.
- **FR-27** Every source open MUST write one `fleet_audit` row `node.logs.read` **(C §7)** and
  every follow MUST write one `node.logs.follow` row, each naming the source, the requester
  (`user:` or `agent:`), the line count and the redaction count, and MUST never contain a log line.
- **FR-28** Confirmation class for every log action MUST be `plain` **(C §2.2)**.
- **FR-29** When the kill switch is on, every log request MUST be refused with `kill_switch`
  **(C R-24)**, every follow MUST stop within 5 seconds, and lines on screen MUST remain.
- **FR-30** The errors a log action can return MUST be drawn from CONTRACTS §8 only:
  `unreachable`, `consent_missing`, `permission_denied`, `kill_switch`, `limit_exceeded`,
  `unsupported_on_node`, `invalid`, `not_found`, `operation_failed`.

### 4.4 P1 — Agent tool, palette, flag

- **FR-31** An Agent tool `fleet_logs_read` MUST return up to **500** lines of one source, marked
  `readOnly: true`, MUST refuse follow, and MUST be gated by the Agent's permissions and the
  Node's `logs` audience as CONTRACTS §2.1 requires.
- **FR-32** An Agent tool `fleet_logs_sources` MUST list the sources an Agent may read, marked
  `readOnly: true`.
- **FR-33** The command palette MUST offer _"Logs on <computer>"_ for every computer the person
  may view, opening the Logs tab.
- **FR-34** Every surface in this epic MUST be behind `FLEET_MACHINE_FACTS_ENABLED` **(C §9)** in
  addition to `FLEET_ENABLED`; with the flag off the tab is not registered and the routes answer
  as unmounted.

### 4.5 P2 — Merged view and paging

- **FR-35** A viewer MUST accept up to 12 sources at once and MUST merge their lines by timestamp,
  tagging each line with a coloured chip naming its source.
- **FR-36** The Docker tab's Compose project view (FL-09) MUST open the merged viewer for a
  project's containers in one click.
- **FR-37** **Load 500 earlier** MUST prepend the previous 500 lines of a source that supports
  it (journal, event logs, files) and MUST say when a source does not (container logs are
  bounded by the Docker log driver).
- **FR-38** The Services tab (FL-09) MUST offer **Open log** on every service row, and the Docker
  tab on every container row, each opening the Logs tab with that source selected.

### 4.6 P3 — Deep links and snapshots

- **FR-39** A failed service MUST offer **Open the log** that opens the Logs tab on that service
  positioned at the failure time — from the Services tab's failed rows (FR-38) and, once CONTRACTS
  §4.6 has a kind for a failed service, from that "needs a look" item (§8b; no such kind exists
  today, so no item is produced by this epic).
- **FR-40** **Download shown lines** MUST produce a plain-text file of the filtered lines on
  screen, scanned, named `<computer>-<source>-<time>.log`, produced in the browser from what the
  viewer already holds — the platform stores nothing.

---

## 5. UX

All copy below is the exact user-visible string; keys are listed in plan §8.

### 5.1 The tab — loaded, following

```
┌ Overview │ Sessions │ Desktop │ Logs │ Services │ Docker │ Processes │ Ports │ Files │ Schedules │ Checkouts │ Settings ┐
│ SOURCES                     ↻ 30 s │ System journal · build-01                              ● LIVE  │
│ ▾ System (2)                       │ [ filter…               ] [ ⏸ Pause ] [ ⤓ Following ] [ ⎘ Copy ▾ ]│
│   ● System journal                 ├─────────────────────────────────────────────────────────────┤
│     Kernel                         │ 09:41:02  sshd[812]   Accepted publickey for ops from …      │
│ ▾ Files (6)                        │ 09:41:04  dockerd     level=warning msg="…"           ⚠ warn │
│   /var/log/syslog         2 min    │ 09:41:07  nginx       [error] upstream timed out     ✖ error │
│   ~/code/api/storage/logs/… 5 min  │ 09:41:08  kernel      usb 1-2: new device …                  │
│   /var/log/auth.log  🔒 root only  │ 09:41:09  sshd[815]   session opened …                       │
│   [ Open a file…              ]    │                                                             │
│ ▾ Containers (3)                   │                                                             │
│   acme-api · running               │                                                             │
│   acme-db · running                │                                                             │
│   old-build · exited (1)           │                                                             │
│ ▾ Services (41)                    ├─────────────────────────────────────────────────────────────┤
│   postgresql · failed ▲            │ Following · 500 lines held · 1.2 MB read · 0 redactions      │
│   nginx · running                  │                                                             │
└────────────────────────────────────┴─────────────────────────────────────────────────────────────┘
```

The `Copy ▾` menu holds **Copy selection**, **Copy all shown**, and (P3) **Download shown lines**.

### 5.2 Paused

```
│ [ filter…               ] [ ▶ Resume ] [ ⤓ Following ] [ ⎘ Copy ▾ ]│
…
│ Paused · 12 new lines                                              │
```

### 5.3 Scrolled up

```
│                    ┌───────────────────────────┐                   │
│                    │ ↓ 8 new lines — jump to latest │               │
│                    └───────────────────────────┘                   │
│ Not following — scroll to the bottom to follow again.               │
```

### 5.4 Filtered

```
│ [ nginx                  ] [ ⏸ Pause ] [ ⤓ Following ] [ ⎘ Copy ▾ ]│
…
│ Following · showing 37 of 500 lines · filter: nginx                 │
```

### 5.5 Group-membership notice (Linux journal)

```
│ ⓘ Only this user's entries. To see the whole system log, run on build-01:   │
│   sudo usermod -aG systemd-journal ops                              [copy]  │
│   and sign in again.                                                        │
```

### 5.6 Empty — no sources

```
│                           📄                                        │
│              Nothing to read on build-01 yet                        │
│  No log files under this computer's shared folders, no containers,  │
│  and the system log is not readable by the node's user.             │
│  Share a folder with --files-root, or install Docker, and come back.│
```

### 5.7 Offline / unavailable with reason

```
│ ○ build-01 is offline — last seen 12 minutes ago (18 Oct 2026, 09:29). │
│   [ Try again ]                                                        │
```

Consent missing:

```
│ ⏳ Logs need machine management switched on for this computer.  │
│    Run this on build-01:                                        │
│      ever-works-node start --manage                     [copy]  │
```

Permission denied: sources listed greyed, line _"Only the owner of build-01 can read its logs."_
Desktop node: _"Not available on this kind of node yet."_
Kill switch: the hub's stop banner plus _"Following stopped — all computers are stopped."_

### 5.8 Loading

```
│ ◜ ◝ Asking build-01 for the last 500 lines…                        │
```

After 10 seconds: _"build-01 has not answered yet. It may be busy."_ After 30 seconds the request
is abandoned with _"build-01 did not answer"_ and **Try again**.

### 5.9 Error

```
│ ✖ Could not read nginx on build-01                                  │
│   journalctl exited 1: "Failed to add match 'nginx'"                │
│   [ Try again ]                                                     │
```

### 5.10 Merged view (P2)

```
│ acme · Compose project · 3 services · build-01                 ● LIVE  │
│ 09:41:02 ■api    GET /health 200 3ms                                  │
│ 09:41:02 ■db     LOG: checkpoint starting                             │
│ 09:41:03 ■cache  1:M Background saving started                        │
```

### 5.11 Activity view and Agent page

- **Activity → Log** shows each `node.logs.read` and `node.logs.follow` as an audit row: _"Ops read
  nginx (service) on build-01 — 500 lines, 0 redactions"_. No log content.
- The **Agent page → Activity** shows an Agent's log reads as tool calls with the source and line
  count, never the lines.

### 5.12 Keyboard

`/` focus the filter · `Space` pause / resume (when the list has focus) · `End` jump to latest ·
`Esc` clear the filter · `C` copy selection · `?` shortcut sheet. The source list is a tree with
arrow-key navigation; the line list is a labelled log region announcing _"Following"_ /
_"Paused, N new lines"_ through a polite live region.

### 5.13 Palette

_"Logs on build-01"_ → `/fleet/computers/<id>?tab=logs`. One entry per computer the person may
view.

---

## 6. Non-functional requirements

- **Performance:** first 500 lines ≤ 2 s P95 (online node, LAN-class link); live line latency
  ≤ 1 s P95; the viewer renders 5 000 held lines without dropping below 50 fps while scrolling
  (virtualised list).
- **Reliability:** a follow survives a node-link reconnect inside the link's resume window
  (CONTRACTS §3.1); a channel that cannot resume is reported, never silently dead. Every refusal
  is typed and carries a hint.
- **Security & privacy:** lines are scanned on the node before they leave it; the platform never
  persists a log line, a path outside what the audit row needs, or a file's contents; reads are
  audited; paths are canonicalised and roots enforced on the node (R-18); the Docker daemon socket
  is never opened — only the CLI is run; nothing on the machine listens (README D2).
- **Observability:** audit rows per read/follow; API metrics for open sources per node, dropped
  lines, redactions; node-side warnings when a source cannot be read.
- **Compatibility:** Linux (systemd), macOS 12+, Windows 10/11 with PowerShell 5.1+; a machine
  without a service manager still offers Files and Containers; additive contracts only
  (Constitution X).
- **Cost:** reading logs spends no model tokens and no credits; the viewer shows bytes received.
  An Agent's log read is part of its Run and appears in its receipt like any other tool call.

---

## 7. Key entities & concepts

| Entity / concept                | New?                      | Description                                                                                                              |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Node** (UI copy **Computer**) | Existing                  | The machine whose logs are read. Gains nothing in this epic; its `consents` and `controlPolicy` (FL-01/02) gate the tab. |
| **Log source**                  | concept                   | One thing that can be tailed: a system log, a file, a container, a service. Read from the Node, never stored.            |
| **Viewer**                      | concept                   | One open source (or merged set) in a browser: held lines, filter, follow state, counters.                                |
| **Fleet audit**                 | Existing                  | Gains two action names, `node.logs.read` and `node.logs.follow` (CONTRACTS §7).                                          |
| **Allowed roots**               | Existing (CONTRACTS R-18) | Where file sources may come from, plus the OS's standard log directories.                                                |
| **"Needs a look" item**         | Existing (CONTRACTS §4.6) | P3: a failed-service item carries an _Open the log_ action.                                                              |

No new noun is introduced (README §1).

---

## 8. Out of scope

- **Storing or indexing logs on the platform.** No retention, no search across history, no alerts
  on log content. Lines live on the machine.
- **Editing or deleting log files.** Read-only, always.
- **Changing group membership or permissions on the machine.** The exact command is shown; it is
  never run.
- **Non-Docker container runtimes** (Podman, containerd without Docker). Later, behind the same
  sources shape.
- **Structured log parsing** beyond level classification (no JSON field filters, no histograms).
- **Reading another Agent's isolated profile directories** as "files" — Agent profiles are never
  roots (R-18, AW-11).
- **The CLI verb.** `ever-works fleet logs read` ships in FL-19 using this epic's shapes.

## 8b. Open questions

- **Resolved** by CONTRACTS §2.1: `logs` is an action family with default audience `owner`; log
  reads map to it (FR-26).
- **Resolved** by CONTRACTS §3.3: the `logs` family opens with `{ source, path?, unit?, container?,
lines, sources?[] }`; the P2 merged view uses `sources[]`, single-source opens are unchanged.
- **Resolved** by CONTRACTS §2.1: an Agent reads a log only when both its own permissions allow the
  tool and the Node's `logs` audience includes the Agent's owner; no further owner opt-in (FR-31).
- `[NEEDS CLARIFICATION: Windows "standard log directories" for the Files group (R-18 names "the OS
standard log directories" without listing Windows ones). Default until answered: on Windows only
the node's own log directory plus the allowed roots; `C:\Windows\Logs` is not listed
(administrator-only and noisy).]`
- **Resolved** by CONTRACTS §3.3, §4.6 and §10 (rev 4): `logs.sources` is a `machine` verb; `logs.earlier`, `logs.initial-done`, `logs.earlier-done`, `logs.notice` on the `logs` channel; kind `service-failed`; limits 5 000 held lines, 200 files per root, 12 merged sources, 8 log channels per viewer per Node; one allowed-roots resolver (R-39).

---

## 9. Acceptance criteria

- [ ] **ACC-FL08-01** On an online Linux node with `--manage`, the Logs tab lists System (journal,
      kernel), Files, Containers and Services groups with counts. (FR-1, FR-2, FR-11)
- [ ] **ACC-FL08-02** Opening the journal shows exactly the last 500 lines within 2 s and follows;
      a line written on the node appears within 1 s. (FR-12)
- [ ] **ACC-FL08-03** A source writing 4 MiB/s is capped at 1 MiB/s and the footer reports
      dropped lines. (FR-13)
- [ ] **ACC-FL08-04** Pause counts arriving lines; Resume appends them; scrolling up stops the
      follow and the pill returns to the bottom. (FR-15, FR-16)
- [ ] **ACC-FL08-05** The filter narrows held and live lines; the footer counts matches. (FR-17)
- [ ] **ACC-FL08-06** Error and warning lines are coloured and carry the level in text. (FR-18)
- [ ] **ACC-FL08-07** A rotated file is followed through the rotation. (FR-20)
- [ ] **ACC-FL08-08** A line containing a token-shaped string arrives with `[redacted]` and the
      footer counts one redaction; the raw string is absent from every API and WebSocket payload.
      (FR-22)
- [ ] **ACC-FL08-09** A file outside the roots is refused with `invalid` and the hint; a symlink
      from a root to `/etc` is refused. (FR-7, U14)
- [ ] **ACC-FL08-10** A node without `--manage` shows the exact command; the API answers
      `consent_missing`. (FR-25)
- [ ] **ACC-FL08-11** An Organization member outside the audience sees greyed sources and the
      API answers `permission_denied` naming `logs`. (FR-26)
- [ ] **ACC-FL08-12** Each open writes `node.logs.read`, each follow `node.logs.follow`, with
      source, requester, line and redaction counts and no line text. (FR-27)
- [ ] **ACC-FL08-13** With the kill switch on, requests answer `kill_switch` and an open follow
      stops within 5 s keeping its lines. (FR-29)
- [ ] **ACC-FL08-14** `fleet_logs_read` returns ≤ 500 scanned lines, refuses `follow`, and is
      audited as `agent:<id>`. (FR-31)
- [ ] **ACC-FL08-15** The palette lists "Logs on <computer>" for each viewable computer. (FR-33)
- [ ] **ACC-FL08-16** With `FLEET_MACHINE_FACTS_ENABLED=false` the tab is absent and the routes
      answer 404. (FR-34)
- [ ] **ACC-FL08-17** (P2) A Compose project's **Logs** opens a merged viewer with per-service
      chips ordered by time. (FR-35, FR-36)
- [ ] **ACC-FL08-18** (P2) **Load 500 earlier** prepends journal lines and says "no earlier lines"
      for a container. (FR-37)
- [ ] **ACC-FL08-19** (P3) **Open the log** on a failed service row opens the log at the failure
      time; no "needs a look" item is produced until CONTRACTS §4.6 has a kind for it. (FR-39)
- [ ] **ACC-FL08-20** (P3) **Download shown lines** yields a text file of the filtered lines only.
      (FR-40)
- [ ] All functional requirements have a passing unit, controller/e2e, node-side or Playwright
      test (plan §14).

---

## 10. Constitution gates

- [x] **I Plugin-first** — n/a: reading a machine's own logs is an OS fact in a node module, not an
      external integration (README D8); no plugin is introduced.
- [x] **II Capability-driven** — n/a: no plugin id is named; the node module advertises the `logs`
      tag (CONTRACTS §1.2).
- [x] **III Source-of-truth repos** — untouched; no content is stored.
- [x] **IV Job runtime** — n/a: every read is an ephemeral link request (CONTRACTS §12); no
      long-running platform work.
- [x] **V Forward-only migrations** — no schema change (no slot in CONTRACTS §13).
- [x] **VI Tests first** — plan §14 names them per package.
- [x] **VII Secrets** — lines scanned on the node; audit redaction belt; nothing stored.
- [x] **VIII Plugin counts** — n/a: no plugin.
- [x] **IX Behaviour-first** — this document names no class or path outside citations of today's
      code.
- [x] **X Backwards compatibility** — additive contracts (new types, new audit values, new tags).

---

## 11. References

- Program: [README](../README.md) §1 vocabulary · §4 D2, D7, D8 · §7 rules 11–14 ·
  [CONTRACTS](../CONTRACTS.md) §1.1 consents, §1.2 `logs` tag, §2 permissions, §3.3 `logs`
  family, §7 audit names, §8 errors, §9 flags, §10 limits (log read), §11 routes, R-18, R-24 ·
  [CAPABILITY-MAP](../CAPABILITY-MAP.md) §D logs row.
- Sibling epics: [FL-02](../FL-02-node-link/) (link, `--manage`, modules), [FL-01](../FL-01-fleet-hub/)
  (tab registry, roles), [FL-09](../FL-09-services-docker/) (services, containers, Compose),
  [FL-11](../FL-11-files/) (roots), [FL-03](../FL-03-computer-health/) ("needs a look"),
  [FL-19](../FL-19-agent-mcp-cli/) (CLI parity).
- Existing code cited: `apps/node/src/core/screen/frame-outbox.ts`,
  `packages/contracts/src/secret/secret-patterns.ts`, `apps/node/src/core/capabilities.ts`,
  `apps/node/src/core/screen/terminal-channel.ts`, `packages/agent/src/fleet/agent-fleet-tools.ts`,
  `apps/mcp/src/openapi-tools/whitelist.ts`, `apps/cli/src/main.ts`, `docs/features/fleet.md`.
- Prior art inside Ever Works: [AW-11 Agent computers](../../agent-workspace/AW-11-agent-computers/spec.md)
  (the terminal channel and its outbox).
- User docs (to be written): `docs/features/fleet-logs.md`.
