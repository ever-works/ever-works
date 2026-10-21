# FL-02 — Node link & runtime foundations

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md).

**Epic ID:** `FL-02-node-link`
**Program:** [Fleet](../README.md) · Wave 0 (foundations)
**Branch:** `feat/fl-02-node-link`
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18
**Size:** L · **Blocked by:** — · **Related:** FL-01 (roles and family audiences), FL-03 (first `machine`-family verbs), FL-04 (first `session` channel), FL-07 (desktop channel), FL-08…FL-14 (every machine tab), FL-19 (tools), AW-11 (the computer-session leg this generalises)
**Extends (existing Ever Works nouns):** Node · Fleet · consents (`--work`, `--attend`) · heartbeat · computer-session leg · terminal/computer relays · kill switch · panic controls · Fleet audit · health endpoint

---

## 0. TL;DR

Every interactive thing this program promises — sessions you can type into, a desktop you can watch,
logs that tail, files that copy, a command that runs on five machines — needs a live two-way path
between the platform and a machine. Today there is one, built for a single purpose: the
computer-session leg a node opens outward so an owner's "refresh" or "sharper picture" can reach it.
This epic generalises that leg into **the node link**: one outbound, multiplexed WebSocket per node,
opened only when the node's owner has switched on at least one of `--work`, `--attend` or the new
**`--manage`** consent, carrying many independent channels, each opened by the platform, authorised
per action family, refused with the consent or permission named, audited when it changes the
machine, paused by the kill switch, and resumed after a network blip without losing a session.
Platform-side, relays stop being per-process: with Valkey configured any API replica can serve any
viewer; without it the API runs single-replica relays and says so in its health output. A node module
registry lets every later epic add its own channel handlers and capability tags without touching
another's. The `apps/desktop-node` shell adopts the same consents last.

```
 NODE build-01                            PLATFORM                              BROWSER
 ever-works-node start --work --manage
   │ POST /api/fleet/link-token ──────────► mint: 5 min, single-use, bound to node
   │ wss://api/ws/fleet/link ─────────────► link.hello { nodeId, consents, tags, token }
   │ ◄──────────────────────────────────────  link.ready { linkGeneration: 7, limits }
   │                                                                     Refresh now (FL-03)
   │ ◄── channel.open { ch 3, family: machine } ◄── authorise: consent? family? kill switch?
   │ ──► channel.ready { ch 3 }
   │ ◄── { requestId, type: health.now }
   │ ──► { requestId, result } ───────────► ─────────────────────────────────► card updates
   │ ◄── link.ping ─── link.pong ──►   every 15 s · 45 s silence closes both ends
   │ ✖ network blip
   │ reconnect 1 s → 30 s, jitter: link.hello { …, resume: 7 }
   │ ◄──────────────────────────────────────  link.ready { linkGeneration: 8, resumed: [3], closed: [] }

 COMPUTER PAGE (header, FL-01 shell)        build-01  ● Online · Linux · checked 09:41
                                            Link ● connected · work · manage       [⋯]
                                            Consents: ✔ work  ✖ attend  ✔ manage   "start with --attend to view the screen"
```

Three phases, each independently shippable:

- **P1 — Protocol and consent.** The link endpoint, token minting, framing, hello/ready,
  ping/pong, reconnect with resume, channel open/refuse/close, `requestId` and `operationId`; the
  `--manage` consent on the node, `consents` in the heartbeat and on the node row, the `managed`
  tag; the node module registry with a control module; the per-family authorisation, audit and
  kill-switch refusal; the link indicator on the computer page; `FLEET_NODE_LINK_ENABLED`.
- **P2 — Relay bus and the viewer bridge.** Valkey-backed fan-out for the terminal relay, the
  computer relay and link channels; single-replica fallback reported in health; viewer attach
  tokens and the viewer gateway that bridges a browser socket to a node channel; the operations
  endpoint; the existing computer-session leg moved onto the link with the old leg kept as fallback.
- **P3 — Lifecycle, management lane and parity.** The upgrade-required flow in the hub (with the
  `node-upgrade-required` "needs a look" producer) and an opt-in auto-update check on the node; the
  node's **management lane** that later epics' machine jobs ride (CONTRACTS R-34);
  `apps/desktop-node` consents in its wizard and tray.

---

## 1. Overview

A **node link** is a long-lived, outbound-only connection a node opens to the platform right after
its first accepted heartbeat, provided its owner switched on at least one consent beyond enrolment.
A node that is merely enrolled never opens it. The link carries **channels**: the platform opens
one for each thing a person or an Agent wants to do (a session, a log tail, a file transfer, a
command, a machine fact), names the **family** the channel belongs to, and the node accepts or
refuses it. Before any channel is opened the platform checks three things, in order: is the kill
switch off; does the node report the **consent** the family needs; does the node's control policy
put the caller in the family's **audience** (FL-01). A refusal always carries the exact reason and
the exact fix — the command to run on the machine, or who to ask.

The link survives what networks do. Both sides exchange a heartbeat every fifteen seconds and close
after forty-five seconds of silence; the node reconnects with exponential backoff from one second
to thirty, presents the generation of the link it lost, and the platform resumes every channel the
node still has (a session that kept running, a log tail) and closes the rest with a named reason.
Nothing on the HTTPS side changes: the sixty-second heartbeat remains the source of a computer's
online/offline status, and job leasing stays where it is.

On the platform, viewers never connect to a node. A browser attaches to a short-lived, single-use
token for one channel and one role, exactly as the Agent-computer surface does today, and the
platform **bridges** that socket to the node's channel. With Valkey configured the bridge works from
any API replica; without it the API runs its existing per-process relays and the health endpoint
reports `fleet_relay: single-replica` so an operator can see the limit rather than discover it.

Inside the node, **modules** own channel families: each module says which capability tags it can
promise and which channel families it handles, and the runtime composes them at compile time. This
epic ships the registry and the control module; FL-03 adds the first `machine` verbs, FL-04 the
session module, and so on. A fourth consent, **`--manage`**, joins `--work` and `--attend`: it is
what every machine-management family (logs, services, Docker, processes, ports, files, commands,
schedules, checkout discovery, owner sessions, wake) requires, and it is reported in every
heartbeat so the hub can say, per tab, which consent a computer is missing. The heartbeat reports
all four consents of CONTRACTS §1.1 — `work`, `attend`, `manage` and `usageScan` — with `usageScan`
always false until FL-20 adds its `--usage-scan` flag. The node's own local conversations with its
session daemon (FL-04) and its screen helper (FL-07) are same-user local sockets protected by a
token, not network listeners, and so stay inside the outbound-only rule (CONTRACTS R-26).

Finally, the node's own lifecycle gets two honest surfaces: a computer below the platform's version
floor already keeps heartbeating but is refused work; this epic shows that state in the hub with
the exact upgrade command, and lets an owner opt a machine into updating itself when the platform
raises the floor or recommends a version. The desktop shell gains the same consents in its wizard
so its computers stop reading "not available on this kind of computer yet".

---

## 2. Why now

### 2.1 The user's question

> _"Why can I watch my agent's browser on that computer but not open a shell, tail a log or run a
> command there — and why does each one need its own plumbing?"_

### 2.2 What exists today, and what breaks

| To do…                              | Today                                                                                                                                                                                                                                                                                                                             | What breaks                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reach a machine live                | One outbound WebSocket exists, opened per **computer session** so quality/refresh/input reach the capture (`apps/node/src/core/screen/node-leg.ts:12-35`); its server end is the computer gateway (`apps/api/src/computer/computer-ws.service.ts:27-60`).                                                                         | It is keyed to one live view and one job; it carries only computer frames; there is no way to open a second kind of channel on it. Every later epic would need its own leg.                                                                                                                                                                      |
| Ask for consent                     | Three consents: enrol, `--work`, `--attend` (`apps/node/src/cli/program.ts:1548-1552`; `apps/node/src/core/runtime.ts:476-480`).                                                                                                                                                                                                  | Nothing covers "manage this machine". The heartbeat does not report consents at all (`packages/contracts/src/fleet/fleet-node.types.ts` — no `consents` field; `apps/node/src/core/heartbeat.ts:72-90` tiers list none), so the hub cannot say which one is missing.                                                                             |
| Serve a viewer from any API replica | Relays are in-memory per process with a declared cross-replica seam whose default is a no-op (`apps/api/src/terminal/terminal-relay.registry.ts:71-82, 130`; `apps/api/src/computer/computer-relay.registry.ts:29-34`).                                                                                                           | Two replicas, one session: only the replica that holds the relay can serve it. Redis is already a dependency (`apps/api/package.json:74` `ioredis`; `apps/api/src/health/service-detection.ts:28-30` `getRedisUrl`) but nothing fleet-related uses it, and health says nothing about relays (`apps/api/src/health/health.controller.ts:85-100`). |
| Add a machine fact                  | The node has no module system: executors are registered by hand in the runtime (`apps/node/src/core/runtime.ts:737-749`, `:947`, `:1062`; EXISTING-SUBSTRATE §1.5), capability tags are computed in one function (`apps/node/src/core/capabilities.ts:277-330`); no plugin loading exists on the node (EXISTING-SUBSTRATE §1.14). | Each of FL-03…FL-14 would edit the same two files.                                                                                                                                                                                                                                                                                               |
| Stop everything                     | The kill switch is read fail-closed by dispatch, routing and lease (`packages/agent/src/fleet/fleet-kill-switch.service.ts:23-40`).                                                                                                                                                                                               | No live channel consults it; a leg opened before the stop keeps forwarding input.                                                                                                                                                                                                                                                                |
| Keep nodes current                  | `FLEET_MIN_NODE_VERSION` floor; a below-floor node keeps beating and is refused work (`fleet-node.types.ts:563-584`; `apps/node/src/core/node-lifecycle.ts:8-25`).                                                                                                                                                                | The verdict lives in a drawer badge and `doctor`; there is no self-update and no canary (EXISTING-SUBSTRATE §1.11, gap 12; `docs/features/fleet.md` §"Keeping nodes current").                                                                                                                                                                   |
| Use the desktop shell               | `apps/desktop-node` shares the node core but passes no live-view consent (`apps/desktop-node/src/main/main.ts:138`; zero matches for "attend" under `apps/desktop-node/src`).                                                                                                                                                     | Every computer-page tab shows "not available on this kind of computer yet" for those machines (R-10).                                                                                                                                                                                                                                            |

### 2.3 Why this epic is additive only

The existing computer-session leg, its gateway and both relays keep working unchanged in P1. In P2
the leg is re-homed onto the link behind a node-side switch with the old path kept as the fallback;
retiring it is a separate change for the owner to approve, not part of this epic. No consent is
removed: `--work` and `--attend` mean exactly what they mean today;
`--manage` is a fourth, independent flag. The heartbeat gains one optional field.

---

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — The link opens with a consent.** **Given** `build-01` is enrolled and its owner runs
  `ever-works-node start --work --manage`, **when** the first heartbeat is accepted, **then** within
  5 seconds the node opens the link, the computer page header reads _"Link ● connected · work ·
  manage"_, and the consents row shows ✔ work, ✖ attend, ✔ manage with the attend fix command.
- **S2 — Enrolled only means no link.** **Given** a node started with no consent flag, **when** it
  heartbeats, **then** no link is opened, the header reads _"Link ○ not open — this computer only
  reports health"_, and every tab that needs the link names the consent it is missing.
- **S3 — A channel opens, works, closes.** **Given** a connected link and a caller in the `view`
  family audience (`health.now` is a read allowed on any open link — CONTRACTS R-31, §2.1), **when**
  FL-03's **Refresh now** is pressed, **then** the platform opens a
  `machine` channel (or reuses the one already open), sends the request with a `requestId`,
  receives the reply within 3 seconds at p95, and the card updates; the channel stays open for
  further requests.
- **S4 — Consent missing is named.** **Given** a node with `--work` only, **when** anyone asks for a
  `logs` channel, **then** the platform refuses before touching the node with `consent_missing` and
  the hint _"start the node with `--manage` on build-01"_, and the tab shows that sentence with a
  copy button.
- **S5 — Permission denied is named.** **Given** a node whose `services` family audience is
  `owner`, **when** an org-admin asks for a `machine` channel to restart a service, **then** the
  platform refuses with `permission_denied` and the hint _"ask the owner of build-01 to allow org
  admins: services"_, and no channel is opened.
- **S6 — A blip resumes, not restarts.** **Given** a session channel is open (FL-04) and the
  network drops for 20 seconds, **when** the node reconnects presenting its previous link
  generation, **then** the platform answers with the next generation, lists the session channel as
  resumed, the viewer's terminal continues without a reattach, and a log tail that could not be
  resumed is closed with `resume_failed` and a one-line notice in its tab.
- **S7 — Two replicas, one viewer.** **Given** the API runs two replicas with Valkey configured,
  **when** the node's link lands on replica A and a viewer's socket on replica B, **then** frames
  flow both ways with no visible difference, and `GET /api/health/ready` reports
  `fleet_relay: { configured: true, mode: 'valkey' }`.
- **S8 — One replica, no Redis.** **Given** a single API process without `REDIS_URL`, **when** it
  boots, **then** relays run in-process, health reports `fleet_relay: single-replica`, and nothing
  else changes; **given** the deployment sets `FLEET_RELAY_REQUIRE_BUS=true` (every multi-replica
  deployment does, CONTRACTS R-7) without a bus, **then** boot fails with a message naming the
  setting.
- **S9 — Kill switch.** **Given** channels are open on three computers, **when** a platform admin
  throws the kill switch, **then** within 5 seconds every new channel request is refused with
  `kill_switch`, every open channel receives a pause notice (daemon sessions are paused by FL-04,
  processes left running), the hub shows the stop banner, and clearing the switch resumes without
  reconnecting.
- **S10 — Drain all.** **Given** the owner presses **Drain all**, **when** owner sessions exist
  (FL-04), **then** each receives a 60-second warning before it is ended; Agent sessions end as
  Runs end today.
- **S11 — Upgrade required, in the hub.** **Given** the platform's floor is `0.3.0` and
  `build-02` runs `0.2.1`, **when** the owner opens the hub, **then** `build-02`'s card and header
  carry _"Upgrade required"_ with the exact command to run on that machine, and the computer keeps
  reporting health.
- **S12 — Opt-in self-update.** **Given** the owner started `build-02` with `--auto-update`,
  **when** the platform raises its floor or names a recommended version, **then** the node upgrades
  itself within 10 minutes, restarts under its service manager, logs the before/after versions, and
  the platform records the change; a node without the flag only reports.
- **S13 — Desktop shell parity.** **Given** a computer running the desktop shell, **when** its owner
  ticks _Allow managing this computer_ in the wizard or the tray, **then** its heartbeat reports
  `manage: true`, the link opens, and the hub stops saying "not available on this kind of computer
  yet" for manage-family tabs.
- **S14 — An Agent polls a long operation.** **Given** a request replied with an `operationId`,
  **when** an Agent polls the operations endpoint, **then** it reads progress and the final result
  with the same error envelope every other surface uses.

### 3.2 Edge cases and failures

- **U1 — Node offline.** A channel request for a node with no link answers `unreachable` with the
  hint _"last seen 12 min ago"_ (FL-03 adds _"wake it from build-02?"_); nothing is queued.
- **U2 — Link flag off.** `FLEET_NODE_LINK_ENABLED=false`: the platform refuses the upgrade; the node
  logs once _"The platform does not accept node links yet"_ and retries every 5 minutes; everything
  that works today keeps working.
- **U3 — Token replay.** A link token presented twice is refused the second time; a token for node A
  presented by node B is refused; both are the same undifferentiated close code the node
  credential paths use.
- **U4 — Plain `http:` platform.** A node pointed at a non-loopback `http:` origin never opens the
  link and never mints a token; it logs the same one-line warning the existing leg logs.
- **U5 — Oversized frame.** A frame over 16 MiB is refused before parse and the channel is closed
  with `invalid`; the link stays up.
- **U6 — Too many channels.** The 65th channel on a link is refused with `limit_exceeded` and the
  hint _"64 channels are open on build-01; close one"_.
- **U7 — Node refuses a family it does not have.** A `machine` verb no module registered answers
  `unsupported_on_node` with the verb and the node version in the hint.
- **U8 — Heartbeat silence.** No pong for 45 seconds: both sides close; the HTTPS heartbeat is
  unaffected, so the computer stays "online" until its own threshold; the header reads _"Link ○
  reconnecting…"_.
- **U9 — Reconnect storm.** A node must not retry faster than the backoff; the platform refuses a
  node that presents more than 10 hellos in a minute for 60 seconds with `limit_exceeded`.
- **U10 — Consent withdrawn while channels are open.** The node is restarted with `--work` only:
  its next heartbeat reports `manage: false`, the platform closes every manage-family channel with
  `consent_missing`, writes one audit row, and the tabs show the fix sentence.
- **U11 — Platform older than the node.** A node sends `consents` to a platform that rejects unknown
  heartbeat fields; the node retries without the newest tier, keeps beating, and does not open the
  link.
- **U12 — Node older than the platform.** A node that never sends `consents` is treated as
  `manage: false`, `attend` and `work` inferred from its tags as today; no link is expected of it.
- **U13 — Replica loses the bus.** Valkey becomes unreachable mid-session: the replica keeps serving
  what it holds locally, refuses cross-replica attaches with `unreachable` and the hint _"relay bus
  unavailable"_, and health goes degraded.
- **U14 — Viewer token for the wrong channel.** A session attach token presented to a logs socket is
  refused; a `viewer` token sending input is answered with an error frame and never forwarded.
- **U15 — Mid-action drop.** A command is running (FL-12) when the link drops and does not resume
  within the backoff: the command channel is closed with `resume_failed`, the output card says so,
  and the node finishes the command locally with its output kept for the next link.
- **U16 — Self-update fails.** The package install fails: the node keeps running the old version,
  logs the error once, reports `upgradeRequired` as before, and the hub shows _"Self-update failed
  on build-02 — run the command yourself"_.

---

## 4. Functional requirements

### 4.1 P1 — Opening the link

- **FR-1** A node MUST open the link only after an accepted heartbeat and only when at least one of
  `work`, `attend`, `manage` is on.
- **FR-2** A node with no consent beyond enrolment MUST NOT open the link and MUST say so in its
  startup log.
- **FR-3** The node MUST mint a link token through its node credential before each connection
  attempt; the token MUST live 5 minutes and MUST be accepted at most once.
- **FR-4** The node's first frame MUST be a hello carrying its id, the protocol version, its
  capability tags, its consents and the token; the platform MUST answer with a ready carrying a link
  generation, the limits, and the server time, or close.
- **FR-5** A hello presenting a used, expired, foreign or malformed token MUST be refused with one
  undifferentiated close code.
- **FR-6** The node MUST never open the link to a plain `http:` origin other than its own loopback.
- **FR-7** Both sides MUST exchange a ping/pong every 15 seconds and MUST close after 45 seconds
  without one.
- **FR-8** The node MUST reconnect with exponential backoff from 1 second to 30 seconds with jitter,
  resetting only after a ready was received.
- **FR-9** A reconnecting node MUST present its previous link generation; the platform MUST resume
  every channel the node reports it still holds and MUST close the rest with `resume_failed`.
- **FR-10** With `FLEET_NODE_LINK_ENABLED` off the platform MUST refuse every link upgrade and the
  node MUST retry no more than every 5 minutes.

### 4.2 P1 — Framing and channels

- **FR-11** Every frame MUST carry a channel number, a kind and a length, MUST be at most 16 MiB,
  and MUST be refused before parsing when larger.
- **FR-12** Channel 0 MUST carry control messages only; channels above 0 MUST be opened by the
  platform, never by the node.
- **FR-13** A channel open MUST name a family and parameters; the node MUST answer ready or a
  refusal carrying a code and a hint.
- **FR-14** Either side MUST be able to close a channel with a reason; a closed channel number MUST
  NOT be reused on the same link generation.
- **FR-15** At most 64 channels MAY be open on one link; the 65th MUST be refused with
  `limit_exceeded`.
- **FR-16** Every request on a channel MUST carry a request id and every reply MUST echo it, with
  either a result or an error carrying a code, a hint and details.
- **FR-17** A request the node cannot finish within 2 seconds MUST reply at once with an operation id
  and MUST report progress and completion on channel 0.
- **FR-18** The platform MUST expose each operation by id for polling until 1 hour after completion,
  and MUST let the caller cancel a running one by id, which sends `operation.cancel` to the node
  (CONTRACTS §3.2–3.3).
- **FR-19** A verb no node module handles MUST answer `unsupported_on_node` naming the verb.

### 4.3 P1 — Consent, authorisation, audit, kill switch

- **FR-20** The node MUST accept a `--manage` flag on `start`, independent of `--work` and
  `--attend`, and MUST advertise the `managed` tag only when it is on.
- **FR-21** Every heartbeat MUST carry the node's consents `{ work, attend, manage, usageScan }`
  (CONTRACTS §1.1; `usageScan` false until FL-20 adds `--usage-scan`); the platform MUST store them
  on the computer and MUST treat an absent field as `manage: false`, `usageScan: false`.
- **FR-22** A change of consents between two heartbeats MUST write one audit row and MUST close
  every channel whose family lost its consent.
- **FR-23** Before opening a channel the platform MUST check, in order: kill switch, the family's
  consent, the caller's membership of the family's audience; the first failure MUST be returned and
  the node MUST NOT be contacted.
- **FR-24** The node MUST independently refuse a channel whose family's consent it does not hold,
  whatever the platform asked.
- **FR-25** Opening a channel in a state-changing family MUST write one audit row naming the
  family, the target and the caller; read-only families MUST NOT be audited on open.
- **FR-26** When the kill switch is on, every channel open MUST be refused with `kill_switch` and
  every open channel MUST receive a pause notice within 5 seconds; clearing the switch MUST send a
  resume notice without reconnecting.
- **FR-27** Drain-all MUST send a 60-second warning on every owner-session channel before ending it,
  and MUST end Agent-session channels as it ends Runs today.
- **FR-28** The computer page header MUST show the link state (`connected`, `reconnecting`, `not
open`) with the consents in force, and MUST name the missing consent's command.

### 4.4 P2 — Relay bus and viewers

- **FR-29** With `REDIS_URL` set, every relay (terminal, computer, link channels) MUST publish and
  subscribe through Valkey so any replica can serve any viewer.
- **FR-30** Without `REDIS_URL` the API MUST run in-process relays and MUST report
  `fleet_relay: single-replica` in its readiness output.
- **FR-31** With `FLEET_RELAY_REQUIRE_BUS=true` and no bus configured, the API MUST fail at boot
  with a message naming the setting, never run a silently degraded relay (CONTRACTS R-7, §9).
- **FR-32** Viewers MUST attach to a channel through a 60-second single-use token carrying a role of
  `viewer` or `driver`, presented in the first frame and never in a URL.
- **FR-33** The viewer gateway MUST bridge a browser socket to the node channel, MUST role-check
  every inbound frame, and MUST never forward input from a `viewer`.
- **FR-34** The existing computer-session leg MUST be served over a link channel when the link is
  up, and MUST fall back to today's leg when it is not, with no change visible to the viewer.
- **FR-35** Losing the bus mid-session MUST keep local sessions alive, MUST refuse cross-replica
  attaches with `unreachable`, and MUST mark health degraded.

### 4.5 P3 — Lifecycle and parity

- **FR-36** A computer below the version floor MUST be shown in the hub with "Upgrade required" (the
  state word FL-03's state mapping supplies) and the exact upgrade command, MUST raise one
  `node-upgrade-required` "needs a look" item (`info`, CONTRACTS §4.6, R-23), and MUST keep
  reporting health.
- **FR-37** A node started with `--auto-update` MUST upgrade itself within 10 minutes of the platform
  raising the floor above its version or naming a recommended version, MUST restart under its
  service manager, and MUST log before and after versions.
- **FR-38** A node without `--auto-update` MUST only report; a failed self-update MUST leave the old
  version running and MUST be reported in the hub.
- **FR-39** The desktop shell MUST offer `work`, `attend` and `manage` in its wizard and tray (the
  usage-scan consent arrives with FL-20), MUST pass them
  into the shared runtime, and MUST report them in its heartbeat.
- **FR-40** Until the desktop shell ships consents, the platform MUST show "not available on this
  kind of computer yet" for any family whose consent that kind cannot report.

### 4.6 Cost and honesty

- **FR-41** The link MUST spend no model tokens; the computer page MUST show the bytes sent and
  received over the link since it connected.
- **FR-42** The link indicator MUST never read "connected" from a stale heartbeat; it MUST reflect
  the platform's own socket state.

### 4.7 P3 — Management lane (CONTRACTS R-34)

- **FR-43** The node MUST run a **management lane**, modelled on the existing attended lane, that
  leases only the job kinds later epics register for it (`vm-create`, `vm-control` under `--manage`;
  `runner-install`, `runner-control` under `--work`; `usage-scan` under `--usage-scan` — CONTRACTS
  R-34, §12) and only while the matching consent is on.
- **FR-44** Management-lane jobs MUST never count against the node's `--concurrency`, and the work
  lane MUST never lease them. This epic ships the lane with an empty kind set; FL-16, FL-18 and FL-20
  each add their kinds.

---

## 5. UX

### 5.1 Computer page header (FL-01 shell, this epic's line)

```
│ ← Fleet   build-01   ● Online · Linux · checked 09:41 · up 3 d       [New session ▾] [Desktop] [⋯] │
│ Link ● connected · work · manage · 12.4 MB this link                                                │
```

States: _"Link ● connected · work · attend · manage"_ · _"Link ○ reconnecting… (last 20 s ago)"_ ·
_"Link ○ not open — this computer only reports health"_ · _"Link ○ not accepted by this
deployment"_ (flag off) · _"Link — not available on this kind of computer yet"_ (R-10).

### 5.2 Consents row (Overview tab, "This computer" block)

```
┌ What build-01 lets Ever Works do ─────────────────────────────────────────────┐
│ ✔ Run work (--work)       ✖ Live viewing (--attend)       ✔ Manage (--manage) │
│ Live viewing is off. Run this on build-01 to turn it on:                      │
│    ever-works-node start --work --attend --manage                      [copy] │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Refusals as the tabs show them

- Consent missing: _"Start the node with `--manage` on build-01 to use Logs."_ `[copy]`
- Permission denied: _"Ask the owner of build-01 to allow org admins: services."_
- Kill switch: the shared stop banner; tab body: _"Live actions are paused while all computers
  are stopped."_
- Unreachable: _"build-01 is not connected. Last seen 12 min ago."_ `[ Try again ]`
- Resume failed (inline in the affected tab): _"The connection dropped and this tail could not be
  resumed. Follow again?"_ `[ Follow ]`
- Unsupported: _"build-01 (node 0.2.1) cannot do this yet."_

### 5.4 Upgrade required

Card chip and header word _"Upgrade required"_; tooltip and Settings tab:

```
┌ Node version ──────────────────────────────────────────────────────────────────┐
│ build-02 runs ever-works-node 0.2.1. This deployment needs 0.3.0 or newer.     │
│ It keeps reporting health but takes no work until it is upgraded.              │
│    npm install -g ever-works-node@latest && sudo systemctl restart ever-works-node@$USER   [copy] │
│ Self-update: off on this computer. Start it with --auto-update to let it      │
│ upgrade itself when the platform asks.                                         │
└────────────────────────────────────────────────────────────────────────────────┘
```

After a failed self-update: _"Self-update failed on build-02 at 09:12 — run the command yourself."_

### 5.5 Desktop shell wizard step

```
┌ What may this computer do? ────────────────────────────────────────────────────┐
│ [ ] Run work for my agents                (lease jobs)                         │
│ [ ] Allow live viewing from the dashboard (screen, desktop)                    │
│ [ ] Allow managing this computer          (logs, services, files, commands…)   │
│ Each can be changed later from the tray.                                       │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 5.6 Health output (operators)

`GET /api/health/ready` → `fleet_relay: { configured: true, mode: 'valkey' | 'single-replica',
status: 'up' | 'degraded' }`.

### 5.7 Node CLI

`ever-works-node start --work --attend --manage [--auto-update]`; `status` and `doctor` print the
consents in force and the link state (`connected since …`, `not open: no consent`, `refused by
platform: flag off`).

### 5.8 Keyboard, states, accessibility

The link line is a `status` region; every refusal sentence is a key under `fleet.errors.*` and
`fleet.link.*`; copy buttons announce "copied". No new shortcuts.

---

## 6. Non-functional requirements

- **Performance:** request round-trip over an open channel ≤ 300 ms at p95 on a ≤ 50 ms link;
  channel open ≤ 1 s at p95; reconnect resume ≤ 5 s after the network returns; a link idles at
  one ping per 15 s and nothing else.
- **Reliability:** a link drop never ends a daemon session (FL-04) or a running command; the
  platform never queues a request for an absent link; one misbehaving channel cannot stall the
  others (per-channel buffers, slow-reader drop after 5 s).
- **Security & privacy:** outbound-only; token in the first frame only; tokens bound to one node
  and one use; consent re-checked on the node; family audience checked on the platform; frame
  size capped before parse; no payload is logged; audit rows carry family, target and caller only.
- **Observability:** link connect/disconnect/resume counters per node; channel opens per family;
  refusals per code; bus publish latency; health indicator.
- **Compatibility:** heartbeat gains one optional field; existing leg, gateways and relays keep
  their wire shapes; the node tolerates an older platform by dropping the newest tier.

---

## 7. Key entities & concepts

| Entity / concept              | New?                | Description                                                                                                                                         |
| ----------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node link**                 | **NEW**             | The one multiplexed outbound connection per node; has a generation, limits, consents and open channels. Not stored.                                 |
| **Channel**                   | **NEW**             | One stream on a link, with a family, parameters, a lifecycle (open → ready/refused → closed) and a resume rule.                                     |
| **Channel family**            | **NEW** (enum)      | `session · desktop · logs · machine · files · command · schedule · tunnel · clip` (CONTRACTS §3.3).                                                 |
| **Consent**                   | Existing + 2        | `work`, `attend`, the new `manage` and the new `usageScan` (flag added by FL-20); reported in every heartbeat, stored on the Node (CONTRACTS §1.1). |
| **Node module**               | **NEW** (internal)  | A unit inside the node runtime owning tags and channel families; composed at compile time (D8).                                                     |
| **Management lane**           | **NEW** (internal)  | The node's third lease loop for machine jobs (CONTRACTS R-34); outside `--concurrency`.                                                             |
| **Link token / attach token** | **NEW** / Existing  | Node-side 5-minute single-use token; viewer-side 60-second single-use token with a role.                                                            |
| **Operation**                 | **NEW** (ephemeral) | A long request's id, progress and result, kept 1 hour; cancellable.                                                                                 |
| **Relay bus**                 | **NEW**             | The cross-replica fan-out behind every relay; Valkey when configured, in-process otherwise.                                                         |
| **Node**                      | Existing            | Gains `consents`; its control policy (FL-01) is what the platform checks per family.                                                                |
| **Fleet audit**               | Existing            | Receives consent changes and state-changing channel opens.                                                                                          |

**Acts this epic adds (rule 7).**

| Act                              | Consent                     | Family / audience             | Confirmation | Audit (CONTRACTS §7)                                      | Errors                                                                                                        | Agent tool                                     |
| -------------------------------- | --------------------------- | ----------------------------- | ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Link connect / disconnect (node) | any of work, attend, manage | — (the node's own credential) | —            | `node.link.connect`, `node.link.disconnect`               | close codes only (auth, flag off, rate)                                                                       | —                                              |
| Open a channel (platform)        | the family's (§3.3)         | the family's (§2.1)           | the verb's   | `node.link.channel-open` for state-changing families only | `kill_switch`, `consent_missing`, `permission_denied`, `unreachable`, `limit_exceeded`, `unsupported_on_node` | —                                              |
| Consent change (node restart)    | —                           | —                             | —            | `node.consent.change`                                     | —                                                                                                             | —                                              |
| Read an operation                | —                           | the operation's family        | `plain`      | — (read)                                                  | `not_found`                                                                                                   | `fleet_operations_get` · readOnly              |
| Cancel an operation              | the operation's family      | the operation's family        | `plain`      | the operation's own verb row                              | `not_found`, `unreachable`, `kill_switch`                                                                     | `fleet_operations_cancel` · destructive: false |

Kill switch (R-24): every channel open is refused `kill_switch`, open channels are paused (input
blocked, processes left running), clearing resumes without a reconnect; drain-all warns owner
sessions 60 s before ending them.

---

## 8. Out of scope

- The content of any family: sessions (FL-04), desktop (FL-07), logs (FL-08), services/Docker/
  processes (FL-09), ports and tunnel (FL-10), files and clipboard (FL-11), commands (FL-12),
  schedules (FL-13), checkouts (FL-14). This epic opens channels; those epics speak on them.
- The session daemon and screen replay (FL-04).
- Any inbound connection to a machine, any listening port, any platform-held machine credential —
  refused by D2.
- A node-side runtime plugin system (D8).
- Code signing of the node package (the self-update installs from the package registry the node
  was installed from).

## 8b. Open questions

- **Resolved** by CONTRACTS §7: `node.link.channel-open` (details `family`, `target`,
  `requestedBy`; state-changing families only) and `node.link.connect|disconnect` (node actor).
- **Resolved** by CONTRACTS R-7: the readiness key is `fleet_relay` (snake_case like its siblings).
- **Resolved** by CONTRACTS R-7 / §9: the multi-replica signal is the operator setting
  `FLEET_RELAY_REQUIRE_BUS=true`; without it a single process is assumed. The relay mode itself is
  derived from `REDIS_URL` alone — there is no second mode setting.
- **Resolved** by CONTRACTS §1.1: the heartbeat response gains optional `recommendedNodeVersion`; its
  value comes from the operator setting `FLEET_RECOMMENDED_NODE_VERSION`, the sibling of the
  existing `FLEET_MIN_NODE_VERSION` value (a value, not a §9 feature flag).
- **Resolved** by CONTRACTS §4.6 / R-23: `node-upgrade-required` (`info`) is a "needs a look" kind and
  this epic registers its producer (FR-36).
- **Resolved** by CONTRACTS R-7: a multi-replica deployment without the bus is a configuration error
  (`FLEET_RELAY_REQUIRE_BUS=true` on every such deployment), so per-process single-use enforcement
  without Valkey is accepted.
- **Resolved** by CONTRACTS §3.1: its 1 s → 30 s backoff governs the link; the existing computer
  leg keeps its own 2 s → 30 s ladder unchanged while it remains the fallback.
- **Resolved** by CONTRACTS §3.2 (rev 3): platform → node `link.pause`, `link.resume` and `link.drain { graceSec }` on channel 0.
- **Resolved** by CONTRACTS §10.1 (rev 3): the link rates and timings are fixed there (hello 10/min then 60 s refusal, operation id after 2 s, operations kept 1 h, slow viewer dropped after 5 s, flag-off retry every 5 min, link-token 20/min, attach-token 30/min).
- `[NEEDS CLARIFICATION: Self-update is the owner's call — CONTRACTS §1.1 adds `recommendedNodeVersion`only "so the node can show an upgrade hint", and EXISTING-SUBSTRATE gap 12 assigns self-update to no epic. Default until answered: ship`--auto-update`as a per-machine opt-in, off unless the machine owner passes it, installing only from the package registry the node came from and reporting a failed attempt as an optional`selfUpdateFailedAt` in the heartbeat's newest tier (a heartbeat field CONTRACTS §1.1 does not yet list); without the flag the node only shows the hint.]`

---

## 9. Acceptance criteria

**P1**

- [ ] `ACC-FL02-01` (FR-1, FR-2) A node started with `--manage` opens the link within 5 s of its
      first accepted heartbeat; a node with no consent flag never does and logs why.
- [ ] `ACC-FL02-02` (FR-3, FR-5) A link token is accepted once; a replay, an expired token and a
      token for another node are refused with one close code.
- [ ] `ACC-FL02-03` (FR-4) The hello/ready exchange carries tags, consents, token, generation,
      limits and server time, and the wire fixture matches byte for byte.
- [ ] `ACC-FL02-04` (FR-6) A non-loopback `http:` origin yields no token request and no socket.
- [ ] `ACC-FL02-05` (FR-7, FR-8, FR-9) 45 s of silence closes both ends; reconnects back off 1 s →
      30 s with jitter; a presented generation resumes a resumable channel and closes a
      non-resumable one with `resume_failed`.
- [ ] `ACC-FL02-06` (FR-11, FR-15) A 16 MiB + 1 frame is refused before parse; the 65th channel is
      refused with `limit_exceeded` and the stated hint.
- [ ] `ACC-FL02-07` (FR-12, FR-13, FR-14) A node-initiated open is refused; ready/refused carry
      code and hint; a closed channel number is not reused on the same generation.
- [ ] `ACC-FL02-08` (FR-16, FR-17, FR-18, FR-19) Replies echo request ids; a slow request yields an
      operation id with progress on channel 0 and is pollable for 1 h; an unknown verb answers
      `unsupported_on_node` naming it.
- [ ] `ACC-FL02-09` (FR-20, FR-21, FR-22) `--manage` advertises `managed`; `consents` reach the
      node row; a consent withdrawn between beats writes `node.consent.change` and closes the
      affected channels.
- [ ] `ACC-FL02-10` (FR-23, FR-24) Kill switch, consent and audience are checked in that order
      with no node contact on failure; the node refuses a manage-family open it was never told to
      allow.
- [ ] `ACC-FL02-11` (FR-25) Opening a `command` channel writes one audit row; opening a `logs`
      channel writes none.
- [ ] `ACC-FL02-12` (FR-26, FR-27) Throwing the kill switch refuses opens with `kill_switch` and
      pauses open channels within 5 s; clearing resumes without reconnect; drain-all warns owner
      sessions 60 s ahead.
- [ ] `ACC-FL02-13` (FR-10, FR-28) Flag off: upgrade refused, node retries every 5 min; the header
      shows the correct link state and the missing consent's command.

**P2**

- [ ] `ACC-FL02-14` (FR-29, FR-30, FR-31) With `REDIS_URL`, a viewer on replica B sees frames from a
      node on replica A; without it health says `single-replica`; `FLEET_RELAY_REQUIRE_BUS=true`
      without Redis fails boot naming the setting.
- [ ] `ACC-FL02-15` (FR-32, FR-33) A 60 s single-use token with role `viewer` attaches; a second use
      is refused; a `viewer` input frame is answered with an error and never forwarded.
- [ ] `ACC-FL02-16` (FR-34) The AW-11 watch and take-over e2e specs pass with the leg on the link
      and with the fallback leg forced.
- [ ] `ACC-FL02-17` (FR-35) Killing Valkey mid-session keeps the local viewer alive, refuses a
      cross-replica attach with `unreachable`, and degrades health.

**P3**

- [ ] `ACC-FL02-18` (FR-36) A below-floor node shows "Upgrade required" and the exact command on
      card, header and Settings tab, and keeps heartbeating.
- [ ] `ACC-FL02-19` (FR-37, FR-38) With `--auto-update`, raising the floor upgrades the node within
      10 min and logs both versions; without it nothing is installed; a failed install is reported
      in the hub.
- [ ] `ACC-FL02-20` (FR-39, FR-40) The desktop shell reports the ticked consents; before that
      every manage/attend tab reads "not available on this kind of computer yet".
- [ ] `ACC-FL02-21` (FR-41, FR-42) The header shows bytes over the link and reads "connected" only
      while the platform holds the socket.
- [ ] `ACC-FL02-22` (FR-18) Cancelling a running operation by id sends `operation.cancel`, the node
      stops it, and the operation reads cancelled with the shared error envelope.
- [ ] `ACC-FL02-23` (FR-43, FR-44) A test kind registered on the management lane is leased only with
      its consent on, never by the work lane, and leasing it does not reduce the work lane's
      `--concurrency` slots.

---

## 10. Constitution gates

- [x] **I — Plugin-first.** Valkey is reached through the Redis client the API already depends on;
      node modules are not integrations (D8); nothing external is added.
- [x] **II — Capability-driven.** No provider resolution; the relay bus is an operator setting, not
      a plugin choice.
- [x] **III — Source-of-truth repos.** Nothing stored but consents and audit rows.
- [x] **IV — Job runtime.** No background jobs; operations are ephemeral request state, not work.
- [x] **V — Forward-only migrations.** One additive migration (`consents`, plus the
      `previewProfileEnabled` column CONTRACTS §13 places in the same slot for FL-10).
- [x] **VI — Tests.** Contract codec fuzz, node, API gateway, bus, e2e named in the plan.
- [x] **VII — Secrets.** Tokens never in URLs or logs; node credential never leaves the node; no
      payload logged.
- [x] **VIII — Plugin counts.** No plugin.
- [x] **IX — Behaviour-first.** No class, file or endpoint named here.
- [x] **X — Backwards compatibility.** Optional heartbeat field; existing gateways and relays keep
      their shapes; the legacy leg stays as the fallback (retiring it is a separate owner decision).

---

## 11. References

- Program: [Fleet README](../README.md) D2, D3, D8, D12 · [CONTRACTS](../CONTRACTS.md) §0 R-7,
  R-10, R-23, R-24, R-26, R-31, R-34; §1; §3 (the protocol this epic implements); §4.6; §7; §8; §9;
  §10; §12; §13 ·
  [Capability map](../CAPABILITY-MAP.md) row A "Direct peer-to-peer link" (adopt one multiplexed
  outbound link)
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Related epics: [AW-11 Agent computers](../../agent-workspace/AW-11-agent-computers/spec.md)
  (the leg and gateways this generalises), FL-01 (families), FL-03 (first verbs), FL-04 (first
  resumable channel).
- Existing docs: `docs/features/fleet.md` §"Keeping nodes current", §"Connect a machine";
  `docs/specs/security/fleet-session-trust-model.md`.
