# FL-02 — Node link & runtime foundations · Implementation plan

> How [`spec.md`](./spec.md) gets built. Implementation detail belongs here, not in the spec
> (Constitution IX). Every path below was opened at `origin/develop` `e4334baf7` before it was cited.

**Epic ID:** `FL-02-node-link`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    subgraph browser [Browser]
        TAB[computer-page tab] -->|BFF: attach-token| BFF
        TAB -->|wss /ws/fleet/family/id, token in first frame| VGW
    end
    subgraph api [apps/api]
        BFF[BFF route] --> FLC[FleetLinkController\n/link-token · /operations/:id · /…/attach-token]
        VGW[FleetLinkViewerGateway] --> BRIDGE[FleetLinkRelay\nviewer socket <-> node channel]
        LGW[FleetLinkGateway\n/ws/fleet/link] --> LINKS[FleetLinkRegistry\nlinks · generations · channels]
        LINKS --> AUTHZ[FleetLinkAuthorizer\nkill switch -> consent -> family audience]
        AUTHZ --> KS[FleetKillSwitchService]
        AUTHZ --> ACCESS[FleetAccessService FL-01]
        AUTHZ --> AUD[FleetAuditService]
        BRIDGE <--> BUS[(RelayBus: Valkey | in-process)]
        LINKS <--> BUS
        HB[FleetController /heartbeat] --> FN[(fleet_nodes.consents)]
        HEALTH[/api/health/ready fleet_relay/] --> BUS
    end
    subgraph node [apps/node · ever-works-node]
        RT[runtime.ts] --> HBL[HeartbeatLoop + consents]
        RT --> LINK[link/link-client.ts\nhello · ready · ping · reconnect · resume]
        LINK --> MUX[link/channel-mux.ts\nframing · 64 channels · 16 MiB]
        MUX --> MODS[link/modules/registry.ts]
        MODS --> CTRL[control module ch0]
        MODS --> MACH[machine module: verb router]
        MODS -. FL-03.. .-> OTHERS[health · session · logs · files …]
        MACH --> OS[(OS shell-outs)]
    end
    LGW <-->|binary frames| LINK
    HBL -->|HTTPS 60 s| HB
```

Data flows back the same way: a module reply → channel frame → `FleetLinkRegistry` → either the
REST caller waiting on its `requestId`, or the bridge → viewer socket (via the bus when the viewer is
on another replica). Heartbeat and leasing stay HTTPS (CONTRACTS §3.1).

## 2. Current state in the codebase

| Piece                                                        | Where (verified)                                                                                                                                                                                                                                                                                                               | Reused as                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| The outbound computer-session leg                            | `apps/node/src/core/screen/node-leg.ts` — secure-origin rule `:76-89`, token-in-first-frame `:142-148`, backoff with acceptance window `:37-46, :107-116`, reconnect `:171-177`                                                                                                                                                | Generalised: the socket mechanics move to `apps/node/src/core/link/link-socket.ts`; `node-leg.ts` keeps its API |
| Worker-token minting through the node credential             | `apps/api/src/computer/computer-internal.controller.ts:180-201` (`FleetNodeAuthGuard`, `wsPath` returned)                                                                                                                                                                                                                      | Pattern for `POST /api/fleet/link-token`                                                                        |
| Node credential guard                                        | `apps/api/src/fleet/guards/fleet-node-auth.guard.ts:1-45` (`AuthenticatedFleetNode { id, userId, organizationId, capabilities }`)                                                                                                                                                                                              | Guards `/link-token`                                                                                            |
| Computer WS gateway sharing the HTTP `upgrade` event         | `apps/api/src/computer/computer-ws.service.ts:27-69` (`noServer`, query string refused, 4001 after 5 s, 30 s ping / 2 pongs, `COMPUTER_WS_PATH_PREFIX`); terminal gateway's foreign-prefix list `apps/api/src/terminal/terminal-ws.service.ts:44-50`                                                                           | Shape for the link gateway and the viewer gateway; `TERMINAL_WS_FOREIGN_PATH_PREFIXES` gains `/ws/fleet/`       |
| Attach-token signer (HMAC, 60 s, fail-closed, channel claim) | `apps/api/src/terminal/terminal-attach.service.ts:1-44`; computer wrapper `apps/api/src/computer/computer-attach.service.ts:1-50`                                                                                                                                                                                              | Reused for viewer tokens with a new channel claim `fleet-link`; a second signer is not written                  |
| Relay registries and the cross-replica seam                  | `apps/api/src/terminal/terminal-relay.registry.ts:71-82` (`TerminalFanoutBus`, `InProcessTerminalFanoutBus`), `:130` token, `:156-159` optional injection; `apps/api/src/computer/computer-relay.registry.ts:29-34, 99-102` (adds `publishRemote` delivery answer), `apps/api/src/computer/computer.module.ts:62-70` providers | The seam gets a Valkey implementation bound to both tokens                                                      |
| Redis client and detection                                   | `apps/api/package.json:74` (`ioredis ^5.10.1`); `apps/api/src/health/service-detection.ts:28-30` (`getRedisUrl`); `apps/api/src/health/indicators/redis.indicator.ts` (per-check client); `apps/api/src/config/throttler.config.ts`                                                                                            | One shared `RelayBusRedis` provider; health indicator pattern                                                   |
| Health readiness composition                                 | `apps/api/src/health/health.controller.ts:85-100` (`detectInformationalServices` loop)                                                                                                                                                                                                                                         | `fleet_relay` indicator added to the informational list                                                         |
| Kill switch (fail-closed read)                               | `packages/agent/src/fleet/fleet-kill-switch.service.ts:23-40`; panic routes `apps/api/src/fleet/fleet-panic.controller.ts`                                                                                                                                                                                                     | Consulted on every channel open; panic drain triggers the 60 s warning                                          |
| Consents today                                               | `apps/node/src/cli/program.ts:1545-1552` (`start`, `--work`, `--attend`), `:464` (`attendEnabled`); `apps/node/src/core/runtime.ts:476-482` (`attendEnabled`), `:555-566` (attended environment), `:1026-1060` (`createAttendedLane`)                                                                                          | `manageEnabled` added beside `attendEnabled`                                                                    |
| Heartbeat field tiers                                        | `apps/node/src/core/heartbeat.ts:72-90` (`OPTIONAL_DESCRIPTION_FIELD_TIERS`, newest first); `:98-105` `onAccepted`                                                                                                                                                                                                             | `consents` joins the newest tier; `onAccepted` carries `recommendedNodeVersion`                                 |
| Heartbeat contract and DTO                                   | `packages/contracts/src/fleet/fleet-node.types.ts:532-600` (`FleetHeartbeatRequest`, `FleetHeartbeatResponse` with `pendingComputerSessions`, `minNodeVersion`, `upgradeRequired`); DTO `apps/api/src/fleet/dto/fleet.dto.ts` (whitelist + forbidNonWhitelisted)                                                               | `consents` added to both                                                                                        |
| Node heartbeat handling                                      | `packages/agent/src/fleet/fleet.service.ts:534-630` (`heartbeat`, patch, `announceWorkerTransition`, `minNodeVersion`/`upgradeRequired` in the result)                                                                                                                                                                         | Stores `consents`; emits `node.consent.change`                                                                  |
| Capability tags                                              | `apps/node/src/core/capabilities.ts:103` (`BASE_CAPABILITIES`), `:277-330` (`detectCapabilities`, `attended`/`screen` rule)                                                                                                                                                                                                    | Modules contribute tags through the registry; `detectCapabilities` concatenates them                            |
| Version floor                                                | `apps/node/src/core/node-lifecycle.ts:8-45`; `apps/node/src/core/worker-loop.ts:217-220` (`describeUpgradeRequired`); `packages/contracts/src/fleet/fleet-node.types.ts:610` (`FLEET_DEFAULT_MIN_NODE_VERSION`); `packages/agent/src/config/` (`config.fleet.getMinNodeVersion`)                                               | Self-update reads the same record                                                                               |
| Desktop shell runtime wiring                                 | `apps/desktop-node/src/main/main.ts:138` (`createNodeRuntime(connectedConfig, io, {…})` without consents); tray `apps/desktop-node/src/main/tray.ts`                                                                                                                                                                           | P3 parity                                                                                                       |
| Audit action union                                           | `packages/contracts/src/fleet/fleet-panic.types.ts:60-131`                                                                                                                                                                                                                                                                     | Gains `node.consent.change` (CONTRACTS §7) and the proposed `node.link.*`                                       |
| Wire-shape conformance harness                               | `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts`, `node-contract.harness.ts`; fixture `packages/contracts/fixtures/fleet-node-contract.v1.json`                                                                                                                                                                | Extended with the link hello/ready fixture                                                                      |

Missing today (grep over `apps/` and `packages/`): any `ws/fleet` path; `--manage`; `consents` in any
contract or heartbeat field; a channel/frame codec other than the computer and terminal JSON frames;
a Valkey fan-out implementation; a `fleet_relay` health key; a node module registry; any self-update.

## 3. Tech choices

| Concern              | Choice                                                                                                                                                                             | Why                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Transport            | `ws` on the API's HTTP server `upgrade` event, `noServer`, binary frames                                                                                                           | Same as the two existing gateways; no socket.io; one origin, one TLS                                       |
| Framing              | Hand-rolled `[channel u32][kind u8][len u32][payload]` BE, 16 MiB cap, in `@ever-works/contracts`                                                                                  | CONTRACTS §3.2; the contracts package is zero-dependency; size-capped before parse like the terminal codec |
| Control messages     | JSON on channel 0 with `type`, `requestId`, `operationId`                                                                                                                          | CONTRACTS §3.3; readable in logs (payloads never logged, types are)                                        |
| Link token           | Signed HMAC token (same signer family as attach tokens) with `nodeId`, `jti`, `exp = 5 min`; `jti` recorded in a seen-set (Valkey `SET NX EX 300`, else in-process `Map` with TTL) | Single-use without a table; bound to the node; fail-closed on missing secret                               |
| Node socket          | Node 22 global `WebSocket` (as `node-leg.ts` uses through `WebSocketFactory`), binary `ArrayBuffer`                                                                                | Already the pattern; injectable factory keeps tests offline                                                |
| Backpressure         | Per-channel credit for `files`/`logs` (`ACK` kind); for other kinds, per-channel bounded queue, slow reader dropped after 5 s                                                      | CONTRACTS §3.2 kinds; one slow tab must not stall a session                                                |
| Relay bus            | `ioredis` pub/sub, one channel per relay key (`fleet:relay:<family>:<id>`), publisher confirms delivery via a 1 s request/response on a reply channel                              | Already a dependency; R-7; the computer relay's seam already expects a delivery answer                     |
| Bus selection        | Valkey whenever `getRedisUrl()` answers (`REDIS_URL`), in-process otherwise — no separate mode setting; `FLEET_RELAY_REQUIRE_BUS=true` fails boot without a bus                    | CONTRACTS R-7, §9                                                                                          |
| Node module registry | Compile-time array in `apps/node/src/core/link/modules/index.ts` of `NodeModule { id, tags(env), families, verbs?, open? }`                                                        | D8; no runtime loading; each epic adds one file and one array entry                                        |
| Self-update          | Node spawns its own package manager (`npm install -g ever-works-node@<version>` or the install path `doctor` detected) then exits code 75 for the service manager to restart       | No downloader of our own; uses the registry the node came from; opt-in                                     |
| Flags                | `FLEET_NODE_LINK_ENABLED` (API accepts links); node has no flags, only consents                                                                                                    | CONTRACTS §9                                                                                               |
| Tests                | Vitest (contracts codec fuzz, node), Jest (api, agent), Playwright (e2e)                                                                                                           | Repo convention                                                                                            |

## 4. Data model

### 4.1 `FleetNode` additions (CONTRACTS §4.1, slot FL-02)

| Column                  | Type                                                                                                                                | Notes                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `consents`              | `simple-json` nullable `{ work, attend, manage, usageScan }` (CONTRACTS "jsonb"; text for SQLite portability like `modelThrottles`) | From heartbeat; `null` = never reported (older daemon) |
| `previewProfileEnabled` | boolean, default `false`                                                                                                            | R-3; column only — FL-10 sets and reads it             |

Migration `apps/api/src/migrations/1796020000000-AddFleetNodeConsents.ts` — `ADD COLUMN consents
text NULL` and `ADD COLUMN previewProfileEnabled boolean NOT NULL DEFAULT false`, each guarded by
`findColumnByName`, `down` drops both. No backfill: a null row reads through one pure function
`effectiveConsents(node)` in contracts as `{ attend: tags include 'attended', work: true when the
node has ever reported a workerState, manage: false, usageScan: false }` — a documented best-effort
inference for pre-FL-02 daemons (lease history is too costly to read per row).

### 4.2 Contracts (`packages/contracts/src/fleet/`)

- `fleet-link.types.ts` — `FLEET_LINK_VERSION = 1`, `FLEET_LINK_MAX_FRAME_BYTES = 16 MiB`,
  `FLEET_LINK_MAX_CHANNELS = 64`, `FLEET_LINK_PING_MS = 15_000`, `FLEET_LINK_SILENCE_MS = 45_000`,
  `FLEET_LINK_BACKOFF = { baseMs: 1000, maxMs: 30_000 }`, `FleetLinkFrameKind` (10 JSON, 11 CLOSE,
  1 DATA, 2 RESIZE, 3 EXIT, 20 FRAME, 23 TILES, 21 INPUT, 30 ACK, 31 END, 40 CLIP), `FleetLinkFamily`
  (the nine of §3.3), `FleetLinkControlMessage` union (`link.hello`, `link.ready`, `link.ping`,
  `link.pong`, `channel.open`, `channel.ready`, `channel.refused`, `channel.close`,
  `operation.progress`, `operation.done`, `operation.cancel` — CONTRACTS §3.1–3.2 — plus
  `link.pause`, `link.resume`, `link.drain`, the defaults of spec §8b until CONTRACTS names them;
  the node→platform `session.list|event|status|attention` members are added by FL-04/FL-05 to the
  same union), `FleetLinkError { code, hint, details }` with the §8 codes plus the `resume_failed`
  close reason (§3.1), `FleetConsents`,
  `effectiveConsents()`, `FLEET_LINK_FAMILY_CONSENT: Record<FleetLinkFamily, 'work'|'attend'|'manage'|'work|manage'>`,
  `FLEET_LINK_VERB_CONSENT_OVERRIDES` (`{ 'health.now': 'link' }` — CONTRACTS R-31: allowed on any
  open link, so the `machine` channel opens for that verb without `manage`, on platform and node
  alike), `FLEET_LINK_STATE_CHANGING_FAMILIES`.
- `fleet-link.codec.ts` — `encodeLinkFrame`, `decodeLinkFrame` (null-never-throw, cap before
  parse), `encodeControl`, `decodeControl` (`__proto__` stripped, bounded strings).
- `fleet-node.types.ts` — `FleetNodeSelfDescription.consents?`, `FleetNodeView.consents?`,
  `FleetNodeView.link?: { state: 'connected'|'reconnecting'|'not-open'|'refused'|'unsupported-kind', since?, bytesIn, bytesOut }`,
  `FleetHeartbeatResponse.recommendedNodeVersion?` (CONTRACTS §1.1).
- `fleet-panic.types.ts` — `node.consent.change`, `node.link.connect`, `node.link.disconnect`,
  `node.link.channel-open` (CONTRACTS §7).
- `fleet-operations.types.ts` — `FleetOperationView { id, nodeId, family, verb, state:
'running'|'done'|'failed'|'cancelled', progress?: { percent?, message? }, result?, error?,
startedAt, endedAt }`.
- `fleet-jobs.types.ts` — `FLEET_MANAGEMENT_LANE_KINDS` (empty in this epic; FL-16/18/20 append
  `vm-create`, `vm-control`, `runner-install`, `runner-control`, `usage-scan`) and
  `FLEET_MANAGEMENT_LANE_CONSENT: Record<kind, 'manage'|'work'|'usageScan'>` (CONTRACTS R-34).

## 5. API surface

| Method | Path                              | DTO / body                             | Returns                                                  | Auth                                                     | Errors                                          |
| ------ | --------------------------------- | -------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| POST   | `/api/fleet/link-token`           | `{ nodeId, secret }` (node credential) | `{ token, wsPath: '/ws/fleet/link', expiresInSec: 300 }` | `@Public()` + `FleetNodeAuthGuard` + `FleetEnabledGuard` | 401 undifferentiated; 404 when link flag off    |
| WS     | `/ws/fleet/link`                  | first frame `link.hello`               | `link.ready` or close                                    | token in hello                                           | close 4001 (auth), 4003 (flag off), 4008 (rate) |
| WS     | `/ws/fleet/:family/:id`           | first frame `{ type: 'auth', token }`  | bridged channel                                          | 60 s attach token, role                                  | 4001; error frame on role violation             |
| GET    | `/api/fleet/operations/:id`       | —                                      | `FleetOperationView`                                     | authenticated; owner or family audience                  | `not_found`                                     |
| DELETE | `/api/fleet/operations/:id`       | —                                      | `202` → `operation.cancel` to the node                   | authenticated; the operation's family audience           | `not_found`, `unreachable`, `kill_switch`       |
| POST   | `/api/fleet/heartbeat` (existing) | `+ consents?`                          | `+ recommendedNodeVersion?`                              | node credential                                          | unchanged                                       |
| GET    | `/api/health/ready` (existing)    | —                                      | `+ fleet_relay`                                          | public                                                   | —                                               |

Internal (not HTTP): `FleetLinkService.request(nodeId, family, verb, params, caller)` is the one
method every other epic calls from its controller; it opens or reuses a channel, enforces the
authoriser, correlates `requestId`, returns the result or throws a typed `FleetLinkError`.
`FleetLinkAttachService.mint(nodeId, family, target, role, caller)` is the one viewer-token
minter (authoriser applied); there is **no generic attach-token route** — each epic exposes it under
its own CONTRACTS §11.2 path (`/sessions/:id/attach-token` FL-04, `/nodes/:id/logs/attach-token`
FL-08, `/nodes/:id/desktop/*` FL-07).

Rate tiers (defaults until CONTRACTS §10 lists them — spec §8b): `link-token` 20/min per node;
viewer attach-token 30/min per user; hellos 10/min per node (U9).

## 6. Node side

### 6.1 Modules (`apps/node/src/core/link/`)

| File                  | Responsibility                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `link-socket.ts`      | Extracted from `node-leg.ts`: secure-origin rule, token in first frame, backoff (1 s → 30 s, jitter, reset on ready), acceptance window; `node-leg.ts` imports it and keeps its exports and spec       |
| `link-client.ts`      | `openNodeLink({ config, io, consents, tags, modules, mintToken })`: hello/ready, ping/pong, generation, resume list, pause/resume/drain notices; status for `status`/`doctor`                          |
| `channel-mux.ts`      | Frame encode/decode via contracts codec; channel table (≤ 64); per-channel bounded queues; `ACK` credit for `files`/`logs` kinds                                                                       |
| `modules/registry.ts` | `NodeModule` interface; `composeModules(env)` → `{ tags, openChannel(family, params), verbs }`                                                                                                         |
| `modules/control.ts`  | Channel 0: answers `link.ping`, applies `link.pause`/`link.resume` to a `paused` flag every module reads, `link.drain` → broadcast to session module (FL-04)                                           |
| `modules/machine.ts`  | The `machine` family: one lazily opened channel per link; routes `verb` by prefix to registered verb handlers (`health.*`, `wake.*` from FL-03; `services.*` FL-09 …); unknown → `unsupported_on_node` |
| `modules/index.ts`    | The compile-time array (control, machine; later epics append)                                                                                                                                          |
| `self-update.ts`      | P3: compares `minNodeVersion`/`recommendedNodeVersion` with `version.ts`; runs the detected installer; exit 75                                                                                         |

### 6.2 Message by message (P1)

1. Heartbeat accepted → `onAccepted` → if `consents.work || attend || manage` and the platform did
   not refuse earlier (`refusedUntil` 5 min) → `mintToken()` → `POST /api/fleet/link-token`.
2. Open `wss://<origin>/ws/fleet/link`; send binary frame ch 0 / JSON `link.hello { nodeId,
linkVersion: 1, capabilities, consents, token, resume?: { linkGeneration, channels: [{ channel,
family, resumeKey }] } }`.
3. Receive `link.ready { linkGeneration, limits, serverTime, resumed[], closed[] }` → reset backoff;
   modules told which channels resumed.
4. Every 15 s send `link.ping { t }`; expect `link.pong` within 45 s; else close and schedule.
5. Receive `channel.open { channel, family, params, requestId }` → registry → module consent check
   (`FLEET_LINK_FAMILY_CONSENT`) → `channel.ready { channel, requestId }` or `channel.refused
{ channel, requestId, error: { code, hint } }`.
6. On an open channel: JSON requests `{ requestId, type: '<verb>', … }` → reply `{ requestId, result }`
   or `{ requestId, error }`; long verbs reply `{ requestId, operationId }` then ch 0
   `operation.progress` / `operation.done`.
7. `channel.close { channel, reason }` either way; number retired for this generation.
8. `link.pause` → every module stops accepting input (FL-04 pauses PTY input), replies continue;
   `link.resume` lifts it; `link.drain { graceSec }` → session module warns owner sessions.

### 6.3 Consents and tags

`program.ts start` gains `--manage` (and P3 `--auto-update`); `createNodeRuntime` gains
`manageEnabled`; `CapabilityEnvironment` gains `managed: boolean`; `detectCapabilities` appends
`composeModules(env).tags` (`managed` from the control module when `manageEnabled`). The heartbeat
`describe()` adds `consents: { work: workEnabled, attend: attendEnabled, manage: manageEnabled,
usageScan: false }` (`usageScan` becomes FL-20's `--usage-scan`), listed in the **newest** tier of
`OPTIONAL_DESCRIPTION_FIELD_TIERS` (`heartbeat.ts:72-90`).

### 6.3a Management lane (P3, CONTRACTS R-34)

`runtime.ts` gains `createManagementLane`, a sibling of `createAttendedLane` (`runtime.ts:1026-1070`):
a worker loop that leases only `FLEET_MANAGEMENT_LANE_KINDS` whose consent
(`FLEET_MANAGEMENT_LANE_CONSENT`) is on, with its own small concurrency (1) outside `--concurrency`;
the work lane's lease filter excludes those kinds exactly as it excludes `computer-session` today
(`runtime.ts:657-661`). Platform side, `FleetJobService.lease` keeps one lease endpoint; the lane
sends its kind list as the existing attended lane does. With an empty kind set the lane is not
started.

### 6.3b Local IPC (CONTRACTS R-26)

The session daemon (FL-04) and the native screen helper (FL-07) talk to the node over same-user
local sockets (Unix socket / Windows named pipe) with a token file; neither is a network listener.
The module registry passes each module the paths; FL-02 owns no socket of its own.

### 6.4 OS matrix

The link is OS-neutral. Self-update restart commands: Linux `systemctl --user restart
ever-works-node@$USER` (template unit `apps/node/packaging/systemd/ever-works-node@.service`), macOS
`launchctl kickstart -k gui/$UID/<label>`, Windows `Restart-Service <nssm name>` or the scheduled
task re-run (`apps/node/packaging/windows/install-service.ps1`). Where the node cannot determine its
service manager it exits 75 and logs the command for the owner.

### 6.5 Desktop shell (P3)

`apps/desktop-node/src/main/main.ts:138` passes `attendEnabled`/`manageEnabled` from a new
`consents` block in its config; wizard step and tray toggles in `apps/desktop-node/src/renderer/`
and `apps/desktop-node/src/main/tray.ts`.

## 7. Plugin surface

None.

## 8. Web surface

- `apps/web/src/components/fleet/computer/ComputerHeader.tsx` (FL-01) gains the link line from
  `node.link`; `apps/web/src/components/fleet/link/ConsentsCard.tsx` registered with FL-01's
  `registerOverviewBlock`; `fleet/link/UpgradeRequiredSection.tsx` on the Settings tab (the card
  and header word come from FL-03's state mapping, not a second one); `fleet/link/link.shared.ts`
  (pure: link state word, missing-consent command builder, bytes formatting).
- "Needs a look": `packages/agent/src/fleet/needs-a-look/producers/node-upgrade-required.producer.ts`
  registered under FL-01's `NEEDS_A_LOOK_PRODUCERS` (CONTRACTS R-23): one `info` item per
  below-floor node, action = copy the upgrade command.
- Placeholder resolution in `registry.ts` reads `effectiveConsents(node)` and `node.kind` for the
  consent-missing and kind-cannot variants.
- i18n groups: `fleet.link.*` (connected, reconnecting, notOpen, refusedByDeployment, unsupportedKind,
  bytes) · `fleet.consents.*` (work, attend, manage, missingHint, command, copy) · `fleet.upgrade.*`
  (required, body, command, selfUpdateOff, selfUpdateFailed) · `fleet.errors.*` additions
  (consentMissing, unreachable, resumeFailed, unsupportedOnNode, killSwitch, limitExceeded).
- Playwright: `apps/web/e2e/flow-fleet-link-contract.spec.ts` (link-token shape, hello/ready
  fixture, refusal codes via the harness), `flow-fleet-consents.spec.ts` (consents row, link line,
  missing-consent command). AW-11 `flow-agent-computer-watch.spec.ts` and
  `flow-agent-computer-takeover.spec.ts` run twice in P2 (link leg, legacy leg).

## 9. Agent / MCP / CLI surface

- No Agent tool is added here except the read-only `fleet_operations_get` (`readOnly: true`),
  shipped with FL-19's catalogue but defined by this epic's endpoint.
- Node CLI: `start --manage`, `start --auto-update`; `status` / `doctor` print consents and link
  state (`apps/node/src/cli/program.ts`).

## 10. Background jobs

None. Operation records expire by an in-process timer (and Valkey TTL when present); link
reconnects are driven by the node.

## 11. Security & permissions

- **Outbound only** (D2): the node never listens; the platform never dials.
- **Link token**: HMAC-signed, `nodeId`-bound, 5-minute, single-use (`jti` seen-set). Presented in
  the first frame; `ws` upgrade with a query string is destroyed before any handler runs
  (`computer-ws.service.ts` rule reused). Refusals share one close code.
- **Three checks, platform-side, in order** (`FleetLinkAuthorizer`): `FleetKillSwitchService.state()`
  (fail-closed), `effectiveConsents(node)[FLEET_LINK_FAMILY_CONSENT[family]]`,
  `FleetAccessService.assertFamily(node, caller, family)` (FL-01). The node repeats the consent check.
- **What the node refuses**: any channel the platform did not open; any frame over 16 MiB; a verb
  no module owns; any family while `paused` (kill switch) except replies in flight.
- **Redaction**: frames are never logged; control messages are logged by `type` and ids only; audit
  rows carry `family`, `target`, `requestedBy`, `confirmationClass`, `outcome` (CONTRACTS §2.3).
- **Replica trust**: bus messages carry the relay key and bytes only; a replica trusts the bus
  because it trusts Valkey — same posture as the throttler storage.
- **Self-update**: installs only from the registry the node was installed from; never downloads an
  arbitrary URL; opt-in per machine.

## 12. Observability

- Audit: `node.consent.change { from, to }` (node actor), `node.link.connect|disconnect
{ linkGeneration, reason }` and `node.link.channel-open { family, target }` for state-changing
  families (CONTRACTS §7).
- Metrics (Prometheus-style counters/histograms through the existing telemetry seam):
  `fleet_link_connected` gauge per node, `fleet_link_reconnects_total`, `fleet_link_channel_opens_total{family}`,
  `fleet_link_refusals_total{code}`, `fleet_link_frame_bytes_total{direction}`, `fleet_relay_bus_publish_ms`.
- Health: `fleet_relay { configured, mode, status }`.
- Logs: one line per connect/disconnect/resume per node; one warning per refusal code per minute.

## 13. Phased rollout

| Phase | Ships                                                                                                                                                                                                                                                                                           | Flag                                 | Green means                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| P1    | Contracts (types, codec), migration `consents`, `--manage`, heartbeat consents + tag, link-token route, link gateway + registry + authoriser, node link client + mux + module registry (control, machine router), operations endpoint, kill-switch pause, header link line, consents card, i18n | `FLEET_NODE_LINK_ENABLED` (prod off) | Conformance fixture green; node and API specs green; AW-11 specs untouched                                              |
| P2    | Valkey relay bus bound to terminal, computer and link relays; health indicator; boot check; viewer attach tokens + gateway + bridge; computer-session leg over the link with fallback                                                                                                           | same                                 | Two-replica integration test green; AW-11 e2e green on both legs                                                        |
| P3    | Upgrade-required surfaces + `node-upgrade-required` producer, `--auto-update` (opt-in, spec §8b default), `recommendedNodeVersion`, the management lane (empty kind set), desktop shell consents                                                                                                | same                                 | Desktop shell heartbeat carries consents; self-update integration test on a container; lane spec green with a test kind |

## 14. Test plan

- **Contracts (Vitest)** `packages/contracts/src/fleet/__tests__/fleet-link.codec.spec.ts` — cap
  before parse (16 MiB + 1), truncated header, unknown kind, every kind round-trips, `__proto__`
  stripped from control JSON, never throws (fuzz 10 000 random buffers);
  `fleet-link.types.spec.ts` — family→consent map complete, state-changing set, `effectiveConsents`
  for null / partial / full.
- **Node (Vitest)** `apps/node/src/core/link/link-socket.spec.ts` (origin rule, backoff ladder with
  jitter bounds, reset only on ready); `link-client.spec.ts` (hello shape, ready handling, ping/pong
  timing at ±1 ms, resume list, pause/resume/drain, refused-until on flag-off close);
  `channel-mux.spec.ts` (65th channel refused, number not reused, slow-reader drop, ACK credit);
  `modules/registry.spec.ts` (tags composition, unknown verb → `unsupported_on_node`, consent refusal
  on the node); `apps/node/src/core/heartbeat.spec.ts` extend (consents in newest tier, dropped on
  400); `apps/node/src/core/capabilities.spec.ts` extend (`managed` only with `--manage`);
  `apps/node/src/core/screen/node-leg.spec.ts` unchanged and green after the extraction;
  `self-update.spec.ts` (version compare, installer detection, exit 75, failure path).
- **API (Jest)** `apps/api/src/fleet-link/fleet-link.controller.spec.ts` (token mint via guard, 401
  undifferentiated, flag off 404); `fleet-link-gateway.spec.ts` (query string destroyed, 4001 after
  5 s, token replay refused, foreign node refused, hello rate limit, generation increments, resume
  lists); `fleet-link.authorizer.spec.ts` (order kill switch → consent → audience; no node contact
  on refusal; audit only for state-changing families); `fleet-link-relay.spec.ts` (bridge
  role-check: viewer input answered with error, never forwarded); `relay-bus.valkey.spec.ts`
  (publish/subscribe round-trip against a test Valkey, delivery answer, degraded on loss);
  `apps/api/src/health/health.controller.spec.ts` extend (`fleet_relay` modes; boot check);
  `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts` extend with the link fixture
  `packages/contracts/fixtures/fleet-link-contract.v1.json`.
- **Agent (Jest)** `packages/agent/src/fleet/__tests__/fleet.service.consents.spec.ts` — consents
  stored, absent → null, change → `node.consent.change` and the close callback.
- **Integration** `apps/api/test/fleet-link.two-replicas.e2e-spec.ts` — two API processes, one
  Valkey, node harness on A, viewer on B.
- **Playwright** §8.

## 15. Risks

| Risk                                                              | Likelihood | Impact | Mitigation                                                                                                      |
| ----------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| Extracting the socket mechanics breaks the computer-session leg   | Medium     | High   | `node-leg.spec.ts` kept byte-for-byte; AW-11 e2e in CI; extraction is P1's first task so it soaks longest       |
| An older platform rejects `consents` and the node goes dark       | Low        | High   | Newest tier of `OPTIONAL_DESCRIPTION_FIELD_TIERS`; existing drop-and-retry proven by `heartbeat.spec.ts`        |
| Valkey pub/sub adds latency to every terminal frame               | Medium     | Medium | Local fast path when viewer and producer share a replica; bus only for the cross-replica hop; p95 budget tested |
| Channel-open audit rows become a firehose                         | Medium     | Low    | Read-only families never audited; `machine` channel audited per state-changing verb by its epic, not per open   |
| Self-update runs an installer the node did not come from          | Low        | High   | Installer detection from `doctor`'s own install-path logic; refuse when unknown; opt-in only                    |
| Two gateways and a third sharing one `upgrade` listener mis-route | Low        | Medium | Prefix table in one place; a path-router unit test enumerates all three                                         |

## 16. Constitution reconciliation

- **I / II** — no external integration or provider choice; Valkey is infrastructure already present.
- **III** — nothing stored beyond consents and audit.
- **IV** — no job runtime work; operations are request state.
- **V** — one additive migration.
- **VI** — tests per package in §14; conformance fixture extended.
- **VII** — tokens and payloads never logged; node credential never leaves the node.
- **VIII** — no plugin.
- **IX** — spec is behaviour-only; this plan holds every path.
- **X** — optional fields only; the legacy leg stays as the fallback (retiring it is a separate
  owner decision); gateways keep their paths.

## 17. References

- Spec [`./spec.md`](./spec.md) · Tasks [`./tasks.md`](./tasks.md)
- [CONTRACTS](../CONTRACTS.md) §1, §3, §8, §9, §10, §13 · [README](../README.md) D2, D3, D8
- AW-11 plan [`../../agent-workspace/AW-11-agent-computers/plan.md`](../../agent-workspace/AW-11-agent-computers/plan.md) §2.1 (the leg), §4.5–4.6 (gateway, relay)
- `docs/specs/security/fleet-session-trust-model.md` · `docs/features/fleet.md` §"Connect a machine"
