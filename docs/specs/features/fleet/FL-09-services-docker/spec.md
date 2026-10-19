# FL-09 — Services, Docker, Compose & processes

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-09-services-docker`
**Program:** [Fleet](../README.md) · Wave 2
**Branch:** `feat/fl-09-services-docker`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** L · **Blocked by:** FL-02 (node link, `--manage`, node modules, operations), FL-01 (computer page shell, roles) · **Related:** FL-08 (service and container logs, merged Compose logs), FL-04 (shell inside a container is an owner Session), FL-03 (failed-services count, "needs a look"), FL-16 (containers as Nodes), FL-18 (Actions runner as a service), FL-19 (tool parity)
**Extends (existing Ever Works nouns):** Node / Computer · Fleet · Session · Agent · Fleet audit · Activity · Command palette

---

## 0. TL;DR

Three tabs on a computer page answer "what is running on it?" and let the owner act on the answer.
**Services** lists the machine's service manager — systemd, launchd and Homebrew services, Windows
services — failed first, with start / stop / restart / at-boot, and warns before any action that
could cut the machine off from Ever Works. **Docker** shows containers, images and Compose
projects through the Docker CLI only — start / stop / restart / remove / run, pull / remove /
prune, up / down / restart / pull — with a Compose project drawn as a picture of its services, and
a shell into any container that becomes an owner Session. **Processes** shows the busiest 300 with
CPU, memory, owner and run time, Stop (SIGTERM) and Kill (SIGKILL) behind a confirmation, and the
machine's GPUs above the list. Root is never typed into the browser: an action that needs it runs
only when the machine already allows it without a password, and is otherwise refused with the exact
command to run there.

```
 ← Fleet   build-01   ● online · Linux · last check 09:41                       [New session ▾] [⋯]
 ┌ Overview │ Sessions │ Desktop │ Logs │ Services │ Docker │ Processes │ Ports │ Files │ … ┐
 │ SERVICES (41)  [ find…        ]   failed first · system + user          ↻ 30 s         │
 │ ▲ postgresql        failed      exited 1 · 09:12   —       —      [Start] [Log] [⋯]   │
 │ ● nginx             running     2 h · at boot      0.3%   41 MB   [Restart] [Stop] [⋯] │
 │ ● docker            running     3 d · at boot      1.1%  188 MB   [Restart] [Stop] [⋯] │
 │ ● ever-works-node   running     3 d · at boot      0.8%   96 MB   ⚠ this node       [⋯]│
 │ ● NetworkManager    running     3 d · at boot      0.0%   12 MB   ⚠ network         [⋯]│
 │ ○ ssh (user)        inactive    —   · at login     —       —      [Start]           [⋯]│
 └───────────────────────────────────────────────────────────────────────────────────────┘

 DOCKER › Compose › acme                                      [Picture | List | Logs]  [Up] [Down] [Restart] [Pull]
 ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 │  ┌ api ───────────────┐   depends on (healthy) ──▶  ┌ db ────────────────┐              │
 │  │ acme/api:1.4  ●    │ ────────────────────────────▶│ postgres:16  ● healthy│            │
 │  │ cpu 2% · 180 MB    │ ──────────────┐              │ vol pgdata          │              │
 │  │ :3000 → 3000       │               ▼              └────────────────────┘              │
 │  │ net acme_default   │   ┌ cache ────────────┐                                           │
 │  └────────────────────┘   │ redis:7  ●        │   [ Shell inside ▾ ]  [ Logs ]           │
 │                           └───────────────────┘                                           │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
```

| Phase  | Ships                                                                                                                                                                                    | Flag                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **P1** | Services tab (list, find, start/stop/restart/at-boot, blast-radius warnings, root rule); Processes tab (busiest 300, Stop/Kill, GPUs); `services` and `processes` tools; palette entries | `FLEET_MACHINE_FACTS_ENABLED` |
| **P2** | Docker tab: containers (start/stop/restart/remove, run dialog) and images (pull/run/remove/prune) as operations with progress; "Runs here" block on Overview; `docker` tools             | same                          |
| **P3** | Compose projects: picture / list / merged logs views, up/down/restart/pull; shell inside a container as an owner Session (FL-04); `compose` tools                                        | same                          |

Each phase is independently shippable.

---

## 1. Overview

A computer page gains **Services**, **Docker** and **Processes**. Each is a read of the machine
with a small set of actions, every action permissioned by the Node's control policy, confirmed in
words that name the target and what could go wrong, written to the Fleet audit ledger, and stopped
by the kill switch.

**Services** reads the machine's service manager — systemd system and user units on Linux,
launchd and Homebrew services on macOS, Windows services — and lists them failed first, then
running, then the rest, with CPU and memory for running ones and whether each starts at boot. Start,
stop, restart, and turn at-boot on or off. When the target is something the machine reaches Ever
Works through — its network service, ssh, an overlay VPN, the node service itself — the confirmation
says so in one sentence and the button is red. When the action needs root, it runs only if the
machine has already allowed the node's user to run it without a password; otherwise the action is
refused and the exact command is shown for the owner to run on the machine.

**Docker** talks to Docker through its command-line tool, never its socket. Containers can be
started, stopped, restarted, removed, and created from an image with name, ports, environment,
volumes, restart policy and command; a shell can be opened inside one, and that shell is an
ordinary owner Session on the Sessions tab. Images can be pulled, run, removed, and unused ones
pruned. Compose projects Docker knows about can be brought up, down, restarted and pulled, and
each is shown three ways: a **picture** of its services with dependency arrows, health, host
ports, networks and volumes; a **list** with per-service controls; and **merged logs** (FL-08).
Anything that takes more than a moment — a pull, a run, up, down, prune — is an **operation** with
live output and progress, visible on the page and in Activity.

**Processes** lists the busiest 300 by CPU with memory, owner, run time and the command, and the
machine's GPUs above the list with utilisation and memory where the vendor tool reports them. Stop
sends SIGTERM and Kill sends SIGKILL, each after a confirmation that names the process. The node's
own process tree and the init process are never signalled.

Containers also appear on the computer's Overview as **Runs here**, and every list is readable by
Agents through read-only tools; every action is an Agent tool too, marked state-changing and gated
by the Agent's permissions and the Node's policy.

---

## 2. Why now

### 2.1 The user's question

> _"Postgres fell over on build-01 again. Start it — and tell me why it keeps failing."_

> _"What is eating the CPU on design-mac?"_

> _"Bring the acme stack up on build-02 and show me when the API is healthy."_

### 2.2 What they do today, and why it does not answer the question

| To answer…                                | Today they must…                                       | What breaks                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Which services are failed?"              | ssh in and run the service manager.                    | A computer's health is heartbeat, disk free, worker state and tags (`docs/features/fleet.md:110`); no service is listed anywhere. The health sample reserves a `failedServices` count (CONTRACTS §4.5) that nothing fills yet.                          |
| "Restart it."                             | ssh in, `sudo`, type a password.                       | Nothing on the platform acts on a service; the program refuses typing a sudo password into the web UI (README §3), so an action needs a rule for root that does not exist yet.                                                                          |
| "What containers run there?"              | `docker ps` on the machine.                            | Docker is a single tag turned on by `docker --version` exiting 0 (`apps/node/src/core/capabilities.ts:278-294`); no container, image or Compose project is read or shown.                                                                               |
| "Open a shell inside that container."     | ssh, then `docker exec`.                               | The only shell the platform can show is the live-view terminal channel — read-only until a take-over, under the Agent's own file root (`apps/node/src/core/screen/terminal-channel.ts:36-44`), not a persistent Session, and never inside a container.  |
| "What is using the CPU?"                  | `top` on the machine.                                  | The node probes a GPU's vendor and model once per heartbeat (`apps/node/src/core/gpu-probe.ts:19-26`) and nothing else about processes; there is no process list, no signal, no utilisation.                                                            |
| "Let Nina do it."                         | Paste output into chat and type the commands yourself. | The one Agent fleet tool lists nodes (`packages/agent/src/fleet/agent-fleet-tools.ts:39-77`); the MCP whitelist's three fleet actions are set/clear affinity and drain (`apps/mcp/src/openapi-tools/whitelist.ts:475-530`; EXISTING-SUBSTRATE §8.2).    |
| "Who restarted what, when?"               | Nothing.                                               | The ledger exists (`packages/agent/src/fleet/fleet-audit.service.ts:96-116`) and already redacts; the action union (`packages/contracts/src/fleet/fleet-panic.types.ts:60-114`) has no service, Docker or process member because no such action exists. |
| "Can an org admin do this on my machine?" | Nothing.                                               | The control policy is declared with three audiences but the code derives only `owner` or `stranger` (`packages/agent/src/computer/control-policy.ts:39-49`); FL-01 derives the roles; this epic is the first to use three families of them.             |

### 2.3 What this epic closes

1. **A machine you can see but not run.** Health (FL-03) and logs (FL-08) tell the owner what is
   wrong; this epic lets them do the obvious thing about it without leaving Ever Works.
2. **A root rule with no password.** `sudo -n` or refuse-with-the-command is the program's answer
   to privilege (README §3); this epic is where it is first exercised and tested.
3. **Blast radius as a sentence.** The confirmation class `blast-radius` (CONTRACTS §2.2) gets its
   first producers: the node names the service that keeps it reachable.
4. **Containers as first-class facts.** FL-16 nests Containers under a host Node; FL-18 installs a
   runner as a service; both stand on this epic's modules.

### 2.4 Why this epic is additive only

Nothing is removed or renamed. The `docker` tag keeps its meaning; new tags `services` and
`processes` join it (CONTRACTS §1.2). Services, containers, images, projects and processes are
read from the Node and never stored as rows (README §1); the only platform writes are
`fleet_audit` rows and, for a shell inside a container, an ordinary `FleetSession` (FL-04). This
epic has no migration slot (CONTRACTS §13) and therefore **no schema change**.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — See the failed service first.**
  **Given** `build-01` is online with `--manage` and `postgresql` has failed,
  **when** the owner opens **Services**,
  **then** within 2 seconds the list shows `postgresql · failed · exited 1 · 09:12` at the top
  with a red triangle, then running services with CPU and memory, then inactive ones, and the
  header counts them (`41`).

- **S2 — Start it.**
  **Given** `postgresql` is failed and the node's user may start it without a password,
  **when** they click **Start** and confirm _"Start postgresql on build-01?"_,
  **then** the row shows _starting…_, becomes `running` within 10 seconds (or `failed` again with
  the exit code), and an audit row `node.service.start` is written naming the service and the
  person.

- **S3 — Root is needed and not pre-authorised.**
  **Given** `nginx` is a system service and `sudo -n` is refused on `build-01`,
  **when** they click **Restart** and confirm,
  **then** the action is refused with _"build-01 needs your password for this. Run it there:"_
  `sudo systemctl restart nginx` _"— or allow the node's user to run it without a password."_,
  with a copy button; nothing is run, no password is asked for, the server answers
  `root_required` with that command as the `hint`, and the refusal is audited as
  `outcome: refused`.

- **S4 — Blast radius named.**
  **Given** the owner clicks **Stop** on `NetworkManager`,
  **then** the dialog reads _"Stop NetworkManager on build-01?"_ and, in red, _"This stops the
  network service build-01 connects to Ever Works through. You would need to be at the machine to
  bring it back."_, the confirm button is red and reads **Stop anyway**.

- **S5 — At boot.**
  **Given** `nginx` is running and not enabled at boot,
  **when** they toggle **At boot** on and confirm,
  **then** the service is enabled, the row reads `at boot`, and `node.service.enable` is audited.

- **S6 — Read the log from the row.**
  **Given** `postgresql · failed`,
  **when** they click **Log**,
  **then** the Logs tab opens with that service selected (FL-08 P2) and the Services tab remembers
  its scroll position when they return.

- **S7 — The busiest processes.**
  **Given** `design-mac` is online with `--manage`,
  **when** they open **Processes**,
  **then** the GPU strip reads `Apple M2 Max · 38 GB shared · utilisation unavailable` and the
  table lists the busiest 300 processes by CPU with memory, owner, run time and command,
  refreshing every 5 seconds while visible.

- **S8 — Stop a process.**
  **Given** `node (pid 4812, ops) · 97%` is at the top,
  **when** they click **Stop** and confirm _"Send SIGTERM to node (4812) on design-mac?"_,
  **then** the signal is sent, the row shows _stopping…_, and disappears or shows _still running —
  Kill?_ after 5 seconds; `node.process.signal` is audited with the signal.

- **S9 — Containers and images (P2).**
  **Given** `build-01` runs Docker,
  **when** they open **Docker › Containers**,
  **then** every container is listed with name, image, state, ports, CPU and memory, Compose
  project when any, and **Start / Stop / Restart / Remove / Shell / Logs**; **Images** lists each
  image with tag, size, age and whether a container uses it, with **Pull / Run / Remove** and
  **Remove unused**.

- **S10 — Run a container (P2).**
  **Given** they click **Run a container**,
  **when** they enter image `redis:7`, name `cache`, port `6379→6379`, an environment variable,
  a volume under a shared folder, restart policy `unless-stopped` and confirm,
  **then** the dialog shows the exact command line it will run, the run becomes an operation with
  streaming output (the pull, then the container id), the container appears in the list within
  the operation's completion, and `node.docker.container.run` is audited with the image, name,
  ports and the **names** of environment variables — never their values.

- **S11 — Compose picture (P3).**
  **Given** project `acme` has services `api` (depends on `db` healthy), `db`, `cache`,
  **when** they open **Docker › Compose › acme**,
  **then** the picture shows three boxes with image, state and health, CPU and memory, host
  ports, networks as coloured tags and named volumes; an arrow from `api` to `db` is amber while
  `db` is not yet healthy and grey once it is; **Up / Down / Restart / Pull** sit in the header.

- **S12 — Up with progress (P3).**
  **Given** `acme` is down,
  **when** they click **Up** and confirm _"Bring acme up on build-01?"_,
  **then** an operation card streams Compose's output, the picture's boxes turn from grey to
  running to healthy as Compose reports them, and `node.compose.up` is audited with the project
  and the services it started.

- **S13 — Shell inside a container (P3).**
  **Given** `acme-api` is running and the node has `--manage`,
  **when** they click **Shell inside** and pick `sh`,
  **then** an owner Session starts whose process is a shell inside that container, it opens in
  the terminal pane like any other Session, it is listed on the Sessions tab as
  `Shell · inside acme-api`, and ending the Session ends the shell. `node.docker.container.exec`
  and `node.session.start` are both audited.

- **S14 — An Agent restarts a service.**
  **Given** Agent `Ops` has a grant for `fleet_services_action` and `build-01`'s `services`
  audience includes Ops' owner,
  **when** Ops calls the tool with `restart nginx`,
  **then** the tool returns the result or the typed refusal (incl. the root-required command as
  `hint`), the action is audited as `agent:<Ops>`, and if the node computed a blast-radius
  warning the call is held as an Approval in My Decisions unless Ops' trust level allows it
  (AW-24; the held call reuses the existing Agent action proposals, CONTRACTS R-33).

### 3.2 Edge cases and failures

- **U1 — Node offline.** The three tabs show _"build-01 is offline — last seen 12 minutes ago"_
  with **Try again**; every request is refused with `unreachable`.
- **U2 — Consent missing.** Without `--manage` each tab shows `ever-works-node start --manage`
  and _"Services need machine management switched on for this computer"_ (same for Docker and
  Processes); requests answer `consent_missing`.
- **U3 — Kill switch on.** No action runs; lists stay readable from the last answer with the stop
  banner; every request answers `kill_switch`; an operation in flight is not killed on the
  machine but its output stops being shown and the card reads _"Stopped — all computers are
  stopped"_.
- **U4 — Permission denied.** An Organization member outside the `services` audience sees the
  list (if `view` allows) with actions disabled and _"Only the owner of build-01 can change its
  services"_; a direct call answers `permission_denied` naming `services`. Same per family.
- **U5 — No service manager.** A Linux machine without systemd shows _"build-01 has no service
  manager Ever Works understands"_ and the tab offers Processes and Docker instead; the `services`
  tag is not advertised.
- **U6 — Docker not installed.** The Docker tab reads _"Docker is not installed on build-01"_
  with the vendor's install page link; the `docker` tag is absent and no tool lists containers.
- **U7 — Docker installed, daemon down.** _"Docker is installed but not running on build-01"_ with
  **Start Docker** (a Services action on the Docker service, with its blast-radius sentence when
  containers are Nodes, FL-16).
- **U8 — Link drops mid-operation.** The operation keeps running on the node; the card shows
  _"Reconnecting…"_ and resumes streaming from the node's buffer when the link returns; if the
  operation finished meanwhile its final state is shown from the node's record.
- **U9 — Action on a Windows service without administrator rights.** Refused under the root rule
  with `root_required` (not `unsupported_on_node`): _"win-lab needs administrator rights for this.
  Run in an elevated PowerShell:"_ `Restart-Service -Name W3SVC`.
- **U10 — Signalling the node itself.** **Stop** on the node's own process, its session daemon,
  or PID 1 is refused with `invalid` and _"Ever Works will not stop its own node from here. Use
  the machine or Settings → Fleet."_; the rows carry a `⚠ this node` marker and no buttons.
- **U11 — Another user's process without root.** **Stop** is attempted with `sudo -n`; when
  refused, the root rule applies with `sudo kill -TERM 4812`.
- **U12 — Remove a container with anonymous volumes.** The dialog requires typing the container's
  name (`confirm-destructive`) and says _"Its anonymous volumes are kept; named volumes are never
  removed from here."_
- **U13 — Run with a dangerous option.** A bind mount outside the shared folders, `--privileged`,
  a host network or PID namespace, or the Docker socket as a volume is refused with `invalid` and
  the hint _"Mounts must be under this computer's shared folders; privileged, host-namespace and
  socket mounts are not available from here."_
- **U14 — Compose project whose files are gone.** Listed as `acme · files missing` with actions
  disabled except **Down**; describe answers `operation_failed` with Compose's first stderr line.
- **U15 — Prune reclaims nothing.** _"Nothing to remove — every image on build-01 is in use."_;
  no audit row is written for a no-op the node refused to run.
- **U16 — Operation limit.** A sixth concurrent machine operation on one node answers `busy` with
  _"build-01 is already running 5 operations"_ (this epic's per-node cap; FL-02 and CONTRACTS §10
  do not set one yet — §8b).
- **U17 — Agent signals a process.** Allowed only through `fleet_processes_signal`, marked
  state-changing; SIGKILL by an Agent is held as an Approval unless its trust level allows it.
- **U18 — Desktop node app.** _"Not available on this kind of node yet"_ (R-10).

---

## 4. Functional requirements

Values marked **(C)** come from [CONTRACTS.md](../CONTRACTS.md).

### 4.1 P1 — Services

- **FR-1** The Services tab MUST list systemd system **and** user units on Linux, launchd agents
  and daemons plus Homebrew services on macOS, and Windows services, each row with name, state,
  since, at-boot, and — for running services — CPU percent and memory.
- **FR-2** Rows MUST be ordered failed first, then running, then the rest, each group by name,
  and a **find** field MUST filter by name and description.
- **FR-3** Each service MUST offer **Start**, **Stop**, **Restart** and an **At boot** toggle
  where its manager supports them, with unsupported actions hidden and the reason in a tooltip.
- **FR-4** An action that needs root MUST run only non-interactively (`sudo -n` or the OS
  equivalent); when that is refused the action MUST be refused with the exact command the owner can
  run on the machine, and MUST never prompt for a password.
- **FR-5** Before stopping, restarting or disabling a service, the node MUST compute whether the
  target could cut the machine off from Ever Works — its network service, ssh, an overlay VPN, the
  Docker daemon when Containers are Nodes, or the node service itself — and the confirmation MUST
  carry that sentence (`blast-radius` class **(C §2.2)**).
- **FR-6** Service lists MUST refresh every 30 seconds while the tab is visible and immediately
  after any action on that node.
- **FR-7** The node MUST expose the failed-service count to the health sample (CONTRACTS §4.5
  `failedServices`) so FL-03 can raise a "needs a look" item.
- **FR-8** Every service row MUST offer **Log**, opening the Logs tab on that service (FL-08).

### 4.2 P1 — Processes and GPUs

- **FR-9** The Processes tab MUST list the **300** busiest processes by CPU **(C §10)** with PID,
  name, CPU percent of one core, memory, owner, run time and command, refreshing every 5 seconds
  while visible.
- **FR-10** Command lines MUST be truncated at 200 characters and MUST pass the secret scan on the
  node before leaving it.
- **FR-11** **Stop** MUST send SIGTERM and **Kill** SIGKILL (Windows: graceful close, then
  forced termination), each after a `confirm` dialog naming the process and PID.
- **FR-12** The node MUST refuse to signal its own process tree, its session daemon, and PID 1,
  with `invalid`, and MUST mark those rows.
- **FR-13** Signalling another user's process MUST follow the root rule (FR-4).
- **FR-14** GPUs MUST be shown above the list — vendor, model, memory used/total and utilisation
  where the vendor tool reports them (NVIDIA, AMD on Linux), and model with memory only where it
  does not (Apple), stating _"utilisation unavailable"_ rather than a dash.

### 4.3 P1 — Consent, permission, audit, kill switch, tools

- **FR-15** Every action in this epic MUST require the `manage` consent **(C §1.1)** and MUST be
  refused with `consent_missing` and the exact command otherwise; the tabs MUST show that command.
- **FR-16** Services actions MUST be governed by the `services` family, Docker and Compose by
  `docker`, process signals by `processes` **(C §2.1)**; a caller outside the audience MUST be
  refused with `permission_denied` naming the family. Listing MUST be governed by the `view`
  family.
- **FR-17** Confirmation classes MUST be: start / enable / Compose up / restart / pull / image
  pull / container run — `confirm`; stop / disable / container stop or restart / Compose down /
  image remove / prune / SIGTERM / SIGKILL — `confirm`, raised to `blast-radius` when the node
  computed a warning; container remove — `confirm-destructive` (type the name); shell inside —
  `plain` **(C §2.2)**.
- **FR-18** Every action MUST write one `fleet_audit` row with the CONTRACTS §7 name
  (`node.service.start|stop|restart|enable|disable`, `node.docker.container.start|stop|restart|remove|run|exec`,
  `node.docker.image.pull|remove|prune`, `node.compose.up|down|restart|pull`, `node.process.signal`),
  the target, `requestedBy`, the confirmation class and the outcome; a refused action MUST be
  audited with `outcome: refused`.
- **FR-19** When the kill switch is on, every request MUST be refused with `kill_switch`
  **(C R-24)**; lists MUST stay readable from their last answer with the stop banner.
- **FR-20** Errors MUST be drawn from CONTRACTS §8: `unreachable`, `consent_missing`,
  `permission_denied`, `confirmation_required`, `kill_switch`, `limit_exceeded`,
  `unsupported_on_node`, `busy`, `invalid`, `not_found`, `operation_failed`, `root_required`. A
  root-required refusal MUST be `root_required` (HTTP 409, CONTRACTS §8) with the exact command as
  `hint`.
- **FR-21** Agent tools MUST exist for every list (`fleet_services_list`, `fleet_processes_list`,
  P2 `fleet_docker_containers_list`, `fleet_docker_images_list`, P3 `fleet_docker_compose_list`,
  `fleet_docker_compose_describe`) marked `readOnly: true`, and for every action
  (`fleet_services_action`, `fleet_processes_signal`, P2 `fleet_docker_container_action`,
  `fleet_docker_run`, `fleet_docker_image_action`, P3 `fleet_docker_compose_action`,
  `fleet_docker_exec`) — named after the `docker` family, which governs Compose (CONTRACTS §2.1,
  §11.3) — marked
  `destructive: true|false` with their confirmation class, gated by the Agent's grants **and** the
  Node's family audience **(C §2.1)**.
- **FR-22** An Agent action whose class is `blast-radius` or `confirm-destructive` MUST be held as
  an Approval (My Decisions) unless the Agent's trust level allows it (AW-24), reusing the existing
  Agent action proposals (CONTRACTS R-33); a non-interactive caller satisfies a class only with the
  CONTRACTS §2.2 fields `confirm: true`, `confirmName` or `acknowledgeBlastRadius: true`, and
  otherwise receives `confirmation_required` with the class and, for `blast-radius`, the sentence.
- **FR-23** The palette MUST offer _"Services on <computer>"_, _"Docker on <computer>"_ and
  _"Processes on <computer>"_ for every viewable computer.
- **FR-24** Everything in this epic MUST be behind `FLEET_MACHINE_FACTS_ENABLED` **(C §9)**.

### 4.4 P2 — Docker containers and images

- **FR-25** Docker MUST be driven through its command-line tool only; the daemon socket MUST never
  be opened by the node or mounted by anything the node starts.
- **FR-26** **Containers** MUST list every container with name, image, state, status, ports,
  created, Compose project, and CPU and memory for running ones; **Images** MUST list tag, id,
  size, age and in-use count.
- **FR-27** Container actions MUST be start, stop, restart, remove; image actions pull, run,
  remove, and remove unused (prune); each a link request, and pull / run / prune reported as an
  **operation** with streaming output and progress.
- **FR-28** **Run a container** MUST take image, name, ports, environment variables, volumes,
  restart policy and command, MUST show the exact command line before confirmation, MUST refuse
  bind mounts outside the allowed roots (R-18), privileged mode, host network or PID namespaces
  and socket mounts with `invalid`, and MUST audit variable names only.
- **FR-29** Environment variable values entered in the dialog MUST be scanned and MUST never
  appear in audit rows, operation output shown to viewers, or tool results.
- **FR-30** The computer Overview MUST show a **Runs here** block listing running containers (and,
  from FL-16, nested Nodes) with Start / Stop, registered as an Overview block through the FL-01
  registry (CONTRACTS §11.1).
- **FR-31** Every container row MUST offer **Logs** (FL-08) and, from P3, **Shell inside**.

### 4.5 P3 — Compose and shell inside

- **FR-32** **Compose** MUST list every project Docker knows with name, status, service count and
  config files, and MUST offer **Up**, **Down**, **Restart** and **Pull** as operations.
- **FR-33** A project MUST have three views: **Picture** (service boxes with image, state, health,
  CPU, memory, host ports, networks as coloured tags, named volumes and mounted files; arrows for
  `depends_on`, amber while a `service_healthy` condition is unmet, red when the dependency is
  down), **List** (table with per-service Start / Stop / Restart), **Logs** (FL-08 merged view).
- **FR-34** **Down** MUST never remove named volumes, and the dialog MUST say so.
- **FR-35** **Shell inside** MUST start an owner Session (FL-04) whose process is a shell inside
  the container, offering the shells found in the image (`bash`, `sh`), labelled
  `Shell · inside <container>` on the Sessions tab, and MUST require `--manage`.
- **FR-36** Compose service names, project names, container names and image references MUST be
  validated against strict patterns on the node and passed as arguments, never through a shell
  string.

---

## 5. UX

All copy is the exact user-visible string; keys in plan §8.

### 5.1 Services — loaded

```
│ SERVICES (41)   [ find…            ]   system + user · failed first         ↻ 30 s │
│ ▲ postgresql       failed    exited 1 · 09:12    —      —     [Start] [Log] [⋯]   │
│ ● nginx            running   2 h · at boot       0.3%  41 MB  [Restart] [Stop] [⋯]│
│ ● ever-works-node  running   3 d · at boot       0.8%  96 MB  ⚠ this node    [⋯] │
│ ● NetworkManager   running   3 d · at boot       0.0%  12 MB  ⚠ network      [⋯] │
│ ○ ssh (user)       inactive  — · at login        —      —     [Start]        [⋯] │
```

`⋯` holds **At boot (on/off)**, **Log**, **Copy unit name**. Rows with a `⚠` marker name the risk in
a tooltip: _"Stopping this could cut build-01 off from Ever Works."_

### 5.2 Confirmations

```
┌ Restart nginx on build-01? ───────────────────────────────┐
│ nginx will be unavailable for a moment.                   │
│                               [ Cancel ]  [ Restart ]     │
└───────────────────────────────────────────────────────────┘

┌ Stop NetworkManager on build-01? ─────────────────────────┐
│ ⚠ This stops the network service build-01 connects to     │
│   Ever Works through. You would need to be at the machine │
│   to bring it back.                                       │
│                            [ Cancel ]  [ Stop anyway ]    │   ← red
└───────────────────────────────────────────────────────────┘

┌ Remove acme-api on build-01? ─────────────────────────────┐
│ The container is removed. Named volumes are never removed │
│ from here.                                                │
│ Type the container's name to confirm:  [ acme-api      ]  │
│                              [ Cancel ]  [ Remove ]       │
└───────────────────────────────────────────────────────────┘
```

### 5.3 Root required

```
┌ build-01 needs your password for this ────────────────────┐
│ Ever Works never asks for it. Run this on build-01:       │
│   sudo systemctl restart nginx                    [copy]  │
│ Or allow the node's user to run it without a password —   │
│ see "Root actions" in the Fleet docs.                     │
│                                              [ Close ]    │
└───────────────────────────────────────────────────────────┘
```

Windows variant: _"win-lab needs administrator rights for this. Run in an elevated PowerShell:"_
`Restart-Service -Name W3SVC`.

### 5.4 Processes

```
│ GPU  NVIDIA RTX 4090 · 61% · 9.2 / 24 GB          GPU 2  NVIDIA RTX 4090 · 0% · 0.4 / 24 GB │
│ PROCESSES · busiest 300 by CPU                     [ find… ]                        ↻ 5 s  │
│  PID    NAME            CPU     MEM     OWNER   RUN TIME  COMMAND                           │
│  4812   node            97.0%   1.2 GB  ops     12:04     node ./dist/worker.js --queue …   │
│  3301   postgres        12.4%   410 MB  postgres 3 d      postgres: checkpointer            │
│  1      systemd          0.0%   11 MB   root    3 d       /sbin/init            ⚠ not from here │
│  912    ever-works-node  0.8%   96 MB   ops     3 d       node cli.js start --work --manage ⚠ this node │
```

Row actions: **Stop**, **Kill** (in `⋯`). Confirm: _"Send SIGTERM to node (4812) on build-01?"_ /
_"Send SIGKILL to node (4812) on build-01? It cannot save its work."_ After Stop: _"still running —
Kill?"_ inline after 5 s. GPU without utilisation: `Apple M2 Max · 38 GB shared · utilisation
unavailable`.

### 5.5 Docker — containers and images (P2)

```
│ DOCKER  [ Containers (3) | Images (12) | Compose (1) ]            [ Run a container ] [ Pull… ] │
│ ● acme-api     acme/api:1.4   running   2 h   :3000→3000   2%   180 MB   acme   [Stop] [Restart] [Shell] [Logs] [⋯] │
│ ● acme-db      postgres:16    running   2 h   (internal)   1%   96 MB    acme   [Stop] [Restart] [Shell] [Logs] [⋯] │
│ ○ old-build    node:22        exited 1  3 d   —            —    —        —      [Start] [Remove] [Logs]       │
│ IMAGES                                                                                                  │
│  acme/api:1.4       412 MB   2 h    used by 1   [Run] [Remove]                                           │
│  node:22            1.1 GB   3 d    unused      [Run] [Remove]           [ Remove unused (2 · 1.6 GB) ]  │
```

**Run a container** dialog: image, name, ports (`host→container` rows), environment (name, value —
value field masked, _"values are never stored or shown again"_), volumes (picker limited to shared
folders + named volumes), restart policy, command; a preview line `docker run -d --name cache -p
6379:6379 -e REDIS_ARGS=… --restart unless-stopped redis:7`; _"Pulls the image if it is not on
build-01 (size shown when known). Disk free: 118 GB."_

### 5.6 Operation card

```
│ ⟳ Pulling redis:7 on build-01 · 42% · 18 MB/s                    [ Stop ]  │
│   7: Pulling from library/redis                                              │
│   a2abf6c4d29d: Pull complete                                                │
│   …                                                                          │
```

Finished: `✓ Pulled redis:7 · 41 MB · 12 s`. Failed: `✖ Pull failed — "manifest unknown"` with
**Retry**. The same card appears in Activity → Live Feed as a sentence (_"Ops pulled redis:7 on
build-01"_).

### 5.7 Compose (P3)

Picture as in §0; **List** view:

```
│ SERVICE   IMAGE          STATE     HEALTH    PORTS       VOLUMES   NETWORKS       │
│ api       acme/api:1.4   running   —         3000→3000   —         acme_default   [Stop] [Restart] [Shell] [Logs] │
│ db        postgres:16    running   healthy   —           pgdata    acme_default   [Stop] [Restart] [Shell] [Logs] │
```

**Down** dialog: _"Bring acme down on build-01? Its 3 containers and network are removed. Named
volumes (pgdata) are kept."_

### 5.8 Overview — Runs here

```
│ Runs here   ● acme-api  ● acme-db  ○ old-build (exited)   [ Start ]        win-11-vm · stopped (VM) │
```

### 5.9 States (every tab)

- Loading: _"Asking build-01…"_; after 10 s _"build-01 has not answered yet. It may be busy."_
- Empty: Services _"No services Ever Works can list on build-01"_; Docker _"No containers on
  build-01 yet"_ with **Run a container**; Processes never empty while online.
- Offline / consent missing / permission denied / desktop node / kill switch: as FL-08 §5.7,
  with the family in the permission sentence.
- Error: `✖ Could not list services on build-01 — systemctl exited 1: "…"` **Try again**.

### 5.10 Activity and Agent page

- Activity → Log: one row per action: _"Ops restarted nginx on build-01 (confirm)"_, _"Nina was
  refused SIGKILL on 4812 — root required"_. Activity → Live Feed: operation sentences.
- Agent page → Activity: tool calls with target and outcome, never env values or command
  output beyond the first line.

### 5.11 Keyboard and palette

`/` find · `Enter` on a row opens its `⋯` · `L` opens the row's log · `Esc` closes dialogs; dialogs
trap focus; `confirm-destructive` fields are labelled. Palette: _"Services on build-01"_,
_"Docker on build-01"_, _"Processes on build-01"_.

---

## 6. Non-functional requirements

- **Performance:** lists ≤ 2 s P95 online; an action's result ≤ 10 s P95 or reported as an
  operation; operation output ≤ 1 s behind the node.
- **Reliability:** operations survive link drops (node-side record, resume); every refusal is
  typed with a hint; lists degrade to "last known" under the kill switch.
- **Security & privacy:** no password ever typed into or transmitted by Ever Works; `sudo -n`
  only; names validated and passed as argv; Docker through the CLI only; env values and command
  lines scanned on the node; audit rows carry names, never values; the node never signals itself;
  nothing listens (README D2).
- **Observability:** audit rows; operation records; API metrics per family and outcome; node
  warnings on `sudo -n` refusals (count only).
- **Compatibility:** Linux systemd ≥ 245 (json output optional, text fallback), macOS 12+,
  Windows 10/11 PowerShell 5.1+, Docker CLI ≥ 24 with Compose v2; additive contracts.
- **Cost:** no tokens or credits; a pull uses the machine's bandwidth and disk — the dialog
  shows disk free and, for cloud computers (FL-17), the line _"Disk on this cloud computer is
  billed by its provider."_ Agent actions appear in the Run receipt as tool calls.

---

## 7. Key entities & concepts

| Entity / concept                                        | New?             | Description                                                                                          |
| ------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| **Node / Computer**                                     | Existing         | The machine; its `consents`, `controlPolicy` families `services · docker · processes` gate the tabs. |
| **Service, container, image, Compose project, process** | plain words      | Read from the Node, never stored (README §1).                                                        |
| **Operation**                                           | Existing (FL-02) | A long link action with progress; pull / run / prune / up / down / restart / Compose pull.           |
| **Session**                                             | Existing (FL-04) | A shell inside a container is an owner Session, `provider: shell`, titled `Shell · inside <c>`.      |
| **Blast radius**                                        | concept          | The node's sentence naming what an action could cut off; drives the `blast-radius` class.            |
| **Fleet audit**                                         | Existing         | Gains the §7 action names for services, Docker, Compose and processes.                               |
| **Health sample**                                       | Existing (FL-03) | `failedServices` is filled from this epic's services module.                                         |

No new noun (README §1).

---

## 8. Out of scope

- **Other container runtimes** (Podman, containerd, Kubernetes on the machine). The `k8s` kind
  stays what it is (README rule 18).
- **Editing Compose files or service unit files.** Read and act only; "Edit" lands with FL-11
  files when a Checkout holds the file.
- **Creating Compose projects** from the UI.
- **Installing or removing services** (FL-18 installs Actions runners through its own job).
- **Per-process details** (open files, threads, environment of a process).
- **Typing a sudo password** anywhere in Ever Works (README §3).
- **Removing named volumes, images in use, or running containers without stopping** — refused
  by construction.
- **CLI verbs** — FL-19 registers `ever-works fleet services|docker|compose|processes …` over this
  epic's routes.

## 8b. Open questions

- **Resolved** by CONTRACTS §8: `root_required` (HTTP 409) with the exact command as `hint` is the
  root-required refusal (FR-4, FR-20, S3, U9).
- **Resolved** by CONTRACTS §11.2: `/nodes/:id/services/:name/:action`,
  `/nodes/:id/processes/:pid/signal`, `/nodes/:id/docker/containers/:cid/:action`,
  `/nodes/:id/docker/images/:iid/:action` and `/nodes/:id/docker/compose/:project/:action` are
  listed beside their collection roots; the plan uses exactly these.
- **Resolved** by CONTRACTS §11.1: the FL-01 registry has `registerOverviewBlock`; **Runs here** is
  registered through it (FR-30).
- `[NEEDS CLARIFICATION: Agent `fleet_docker_run`by default. Default until answered: allowed only
with an explicit per-Agent grant (AW-15),`destructive: false`, class `confirm`, and held as an
Approval (CONTRACTS R-33) below AW-24 trust level "trusted".]`
- `[NEEDS CLARIFICATION: Compose **Down** from an Agent when the project contains a container that
is a Node (FL-16). Default until answered: the node computes a `blast-radius` warning for it
("this stops <child>, a computer in your Fleet"), so an Agent below the allowing trust level is
held for approval (FR-22).]`
- **Resolved** by CONTRACTS §10 (rev 4): 5 concurrent machine operations per Node, 60-min operation cap, 20 finished operations kept per Node.

---

## 9. Acceptance criteria

- [ ] **ACC-FL09-01** Services lists system + user units failed first with CPU/memory for running
      ones; find filters. (FR-1, FR-2)
- [ ] **ACC-FL09-02** Start on a failed unit the node may start runs, the row updates ≤ 10 s, and
      `node.service.start` is audited with target and requester. (FR-3, FR-18)
- [ ] **ACC-FL09-03** A system unit with `sudo -n` refused yields the root dialog with the exact
      command; the API answers `root_required` (409) with the command as `hint`; no password prompt
      exists; audit `outcome: refused`. (FR-4, FR-20)
- [ ] **ACC-FL09-04** Stop on the network service shows the blast-radius sentence and a red
      button; the audit row's class is `blast-radius`. (FR-5, FR-17)
- [ ] **ACC-FL09-05** At boot toggles enable/disable and audits them. (FR-3, FR-18)
- [ ] **ACC-FL09-06** The health sample carries `failedServices` from the module. (FR-7)
- [ ] **ACC-FL09-07** Processes lists ≤ 300 rows by CPU with owner and run time; refresh 5 s. (FR-9)
- [ ] **ACC-FL09-08** A command line with a token-shaped argument arrives redacted. (FR-10)
- [ ] **ACC-FL09-09** Stop sends SIGTERM after confirm; Kill SIGKILL; the node's own PID and PID 1
      are refused with `invalid`. (FR-11, FR-12)
- [ ] **ACC-FL09-10** GPU strip shows utilisation for NVIDIA and "utilisation unavailable" on
      Apple. (FR-14)
- [ ] **ACC-FL09-11** Without `--manage` each tab shows the command; API answers
      `consent_missing`. (FR-15)
- [ ] **ACC-FL09-12** Outside the `services` audience, actions are disabled and the API answers
      `permission_denied` naming the family. (FR-16)
- [ ] **ACC-FL09-13** Kill switch: requests answer `kill_switch`; lists show last known with the
      banner. (FR-19)
- [ ] **ACC-FL09-14** Agent `fleet_services_action restart nginx` is audited as `agent:<id>`; a
      blast-radius target creates an Approval for an Agent below the allowing trust level.
      (FR-21, FR-22)
- [ ] **ACC-FL09-15** Palette lists the three entries per computer; flag off hides tabs and 404s
      routes. (FR-23, FR-24)
- [ ] **ACC-FL09-16** (P2) Containers and images list with the stated columns; no code path opens
      the Docker socket (static check + e2e). (FR-25, FR-26)
- [ ] **ACC-FL09-17** (P2) Pull reports an operation with progress; failure shows the first
      stderr line. (FR-27)
- [ ] **ACC-FL09-18** (P2) Run refuses a bind mount outside roots, `--privileged`, host
      namespaces and the socket; audit holds env names only; env values absent from every
      payload. (FR-28, FR-29)
- [ ] **ACC-FL09-19** (P2) Overview shows Runs here with running containers. (FR-30)
- [ ] **ACC-FL09-20** (P3) Compose lists projects; Picture shows boxes, arrows (amber while
      unhealthy dependency), ports, networks, volumes; List acts per service; Logs opens FL-08
      merged. (FR-32, FR-33)
- [ ] **ACC-FL09-21** (P3) Down keeps named volumes and the dialog says so. (FR-34)
- [ ] **ACC-FL09-22** (P3) Shell inside starts an owner Session listed as `Shell · inside <c>`;
      ending it ends the shell; both audit rows exist. (FR-35)
- [ ] **ACC-FL09-23** A name with a shell metacharacter is refused with `invalid` and never
      reaches a child process. (FR-36)
- [ ] All functional requirements have a passing unit, controller/e2e, node-side or Playwright
      test (plan §14).

---

## 10. Constitution gates

- [x] **I Plugin-first** — n/a: service managers, Docker CLI and `ps` are OS facts in node
      modules (README D8); no external service is integrated.
- [x] **II Capability-driven** — n/a: no plugin id; modules advertise `services`, `processes`
      and the existing `docker` tag.
- [x] **III Source-of-truth repos** — untouched.
- [x] **IV Job runtime** — n/a: actions are ephemeral link requests; long ones are FL-02
      operations recorded on the node, not platform jobs (CONTRACTS §12).
- [x] **V Forward-only migrations** — no schema change (no FL-09 slot).
- [x] **VI Tests first** — plan §14.
- [x] **VII Secrets** — no passwords; env values and command lines scanned; audit belt.
- [x] **VIII Plugin counts** — n/a.
- [x] **IX Behaviour-first** — no class or path outside citations of today's code.
- [x] **X Backwards compatibility** — additive contracts, routes under the existing root.

---

## 11. References

- Program: [README](../README.md) §1, §3 (sudo refusal, Docker CLI), §4 D2, D7, D8 · [CONTRACTS](../CONTRACTS.md)
  §1.1, §1.2 (`services`, `processes`, `docker`), §2 (families, classes, audit), §3.3 (`machine`
  family: `services.list|action`, `docker.*`, `compose.*`, `processes.list|signal`), §7, §8, §9,
  §10 (process list), §11, R-18, R-24, R-33 · [EXISTING-SUBSTRATE](../EXISTING-SUBSTRATE.md) §1.9,
  §1.14, §2.7, §2.10, §8.2 · [CAPABILITY-MAP](../CAPABILITY-MAP.md) §D services,
  Docker, processes rows.
- Siblings: [FL-02](../FL-02-node-link/), [FL-01](../FL-01-fleet-hub/), [FL-08](../FL-08-logs/),
  [FL-04](../FL-04-sessions-on-computers/), [FL-03](../FL-03-computer-health/),
  [FL-16](../FL-16-virtual-computers/), [FL-18](../FL-18-actions-runners/), [FL-19](../FL-19-agent-mcp-cli/).
- Existing code cited: `apps/node/src/core/capabilities.ts`, `apps/node/src/core/gpu-probe.ts`,
  `apps/node/src/core/screen/terminal-channel.ts`, `packages/agent/src/computer/control-policy.ts`,
  `packages/agent/src/fleet/fleet-audit.service.ts`, `packages/contracts/src/fleet/fleet-panic.types.ts`,
  `packages/agent/src/fleet/agent-fleet-tools.ts`, `apps/mcp/src/openapi-tools/whitelist.ts`,
  `docs/features/fleet.md`.
- User docs (to be written): `docs/features/fleet-services-docker.md`.
