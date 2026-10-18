# FL-18 — Actions runners on computers: install, status, jobs

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no code. Substrate citations (`path:Lnn`) appear only as evidence for "we do not
> have this today" claims (program rule 13). Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-18-actions-runners`
**Program:** [Fleet](../README.md) · Wave 3 (machines and CI)
**Branch:** `feat/fl-18-actions-runners`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** M · **Blocked by:** FL-09 (services module), FL-02 (node link, operations), FL-08 (log sources), FL-01 (Overview block registry) · **Related:** FL-03 ("needs a look"), FL-15 (GitHub on the fleet), FL-16 (Docker on a host, P3), FL-19 (tool parity)
**Extends (existing Ever Works nouns):** Node · Fleet · Job · Plugin (GitHub App) · Service (FL-09) · Log source (FL-08) · Fleet audit · Needs a look · Inbox

---

## 0. TL;DR

A computer in the Fleet can become a **GitHub Actions self-hosted runner** for a repository or an
organisation the owner has installed the Ever Works GitHub App on — from the computer's page, in one
dialog, without the `gh` CLI and without the owner ever seeing a registration token. The node
downloads the correct runner build, verifies its checksum, registers it with the name, labels and
count the owner chose (up to 16), and runs it as a service through the machine's own service manager.
The computer's Overview shows each runner as **working · idle · offline** with the last check; the
hub shows the **Actions jobs** that are queued or running on the owner's runners, counts busy
runners, and says plainly when _no runner can take this job_ — and why (offline, missing label, wrong
scope) — with a one-click **Cancel workflow run**. Runner logs are a log source like any other. A stopped
runner or a stuck job becomes a "needs a look" item.

```
 COMPUTER build-01 › Overview
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ Actions runners (2)                                               [+ Install runners] │
 │   ● build-01-1   acme/api        idle      self-hosted linux x64 gpu   checked 09:41 │
 │   ◐ build-01-2   acme/api        working   "test · ubuntu" #4821   checked 09:41     │
 │                                   [Stop] [Restart] [Logs] [Open job on GitHub] [⋯]   │
 └──────────────────────────────────────────────────────────────────────────────────────┘

 FLEET HUB › Overview › Actions jobs                        3 queued · 2 running · 2 of 3 runners busy
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ ◐ acme/api   test · ubuntu          #4821   build-01-2          running 4 min        │
 │ ◐ acme/web   build                  #911    design-mac-1        running 1 min        │
 │ ⏳ acme/api  e2e · windows          #4822   queued 6 min  ⚠ no runner can take it     │
 │              needs label windows — runners have linux x64 gpu  [Cancel workflow run…] │
 │ ⏳ acme/api  lint                   #4823   queued 2 min   waiting for build-01-1     │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

Three phases, each independently shippable:

| Phase  | Ships                                                                                                                                                                                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Plugin `github-actions-runners`; node jobs `runner-install` / `runner-control`; the install dialog; runners as services (Linux systemd, macOS launchd, Windows service); status on the Overview and a Runners block; logs through FL-08; `runner-stopped`; audit; Agent tools |
| **P2** | The **Actions jobs** panel in the hub: queued and running self-hosted jobs for watched repositories and organisations, busy count, unassignable diagnosis, **Cancel workflow run** (`confirm`), `job-unassignable`; organisation scope with **Grant access** |
| **P3** | Docker-isolated runners on Linux hosts with Docker; runner version visibility and "update available"                                                                                                   |

---

## 1. Overview

From a computer's page the owner presses **Install runners**, picks the target — a repository or an
organisation among those the Ever Works GitHub App is installed on for them — how many runners (1 to
16), their names (defaulting to `<computer>-<n>`), extra labels, and confirms. The platform mints
the registration token through the GitHub App at the moment the node is ready for it and hands it
over the node link; the node never puts it on a command line and the owner never sees it. The node
downloads the runner build GitHub publishes for its OS and architecture, verifies the published
checksum, configures the runner unattended and installs it as a service through the machine's
service manager (FL-09). Each runner is a row under its computer with a state the platform reads
from GitHub (working / idle / offline) and from the node (service running or not), and a last-check
time. Start, stop and restart act on the service; **Remove runner…** deregisters at GitHub, uninstalls
the service and deletes the runner's folder — typed-name confirmed.

The hub's Overview gains an **Actions jobs** panel: the queued and in-progress jobs of the watched
repositories and organisations that target self-hosted runners, who is running them, how many of
the owner's runners are busy, and — for a queued job — whether any of the owner's runners could
ever take it. When none can, the row says why in plain words: the only matching runner is offline,
no runner carries a label the job demands, or the job belongs to a repository or organisation none
of the runners is registered to. **Cancel workflow run…** cancels the whole workflow run after a
confirmation. Organisation-level runners need an App permission the installation may not have; the
dialog says exactly which and offers **Grant access**, which opens the installation's permission
page on GitHub.

Nothing is removed. Windows runners run as services only. Docker-isolated runners are a third
phase, available only on Linux hosts that advertise Docker.

---

## 2. Why now

### 2.1 The user's question

> _"Our CI queue is 40 minutes deep — can this build box pick jobs up, and will I know when it stops?"_

### 2.2 What they do today, and what breaks

| To get…                              | Today they must…                                                                                                    | What breaks                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A self-hosted runner on a machine    | Open GitHub's runner page, copy a token, SSH to the machine, download, verify by hand, configure, install the service | Nothing in the product touches runners: the GitHub plugin's Actions surface covers secrets, variables, workflows and dispatch only (`packages/plugins/github/src/github-actions.service.ts:1-215`); the build plugin only _selects_ a runner label for workflows it generates (`packages/plugins/github-actions-build/src/github-actions-build.plugin.ts:42`). |
| To know whether runners are alive     | Open each repository's runner page                                                                                  | A Node has no notion of a runner and no row to hang its state on (`packages/agent/src/entities/fleet-node.entity.ts:96-115`); the job kinds are the four of today (`packages/contracts/src/fleet/fleet-jobs.types.ts:117-125`).                                 |
| To see why a job is stuck            | Read the job's "Waiting for a runner" page and compare labels by eye                                                | No surface compares job labels with the owner's runners.                                                                                                                                                                                                      |
| To do it without a personal token    | Use the `gh` CLI on the machine                                                                                     | The platform already holds a GitHub App and mints narrowly-scoped installation tokens for node-side acts (`packages/agent/src/utils/github-app.utils.ts:79-130`; `apps/api/src/fleet/fleet-push-credential.service.ts:184-199`) — nothing uses that for runners. |

Three existing mechanics make this cheap: the GitHub App installation records carry the account
and `targetType` needed to pick a repository or organisation scope
(`packages/agent/src/entities/github-app-installation.entity.ts:11-64`); the node already installs
_itself_ as a service on every OS (`apps/node/packaging/systemd/ever-works-node@.service`;
`apps/node/packaging/README.md:8-14`), the pattern FL-09's service module generalises; and the
`actions-runner` capability tag is already reserved (CONTRACTS §1.2).

### 2.3 Why this epic is additive only

A plugin, two job kinds, one new table and a hub panel. The GitHub plugin, the build plugin and the
node's own service install are untouched.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Install two runners (owner).**
  **Given** `build-01` is online with `--work`, advertises `actions-runner`, and the owner's GitHub
  App installation covers `acme/api`, **when** they press **Install runners**, pick `acme/api`,
  count 2, labels `gpu`, keep **Run as a service**, and confirm, **then** within 500 ms two rows
  `build-01-1 · installing`, `build-01-2 · installing` appear with progress _"downloading 2.3xx ·
  verifying · registering · starting"_, and within 2 minutes both read `● idle` with labels
  `self-hosted linux x64 gpu`; GitHub lists them under `acme/api`; an audit row `node.runner.install`
  per runner names the owner, the computer and the target.

- **S2 — Status on the Overview.**
  **Given** a job starts on `build-01-2`, **when** the owner opens `build-01`'s Overview, **then**
  the runner reads `◐ working · "test · ubuntu" workflow #4821 · checked 09:41`, and **Open job on
  GitHub** links to the job.

- **S3 — Stop, restart, logs.**
  **Given** `build-01-1` is idle, **when** the owner presses **Stop** and confirms, **then** the
  service stops, the row reads `■ stopped (by you)`, GitHub shows it offline, and no "needs a look"
  item is raised for a stop the owner asked for; **Restart** restarts the service; **Logs** opens the
  runner's newest diagnostic log in the Logs tab (FL-08) as source `runner:build-01-1`.

- **S4 — Remove.**
  **Given** `build-01-1` exists, **when** the owner presses **Remove runner…**, types its name and
  confirms, **then** the runner is deregistered at GitHub, its service uninstalled, its folder
  deleted, the row disappears, and `node.runner.remove` is audited.

- **S5 — Actions jobs (P2).**
  **Given** three jobs are queued and two running across `acme/api` and `acme/web`, **when** the owner
  opens the hub, **then** the **Actions jobs** panel lists them with repository, job and run names,
  the runner (or `queued N min`), the busy count `2 of 3 runners busy`, and for the queued job that
  needs `windows` the line _"no runner can take it — needs label windows; your runners have linux
  x64 gpu"_ with **Cancel workflow run…**.

- **S6 — Cancel a run (P2).**
  **Given** a queued job no runner can take, **when** the owner presses **Cancel workflow run…** and confirms
  _"Cancel workflow run #4822 of acme/api? Every job in it stops."_, **then** the whole workflow run is
  cancelled at GitHub, the row leaves the panel within one poll, and `node.runner.job.cancel` is
  audited (CONTRACTS §7).

- **S7 — Organisation scope (P2).**
  **Given** the owner picks the organisation `acme` as target, **when** the installation lacks the
  self-hosted-runners permission at organisation level, **then** the dialog reads _"Registering
  runners for the organisation acme needs the Ever Works GitHub App permission 'Self-hosted runners:
  Read and write' on acme"_ with **Grant access** (opens the installation's permission page) and
  **Use a repository instead**; Install stays disabled until a re-check passes.

- **S8 — An Agent asks.**
  **Given** Agent `Ops`'s tool grants allow the runner tools and `build-01`'s `machines` audience
  includes its owner (CONTRACTS §2.1), **when** it calls `fleet_runners_list`, **then** it receives
  the owner's runners read-only; **when** it calls `fleet_runners_install` with its ladder at **Ask**
  for _Change a computer_, **then** the call is held as an `agent_action_proposals` row (CONTRACTS
  R-33) whose Decision states _"Installs 2 Actions runners for acme/api on build-01 as services. They
  run CI jobs on that computer; no credits are spent."_; at **Auto** it answers 409
  `confirmation_required` with that summary until repeated with `confirm: true` (CONTRACTS §2.2).

### 3.2 Edge cases, refusals and failures

- **U1 — Node offline.** `unreachable` with _"build-01 last heartbeated 12 min ago"_; the dialog
  greys the computer.
- **U2 — Consent missing.** The node runs without `--work` → `consent_missing`, hint _"start the
  node with --work on build-01"_ (runner jobs are work; CONTRACTS §1.1).
- **U3 — No service manager.** No systemd / launchd / Windows service manager detected → the computer
  does not advertise `actions-runner`; a direct request is refused `unsupported_on_node` with _"no
  service manager was found on build-01"_.
- **U4 — Linux without passwordless sudo.** Installing a systemd service needs root → the node
  refuses `root_required` (CONTRACTS §8) with the exact command the owner can run once on the
  machine (README §3: no sudo password is ever typed into the web UI).
- **U5 — Windows, not elevated.** The node is not running elevated and a service install needs it →
  `root_required` with the exact elevated command; Windows never offers a non-service mode.
- **U6 — Checksum mismatch.** The downloaded archive does not match GitHub's published checksum →
  `operation_failed`, hint _"checksum mismatch for actions-runner-linux-x64-2.3xx.tar.gz — nothing
  was installed"_, the archive is deleted, the row is `failed` with **Retry**.
- **U7 — App not installed on the target.** The repository is not covered by any installation of the
  owner → the target is not offered; a direct request is refused `permission_denied` with _"install
  the Ever Works GitHub App on acme/api first"_.
- **U8 — GitHub refuses the token.** GitHub answers 403 → `permission_denied` with the exact
  permission named and **Grant access**.
- **U9 — Limit.** A 17th runner on one computer → `limit_exceeded` (16 per Node, CONTRACTS §10).
- **U10 — Name collision.** The name exists at GitHub for another machine → `invalid` naming the
  field; the node never uses "replace" for a name it does not own.
- **U11 — Link drops mid-install.** The install is a durable job: download and verification continue;
  registration waits for the token, which arrives when the link returns; progress resumes.
- **U12 — Runner stops by itself.** The service exits or GitHub reports offline for 5 minutes while
  the node is online → a `runner-stopped` "needs a look" item with **Start**; a stop the owner asked
  for raises nothing.
- **U13 — Job stuck.** A queued job has waited 5 minutes and no runner could take it → a
  `job-unassignable` item with the diagnosis and **Cancel workflow run…**.
- **U14 — Kill switch.** Install, control and cancel are refused `kill_switch`; the node's link is
  paused (`link.pause`, CONTRACTS §3.2) so it refuses any `runner.*` request still in flight; running
  runners keep running (they are the owner's CI, not Ever Works work) and the panel says so.
- **U15 — Permission denied.** Outside the computer's `machines` audience → `permission_denied` with
  the audience named; the panel still shows jobs to `view` audience viewers.
- **U16 — Remove while working.** The runner is mid-job → **Remove runner…** is refused `busy` with
  _"build-01-2 is running job test · ubuntu; stop after the job or cancel the run"_.
- **U17 — Rate limit.** GitHub rate-limits polling → the last known state is shown with _"checked
  09:41 · GitHub is rate-limiting"_; polling backs off to the reset time.

---

## 4. Functional requirements

Values marked **(C)** come from [CONTRACTS.md](../CONTRACTS.md).

### 4.1 Action families (program rule 12)

| Family action          | Consent on node (C §1.1) | Permission family / default audience (C §2.1) | Confirmation (C §2.2)                                 | Audit (C §7)                                | Agent tool (C §11.3)                        |
| ---------------------- | ------------------------ | --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Install runners        | `--work`                 | `machines` / owner                            | `confirm` — names target, count, mode, computer       | `node.runner.install` (one per runner)      | `fleet_runners_install` — destructive       |
| Start / Stop / Restart | `--work`                 | `machines` / owner                            | `plain` start; `confirm` stop and restart             | `node.runner.start` · `node.runner.stop` · `node.runner.restart` (C §7) | `fleet_runners_action` — destructive |
| Remove runner          | `--work`                 | `machines` / owner                            | `confirm-destructive` — type the name                 | `node.runner.remove`                        | `fleet_runners_remove` — destructive        |
| Cancel workflow run    | — (platform → GitHub)    | `machines` / owner                            | `confirm` — "every job in it stops"                   | `node.runner.job.cancel` (C §7)             | `fleet_runners_cancel_run` — destructive (R-37) |
| List runners / jobs    | enrolled                 | `view`                                        | `plain`                                               | —                                           | `fleet_runners_list`, `fleet_runners_jobs` — readOnly |

Every caller satisfies a class with the same request fields (`confirm: true`, `confirmName`); a
call without them answers 409 `confirmation_required` with the summary to show (C §2.2). Every
runner action is in the `machines` family (C §2.1). Kill switch (R-24): every state-changing action
above is refused `kill_switch`; runners already running are left alone and the surfaces say so.

### 4.2 Installing (P1)

- **FR-1** A computer that advertises `actions-runner` **(C §1.2)** MUST offer **Install runners** on
  its page; one that does not MUST show the reason (no `--work`, no service manager, offline).
- **FR-2** The dialog MUST offer as targets only repositories and organisations covered by a GitHub
  App installation that belongs to the owner and is neither suspended nor deleted.
- **FR-3** The dialog MUST ask for count (1–16, default 1), names (default `<computer>-<n>`, editable,
  unique per computer), extra labels (GitHub adds `self-hosted`, the OS and the architecture), and
  the run mode: **Service** (default and only P1 mode; Windows: only mode ever), **Docker-isolated**
  (P3, Linux + `docker` only).
- **FR-4** At most **16** runners MAY exist per Node **(C §10)**; the seventeenth MUST be refused
  `limit_exceeded`.
- **FR-5** Pressing Install MUST return within 500 ms with the runner rows (`installing`) and an
  operation id, and MUST enqueue one durable `runner-install` job pinned to the computer **(C §12)**.
- **FR-6** The node MUST download the runner build GitHub publishes for its OS and architecture and
  MUST verify the published SHA-256 before extracting; a mismatch MUST delete the archive and fail
  with the file name in the hint.
- **FR-7** The registration token MUST be minted through the GitHub App installation token with the
  narrowest permission that works (repository: administration write; organisation: self-hosted
  runners write), MUST be minted only when the node reports it is ready to register, MUST travel to
  the node over the node link, and MUST be given to the runner through its environment-variable
  input — never as a command-line argument, never in a job payload, never in a log or audit row.
- **FR-8** The runner MUST be configured unattended with the chosen name and labels; "replace" MUST be
  used only when GitHub already lists that name for this computer.
- **FR-9** The runner MUST be installed as a service through the computer's service manager (FL-09):
  systemd on Linux (requires passwordless `sudo -n`, else refused `root_required` with the exact
  command), launchd on
  macOS, a Windows service on Windows; on Windows the runner's own service mode MUST be used and no
  other mode offered.
- **FR-10** The runner's folder MUST live under the node's data directory with owner-only
  permissions; on Windows the folder ACL MUST be restricted to the runner's account.
- **FR-11** Progress MUST be shown as an operation with phases `downloading · verifying · registering
  · installing service · starting · idle`, resumable after a link drop.
- **FR-12** A node that lacks `--work` MUST refuse `consent_missing`; a computer that is itself a
  virtual computer (FL-16) MAY host runners like any other.

### 4.3 Status and control (P1)

- **FR-13** Each runner MUST carry one of the stored states `installing · idle · working · offline ·
  removed · unknown` (CONTRACTS §4.11; `removed` rows are not listed), shown as **stopped (by you)**
  when it is `offline` after an owner stop and as **failed** when it is `installing` and its install
  job failed, with the source of that state (GitHub or the node) and the last check time; GitHub's
  view MUST win when both are fresh.
- **FR-14** Runner state MUST be refreshed from GitHub every **30 s** while a page showing it is open
  and every **5 minutes** otherwise, using conditional requests, and MUST back off to GitHub's reset
  time when rate-limited (U17).
- **FR-15** **Start**, **Stop** and **Restart** MUST act on the runner's service through a `runner-control`
  job and MUST reflect the new state within one check.
- **FR-16** **Remove runner…** MUST require the typed name, MUST deregister at GitHub (by a remove
  token or the runner's id), uninstall the service, delete the folder, and remove the row; it MUST
  be refused `busy` while the runner is working.
- **FR-17** A runner the node knows but GitHub does not (or the reverse) MUST be shown as `unknown`
  with the discrepancy named, never hidden.
- **FR-18** The runner's newest diagnostic log MUST be readable through the Logs tab as source
  `runner:<name>` (FL-08), with the same tail/filter/pause behaviour as any log.
- **FR-19** A `runner-stopped` "needs a look" item **(C §4.6)** MUST be raised when a runner the owner
  did not stop is offline or its service is down for **5 minutes** while its computer is online, with
  **Start**; it MUST clear when the runner is idle or working again.

### 4.4 Actions jobs (P2)

- **FR-20** The hub Overview MUST carry an **Actions jobs** panel listing queued and in-progress jobs
  that target self-hosted runners in the watched repositories and organisations, with repository,
  workflow/job name, run number, runner name or queue time, and the busy-runner count.
- **FR-21** Watched targets MUST default to every repository and organisation the owner has runners
  registered for and MUST be editable in the panel (add / remove a target the App covers).
- **FR-22** For a queued job the panel MUST say whether any of the owner's runners could take it,
  with one diagnosis from a closed set: _the only matching runner is offline_ · _no runner has the
  label <label>_ · _no runner is registered to <repository or organisation>_ · _all matching runners
  are busy_ (not a problem, shown as "waiting for <runner>").
- **FR-23** **Cancel workflow run…** MUST cancel the whole workflow run after a `confirm` dialog naming the run
  and repository, MUST write `node.runner.job.cancel`, and MUST be offered only to the `machines`
  audience.
- **FR-24** A `job-unassignable` "needs a look" item **(C §4.6)** MUST be raised when a queued job has
  had no eligible runner for **5 minutes**, carrying the diagnosis and **Cancel workflow run…**; it MUST clear
  when the job starts or is cancelled.
- **FR-25** Jobs MUST be polled every **30 s** while the hub is open and every **5 minutes**
  otherwise, with conditional requests and rate-limit back-off.
- **FR-26** Organisation-level operations MUST check the installation's permission first and, when
  missing, show the exact permission name and **Grant access**; the platform MUST never ask for a
  personal token or `gh` login.

### 4.5 Docker-isolated runners and versions (P3)

- **FR-27** On a Linux computer that advertises `docker`, the dialog MAY offer **Docker-isolated**:
  each runner runs in its own container with the runner folder mounted, restarted by Docker, with
  no access to the host's node credential or Docker socket unless the owner ticks an explicit
  _"share the Docker daemon (runs as root)"_ option that is labelled as such.
- **FR-28** The runner's version MUST be shown and an **Update available** note MUST appear when
  GitHub publishes a newer build; updating MUST be an owner action (reinstall), never automatic.

### 4.6 Agents, tools and audit

- **FR-29** `fleet_runners_list` and `fleet_runners_jobs` MUST be read-only; `fleet_runners_install`,
  `fleet_runners_action`, `fleet_runners_remove` and `fleet_runners_cancel_run` MUST be destructive
  with the classes in §4.1, gated as C §2.1 fixes — the Agent's tool grants and trust ladder (AW-15,
  AW-24) allow the tool **and** the computer's `machines` audience includes the Agent's owner.
- **FR-30** `fleet_runners_install`'s confirmation text MUST state target, count, mode, computer and
  "No credits are spent"; runners cost nothing in Ever Works and the dialog MUST say so.
- **FR-31** Every state-changing action MUST write one `fleet_audit` row with `family: machines`,
  the runner (or run) as target, `requestedBy`, `confirmationClass`, and `extra` with target,
  labels, mode and runner version — never a token.

---

## 5. UX

Copy is the exact user-visible string, keyed under `fleet.runners.*` (§5.7).

### 5.1 Install dialog

```
 Install Actions runners on build-01
 Register with   [ acme/api ▾ ]   (repositories and organisations your GitHub App covers)
 How many        [ 2 ]  (up to 16)          Names  [ build-01-1 ] [ build-01-2 ]
 Extra labels    [ gpu            ]  GitHub adds self-hosted, linux, x64.
 Run as          (•) Service — starts at boot, restarts on failure (systemd)
                 ( ) Docker-isolated — each runner in its own container        (P3)
 The runner is downloaded from GitHub and its checksum verified. Registration happens
 through your GitHub App; you never handle a token. Runners cost nothing in Ever Works.
                                                        [ Cancel ]  [ Install 2 runners ]
```

States: **loading** targets skeleton; **no target** _"Install the Ever Works GitHub App on a
repository or organisation first"_ `[Open GitHub App settings]`; **permission missing** (S7) with
**Grant access**; **sudo needed** _"Installing a service on build-01 needs passwordless sudo for the
node's user. Run this once on build-01:"_ + command + `[copy]`; **Windows not elevated** likewise;
**submitting** ≤ 500 ms.

### 5.2 Runners block (computer Overview) and row states

`● idle` · `◐ working · "<job>" run #<n>` · `○ offline · checked 09:41` · `■ stopped (by you)` ·
`◌ installing · verifying 2.3xx` · `✕ failed — <hint> [Retry]` · `? unknown — GitHub lists it,
build-01 does not`. Row actions: **Stop/Start**, **Restart**, **Logs**, **Open job on GitHub**,
**⋯ › Remove runner…**.

### 5.3 Confirmations

```
 Stop build-01-1?                               Remove build-01-1?
 It stops taking jobs until you start it.       Deregisters it from acme/api, uninstalls the
 A job in progress finishes first.              service and deletes its folder on build-01.
            [ Cancel ]  [ Stop ]                Type the name to confirm: [            ]
                                                             [ Cancel ]  [ Remove ]
 Cancel workflow run #4822 of acme/api?
 Every job in it stops. This cannot be undone.
            [ Cancel ]  [ Cancel workflow run ]
```

### 5.4 Actions jobs panel (hub Overview)

As in §0. Empty: _"No queued or running jobs on your runners · watching acme/api, acme/web
[Change]"_. Rate-limited: _"checked 09:41 · GitHub is rate-limiting; next check 09:52"_. Kill
switch: banner _"All computers are stopped — runners keep running; installing and cancelling are
paused."_

### 5.5 Needs a look

`● build-01-1 stopped · acme/api runner offline for 7 min  [Start]` ·
`● acme/api workflow #4822 — no runner can take "e2e · windows": needs label windows  [Cancel workflow run…] [View]`

### 5.6 Grant access

```
 Organisation runners need one more permission
 The Ever Works GitHub App on acme needs "Self-hosted runners: Read and write".
 Grant it on GitHub, then come back and press Check again.
                   [ Grant access ↗ ]  [ Check again ]  [ Use a repository instead ]
```

### 5.7 Keyboard, palette, i18n

Dialog and panel keyboard-operable; row actions in a menu reachable by `Enter`. Palette: **Install
Actions runners on <computer>**, **Actions jobs**. i18n groups: `fleet.runners.install`,
`fleet.runners.row`, `fleet.runners.actions`, `fleet.runners.remove`, `fleet.runners.jobs`,
`fleet.runners.diagnosis`, `fleet.runners.grantAccess`, `fleet.runners.needsALook`,
`fleet.errors.runner*`.

---

## 6. Non-functional requirements

- **Performance**: install/control requests ≤ 500 ms (p95); a runner idle on GitHub ≤ 2 min (p95)
  after Install on a machine with the archive cached, ≤ 5 min otherwise; panel refresh ≤ 30 s while
  open.
- **Reliability**: install is a durable job; registration tokens are minted at use and expire in an
  hour at GitHub; state reconciles from two sources and names disagreement rather than hiding it.
- **Security & privacy**: tokens never on argv, in payloads, logs or audit rows; installation tokens
  narrowed to the one permission needed and to the target repository; runner folders owner-only;
  no personal GitHub token is ever requested; no `gh` dependency (R-14).
- **Observability**: audit rows; operation progress; counters of installs by OS and outcome; a gauge
  of runners by state; the number of unassignable jobs.
- **Compatibility**: new job kinds, a new table and a new capability appended; nodes without the
  `actions-runner` tag are never sent runner jobs.

---

## 7. Key entities & concepts

| Concept                      | New?          | Description                                                                                                                                 |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Actions runner**           | **New** (`FleetActionsRunner`, C §4.11) | One registered self-hosted runner on a Node: target scope, name, labels, mode, state, GitHub runner id, last seen, installed at (C §4.11) plus the epic-local service unit, version, state source, last check and current job (plan §4.1) |
| **Target**                   | Read model     | A repository or organisation covered by one of the owner's GitHub App installations                                                        |
| **Watched targets**          | Plugin setting | The repositories/organisations whose jobs the panel shows (user scope)                                                                      |
| **Actions job**              | Read model     | A queued or in-progress GitHub Actions job targeting self-hosted runners, with its labels and assigned runner — GitHub's own noun, shown as-is; its "workflow run" is never called a Run (README §1) |
| **Diagnosis**                | Closed set     | offline-matching-runner · missing-label · wrong-scope · all-busy                                                                             |
| **Plugin `github-actions-runners`** | New (category `integration`, capability `actions-runners`) | Talks to GitHub through the App; mints tokens, lists runners/jobs, cancels runs — R-14 |
| **Job kinds**                | Existing union | `runner-install`, `runner-control` — durable (C §12)                                                                                        |
| **Log source `runner:<name>`** | Existing kind (FL-08) | The runner's newest diagnostic log                                                                                                   |
| **Needs a look**             | Existing kinds | `runner-stopped`, `job-unassignable` (C §4.6)                                                                                              |

---

## 8. Out of scope

- **Hosting runners for repositories the App is not installed on** — install the App first.
- **Personal access tokens or the `gh` CLI** — refused by design (R-14).
- **Automatic runner updates** — shown, not applied (FR-28).
- **Ephemeral (one-job) runners, runner groups, autoscaling** — later.
- **A dedicated Jobs route or hub tab** — the panel lives on the hub Overview (D1 fixes six tabs; CONTRACTS R-37).
- **Workflow authoring** — the build plugin's business.

## 8b. Open questions

- **Resolved** by CONTRACTS §4.11: `FleetActionsRunner` (table `fleet_actions_runners`, slot `1796180000000`) has the contract columns `nodeId, name, scope, target, labels, mode, state, githubRunnerId, lastSeenAt, installedAt`; the stored `state` uses only §4.11's values (FR-13). The epic-local columns in plan §4.1 are additive to that shape and are listed for the CONTRACTS maintainer in the audit report.
- **Resolved** by CONTRACTS §7: `node.runner.restart` and `node.runner.job.cancel` are contract audit names.
- **Resolved** by CONTRACTS §2.1: Actions runner install/control map to the `machines` family — every runner action in §4.1 is `machines`.
- **Resolved** by CONTRACTS R-37: the Actions jobs view is a hub Overview panel (`registerOverviewBlock`), not a seventh tab or route; the run-level act is worded "Cancel workflow run" and the tool is `fleet_runners_cancel_run`.
- **Resolved** by CONTRACTS §3.3 (`runner.*` on the `machine` channel) and §12 (runner jobs are durable): the registration token is minted at the node's `awaiting-token` phase and pushed over the link as `runner.token`; if the link is down the job waits at that phase and the token is sent on reconnect (U11).
- `[NEEDS CLARIFICATION: Should the Ever Works GitHub App manifest gain "Self-hosted runners" (organisation) and repository "Administration" now, accepting the re-authorisation prompt existing installations will see? Default until answered: the manifest is unchanged; repository runners use the permission when an installation already has it, and every missing permission shows the exact name with Grant access (S7, FR-26).]`

---

## 9. Acceptance criteria

**Installing (P1)**

- [ ] `ACC-FL18-01` (FR-1, FR-2, FR-3) Install runners appears only on computers advertising `actions-runner`, lists only the owner's live installations' targets, defaults count 1 and names `<computer>-<n>`, and offers Service only on Windows.
- [ ] `ACC-FL18-02` (FR-4, FR-5) The 17th runner is refused `limit_exceeded`; Install answers ≤ 500 ms with rows and an operation id.
- [ ] `ACC-FL18-03` (FR-6) A tampered archive fails verification, is deleted, and the hint names the file; nothing is extracted.
- [ ] `ACC-FL18-04` (FR-7) The token is minted after the node's ready signal with the narrowest permission, arrives over the link, is passed through the runner's environment input, and appears in no argv, payload, log or audit row.
- [ ] `ACC-FL18-05` (FR-8, FR-9, FR-10) The runner is configured unattended with name and labels, installed as a service per OS, with an owner-only folder; missing sudo/elevation refuses with the exact command.
- [ ] `ACC-FL18-06` (FR-11, FR-12) Progress passes through every phase and resumes after a link drop; a node without `--work` is refused `consent_missing`.

**Status and control (P1)**

- [ ] `ACC-FL18-07` (FR-13, FR-14, FR-17) Rows show state, source and last check; GitHub wins when fresh; discrepancies show `unknown` with the reason; polling is 30 s open / 5 min closed with back-off.
- [ ] `ACC-FL18-08` (FR-15, FR-16) Start/Stop/Restart change the service state within one check; Remove requires the typed name, deregisters, uninstalls, deletes and is refused `busy` while working.
- [ ] `ACC-FL18-09` (FR-18, FR-19) Logs open as `runner:<name>`; an unexpected stop raises `runner-stopped` after 5 min and clears on recovery; an owner stop raises nothing.

**Actions jobs (P2)**

- [ ] `ACC-FL18-10` (FR-20, FR-21, FR-25) The panel lists queued/running self-hosted jobs for watched targets with the busy count; targets default to registered ones and are editable; polling matches FR-25.
- [ ] `ACC-FL18-11` (FR-22, FR-24) Each queued job carries exactly one closed-set diagnosis; `job-unassignable` is raised after 5 min and clears on start or cancel.
- [ ] `ACC-FL18-12` (FR-23) Cancel workflow run confirms, cancels the whole run, audits, and is hidden outside the `machines` audience.
- [ ] `ACC-FL18-13` (FR-26) Organisation scope with a missing permission shows the exact permission and Grant access; no personal token is ever requested.

**P3**

- [ ] `ACC-FL18-14` (FR-27, FR-28) Docker-isolated runners are offered only with `docker` on Linux, never share the socket unless the labelled option is ticked; versions and Update available render.

**Agents, safety, audit**

- [ ] `ACC-FL18-15` (§4.1, FR-29, FR-30, FR-31) Tools carry the stated annotations; every action is refused `kill_switch` under the stop switch and `permission_denied` outside the audience; every action writes one audit row without a token.

**Cross-cutting**

- [ ] Every FR has a passing test (plan §14); every user-visible string is a `fleet.runners.*` key; the plugin is counted once in the canonical plugin document.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** GitHub is reached only through the `github-actions-runners` plugin; the node-side install is OS work in a node module (README D8).
- [x] **II — Capability-driven resolution.** The facade resolves `actions-runners`; no core file names the plugin id.
- [x] **III — Source-of-truth repos.** Nothing of the owner's repositories is stored beyond names and ids.
- [x] **IV — Job runtime.** Status/jobs polling off-page and the two "needs a look" producers run through the configured job-runtime provider via dispatcher symbols; install/control are durable node jobs.
- [x] **V — Forward-only migrations.** One additive migration, slot `1796180000000`.
- [x] **VI — Tests.** Named per package in plan §14.
- [x] **VII — Secrets.** Registration tokens never persisted or logged; installation tokens narrowed; redaction tested.
- [x] **VIII — Plugin counts.** Counted in the canonical plugin document only.
- [x] **IX — Behaviour-first.** No class or endpoint here.
- [x] **X — Backwards compatibility.** Appended job kinds and capability; a new table; optional view fields.

---

## 11. References

- Program: [README](../README.md) (§1 "Actions runner", D8, rule 18) · [CONTRACTS](../CONTRACTS.md) (R-14, R-23, R-24, §1, §2, §3.3 `runner.*`, §4.6, §7, §8, §9, §10, §11.2, §12, §13) · [CAPABILITY-MAP](../CAPABILITY-MAP.md) §E
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Sibling epics: FL-01 (hub Overview registry), FL-02 (link, operations), FL-03 (needs a look), FL-08 (log sources), FL-09 (services module), FL-15 (GitHub on the fleet), FL-16 (Docker hosts), FL-19 (tools)
- Substrate evidence: `packages/plugins/github/src/github-actions.service.ts:1-215`; `packages/plugins/github-actions-build/src/github-actions-build.plugin.ts:42`; `packages/agent/src/utils/github-app.utils.ts:79-130`; `apps/api/src/fleet/fleet-push-credential.service.ts:184-199`; `packages/agent/src/entities/github-app-installation.entity.ts:11-64`; `packages/agent/src/entities/fleet-node.entity.ts:96-115`; `packages/contracts/src/fleet/fleet-jobs.types.ts:117-125`; `apps/node/packaging/systemd/ever-works-node@.service`; `apps/node/packaging/README.md:8-14`
- Constitution: `.specify/memory/constitution.md`
