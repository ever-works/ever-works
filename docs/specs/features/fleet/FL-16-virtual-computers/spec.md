# FL-16 — Virtual computers: Windows VMs and Linux Containers on a host you own

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no code. Substrate citations (`path:Lnn`) appear only as evidence for "we do not
> have this today" claims (program rule 13). Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-16-virtual-computers`
**Program:** [Fleet](../README.md) · Wave 3 (creating machines)
**Branch:** `feat/fl-16-virtual-computers`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** L · **Blocked by:** FL-09 (Docker module, the **Runs here** Overview block), FL-02 (node link, `--manage`), FL-01 (hub nesting, module registry), FL-10 (P2 only — "open on the machine" for Watch the install) · **Related:** FL-03 (health), FL-07 (Desktop source), FL-17 (shares the `origin` column), FL-19 (tool parity), FL-20 (usage)
**Extends (existing Ever Works nouns):** Node · Fleet · Job · Enrolment token · Agent · Run · Fleet audit · Organization · Operation (FL-02)

---

## 0. TL;DR

A computer the owner already has in the Fleet — a Linux box with Docker — can **create more
computers on itself**: a **Windows VM** (Windows 11, Windows 10, Windows Server) installed by a
KVM-backed installer image, or a **Linux Container** (Ubuntu, Debian, Fedora, Alpine, Arch) that is
ready in about a minute. Each new machine runs `ever-works-node` inside and enrols itself with a
one-time token minted for it, so it appears in the Fleet as an ordinary Node — nested under its host,
leasable, watchable, manageable — with nothing else to install and no credential ever leaving the
host. Start, stop and destroy are one click each; destroy is typed-name confirmed and irreversible.
Only the KVM-backed Windows machines are called VMs; the Linux ones are Containers, because they
share the host's kernel and have no init system of their own.

```
 FLEET HUB › Computers                                      [+ Add computer ▾]
                                                            │ Enrol a computer…
                                                            │ New virtual computer…   ◀ this epic
                                                            │ New cloud computer…     (FL-17)
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ build-01   ● online  Linux    1 session   cpu 31% mem 58% disk 40%  Runs: 2 here  │
 │   └ win-11-vm     ■ stopped   VM on build-01 · Windows 11 · 4 CPU · 8 GB · 64 GB  │
 │   └ ubuntu-nina   ● online    Container on build-01 · Ubuntu 26.04 · 2 CPU · 4 GB │
 │ design-mac ● online  macOS    desktop                                              │
 └──────────────────────────────────────────────────────────────────────────────────┘

 NEW VIRTUAL COMPUTER
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ Name        [ ubuntu-nina                 ]                                      │
 │ System      ( ) Windows 11   ( ) Windows 10   ( ) Windows Server 2025           │
 │             (•) Ubuntu 26.04 ( ) Debian 13   ( ) Fedora  ( ) Alpine  ( ) Arch   │
 │ Host        [ build-01 — 23 GB free memory, 118 GB free disk, KVM ▾ ]            │
 │ CPUs        ( ) 2  (•) 4  ( ) 8        Memory  ( ) 4 GB (•) 8 GB ( ) 16 GB        │
 │                                                                                  │
 │ A Container shares build-01's kernel and has no systemd. It uses build-01's CPU, │
 │ memory and disk; nothing is billed and no credits are spent. Ready in about a    │
 │ minute. It will enrol itself as its own computer.                                │
 │                                            [ Cancel ]   [ Create container ]     │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

Three phases, each independently shippable:

| Phase  | Ships                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Linux **Containers**: the create dialog, host choice, the child enrolling itself, nesting in the hub, start / stop / destroy, "Runs here" on the host, limits, consents, audit, Agent tools                      |
| **P2** | Windows **VMs**: the `kvm` requirement, the 15–30 minute install as an operation with progress, "watch the install", the generated password kept on the host with a one-time audited reveal, 2-minute stop grace |
| **P3** | Resize a stopped machine (CPUs / memory), refresh the system catalogue, rebuild a Container from a newer image, CLI parity hand-off to FL-19                                                                     |

---

## 1. Overview

From the Fleet hub (or from a host's own page) the owner picks **New virtual computer…**, names it,
chooses a system, a host and a size, and presses Create. The platform creates the new Node's
registration first — in the `enrolling` state, nested under the host — and asks the host to build
the machine. For a Container the host pulls a pinned base image, starts it with the chosen CPU and
memory limits, installs the node runtime inside and — once the runtime inside reports it is ready —
hands it a one-time enrolment token minted at that moment (CONTRACTS R-35); about a minute later
the child heartbeats and turns green under its host. For a Windows VM the host checks
it can virtualise (`kvm`), has roughly 30 GB free, pulls the installer image and lets Windows install
itself over 15–30 minutes while the owner watches progress — and, if they like, the installer's
screen — from the hub. When Windows reaches its first desktop, a first-boot step installs the node
runtime, enrols with a token minted at that moment, and registers the runtime to start at boot.

Everything the Fleet already knows how to do then applies to the child unchanged: it leases work,
hosts sessions, shows its logs and services, can be watched, and is covered by the kill switch. Its
row carries who hosts it (`hostNodeId`) and what it is (`virtualKind`: `vm` or `container`); its
`kind` stays `node` (CONTRACTS R-4). Stopping a Windows VM asks Windows to shut down and gives it
two minutes; stopping a Container stops it at once. Destroying either removes the machine and its
disk under the host node's data directory and then its Fleet registration; the owner must type the
machine's name. Four virtual computers per host; no machine may host another; a Windows host cannot
host anything.

Nothing is removed or renamed. Enrolling a real machine by token works exactly as today; a virtual
computer is a second way for a Node row to come into being (CONTRACTS R-20).

---

## 2. Why now

### 2.1 The user's question

> _"Spin up a clean Windows for this one job — I don't want the agent on my own desktop."_

> _"Give Nina her own Ubuntu box on the build server so her worktrees don't fill mine."_

### 2.2 What they do today, and what breaks

| To get…                            | Today they must…                                                                                                                     | What breaks                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second machine in the Fleet      | Find or buy hardware, install the OS, install the node runtime, open Settings → Fleet → Add node, copy a token, run `enroll` by hand | The Add-node flow issues a token and waits for a human to run a command on a machine that already exists (`apps/web/src/components/settings/FleetSettings.tsx:826-891`; `packages/agent/src/fleet/fleet.service.ts:349-394`). There is no way to _make_ the machine. |
| A clean Windows for a Windows task | Keep a spare Windows PC, or run the agent on the owner's own desktop                                                                 | Nothing in the Fleet can create or control a VM: the only job kinds are `acceptance-checks`, `agent-task`, `browser-check`, `computer-session` (`packages/contracts/src/fleet/fleet-jobs.types.ts:117-125`).                                                         |
| A throwaway Linux box per Agent    | Share one machine's worktree pool between every Agent                                                                                | A Node has no parent and no notion of being virtual: `kind` is `desktop-node · node · k8s` and the entity has no host column (`packages/contracts/src/fleet/fleet-node.types.ts:46-55`; `packages/agent/src/entities/fleet-node.entity.ts:96-115`).                  |
| To know whether a host can do it   | Guess                                                                                                                                | The node detects `docker` by probing for the binary but never checks `/dev/kvm` or free memory for this purpose (`apps/node/src/core/capabilities.ts:277-294`).                                                                                                      |
| To watch an install                | Nothing                                                                                                                              | The screen channel shows an Agent's browser or (FL-07) a desktop; nothing surfaces an installer's console.                                                                                                                                                           |

Two existing mechanics make this cheap: executors are registered per job kind and only when the
machine can honour them (`apps/node/src/core/runtime.ts:940-953`), and a consent-specific lease
lane already exists for `--attend` (`apps/node/src/core/runtime.ts:1049-1062`) — the pattern a
`--manage` lane for machine-creation jobs follows. The one-time enrolment token has a 15-minute life
(`packages/agent/src/fleet/fleet.service.ts:79,377`), which is why a Windows install must mint its
token _when the guest is ready_, not when the owner presses Create (FR-24).

### 2.3 Why this epic is additive only

`FleetNode` stays the entity; `kind` is untouched (R-4). New columns (`origin`, `hostNodeId`,
`virtualKind`) default to today's meaning for every existing row. New job kinds join the closed
union without changing the lease protocol. The Add-node flow, the drawer and the enrolment hand-off
keep working; this epic adds a menu item beside them.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — Create a Container (owner).**
  **Given** `build-01` is online, started with `--manage`, advertises `docker`, and hosts fewer than
  four virtual computers, **when** the owner chooses **New virtual computer…**, names it
  `ubuntu-nina`, picks Ubuntu 26.04, `build-01`, 4 CPUs and 8 GB, and presses **Create container**,
  **then** within 500 ms a nested row `ubuntu-nina · creating · Container on build-01` appears under
  `build-01`, a progress line advances through _pulling image → starting → installing the node
  runtime → enrolling_, and within about a minute the row reads `● online`; an audit row
  `node.vm.create` names the owner, the host and the child.

- **S2 — Create a Windows VM (owner, P2).**
  **Given** `build-01` additionally advertises `kvm` and has ≥ 30 GB free, **when** the owner picks
  Windows 11, 4 CPUs, 8 GB, 64 GB disk and presses **Create VM**, **then** the nested row reads
  `installing` with a progress line and an estimate (_"15–30 minutes; about 6 GB to download"_),
  **Watch the install** opens the installer's screen through the host, and when Windows finishes its
  first boot the row turns `● online` with `VM on build-01 · Windows 11 · not activated`.

- **S3 — Host chosen for you.**
  **Given** three hosts can create Containers, **when** the owner leaves **Host** on _Choose for me_,
  **then** the host with the most free memory is picked and named in the dialog before Create is
  pressed, so the choice is visible, never silent.

- **S4 — Start and stop.**
  **Given** `win-11-vm` is stopped, **when** the owner presses **Start**, **then** the row reads
  `starting` until the child heartbeats, then `● online`; **when** they press **Stop**, **then**
  Windows is asked to shut down, the row reads `stopping — Windows has up to 2 minutes`, and it
  reads `■ stopped` when the machine is off. A Container stops within 10 seconds.

- **S5 — Destroy.**
  **Given** `ubuntu-nina` exists, **when** the owner presses **Destroy…**, types `ubuntu-nina` and
  confirms, **then** the machine and its disk under `build-01`'s node data directory are deleted,
  the Fleet registration disappears, its job history stays, and an audit row `node.vm.destroy` is
  written. Nothing on the host outside that data directory is touched.

- **S6 — Runs here.**
  **Given** `build-01` hosts two virtual computers, **when** the owner opens `build-01`'s Overview,
  **then** the **Runs here** block (FL-09 FR-30 — this epic adds rows to it, not a second block)
  lists them beside the host's containers with their state and one-click Start/Stop, and the host's
  free-memory figure is shown net of what they reserve.

- **S7 — Copy the Windows password (owner, P2).**
  **Given** `win-11-vm` is online, **when** the owner opens **⋯ › Copy password**, **then** a dialog
  explains the password was generated on `build-01` and is kept only there, a single **Reveal once**
  reveals it for 60 seconds with a copy button, and an audit row `node.vm.password.reveal` is written
  naming who and when.

- **S8 — An Organization member.**
  **Given** `build-01`'s control policy grants `machines` to `org-admins`, **when** an Organization
  admin opens the hub, **then** they can create, start, stop and destroy virtual computers on it;
  **when** an Organization member who is not an admin opens it, **then** the menu item is present
  but disabled with _"Only the owner of build-01 can create computers on it"_, and the same request
  made directly is refused `permission_denied`.

- **S9 — An Agent creates its own box.**
  **Given** Agent `Nina`'s tool grants allow `fleet_virtual_create`, her trust ladder puts _Change a
  computer_ (`machine.admin`) at **Ask**, and the host's `machines` audience includes her owner
  (CONTRACTS §2.1), **when** she calls `fleet_virtual_create` with `system: ubuntu-26.04`, `cpus: 2`,
  `memoryGiB: 4`, **then** the call is held as an `agent_action_proposals` row (CONTRACTS R-33) and
  returns `{ held: true, decisionId }`; the Decision states _"Creates a Container on build-01 using
  2 CPUs, 4 GB of memory and about 3 GB of disk. No credits are spent."_; once approved, the child is
  created with `requestedBy: agent:<id>` in the audit row. At **Auto** the same call answers 409
  `confirmation_required` with that summary until it is repeated with `confirm: true` (CONTRACTS
  §2.2).

### 3.2 Edge cases, refusals and failures

- **U1 — Host offline.** The host is not heartbeating → the dialog lists it greyed with _"offline —
  last seen 2 h ago"_, and a direct request is refused `unreachable` with the hint _"build-01 last
  heartbeated 2 h ago; wake it from build-02?"_ (FL-03).
- **U2 — Consent missing.** The host runs without `--manage` → the host row says _"Management is
  off — start the node with --manage on build-01"_ and a direct request is refused
  `consent_missing` with that command as its hint.
- **U3 — No Docker / no KVM.** No `docker` tag → _"Docker was not found on build-01"_. Windows
  chosen on a host without `kvm` → refused `unsupported_on_node`, hint _"Windows VMs need /dev/kvm
  on a Linux x86-64 host; Containers are available on build-01"_.
- **U4 — Windows host.** A Windows Node is listed in the Host picker as _"cannot host virtual
  computers"_ and a direct request is refused `unsupported_on_node`.
- **U5 — Nesting.** A virtual computer is never offered as a host; a direct request naming one is
  refused `unsupported_on_node` with the hint _"win-11-vm is itself a VM on build-01; create on
  build-01 instead"_.
- **U6 — Limit.** The host already has four → the menu item on that host reads _"build-01 already
  hosts 4 virtual computers"_ and a direct request is refused `limit_exceeded`.
- **U7 — Not enough disk.** Windows chosen with < 30 GB free → refused before any download with
  _"Windows needs about 30 GB free on build-01; 12 GB is free"_.
- **U8 — Image pull fails.** The host cannot pull the base or installer image → the operation fails
  `operation_failed` with the first stderr line as hint, the child row is marked `failed` with
  **Retry** and **Remove**, and nothing half-built is left running.
- **U9 — Link drops mid-create.** The platform loses the host's link while a Container builds →
  the build continues on the host (it is a durable job), progress resumes when the link returns, and
  the child still enrols on its own because enrolment is outbound from the child.
- **U10 — Guest never enrols.** A Windows install finishes but no heartbeat arrives within 20
  minutes of the first-boot step → the row reads `installed but not enrolled`, with **Watch the
  screen**, **Retry enrolment** (re-mints the token) and **Destroy**. This is a row state, not a
  "needs a look" item (CONTRACTS §4.6 has no kind for it; R-23 does not list FL-16 as a producer).
- **U11 — Kill switch.** The Fleet kill switch is on → **New virtual computer…** is disabled with
  the stop banner's reason; create, start, stop, destroy and reveal requests are refused
  `kill_switch`; running children keep running (they are Nodes, and their links are paused like
  every node's — `link.pause`, CONTRACTS §3.2); nothing is destroyed by the switch.
- **U12 — Permission denied.** Covered by S8; the server refuses with the audience named.
- **U13 — Destroy while a Run is live.** A child is executing a Run → **Destroy…** is refused
  `busy` with _"Nina is working on ubuntu-nina right now; end the session or wait"_, never a silent
  kill.
- **U14 — Host removed from the Fleet.** The owner tries to remove `build-01`'s registration while it
  hosts children → refused `busy` with _"destroy or remove its 2 virtual computers first"_.
- **U15 — Name taken.** The name matches another Node of the owner → `invalid` with the field named;
  names are 2–39 characters, lower-case letters, digits and hyphens.
- **U16 — Password reveal by a non-owner.** An Organization admin asks to reveal the Windows
  password → refused `permission_denied` (_"only build-01's owner can reveal it"_), even when the
  `machines` audience includes admins (the default until the owner answers §8b).

---

## 4. Functional requirements

Every default and limit below is a number. Values marked **(C)** come from
[CONTRACTS.md](../CONTRACTS.md) and are not re-derived here.

### 4.1 Action families (program rule 12)

| Family action         | Consent on host (C §1.1) | Permission family / default audience (C §2.1) | Confirmation (C §2.2)                       | Audit (C §7)                                | Agent tool (C §11.3)                                     |
| --------------------- | ------------------------ | --------------------------------------------- | ------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Create                | `--manage`               | `machines` / owner                            | `confirm` — states CPUs, memory, disk, host | `node.vm.create`                            | `fleet_virtual_create` — destructive                     |
| Start / Stop          | `--manage`               | `machines` / owner                            | `plain` start; `confirm` stop               | `node.vm.start` · `node.vm.stop`            | `fleet_virtual_power` — destructive                      |
| Destroy               | `--manage`               | `machines` / owner                            | `confirm-destructive` — type the name       | `node.vm.destroy`                           | `fleet_virtual_destroy` — destructive                    |
| Reveal password       | `--manage`               | owner only (default; §8b)                     | `confirm` — "reveal once, audited"          | `node.vm.password.reveal` (C §7)            | not offered to Agents                                    |
| Resize / Rebuild (P3) | `--manage`               | `machines` / owner                            | `confirm`                                   | `node.vm.resize` · `node.vm.rebuild` (C §7) | not offered to Agents in this epic                       |
| List / options        | enrolled                 | `view`                                        | `plain`                                     | —                                           | `fleet_virtual_list`, `fleet_virtual_options` — readOnly |

Every caller — the web dialog, Agent tools, MCP and the CLI — satisfies a class with the same
request fields (`confirm: true`, `confirmName`), and a call without them answers 409
`confirmation_required` with the summary to show (C §2.2). Kill switch (R-24): every family above is
refused `kill_switch` while the switch is on; no running child is stopped or destroyed by the
switch itself. "Drain all" leaves virtual computers as they are.

### 4.2 Creating (P1 Containers, P2 VMs)

- **FR-1** The hub's **Add computer** menu and every host's page MUST offer **New virtual computer…**
  when at least one Node the viewer may use can host; otherwise the item MUST be present and disabled
  with the reason.
- **FR-2** The dialog MUST ask for: name, system, host, CPUs (2 / 4 / 8, default 4) and memory
  (4 / 8 / 16 GB, default 8); for Windows systems it MUST also ask for disk (64 / 128 / 256 GB,
  default 64); Containers MUST NOT show a disk field.
- **FR-3** The system list MUST be: Windows 11, Windows 10, Windows Server 2025, Windows Server 2022
  (VMs); Ubuntu 26.04, Ubuntu 24.04, Debian 13, Fedora, Alpine, Arch Linux (Containers); the dialog
  MUST label the two groups **VM** and **Container** and MUST never call a Container a VM.
- **FR-4** The host picker MUST list every Node the viewer may use with its free memory and free
  disk, MUST grey out hosts that cannot serve the chosen system and say why (offline, management
  off, no Docker, no KVM, Windows host, is itself virtual, 4 of 4), and MUST default to **Choose for
  me**, which picks the eligible host with the most free memory and names it before Create.
- **FR-5** A Windows VM MUST be offered only on a Linux x86-64 host that advertises `docker`, `kvm`
  and `managed`; a Container MUST be offered on any Linux or macOS host that advertises `docker`
  and `managed`; a Windows host MUST never be offered.
- **FR-6** Arch Linux MUST be offered only on x86-64 hosts; every other Container system MUST be
  offered on x86-64 and arm64 hosts.
- **FR-7** Pressing Create MUST return within 500 ms with the child's Node id and an operation id,
  and MUST create the child's registration (`origin: virtual`, `hostNodeId`, `virtualKind`, state
  `enrolling`) before anything runs on the host.
- **FR-8** The child's name MUST be unique among the owner's Nodes and MUST match
  `^[a-z0-9][a-z0-9-]{1,38}$`.
- **FR-9** At most **4** virtual computers MAY exist per host **(C §10)**, counting `enrolling` and
  `failed` rows; the fifth MUST be refused `limit_exceeded`.
- **FR-10** A virtual computer MUST NOT be offered or accepted as a host (`unsupported_on_node`).
- **FR-11** A Container MUST reach `online` within **120 s** at the 95th percentile when the host
  already has the base image, and within **5 minutes** otherwise; the dialog MUST state "about a
  minute".
- **FR-12** The dialog MUST state, before Create, that the machine uses the host's CPU, memory and
  disk, that nothing is billed and no credits are spent, and — for Windows — the approximate download
  (6 GB) and install time (15–30 minutes).
- **FR-13** Progress MUST be shown as an operation with named phases (`pulling image · starting ·
installing the node runtime · enrolling · online` for Containers; `pulling image · downloading
Windows · installing · first boot · installing the node runtime · enrolling · online` for VMs),
  updated at least every 5 seconds while the link is up, and resumable after a link drop.
- **FR-14** The child MUST enrol by itself, outbound, with a one-time token minted for it only when
  the guest signals it is ready to enrol (both kinds — CONTRACTS R-35); the token MUST be handed to
  the guest through a private file read by `enroll --token-file`, never on a command line and never
  in a job payload, and MUST be deleted after use.
- **FR-15** The child MUST run the node runtime with `--work --manage` by default and MUST NOT run
  with `--attend` unless the owner enables it later; the hub MUST show the child's consents like any
  Node's.
- **FR-16** The child MUST be bound to the same Organization as its host at creation.
- **FR-17** The child's heartbeat MUST carry `hostNodeId`-independent facts exactly as any Node's;
  the platform MUST NOT special-case a virtual Node anywhere except nesting, hosting rules and
  the power/destroy actions.

### 4.3 Windows VMs (P2)

- **FR-18** Before pulling anything, the host MUST verify `/dev/kvm` is usable by the node's user,
  at least **30 GB** is free under the node data directory, and the host is x86-64 Linux; a failed
  check MUST refuse with the specific shortfall.
- **FR-19** The installer image MUST be pinned by digest in the node's system catalogue and MUST be
  operator-overridable; the catalogue MUST name the Windows edition each system id maps to.
- **FR-20** The guest's local account password MUST be generated on the host (24 characters), MUST
  be stored only in the host node's OS keychain (or its documented file fallback), MUST never be
  written to a job payload, log, audit row or platform table, and MUST be set inside the guest by
  the first-boot step.
- **FR-21** **Copy password** MUST be owner-only, MUST reveal once per request for 60 seconds, MUST
  write an audit row naming the actor and the child, and MUST transport the value from the host to
  the owner's browser over the node link and the owner's authenticated connection only.
- **FR-22** The VM MUST be reported `not activated` until the owner adds a product key inside
  Windows; the hub MUST state that activation is the owner's responsibility and that Ever Works
  ships no key.
- **FR-23** **Watch the install** MUST open the installer's screen through the host (the installer's
  local web viewer, bound to the host's loopback only, opened via FL-10's "open on the machine"), and
  MUST never expose that viewer beyond the host.
- **FR-24** The guest's enrolment token MUST be minted only when the guest signals it is ready to
  enrol, so the token's 15-minute life is never spent on the Windows install itself; a token that
  expires anyway MUST be re-issued by **Retry enrolment** without rebuilding the VM.
- **FR-25** The first-boot step MUST install the node runtime, enrol, and register the runtime to
  start at boot as the generated local account, using the node's existing Windows service
  installation path; it MUST NOT run the runtime as a built-in system account.

### 4.4 Power and destroy (P1)

- **FR-26** **Start** MUST return within 500 ms with an operation id; the row MUST read `starting`
  until the child's first heartbeat, then `online`.
- **FR-27** **Stop** on a Windows VM MUST request an orderly shutdown and wait up to **120 s** before
  forcing power-off; **Stop** on a Container MUST complete within **10 s**; the row MUST show which
  of the two is happening.
- **FR-28** **Destroy** MUST require typing the machine's name, MUST state that the disk under the
  host's node data directory is deleted and that this cannot be undone, MUST refuse `busy` while a
  Run or an owner Session is live on the child, MUST remove the machine, its disk and then its Fleet
  registration, and MUST keep the child's job history.
- **FR-29** Removing a host's registration while it hosts virtual computers MUST be refused `busy`
  naming them; removing a virtual child's registration without destroying it MUST be refused
  `unsupported_on_node` with the hint _"destroy it instead"_ (an orphaned machine would keep running
  on the host) — the same additive guard CONTRACTS R-36 sets for cloud computers; Remove becomes
  available again once the child's machine is gone (FR-30).
- **FR-30** A child whose machine is gone on the host (destroyed outside Ever Works) MUST be shown
  `offline — its container is gone on build-01` within one reconcile cycle (5 minutes) and MAY then
  be removed.

### 4.5 Hub, host page and child page

- **FR-31** Virtual computers MUST be nested under their host in the hub's Computers tab (FL-01
  nests by `hostNodeId`), with a `VM on <host>` or `Container on <host>` label, their system and
  size, and their state.
- **FR-32** The host's **Runs here** Overview block (owned by FL-09, FR-30 there) MUST list each
  child with state and Start/Stop, and MUST show the host's free memory net of reservations; this
  epic adds those rows and that line to FL-09's block and defines no second block.
- **FR-33** The child's page header MUST carry Start / Stop / **⋯** (Copy password for VMs,
  Destroy…), and its Overview MUST name its host with a link.
- **FR-34** The command palette MUST offer **New virtual computer** and, per child, **Start <name>**
  / **Stop <name>**.

### 4.6 Agents, tools and limits

- **FR-35** `fleet_virtual_list` and `fleet_virtual_options` MUST be read-only tools; `fleet_virtual_create`,
  `fleet_virtual_power` and `fleet_virtual_destroy` MUST be marked destructive with the confirmation
  class from §4.1, MUST be gated as C §2.1 fixes — the Agent's tool grants and trust ladder (AW-15,
  AW-24) allow the tool **and** the host's `machines` audience includes the Agent's owner — and MUST
  return CONTRACTS §8 errors with hints.
- **FR-36** `fleet_virtual_create` MUST include in its confirmation text the host, CPUs, memory,
  approximate disk and the sentence "No credits are spent".
- **FR-37** Every state-changing action MUST write one `fleet_audit` row with `family: machines`,
  the child as `target`, `requestedBy` and `confirmationClass` (C §2.3).

### 4.7 Resize and rebuild (P3)

- **FR-38** A stopped virtual computer MAY have its CPUs and memory changed within the same choices
  as creation; the change MUST be refused `busy` while it runs.
- **FR-39** A Container MAY be rebuilt from the current catalogue image; rebuild MUST keep the
  child's registration and its home directory and MUST be `confirm`-class.

---

## 5. UX

All copy is the exact user-visible string, keyed under `fleet.virtual.*` (§5.9).

### 5.1 Hub — nested rows and the menu

```
 ┌ build-01   ● online  Linux · 2 virtual computers ──────────────── Runs here: 2 ─┐
 │   └ win-11-vm    ■ stopped    VM on build-01 · Windows 11 · 4 CPU · 8 GB · 64 GB │
 │   └ ubuntu-nina  ● online     Container on build-01 · Ubuntu 26.04 · 2 CPU · 4 GB│
 │   └ fedora-ops   ◌ creating   Container on build-01 · installing the node runtime│
 └──────────────────────────────────────────────────────────────────────────────────┘
 [+ Add computer ▾]  › Enrol a computer…  › New virtual computer…  › New cloud computer…
```

Disabled item tooltips: _"No computer in your fleet can host virtual computers yet — a Linux or
macOS computer with Docker, started with --manage"_ · _"All computers are stopped — "<reason>""_.

### 5.2 The create dialog — states

- **Loading**: host list skeleton; system radios enabled; Create disabled.
- **Ready**: as in §0; host line shows `free memory · free disk · KVM` or a greyed reason.
- **Windows chosen**: disk field appears; the note reads _"Windows downloads about 6 GB and installs
  itself in 15–30 minutes. It stays unactivated until you add a product key inside Windows. The
  account password is generated on build-01 and kept only there."_
- **Submitting**: Create disabled with a spinner for ≤ 500 ms, then the dialog closes and the nested
  row appears.
- **Error**: inline, from the error hint (_"Windows needs about 30 GB free on build-01; 12 GB is
  free"_).

### 5.3 Progress (the nested row and the child's page)

```
 fedora-ops   ◌ creating   Container on build-01
 ├──────────────────●──────────────┤  installing the node runtime · 00:41
 pulling image ✓  starting ✓  installing the node runtime …  enrolling  online
```

Windows adds _"downloading Windows (2.1 of 6 GB)"_ and _"installing — 12 min so far · [Watch the
install]"_. On failure: `✕ failed — could not pull the image: <first stderr line>` with **Retry**
and **Remove**.

### 5.4 Runs here (rows added to FL-09's host Overview block)

```
 Runs here           ● acme-api  ● acme-db (containers, FL-09)
                     win-11-vm  ■ stopped  [Start]      ubuntu-nina  ● online  [Stop]
 Free memory         23 GB (12 GB reserved by virtual computers)
```

### 5.5 Child header and menu

`← Fleet  ubuntu-nina  ● online · Container on build-01 · Ubuntu 26.04 · 2 CPU · 4 GB   [Stop] [⋯]`
`⋯` → **Copy password** (VMs only) · **Resize…** (P3, stopped only) · **Rebuild…** (Containers,
P3) · **Destroy…**.

### 5.6 Stop and destroy dialogs

```
 Stop win-11-vm?                              Destroy ubuntu-nina?
 Windows is asked to shut down and gets       Deletes the container and its disk under
 up to 2 minutes. Sessions on it end.         build-01's node data folder. This cannot
            [ Cancel ]  [ Stop ]              be undone. Job history is kept.
                                              Type the name to confirm: [            ]
                                                         [ Cancel ]  [ Destroy ]
```

### 5.7 Copy password (VMs)

```
 Password for win-11-vm
 Generated on build-01 when the VM was created and kept only there.
 Revealing it is recorded in the audit log.
                                   [ Cancel ]  [ Reveal once ]
 → ••••••••••••••••••••••••  [Copy]   hides in 0:59
```

### 5.8 Unavailable states (every surface says why)

_"Management is off — start the node with --manage on build-01"_ · _"Docker was not found on
build-01"_ · _"Windows VMs need /dev/kvm on a Linux x86-64 host"_ · _"build-01 is offline — last
seen 2 h ago"_ · _"win-11-vm cannot host — it is itself a VM"_ · _"Not available on this kind of
node yet"_ (desktop-node, R-10).

### 5.9 Keyboard, palette, i18n

Dialog is fully keyboard-operable; `Enter` on a system radio moves to Host. Palette: **New
virtual computer**, **Start <name>**, **Stop <name>**. i18n groups: `fleet.virtual.menu`,
`fleet.virtual.create` (fields, systems, notes), `fleet.virtual.progress` (phases), `fleet.virtual.row`,
`fleet.virtual.runsHere`, `fleet.virtual.power`, `fleet.virtual.destroy`, `fleet.virtual.password`,
`fleet.virtual.resize`, `fleet.virtual.rebuild`, `fleet.errors.virtual*` (hints). Leaf keys camelCase,
no literal dots.

---

## 6. Non-functional requirements

- **Performance**: create/start/stop/destroy requests answer in ≤ 500 ms (p95); Container online
  ≤ 120 s (p95, image cached); progress events ≤ 5 s apart over a live link.
- **Reliability**: creation is a durable node job — it survives a link drop and a platform restart;
  a host restart mid-install resumes the operation or marks it `failed` with Retry; no half-built
  machine is left running after a failure.
- **Security & privacy**: the host executes only the catalogue's digest-pinned images; the guest
  password never leaves the host except through the audited one-time reveal; enrolment tokens travel
  by private file; Docker is never given the host's node credential or socket inside a child; a
  child can never see the host's config directory. Threats and refusals are in plan §11.
- **Observability**: audit rows for every action; operation progress; a counter of creations by kind
  and outcome; durations of create and first-heartbeat.
- **Compatibility**: contracts are additive (new union members, optional fields); older nodes ignore
  the new job kinds and never advertise `kvm`; the platform never routes `vm-*` jobs to a node that
  does not advertise the tags they require.

---

## 7. Key entities & concepts

| Concept              | New?             | Description (shapes in CONTRACTS)                                                                                                  |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Node** (Computer)  | Existing         | Gains `origin` (`enrolled · virtual · cloud`), `hostNodeId` and `virtualKind` (`vm · container`) — C §4.1. `kind` unchanged (R-4). |
| **Host**             | Role, not a noun | A Node that hosts virtual computers; must advertise `docker` + `managed` (+ `kvm` for VMs).                                        |
| **Virtual computer** | UI copy          | A child Node with `origin: virtual`; **VM** when `virtualKind = vm`, **Container** when `container`.                               |
| **System catalogue** | New (node-side)  | The pinned images and Windows editions a host can build, advertised through the options endpoint.                                  |
| **Operation**        | Existing (FL-02) | Progress of a create / power / destroy; polled or streamed.                                                                        |
| **Job kinds**        | Existing union   | `vm-create`, `vm-control` — durable (C §12), leased by the host's management lane under `--manage` (C R-34).                       |
| **Enrolment token**  | Existing         | Minted for the child when the guest signals readiness, both kinds (C R-35; FR-14, FR-24).                                          |
| **Fleet audit**      | Existing         | `node.vm.create\|start\|stop\|destroy\|resize\|rebuild` and `node.vm.password.reveal` (C §7).                                      |

---

## 8. Out of scope

- **Nesting** (a VM inside a VM, a Container inside a Container) — refused, not deferred.
- **Windows or macOS as a VM host** — Containers on macOS are in; Windows VMs need Linux + KVM.
- **macOS guests, custom ISOs, GPU pass-through, snapshots, live migration between hosts.**
- **Windows activation** — the owner adds a key inside Windows; Ever Works ships none.
- **Docker-isolated Checkouts** (FL-14) and Docker-isolated Actions runners (FL-18 P3) — different
  things, same host facility.
- **A second Fleet entity for virtual machines** — a child is a Node (README §1).
- **Exposing the installer's web viewer beyond the host** — only "open on the machine" (R-3).

## 8b. Open questions

- **Resolved** by CONTRACTS §7: `node.vm.password.reveal`, `node.vm.resize` and `node.vm.rebuild` are contract audit names (§4.1 above uses them).
- **Resolved** by CONTRACTS R-35: FL-16's slot `1796160000000` adds `origin`, `hostNodeId` and `virtualKind`; FL-17's slot adds the provider columns; both migrations guard every column with `findColumnByName` so either may land first.
- **Resolved** by CONTRACTS R-34: a management lane, modelled on the attended lane, leases `vm-create` / `vm-control` on nodes started with `--manage` and never competes with Agent work for `--concurrency`.
- **Resolved** by CONTRACTS R-36 (by analogy, for the same UI action): a virtual child's registration cannot be removed while its machine exists — refused `unsupported_on_node`, hint "destroy it instead" (FR-29).
- `[NEEDS CLARIFICATION: Password reveal audience — owner only, or everyone in the host's machines audience? Default until answered: owner only, even when the machines audience includes Organization admins (U16, FR-21).]`
- `[NEEDS CLARIFICATION: Should Windows VMs start with --attend so "watch the desktop" works at once (needs FL-07's native helper inside the guest, hash-pinned)? Default until answered: every child runs --work --manage with --attend off; the owner turns attend on inside the guest (FR-15).]`
- `[NEEDS CLARIFICATION: Windows installer image licensing — may Ever Works document a community KVM-backed Windows-in-Docker installer image that fetches Microsoft media and leaves Windows unactivated? Default until answered: P1 (Containers) ships; the Windows systems stay hidden behind FLEET_VIRTUAL_ENABLED's P2 gate (plan §13) with the image digest-pinned and operator-overridable.]`
- `[NEEDS CLARIFICATION: Should a per-Container disk ceiling be enforced? Default until answered: no quota; Runs here and the child's page show the child's data-directory usage, and only Windows VMs get the 30 GB precheck (FR-18).]`

---

## 9. Acceptance criteria

**Creating (P1)**

- [ ] `ACC-FL16-01` (FR-1, FR-4) The menu item is enabled only when an eligible host exists; every ineligible host shows one of the closed-set reasons.
- [ ] `ACC-FL16-02` (FR-2, FR-3) The dialog groups systems as VM / Container, shows disk only for Windows, and defaults to 4 CPUs / 8 GB.
- [ ] `ACC-FL16-03` (FR-4) "Choose for me" names the host with the most free memory before Create.
- [ ] `ACC-FL16-04` (FR-7, FR-8) Create answers ≤ 500 ms with a child id and operation id; an invalid or duplicate name is refused `invalid` naming the field.
- [ ] `ACC-FL16-05` (FR-9, FR-10, FR-5) The fifth child is refused `limit_exceeded`; a virtual host is refused `unsupported_on_node`; a Windows host is refused `unsupported_on_node`.
- [ ] `ACC-FL16-06` (FR-11, FR-13) A Container reaches `online` within 120 s with a cached image, and the progress line passes through every named phase.
- [ ] `ACC-FL16-07` (FR-14, FR-15, FR-16) The child enrols by itself with a token delivered by private file (no token in any job payload, argv or log), runs `--work --manage`, and is bound to the host's Organization.
- [ ] `ACC-FL16-08` (FR-12, FR-36) The dialog and the Agent confirmation both state the host, CPUs, memory, disk and "No credits are spent".

**Power and destroy (P1)**

- [ ] `ACC-FL16-09` (FR-26, FR-27) Start and Stop answer ≤ 500 ms; a Container stops within 10 s; the row shows `starting` / `stopping`.
- [ ] `ACC-FL16-10` (FR-28) Destroy requires the typed name, deletes the disk under the host's node data directory, removes the registration, keeps job history, and is refused `busy` under a live Run or Session.
- [ ] `ACC-FL16-11` (FR-29, FR-30) Removing a host with children is refused `busy`; removing a child whose machine exists is refused `unsupported_on_node` with "destroy it instead"; a child whose container vanished shows the gone state within 5 minutes and may then be removed.

**Hub and host page (P1)**

- [ ] `ACC-FL16-12` (FR-31, FR-32, FR-33, FR-34) Children nest under their host with the `VM on` / `Container on` label; FL-09's Runs here block lists them with Start/Stop (no second block exists); the child header carries the actions; the palette offers the three entries.

**Windows VMs (P2)**

- [ ] `ACC-FL16-13` (FR-18) Each failed precheck (no kvm, < 30 GB, not x86-64 Linux) refuses before any download with its specific message.
- [ ] `ACC-FL16-14` (FR-19) The installer image is resolved by digest from the catalogue and an operator override is honoured.
- [ ] `ACC-FL16-15` (FR-20, FR-21) The password exists only in the host keychain (or documented fallback); a reveal shows it once for 60 s and writes `node.vm.password.reveal`; no payload, log or audit row contains it.
- [ ] `ACC-FL16-16` (FR-23) Watch the install opens the installer screen through the host and the viewer port is bound to the host's loopback only.
- [ ] `ACC-FL16-17` (FR-24, FR-25) The token is minted after the guest signals readiness; Retry enrolment re-mints without rebuilding; the runtime starts at boot as the generated account.
- [ ] `ACC-FL16-18` (FR-22, FR-27) The row reads `not activated`; Stop waits up to 120 s for Windows then forces off.

**Permissions, safety, tools**

- [ ] `ACC-FL16-19` (§4.1, FR-35) Each action is refused `consent_missing` without `--manage`, `permission_denied` outside the `machines` audience, and `kill_switch` under the stop switch; the tools carry the stated annotations.
- [ ] `ACC-FL16-20` (FR-37) Every action writes one audit row with family, target, requester and confirmation class; none contains a password or token.

**P3**

- [ ] `ACC-FL16-21` (FR-38, FR-39) Resize is refused `busy` while running and applied when stopped; Rebuild keeps the registration and home directory.

**Cross-cutting**

- [ ] Every FR has a passing unit, controller/e2e or node-side test (plan §14); every user-visible string is a `fleet.virtual.*` key.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** No external integration: Docker and KVM on the host are OS facts handled by a node module (README D8); the installer and base images are pulled by the host, not integrated by the platform. A future image-catalogue plugin is noted in the plan as not needed for this epic.
- [x] **II — Capability-driven resolution.** No plugin id is named by core code.
- [x] **III — Source-of-truth repos.** No Work content touches the database.
- [x] **IV — Job runtime.** Creation and control are durable node jobs; the reconcile sweep runs through the configured job-runtime provider via a dispatcher symbol.
- [x] **V — Forward-only migrations.** One additive migration, slot `1796160000000`.
- [x] **VI — Tests.** Named per package in plan §14 and tasks.
- [x] **VII — Secrets.** The guest password and enrolment token never enter a payload, log or audit row; redaction tested.
- [x] **VIII — Plugin counts.** No plugin; the canonical doc is untouched.
- [x] **IX — Behaviour-first.** This document names no class or endpoint.
- [x] **X — Backwards compatibility.** New union members and optional columns only.

---

## 11. References

- Program: [README](../README.md) (§1 vocabulary, §3 "Calling Linux containers VMs" refused, D2, D8, rule 18) · [CONTRACTS](../CONTRACTS.md) (R-4, R-20, R-24, R-33, R-34, R-35, R-36, §1, §2, §3.2, §4.1, §7, §8, §9, §10, §11.2, §12, §13) · [CAPABILITY-MAP](../CAPABILITY-MAP.md) §F
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Sibling epics: FL-01 (hub, registry), FL-02 (link, `--manage`, operations), FL-03 (health, wake), FL-09 (Docker module), FL-10 (open on the machine), FL-17 (cloud computers), FL-19 (tools)
- Substrate evidence: `apps/web/src/components/settings/FleetSettings.tsx:826-891`; `packages/agent/src/fleet/fleet.service.ts:79,349-394`; `packages/contracts/src/fleet/fleet-jobs.types.ts:117-125`; `packages/contracts/src/fleet/fleet-node.types.ts:46-55`; `packages/agent/src/entities/fleet-node.entity.ts:96-115`; `apps/node/src/core/capabilities.ts:277-294`; `apps/node/src/core/runtime.ts:940-953,1049-1062`
- Constitution: `.specify/memory/constitution.md`
