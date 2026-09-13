# AW-11 — Agent computers · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a definition of done. Every task ships with its tests (Constitution VI). Work top to bottom;
> tasks marked `(parallel)` may run alongside the task immediately above them.

**Feature ID**: `aw-11-agent-computers`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- All paths are repo-relative to the monorepo root.
- Run everything with `pnpm` from the root unless a task says otherwise.
- Migrations are **authored** from `apps/api/`; nothing is run by hand on deploy — the API
  self-applies pending migrations on boot.
- Test runners differ per package: `packages/agent` and `apps/api` use **Jest**; `apps/node`,
  `packages/contracts`, `packages/plugins/*` and `apps/web` unit use **Vitest**; `apps/web` e2e
  uses **Playwright**.
- Add new tasks at the bottom; never renumber.
- Commit style: `feat(computer): …`, `feat(fleet): …`, `test(computer): …`, `chore(i18n): …`.

---

# PHASE 1 — Watch

## P1.A — Contracts

- [ ] **T1. Extract the secret scanner into the zero-dependency contracts package.** - Create `packages/contracts/src/secret/secret-patterns.ts` holding, moved verbatim from
      `packages/agent/src/utils/secret-scan.ts`: the pattern table, `SecretMatch`,
      `scanForSecrets`, `containsSecret`, `redactSecrets`. Keep every length floor and every
      comment explaining why a pattern is conservative — they are the reason it has a low false
      positive rate. - Create `packages/contracts/src/secret/index.ts` and export it from
      `packages/contracts/src/index.ts`. - Rewrite `packages/agent/src/utils/secret-scan.ts` to `export { ... } from
'@ever-works/contracts'` for the four moved symbols and keep only `assertNoSecrets` (the one
      function that imports `BadRequestException`). **No caller changes** — the agent package's
      export surface is identical (Constitution X). - **Test**: create `packages/contracts/src/secret/__tests__/secret-patterns.spec.ts` (Vitest)
      porting the existing agent-package cases; keep the agent-package spec passing untouched. - **Done when**: `pnpm --filter @ever-works/contracts test` and
      `cd packages/agent && pnpm test -- secret-scan` are both green, and
      `grep -rn "scanForSecrets" packages/agent/src | wc -l` is unchanged.

- [ ] **T2. Add the computer frame protocol to contracts.**
    - Create `packages/contracts/src/computer/computer-frame.types.ts`. Mirror the invariants
      documented at the top of `packages/contracts/src/terminal/terminal-frame.types.ts`
      (size-capped before parse, null-never-throw, direction-mapped kinds, normalized
      field-by-field construction) and state them in the same header form.
        - Constants: `COMPUTER_MAX_FRAME_BYTES = 512 * 1024`, `COMPUTER_MAX_BATCH_FRAMES = 8`,
          `COMPUTER_MAX_BATCH_BYTES = 512 * 1024`, `COMPUTER_MAX_ERROR_MESSAGE_LENGTH = 8192`,
          `COMPUTER_MAX_AUTH_TOKEN_LENGTH = 4096`, `COMPUTER_MAX_TEXT_LENGTH = 4096`.
        - `COMPUTER_QUALITY_PRESETS` — frozen record of
          `sharp {width:1280,maxFps:8,keyframeMs:5000,q:70}`,
          `smooth {width:960,maxFps:15,keyframeMs:5000,q:55}`,
          `steady {width:800,maxFps:2,keyframeMs:2000,q:45}`.
        - `COMPUTER_CLOSE_REASONS` — the closed set from spec §5.2.
        - `COMPUTER_CONTROL_RELEASE_REASONS` — `given-back` `idle` `disconnected` `ceiling`
          `handed-over` `revoked` `session-ended`.
        - Frame interfaces: `ComputerScreenFrame` (`kind:'frame'`, `seq`, `keyframe`, `width`,
          `height`, `mime`, `data` base64), `ComputerTerminalFrame` (`kind:'terminal'`, wrapping a
          `TerminalFrame` from the sibling module — do **not** redefine the terminal protocol),
          `ComputerModeFrame`, `ComputerStatsFrame`, `ComputerErrorFrame`, `ComputerEndFrame`,
          `ComputerAuthFrame`, `ComputerPointerFrame`, `ComputerKeyFrame`, `ComputerTextFrame`,
          `ComputerScrollFrame`, `ComputerQualityFrame`, `ComputerRefreshFrame`,
          `ComputerControlFrame`.
        - Direction maps: `COMPUTER_CLIENT_TO_SERVER_KINDS`, `COMPUTER_SERVER_TO_CLIENT_KINDS`,
          `COMPUTER_NODE_TO_SERVER_KINDS`.
    - Create `packages/contracts/src/computer/computer-frame.codec.ts` — hand-rolled
      encode/decode/normalize with the same base64 canonicality gate and the same
      `isRecord`/`isBoundedInt` helper style as the terminal codec. **Never throws.**
    - Create `packages/contracts/src/computer/index.ts`; export from
      `packages/contracts/src/index.ts`.
    - **Test**: `packages/contracts/src/computer/__tests__/computer-frame.codec.spec.ts` and
      `.../quality-presets.spec.ts` per [`plan.md`](./plan.md) §10.1.
    - **Done when**: `pnpm --filter @ever-works/contracts test` is green and the codec has a case
      proving an inbound `frame` and an outbound `pointer` are both rejected by the direction map.

- [ ] **T3. Add the session view types to contracts.** _(parallel)_
    - Create `packages/contracts/src/computer/computer-session.types.ts`:
      `ComputerSessionStatus`, `ComputerChannel`, `ComputerQuality`, `ComputerSessionView`,
      `ComputerControlSpan`, `ComputerNodeOption` (with `watchable: boolean` and
      `unwatchableReason: ComputerUnwatchableReason | null`), `COMPUTER_UNWATCHABLE_REASONS`
      (`offline` `paused` `disabled` `draining` `no-display` `no-browser` `no-terminal`
      `not-attended` `cluster`), `servableChannels: ComputerChannel[]` on `ComputerNodeOption`,
      `NodeAgentProfileView`.
    - **Done when**: every string union has a `readonly` array constant beside it and a
      `isX(value: unknown)` guard, matching the house pattern in
      `packages/contracts/src/fleet/fleet-jobs.types.ts`.

- [ ] **T4. Extend the fleet contracts — job kind, audit actions, capability tags.**
    - `packages/contracts/src/fleet/fleet-jobs.types.ts`: add `'computer-session'` to
      `FleetJobKind` (line ~104) and `FLEET_JOB_KINDS` (line ~107). **`FLEET_JOB_DEFAULT_QUEUED_MAX_AGE_SEC`
      (line ~191) is a `Readonly<Record<FleetJobKind, number>>` and will not compile without a new
      entry** — set it to `40`, matching spec FR-8.
    - `packages/contracts/src/fleet/fleet-panic.types.ts`: add the eight `computer.*` members to
      `FleetAuditAction` (line ~60) and `FLEET_AUDIT_ACTIONS` (line ~96), in the same order as
      [`plan.md`](./plan.md) §9.1.
    - `packages/contracts/src/fleet/fleet-node.types.ts`: add `screen`, `input`, `attended` to the
      known capability tags; add `controlPolicy`, `recordWatchSessions`, `recordingRetentionDays`
      and an optional `controlHolder { userId, since, expiresAt }` to `FleetNodeView`.
    - **Test**: extend `packages/contracts/src/fleet/__tests__/fleet-jobs.spec.ts` and
      `.../fleet-panic.spec.ts` per [`plan.md`](./plan.md) §10.1.
    - **Done when**: `pnpm --filter @ever-works/contracts test` and
      `pnpm --filter @ever-works/contracts type-check` are green, and nothing else in the repo
      fails to compile because of the new record entry.

## P1.B — Schema and domain model

- [ ] **T5. Add the `ComputerSession` entity.**
    - Create `packages/agent/src/entities/computer-session.entity.ts` with the columns in
      [`plan.md`](./plan.md) §3.1. Use `PortableDateColumn` from `./_types` (as
      `packages/agent/src/entities/fleet-node.entity.ts` does), raw `uuid` columns rather than
      `@ManyToOne` for `agentId` / `nodeId` / `runId` (FKs are added by the migration, not the
      decorator — the same rule `agent-action-proposal.entity.ts` documents), and plain `varchar`
      for every string union.
    - Class-level indexes: `idx_computer_sessions_user_status(userId,status)`,
      `idx_computer_sessions_node_status(nodeId,status)`,
      `idx_computer_sessions_agent(agentId,createdAt)`, `idx_computer_sessions_run(runId)`.
    - Register the entity wherever `FleetNode` is registered
      (`packages/agent/src/entities/index.ts` and the fleet/agent TypeORM feature arrays).
    - **Done when**: `pnpm --filter @ever-works/agent build` is clean and every column carries a
      doc comment naming what writes it.

- [ ] **T6. Add the `NodeAgentProfile` entity.** _(parallel)_
    - Create `packages/agent/src/entities/node-agent-profile.entity.ts` per
      [`plan.md`](./plan.md) §3.1. `profileKey` is an opaque id the Node maps to a directory —
      document explicitly that the platform **never** stores a filesystem path.
    - Unique index `(nodeId, agentId)`; index `(userId, agentId)`.
    - **Done when**: the package builds and the doc comment states the isolation guarantee.

- [ ] **T7. Add the control-lock and policy columns to `FleetNode`.**
    - Modify `packages/agent/src/entities/fleet-node.entity.ts`: add `controlPolicy`
      `varchar(24)` default `'owner'`, `recordWatchSessions` boolean default `false`,
      `recordingRetentionDays` int default `14`, `controlHolderUserId` uuid null,
      `controlHolderSessionId` uuid null, `controlHeldSince` / `controlExpiresAt`
      `PortableDateColumn({ nullable: true })`.
    - Export `FleetNodeControlPolicy` as a string union with its `readonly` array beside the
      existing `FleetNodeKind` / `FleetNodeStatus` unions in the same file.
    - **Done when**: the package builds and the header comment explains that the four
      `controlHolder*` columns are a CAS lock, not a cache.

- [ ] **T8. Author and hand-review migration A.**
    - From `apps/api/`:
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateComputerSessions`
    - Land it as `apps/api/src/migrations/1791110000000-CreateComputerSessions.ts` (AW-11 slot 00,
      [README §5 rule 10](../README.md#5-rules-every-epic-spec-in-this-program-must-follow)), following
      `apps/api/src/migrations/1789000000000-AddFleetCredentialRotation.ts` for shape.
    - Hand-check: two `CREATE TABLE`, seven `ADD COLUMN` on `fleet_nodes`, six `CREATE INDEX`,
      the FKs on `agentId` / `nodeId` / `runId` / `userId`. **No `DROP`, no `ALTER … TYPE`, no
      `NOT NULL` without a default.** `down` drops only what `up` added, in reverse.
    - **Done when**: it applies on a fresh database and again on a database with data, and a
      re-run of `migration:generate` afterwards produces an empty diff.

## P1.C — The session domain service

- [ ] **T9. Create the computer domain module skeleton.**
    - Create `packages/agent/src/computer/` with `index.ts`, `computer.module.ts`,
      `computer-session.repository.ts`, `node-agent-profile.repository.ts`.
    - Export the sub-path `@ever-works/agent/computer` from the package's `exports` map, matching
      how `@ever-works/agent/agents` is exported.
    - **Done when**: `pnpm --filter @ever-works/agent build` emits the new sub-path's declarations.

- [ ] **T10. Write the pure session-policy functions.**
    - Create `packages/agent/src/computer/computer-session.policy.ts` exporting, with **no**
      TypeORM / NestJS imports:
        - `resolveWatchability(node, opts): { watchable: boolean; reason: ComputerUnwatchableReason | null; servableChannels: ComputerChannel[] }`
          — precedence exactly as spec §4.10: cluster → disabled → paused → draining → offline →
          not-attended → per channel (`no-browser` → `no-display` remove only `screen`;
          `no-terminal` removes only `terminal`) → watchable when at least one channel remains
          (spec FR-4a, FR-70).
        - `requiredCapabilitiesForChannels(channels)` — `attended` always, `screen` only for the
          screen channel, `terminal` only for the terminal channel (plan §2.5). The single source
          of the job's `requiredCapabilities`; nothing else builds that list.
        - `resolveQuality(requested, stored): ComputerQuality` (default `sharp`).
        - `shouldDegrade(stats, sinceMs)` / `shouldRecover(stats, sinceMs)` — the 3-frame backlog
          and 1500 ms ack thresholds over a 5 s window, recovery after 30 s.
        - `stallState(lastFrameAt, now)` → `ok` | `stalled` | `auto-refresh` | `dead` at the 6 s /
          20 s / 45 s boundaries.
        - `SESSION_LIMITS` — `perNode: 2`, `perOrganization: 5`, `maxDurationMs: 4 h`,
          `noViewerMs: 30 min`, `lastViewerGraceMs: 15 s`, `claimTimeoutMs: 40 s`, each with a
          documented clamp.
    - **Test**: `packages/agent/src/computer/__tests__/computer-session.policy.spec.ts` — a truth
      table over every watchability branch and every threshold at ±1 ms, and every channel
      combination of `requiredCapabilitiesForChannels` (a terminal-only result never contains
      `screen`).
    - **Done when**: the file imports nothing but types from `@ever-works/contracts`.

- [ ] **T11. Write `ComputerSessionService`.**
    - Create `packages/agent/src/computer/computer-session.service.ts`.
        - `open(userId, agentId, input)` — verify Agent ownership, resolve the Node (affinity
          binding first, via `FleetAgentNodeAffinityService`), refuse on kill switch
          (`FleetKillSwitchService`, already exported by
          `packages/agent/src/fleet/fleet.module.ts`), refuse on node state, enforce
          `SESSION_LIMITS`, insert the row `requested`, then enqueue the fleet job (T13).
        - `markLive` / `markStalled` / `close(reason)` — the state machine from spec §5.2.
        - `bindRun(sessionId, runId)` — set once, never re-bound.
        - `listForNode` / `getForUser` — owner-scoped; a foreign id resolves to `null` so the
          controller can 404 identically to unknown.
    - Every refusal is a typed **return value or a named error**, never a bare throw, following
      `TerminalSessionLauncher`'s refusal-value posture
      (`packages/agent/src/agents/terminal-session-launcher.service.ts`).
    - **Test**: `packages/agent/src/computer/__tests__/computer-session.service.spec.ts` per
      [`plan.md`](./plan.md) §10.2.
    - **Done when**: every close reason in `COMPUTER_CLOSE_REASONS` has a test that produces it.

- [ ] **T12. Write `NodeAgentProfileService`.**
    - Create `packages/agent/src/computer/node-agent-profile.service.ts`: `ensure(nodeId, agentId)`
      (lazy create, returns the `profileKey`), `recordSelfReport(...)`, `get(...)`,
      `reset(userId, nodeId, agentId, confirmAgentName)` — refuses with a named value when a
      `fleet_jobs` row for that Agent on that Node is `leased` or `running`.
    - **Test**: `packages/agent/src/computer/__tests__/node-agent-profile.service.spec.ts` —
      lazy creation, one profile per pair, reset refusal under a live lease, name-confirmation
      mismatch refused.
    - **Done when**: the reset path writes an audit row (T14) and never touches another pair.

- [ ] **T13. Enqueue the `computer-session` fleet job.**
    - Create `packages/agent/src/computer/computer-session.dispatcher.ts` — a thin wrapper that
      builds the payload (`sessionId`, `agentId`, `userId`, `nodeId`, `profileKey`, `channels`,
      `quality`, `internalBaseUrl`) and enqueues through the node job-runtime plugin's
      `NodeDispatcherFactory`, exactly as `apps/api/src/fleet/fleet-agent-task.dispatcher.ts`
      does for `agent-task` — **not** by calling `FleetJobService` directly, so idempotency,
      capability tags and lease-TTL mapping follow the same `JobEnqueueOptions` semantics.
    - `requiredCapabilities: requiredCapabilitiesForChannels(session.channels)` (T10) — derived
      from the requested channels, never a fixed list: a screen session requires
      `['attended','screen']`, a terminal-only session `['attended','terminal']`, both channels
      all three. The lease matcher requires every listed tag, so a fixed `screen` would lock
      display-less Nodes out of terminal-only sessions (plan §2.5). Lease TTL 120 s.
    - **Test**: `packages/agent/src/computer/__tests__/computer-session.dispatcher.spec.ts` —
      payload shape, required capabilities per channel combination (terminal-only has no
      `screen`), `targetNodeId` always set (a session must never be claimed by a different
      machine).
    - **Done when**: a session job can only ever be leased by the node it named.

- [ ] **T14. Extend the fleet audit writer with the eight computer actions.**
    - Modify `packages/agent/src/fleet/fleet-audit.service.ts` only where a new helper is genuinely
      needed; the eight actions are new **values**, not a new writer.
    - **Naming rule (this bites):** `REDACTED_KEY_RE` in that file drops any value whose _key_
      contains `secret|token|credential|password|passphrase|hash|apikey|api_key`. Name the audit
      fields for what they mean — `profileRef`, not `profileKeyHash`.
    - **Test**: extend `packages/agent/src/fleet/__tests__/fleet-audit.service.spec.ts` — each new
      action writes a row; a `details` blob carrying a frame, a typed value or a selector is
      rejected by the test's own assertion set.
    - **Done when**: all eight actions round-trip and none carries a value that could be a secret.

## P1.D — API

- [ ] **T15. Create the computer API module.**
    - Create `apps/api/src/computer/computer.module.ts`, import it in
      `apps/api/src/api.module.ts` beside `TerminalModule` (imported at line 61, mounted at line
      217), with a comment in the same house style as its neighbours saying what it is.
    - Apply `FleetEnabledGuard` from `apps/api/src/fleet/guards/` at the controller level so the
      whole surface disappears with `FLEET_ENABLED=false`, matching `FleetController`.
    - **Done when**: `pnpm --filter ever-works-api build` is clean and the API boots with the
      module mounted.

- [ ] **T16. Write `ComputerController` (owner-facing).**
    - Create `apps/api/src/computer/computer.controller.ts` — `@Controller('api/agents/:id/computer')`,
      every route in [`plan.md`](./plan.md) §4.1.
    - Authorization: copy the `authorizeRun` shape from
      `apps/api/src/terminal/terminal-attach.controller.ts` — `AgentsService.getOne` then a
      user-scoped Node lookup; a cross-user Agent or Node **404s identically to an unknown one**.
    - Throttles: `@Throttle` at 10/min on session open, 20/min on control, 30/min on refresh.
    - DTOs under `apps/api/src/computer/dto/` with `class-validator` decorators; response DTOs use
      `@Exclude()`/`@Expose()` so no entity leaks.
    - **Test**: `apps/api/src/computer/computer.controller.spec.ts` per [`plan.md`](./plan.md) §10.3.
    - **Done when**: every refusal in spec §4 has a controller-spec case asserting its status code
      and that its message names the reason.

- [ ] **T17. Write `ComputerInternalController` (node-facing).**
    - Create `apps/api/src/computer/computer-internal.controller.ts` —
      `@Controller('api/internal/computer')`, `@Public()`, guarded by the existing
      `FleetNodeAuthGuard` (`apps/api/src/fleet/guards/fleet-node-auth.guard.ts`) so `disabled`
      and `enrolling` nodes are refused at the edge with the same undifferentiated 401.
    - Routes per [`plan.md`](./plan.md) §4.3. Enforce the batch caps **before** decoding.
    - The `steps` route re-runs `redactSecrets` on every string server-side even though the Node
      already scanned — belt and braces, and the only line of defence against a modified Node.
    - **Test**: `apps/api/src/computer/computer-internal.controller.spec.ts` per §10.3.
    - **Done when**: a node authenticated for node A cannot publish into a session belonging to
      node B, and the refusal is the same 401 as an unknown credential.

- [ ] **T18. Write the relay registry.**
    - Create `apps/api/src/computer/computer-relay.registry.ts`, modelled on
      `apps/api/src/terminal/terminal-relay.registry.ts`: per-session registry, **one retained
      keyframe** (not a rolling scrollback), retained pre-attach `error` banners, a pinned `end`
      frame replayed last, seq dedupe, role-checked inbound fan-out, and the same reclaim rule
      (no clients AND ended AND at least one attach saw the keyframe).
    - **Test**: `apps/api/src/computer/computer-relay.registry.spec.ts` per §10.3.
    - **Done when**: a re-attaching viewer always gets a picture or an explicit banner, never a
      blank stage.

- [ ] **T19. Write the attach service and the WebSocket gateway.**
    - Create `apps/api/src/computer/computer-attach.service.ts` — short-lived signed tokens with a
      role (`viewer` | `controller` | `node`); a request may **downgrade** itself, never upgrade
      (copy the rule and its comment from `apps/api/src/terminal/terminal-attach.service.ts`).
    - Create `apps/api/src/computer/computer-ws.service.ts` — raw `ws` on the API HTTP server's
      `upgrade` event at `/ws/computer/:sessionId`. **Refuse any query string on the upgrade**
      (the token rides the first frame, never the URL). Close `4001` after 5 s unauthenticated;
      30 s ping, two missed pongs reaps. No socket.io.
    - **Test**: `apps/api/src/computer/computer-ws.service.spec.ts` per §10.3.
    - **Done when**: a `pointer` frame from a `viewer` socket is answered with an `error` frame and
      never forwarded to the node leg.

- [ ] **T20. Extend the fleet heartbeat response.**
    - Modify `apps/api/src/fleet/fleet.controller.ts` (and the service behind it) so the heartbeat
      response carries an **optional** `pendingComputerSessions: string[]`. Older nodes ignore it.
    - **Test**: extend `apps/api/src/fleet/fleet.controller.spec.ts` — the field is present when a
      session is pending for that node and absent otherwise; the response shape is otherwise
      byte-identical.
    - **Done when**: `apps/web/e2e/flow-fleet-enrollment-contract.spec.ts` still passes unchanged.

## P1.E — Node

- [ ] **T21. Add the `--attend` verb and the attended fast poll.**
    - Modify `apps/node/src/cli/program.ts`: add `--attend` to `start`, documented as "allow live
      viewing of this machine from the dashboard", independent of `--work`.
    - Modify `apps/node/src/core/worker-loop.ts`: when attended, run a dedicated interactive lease
      poll at 2000 ms (clamp 500–10000) with `kinds:['computer-session']` and batch 1, backing off
      to 15000 ms after 10 consecutive empty polls with no session in the previous 10 minutes and
      returning to fast on any heartbeat that carries `pendingComputerSessions`.
    - Modify `apps/node/src/core/heartbeat.ts` to surface that hint to the loop.
    - **Test**: extend `apps/node/src/core/worker-loop.spec.ts` and
      `apps/node/src/core/heartbeat.spec.ts` per [`plan.md`](./plan.md) §10.4.
    - **Done when**: a node started without `--attend` never polls the interactive lane, and one
      started without `--work` still does.

- [ ] **T22. Advertise the new capability tags.**
    - Modify `apps/node/src/core/capabilities.ts`: add `screen` (only when
      `apps/node/src/core/browser-probe.ts` resolves a binary — the **same probe the capture will
      launch**, per that file's own rule), `input` (screen + a display or a headed browser), and
      `attended` (only under `--attend`).
    - **Test**: extend `apps/node/src/core/capabilities.spec.ts` — `screen` is never advertised on
      a machine where the probe finds nothing.
    - **Done when**: no tag is advertised that has no executor behind it.

- [ ] **T23. Write the per-Agent profile manager.**
    - Create `apps/node/src/core/screen/agent-profile.ts`: resolves a directory per
      `(nodeId, agentId)` under the node's data root, creates it lazily, returns the opaque
      `profileKey`, reports `signedInSiteCount` and `diskBytes`, and implements `reset` as a
      delete-and-recreate of exactly one directory. Owner-only ACL on Windows via the existing
      `icacls` helper in `apps/node/src/node-io.ts`.
    - All IO injected, as every other module in `apps/node/src/core/` is.
    - **Test**: `apps/node/src/core/screen/agent-profile.spec.ts` per §10.4.
    - **Done when**: resetting one Agent's profile provably leaves a sibling's untouched.

- [ ] **T24. Write the capture pump.**
    - Create `apps/node/src/core/screen/capture-pump.ts`: launches (or attaches to) the Agent's own
      browser with its profile directory, starts a CDP screencast, encodes frames per the resolved
      quality preset, batches them at ≤ 8 frames / 512 KiB, publishes outbound to
      `POST /api/internal/computer/:sessionId/frames`, and honours `refresh` (force keyframe),
      `setQuality`, and `stop`.
    - Degrade/recover logic reads the thresholds from `COMPUTER_QUALITY_PRESETS` and the policy in
      `packages/agent/src/computer/computer-session.policy.ts`'s exported constants — **do not
      re-declare the numbers here.**
    - **Test**: `apps/node/src/core/screen/capture-pump.spec.ts` per §10.4.
    - **Done when**: three consecutive failed keyframes restart the pump without ending the
      session, and a test proves the batch caps are never exceeded.

- [ ] **T25. Write the `computer-session` executor.**
    - Create `apps/node/src/core/executors/computer-session.ts`: claims the job, ensures the
      profile, starts the capture pump, opens the node's own inbound WebSocket leg using a
      `worker-token` brokered by session id, keeps the lease alive at 1/3 TTL, drains gracefully on
      stop/pause honouring `LEASE_TERMINATION_SAFETY_MS`, and completes with a verdict.
    - Register it in `apps/node/src/core/runtime.ts` beside the `browser-check` registration
      (line ~493) and **only when the machine advertises `screen`** — the same conditional
      registration pattern `browser-check` uses.
    - Export it from `apps/node/src/core/index.ts` alongside the other executors.
    - **Test**: `apps/node/src/core/executors/computer-session.spec.ts` per §10.4.
    - **Done when**: a drain during a live session ends it cleanly with `node-unavailable` rather
      than letting the lease lapse.

## P1.F — Web

- [ ] **T26. Add routes, tab and hero action.**
    - Add `DASHBOARD_AGENT_COMPUTER`, `DASHBOARD_AGENT_COMPUTER_RECORDING` and
      `DASHBOARD_AGENT_DEMONSTRATION` to `apps/web/src/lib/constants.ts`, beside
      `DASHBOARD_AGENT_TERMINAL` (line 189).
    - Add a `computer` entry to the tab array in
      `apps/web/src/components/agents/AgentDetailTabs.tsx`, immediately after `terminal`.
    - Add the **Watch computer** button to the hero action row in
      `apps/web/src/app/[locale]/(dashboard)/agents/[id]/page.tsx`, second after Message.
    - Gate both behind `isFleetEnabled()` from `apps/web/src/lib/fleet-flags.ts`.
    - **Test**: `apps/web/src/components/agents/AgentDetailTabs.unit.spec.tsx` (new) — the tab is
      present when fleet is on and absent when off.
    - **Done when**: the tab and the button both reach the new route.

- [ ] **T27. Write the shared client policy module.**
    - Create `apps/web/src/components/computer/computer-session.shared.ts` — pure functions only,
      for the same reason `apps/web/src/components/agents/agent-fleet.shared.ts` exists: node
      ordering, watchability + its reason string key, quality resolution and persistence key,
      control eligibility, stall thresholds, bandwidth formatting.
    - Reuse `runnerDotClass` from `apps/web/src/components/dashboard/runner-status.shared.ts` and
      the node-status strings from the `dashboard.runner.nodeState` namespace so this surface and
      the sidebar pill can never disagree about what "Paused" means.
    - **Test**: `apps/web/src/components/computer/computer-session.shared.unit.spec.ts` per §10.5.
    - **Done when**: no layout file contains a threshold or an ordering rule.

- [ ] **T28. Write the page and the client shell.**
    - Create `apps/web/src/app/[locale]/(dashboard)/agents/[id]/computer/page.tsx` — a server
      component that fetches the Agent, the Node list, the affinity binding and the profile in
      parallel and hands them to the client as props. Defensive `.catch()` per read so a stale
      environment cannot 500 the page, following the pattern in the Agent dashboard page.
    - Create `apps/web/src/components/computer/AgentComputerClient.tsx`.
    - **Done when**: the page renders every empty/offline/error state from spec §6 without opening
      a session.

- [ ] **T29. Write the stage, strip, overlay and controls.** _(parallel)_
    - Create, under `apps/web/src/components/computer/`: `ComputerStage.tsx`,
      `ComputerIdentityStrip.tsx`, `ComputerStatusLine.tsx`, `ComputerBriefOverlay.tsx`,
      `ComputerWatermark.tsx`, `ComputerControls.tsx`, `ComputerNodePicker.tsx`,
      `ComputerProfilePanel.tsx`, `use-computer-attach.ts`.
    - `ComputerStage` renders to `<canvas>` via `createImageBitmap` + `drawImage`, is a labelled
      focusable region, and announces its mode through a polite live region.
    - `use-computer-attach.ts` mirrors `apps/web/src/components/terminal/use-terminal-attach.ts`:
      token from the BFF, first-frame auth, reconnect with backoff, never a token in a URL.
    - **Test**: the unit specs listed in [`plan.md`](./plan.md) §10.5 for the picker and the
      status line.
    - **Done when**: keyboard-only operation reaches every control and `?` opens the shortcut
      sheet.

- [ ] **T30. Add the BFF routes.**
    - Create `apps/web/src/app/api/agents/[id]/computer/sessions/route.ts`,
      `.../sessions/[sessionId]/attach-token/route.ts`,
      `.../sessions/[sessionId]/control/route.ts`, `.../sessions/[sessionId]/refresh/route.ts`,
      mirroring the existing
      `apps/web/src/app/api/agents/[id]/runs/[runId]/terminal/{attach-token,start,transcript}/route.ts`
      so the attach token is minted server-side and never round-trips through client code.
    - **Done when**: no client component holds an API base URL or an attach token before the
      socket opens.

## P1.G — i18n, background work, tests

- [ ] **T31. Add the i18n namespace.**
    - Add the whole `dashboard.computer` block from [`plan.md`](./plan.md) §8 to
      `apps/web/messages/en.json`, plus `dashboard.agentsPage.tabs.computer`.
    - **Leaf key names are camelCase and must never contain a literal `.`** — `next-intl` rejects
      those at runtime and the hydration spec turns one into a multi-shard e2e failure.
    - Only `en.json` is authored; the other 20 locale files fall back to English.
    - **Done when**: `grep -c '"[a-zA-Z]*\.[a-zA-Z]*":' apps/web/messages/en.json` is unchanged
      from before this task, and no component in `apps/web/src/components/computer/` contains a
      user-visible literal string.

- [ ] **T32. Add the session reaper task.**
    - Create `packages/tasks/src/tasks/trigger/computer-session-reaper.task.ts` — cron
      `2/2 * * * *` (off the minute boundary, like
      `packages/tasks/src/tasks/trigger/fleet-job-lease-sweeper.task.ts`'s `3/5`). Ends abandoned
      (40 s unclaimed), stalled (45 s), ceiling-exceeded and viewerless sessions; releases expired
      control locks.
    - Register it wherever `fleet-job-lease-sweeper` is registered. **That task's header warns it
      must be run with `TriggerInternalModule` or it fails silently on every fire** — check the
      same for this one.
    - **Test**: `packages/tasks/src/__tests__/computer-session-reaper.task.spec.ts` —
      each sweep branch, and idempotence when two ticks overlap.
    - **Done when**: killing the API mid-session still leaves the session `ended` within 4 minutes.

- [ ] **T33. Write the P1 end-to-end spec.**
    - Create `apps/web/e2e/flow-agent-computer-watch.spec.ts` and
      `apps/web/e2e/flow-agent-computer-contract.spec.ts`, named to match the existing
      `apps/web/e2e/flow-fleet-*.spec.ts` and `flow-terminal-attach-contract.spec.ts`.
    - Cover: the entry button, the surface, the identity strip, the status sentence, the
      watermark, the node picker with each reason, and the empty / offline / not-attended states.
    - Prefer role-and-name locators; avoid `*ByRole` chains that are known to be load-sensitive in
      this suite.
    - **Done when**: both specs are green locally and in CI on a cold database.

- [ ] **T34. Update the docs.**
    - Add a short section to `docs/specs/features/agent-workspace/TRACKER.md` marking AW-11 P1
      spec'd and implemented.
    - **Done when**: the tracker row exists and links to this folder.

---

# PHASE 2 — Take over and teach

## P2.A — Control

- [ ] **T35. Write the control arbiter.** - Create `packages/agent/src/computer/control-arbiter.service.ts` implementing the CAS lock in
      [`plan.md`](./plan.md) §2.4 as a single owner-scoped `UPDATE … WHERE (holder IS NULL OR
expires < now())`, plus `release` (scoped by `controlHolderSessionId` so a stale releaser can
      never evict a newer holder), `requestControl`, `answerRequest`, `extendOnce`, and the idle /
      ceiling / disconnect sweeps. - Create `packages/agent/src/computer/control-policy.ts` — a pure
      `canControl(policy, viewerRole)` truth table. - **Test**: `packages/agent/src/computer/__tests__/control-arbiter.spec.ts` and
      `.../control-policy.spec.ts` per [`plan.md`](./plan.md) §10.2. - **Done when**: two concurrent take-overs produce exactly one winner and the loser reads the
      real holder.

- [ ] **T36. Wire control into the controller, relay and WS.**
    - Add the four control routes from [`plan.md`](./plan.md) §4.1 to
      `apps/api/src/computer/computer.controller.ts`.
    - Teach `apps/api/src/computer/computer-relay.registry.ts` to accept `pointer` / `key` /
      `text` / `scroll` frames **only** from the socket holding control, and to answer any other
      inbound input with an `error` frame.
    - Re-check `controlExpiresAt` and `lastInputAt` on every inbound input frame and every 30 s
      ping so the countdown a user sees is second-accurate; the T32 cron is only the floor.
    - **Test**: extend `apps/api/src/computer/computer.controller.spec.ts` and
      `computer-relay.registry.spec.ts`.
    - **Done when**: a viewer socket can never inject input, verified by a test.

- [ ] **T37. Write the input injector on the Node.**
    - Create `apps/node/src/core/screen/input-injector.ts` — dispatches pointer, key, wheel and
      text events into the captured browser context. **Refuses** clipboard payloads, file drops and
      anything not in the allowed frame set, and refuses everything while control is not held.
    - Suspend the Agent's own synthetic input to that surface while control is held, and tell the
      Agent it is paused rather than letting its actions fail silently.
    - **Test**: `apps/node/src/core/screen/input-injector.spec.ts` per §10.4.
    - **Done when**: a fuzz case of unexpected frame kinds injects nothing and throws nothing.

- [ ] **T38. Build the control UI.**
    - Add to `apps/web/src/components/computer/`: the amber control state on `ComputerStage`, the
      `✋ YOU` badge on `ComputerIdentityStrip`, the take-over / give-back controls, the countdown
      and `Keep control` affordance, and `ComputerControlRequestDialog.tsx` (both sides, with the
      60 s auto-decline).
    - Keyboard: `T` takes over; `Escape Escape` gives back and is the **only** key intercepted
      while in control.
    - **Test**: `apps/web/src/components/computer/ComputerControlRequestDialog.unit.spec.tsx`.
    - **Done when**: the mode is legible from the status line alone, with colour disabled.

## P2.B — Teach

- [ ] **T39. Add the demonstration entities.**
    - Create `packages/agent/src/entities/agent-demonstration.entity.ts` and
      `packages/agent/src/entities/agent-demonstration-step.entity.ts` per
      [`plan.md`](./plan.md) §3.1, registered like the P1 entities.
    - **Done when**: `pnpm --filter @ever-works/agent build` is clean.

- [ ] **T40. Author and hand-review migration B.**
    - From `apps/api/`:
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateAgentDemonstrations`
    - Land it as `apps/api/src/migrations/1791110100000-CreateAgentDemonstrations.ts` (AW-11 slot 01).
    - Hand-check: two `CREATE TABLE`, four `CREATE INDEX`, one unique index on
      `(demonstrationId, seq)`, FKs on `agentId` / `nodeId` / `sessionId` / `userId`. No drops.
    - **Done when**: it applies twice cleanly and re-generation produces an empty diff.

- [ ] **T41. Write the demonstration recorder on the Node.**
    - Create `apps/node/src/core/screen/demonstration-recorder.ts`, capturing exactly the step
      fields in spec FR-57 and enforcing every redaction rule in FR-58:
        - password fields, `autocomplete` in `{current-password, new-password, one-time-code}`,
          and any field whose accessible name / label / placeholder / name matches the credential
          pattern → recorded as a named secret requirement with `redacted:true`, value **never
          read**;
        - clipboard contents never captured;
        - query values stripped from recorded paths;
        - typed values truncated at 200 characters;
        - every remaining string run through `redactSecrets` from `@ever-works/contracts` (T1)
          **before** it leaves the machine.
    - Caps: 200 steps, 15 minutes, 60 screenshots at ≤ 200 KB each.
    - **Test**: `apps/node/src/core/screen/demonstration-recorder.spec.ts` — one case per
      redaction rule, plus a case proving a scanner-tripping value never appears in the outbound
      payload.
    - **Done when**: no test can construct an input that gets a credential off the machine.

- [ ] **T42. Write `DemonstrationService`.**
    - Create `packages/agent/src/computer/demonstration.service.ts` — `start` (requires control),
      `appendSteps` (server-side re-scan, cap enforcement), `finish`, `cancel`, `removeStep`,
      `redraft`, `fromRun`, and the 30-day expiry.
    - **Test**: `packages/agent/src/computer/__tests__/demonstration.service.spec.ts` per §10.2.
    - **Done when**: every lifecycle transition in spec §5.3 has a test.

- [ ] **T43. Write the synthesis dispatcher and task.**
    - Create `packages/agent/src/computer/demonstration-synthesis.dispatcher.ts` declaring
      `DEMONSTRATION_SYNTHESIS_DISPATCHER`, modelled **exactly** on
      `packages/agent/src/agents/terminal-session-dispatcher.ts`: a `const` string token, a payload
      interface, an `enqueue` returning `{ jobRunId }`, and `@Optional()` at the injection site so
      an install with no job runtime reports a no-op instead of crashing.
    - Bind it in `apps/api/src/agents/agents.module.ts` beside `TERMINAL_SESSION_DISPATCHER`
      (line 293) with the same `@Global()` token posture.
    - **`packages/agent/src/tasks/_tasks-symbols.ts` pins the runtime-symbol set of the
      `@ever-works/agent/tasks` barrel and its spec fails CI when a new symbol appears there.**
      This token is exported from `@ever-works/agent/computer`, not `/tasks`, so **no entry is
      needed** — but if it is ever re-exported through `/tasks`, add it alphabetically or CI goes
      red one merge late.
    - Create `packages/tasks/src/tasks/trigger/demonstration-synthesis.task.ts` — loads the
      demonstration and its steps, builds the prompt, calls the Agent's model through the AI
      facade, writes `draft`, creates the approval and the conversation message. 3 attempts with
      30 s / 2 min / 10 min backoff; on exhaustion set `synthesis-failed` and post the plain
      failure message.
    - **Test**: `packages/tasks/src/__tests__/demonstration-synthesis.task.spec.ts` —
      the retry ladder, that a failure never creates a partial Skill, and that no secret value
      reaches the prompt.
    - **Done when**: the task is registered and a stubbed dispatcher drives it synchronously in
      tests.

- [ ] **T44. Write the prompt builder as a pure function.**
    - Create `packages/agent/src/computer/draft-skill-prompt.ts` — turns steps into the prompt and
      parses the model's reply into the `DraftSkillView` shape, refusing (rather than guessing)
      when the reply is malformed.
    - **Test**: `packages/agent/src/computer/__tests__/draft-skill-prompt.spec.ts` — redacted
      steps become named secret requirements; a malformed reply is refused; the title is clamped
      at 80 and the description at 200 characters.
    - **Done when**: the builder has no NestJS or TypeORM import.

- [ ] **T45. Add the `adopt_skill` approval kind and the adoption path.**
    - Modify `packages/agent/src/entities/agent-action-proposal.entity.ts`: add `'adopt_skill'` to
      `AgentActionProposalActionType` and `AGENT_ACTION_PROPOSAL_ACTION_TYPES`. **No migration is
      needed** — `actionType` is a `varchar(32)` with no check constraint (verified in
      `apps/api/src/migrations/*-CreateAgentActionProposals.ts`).
    - Create `packages/agent/src/computer/draft-skill-adoption.service.ts` — on approve, create a
      `Skill` at `agent` owner scope and a `SkillBinding` to that Agent; on a slug collision,
      suffix and report the name used; on reject, create nothing and keep the demonstration 30 days.
    - **Test**: `packages/agent/src/computer/__tests__/draft-skill.spec.ts` per §10.2.
    - **Done when**: an existing approval of any other action type is provably unaffected.

- [ ] **T46. Add the demonstration API routes.**
    - Create `apps/api/src/computer/demonstrations.controller.ts` with every route in
      [`plan.md`](./plan.md) §4.2, plus the `steps` route on the internal controller (T17).
    - **Test**: `apps/api/src/computer/demonstrations.controller.spec.ts` per §10.3.
    - **Done when**: starting without control returns 422 and names the reason.

- [ ] **T47. Build the teach UI.**
    - Create `apps/web/src/components/computer/TeachTaskDialog.tsx`,
      `TeachRecordingStrip.tsx`, `DemonstrationReview.tsx`, `DraftSkillCard.tsx`, and the
      demonstration review page at
      `apps/web/src/app/[locale]/(dashboard)/agents/[id]/demonstrations/[demoId]/page.tsx`.
    - The recording strip is `role="status"`; the secret-skipped flash is `role="alert"`.
    - `DraftSkillCard` renders inside the conversation **and** in the approvals queue — one
      component, two mounts, so the two can never drift.
    - **Test**: `TeachTaskDialog.unit.spec.tsx` and `DraftSkillCard.unit.spec.tsx` per §10.5.
    - **Done when**: the guard sentence appears verbatim and `Start recording` is disabled without
      control.

- [ ] **T48. Extend the i18n namespace for P2.**
    - Add the `control`, `teach`, `draft` and `review` sub-blocks from [`plan.md`](./plan.md) §8 to
      `apps/web/messages/en.json`.
    - **Done when**: no P2 component holds a literal user-visible string and no leaf key contains a
      dot.

- [ ] **T49. Write the P2 end-to-end specs.**
    - Create `apps/web/e2e/flow-agent-computer-takeover.spec.ts` and
      `apps/web/e2e/flow-agent-computer-teach.spec.ts` per [`plan.md`](./plan.md) §10.7.
    - **Done when**: the teach spec proves a password typed during a demonstration never appears in
      the resulting draft.

---

# PHASE 3 — Re-watch and the terminal channel

- [ ] **T50. Add the recording segment entity and migration C.**
    - Create `packages/agent/src/entities/computer-recording-segment.entity.ts` per
      [`plan.md`](./plan.md) §3.1 (bytes live in storage; the row holds a `storageKey`, never
      bytes).
    - Add `computerRecordedAt` `PortableDateColumn({ nullable: true })` to
      `packages/agent/src/entities/agent-run.entity.ts`, documented as "set once when the first
      recording segment for a session bound to this run is written; a cheap flag so the receipt
      needs no join".
    - From `apps/api/`:
      `pnpm typeorm migration:generate -d typeorm.config.ts src/migrations/CreateComputerRecordings`
    - Land it as `apps/api/src/migrations/1791110200000-CreateComputerRecordings.ts` (AW-11 slot 02).
    - Hand-check: one `CREATE TABLE`, two `CREATE INDEX`, one `ADD COLUMN` on `agent_runs`, no
      drops.
    - **Done when**: it applies twice cleanly.

- [ ] **T51. Write the recording service.**
    - Create `packages/agent/src/computer/recording.service.ts` — samples at ≤ 1 fps, writes bytes
      through the storage backend (`getActiveStorageBackend` in
      `apps/api/src/uploads/storage-backend.factory.ts`, reached the way
      `apps/api/src/uploads/uploads.service.ts` does with `getBackend()`), enforces 200 MB / 4 h,
      stamps `expiresAt` from the Node's clamped `recordingRetentionDays`, and **degrades without
      ending the session** when storage is unreachable, stamping `recordingSkippedReason`.
    - **Test**: `packages/agent/src/computer/__tests__/recording.service.spec.ts` per §10.2.
    - **Done when**: a storage outage never fails a session and always shows up on the receipt.

- [ ] **T52. Add the recording GC task.**
    - Create `packages/tasks/src/tasks/trigger/computer-recording-gc.task.ts`, mirroring
      `packages/tasks/src/tasks/trigger/terminal-transcript-gc.task.ts`. **Delete the storage
      object first, then the row** — the reverse order orphans bytes forever.
    - **Test**: `packages/tasks/src/__tests__/computer-recording-gc.task.spec.ts` — an
      object whose delete fails leaves its row for the next sweep rather than being lost.
    - **Done when**: nothing older than the retention window survives a sweep.

- [ ] **T53. Build the player and wire it into the Run receipt.**
    - Create `apps/web/src/components/computer/ComputerRecordingPlayer.tsx` and the route at
      `apps/web/src/app/[locale]/(dashboard)/agents/[id]/computer/recordings/[sessionId]/page.tsx`.
    - Add the `COMPUTER` block from spec §6.24 to the AW-09 receipt component, gated on
      `agent_runs.computerRecordedAt`, with the _not recorded_ variants and their reasons.
    - The scrubber is a slider with a 1 s keyboard step and a 10 s page step; control spans are
      marked on the timeline.
    - **Test**: extend the AW-09 receipt unit spec — the block renders, and its three not-recorded
      variants render their reasons.
    - **Done when**: the receipt renders unchanged for runs with no recording.

- [ ] **T54. Add "Make a Skill from this run".**
    - Wire `POST /api/agents/:id/demonstrations/from-run/:runId` (T46) to the receipt button;
      `409` when the run has no stored steps, rendered as a disabled button with a reason.
    - **Done when**: the same synthesis path runs with no new demonstration.

- [ ] **T55. Add the Node-hosted terminal channel.**
    - Extend the `computer-session` job payload with `channels` including `terminal`; in
      `apps/node/src/core/executors/computer-session.ts` spawn a local PTY and publish
      `TerminalFrame`s wrapped in the `ComputerTerminalFrame` envelope from T2 — **reusing** the
      existing protocol in `packages/contracts/src/terminal/terminal-frame.types.ts`, not a second
      one.
    - In the web stage, delegate the terminal channel to the existing renderer factory at
      `apps/web/src/components/terminal/create-terminal-renderer.ts`.
    - Add the channel switch to `ComputerControls.tsx` and the `C` shortcut.
    - **Test**: extend `apps/node/src/core/executors/computer-session.spec.ts`; add a web unit case
      that the read-only badge is present in watching mode.
    - **Done when**: the existing `/agents/[id]/terminal` tab and
      `apps/web/e2e/flow-terminal-attach-contract.spec.ts` are provably unchanged, and the Node's
      long-advertised `terminal` capability finally has an executor behind it.

- [ ] **T55a. Prove a display-less Node leases a terminal-only session.**
    - **Test (agent, Jest)**: add
      `packages/agent/src/fleet/__tests__/fleet-job.computer-session-capabilities.spec.ts` — a
      lease case that enqueues a `computer-session`
      job through the T13 dispatcher with `channels: ['terminal']` and leases it as a Node
      advertising `['terminal','workspace','attended']` (no `screen`, no `input`): the job is
      leased. The same Node leasing a `['screen']` session gets nothing, and a Node advertising
      `['terminal','workspace']` (not attended) gets neither.
    - **Test (node)**: extend `apps/node/src/core/executors/computer-session.spec.ts` — with the
      browser probe resolving nothing and no display, a terminal-only session spawns the PTY,
      publishes `ComputerTerminalFrame`s and never starts a capture.
    - **Test (web unit)**: extend `computer-session.shared.unit.spec.ts` — that Node is listed as
      watchable with `servableChannels: ['terminal']` and the screen channel's _no display_
      reason beside it.
    - **Done when**: spec FR-4a and its acceptance criterion hold end to end on a headless
      machine started with `--attend`.

- [ ] **T56. Add the `screen-stream` plugin capability.**
    - Create `packages/plugin/src/contracts/capabilities/screen-stream.interface.ts`, mirroring
      `terminal-stream.interface.ts`: `IScreenStreamPlugin` with `providerName` and
      `capture(input, transport)`, a `ScreenSessionHandle` (`setQuality`, `refresh`, `sendInput`,
      `stop`, `ended`), a `ScreenTransport`, an `IScreenStreamFacade`, a
      `ScreenNotProvisionedError` matched **by name** across package boundaries, and an
      `isScreenStreamPlugin` guard.
    - Export it from `packages/plugin/src/contracts/capabilities/index.ts` (beside line 33) and add
      `SCREEN_STREAM: 'screen-stream'` to
      `packages/plugin/src/contracts/facade-capabilities.ts` (beside `TERMINAL_STREAM`, line 86).
    - **Done when**: `pnpm --filter @ever-works/plugin build` is clean.

- [ ] **T57. Create the `screen-cdp` plugin.**
    - Create `packages/plugins/screen-cdp/` — ESM, `tsup`, Vitest, `everworks.plugin` block with
      `capabilities: ['screen-stream']` and `playwright-core` as an **optionalDependency**, exactly
      as `packages/plugins/browser-automation/package.json` does.
    - Implement capture over CDP screencast and input over `Input.dispatch*Event`.
    - **Test**: `packages/plugins/screen-cdp/src/__tests__/screen-cdp.plugin.spec.ts` per §10.6.
    - Add the plugin and the new capability to `docs/plugin-system/built-in-plugins.md` —
      **the only doc that carries plugin counts** (Constitution VIII).
    - **Done when**: the plugin builds, tests pass, and no other doc's plugin count was edited.

- [ ] **T58. Add the screen facade and route the cloud path through it.**
    - Create `packages/agent/src/facades/screen-stream.facade.ts` beside
      `browser-automation.facade.ts`, resolving a provider from the settings cascade and forwarding
      the resolved id as a `providerOverride` the way `TerminalSessionDispatchPayload.providerId`
      already does.
    - **Test**: `packages/agent/src/facades/__tests__/screen-stream.facade.spec.ts` — resolution
      against a mock plugin, and a case asserting the string `screen-cdp` appears nowhere outside
      the plugin package (`grep -rn "screen-cdp" packages/agent apps` must return nothing).
    - **Done when**: Constitution II holds by test, not by convention.

- [ ] **T59. Add per-Node control-policy and recording controls to the Fleet drawer.**
    - Extend `apps/web/src/components/settings/FleetNodeDrawer.tsx` with the control policy
      selector, the watch-recording opt-in and the retention-days field, under the
      `dashboard.settings.fleet.controls` namespace.
    - **Test**: extend the fleet settings unit spec; add a case that the retention field clamps
      1–90 client-side and that the server clamps independently.
    - **Done when**: a policy change takes effect on the next control attempt with no restart.

- [ ] **T60. Widen access to Organization members.**
    - Extend the authorization in `apps/api/src/computer/computer.controller.ts` so an
      Organization member may **watch** a Node whose `controlPolicy` is `org-admins` or
      `org-members`, and may **control** only when the policy allows their role. Revocation closes
      the session within 30 s via the reaper (T32).
    - **Test**: extend `computer.controller.spec.ts` with the full role × policy matrix.
    - **Done when**: the default (`owner`) behaves exactly as it did in P1 and P2.

- [ ] **T61. Write the P3 end-to-end and accessibility specs.**
    - Create `apps/web/e2e/flow-agent-computer-a11y.spec.ts` — keyboard-only operation of every
      control plus an axe pass on the surface, the teach dialog and the player.
    - Extend `flow-agent-computer-watch.spec.ts` with the channel switch and the recording player.
    - **Done when**: the accessibility sweep is clean and the whole suite is green in CI.

- [ ] **T62. Close out the epic.**
    - Update `docs/specs/features/agent-workspace/TRACKER.md` to mark AW-11 implemented across all
      three phases.
    - Add a short user-facing page under `docs/` covering watch, take over and teach, and list it
      in `apps/docs/sidebarsPlatform.ts` so it is not an orphan page.
    - **Done when**: the tracker and the docs sidebar both reflect the shipped feature.
