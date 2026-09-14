# AW-11 — Agent computers · Implementation plan

> How [`spec.md`](./spec.md) gets built. Implementation detail belongs here, not in the spec
> (Constitution IX). Every path below was verified to exist in the repository before it was cited.

**Epic ID:** `AW-11-agent-computers`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-09-06
**Last updated:** 2026-09-06

---

## 1. Current state in the codebase

The Fleet subsystem is mature. This epic is a _surfacing_ job on top of it plus two genuinely new
pieces: a visual channel and a demonstration-to-Skill pipeline.

### 1.1 What a Node already is

| Piece                                                                                               | Where                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node registry, enrolment, drain, rotate, capability pinning                                         | `apps/api/src/fleet/fleet.controller.ts`, `packages/agent/src/fleet/fleet.service.ts`, `packages/agent/src/fleet/fleet-node.repository.ts`                                                  |
| Node entity                                                                                         | `packages/agent/src/entities/fleet-node.entity.ts`                                                                                                                                          |
| Job entity + lease protocol (CAS claim, capability filter, target-node filter, keep-alive, reclaim) | `packages/agent/src/entities/fleet-job.entity.ts`, `packages/agent/src/fleet/fleet-job.service.ts`, `apps/api/src/fleet/fleet-jobs.controller.ts`                                           |
| Node-secret authentication at the edge                                                              | `apps/api/src/fleet/guards/fleet-node-auth.guard.ts`, `packages/agent/src/fleet/fleet-node-credential.ts`                                                                                   |
| Agent↔Node affinity (entity, service, enqueue snapshot, lease filter)                               | `packages/agent/src/entities/fleet-agent-node-affinity.entity.ts`, `packages/agent/src/fleet/fleet-agent-node-affinity.service.ts`, `apps/api/src/fleet/fleet-agent-affinity.controller.ts` |
| Affinity UI (already shipped — the "Execution" section of the Capabilities tab)                     | `apps/web/src/components/agents/AgentFleetSection.tsx`, `apps/web/src/components/agents/agent-fleet.shared.ts`                                                                              |
| Runtime routing (local-wait / local-fallback / cloud, narrowest-wins)                               | `apps/api/src/fleet/fleet-run-router.service.ts`, `apps/api/src/fleet/fleet-agent-task.dispatcher.ts`                                                                                       |
| Runner status composer behind the sidebar pill                                                      | `apps/api/src/fleet/fleet-runner-status.service.ts`                                                                                                                                         |
| Panic controls + kill switch                                                                        | `apps/api/src/fleet/fleet-panic.controller.ts`, `apps/api/src/fleet/fleet-kill-switch.controller.ts`, `packages/agent/src/fleet/fleet-kill-switch.service.ts`                               |
| **Fleet audit ledger — one writer, redaction-hardened**                                             | `packages/agent/src/fleet/fleet-audit.service.ts`, `packages/agent/src/entities/fleet-audit.entity.ts`, action union in `packages/contracts/src/fleet/fleet-panic.types.ts`                 |
| Node process: heartbeat, capability probe, lease loop, executors                                    | `apps/node/src/core/heartbeat.ts`, `apps/node/src/core/capabilities.ts`, `apps/node/src/core/worker-loop.ts`, `apps/node/src/core/runtime.ts`                                               |
| Node's browser discovery — one probe, two consumers                                                 | `apps/node/src/core/browser-probe.ts` (`BROWSER_PATH_ENV`, `BROWSER_PATH_COMMANDS`)                                                                                                         |
| Node's real-Chrome executor (the precedent for driving a local browser from Node core)              | `apps/node/src/core/executors/browser-check.ts`                                                                                                                                             |
| Node CLI verbs (`enroll`, `start --work`, `pause`, `status`, …)                                     | `apps/node/src/cli/program.ts`                                                                                                                                                              |
| Per-Task git worktree provisioning on the Node                                                      | `apps/node/src/core/workspaces/fleet-task-workspace.ts`                                                                                                                                     |

Two structural facts shape everything below:

1. **The channel is outbound-only.** Nothing connects _into_ a Node and no port is opened on the
   user's machine (`apps/node/src/core/worker-loop.ts` states this as a design rule). The screen
   channel therefore has to be _published outward_ by the Node exactly the way terminal frames are
   published outward by the job worker today. There is no negotiation about this.
2. **`FleetJobKind` is a closed three-value union** —
   `packages/contracts/src/fleet/fleet-jobs.types.ts:104` — and none of the three is an interactive
   session.

### 1.2 What the streaming terminal already is

| Piece                                                                                                                                  | Where                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Frozen wire protocol (`auth`/`stdin`/`resize` in, `stdout`/`exit`/`error` out; 1 MiB frame cap; direction map; null-never-throw codec) | `packages/contracts/src/terminal/terminal-frame.types.ts`, `packages/contracts/src/terminal/terminal-frame.codec.ts`                 |
| WebSocket gateway on the API's own HTTP upgrade, token in the first frame never in the URL, 4001 after 5 s, 30 s ping                  | `apps/api/src/terminal/terminal-ws.service.ts`                                                                                       |
| In-memory relay: rolling scrollback, replay on attach, pinned `exit`, seq dedupe, role-checked fan-out, reclaim rule                   | `apps/api/src/terminal/terminal-relay.registry.ts`                                                                                   |
| Attach-token minting + role downgrade (`driver` / `viewer` / `worker`)                                                                 | `apps/api/src/terminal/terminal-attach.controller.ts`, `apps/api/src/terminal/terminal-attach.service.ts`                            |
| Worker-facing frame publish / heartbeat / worker-token, shared-secret authenticated                                                    | `apps/api/src/terminal/terminal-internal.controller.ts`                                                                              |
| Session launcher with a CAS claim on the run's terminal slot                                                                           | `packages/agent/src/agents/terminal-session-launcher.service.ts`                                                                     |
| Dispatch port + argv resolution (operator-configured, never caller-supplied)                                                           | `packages/agent/src/agents/terminal-session-dispatcher.ts`                                                                           |
| The session task                                                                                                                       | `packages/tasks/src/tasks/trigger/terminal-session.task.ts`                                                                          |
| Transcript persistence + retention GC                                                                                                  | `packages/agent/src/entities/terminal-transcript-chunk.entity.ts`, `packages/tasks/src/tasks/trigger/terminal-transcript-gc.task.ts` |
| Browser pane (xterm.js with a dependency-free DOM floor)                                                                               | `apps/web/src/components/terminal/TerminalPane.tsx`, `create-terminal-renderer.ts`, `use-terminal-attach.ts`                         |
| Pluggable session host behind a capability                                                                                             | `packages/plugin/src/contracts/capabilities/terminal-stream.interface.ts`, `packages/plugins/pty-local/src/pty-local.plugin.ts`      |

**This is the template.** The screen channel is the same shape one level over: a frozen frame
protocol in `@ever-works/contracts`, an outbound publish endpoint, a relay, an attach token, a
WebSocket, and a renderer. Where the terminal's producer is the job worker, the screen's producer
is the Node.

### 1.3 What is missing

| Needed                                          | State today                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A visual channel of any kind                    | Nothing. No screenshot capability, job kind or endpoint exists in the fleet, node or terminal modules.                                                                   |
| Input forwarding into a machine                 | Nothing.                                                                                                                                                                 |
| A terminal that runs **on the Node**            | Nothing. The Node advertises a `terminal` tag (`BASE_CAPABILITIES = ['terminal','workspace']`, `apps/node/src/core/capabilities.ts:65`) that no job kind ever exercises. |
| Per-Agent browser profile / file root on a Node | Nothing. The Node provisions a per-**Task** git worktree; nothing is per-Agent or durable.                                                                               |
| A record of who watched or controlled a machine | Nothing — but the ledger to write it into exists and is already the one writer for every fleet action.                                                                   |
| Recording of a session                          | Nothing for screen. Terminal transcripts exist as a working precedent for retention + GC.                                                                                |
| Demonstration → Skill                           | Nothing. Skills are authored as Markdown in a plain textarea (`apps/web` Skill detail page still uses a Write/Preview textarea, per that page's own note).               |

### 1.4 Adjacent pieces this epic reuses rather than rebuilds

- **Skill / SkillBinding** — `packages/agent/src/entities/skill.entity.ts`,
  `packages/agent/src/entities/skill-binding.entity.ts`. A draft becomes a Skill owned at `agent`
  scope with a binding to that Agent.
- **Approval queue** — `packages/agent/src/entities/agent-action-proposal.entity.ts`. Its
  `actionType` is a plain `varchar(32)` with **no DB check constraint** (see
  `apps/api/src/migrations/*-CreateAgentActionProposals.ts`), so adding `adopt_skill` is a
  TypeScript-union change with no migration.
- **Secret scanner** — `packages/agent/src/utils/secret-scan.ts` (`scanForSecrets`,
  `containsSecret`, `redactSecrets`, `assertNoSecrets`). Its pattern set is pure; only
  `assertNoSecrets` imports NestJS. `apps/node` already depends on `@ever-works/contracts`, so the
  pure half moves there and both sides share one definition.
- **Storage** — `apps/api/src/uploads/storage-backend.factory.ts` (`getActiveStorageBackend`) and
  `apps/api/src/uploads/uploads.service.ts` (`getBackend()`), returning an `IStoragePlugin`.
  Recording bytes go here; only metadata rows go to the database.
- **Activity log** — `apps/api/src/activity-log/activity-log.listener.ts`.
- **Fleet gating** — `apps/web/src/lib/fleet-flags.ts` (`isFleetEnabled`, default **on**).

### 1.5 Summary of the delta

```
   EXISTS                                        NEW IN THIS EPIC
   ────────────────────────────────────────      ─────────────────────────────────────
   Node registry, enrol, heartbeat, lease   ──►  + computer-session job kind
   Capability probe (browser, display)      ──►  + screen / input / attended tags
   Outbound-only worker loop                ──►  + attended fast-lane poll
   Terminal frame protocol + relay + WS      ──►  + computer frame protocol, relay, WS
   pty-local terminal-stream plugin          ──►  + screen-stream capability + plugin
   Per-Task git worktree on the node         ──►  + per-Agent profile on the node
   Fleet audit ledger                        ──►  + 8 computer actions
   Skill + binding + approval queue          ──►  + demonstration → draft → adopt
   Terminal transcript + GC                  ──►  + recording segments + GC
```

---

## 2. Architecture and the seam it plugs into

### 2.1 The whole path, once

```
 BROWSER                       API                          NODE (user's machine)
 ───────                       ───                          ────────────────────
 open surface
   │ POST /api/agents/:id/computer/sessions
   ├──────────────────────────►│
   │                           │ create computer_sessions row (requested)
   │                           │ enqueue fleet_job kind=computer-session
   │                           │   targetNodeId = chosen node
   │  202 { sessionId }        │
   │◄──────────────────────────┤
   │ POST …/attach-token       │                    ┌── attended fast poll (2 s)
   │◄──────────────────────────┤◄───────────────────┤ POST /api/fleet/jobs/lease
   │                           │  job payload       │   kinds:['computer-session']
   │ ws /ws/computer/:sessionId│                    │
   ├──────────auth frame──────►│                    │ start capture:
   │                           │                    │  · attach CDP to the agent's
   │                           │◄───────────────────┤    own browser profile
   │◄──────frame frames────────┤ POST /api/internal/computer/:sessionId/frames
   │                           │  (batch ≤ 8 / 512 KiB, outbound only)
   │                           │
   │──────pointer/key─────────►│  relay holds them for the node's inbound leg
   │                           │──── node's own attach WS (worker role) ──────►│
   │                           │                    │ inject via CDP Input.*
```

The Node opens **its own** WebSocket to the API for the inbound (input) leg — the same trick the
terminal worker uses today (`role: 'worker'` token brokered by run id in
`apps/api/src/terminal/terminal-internal.controller.ts`). Nothing ever connects into the Node.

### 2.2 New module boundaries

| Layer         | New unit                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts     | `packages/contracts/src/computer/` — frame protocol + codec + session view types; `packages/contracts/src/secret/` — the pure secret-pattern scanner extracted from the agent package |
| Plugin SDK    | `packages/plugin/src/contracts/capabilities/screen-stream.interface.ts` + `SCREEN_STREAM` in `packages/plugin/src/contracts/facade-capabilities.ts`                                   |
| Plugin        | `packages/plugins/screen-cdp/` — the cloud-side `screen-stream` provider (P3)                                                                                                         |
| Agent package | `packages/agent/src/computer/` — session service, control arbiter, recording service, demonstration service, synthesis prompt builder, dispatch ports                                 |
| API           | `apps/api/src/computer/` — public controller, internal (node-facing) controller, relay registry, attach service, WS gateway, module                                                   |
| Node          | `apps/node/src/core/screen/` — CDP capture pump, input injector, per-Agent profile manager, demonstration recorder; `apps/node/src/core/executors/computer-session.ts`                |
| Web           | `apps/web/src/app/[locale]/(dashboard)/agents/[id]/computer/`, `apps/web/src/components/computer/`                                                                                    |
| Tasks         | three tasks under `packages/tasks/src/tasks/trigger/`                                                                                                                                 |

### 2.3 Why the capture lives in Node core, not in a plugin

Constitution I requires every **external integration** to be a plugin. Driving the Chromium binary
that is already on the user's machine is not an external integration, and the repository has
already settled this case: `apps/node/src/core/executors/browser-check.ts` spawns a real Chrome
found by `apps/node/src/core/browser-probe.ts`, in Node core, with no plugin. `apps/node` has no
plugin runtime at all — its only `@ever-works/plugin` imports are _type-only_ (see
`apps/node/src/core/workspaces/fleet-task-workspace.ts`). Introducing one to satisfy a rule that
does not apply would be a large regression in that app's design.

What _is_ pluggable is the **cloud-hosted** capture path, and that ships as a real plugin behind a
real capability (`screen-stream`, mirroring `terminal-stream` exactly), so a future `screen-vnc`
or `screen-k8s` provider drops in without touching core. No caller names a provider id: the API
resolves through a facade, exactly as the terminal path does.

### 2.4 Control arbitration

One controller per **Node** (not per session), held as a row-level CAS on `fleet_nodes`:

```
 take control  →  UPDATE fleet_nodes
                  SET controlHolderUserId = :user,
                      controlHolderSessionId = :session,
                      controlHeldSince = now(),
                      controlExpiresAt = now() + 60 min
                  WHERE id = :node
                    AND (controlHolderUserId IS NULL OR controlExpiresAt < now())
                  → rowsAffected = 1 wins, 0 loses and reads the current holder
```

Same posture as the terminal launcher's CAS claim on the run's terminal slot. Release is an
owner-scoped `UPDATE … SET controlHolder* = NULL WHERE controlHolderSessionId = :session`, so a
stale releaser can never evict a newer holder. Idle release, the 60-minute ceiling and the
30-second disconnect release are all driven by `controlExpiresAt` plus a `lastInputAt` on the
session, swept by the session-reaper task and re-checked on every inbound input frame.

### 2.5 Where the terminal channel comes from

The `computer-session` job payload carries `channels: ('screen' | 'terminal')[]`. When `terminal`
is present the Node's executor spawns a PTY locally and publishes `TerminalFrame`s — the **existing**
protocol from `packages/contracts/src/terminal/terminal-frame.types.ts` — wrapped in a computer
frame envelope so one socket carries both channels. The browser reuses
`apps/web/src/components/terminal/create-terminal-renderer.ts` unchanged. This finally puts an
executor behind the `terminal` capability tag every Node already advertises.

The existing `/agents/[id]/terminal` tab and its worker-hosted session are untouched.

#### Required capabilities are derived from the requested channels

The fleet lease matcher requires **every** tag on a job: `nodeSatisfiesCapabilities` in
`packages/contracts/src/fleet/fleet-jobs.types.ts` returns `required.every((tag) => available.has(tag))`,
and `FleetJobService`'s lease loop (`packages/agent/src/fleet/fleet-job.service.ts`) skips any
candidate that fails it. A fixed tag list would therefore lock out every display-less Node from
a terminal-only session. The dispatcher never hard-codes the list; it calls one pure function in
`computer-session.policy.ts`:

```ts
requiredCapabilitiesForChannels(channels: readonly ComputerChannel[]): string[]
// ['screen']             -> ['attended', 'screen']
// ['terminal']           -> ['attended', 'terminal']
// ['screen', 'terminal'] -> ['attended', 'screen', 'terminal']
// []                     -> refused before enqueue (FR-4 requires a channel)
```

- `screen` is added only when the screen channel is requested; `terminal` only when the terminal
  channel is requested.
- `attended` is added for **every** session and is not a display requirement. It is the Node's
  live-viewing switch (`--attend`, spec U4), advertised independently of any display. It has to
  stay on terminal-only sessions because it is the only server-side gate on them: lease
  candidates are not filtered by job kind (`FleetJobRepository.findQueuedForNode`), and
  `terminal` is in `BASE_CAPABILITIES` (`apps/node/src/core/capabilities.ts`), so without
  `attended` any enrolled Node's ordinary work lane could lease a live shell session its owner
  never switched on.
- A headless server started with `--attend` advertises `terminal`, `workspace` and `attended` and
  no `screen`, so it satisfies a terminal-only session and fails a screen session — which is the
  behaviour spec FR-4a requires.

`resolveWatchability` applies the same split: `no-browser` and `no-display` remove only the screen
channel, `no-terminal` removes only the terminal channel, and a Node is unwatchable only when no
channel remains. `POST /sessions` validates the requested channels against that result before
enqueueing, so a refused channel is a `422` naming the missing capability rather than a job no
Node will ever lease.

---

## 3. Data model

All new entities live in `packages/agent/src/entities/` and follow house conventions: string
unions in plain `varchar` columns (no DB enums), `PortableDateColumn` for timestamps, raw `uuid`
columns rather than `@ManyToOne` where a forward-import cycle is possible, FKs added by the
migration rather than the decorator.

### 3.1 New entities

#### `computer-session.entity.ts` → `computer_sessions`

| Column                                | Type                                   | Notes                                                           |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `id`                                  | uuid PK                                | Doubles as the relay channel id and the WS path segment.        |
| `userId`                              | uuid                                   | Owner scope, as every fleet row.                                |
| `organizationId`                      | uuid?                                  | Tier-A scope stamp.                                             |
| `agentId`                             | uuid                                   | Whose computer this is.                                         |
| `nodeId`                              | uuid                                   | Which machine.                                                  |
| `openedByUserId`                      | uuid                                   | Who opened it (may differ from `userId` for an org member).     |
| `runId`                               | uuid?                                  | Bound at first frame when the Node is executing for this Agent. |
| `fleetJobId`                          | uuid?                                  | The `computer-session` job that carries it.                     |
| `channels`                            | simple-json `('screen'\|'terminal')[]` | Requested channels.                                             |
| `activeChannel`                       | varchar(16)                            | `screen` \| `terminal`.                                         |
| `quality`                             | varchar(8)                             | `sharp` \| `smooth` \| `steady`.                                |
| `status`                              | varchar(16)                            | `requested` \| `live` \| `stalled` \| `ended`.                  |
| `closeReason`                         | varchar(24)?                           | Closed set from spec §5.2.                                      |
| `controlSpans`                        | simple-json                            | `{userId,startedAt,endedAt,reason}[]`, capped 50.               |
| `recorded`                            | boolean default false                  |                                                                 |
| `recordingSkippedReason`              | varchar(32)?                           | e.g. `storage-unavailable`, `not-opted-in`.                     |
| `frameCount` / `bytesOut`             | int / bigint default 0                 | Drives the bandwidth readout.                                   |
| `lastFrameAt` / `lastInputAt`         | PortableDate?                          | Stall + idle detection.                                         |
| `startedAt` / `endedAt` / `createdAt` | PortableDate                           |                                                                 |

Indexes: `(userId, status)`, `(nodeId, status)`, `(agentId, createdAt)`, `(runId)`.

#### `computer-recording-segment.entity.ts` → `computer_recording_segments`

Mirrors `terminal_transcript_chunks`. `id` · `sessionId` · `seq` int · `channel` varchar(16) ·
`storageKey` varchar(512) (bytes live in the storage plugin, **never** in the row) · `mime`
varchar(32) · `sizeBytes` int · `capturedAt` PortableDate · `durationMs` int · `expiresAt`
PortableDate. Unique `(sessionId, seq)`; index `(expiresAt)` for the GC sweep.

#### `node-agent-profile.entity.ts` → `node_agent_profiles`

`id` · `userId` · `organizationId?` · `nodeId` · `agentId` · `profileKey` varchar(64) (an opaque
id the Node maps to a directory — the platform never stores a filesystem path) · `createdAt` ·
`lastUsedAt?` · `signedInSiteCount` int default 0 · `diskBytes` bigint default 0 ·
`lastResetAt?` · `lastResetByUserId?`. Unique `(nodeId, agentId)`; index `(userId, agentId)`.

#### `agent-demonstration.entity.ts` → `agent_demonstrations`

`id` · `userId` · `organizationId?` · `agentId` · `nodeId` · `sessionId?` · `runId?` ·
`intent` varchar(120) · `status` varchar(24) (`recording` \| `captured` \| `synthesising` \|
`drafted` \| `synthesis-failed` \| `adopted` \| `discarded`) · `stepCount` int ·
`secretCount` int · `stopReason` varchar(24)? (`finished` \| `step-cap` \| `time-cap` \|
`control-lost` \| `cancelled`) · `draft` simple-json? (title, description, instructions,
requiredInputs, requiredSecrets) · `proposalId` uuid? · `skillId` uuid? ·
`synthesisAttempts` int default 0 · `synthesisError` varchar(256)? · `expiresAt` PortableDate ·
`createdAt` / `updatedAt`. Indexes `(userId, status)`, `(agentId, createdAt)`, `(expiresAt)`.

#### `agent-demonstration-step.entity.ts` → `agent_demonstration_steps`

`id` · `demonstrationId` · `seq` int · `kind` varchar(16) (`navigate` \| `click` \| `type` \|
`press` \| `scroll` \| `select` \| `upload` \| `wait`) · `origin` varchar(200)? ·
`path` varchar(400)? (query values already stripped on the Node) · `role` varchar(40)? ·
`accessibleName` varchar(200)? · `selector` varchar(400)? · `value` varchar(200)? ·
`redacted` boolean default false · `redactionReason` varchar(32)? (`password-field` \|
`otp-field` \| `credential-label` \| `secret-scanner`) · `screenshotStorageKey` varchar(512)? ·
`occurredAt` PortableDate. Unique `(demonstrationId, seq)`.

### 3.2 Columns added to existing entities

- `packages/agent/src/entities/fleet-node.entity.ts`
    - `controlPolicy` `varchar(24)` default `'owner'` — `owner` \| `org-admins` \| `org-members`.
    - `recordWatchSessions` `boolean` default `false`.
    - `recordingRetentionDays` `int` default `14` (clamped 1–90 in the service).
    - `controlHolderUserId` `uuid` null, `controlHolderSessionId` `uuid` null,
      `controlHeldSince` PortableDate null, `controlExpiresAt` PortableDate null — the CAS lock
      from §2.4.
- `packages/agent/src/entities/agent-run.entity.ts`
    - `computerRecordedAt` PortableDate null — set when the first recording segment for a session
      bound to this run is written. A cheap flag so the receipt does not need a join to decide
      whether to render _Watch the recording_.

### 3.3 Migrations (forward-only, `apps/api/src/migrations/`)

Migrations are **authored** from `apps/api/`; nothing runs by hand on deploy — the API self-applies
on boot. One migration per phase, additive only, `down` dropping exactly what `up` added.

| Phase | File                                         | Contents                                                                                                                                        |
| ----- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | `1791110000000-CreateComputerSessions.ts`    | `computer_sessions`, `node_agent_profiles`, 7 `ADD COLUMN` on `fleet_nodes`, their indexes. No `NOT NULL` without a default; no `ALTER … TYPE`. |
| P2    | `1791110100000-CreateAgentDemonstrations.ts` | `agent_demonstrations`, `agent_demonstration_steps`, indexes.                                                                                   |
| P3    | `1791110200000-CreateComputerRecordings.ts`  | `computer_recording_segments`, its indexes, and `agent_runs.computerRecordedAt`.                                                                |

`apps/api/src/migrations/` already holds 175 migrations; follow the neighbouring
`1789000000000-AddFleetCredentialRotation.ts` for naming and shape. Timestamps are AW-11 slots
00–02 of the program's reserved migration blocks ([README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)); re-stamp before merge if
`develop` has moved past them.

### 3.4 Contracts

New: `packages/contracts/src/computer/`

- `computer-frame.types.ts` — the frozen wire protocol, written to the same invariants as
  `packages/contracts/src/terminal/terminal-frame.types.ts` (size-capped **before** parse,
  null-never-throw, direction-mapped kinds, normalized field-by-field construction).

    ```
    server → client:  frame · mode · stats · error · end
    client → server:  auth · pointer · key · text · scroll · quality · refresh · control
    node   → server:  frame · terminal · stats · profile · step · end     (via the internal endpoint)
    ```

    Constants: `COMPUTER_MAX_FRAME_BYTES = 512 * 1024`, `COMPUTER_MAX_BATCH_FRAMES = 8`,
    `COMPUTER_QUALITY_PRESETS` (the three named tiers with their width / fps / keyframe interval),
    `COMPUTER_CLOSE_REASONS`, `COMPUTER_CONTROL_RELEASE_REASONS`.

- `computer-frame.codec.ts` — encode/decode/normalize, hand-rolled (the package is
  zero-dependency by design).
- `computer-session.types.ts` — `ComputerSessionView`, `ComputerNodeOption` (with the closed-set
  `unwatchableReason`, plus `servableChannels: ComputerChannel[]` and a per-channel reason so the
  picker can say which channel is unavailable and why — spec FR-4, FR-70), `NodeAgentProfileView`, `DemonstrationView`, `DemonstrationStepView`,
  `DraftSkillView`.

Changed (additive only, Constitution X):

- `packages/contracts/src/fleet/fleet-jobs.types.ts` — add `'computer-session'` to `FleetJobKind`
  and `FLEET_JOB_KINDS`. **`FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC` is a
  `Readonly<Record<FleetJobKind, number>>`** (same file, ~line 191) so it will not compile without
  a new entry — set it to `40` to match spec FR-8.
- `packages/contracts/src/fleet/fleet-panic.types.ts` — add eight members to `FleetAuditAction` /
  `FLEET_AUDIT_ACTIONS`: `computer.session-open`, `computer.session-close`,
  `computer.control-grant`, `computer.control-release`, `computer.control-refused`,
  `computer.teach-start`, `computer.teach-finish`, `computer.profile-reset`.
- `packages/contracts/src/fleet/fleet-node.types.ts` — add `screen`, `input`, `attended` to the
  known capability tags and `controlPolicy` / `recordWatchSessions` / `recordingRetentionDays` /
  `controlHolder` to `FleetNodeView`.
- New `packages/contracts/src/secret/secret-patterns.ts` — the pure pattern set plus
  `scanForSecrets` / `containsSecret` / `redactSecrets`, moved verbatim from
  `packages/agent/src/utils/secret-scan.ts`. That file keeps its exports by re-exporting them and
  retains only `assertNoSecrets` (which imports `BadRequestException`). `apps/node` already
  depends on `@ever-works/contracts`, so the Node gets the identical scanner with no new
  dependency.

---

## 4. API

New module `apps/api/src/computer/`, registered in `apps/api/src/api.module.ts` beside
`TerminalModule` (imported at line 61, mounted at line 217) and guarded by the existing
`FleetEnabledGuard` from `apps/api/src/fleet/guards/`.

Authorization for every owner-facing route mirrors `GET /api/agents/:id/runs/:runId` exactly, the
way `apps/api/src/terminal/terminal-attach.controller.ts` documents: Agent ownership through
`AgentsService.getOne`, then a user-scoped Node lookup. A cross-user Agent or Node **404s
identically to an unknown one** — no existence leak. Organization-member access (P3) is an
explicit widening on top, never a default.

### 4.1 Owner-facing — `@Controller('api/agents/:id/computer')`

| Method | Path                                           | Body / query                       | Returns                                      | Notes                                                                                                                                                                                                                                                                                                 |
| ------ | ---------------------------------------------- | ---------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/nodes`                                       | —                                  | `ComputerNodeOption[]`                       | Every visible Node with `watchable` and a closed-set `unwatchableReason`. Composes from `FleetService.listForUser` + `FleetJobService.loadByNodeForUser`, the same pair the settings table and the runner pill use, so three surfaces cannot disagree.                                                |
| POST   | `/sessions`                                    | `{ nodeId?, channels?, quality? }` | `202 { sessionId, status }`                  | `channels` defaults to `['screen']` when the Node can show a screen and to `['terminal']` otherwise. Refuses on kill switch (409), node state (409), session caps (429), and a requested channel the Node cannot serve (422, naming the channel and its missing capability — §2.5). Throttled 10/min. |
| GET    | `/sessions/:sessionId`                         | —                                  | `ComputerSessionView`                        | Live relay view merged with the persisted row, exactly as the terminal status route does.                                                                                                                                                                                                             |
| PATCH  | `/sessions/:sessionId`                         | `{ quality?, activeChannel? }`     | `ComputerSessionView`                        |                                                                                                                                                                                                                                                                                                       |
| DELETE | `/sessions/:sessionId`                         | —                                  | `204`                                        | Idempotent.                                                                                                                                                                                                                                                                                           |
| POST   | `/sessions/:sessionId/attach-token`            | `?role=viewer`                     | `{ token, expiresInSec }`                    | Short-lived signed token; role may only be **downgraded**, never upgraded — same rule as the terminal attach service.                                                                                                                                                                                 |
| POST   | `/sessions/:sessionId/control`                 | `{ request?: boolean }`            | `200 { held, holder?, requestId? }`          | CAS from §2.4. `409` with the holder when another party has it; `403` with the policy name when refused. Throttled 20/min.                                                                                                                                                                            |
| DELETE | `/sessions/:sessionId/control`                 | —                                  | `204`                                        |                                                                                                                                                                                                                                                                                                       |
| POST   | `/sessions/:sessionId/control/handover`        | `{ requestId, decision }`          | `204`                                        | The current holder answering a request.                                                                                                                                                                                                                                                               |
| POST   | `/sessions/:sessionId/refresh`                 | —                                  | `202`                                        | Forces a keyframe. Throttled 30/min.                                                                                                                                                                                                                                                                  |
| GET    | `/sessions/:sessionId/recording`               | —                                  | `{ segments[], durationMs, controlSpans[] }` | Manifest only.                                                                                                                                                                                                                                                                                        |
| GET    | `/sessions/:sessionId/recording/segments/:seq` | —                                  | bytes                                        | `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`.                                                                                                                                                                                                                                 |
| GET    | `/profile`                                     | `?nodeId=`                         | `NodeAgentProfileView`                       |                                                                                                                                                                                                                                                                                                       |
| POST   | `/profile/reset`                               | `{ nodeId, confirmAgentName }`     | `202`                                        | `409` when a Run is live for that Agent on that Node.                                                                                                                                                                                                                                                 |

### 4.2 Demonstrations — `@Controller('api/agents/:id/demonstrations')`

| Method | Path                  | Body                        | Returns                                                                                        |
| ------ | --------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| POST   | ``                    | `{ sessionId, intent }`     | `201 DemonstrationView` — `422` when the caller does not hold control.                         |
| POST   | `/:demoId/finish`     | `{ keepPartial?: boolean }` | `202 DemonstrationView`                                                                        |
| POST   | `/:demoId/cancel`     | —                           | `204`                                                                                          |
| GET    | `/:demoId`            | —                           | `DemonstrationView` with steps                                                                 |
| GET    | ``                    | `?status=&limit=`           | paged list                                                                                     |
| PATCH  | `/:demoId/steps/:seq` | `{ removed: true }`         | `204` — the "remove a step" affordance in the review                                           |
| POST   | `/:demoId/redraft`    | —                           | `202` — re-run synthesis after step edits                                                      |
| POST   | `/from-run/:runId`    | —                           | `202 DemonstrationView` — "make a Skill from this run"; `409` when the run has no stored steps |

### 4.3 Node-facing internal — `@Controller('api/internal/computer')`

`@Public()`, authenticated by the **node secret** through `FleetNodeAuthGuard`
(`apps/api/src/fleet/guards/fleet-node-auth.guard.ts`) — reused rather than re-implemented, so
`disabled` and `enrolling` nodes are refused at the edge with the same undifferentiated 401.

| Method | Path                       | Body                                           | Notes                                                                                                                            |
| ------ | -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/:sessionId/frames`       | `{ frames: ComputerFrame[] }`                  | Batch ≤ 8 frames / 512 KiB total. Publishes into the relay and, when recording, persists a ≤ 1 fps sample.                       |
| POST   | `/:sessionId/heartbeat`    | `{ status, nodeLocalTime, stats }`             | Enum-whitelisted lifecycle patch; carries the Node's wall clock for the identity strip.                                          |
| POST   | `/:sessionId/worker-token` | —                                              | Mints the Node's inbound-leg attach token, brokered by session id — never handed to a browser.                                   |
| POST   | `/:sessionId/steps`        | `{ steps: DemonstrationStep[] }`               | Batch ≤ 25. Every string re-scanned server-side with `redactSecrets` before insert (belt and braces — the Node already scanned). |
| POST   | `/:sessionId/profile`      | `{ profileKey, signedInSiteCount, diskBytes }` | Node's self-report for the isolation panel.                                                                                      |

### 4.4 Fleet heartbeat, extended

`POST /api/fleet/heartbeat` (`apps/api/src/fleet/fleet.controller.ts`) gains one **optional**
response field, `pendingComputerSessions: string[]`. An attended Node that sees a non-empty array
drops to its fast poll immediately instead of waiting for its next tick. Older Nodes ignore the
field — additive, no version gate.

### 4.5 WebSocket

`wss://<api>/ws/computer/:sessionId`, implemented the way
`apps/api/src/terminal/terminal-ws.service.ts` already does it: raw `ws` on the API HTTP server's
`upgrade` event, **query strings on the upgrade refused** (the token rides the first frame),
unauthenticated sockets closed `4001` after 5 s, 30 s ping with a two-missed-pong reap. No
socket.io.

Roles: `viewer` (frames only), `controller` (frames + input), `node` (publishes frames, consumes
input). A request may downgrade itself, never upgrade.

### 4.6 Relay

`apps/api/src/computer/computer-relay.registry.ts`, modelled on
`apps/api/src/terminal/terminal-relay.registry.ts`: per-session in-memory registry, a **single
retained keyframe** (not a rolling scrollback — a stale keyframe is what a re-attaching viewer
needs), retained pre-attach `error` banners, a pinned `end` frame replayed last, role-checked
inbound fan-out, and the same reclaim rule. Cross-replica fan-out sits behind the same declared
seam the terminal relay uses and is **out of scope** (spec §7).

---

## 5. Web

### 5.1 Routes and navigation

| Path                           | File                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `/agents/[id]/computer`        | `apps/web/src/app/[locale]/(dashboard)/agents/[id]/computer/page.tsx`                        |
| Recording player (modal route) | `apps/web/src/app/[locale]/(dashboard)/agents/[id]/computer/recordings/[sessionId]/page.tsx` |
| Demonstration review           | `apps/web/src/app/[locale]/(dashboard)/agents/[id]/demonstrations/[demoId]/page.tsx`         |

- Add `DASHBOARD_AGENT_COMPUTER: (id: string) => `/agents/${id}/computer``(and the two
sub-routes) to`apps/web/src/lib/constants.ts`, beside the existing
`DASHBOARD_AGENT_TERMINAL` at line 189.
- Add a `computer` entry to the tab list in
  `apps/web/src/components/agents/AgentDetailTabs.tsx`, immediately after `terminal`.
- Add the **Watch computer** button to the hero action row on
  `apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx`.
- Gate everything behind `isFleetEnabled()` from `apps/web/src/lib/fleet-flags.ts`, the same
  switch the Fleet settings page uses.

### 5.2 Components — `apps/web/src/components/computer/`

| File                               | Responsibility                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentComputerClient.tsx`          | The page shell: session lifecycle, mode, channel, error states.                                                                                                                                                                                 |
| `ComputerStage.tsx`                | `<canvas>` renderer for screen frames; delegates to the terminal renderer for the terminal channel. Labelled focusable region.                                                                                                                  |
| `ComputerIdentityStrip.tsx`        | Agent · Node · Node-local clock · channel · quality · LIVE badge.                                                                                                                                                                               |
| `ComputerStatusLine.tsx`           | The prose mode sentence + live region announcements.                                                                                                                                                                                            |
| `ComputerControls.tsx`             | Channel switch, quality menu, refresh, take over / give back, `⋯` menu.                                                                                                                                                                         |
| `ComputerNodePicker.tsx`           | The Node list with closed-set reasons. Reuses `runnerDotClass` from `apps/web/src/components/dashboard/runner-status.shared.ts` and the node-status strings from `dashboard.runner.nodeState`, so this surface and the pill can never disagree. |
| `ComputerBriefOverlay.tsx`         | `BRIEF · <task>` + Mission, or the idle line.                                                                                                                                                                                                   |
| `ComputerWatermark.tsx`            | The always-on identity watermark.                                                                                                                                                                                                               |
| `ComputerControlRequestDialog.tsx` | Both sides of the request/hand-over flow with the 60 s countdown.                                                                                                                                                                               |
| `ComputerProfilePanel.tsx`         | Own logins and files + the typed-confirmation reset.                                                                                                                                                                                            |
| `TeachTaskDialog.tsx`              | The teach dialog, its guard state and the intent field.                                                                                                                                                                                         |
| `TeachRecordingStrip.tsx`          | `role="status"` strip, step counter, secret-skipped `role="alert"` flash.                                                                                                                                                                       |
| `DemonstrationReview.tsx`          | Step list with thumbnails, per-step removal, re-draft.                                                                                                                                                                                          |
| `DraftSkillCard.tsx`               | The card rendered inside the conversation and in My Decisions.                                                                                                                                                                                  |
| `ComputerRecordingPlayer.tsx`      | Scrubber, control-span markers, playback rate.                                                                                                                                                                                                  |
| `use-computer-attach.ts`           | The WebSocket hook — mirrors `apps/web/src/components/terminal/use-terminal-attach.ts`.                                                                                                                                                         |
| `computer-session.shared.ts`       | Pure policy: which Nodes are watchable and why, quality preset resolution, control-eligibility, stall thresholds. Split out for the same reason `agent-fleet.shared.ts` exists — each decision becomes a one-line test.                         |

### 5.3 State and data fetching

- The page is a server component: it server-fetches the Node list, the Agent, the affinity
  binding and the profile, then hands them to `AgentComputerClient` as props. No client-side
  fetch on first paint.
- Session open, control and refresh go through **BFF routes** under
  `apps/web/src/app/api/agents/[id]/computer/...`, mirroring the existing terminal BFF routes at
  `apps/web/src/app/api/agents/[id]/runs/[runId]/terminal/{attach-token,start,transcript}/route.ts`
  so the attach token is minted server-side and never round-trips through client code.
- Frames arrive only over the WebSocket. Nothing polls for frames.
- The quality choice persists in `localStorage` keyed `ew:computer:quality:<nodeId>`; a failed read
  falls back to `sharp` and never throws.
- Rendering: `createImageBitmap` + `drawImage` onto a canvas sized to the frame, CSS-scaled to fit.
  A decode failure drops that frame and increments a counter; three consecutive failures trigger a
  refresh.

---

## 6. Background work

Every job is dispatched through the configured job-runtime provider via a `*_DISPATCHER` DI symbol
(Constitution IV). No call site imports a job-runtime SDK directly (`@trigger.dev/sdk` or any equivalent).

| Task                      | File                                                               | Trigger                                                                                         | Purpose                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demonstration-synthesis` | `packages/tasks/src/tasks/trigger/demonstration-synthesis.task.ts` | on demand                                                                                       | Loads the demonstration + steps, builds the prompt, calls the Agent's model through `AiFacadeService`, writes `draft`, creates the approval and the conversation message. 3 attempts, 30 s / 2 min / 10 min backoff. |
| `computer-session-reaper` | `packages/tasks/src/tasks/trigger/computer-session-reaper.task.ts` | cron `2/2 * * * *` (every 2 min, off the minute boundary, like the fleet lease sweeper's `3/5`) | Ends abandoned, stalled, ceiling-exceeded and viewerless sessions; releases expired control locks; expires undecided drafts at 30 days.                                                                              |
| `computer-recording-gc`   | `packages/tasks/src/tasks/trigger/computer-recording-gc.task.ts`   | scheduled daily                                                                                 | Deletes segments past `expiresAt` from storage **then** the rows, mirroring `terminal-transcript-gc.task.ts`.                                                                                                        |

Dispatch ports live in `packages/agent/src/computer/`:

- `DEMONSTRATION_SYNTHESIS_DISPATCHER` — declared exactly like
  `packages/agent/src/agents/terminal-session-dispatcher.ts` (a `const` string token, an interface
  with `enqueue`, `@Optional()` at the injection site so an install with no job runtime reports a
  no-op instead of crashing). Bound in `apps/api/src/agents/agents.module.ts` next to
  `TERMINAL_SESSION_DISPATCHER` (line 293).
- **Gotcha:** `packages/agent/src/tasks/_tasks-symbols.ts` pins the exact runtime-symbol set of the
  `@ever-works/agent/tasks` barrel and its spec fails CI when a new symbol appears there. These
  ports are exported from `@ever-works/agent/computer`, **not** `/tasks`, so that list needs no
  entry — but if any of them is ever re-exported through `/tasks`, add it alphabetically or CI
  goes red one merge late.

Live control expiry is _not_ left to the 2-minute cron: the relay checks `controlExpiresAt` and
`lastInputAt` on every inbound input frame and on every 30 s socket ping, so the countdown a user
sees is accurate to the second. The cron is the floor that covers a dead API replica, exactly as
`fleet-job-lease-sweeper.task.ts` is the floor under inline lease reclaim.

---

## 7. Plugin boundaries

- **New capability.** `packages/plugin/src/contracts/capabilities/screen-stream.interface.ts`,
  exported from `packages/plugin/src/contracts/capabilities/index.ts` (line 33 area, beside
  `terminal-stream.interface.js`), with `SCREEN_STREAM: 'screen-stream'` added to
  `packages/plugin/src/contracts/facade-capabilities.ts` (beside `TERMINAL_STREAM` at line 86).
  The interface mirrors `ITerminalStreamPlugin`: a `providerName`, a `capture(input, transport)`
  that resolves once the stream is live, a handle with `setQuality` / `refresh` / `sendInput` /
  `stop` / `ended`, and a `ScreenNotProvisionedError` matched **by name** across package
  boundaries (the house `FacadeError` pattern).
- **New plugin.** `packages/plugins/screen-cdp/` — ESM, `tsup`, Vitest, `everworks.plugin` block
  declaring `capabilities: ['screen-stream']`, `playwright-core` as an **optional** dependency
  exactly as `packages/plugins/browser-automation/package.json` does. It attaches to a Chromium
  context over CDP (`Page.startScreencast` for frames, `Input.dispatchMouseEvent` /
  `Input.dispatchKeyEvent` for input). Shipped in P3 for the cloud-hosted path.
- **No hardcoded ids.** The API resolves a provider through a facade
  (`packages/agent/src/facades/`, alongside `browser-automation.facade.ts`); the resolved provider
  id is forwarded to the worker as a `providerOverride` the way
  `TerminalSessionDispatchPayload.providerId` already does, so both halves host the same provider.
  Nothing outside `packages/plugins/screen-cdp/` ever writes the string `screen-cdp`.
- **Node-side capture is not a plugin**, for the reasons set out in §2.3. It lives in
  `apps/node/src/core/screen/` and reuses `apps/node/src/core/browser-probe.ts` so the `screen`
  capability tag is backed by the same binary the capture will actually launch — the rule that
  file's own header states for `browser`.
- **Canonical plugin doc.** `docs/plugin-system/built-in-plugins.md` is the only place the new
  plugin's existence and the new capability are counted (Constitution VIII).

---

## 8. i18n

All user-visible strings become keys under a new `dashboard.computer` namespace in
`apps/web/messages/en.json`. Leaf names are camelCase and **never contain a literal dot** —
`next-intl` rejects those at runtime and the hydration spec turns one into a multi-shard e2e
failure.

```
dashboard.computer
  title                    "{agent}'s computer"
  tabLabel                 "Computer"
  heroAction               "Watch computer"
  modeWatching             "Watching — {agent} keeps working."
  modeControlling          "You have control — {agent}'s input is paused."
  overlayTakeOver          "Take over"
  overlayHint              "Watching. Take over to use your mouse and keyboard."
  giveBackControl          "Give back control"
  watermark                "EVER WORKS · LIVE VIEW · {agent} @ {node}"
  liveBadge                "LIVE"
  connectingBadge          "CONNECTING"
  youBadge                 "YOU"
  briefLabel               "BRIEF · {task}"
  briefMission             "Mission: {mission}"
  briefIdle                "Idle — no task in flight"
  bandwidthUsed            "Bandwidth used: {value}"
  copyLink                 "Copy link to this view"
  endSession               "End session"
  channelScreen            "Screen"
  channelTerminal          "Terminal"
  terminalOnNode           "Watching — this shell is on {node}. Take over to type."
  terminalReadOnly         "read-only"
  quality
    sharp                  "Sharp"
    smooth                 "Smooth"
    steady                 "Steady"
    autoLowered            "Lowered to {tier} — the connection is slow. It will go back to {chosen} on its own."
  refresh                  "Refresh"
  connecting
    title                  "Waking up the view…"
    subtitle               "Asking {node} for a picture."
    slow                   "{node} has not answered yet. It may be busy."
    cancel                 "Cancel"
  stall
    banner                 "Stream stalled — last frame {seconds}s ago"
    refreshNow             "Refresh now"
    staleNote              "The picture is stale; the work is not."
    stopped                "The stream stopped."
    stoppedDetail          "The computer may be busy or asleep."
    reconnect              "Reconnect"
  empty
    title                  "{agent} does not have a computer yet"
    body                   "Agents work on machines you own. Add one and you can watch it, take over when a step needs you, and teach it how you do things."
    addComputer            "Add a computer"
    howItWorks             "How this works"
  offline
    title                  "{node} is offline"
    lastSeen               "Last heard from {relative} ({absolute})."
    hint                   "Start the Ever Works node app on that machine to bring it back."
    tryAgain               "Try again"
    pickAnother            "Pick another computer"
  cannotShow
    noBrowserTitle         "No browser found on {node}"
    noBrowserBody          "{agent} needs its own browser on a machine before you can watch it work. Install Chrome, Edge or Chromium there, or point the node at one you already have."
    noDisplayTitle         "{node} has no display session"
    noTerminalTitle        "{node} cannot serve a terminal right now"
    watchTerminalInstead   "Watch the terminal instead"
  notAttended
    title                  "Live view is switched off on {node}"
    body                   "Run this on that machine to turn it on:"
    command                "ever-works-node start --attend"
    copy                   "copy"
  nodePicker
    heading                "WATCHING A COMPUTER DOES NOT CHANGE WHERE {agent}'S WORK RUNS."
    pinnedNote             "{agent} is pinned to {node}. Change that on {agent}'s Capabilities tab."
    pinnedBadge            "Pinned to {agent}"
    reasonOffline          "Offline"
    reasonPaused           "Paused"
    reasonDisabled         "Disabled"
    reasonDraining         "Draining — not available"
    reasonNoDisplay        "No display session"
    reasonNoBrowser        "No browser found"
    reasonNotAttended      "Live view is switched off"
    reasonCluster          "Cluster node — read only"
    capabilitiesScreenTerminal "Screen, Terminal"
  control
    takeOver               "Take over"
    deniedTooltip          "Only the owner of this computer can take control."
    heldBy                 "{name} has had control since {time}."
    heldByBody             "You can watch. Ask for control and {name} will be prompted."
    requestControl         "Request control"
    keepWatching           "Keep watching"
    incomingRequest        "{name} is asking for control of {node}."
    autoDeclines           "Declines on its own in {countdown}."
    handOver               "Hand over"
    keepControl            "Keep control"
    requestDeclined        "{name} did not answer. You still have watching access."
    idleWarning            "Giving control back in {countdown}"
    idleWarningBody        "{agent} has been waiting since {time}."
    giveBack               "Give back"
    ceilingNote            "A single stretch of control lasts at most an hour. You can extend it once."
    endsIn                 "Control ends in {countdown}."
    releasedAutomatically  "Control was released automatically."
  overLimit
    title                  "{node} already has {count} live views"
    body                   "Close one to open another."
    rowWatching            "{name} — watching since {time}"
    rowControlling         "{name} — in control since {time}"
  stopped
    banner                 "All computers are stopped — \"{reason}\" · since {time}"
    body                   "Live views are closed while the stop is in force."
  profile
    title                  "Own logins and files"
    body                   "{agent} has its own browser profile on {node}. No other agent can read its cookies, sessions or files."
    created                "Created"
    lastUsed               "Last used"
    signedInTo             "Signed in to"
    signedInCount          "{count} sites"
    diskUsed               "Disk used"
    lastReset              "Last reset"
    never                  "never"
    resetAction            "Reset this agent's logins and files"
    resetTitle             "Reset {agent}'s logins and files on {node}?"
    resetBody              "{agent} will be signed out of {count} sites and its downloads there are deleted. No other agent on this computer is touched. This cannot be undone."
    resetConfirmLabel      "Type the agent's name to confirm:"
    resetBlocked           "{agent} is working on this computer right now. Pause it or wait for the run to finish."
  teach
    action                 "Teach a task"
    title                  "Teach {agent} a task"
    body1                  "Do the task once while {agent} watches. When you press Start, {agent}'s own browser comes to the front on {node} — demonstrate in that browser, because that is what gets recorded."
    body2                  "Clicks and typed values are captured. Passwords and one-time codes never are."
    body3                  "When you finish, {agent} studies the recording and replies in your conversation with a draft skill for you to approve."
    intentLabel            "WHAT ARE YOU ABOUT TO SHOW?"
    intentHelp             "3–120 characters. {used} used."
    costNote               "Synthesising the draft uses {agent}'s model and appears in Runs like any other run."
    start                  "Start recording"
    cancel                 "Cancel"
    guard                  "Take control of the computer first — a recording of {agent} working is not a demonstration."
    guardAction            "Take control"
    noBrowser              "Teaching needs {agent}'s own browser, and this computer has none."
    recordingLabel         "RECORDING"
    stepCounter            "Step {current} of {max}"
    secretNotice           "Passwords and one-time codes are never captured."
    secretSkipped          "Secret skipped — {agent} will ask you for this when it runs."
    pause                  "Pause"
    discard                "Discard"
    finish                 "Finish"
    capReached             "Recording stopped — that is as long as a demonstration can be."
    useWhatIHave           "Use what I have"
    studying               "{agent} is studying your demonstration…"
    studyingDetail         "{steps} steps · {secrets} secrets noted · usually under a minute"
  draft
    heading                "DRAFT SKILL"
    intro                  "I watched you {intent}. Here is what I learned."
    needsEachTime          "I will need from you each time:"
    needsOnce              "I will need once:"
    recordedSummary        "{steps} steps recorded · {secrets} secrets noted, never captured"
    approve                "Approve and add to {agent}"
    editFirst              "Edit first"
    discard                "Discard"
    adopted                "Added to {agent}'s skills as \"{title}\"."
    renamed                "Added as \"{title}\" — a skill with that name already existed."
    discarded              "Discarded — the demonstration is kept for 30 days if you want another draft."
    failed                 "I could not turn that into a skill. The recording is saved; ask me to try again."
    tryAgain               "Try again"
    expired                "This draft expired after 30 days and was not added."
  review
    title                  "Demonstration · {intent}"
    meta                   "Recorded {date} · {node} · {steps} steps · {duration}"
    removeHint             "Remove a step to keep it out of the skill."
    redraft                "Re-draft the skill"
    secretStep             "secret, not captured"
  recording
    receiptHeading         "COMPUTER"
    receiptSummary         "{node} · {channel} · recorded {duration} · {takeovers} take-overs"
    watch                  "Watch the recording"
    makeSkill              "Make a skill from this run"
    notRecorded            "This run was not recorded."
    notRecordedStorage     "Storage was unavailable."
    notRecordedOptOut      "Watching sessions are not recorded on this computer."
    playerTitle            "Recording · {agent} @ {node} · {date}"
    controlSpan            "{name} in control {from} – {to}"
  notRecordedBanner        "Not being recorded — storage is unavailable"
  accessRevoked            "You no longer have access to this computer."
  nodeRestarted            "{node} restarted. Reconnect to open a new view."
  shortcuts
    title                  "Keyboard"
    takeOver               "Take over"
    giveBack               "Give back control"
    refresh                "Refresh the picture"
    quality                "Cycle quality: Sharp → Smooth → Steady"
    channel                "Switch channel: screen ↔ terminal"
    node                   "Choose a computer"
    teach                  "Teach a task"
    sheet                  "This sheet"
    footnote               "While you have control every other key goes to the computer. Esc Esc always comes back to you."
  a11y
    stageLabelWatching     "Live view of {agent}'s computer {node}. Watching."
    stageLabelControlling  "Live view of {agent}'s computer {node}. You have control."
    modeChanged            "Mode changed to {mode}."
```

Two keys added outside the namespace:

- `dashboard.agentsPage.tabs.computer` = `"Computer"` (the tab strip reads
  `dashboard.agentsPage.tabs`).
- `dashboard.settings.fleet.controls.controlPolicy*` for the per-Node control policy, record
  opt-in and retention controls on the Fleet node drawer
  (`apps/web/src/components/settings/FleetNodeDrawer.tsx`).

Only `en.json` is authored. The other 20 locale files in `apps/web/messages/` fall back to English
until translated.

---

## 9. Telemetry and failure modes

### 9.1 Audit (the primary record)

Every act goes through `FleetAuditService.record()` / `tryRecord()`
(`packages/agent/src/fleet/fleet-audit.service.ts`) — the one writer of `fleet_audit`, with its
key-based redaction (`REDACTED_KEY_RE` drops anything whose key contains
`secret|token|credential|password|passphrase|hash|apikey|api_key`).

| Action                     | `details`                                                |
| -------------------------- | -------------------------------------------------------- |
| `computer.session-open`    | agentId, nodeId, channels, quality, runId                |
| `computer.session-close`   | sessionId, closeReason, durationMs, frameCount, recorded |
| `computer.control-grant`   | sessionId, agentId, nodeId                               |
| `computer.control-release` | sessionId, releaseReason, heldMs                         |
| `computer.control-refused` | nodeId, policy, holderPresent                            |
| `computer.teach-start`     | demonstrationId, intent (already length-capped at 120)   |
| `computer.teach-finish`    | demonstrationId, stepCount, secretCount, stopReason      |
| `computer.profile-reset`   | nodeId, agentId, signedInSiteCountBefore                 |

**Naming rule that bites here:** the redactor matches on the key, so a field named
`credentialProfileKey` would be silently replaced by `[redacted]`. Name fields for what they
_mean_ — `profileRef`, not `profileKeyHash` — exactly as that service's own header warns.

Frame bytes, typed values, selectors carrying values and screenshot keys are **never** put in an
audit row.

### 9.2 Activity log

Three user-legible entries via `apps/api/src/activity-log/activity-log.listener.ts`:
`agent.computer.watched`, `agent.computer.controlled` (on release, with duration), and
`agent.skill.learned` (on adoption, linking the demonstration and the Skill).

### 9.3 Analytics

`computer_session_opened`, `computer_first_frame_ms`, `computer_quality_degraded`,
`computer_stall`, `computer_control_granted`, `computer_control_released` (with reason),
`demonstration_started`, `demonstration_finished` (steps, secrets, stopReason),
`demonstration_synthesised` (attempt, latencyMs), `demonstration_adopted`,
`demonstration_rejected`.

### 9.4 Failure modes

| Failure                              | Behaviour                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Node claims the session in 40 s   | Session → `ended/abandoned`; the fleet job is cancelled so it cannot be claimed later by a Node that wakes up; the UI shows §6.10 of the spec.                                                    |
| Node dies mid-session                | Job lease lapses; the inline reclaim in `FleetJobService.lease` and the 2-minute reaper both end the session with `node-restarted`.                                                               |
| Relay replica restarts               | Live scrollback is lost (as with the terminal relay); the session ends with `error` and the UI offers Reconnect. Recorded segments survive — they are in storage, not memory.                     |
| Storage unreachable at session start | Session opens **unrecorded** with `recordingSkippedReason='storage-unavailable'`; the receipt repeats it. Never fail the session for a recording failure.                                         |
| Storage fails mid-recording          | Stop recording, stamp the reason, keep streaming.                                                                                                                                                 |
| Model unavailable for synthesis      | 3 attempts, then `synthesis-failed` with a plain conversation message. No partial Skill is ever created.                                                                                          |
| Secret scanner false positive        | The value is replaced by a placeholder and the step says so. Deliberately biased toward over-redaction — a lost value costs a re-demonstration; a leaked one costs a breach.                      |
| Kill switch thrown mid-session       | The relay checks the flag on every heartbeat tick; sessions end within 5 s with `stopped`.                                                                                                        |
| Two API replicas, one session        | Only the replica holding the relay serves it; the other returns the persisted row with `status` and a note that live view is unavailable there. Cross-replica fan-out is explicitly out of scope. |
| Clock skew between Node and API      | The identity strip shows the **Node's** reported clock and marks it stale after 10 s without a heartbeat, rather than silently substituting the API's.                                            |

---

## 10. Test plan

Runners, verified from each package's `package.json`: `packages/agent` → **Jest**;
`apps/api` → **Jest**; `apps/node` → **Vitest**; `packages/contracts` → **Vitest**;
`packages/plugins/*` → **Vitest**; `apps/web` unit → **Vitest**; `apps/web` e2e → **Playwright**.

### 10.1 Contracts (Vitest)

- `packages/contracts/src/computer/__tests__/computer-frame.codec.spec.ts` — the same exhaustive
  matrix the terminal codec spec runs: over-cap rejection before parse, invalid JSON, wrong shape,
  out-of-range values, unknown kind, `__proto__` keys stripped, direction map (a `frame` can never
  be smuggled inbound; a `pointer` can never be fanned out), canonical base64 only, never throws.
- `packages/contracts/src/computer/__tests__/quality-presets.spec.ts` — the three tiers' exact
  width / fps / keyframe values and the degrade/recover ladder.
- `packages/contracts/src/secret/__tests__/secret-patterns.spec.ts` — the extracted scanner keeps
  every pattern and every length floor from the agent-package original.
- `packages/contracts/src/fleet/__tests__/fleet-jobs.spec.ts` — extend the existing file: the new
  kind is in `FLEET_JOB_KINDS` **and** has a `FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC` entry.
- `packages/contracts/src/fleet/__tests__/fleet-panic.spec.ts` — extend: the eight new audit
  actions are present in `FLEET_AUDIT_ACTIONS`.

### 10.2 Agent package (Jest)

- `packages/agent/src/computer/__tests__/computer-session.service.spec.ts` — open/close state
  machine, every close reason, the 40 s abandon, the caps (2 per node / 5 per org), kill-switch
  refusal, node-state refusals, run binding set once and never re-bound; a terminal-only open on
  a display-less Node is accepted and a screen open on the same Node is refused `422`.
- `packages/agent/src/computer/__tests__/computer-session.policy.spec.ts` —
  `requiredCapabilitiesForChannels` for every channel combination (terminal-only never contains
  `screen`; every result contains `attended`), and a lease-matcher case feeding those results
  through the real `nodeSatisfiesCapabilities`: a Node advertising
  `['terminal', 'workspace', 'attended']` satisfies `['terminal']` and fails `['screen']`, and a
  Node without `attended` fails both.
- `packages/agent/src/computer/__tests__/control-arbiter.spec.ts` — CAS win/lose, the stale
  releaser cannot evict a newer holder, idle release at the boundary ±1 ms, the 60-minute ceiling,
  one extension only, disconnect release at 30 s, request auto-decline at 60 s, hand-over.
- `packages/agent/src/computer/__tests__/control-policy.spec.ts` — a truth table over
  `owner` / `org-admins` / `org-members` × owner / admin / member / stranger.
- `packages/agent/src/computer/__tests__/demonstration.service.spec.ts` — step cap at 200, time cap
  at 15 min, secret classification for every rule in spec FR-58, scanner-triggered redaction,
  screenshot cap at 60, lifecycle transitions, the 30-day expiry.
- `packages/agent/src/computer/__tests__/draft-skill.spec.ts` — adoption creates the Skill and the
  binding, a slug collision is suffixed not overwritten, rejection creates nothing, a secret never
  reaches the Skill body.
- `packages/agent/src/computer/__tests__/recording.service.spec.ts` — 1 fps sampling, the 200 MB /
  4 h caps, `expiresAt` from the Node's retention clamp, storage failure degrades without ending
  the session, `agent_runs.computerRecordedAt` stamped once.
- `packages/agent/src/fleet/__tests__/fleet-audit.service.spec.ts` — extend: each of the eight new
  actions writes a row, and no `details` field survives that would carry a value.

### 10.3 API controller specs (Jest, beside the controller)

- `apps/api/src/computer/computer.controller.spec.ts` — cross-user Agent 404s identically to
  unknown; cross-user Node 404s; session open returns 202 with an id; caps → 429; kill switch →
  409; attach-token role may downgrade but never upgrade; control 403 names the policy; control 409
  names the holder; profile reset 409 under a live Run; throttle decorators present at the stated
  ceilings.
- `apps/api/src/computer/computer-internal.controller.spec.ts` — node-secret auth via the reused
  guard; a foreign node's session id is refused with the same undifferentiated 401; frame batch
  over 8 or over 512 KiB rejected; steps batch re-scanned server-side; heartbeat is
  enum-whitelisted.
- `apps/api/src/computer/computer-ws.service.spec.ts` — upgrade with a query string is refused;
  unauthenticated socket closed 4001 after 5 s; ping/pong reap; a viewer's inbound `pointer` frame
  is answered with an `error`, never forwarded.
- `apps/api/src/computer/computer-relay.registry.spec.ts` — keyframe retained and replayed on
  attach, pinned `end` replayed last, role-checked fan-out, reclaim rule.
- `apps/api/src/computer/demonstrations.controller.spec.ts` — start without control → 422; finish
  is idempotent; `from-run` with no stored steps → 409.

### 10.4 Node (Vitest)

- `apps/node/src/core/screen/capture-pump.spec.ts` — quality preset → capture parameters, the
  backlog/latency degrade trigger, refresh forces a keyframe, three failed keyframes restart the
  pump, batch never exceeds 8 frames or 512 KiB.
- `apps/node/src/core/screen/input-injector.spec.ts` — only pointer/key/wheel/text are injected;
  clipboard and file-drop events are dropped; no injection while control is not held.
- `apps/node/src/core/screen/agent-profile.spec.ts` — profile directory per `(node, agent)`,
  created lazily, never shared, reset deletes exactly one, refuses under a live lease.
- `apps/node/src/core/screen/demonstration-recorder.spec.ts` — every redaction rule from spec
  FR-58, query values stripped from recorded paths, typed values truncated at 200 chars, the
  scanner runs **before** the step leaves the machine.
- `apps/node/src/core/capabilities.spec.ts` — extend: `screen` is advertised only when the browser
  probe resolves a binary (the same rule `browser` already follows), `attended` only under
  `--attend`.
- `apps/node/src/core/executors/computer-session.spec.ts` — lease → capture → publish → complete,
  graceful stop on drain, keep-alive at 1/3 TTL, `LEASE_TERMINATION_SAFETY_MS` respected; a
  terminal-only session on a Node with no display and no browser spawns the PTY and never starts
  a capture.
- `apps/node/src/core/worker-loop.spec.ts` — extend: the attended fast poll runs at 2 s, backs off
  to 15 s after 10 empty polls, and returns to fast on a heartbeat carrying a pending session.

### 10.5 Web unit (Vitest, beside the component)

- `apps/web/src/components/computer/computer-session.shared.unit.spec.ts` — watchability and its
  reason for every node shape (offline, paused, disabled, draining, no display, no browser, no
  terminal, not attended, cluster), the servable channels for each (a display-less Node is
  watchable on the terminal channel only), quality resolution, control eligibility, stall
  thresholds.
- `apps/web/src/components/computer/ComputerNodePicker.unit.spec.tsx` — ordering (bound first,
  then online by heartbeat), reason strings, the "does not change where work runs" note.
- `apps/web/src/components/computer/TeachTaskDialog.unit.spec.tsx` — the guard blocks Start, the
  intent length rule, the secret sentence is in the body.
- `apps/web/src/components/computer/DraftSkillCard.unit.spec.tsx` — all four card states.
- `apps/web/src/components/computer/ComputerStatusLine.unit.spec.tsx` — the exact mode sentences
  and the live-region announcement.

### 10.6 Plugin (Vitest)

- `packages/plugins/screen-cdp/src/__tests__/screen-cdp.plugin.spec.ts` — capability declaration,
  `ScreenNotProvisionedError` when `playwright-core` is absent, quality mapping, input dispatch
  shape, `ended` resolves only after the `end` frame is published.

### 10.7 End-to-end (Playwright, `apps/web/e2e/`)

Named to match the existing fleet/terminal specs (`flow-fleet-*`, `flow-terminal-attach-contract`):

- `flow-agent-computer-watch.spec.ts` — entry button → surface → identity strip → status line →
  watermark → empty and offline states.
- `flow-agent-computer-takeover.spec.ts` — take over, the amber state, give back, the disabled
  button under policy, the second-viewer request flow.
- `flow-agent-computer-teach.spec.ts` — guard, dialog validation, recording strip, secret-skipped
  alert, finish, the draft card in the conversation, approve → Skill appears on the Skills tab.
- `flow-agent-computer-contract.spec.ts` — the API contract shape for the new endpoints, in the
  style of `flow-terminal-attach-contract.spec.ts`.
- `flow-agent-computer-a11y.spec.ts` — keyboard-only operation of every control and an axe pass.

---

## 11. Phasing

Each phase is independently shippable and leaves `develop` green.

### P1 — Watch (migration A)

**Ships:** the contracts package (`computer` frame protocol + codec, the extracted secret
scanner), the `computer-session` fleet job kind, the Node's attended fast poll and screen capture,
per-Agent profiles, the API module (public + internal controllers, relay, WS gateway), the web
surface with the Node picker, identity strip, brief overlay, quality, refresh and stall handling,
the isolation panel, the eight audit actions (only the four that P1 can raise), the session reaper,
and the full i18n namespace for what exists.

**Explicitly not in P1:** input forwarding, teach, recording, the terminal channel. The **Take
over** button renders disabled with `dashboard.computer.control.deniedTooltip` replaced by a
"coming in the next release" string — or, preferably, is not rendered at all until P2. Choose one
and be consistent; this plan assumes **not rendered**.

**Green means:** the fleet e2e specs still pass, the terminal specs are untouched, and
`flow-agent-computer-watch.spec.ts` is green.

### P2 — Take over and teach (migration B)

**Ships:** input forwarding end to end, the control arbiter and its CAS lock, the control policy,
the request/hand-over flow, idle and ceiling release, the remaining audit actions, the teach
dialog and guard, the Node's demonstration recorder with full redaction, the steps endpoint, the
synthesis task and its dispatcher, the draft-Skill card in the conversation, the `adopt_skill`
approval kind, adoption and rejection, and the demonstration review.

**Green means:** `flow-agent-computer-takeover.spec.ts` and `flow-agent-computer-teach.spec.ts`
are green and the approvals queue still behaves for its existing action types.

### P3 — Re-watch and the terminal channel (migration C)

**Ships:** recording segments and their storage path, the retention GC, the player, the Run
receipt's _Watch the recording_ and _Make a Skill from this run_, `agent_runs.computerRecordedAt`,
the Node-hosted terminal channel and the channel switch, the `screen-stream` plugin capability and
the `screen-cdp` plugin for the cloud-hosted path, and Organization-member watch access under the
Node's control policy.

**Green means:** the AW-09 receipt renders the new block without regressing, the existing Agent
Terminal tab is unchanged, and the recording GC deletes storage objects before rows.

---

## 12. Constitution compliance checklist

- [x] **I — Plugin-first (NON-NEGOTIABLE).** The cloud-hosted capture provider is a standalone
      plugin package declaring the new `screen-stream` capability. Node-side capture is not an
      external integration and follows the existing in-core precedent
      (`apps/node/src/core/executors/browser-check.ts`), in an app that has no plugin runtime.
- [x] **II — Capability-driven resolution (NON-NEGOTIABLE).** The API resolves a screen provider
      through a facade and forwards the resolved id as an override; no core code writes a provider
      id.
- [x] **III — Source-of-truth repos.** No work content enters the database. Recording bytes go to
      the configured storage provider; the database holds only keys, sizes and timestamps.
- [x] **IV — Job runtime.** Synthesis, session reaping and recording GC are tasks dispatched via
      `*_DISPATCHER` DI symbols; nothing imports a job-runtime SDK directly, and the interactive path rides the
      existing fleet lease protocol rather than a bespoke queue.
- [x] **V — Forward-only migrations.** Three additive migrations under `apps/api/src/migrations/`,
      one per phase, no drops, no type changes, `down` reversing exactly what `up` added.
- [x] **VI — Tests.** Contracts, agent-package unit, controller specs, node unit, web unit, plugin
      unit and five Playwright flows, all named in §10.
- [x] **VII — Secrets (NON-NEGOTIABLE).** Redaction runs on the machine before any capture leaves
      it, again server-side before insert, and again in the audit writer. No frame bytes, typed
      values or selectors carrying values are logged. Password, one-time-code and credential-labelled
      fields are never read.
- [x] **VIII — Plugin counts.** `docs/plugin-system/built-in-plugins.md` is the only doc updated
      with the new plugin and capability.
- [x] **IX — Behaviour-first.** `spec.md` names no class, file or endpoint; every implementation
      detail is in this document.
- [x] **X — Backwards compatibility.** `FleetJobKind`, `FleetAuditAction` and the capability tag
      list gain members; the heartbeat response gains an optional field; the approval action type
      gains a value in a column with no check constraint. Nothing existing changes shape.

---

## 13. References

- Spec: [`./spec.md`](./spec.md) · Tasks: [`./tasks.md`](./tasks.md)
- Program: [Agent Workspace](../README.md)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Existing fleet design: `docs/specs/fleet-agent-node-affinity/design.md`
- Related epics: [AW-09 Runs & receipts](../AW-09-runs-receipts/plan.md),
  [AW-15 Connections & scopes](../AW-15-connections-scopes/plan.md)
