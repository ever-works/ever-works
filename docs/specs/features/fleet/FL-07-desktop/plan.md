# FL-07 — Desktop view & control · Implementation plan

> How [`spec.md`](./spec.md) gets built. Every path below was opened at this branch's base
> (`origin/develop` `e4334baf7`) before it was cited; paths marked _(new)_ do not exist yet, and
> paths marked _(FL-02)_ or _(FL-01)_ are owned by those epics and assumed here.

**Epic ID:** `FL-07-desktop`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    subgraph WEB[apps/web]
        T[Desktop tab / Agent→Computer source switch / Session split]
        P[DesktopStage: canvas + tile painter]
        T --> P
    end
    subgraph API[apps/api]
        C[FleetDesktopController\n/api/fleet/nodes/:id/desktop/*]
        G[/ws/fleet/desktop/:viewId\nviewer gateway/]
        R[Relay bus (FL-02, Valkey)]
        A[ComputerControlArbiter (AW-11)]
        S[DesktopRecordingService → storage plugin]
        C --> R
        G <--> R
        G --> A
        R --> S
    end
    subgraph NODE[apps/node on the machine]
        L[Node link (FL-02)\nchannel family: desktop]
        B[DesktopHelperBackend\n(CaptureBackend impl)]
        H[ever-works-screen helper\n(Rust, same user, local IPC)]
        OS[(OS: ScreenCaptureKit / DXGI+GDI / X11)]
        L <--> B
        B <--> H
        H <--> OS
    end
    T -- "POST views, PATCH display/quality" --> C
    P <-- "FRAME(20) · TILES(23) · stats" --> G
    P -- "INPUT(21) while controlling" --> G
    R <-- "one outbound WSS per node" --> L
    S -- "≤1 fps keyframes, 60 s chunks" --> ST[(Storage plugin)]
    C -- "index row" --> DB[(computer_sessions +\nfleet_nodes.helperTrust)]
```

Data flow back: the helper captures the display, diffs 64-px tiles against the previous frame,
JPEG-encodes the changed ones and hands `tiles`/`frame` messages to the node; the node's desktop
channel wraps them into link frames (`TILES` 23 / `FRAME` 20) with a `stats` JSON once a second; the
API relay fans them out to every attached viewer socket and, when the view is recording, samples
keyframes at ≤ 1 fps into the recording writer. Input goes the other way: a controlling viewer's
`INPUT` (21) frame → relay (role- and hold-checked by the arbiter) → link → node → helper → OS.

---

## 2. Current state in the codebase

| Piece                                                                                                                                 | Where (verified at HEAD)                                                                                                                                                                                                                    | Reused as                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture-backend seam: `isAvailable` pure, `start`/`capture`/`stop`, optional `dispatchInput`                                          | `apps/node/src/core/screen/capture-backend.ts:4-31, 63-93`; selection `:121-126`; availability list `:107-110`                                                                                                                              | The desktop helper is a second `CaptureBackend` (`DesktopHelperBackend`), preferred over the headless browser only when the request names `source: 'desktop'`. |
| Headless-browser backend (the only one)                                                                                               | `apps/node/src/core/screen/headless-browser-backend.ts:18-41, 60-67`                                                                                                                                                                        | Untouched; stays the `browser` source.                                                                                                                         |
| Capture pump: timing, degrade/recover, three failed pictures → restart, stats once a second                                           | `apps/node/src/core/screen/capture-pump.ts:16-38, 40-60`                                                                                                                                                                                    | Reused for the keyframe cadence; tiles bypass the pump (the helper pushes them) but the pump still owns quality and stats.                                     |
| Outbox: secret-scan every string, batch caps, drop oldest                                                                             | `apps/node/src/core/screen/frame-outbox.ts:14-43`                                                                                                                                                                                           | Reused for the browser source; the link's `desktop` channel gets a sibling `DesktopLinkOutbox` with the same drop-oldest rule and 16 MiB link frame cap.       |
| Input injector: injects only while controlling, refuses non-input kinds and blocked shortcuts, fails closed until the Agent is paused | `apps/node/src/core/screen/input-injector.ts:10-45`; marker `apps/node/src/core/screen/agent-control-marker.ts:4-36`                                                                                                                        | Reused verbatim; `DesktopHelperBackend.dispatchInput` is its new target. The Agent pause marker applies only when the view is bound to an Agent's Run.         |
| Capability probe; stale `input` comment                                                                                               | `apps/node/src/core/capabilities.ts:261-276, 304-324` ("`input` is NOT advertised: nothing on this node injects input yet")                                                                                                                 | Extended: `input`, `screen:desktop`, `helper:screen`.                                                                                                          |
| Capability tag constants                                                                                                              | `packages/contracts/src/fleet/fleet-jobs.types.ts:132-152` (`browser`, `gpu`, `screen`, `input`, `attended`)                                                                                                                                | `FLEET_INPUT_CAPABILITY` finally used; `FLEET_SCREEN_DESKTOP_CAPABILITY`, `FLEET_HELPER_SCREEN_CAPABILITY` added.                                              |
| `--attend` wiring: attend is process-scoped, capture backend selected once                                                            | `apps/node/src/cli/program.ts:1550`; `apps/node/src/core/runtime.ts:475-497, 553-568, 987-1013`                                                                                                                                             | `selectAttendedCapture` gains the desktop backend when a helper is admitted.                                                                                   |
| Live-view wire protocol (frame = full picture; input kinds; direction maps)                                                           | `packages/contracts/src/computer/computer-frame.types.ts:32-77, 113-124, 178-258, 279-298`                                                                                                                                                  | `FRAME`/`INPUT` link payloads carry these encodings unchanged; `TILES` is new.                                                                                 |
| Link thresholds (degrade 3 frames / 1500 ms for 5 s; stall 6 s / 20 s / 45 s)                                                         | `packages/contracts/src/computer/computer-link.policy.ts:15-32`                                                                                                                                                                             | Same numbers for the desktop source.                                                                                                                           |
| Session statuses, channels, unwatchable reasons, control policies, session view                                                       | `packages/contracts/src/computer/computer-session.types.ts:29-124`                                                                                                                                                                          | `COMPUTER_UNWATCHABLE_REASONS` extended; `ComputerSessionView` gains `source`, `displayId`, recording fields.                                                  |
| Control types: idle 10 min, ceiling 60 min, disconnect 30 s, request 60 s, blocked shortcuts                                          | `packages/contracts/src/computer/computer-control.types.ts:20-33, 140-191`                                                                                                                                                                  | Unchanged.                                                                                                                                                     |
| Control arbiter (CAS lock on `fleet_nodes`) and its event                                                                             | `packages/agent/src/computer/control-arbiter.service.ts:1-80`; lock columns `packages/agent/src/entities/fleet-node.entity.ts:520-578` (EXISTING-SUBSTRATE §2.2)                                                                            | Used as-is for desktop views; the Agent as an actor is a new `requestedBy` kind on the same lock.                                                              |
| Session policy: watchability precedence, required capabilities, limits, expiry                                                        | `packages/agent/src/computer/computer-session.policy.ts:72-137, 194-301`                                                                                                                                                                    | `resolveWatchability` gains the source dimension; limits reused.                                                                                               |
| Session entity: `recorded`, `recordingSkippedReason` (never written)                                                                  | `packages/agent/src/entities/computer-session.entity.ts:92-98`; only read at `packages/agent/src/computer/computer-session.service.ts:750`                                                                                                  | Slot 01 adds the recording index columns; `DesktopRecordingService` is the first writer.                                                                       |
| Node columns: `controlPolicy`, `recordWatchSessions`, `recordingRetentionDays`                                                        | `packages/agent/src/entities/fleet-node.entity.ts:495-510`; read at `packages/agent/src/fleet/fleet.service.ts:1758-1759`                                                                                                                   | `controlPolicy` becomes the family map (FL-01); the two recording columns get their first writer.                                                              |
| Owner-facing computer controller and WS gateway                                                                                       | `apps/api/src/computer/computer.controller.ts:62-101`; `apps/api/src/computer/computer-ws.service.ts:26-69` (`/ws/computer/:sessionId`, token in first frame, 4001 after 5 s, 30 s ping)                                                    | Untouched. The desktop gateway is the same handshake on `/ws/fleet/desktop/:viewId` through FL-02's viewer-attach pattern.                                     |
| Fleet audit writer with key-based redaction                                                                                           | `packages/agent/src/fleet/fleet-audit.service.ts:38-58` (`REDACTED_KEY_RE`)                                                                                                                                                                 | One writer; new action names only. Field names avoid `hash`/`token` — `fingerprintPrefix`, not `sha256Hash`.                                                   |
| Audit action union (eight `computer.*` members)                                                                                       | `packages/contracts/src/fleet/fleet-panic.types.ts:60-148`                                                                                                                                                                                  | Extended with the `node.desktop.*`, `node.helper.*` names (CONTRACTS §7).                                                                                      |
| Windows helper trust policy (path + SHA-256 + Authenticode subject + cert hash), PowerShell broker                                    | `apps/node/src/core/windows-job-launcher/windows-job-helper-trust.internal.ts:6-15, 49-53`; `apps/node/native/windows-job-launcher/PACKAGING.md:45-68` (reparse check, canonical path, deny-write handles, re-verify before protocol bytes) | The **signed** admission level on Windows reuses this exact policy shape and broker; hash-pinned admission is a strict subset (path + SHA-256).                |
| Windows job launcher crate (edition 2024, Rust 1.88, reproducible build scripts, schemas)                                             | `apps/node/native/windows-job-launcher/{Cargo.toml,rust-toolchain.toml,build-release.ps1,create-signed-manifest.ps1,*.schema.json}`                                                                                                         | The screen helper crate sits beside it and reuses the toolchain pin, the metadata schemas and the post-sign manifest contract.                                 |
| Storage plugin factory                                                                                                                | `apps/api/src/uploads/storage-backend.factory.ts:5-26`                                                                                                                                                                                      | Recording bytes go through `getActiveStorageBackend()`; nothing names a backend.                                                                               |
| Retention sweep precedent                                                                                                             | `packages/tasks/src/tasks/trigger/terminal-transcript-gc.task.ts:1-40` (cron 03:17, `withWorkerContext`)                                                                                                                                    | `computer-recording-gc.task.ts` mirrors it at 03:23.                                                                                                           |
| Web: stage with `drawPicture`/`writeTerminal`, controls with one channel, attach hook, route constant                                 | `apps/web/src/components/computer/ComputerStage.tsx:31-58`; `ComputerControls.tsx:26-49`; `use-computer-attach.ts:19-50`; `apps/web/src/lib/constants.ts:258`                                                                               | Stage gains a tile painter; controls gain the source switch; a sibling attach hook speaks the link viewer protocol.                                            |
| Existing e2e specs                                                                                                                    | `apps/web/e2e/flow-agent-computer-{watch,takeover,contract}.spec.ts`, `flow-fleet-*.spec.ts`                                                                                                                                                | Must stay green; new specs named in §8.                                                                                                                        |
| Agent fleet tools (one read-only tool)                                                                                                | `packages/agent/src/fleet/agent-fleet-tools.ts:32-60`                                                                                                                                                                                       | Desktop tools are added beside it with the FL-19 naming.                                                                                                       |
| MCP whitelist (fleet reads, affinity, drain)                                                                                          | `apps/mcp/src/openapi-tools/whitelist.ts:475-530`                                                                                                                                                                                           | Desktop routes added with annotations.                                                                                                                         |

**Missing at HEAD (what this plan builds):** a desktop capture backend; the native helper and its
crate; admission (CLI verbs, trust record, verification before start); the `desktop` link channel
and its relay/gateway; `TILES` encoding; display enumeration; source/display on the session row;
recording writer, index columns, sweep and player; the split pane; the `input` tag; Agent desktop
tools; the Desktop tab and the source switch. No `apps/web/src/components/fleet/` directory exists
yet (FL-01 creates it and the registry).

---

## 3. Tech choices

| Concern                      | Choice                                                                                                                                                                                                                                                                                            | Why                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Helper language / crate      | Rust (edition 2024, toolchain pinned by `rust-toolchain.toml` as the job-launcher crate does), `publish = false`, one binary per target: `darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`                                                                                                   | Owner decision README §8 #1; the only other native crate in the repo is Rust; reproducible-build scripts and signing manifests already exist for Rust artifacts.                                |
| macOS capture / input        | ScreenCaptureKit via `objc2` + `objc2-screen-capture-kit` (0.3.x) for frames; `core-graphics` (0.24.x) `CGEvent` for input; permission preflight through `CGPreflightScreenCaptureAccess` / `CGPreflightPostEventAccess`; min macOS 12.3                                                          | The supported, sandbox-friendly capture API; preflight gives a named reason without triggering a prompt mid-stream.                                                                             |
| Windows capture / input      | DXGI Desktop Duplication via `windows` crate (0.58.x) with GDI `BitBlt` fallback when duplication is unavailable (RDP session, unsupported adapter); `SendInput` for input; helper launched into the interactive session via a one-off scheduled task created with the enrolling user's token     | Duplication is low-CPU and gives dirty rects for free; GDI covers the rest. The node service already runs as the enrolling user (installer requires it), so the task runs as the same identity. |
| Linux capture / input        | `x11rb` (0.13.x) with the `shm`, `xtest`, `xfixes`, `randr` extensions; XShm `GetImage` per frame, XFixes cursor, XTest fake input; keysym→keycode map from the current mapping; Wayland detected (`XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`) and refused by name                                     | Pure Rust, no C bindings; X11 only in P1–P3 by spec.                                                                                                                                            |
| Virtual displays (P3, Linux) | A dedicated `virtual-display` helper subcommand: adds an `xrandr` mode on a free connector of the running X server and registers it with the compositor's display configuration when one is present; refuses otherwise with the compositor named                                                  | Keeps the capability inside the helper, root-free where the X server allows, honest where it does not.                                                                                          |
| Tile encoding                | 64 × 64 tiles, byte-compare against the previous downscaled frame, `jpeg-encoder` (0.6.x) per changed tile, `TILES` payload `[w u16][h u16][count u16]{x u16,y u16,w u16,h u16,len u32,jpeg}`; a `FRAME` keyframe every `keyframeMs` as the existing `ComputerScreenFrame` encoding               | CONTRACTS §3.2 fixes the kinds; this plan binds the field widths (dimensions fit u16 under `COMPUTER_MAX_DIMENSION` 8192).                                                                      |
| Downscale                    | Box-average to the preset width in the helper before diffing                                                                                                                                                                                                                                      | Diffing at output resolution keeps tiles stable and CPU bounded.                                                                                                                                |
| Helper ↔ node IPC            | Length-prefixed binary messages (`[len u32][type u8][payload]`) over stdio when the helper is a direct child (Linux); over a same-user Unix domain socket (`0600`, in the node config dir) on macOS when the node is not in the GUI session; over a named pipe with an owner-only DACL on Windows | Mirrors the job-launcher protocol style (`apps/node/native/windows-job-launcher/src/protocol.rs`); no network listener anywhere; same-user local IPC is inside D2 (CONTRACTS R-26).             |
| Admission record             | `helper-policy.json` in the node config dir, `0600`/icacls-locked like the credential file: `{ path, sha256, level, version, acknowledgedAt, signer? }`                                                                                                                                           | Same persistence posture as the node secret; re-read and re-verified before every helper start.                                                                                                 |
| Fingerprint source           | `helper-manifest.json` baked into the `ever-works-node` package at publish: `{ version, targets: { <target>: { sha256, url, signedSha256?, signer? } } }`                                                                                                                                         | The node knows which helper versions it accepts without a network call; `helper install` downloads from `url`, verifies, then asks for `admit`.                                                 |
| Signed verification (P3)     | macOS: `codesign --verify --strict` + Team ID from the manifest; Windows: the existing Authenticode broker (subject + leaf cert SHA-256)                                                                                                                                                          | Reuses what exists; no new verifier on Windows.                                                                                                                                                 |
| Viewer transport             | FL-02 viewer attach: `POST …/attach-token` (60 s, single-use, role) → `wss://<api>/ws/fleet/desktop/:viewId`, token in the first frame; relay bus on Valkey when `REDIS_URL` is set                                                                                                               | R-7; identical handshake rules to `computer-ws.service.ts`.                                                                                                                                     |
| Web rendering                | `<canvas>`; keyframes via `createImageBitmap` + `drawImage`; tiles decoded with `createImageBitmap(Blob)` per tile and painted at `(x, y)`; CSS-scaled to fit, never upscaled                                                                                                                     | Extends `ComputerStage`'s existing `drawPicture` path.                                                                                                                                          |
| Split pane                   | A `DesktopSplitPane` with a `role="separator"` divider (`aria-valuenow` = %), pointer drag + `Alt+[`/`Alt+]`, ratio in `localStorage` `ew:fleet:desktop:split:<nodeId>`                                                                                                                           | No new dependency; keyboard-accessible by construction.                                                                                                                                         |
| Recording storage            | 60-second chunks: `fleet/recordings/<nodeId>/<viewId>/<seq>.bin` (concatenated JPEG keyframes with a 16-byte header each: `t u32 ms, len u32, w u16, h u16, flags u32`) + `index.json` written on close                                                                                           | Few objects per view; the player seeks by chunk; bytes never touch the database.                                                                                                                |
| Retention sweep              | Trigger task `computer-recording-gc` (cron `23 3 * * *`), storage delete first then row update                                                                                                                                                                                                    | Constitution IV; mirrors `terminal-transcript-gc`.                                                                                                                                              |

---

## 4. Data model

### 4.1 `FleetNode` — additions (CONTRACTS §4.1, slot 00)

`packages/agent/src/entities/fleet-node.entity.ts` gains:

| Column        | Type                                                           | Written by                                                               |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `helperTrust` | `varchar(16)` default `'none'` — `none · hash-pinned · signed` | heartbeat (`FleetService.heartbeat`) from the node's `helperTrust` field |

Migration `apps/api/src/migrations/1796070000000-AddFleetNodeHelperTrust.ts`: one `ADD COLUMN`
with default, one index `idx_fleet_nodes_helper_trust(helperTrust)`; `down` drops both.
`controlPolicy`'s new family-map shape is FL-01's migration (`1796010000000`), not this one; this
plan reads `controlPolicy.desktop`.

### 4.2 `ComputerSession` — additions (slot 01)

`packages/agent/src/entities/computer-session.entity.ts` gains:

| Column                   | Type                             | Notes                                                                  |
| ------------------------ | -------------------------------- | ---------------------------------------------------------------------- |
| `source`                 | `varchar(8)` default `'browser'` | `browser · desktop`                                                    |
| `displayId`              | `varchar(64)` null               | the helper's display id at open; updated on `desktop.setDisplay`       |
| `fleetSessionId`         | `uuid` null                      | the FL-04 session this view sits beside (split); FK added by migration |
| `recordingRef`           | `varchar(512)` null              | storage key prefix; **never** bytes                                    |
| `recordingBytes`         | `bigint` default 0               |                                                                        |
| `recordingDurationMs`    | `int` default 0                  |                                                                        |
| `recordingExpiresAt`     | `PortableDateColumn` null        | `endedAt + node.recordingRetentionDays` (clamped 1–90)                 |
| `recordingStoppedReason` | `varchar(24)` null               | `size-cap · time-cap · storage-failed · view-ended · deleted`          |
| `agentId`                | **widened to nullable**          | a Desktop view from the computer page has no Agent                     |

Migration `apps/api/src/migrations/1796070100000-AddComputerSessionRecordingColumns.ts` (class
`AddComputerSessionRecordingColumns1796070100000`, the CONTRACTS §13 name): eight portable
`TableColumn` additions (varchar enums validated in code and `bigint`/`int`/`PortableDateColumn`
types as the sibling columns use — CONTRACTS §4 storage note; runs on SQLite and Postgres), one
`queryRunner.changeColumn` making `agentId` nullable (TypeORM rebuilds the table on SQLite), indexes
`idx_computer_sessions_recording_expires(recordingExpiresAt)` and
`idx_computer_sessions_fleet_session(fleetSessionId)`; FK `fleetSessionId → fleet_sessions` only if
FL-04's table exists at merge time (guarded `hasTable`). `down` reverses exactly.
`agent_runs.computerRecordedAt` from the AW-11 plan is **not** added: the receipt joins on
`computer_sessions.runId` with `recordingRef IS NOT NULL` (one indexed lookup).

### 4.3 Contracts (`packages/contracts/src/fleet/`, additive)

- `fleet-desktop.types.ts` _(new)_: `FLEET_SCREEN_SOURCES = ['browser','desktop']`,
  `FleetScreenSource`; `FleetDisplayView { id, name, width, height, scale, primary, virtual }`;
  `FLEET_HELPER_TRUST_LEVELS = ['none','hash-pinned','signed']`, `FleetHelperTrust`;
  `FleetDesktopReason` = the eight new reasons; `FleetDesktopViewView extends ComputerSessionView`
  with `source`, `displayId`, `fleetSessionId`, `recording: { ref, bytes, durationMs, expiresAt, stoppedReason } | null`;
  `FleetDesktopOpenRequest { source, displayId?, quality?, fleetSessionId? }`;
  `FLEET_SCREEN_DESKTOP_CAPABILITY = 'screen:desktop'`, `FLEET_HELPER_SCREEN_CAPABILITY = 'helper:screen'`,
  `FLEET_SCREEN_BROWSER_CAPABILITY = 'screen:browser'`.
- `fleet-desktop-tiles.codec.ts` _(new)_: `encodeDesktopTiles` / `decodeDesktopTiles` for the
  `TILES` payload, size-capped before parse (16 MiB link frame), null-never-throw, dimension bounds
  from `COMPUTER_MAX_DIMENSION`; `DESKTOP_TILE_SIZE = 64`.
- `fleet-helper.types.ts` _(new)_: `FleetHelperManifest`, `FleetHelperPolicyRecord` (no secret
  fields), `FleetHelperStatusView { present, admitted, level, version, fingerprintPrefix, verifiedAt, reason? }`.
- `fleet-node.types.ts`: `FleetNodeView.helperTrust`, heartbeat `helperTrust` (CONTRACTS §1.1) plus
  `helper?: FleetHelperStatusView`, `displays?: FleetDisplayView[]`, `desktopReasons?: FleetDesktopReason[]`,
  `helperEvents?` (all optional; the four beyond `helperTrust` are the §1.1 addition raised in spec §8b).
- `fleet-panic.types.ts`: audit members `node.desktop.view`, `node.desktop.control.take|release|request`,
  `node.desktop.display.set|add|remove`, `node.desktop.recording.start|stop|delete`,
  `node.helper.admit|revoke|verify-failed` (all in CONTRACTS §7).
- `packages/contracts/src/computer/computer-session.types.ts`: `COMPUTER_UNWATCHABLE_REASONS` +
  the eight; `ComputerSessionView.source` (optional, default `browser`).

---

## 5. API surface

Root `/api/fleet/nodes/:id/desktop` (CONTRACTS §11.2), `FleetEnabledGuard` + `FLEET_DESKTOP_ENABLED`
flag guard; authenticated; family check `desktop` through FL-01's role derivation; every refusal is
`{ error: { code, hint, details } }` from §8. `/api/agents/:id/computer/*` stays.

| Method          | Path                                            | Body / query                                                           | Returns                                        | Errors                                                                                                        | Tier    |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------- |
| GET             | `/availability`                                 | —                                                                      | `{ available, reasons[], displays[], helper }` | `not_found`, `unreachable`                                                                                    | 60/min  |
| GET             | `/displays`                                     | —                                                                      | `FleetDisplayView[]`                           | `unreachable`, `consent_missing`, `unsupported_on_node`                                                       | 60/min  |
| POST            | `/views`                                        | `OpenDesktopViewDto { source, displayId?, quality?, fleetSessionId? }` | `202 { viewId, status }`                       | `consent_missing`, `permission_denied`, `kill_switch`, `limit_exceeded`, `unsupported_on_node`, `unreachable` | 10/min  |
| GET             | `/views/:viewId`                                | —                                                                      | `FleetDesktopViewView & { live }`              | `not_found`                                                                                                   | 60/min  |
| PATCH           | `/views/:viewId`                                | `UpdateDesktopViewDto { quality?, displayId? }`                        | view                                           | `invalid`, `unsupported_on_node`                                                                              | 30/min  |
| DELETE          | `/views/:viewId`                                | —                                                                      | `204`                                          | idempotent                                                                                                    | 30/min  |
| POST            | `/views/:viewId/attach-token`                   | `?role=viewer\|driver`                                                 | `{ token, expiresInSec: 60, wsPath }`          | `permission_denied` (driver without hold)                                                                     | 30/min  |
| POST            | `/views/:viewId/refresh`                        | —                                                                      | `202`                                          | —                                                                                                             | 30/min  |
| GET/POST/DELETE | `/views/:viewId/control`                        | `ComputerControlDto` (existing shape)                                  | `ComputerControlStateView`                     | `permission_denied` (policy named), `busy` (holder named), `confirmation_required` never                      | 20/min  |
| POST            | `/views/:viewId/control/handover\|keep\|extend` | existing AW-11 bodies                                                  | state                                          | as AW-11                                                                                                      | 20/min  |
| GET             | `/recordings`                                   | `?limit`                                                               | `FleetDesktopViewView[]` with recording        | —                                                                                                             | 60/min  |
| GET             | `/recordings/:viewId`                           | —                                                                      | `{ index, chunks[], controlSpans[] }`          | `not_found`                                                                                                   | 60/min  |
| GET             | `/recordings/:viewId/chunks/:seq`               | —                                                                      | bytes (`attachment`, `nosniff`)                | `not_found`                                                                                                   | 120/min |
| DELETE          | `/recordings/:viewId`                           | `{ confirm: true }` (CONTRACTS §2.2)                                   | `204`                                          | `confirmation_required` (class `confirm`)                                                                     | 10/min  |
| POST            | `/displays/virtual` (P3)                        | `{ name, size, confirm: true }`                                        | `202 { operationId }`                          | `unsupported_on_node`, `confirmation_required`                                                                | 5/min   |
| DELETE          | `/displays/virtual/:displayId` (P3)             | `{ confirm: true }`                                                    | `202`                                          | same                                                                                                          | 5/min   |

Node-facing: none new over HTTP — the desktop rides the link; `helperTrust` (CONTRACTS §1.1) and
`helper`, `displays`, `desktopReasons`, `helperEvents` (the §1.1 addition raised in spec §8b) ride the
existing heartbeat (`POST /api/fleet/heartbeat`, optional fields).
Viewer socket: `wss://<api>/ws/fleet/desktop/:viewId` (FL-02 gateway, same rules as
`computer-ws.service.ts:26-45`).

DTOs in `apps/api/src/fleet/desktop/dto/fleet-desktop.dto.ts` (`class-validator`; `displayId`
≤ 64 chars; `source` in the enum; `fleetSessionId` UUID).

---

## 6. Node side

### 6.1 Modules

| Unit                                                                                                                                                   | Responsibility                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/node/src/core/screen/desktop-helper-backend.ts` _(new)_                                                                                          | `CaptureBackend` over the helper: `isAvailable` = admitted policy + display session + OS permission facts from the last helper `hello`; `start` launches/attaches the helper for `{ displayId }`; `capture` returns the last keyframe; `onTiles` pushes tiles; `dispatchInput` forwards; `listDisplays`, `setDisplay`, `openUrl`, `pasteText`. |
| `apps/node/src/core/screen/helper/helper-protocol.ts` _(new)_                                                                                          | Codec for the node↔helper messages (`hello`, `start`, `stop`, `frame`, `tiles`, `displays`, `setDisplay`, `input`, `releaseAll`, `openUrl`, `pasteText`, `error`); length-prefixed, size-capped, null-never-throw.                                                                                                                             |
| `apps/node/src/core/screen/helper/helper-process.ts` _(new)_                                                                                           | Spawns/connects per platform (child stdio on Linux; Unix socket on macOS; named pipe + scheduled-task launch on Windows); supervises (3 restarts / 60 s); `releaseAll` on any disconnect.                                                                                                                                                      |
| `apps/node/src/core/screen/helper/helper-trust.ts` _(new)_                                                                                             | Reads `helper-policy.json`; verifies SHA-256 (hash-pinned) or signature (signed; Windows reuses `windows-job-helper-trust.internal.ts` broker, macOS `codesign`) **immediately before each start**; returns `helperTrust` and a `FleetDesktopReason` on failure.                                                                               |
| `apps/node/src/core/screen/helper/helper-admission.ts` _(new)_                                                                                         | `install` (download from manifest URL, verify, stage), `admit` (print both fingerprints, require typed `admit`, write policy, audit via heartbeat `helperEvents`), `revoke`, `status`.                                                                                                                                                         |
| `apps/node/src/core/screen/desktop-host.ts` _(new)_                                                                                                    | The node-internal hook for FL-10 (`openUrl`) and FL-11 (`pasteText`): available only when the backend is available; refuses with the same reasons.                                                                                                                                                                                             |
| `apps/node/src/core/link/modules/desktop.ts` _(new file in FL-02's module registry; one entry appended to `apps/node/src/core/link/modules/index.ts`)_ | The `desktop` family as a `NodeModule` (FL-02 plan §6): one channel per view; wraps helper output into `FRAME`/`TILES`/`JSON stats`; applies `INPUT` through the injector; handles `desktop.quality\|refresh\|displays\|setDisplay\|openUrl`; honours the shared `paused` flag set by `link.pause`.                                            |
| `apps/node/src/cli/program.ts`                                                                                                                         | New verbs: `helper install [--version] [--target]`, `helper admit [--path]`, `helper revoke`, `helper status [--json]`.                                                                                                                                                                                                                        |
| `apps/node/src/core/capabilities.ts`                                                                                                                   | Advertise `screen:desktop` (admitted + attended + reasons empty), `helper:screen` (admitted), `screen:browser` (alias of `screen`), `input` (browser backend has `dispatchInput` or helper admitted). Remove the stale comment.                                                                                                                |
| `apps/node/src/core/runtime.ts`                                                                                                                        | `selectAttendedCapture` returns both backends; heartbeat telemetry carries `helper`, `displays`, `desktopReasons`, `helperTrust`.                                                                                                                                                                                                              |
| `apps/node/native/ever-works-screen/` _(new crate)_                                                                                                    | `src/main.rs` (protocol loop), `src/protocol.rs`, `src/tiles.rs` (diff + JPEG), `src/scale.rs`, `src/capture/{mod,macos,windows,x11}.rs`, `src/input/{mod,macos,windows,x11}.rs`, `src/displays.rs`, `src/virtual_display_x11.rs` (P3), `PACKAGING.md`, `build-release.{ps1,sh}`, `helper-manifest.schema.json`.                               |

### 6.2 OS matrix

| Concern               | macOS                                                                                                                                                                                  | Windows                                                                                                                                         | Linux                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Capture               | ScreenCaptureKit `SCStream` per display                                                                                                                                                | DXGI Desktop Duplication; GDI `BitBlt` fallback                                                                                                 | X11 XShm `GetImage`; cursor via XFixes                                                                                |
| Input                 | `CGEvent` mouse/scroll/key/text with modifier flags                                                                                                                                    | `SendInput` absolute coordinates                                                                                                                | XTest fake input; keysym→keycode from current mapping                                                                 |
| Permission facts      | `CGPreflightScreenCaptureAccess`, `CGPreflightPostEventAccess` → reasons                                                                                                               | interactive session present (`WTSGetActiveConsoleSessionId`) → `no-display-session`                                                             | `DISPLAY`/`XAUTHORITY` from the node's env, else `systemctl --user show-environment`; Wayland → `wayland-unsupported` |
| Where the helper runs | GUI session: a per-user LaunchAgent `com.ever-works.screen` the node installs on `helper admit`; node connects over `~/Library/Application Support/ever-works-node/screen.sock` (0600) | Interactive session via a one-off scheduled task (`/IT`, enrolling user); named pipe `\\.\pipe\ever-works-screen-<nodeId>` with owner-only DACL | Child process of the node (same session)                                                                              |
| Displays              | `SCShareableContent` displays                                                                                                                                                          | `EnumDisplayMonitors` + DXGI outputs                                                                                                            | RandR outputs                                                                                                         |
| Virtual displays      | refused `unsupported_on_node`                                                                                                                                                          | refused                                                                                                                                         | P3: X11 only                                                                                                          |
| Signed admission (P3) | Developer ID + Team ID via `codesign --verify --strict`                                                                                                                                | Authenticode subject + leaf cert SHA-256 via the existing broker                                                                                | never (hash-pinned only)                                                                                              |
| Shell-outs            | `open <url>` (openUrl), `codesign`, `launchctl`                                                                                                                                        | `schtasks`, `rundll32 url.dll,FileProtocolHandler <url>`                                                                                        | `xdg-open <url>`, `xrandr` (P3)                                                                                       |

### 6.3 Consents and tags

`--attend` only. Without it: `consent_missing` with hint `start the node with --attend on <node>`.
Tags: `screen:desktop`, `helper:screen`, `screen:browser`, `input`; all re-detected each heartbeat.

### 6.4 The `desktop` link channel, message by message

```
platform → node  channel.open { channel, family: 'desktop', params: { viewId, source: 'desktop', display?, quality } }
node → platform  channel.ready { channel, display: FleetDisplayView, displays: [...] }
                 — or channel.refused { code: 'unsupported_on_node'|'consent_missing'|'busy', hint, details: { reason } }
node → platform  FRAME(20)  payload = existing ComputerScreenFrame encoding, keyframe=true    (every keyframeMs, on refresh, on display switch)
node → platform  TILES(23)  payload = encodeDesktopTiles(...)                                (whenever ≥1 tile changed, ≤ maxFps)
node → platform  JSON(10)   { type: 'desktop.stats', nodeLocalTime, quality, effectiveQuality, fps, backlog, bytesOut, tilesPerSec }   (1/s)
platform → node  JSON(10)   { type: 'desktop.quality', requestId, quality }  → JSON { requestId, ok }
platform → node  JSON(10)   { type: 'desktop.refresh', requestId }            → FRAME + JSON { requestId, ok }
platform → node  JSON(10)   { type: 'desktop.displays', requestId }           → JSON { requestId, displays }
platform → node  JSON(10)   { type: 'desktop.setDisplay', requestId, display } → FRAME + JSON { requestId, ok } | error unsupported_on_node
platform → node  INPUT(21)  payload = existing ComputerInputFrame encoding    (forwarded only from the holding viewer; node re-checks `mode` and shortcuts)
platform → node  JSON(10)   { type: 'desktop.mode', mode: 'watching'|'controlling', actor: 'user'|'agent' }   (the node's cue to pause/resume the Agent marker and to releaseAll on 'watching')
node → platform  JSON(10)   { type: 'desktop.displayChanged', displays, fallback?: display }  (3 s after a hot-plug)
either          CLOSE(11)   reason: node-unavailable | closed-by-user | stopped | resume_failed
```

Reconnect: the node presents its `linkGeneration`; a `desktop` channel resumes if the helper still
has the capture (the viewer sees a stall, not an end); otherwise `resume_failed` and the viewer
reconnects a fresh view (CONTRACTS §3.1).

CONTRACTS §3.3 fixes `desktop.quality`, `desktop.refresh`, `desktop.displays`, `desktop.setDisplay`,
`desktop.openUrl` and the open params `{ source, display?, profile? }`. The `viewId` and `quality`
open params and the `desktop.stats`, `desktop.mode` and `desktop.displayChanged` messages above are
additive and are the §3.3 addition raised in spec §8b; the builder adds them to CONTRACTS in the
same PR. `desktop.openUrl { requestId, url }` (FL-10's hook, R-3) is answered `{ requestId, ok }` or
refused with the desktop reason.

---

## 7. Plugin surface

None added. Recording bytes go through the storage plugin facade
(`apps/api/src/uploads/storage-backend.factory.ts`); no capability or plugin is introduced, so
`docs/plugin-system/built-in-plugins.md` is untouched.

---

## 8. Web surface

- **Routes:** `/fleet/computers/[id]?tab=desktop[&display=…][&recording=<viewId>]` (FL-01 shell;
  constant `DASHBOARD_FLEET_COMPUTER`); Agent → Computer `?source=desktop` on the existing
  `/agents/[id]/computer` (`apps/web/src/lib/constants.ts:258`).
- **Registry entry** _(FL-01)_: `apps/web/src/components/fleet/registry.ts` → `{ id: 'desktop', label: 'fleet.computer.tabs.desktop', flag: 'FLEET_DESKTOP_ENABLED', load: () => import('./desktop/DesktopTab') }`.
- **Components** under `apps/web/src/components/fleet/desktop/` _(new)_: `DesktopTab.tsx`,
  `DesktopStage.tsx` (wraps `components/computer/ComputerStage.tsx`, adds `paintTiles`),
  `DesktopDisplayPicker.tsx`, `DesktopSourceSwitch.tsx` (also mounted in `components/computer/ComputerControls.tsx`),
  `DesktopSplitPane.tsx`, `DesktopUnavailableCard.tsx` (the §5.4 variants), `DesktopHelperNote.tsx`
  (reduced trust), `DesktopRecordingsList.tsx`, `DesktopRecordingPlayer.tsx`, `use-desktop-attach.ts`
  (sibling of `components/computer/use-computer-attach.ts`), `desktop.shared.ts` (pure: reason →
  key, display ordering, split clamp, storage keys `ew:fleet:desktop:display:<nodeId>` /
  `ew:fleet:desktop:split:<nodeId>`).
- **BFF**: `apps/web/src/app/api/fleet/nodes/[id]/desktop/**/route.ts` mirroring
  `apps/web/src/app/api/agents/[id]/computer/**`.
- **FL-04 hook**: the session header's **Desktop ▾** mounts `DesktopSplitPane` with the terminal
  pane as `left`.
- **AW-09 receipt**: `COMPUTER` block reads `recordingRef` on the bound view.
- **i18n groups** (`apps/web/messages/en.json`, namespace `fleet`): `fleet.computer.tabs.desktop`,
  `fleet.desktop.strip.*`, `fleet.desktop.status.*` (the three sentences), `fleet.desktop.controls.*`,
  `fleet.desktop.displays.*`, `fleet.desktop.unavailable.*` (one key per reason + fix),
  `fleet.desktop.helper.*` (reduced trust, commands), `fleet.desktop.split.*`,
  `fleet.desktop.recording.*` (list, player, delete confirm, caps, not-recorded reasons),
  `fleet.desktop.shortcuts.*`, `fleet.desktop.a11y.*`, `fleet.errors.*` (hints). Leaf keys
  camelCase, no literal `.`.
- **Playwright** (`apps/web/e2e/`): `flow-fleet-desktop-view.spec.ts`, `flow-fleet-desktop-control.spec.ts`,
  `flow-fleet-desktop-split.spec.ts`, `flow-fleet-desktop-recording.spec.ts`,
  `flow-fleet-desktop-contract.spec.ts`, `flow-fleet-desktop-a11y.spec.ts`; the existing
  `flow-agent-computer-*.spec.ts` must stay green.

---

## 9. Agent / MCP / CLI surface

| Tool (`fleet_<family>_<verb>`)      | Annotation                                                                       | Does                                                                                                                           | Family / consent   | Phase |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ----- |
| `fleet_desktop_screenshot`          | `readOnly: true`                                                                 | One Steady-width keyframe of `{ nodeId, displayId? }` as an image; receipt shows size/tokens                                   | `desktop` · attend | P1    |
| `fleet_desktop_displays`            | `readOnly: true`                                                                 | The display list                                                                                                               | `desktop` · attend | P1    |
| `fleet_desktop_recordings_list`     | `readOnly: true`                                                                 | Recordings for a node                                                                                                          | `desktop` · attend | P2    |
| `fleet_desktop_input`               | `destructive: true`, `confirmationClass: 'plain'`, denied unless granted (AW-15) | Acquires the control grant for `agent:<id>`, sends a scripted list of pointer/key/text events, releases; `busy` under a person | `desktop` · attend | P2    |
| `fleet_desktop_set_display`         | `destructive: false`                                                             | Changes the display of the Agent's own view                                                                                    | `desktop` · attend | P2    |
| `fleet_desktop_display_add\|remove` | `destructive: true`, `confirmationClass: 'confirm'` → raises an approval         | Virtual display (Linux X11)                                                                                                    | `desktop` · attend | P3    |

Implemented in `packages/agent/src/fleet/agent-fleet-desktop-tools.ts` _(new)_ beside
`agent-fleet-tools.ts`; MCP entries in `apps/mcp/src/openapi-tools/whitelist.ts` with the same
annotations; CLI `ever-works fleet desktop shot|displays|input|recordings [--json]` in
`apps/cli/src/commands/fleet/desktop.ts` _(FL-19 creates `commands/`; this file lands with FL-19 or
after)_. Every tool returns `{ error: { code, hint, details } }` on refusal.

---

## 10. Background jobs

| Task                    | File                                                                           | Trigger           | Does                                                                                                                                                                                                                          | Idempotency                                    |
| ----------------------- | ------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `computer-recording-gc` | `packages/tasks/src/tasks/trigger/computer-recording-gc.task.ts` _(new)_       | cron `23 3 * * *` | For rows with `recordingExpiresAt < now` and `recordingRef`: delete storage objects **first**, then set `recordingRef = null`, `recordingStoppedReason = 'deleted'`; a failed object delete leaves the row for the next sweep | row-level `UPDATE … WHERE recordingRef = :ref` |
| Recording writer        | in-process on the API replica that holds the relay (`DesktopRecordingService`) | per view          | Samples ≤ 1 keyframe/s, buffers 60 s chunks, writes through the storage facade, closes the index on view end; stops at 200 MB / 4 h                                                                                           | chunk `seq` monotonic; close is idempotent     |

Dispatch through `COMPUTER_RECORDING_GC_DISPATCHER` in `packages/agent/src/fleet/desktop/` (not
re-exported through `@ever-works/agent/tasks`, so `_tasks-symbols.ts` needs no entry).

---

## 11. Security & permissions

- **Threats specific to this epic:** a tampered helper capturing or injecting; a helper reachable by
  another local user; input injected without a grant; pictures or typed text leaking into logs or
  audit; a viewer outside the audience seeing a desktop; a stuck modifier key after a dropped
  socket; a recording readable by the wrong audience.
- **What the node refuses:** starting a helper whose fingerprint or signature differs from the
  admitted record (checked immediately before spawn, file handle held open on Windows via the
  existing broker); any helper IPC endpoint not owned by the node's user; any `INPUT` while the
  view's last `desktop.mode` was `watching`; blocked shortcuts; frames over the link cap; a
  `setDisplay` to an unknown id; `openUrl`/`pasteText` without the source available.
- **Redaction:** pictures and tiles are never logged; `stats` carries numbers only; audit details
  carry `displayId`, `source`, `quality`, `durationMs`, `bytes`, `fingerprintPrefix` (8 hex) — never
  a full hash under a key the redactor would eat, never text.
- **Audit (one writer, `FleetAuditService`)**: `node.desktop.view` (open), `node.desktop.display.set`,
  `node.desktop.control.take|release|request`, `node.desktop.recording.start|stop|delete`,
  `node.helper.admit|revoke|verify-failed` (from the node's heartbeat `helperEvents`, de-duplicated
  by event id), `node.desktop.display.add|remove` (P3); `requestedBy` = `user:<id>` | `agent:<id>`;
  `confirmationClass` recorded. Browser-source views opened from Agent → Computer keep writing the
  existing `computer.*` names (`packages/contracts/src/fleet/fleet-panic.types.ts:100-114`) exactly as
  today; only Desktop-source views write `node.desktop.*`, so no action is audited twice.
- **Permission:** FL-01's `resolveNodeRole(user, node)` → audience check on `controlPolicy.desktop`
  for watch and control; Agents additionally need the tool grant (AW-15) and trust level (AW-24).
- **Kill switch (R-24):** the platform sends `link.pause` (CONTRACTS §3.2), so the node drops every
  `INPUT` at once; `channel.open` is refused `kill_switch`; the relay ends every desktop view within
  5 s (`stopped`), releasing control and closing recordings first.
- **Helper least privilege:** the helper receives no environment but `DISPLAY`/`XAUTHORITY` (Linux)
  and the IPC path; it never reads the clipboard (FL-11 writes to it only on an explicit paste),
  never touches files, never opens sockets.

---

## 12. Observability

- Activity Log: `fleet.desktop.viewed`, `fleet.desktop.controlled` (on release, duration, actor
  kind), `fleet.desktop.recorded` (bytes, duration), `fleet.helper.admitted|revoked` (level).
- Metrics: `fleet_desktop_first_frame_ms`, `fleet_desktop_tiles_per_sec`, `fleet_desktop_bytes_out`,
  `fleet_desktop_input_rtt_ms`, `fleet_helper_restarts_total`, `fleet_helper_admissions_total{level}`,
  `fleet_recording_bytes_total`, `fleet_recording_gc_deleted_total`.
- Health: `GET /api/health/ready` `fleet_relay` (FL-02, CONTRACTS R-7) covers desktop relays.
- Node `doctor` prints helper status, level, fingerprint prefix, permission facts and display count.

---

## 13. Phased rollout (flag `FLEET_DESKTOP_ENABLED`, default off in production)

- **P1 — See the desktop** (slot 00): contracts, helper crate (capture, displays, protocol, tiles),
  node backend + trust + admission + CLI verbs + tags, link `desktop` channel, API views/availability/
  displays, viewer gateway path, Desktop tab, source switch on Agent → Computer, unavailable card,
  reduced-trust note, read-only tools, audit, i18n, e2e view + contract. Green: existing
  `flow-agent-computer-*` unchanged; `flow-fleet-desktop-view.spec.ts` green with the fake helper.
- **P2 — Drive and keep it** (slot 01): helper input per OS + `releaseAll`, `input` tag, control
  routes on views via the arbiter, `desktop.mode`, split pane + FL-04 header hook, `openUrl`/`pasteText`
  hooks, recording writer + columns + player + receipt block + GC task, Agent input tool, AW-11
  tracker update. Green: `flow-fleet-desktop-control|split|recording.spec.ts`.
- **P3 — Trust and headless**: signed verification (macOS `codesign`, Windows broker reuse), manifest
  `signedSha256`/`signer`, helper note removal, Linux X11 virtual displays + tools + confirm, a11y
  sweep. Green: `flow-fleet-desktop-a11y.spec.ts`; signed fixture test on Windows CI.
- **Default-on** after acceptance tests are green on `develop` (D12).

---

## 14. Test plan

Runners: `packages/contracts`, `apps/node`, `apps/web` unit → **Vitest**; `packages/agent`,
`apps/api` → **Jest**; `apps/web` e2e → **Playwright**; helper → `cargo test` (+ a fake-OS backend).

- **Contracts (Vitest)** `packages/contracts/src/fleet/__tests__/fleet-desktop-tiles.codec.spec.ts`
  — round-trip, over-cap rejected before parse, dimension bounds, never throws;
  `fleet-desktop.types.spec.ts` — guards for sources, trust levels, reasons;
  `computer/__tests__/computer-session.types.spec.ts` — reasons extended, old set preserved.
- **Helper (cargo)** `apps/node/native/ever-works-screen/tests/{protocol,tiles,displays,input_release}.rs`
  — protocol fuzz, tile diff on synthetic frames (unchanged → zero tiles; one pixel → one tile),
  JPEG size caps, `releaseAll` releases every pressed key/button, Wayland detection refuses.
- **Node (Vitest)** `apps/node/src/core/screen/desktop-helper-backend.spec.ts` (availability from
  facts, start/stop, tiles forwarded, dispatchInput only while controlling),
  `helper/helper-trust.spec.ts` (altered file refused before spawn; policy parse; signed path on a
  fixture), `helper/helper-admission.spec.ts` (both fingerprints printed; `admit` typed; revoke
  stops), `helper/helper-process.spec.ts` (restart cap; releaseAll on disconnect),
  `desktop-host.spec.ts`, `apps/node/src/core/link/modules/desktop.spec.ts` (message
  table above; INPUT dropped while watching), `capabilities.spec.ts` (tags iff facts; `input` rule),
  `apps/node/src/cli/program.helper.spec.ts`.
- **Agent (Jest)** `packages/agent/src/fleet/desktop/__tests__/desktop-view.service.spec.ts`
  (open refusals per code; caps shared with browser views; display persistence),
  `desktop-view.policy.spec.ts` (reason precedence incl. the eight new), `desktop-recording.service.spec.ts`
  (≤ 1 fps, 200 MB / 4 h caps, storage outage degrades, index close, retention stamp),
  `helper-trust.service.spec.ts` (heartbeat → `helperTrust`, needs-a-look producer),
  `agent-fleet-desktop-tools.spec.ts` (annotations; input tool denied by default; `busy` under a person),
  `packages/agent/src/computer/__tests__/control-arbiter.spec.ts` extended for an `agent:` actor.
- **API (Jest)** `apps/api/src/fleet/desktop/fleet-desktop.controller.spec.ts` (every error code
  with hint; audience matrix; attach-token role downgrade only), `fleet-desktop-relay.spec.ts`
  (FRAME/TILES fan-out; INPUT only from the holder; recording sampling), `fleet-desktop-recordings.controller.spec.ts`
  (chunk headers; delete needs confirmation).
- **Tasks (Jest)** `packages/tasks/src/__tests__/computer-recording-gc.task.spec.ts` (object first,
  row second; failed delete leaves the row).
- **Web unit (Vitest)** `desktop.shared.unit.spec.ts`, `DesktopStage.unit.spec.tsx` (tile painting
  at offsets; keyframe resets), `DesktopDisplayPicker.unit.spec.tsx`, `DesktopUnavailableCard.unit.spec.tsx`
  (one card per reason), `DesktopSplitPane.unit.spec.tsx` (clamp, keyboard, persistence),
  `DesktopRecordingPlayer.unit.spec.tsx`.
- **E2E (Playwright)** §8 list; the e2e harness ships a **fake helper** (a Node script speaking the
  helper protocol with synthetic frames) so CI never needs a real display.

---

## 15. Risks

| Risk                                                              | L   | I   | Mitigation                                                                                                                           |
| ----------------------------------------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| macOS TCC re-prompts after every hash-pinned helper update        | H   | M   | Say so in the UI (FR-22); P3 signed admission with a stable identifier ends it.                                                      |
| Windows service in session 0 cannot reach the interactive desktop | M   | H   | Scheduled-task launch into the console session as the enrolling user; `no-display-session` when none.                                |
| Helper distribution and fingerprints drift from the node package  | M   | H   | Manifest baked at publish; `helper install` refuses a fingerprint not in the manifest; CI verifies manifest ↔ release assets.        |
| Tile diff CPU on 4K displays                                      | M   | M   | Downscale first; per-core bands; Steady preset; NFR budget tested in `cargo bench`.                                                  |
| Agent-driven input misused                                        | M   | H   | Default denied; same grant as a person; `busy` under a person; every event recorded and audited.                                     |
| Relay replica restart loses a live view                           | M   | L   | Same as AW-11: the view ends with `error`, Reconnect offered; recordings are in storage.                                             |
| FL-02 link lands later than planned                               | M   | H   | FL-07 is blocked by FL-02 by design; the helper crate and admission (P1 node-side) can land first behind the flag with no link path. |
| Local IPC judged outside D2                                       | L   | M   | Settled by CONTRACTS R-26 (same-user local IPC is inside D2); child stdio stays the Linux path.                                      |

---

## 16. Constitution reconciliation

- **I Plugin-first:** no external integration; OS capture on the owner's machine inside the node app
  (D8 precedent `apps/node/src/core/executors/browser-check.ts`); storage via plugin facade.
- **II Capability-driven:** storage resolved through the facade; backends selected by capability.
- **III Source-of-truth repos:** nothing content-like enters the database.
- **IV Job runtime:** the GC is a scheduled task via a dispatcher symbol.
- **V Forward-only migrations:** two additive migrations, nullable widening only, `down` exact.
- **VI Tests:** §14, including the helper's own suite and a fake helper for e2e.
- **VII Secrets:** no pictures or text in logs/audit; the helper receives no credentials;
  verification before every start.
- **VIII Plugin counts:** untouched.
- **IX Behaviour-first:** spec names no class; this plan owns the implementation.
- **X Backwards compatibility:** additive unions, optional heartbeat fields, the browser source and
  `/api/agents/:id/computer/*` untouched.

---

## 17. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md)
- Program: [README](../README.md) D2, D3, D7, D13 · [CONTRACTS](../CONTRACTS.md) §1–§3, §7–§10,
  §13 · [CAPABILITY-MAP §C](../CAPABILITY-MAP.md)
- AW-11 plan §2.4 (control arbitration), §3 (session entity), §6 (background work):
  [`../../agent-workspace/AW-11-agent-computers/plan.md`](../../agent-workspace/AW-11-agent-computers/plan.md)
- Helper trust precedent: `apps/node/native/windows-job-launcher/PACKAGING.md`
- Security model: `docs/specs/security/fleet-session-trust-model.md`
