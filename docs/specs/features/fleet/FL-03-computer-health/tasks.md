# FL-03 — Computer health & inventory · Task breakdown

> Ordered, executable tasks derived from [`plan.md`](./plan.md). Each carries explicit file paths
> and a test. Every task ships with its tests (Constitution VI). Work top to bottom; tasks marked
> `(parallel)` may run alongside the task immediately above them.

**Epic ID:** `FL-03-computer-health`
**Spec:** [`./spec.md`](./spec.md) · **Plan:** [`./plan.md`](./plan.md)
**Status:** `In progress` — P1 in PR 1 (`feat/fl-03-computer-health-p1`)
**Last updated:** 2026-10-18

---

## How to use

- Paths are repo-relative; `pnpm` from the root. Runners: `packages/contracts`, `apps/node`,
  `apps/web` unit → **Vitest**; `packages/agent`, `apps/api`, `packages/tasks` → **Jest**; e2e →
  **Playwright**.
- P1 and P2 depend on FL-01's registry and slots; P3 depends on FL-02's `machine` channel. Until
  those merge, develop against their interfaces behind stubs named in the tasks.
- Migrations authored from `apps/api/`; re-stamp the slot if `develop` moved (README rule 10).
- Health is report-only: no task may add a platform → node write other than the two verbs in P3.
- Commit style: `feat(fleet-health): …`, `feat(node): …`, `test(fleet-health): …`.

---

## P1.A — Contracts and node probe

- [ ] **T-01**. Add `packages/contracts/src/fleet/fleet-node-health.types.ts` (snapshot, stored,
      `ComputerState`, `resolveComputerState`, `diskLowSeverity`, bounds) and export from
      `packages/contracts/src/fleet/index.ts`; extend `FleetNodeSelfDescription` / `FleetNodeView` in
      `fleet-node.types.ts` (`health?`, `macAddress?`, `lanId?`, `canWake?`, `lastWakeAttemptAt?`); add
      `node.wake` to `fleet-panic.types.ts` (`:60-131`).
      **Test**: `packages/contracts/src/fleet/__tests__/fleet-node-health.spec.ts` — state truth table
      incl. agreement with `runnerRowState` (`apps/web/src/components/dashboard/runner-status.shared.ts:24-33`
      logic mirrored), `diskLowSeverity` boundaries, bounds.
      **Status (FL-03 PR 1)**: P1 half ✓ (snapshot, stored view, states — with the offline window, `offlineAfterMs` — disk rule, bounds, `health` on the self-description and view, `hasFleetNodeHealthReading`, `FLEET_CLEAR_MODEL_THROTTLE_COMMAND`; items use FL-01's §4.6 shape; the `runnerRowState` agreement test lives in `apps/web` and imports the real function). `macAddress`/`lanId`/`canWake`/`lastWakeAttemptAt` on the wire and `node.wake` land with T-19 … T-20.
- [x] **T-02**. Create `apps/node/src/core/health-probe.ts` (`probeHealth`, per-fact sub-probes with a
      2 s budget; reuses `createResourceProbe` from `apps/node/src/node-io.ts:310` and the disk probe in
      `apps/node/src/core/telemetry-probe.ts`); extend `apps/node/src/core/gpu-probe.ts` with
      utilisation/memory queries; export from `apps/node/src/core/index.ts`.
      **Test**: `apps/node/src/core/health-probe.spec.ts` — every fact per OS with fake runners; hanging
      runner drops the field in 2 s; `gpu-probe.spec.ts` extend.
- [ ] **T-03**. Heartbeat: `describe()` in `apps/node/src/core/runtime.ts` adds `health`, `macAddress`,
      `lanId`; `OPTIONAL_DESCRIPTION_FIELD_TIERS` in `apps/node/src/core/heartbeat.ts:72-90` gains them in
      the newest tier; `apps/node/src/core/types.ts` `NodeSelfDescription` fields.
      **Test**: extend `apps/node/src/core/heartbeat.spec.ts` (sent; dropped first on 400);
      `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts` fixture
      `packages/contracts/fixtures/fleet-node-contract.v1.json` updated.
      **Status (FL-03 PR 1)**: P1 half ✓ (`health` in its own newest tier, enrolment never sends it). `macAddress`/`lanId` join a newer tier with T-19 … T-20.

## P1.B — Platform: store, derive, produce

- [x] **T-04**. Entity columns in `packages/agent/src/entities/fleet-node.entity.ts` (`health`,
      `macAddress`, `lanId`, `lastWakeAttemptAt`) and new
      `packages/agent/src/entities/fleet-node-health-sample.entity.ts`; register in
      `packages/agent/src/entities/index.ts` and `packages/agent/src/database/_entities-inventory.ts`.
      **Test**: `pnpm --filter @ever-works/agent build` clean.
- [x] **T-05**. Migrations from `apps/api/` (CONTRACTS §13 slots, both in P1):
      `apps/api/src/migrations/1796030000000-CreateFleetNodeHealthSamples.ts` (table + indexes, the
      §4.5 columns with `resolution` `raw|hourly`) and `1796030100000-AddFleetNodeWakeFields.ts`
      (`health`, `macAddress`, `lanId`, `lastWakeAttemptAt`), guarded like `1795161700000-AddFleetModelUsageLimits.ts`.
      **Test**: apply twice on sqlite and Postgres; `migration:generate` afterwards empty.
- [ ] **T-06**. `FleetService.heartbeat` (`packages/agent/src/fleet/fleet.service.ts:534-630`) stores
      `health` with receipt time (`sanitize` each number; absent never overwrites), `macAddress`
      (format-checked), `lanId`; DTO fields in `apps/api/src/fleet/dto/fleet.dto.ts`;
      `FleetNodeView` mapping adds them (masked MAC for non-owners).
      **Test**: `packages/agent/src/fleet/__tests__/fleet.service.health.spec.ts`;
      `apps/api/src/fleet/dto/fleet-heartbeat-health.dto.spec.ts` (shape; out-of-range refused).
      **Status (FL-03 PR 1)**: P1 half ✓ (snapshot sanitised and stored with the receipt time; absent leaves it alone; `diskLowSince`/`sampledAt` markers; covered by `fleet.service.health.spec.ts` and the conformance fixture — out-of-range values are dropped by the sanitiser, never a 400). MAC/`lanId` storage and masking land with T-20.
- [x] **T-07**. Producers in `packages/agent/src/fleet/needs-a-look/producers/`: `disk-low.producer.ts`,
      `node-throttled.producer.ts` (throttled + limited), `node-quarantined.producer.ts`,
      `consent-missing.producer.ts`, `helper-untrusted.producer.ts`; registered under FL-01's
      `NEEDS_A_LOOK_PRODUCERS` in `packages/agent/src/fleet/fleet.module.ts`.
      **Test**: `packages/agent/src/fleet/__tests__/needs-a-look.producers.spec.ts` — condition,
      severity, action, stable id per producer; `helper-untrusted` silent without `helperTrust`.
      **Status (FL-03 PR 1)**: ✓ — bound through the `NEEDS_A_LOOK_PRODUCERS` token; the spec is
      `needs-a-look.spec.ts` and also runs every item through FL-01's real registry and normaliser.
- [ ] **T-08**. `apps/api/src/fleet/fleet-health.controller.ts` with `GET /nodes/:id/health`
      (`view` family via FL-01's `FleetAccessService`); add the `machines` family check to the existing
      `POST nodes/:id/clear-model-throttle` (`apps/api/src/fleet/fleet.controller.ts:451`).
      **Test**: `apps/api/src/fleet/fleet-health.controller.spec.ts` — shape, 404 for strangers;
      extend `fleet.controller.spec.ts` (`:136` block) for the family check.
      **Status (FL-03 PR 1)**: P1 half ✓ (`GET /nodes/:id/health` through FL-01's `getVisibleForUser` — the `view` family — with the job count for the owner only; `fleet-health.controller.spec.ts`). The clear route keeps its owner-only check, which is the `machines` default audience; the family check on it lands with P2's `machines` acts (wake).

## P1.C — Web: cells, metric slot, sentences

- [ ] **T-09**. `apps/web/src/components/fleet/health/computer-state.shared.ts` (state → i18n key +
      action); use it in FL-01's `ComputerHeader.tsx`, `ComputerCards.tsx`, `FleetComputersTable.tsx`
      (word beside dot, action button); card cells read `node.health`.
      **Test**: `computer-state.shared.unit.spec.ts`; extend `ComputerCards.unit.spec.tsx` ("—", stale).
      **Status (FL-03 PR 1)**: P1 half ✓ (`computer-state.shared.ts`, `ComputerStateLine`, `HealthCells` for the cards). Wiring them into FL-01's `ComputerHeader` / `ComputerCards` / `FleetComputersTable` (on `develop` since FL-01 P1b) lands in PR 2.
- [x] **T-10**. `apps/web/src/components/fleet/health/overview/HealthMetrics.tsx` registered as the
      Overview "metrics" block via `registerOverviewBlock` in `apps/web/src/components/fleet/registry.ts` (six cards, reboot line,
      footprint sentence, Refresh now button disabled with reason until P3).
      **Test**: `HealthMetrics.unit.spec.tsx` — loading, no snapshot, stale, offline, error, all cards.
- [x] **T-11**. Fix actions: Clear limit now → existing `clearModelThrottleAction`; quarantine and
      consent commands via `fleet.fixCommands.*` (never `fleet.commands.*`, FL-12's namespace);
      `fleetAPI.health(id)` in `apps/web/src/lib/api/fleet.ts`.
      **Test**: `apps/web/src/components/fleet/health/FixAction.unit.spec.tsx` — each state's action.
- [x] **T-12**. i18n `fleet.health.*`, `fleet.states.*` (eleven), `fleet.needsALook.kinds.*`,
      `fleet.fixCommands.*` in `apps/web/messages/en.json`.
      **Test**: no dotted leaf; no literal string under `apps/web/src/components/fleet/health/**`.
      **Status (FL-03 PR 1)**: ✓ without `fleet.needsALook.kinds.*`: FL-01's §4.6 item carries no
      message key, so items are English sentences (lane log decision 10, owner question 6).
- [x] **T-13**. Playwright `apps/web/e2e/flow-fleet-health.spec.ts` — cards with numbers from the
      harness beat, "—" for an old node, state sentences, producers in the list, Clear limit now.
      **Test**: itself.

## P2 — History

- [x] **T-14**. `packages/agent/src/fleet/fleet-node-health.service.ts` (`record` behind
      `config.fleet.isHealthHistoryEnabled()` — add to `packages/agent/src/config/`; 55 s floor;
      fire-and-forget with one log per node per hour) called from `FleetService.heartbeat`; repository
      `fleet-node-health-sample.repository.ts` (`insertRaw`, `rollupHour`, `deleteBefore`, `series`).
      **Test**: `packages/agent/src/fleet/__tests__/fleet-node-health.service.spec.ts` — floor, flag off,
      failure not thrown; repository spec on sqlite.
- [x] **T-15**. `packages/tasks/src/tasks/trigger/fleet-health-rollup.task.ts` (cron `7 * * * *`;
      `TriggerInternalModule`; one `hourly` row of means per node per hour — peaks wait on spec §8b;
      retention 7 d raw / 90 d hourly); register
      in `packages/tasks/src/tasks/trigger/index.ts` beside `fleet-job-lease-sweeper`.
      **Test**: `packages/tasks/src/__tests__/fleet-health-rollup.task.spec.ts` — roll-up values,
      idempotent re-run, boundaries ±1 min.
- [ ] **T-16**. `GET /nodes/:id/health/history` in `fleet-health.controller.ts` (ranges, ≤ 500 points,
      gaps, `{ disabled: true }` when off); `fleetAPI.healthHistory`.
      **Test**: extend `fleet-health.controller.spec.ts` — each range picks the right resolution;
      downsampling to 500; flag off.
- [ ] **T-17**. `apps/web/src/components/fleet/health/overview/HealthHistoryChart.tsx` (ranges,
      toggles, gaps, a11y text summary) registered with `registerOverviewBlock`; card sparkline in `ComputerCards.tsx`.
      i18n `fleet.history.*`.
      **Test**: `HealthHistoryChart.unit.spec.tsx` — gaps as breaks, off, empty, summary text.
- [ ] **T-18**. Playwright `apps/web/e2e/flow-fleet-health-history.spec.ts` — flag off message; flag on
      ranges render harness samples.
      **Test**: itself.

## P3 — Reach: wake and refresh now

- [ ] **T-19**. Node module `apps/node/src/core/link/modules/health.ts` (verbs `health.now`,
      `wake.send`; `wake` tag when `manage` and a MAC) added to `apps/node/src/core/link/modules/index.ts`
      (FL-02).
      **Test**: `apps/node/src/core/link/modules/health.spec.ts` — snapshot reply on a `--work`-only
      link (`health.now` needs no `manage`, CONTRACTS R-31 / FL-02 `FLEET_LINK_VERB_CONSENT_OVERRIDES`);
      3 packets to the right addresses; MAC validation; `wake.send` refused without `manage`; tag
      conditions.
- [ ] **T-20**. `POST /nodes/:id/health` (refresh now — `view` family, any open link, CONTRACTS R-31,
      §2.1) and `POST /nodes/:id/wake` (`machines` family on the target) in
      `fleet-health.controller.ts` through FL-02's `FleetLinkService.request`; sibling selection
      (`same owner, same lanId, online, tags ⊇ { wake, managed }`); `lastWakeAttemptAt`; audit
      `node.wake { target, via }`; per-node windows (10/min, 3 per 5 min); hint
      `"last seen …; wake it from …?"` on `unreachable`.
      **Test**: extend `fleet-health.controller.spec.ts` — every error code; the 11th refresh and the
      4th wake; audit row; sibling selection matrix.
- [ ] **T-21**. Web: `apps/web/src/components/fleet/health/overview/WakePanel.tsx`, Refresh now
      enabled path with `fleetAPI.refreshHealth`, `fleetAPI.wake`; 20 s / 60 s listener polling
      `GET /nodes/:id` status; `R` / `W` shortcuts; i18n `fleet.wake.*`, `fleet.health.refresh*`.
      **Test**: `WakePanel.unit.spec.tsx` (every disabled reason, outcomes at 20 s / 60 s with fake
      timers); `HealthMetrics.unit.spec.tsx` extend (refresh success, `unreachable` → Try again).
- [ ] **T-22**. Tool shapes handed to FL-19 under its catalogue names (FL-19 plan §9.1):
      `fleet_nodes_health` (`readOnly`; `range?` for history, `fresh: true` for Refresh now),
      `fleet_nodes_needs_a_look` (`readOnly`), `fleet_nodes_wake` (`destructive: false`, `plain`) with
      annotations in `packages/agent/src/fleet/agent-fleet-tools.ts` beside `list_fleet_nodes` (`:40`)
      — read-only ones wired now, the state-changing one exported as a descriptor for FL-19.
      **Test**: `packages/agent/src/fleet/__tests__/agent-fleet-tools.spec.ts` — annotations, envelopes.
- [ ] **T-23**. Playwright `apps/web/e2e/flow-fleet-wake-refresh.spec.ts` — disabled variants; refresh
      round-trip via the node harness; wake via a harness sibling.
      **Test**: itself.

## P4 — Docs and rollout

- [ ] **T-24**. Docs: `docs/features/fleet-health.md` (what is reported, states and fixes, history
      retention and footprint, wake, refresh); add to `apps/docs/sidebarsPlatform.ts` beside
      `'features/fleet'` (`:183`); extend `docs/features/fleet.md` §"Health signals" with a pointer;
      update `docs/specs/features/fleet/TRACKER.md` row FL-03.
      **Test**: `pnpm --filter ever-works-docs build` — no broken-link warning.
- [ ] **T-25**. `pnpm format && pnpm lint && pnpm test && pnpm build` green; fleet, FL-01, FL-02 and
      AW-11 e2e green with `FLEET_HEALTH_HISTORY_ENABLED` on and off.

## Definition of done

- Every checkbox ticked; every named test exists and passes locally and in CI.
- A node of the previous version keeps heartbeating against this platform and shows "—" cells; a
  node of this version keeps heartbeating against the previous platform (tier drop proven).
- With `FLEET_HEALTH_HISTORY_ENABLED=false` no sample row is ever written.
- Banned-terms grep over this folder and the code prints nothing (program rule 16).
- Spec §9 criteria checked by a non-author; constitution gates in spec §10 confirmed.
