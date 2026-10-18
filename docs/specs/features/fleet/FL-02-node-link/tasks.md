# FL-02 — Node link & runtime foundations · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Epic ID:** `FL-02-node-link`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `Draft`
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative; `pnpm` from the root. Runners: `packages/contracts`, `apps/node` →
  **Vitest**; `packages/agent`, `apps/api` → **Jest**; `apps/web` e2e → **Playwright**.
- The existing computer-session leg (`apps/node/src/core/screen/node-leg.ts`) and both gateways must
  stay green after every task — their specs are the regression floor for this epic.
- Migration authored from `apps/api/`; re-stamp the slot if `develop` moved (README rule 10).
- Nothing is removed: the legacy leg stays as the fallback; retiring it is a separate change the
  owner approves, not a task here.
- Commit style: `feat(fleet-link): …`, `feat(node): …`, `test(fleet-link): …`.

---

## P1.A — Contracts

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-link.types.ts` (constants, frame kinds,
      families, control message union, `FleetLinkError`, `FleetConsents`, `effectiveConsents`,
      `FLEET_LINK_FAMILY_CONSENT`, `FLEET_LINK_STATE_CHANGING_FAMILIES`) and export from
      `packages/contracts/src/fleet/index.ts`.
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-link.types.spec.ts` — every family has a
      consent; `effectiveConsents` for null/partial/full; constants equal CONTRACTS §10.
- [ ] **T-02**. Add `packages/contracts/src/fleet/fleet-link.codec.ts` (`encodeLinkFrame`,
      `decodeLinkFrame`, `encodeControl`, `decodeControl`; null-never-throw; 16 MiB cap before parse).
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-link.codec.spec.ts` — round-trip per kind,
      cap + 1 refused, truncated header, `__proto__` stripped, 10 000-buffer fuzz never throws.
- [ ] **T-03** (parallel). Extend `packages/contracts/src/fleet/fleet-node.types.ts`:
      `FleetNodeSelfDescription.consents?`, `FleetNodeView.consents?`, `FleetNodeView.link?`,
      `FleetHeartbeatResponse.recommendedNodeVersion?`. Add `packages/contracts/src/fleet/fleet-operations.types.ts`.
      Add `node.consent.change`, `node.link.connect`, `node.link.disconnect`, `node.link.channel-open`
      to `packages/contracts/src/fleet/fleet-panic.types.ts` (`:60-131`).
      **Test**: extend `fleet-node.spec.ts`, `fleet-panic.spec.ts`; `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts`
      still green (optional fields only).
- [ ] **T-04**. Add fixture `packages/contracts/fixtures/fleet-link-contract.v1.json` (hello, ready,
      channel.open/ready/refused/close, operation.progress/done, one frame per kind as hex).
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-link.fixture.spec.ts` — codec decodes
      every fixture entry to the typed shape.

## P1.B — Node: consent, socket extraction, link client

- [ ] **T-05**. Extract socket mechanics from `apps/node/src/core/screen/node-leg.ts` (`:76-89`,
      `:107-116`, `:142-148`, `:171-177`) into `apps/node/src/core/link/link-socket.ts`
      (`isSecureLegOrigin`, `toWsUrl`, `createReconnectingSocket({ baseMs, maxMs, jitter, acceptedAfterMs })`);
      `node-leg.ts` imports it with its 2 s base unchanged.
      **Test**: `apps/node/src/core/link/link-socket.spec.ts` (ladder 1 s → 30 s with jitter bounds,
      reset only on accept); `apps/node/src/core/screen/node-leg.spec.ts` passes unchanged.
- [ ] **T-06**. `--manage` on `start` in `apps/node/src/cli/program.ts` (beside `--attend` `:1549-1552`;
      `manageEnabled` beside `attendEnabled` `:464`); `createNodeRuntime` option `manageEnabled` in
      `apps/node/src/core/runtime.ts` (beside `attendEnabled` `:480`); `CapabilityEnvironment.managed`
      and the `managed` tag in `apps/node/src/core/capabilities.ts` (`detectCapabilities` `:277-330`).
      `status` / `doctor` print consents.
      **Test**: extend `apps/node/src/core/capabilities.spec.ts` (`managed` only with the flag) and
      `apps/node/src/cli/program.spec.ts` (flag parsed, independent of `--work`/`--attend`).
- [ ] **T-07**. Heartbeat `consents`: `describe()` in `runtime.ts` adds `{ work, attend, manage,
      usageScan: false }` (CONTRACTS §1.1; FL-20 wires `usageScan`);
      `OPTIONAL_DESCRIPTION_FIELD_TIERS` in `apps/node/src/core/heartbeat.ts:72-90` gains `consents` in
      the newest tier; `apps/node/src/core/types.ts` `NodeSelfDescription.consents?`.
      **Test**: extend `apps/node/src/core/heartbeat.spec.ts` — sent on every beat; dropped first on a
      400 from an older platform; `node-contract.conformance.spec.ts` fixture updated.
- [ ] **T-08**. Module registry: `apps/node/src/core/link/modules/registry.ts` (`NodeModule`,
      `composeModules`), `modules/control.ts` (ch 0: ping/pong, pause/resume/drain flags),
      `modules/machine.ts` (lazy channel, verb router, `unsupported_on_node`), `modules/index.ts`.
      `detectCapabilities` appends `composeModules(env).tags`.
      **Test**: `apps/node/src/core/link/modules/registry.spec.ts` — tag composition; unknown verb;
      consent refusal on the node; pause blocks new input, not replies.
- [ ] **T-09**. Link client: `apps/node/src/core/link/link-client.ts` (hello/ready, generation, resume
      list, 15 s ping / 45 s silence, `refusedUntil` 5 min on flag-off close) and
      `apps/node/src/core/link/channel-mux.ts` (64 channels, per-channel queues, slow-reader drop,
      ACK credit). Wire into `runtime.ts` after `untilHeartbeatAccepted` (`heartbeat.ts:127`) when any
      consent is on; expose link state to `status`/`doctor`; export from `apps/node/src/core/index.ts`.
      **Test**: `link-client.spec.ts` (hello shape, ready, ping timing ±1 ms, resume, pause/resume/drain,
      refused-until), `channel-mux.spec.ts` (65th refused, number not reused, credit).

## P1.C — API: token, gateway, registry, authoriser, operations

- [ ] **T-10**. Migration `apps/api/src/migrations/1796020000000-AddFleetNodeConsents.ts` (guarded
      `ADD COLUMN consents text NULL` and `ADD COLUMN previewProfileEnabled boolean NOT NULL DEFAULT
      false` — CONTRACTS §13 puts both in this slot; FL-10 owns the behaviour); entity columns in
      `packages/agent/src/entities/fleet-node.entity.ts`;
      `FleetService.heartbeat` (`packages/agent/src/fleet/fleet.service.ts:534-630`) stores `consents`,
      emits `node.consent.change` through `FleetAuditService`, and calls a `ConsentChangeListener` port.
      DTO field in `apps/api/src/fleet/dto/fleet.dto.ts`.
      **Test**: `packages/agent/src/fleet/__tests__/fleet.service.consents.spec.ts`; migration applies
      twice; `apps/api/src/fleet/dto/fleet-heartbeat-consents.dto.spec.ts` (shape accepted; unknown key
      still 400).
- [ ] **T-11**. Create `apps/api/src/fleet-link/` module: `fleet-link.module.ts` (registered in
      `apps/api/src/api.module.ts` beside `TerminalModule` `:72,292`), `fleet-link-token.service.ts`
      (HMAC via `TerminalAttachService` signer family, `jti` seen-set with Valkey/in-process),
      `fleet-link.controller.ts` (`POST /api/fleet/link-token` under `FleetEnabledGuard` +
      `FleetNodeAuthGuard`, 404 when `FLEET_NODE_LINK_ENABLED` is off).
      **Test**: `apps/api/src/fleet-link/fleet-link.controller.spec.ts` — guard reuse, undifferentiated
      401, single use, 5 min TTL, flag off.
- [ ] **T-12**. `apps/api/src/fleet-link/fleet-link-gateway.service.ts` on `/ws/fleet/link` (shape of
      `apps/api/src/computer/computer-ws.service.ts:27-69`); add `/ws/fleet/` to
      `TERMINAL_WS_FOREIGN_PATH_PREFIXES` (`apps/api/src/terminal/terminal-ws.service.ts:50`) and to the
      computer gateway's ignore list. `fleet-link.registry.ts` (links, generations, channels, resume).
      **Test**: `fleet-link-gateway.spec.ts` — query string destroyed; 4001 after 5 s; replay refused;
      foreign node refused; 10 hellos/min; generation increments; resumed/closed lists; 45 s silence.
- [ ] **T-13**. `fleet-link.authorizer.ts` (kill switch → consent → `FleetAccessService.assertFamily`;
      audit `node.link.channel-open` for `FLEET_LINK_STATE_CHANGING_FAMILIES`) and `fleet-link.service.ts`
      (`request(nodeId, family, verb, params, caller)`, channel reuse, `requestId` correlation, typed
      errors with CONTRACTS §8 hints).
      **Test**: `fleet-link.authorizer.spec.ts` (order; no node contact on refusal; audit only for
      state-changing); `fleet-link.service.spec.ts` (`unreachable` when no link; `limit_exceeded` on
      the 65th; `unsupported_on_node` passthrough).
- [ ] **T-14**. Operations: `fleet-operations.service.ts` (in-memory + Valkey TTL 1 h) and
      `GET /api/fleet/operations/:id` + `DELETE /api/fleet/operations/:id` (sends `operation.cancel`,
      CONTRACTS §3.3 / §11.2) in `fleet-link.controller.ts`; ch 0 `operation.progress/done` handling
      in the registry.
      **Test**: `fleet-operations.service.spec.ts` — progress, done, cancel → `cancelled`, expiry,
      foreign caller 404.
- [ ] **T-15**. Kill switch and panic: `fleet-link.registry.ts` subscribes to
      `FleetKillSwitchService` changes (poll each ping tick, as the computer relay does) → `link.pause`
      / `link.resume` broadcast; `apps/api/src/fleet/fleet-panic.service.ts` drain-all → `link.drain
      { graceSec: 60 }`. Consent withdrawal (T-10 listener) closes affected channels with
      `consent_missing`.
      **Test**: extend `fleet-link.registry.spec.ts` — pause within 5 s, resume without reconnect,
      drain warning, channels closed on consent loss.

## P1.D — Web and i18n

- [ ] **T-16**. Link line in `apps/web/src/components/fleet/computer/ComputerHeader.tsx` from
      `node.link`; `apps/web/src/components/fleet/link/ConsentsCard.tsx` registered with
      `registerOverviewBlock` (FL-01);
      `link.shared.ts` (state word, missing-consent command, bytes). Registry placeholder resolution
      reads `effectiveConsents`.
      **Test**: `link.shared.unit.spec.ts`, `ConsentsCard.unit.spec.tsx` (command for each missing
      consent; kind-cannot variant).
- [ ] **T-17**. i18n `fleet.link.*`, `fleet.consents.*`, `fleet.errors.*` additions in
      `apps/web/messages/en.json`.
      **Test**: no dotted leaf; no literal string in `apps/web/src/components/fleet/link/**`.
- [ ] **T-18**. Playwright `apps/web/e2e/flow-fleet-link-contract.spec.ts` (token shape, hello/ready
      fixture via the node harness, refusal codes) and `flow-fleet-consents.spec.ts`.
      **Test**: itself; AW-11 `flow-agent-computer-*.spec.ts` unchanged and green.

## P2 — Relay bus and viewer bridge

- [ ] **T-19**. `apps/api/src/relay/relay-bus.ts` (`RelayBus` interface = the existing
      `TerminalFanoutBus` plus subscribe), `relay-bus.valkey.ts` (ioredis pub/sub, delivery answer),
      `relay-bus.in-process.ts`, `relay-bus.module.ts` selecting Valkey exactly when `getRedisUrl()`
      answers (CONTRACTS R-7 — no mode setting); bind to `TERMINAL_FANOUT_BUS`
      (`terminal-relay.registry.ts:130`) and the computer relay's bus token (`computer.module.ts:62-70`);
      boot check for `FLEET_RELAY_REQUIRE_BUS`.
      **Test**: `relay-bus.valkey.spec.ts` against a test Valkey (round-trip, delivery answer, degraded
      on loss); `relay-bus.module.spec.ts` (selection by `REDIS_URL`; boot failure message names
      `FLEET_RELAY_REQUIRE_BUS`).
- [ ] **T-20**. Health: `fleet_relay` indicator in `apps/api/src/health/service-detection.ts` /
      `health.controller.ts:85-100` (`configured`, `mode: 'valkey'|'single-replica'`, `status`) on the
      existing `GET /api/health/ready`.
      **Test**: extend `apps/api/src/health/health.controller.spec.ts` — both modes and the degraded
      status.
- [ ] **T-21**. Viewer side: `fleet-link-attach.service.ts` (`mint(nodeId, family, target, role,
      caller)`; channel claim `fleet-link`, role `viewer|driver`, 60 s, single use) over
      `TerminalAttachService`, authoriser applied — no HTTP route of its own: each epic calls it from
      its CONTRACTS §11.2 attach-token path; `fleet-link-viewer-gateway.service.ts` on `/ws/fleet/:family/:id`;
      `fleet-link-relay.ts` bridging viewer sockets ↔ node channels through the bus.
      **Test**: `fleet-link-relay.spec.ts` (viewer input → error frame, never forwarded; driver
      forwarded; cross-replica via bus mock); `fleet-link-viewer-gateway.spec.ts` (token single use,
      wrong-channel token refused).
- [ ] **T-22**. Computer-session leg over the link: `apps/node/src/core/executors/computer-session.ts`
      uses a `desktop { source: 'browser' }` channel when `runtime.link` is connected, else
      `openNodeLeg` (unchanged); `EVER_WORKS_NODE_LINK_LEGACY_LEG=1` forces the old path. API side:
      `computer-relay.registry.ts` accepts frames from the bridge as the `worker` role.
      **Test**: `computer-session.spec.ts` extend (both paths); AW-11 e2e run twice in CI (env matrix).
- [ ] **T-23**. Integration `apps/api/test/fleet-link.two-replicas.e2e-spec.ts` — two API processes,
      one Valkey, node harness on A, viewer on B; frames both ways; bus loss degrades health.
      **Test**: itself.

## P3 — Lifecycle, management lane and parity

- [ ] **T-24**. Upgrade-required surfaces: `apps/web/src/components/fleet/link/UpgradeRequiredSection.tsx`
      on the Settings tab; card/header word from FL-03's state mapping (`node.upgradeRequired`);
      `recommendedNodeVersion` (CONTRACTS §1.1) from `FLEET_RECOMMENDED_NODE_VERSION` in
      `packages/agent/src/config/` and `FleetService.heartbeat` result (`fleet.service.ts:620-630`);
      producer `packages/agent/src/fleet/needs-a-look/producers/node-upgrade-required.producer.ts`
      registered under FL-01's `NEEDS_A_LOOK_PRODUCERS`.
      **Test**: `UpgradeRequiredSection.unit.spec.tsx`; extend `config.spec.ts` and the heartbeat spec;
      `packages/agent/src/fleet/__tests__/node-upgrade-required.producer.spec.ts` (one `info` item per
      below-floor node, stable id, none at or above the floor).
- [ ] **T-25**. Node self-update: `apps/node/src/core/link/self-update.ts` (compare, installer
      detection reusing `doctor`'s install-path logic, run, exit 75, failure log + heartbeat
      `selfUpdateFailedAt`); `--auto-update` on `start` in `program.ts`; `node-lifecycle.ts` record gains
      the verdict.
      **Test**: `self-update.spec.ts` (ladder, refuse unknown installer, failure keeps old version);
      container integration in `apps/node/packaging/` smoke script.
- [ ] **T-26**. Desktop shell: consents in `apps/desktop-node/src/main/main.ts:138` options,
      `apps/desktop-node/src/main/tray.ts` toggles, wizard step in `apps/desktop-node/src/renderer/`;
      config persisted beside the enrolment.
      **Test**: `apps/desktop-node/src/main/start-order.spec.ts` extend (consents passed through);
      renderer unit spec for the step.
- [ ] **T-27**. Management lane (CONTRACTS R-34): `FLEET_MANAGEMENT_LANE_KINDS` (empty) and
      `FLEET_MANAGEMENT_LANE_CONSENT` in `packages/contracts/src/fleet/fleet-jobs.types.ts`;
      `createManagementLane` beside `createAttendedLane` in `apps/node/src/core/runtime.ts`
      (`:1026-1070`), started only when a registered kind's consent is on, concurrency 1 outside
      `--concurrency`; the work lane's kind filter (`runtime.ts:657-661`) excludes the lane's kinds.
      **Test**: `apps/node/src/core/runtime.management-lane.spec.ts` — with a test kind: leased only
      with its consent, never by the work lane, work-lane slots unchanged; empty set → no lane started.
- [ ] **T-28**. Docs: `docs/features/fleet-node-link.md` (consents, what the link is, what it never
      does, operator relay settings, self-update); add to `apps/docs/sidebarsPlatform.ts` beside
      `'features/fleet'` (`:183`); extend `docs/features/fleet.md` §"Keeping nodes current" and
      §"Connect a machine"; `docs/specs/security/fleet-session-trust-model.md` gains a link section;
      update `docs/specs/features/fleet/TRACKER.md` row FL-02.
      **Test**: `pnpm --filter ever-works-docs build` — no broken-link warning.
- [ ] **T-29**. `pnpm format && pnpm lint && pnpm test && pnpm build` green; AW-11 and fleet e2e green
      with `FLEET_NODE_LINK_ENABLED` on and off and on both legs.

## Definition of done

- Every checkbox ticked; every named test exists and passes locally and in CI.
- `FLEET_NODE_LINK_ENABLED=false` reproduces today's behaviour; the legacy leg is intact.
- Conformance fixtures (`fleet-node-contract.v1.json`, `fleet-link-contract.v1.json`) are the wire
  truth and both are green.
- Banned-terms grep over this folder and the code prints nothing (program rule 16).
- Spec §9 criteria checked by a non-author; constitution gates in spec §10 confirmed.
