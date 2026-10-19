# FL-03 — Computer health & inventory · Implementation plan

> How [`spec.md`](./spec.md) gets built. Implementation detail belongs here, not in the spec
> (Constitution IX). Every path below was opened at `origin/develop` `e4334baf7` before it was cited.

**Epic ID:** `FL-03-computer-health`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft` · implementation `In progress` (P1 in `feat/fl-03-computer-health-p1`)
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    subgraph node [apps/node]
        HP[health-probe.ts\ncpu · mem · disk · load · uptime · gpu · reboot · services] --> DESC[describe() → health]
        DESC --> HB[HeartbeatLoop 60 s HTTPS]
        HM[link/modules/health.ts\nhealth.now · wake.send] --> LINK[node link FL-02]
    end
    subgraph api [apps/api + packages/agent]
        HB --> HBC[FleetController /heartbeat]
        HBC --> FS[FleetService.heartbeat\nstore health jsonb]
        FS --> HS[FleetNodeHealthService\nsample writer (flag)]
        HS --> T[(fleet_node_health_samples)]
        FS --> FN[(fleet_nodes.health · macAddress · lanId)]
        ST[computer-state.ts (pure)] --> PROD[5 NeedsALook producers]
        PROD --> NAL[NeedsALookService FL-01]
        HC[FleetHealthController\n/nodes/:id/health · /history · /wake] --> FLS[FleetLinkService FL-02]
        FLS --> LINK
        ROLL[fleet-health-rollup.task\nhourly + retention] --> T
    end
    subgraph web [apps/web]
        CARD[ComputerCards cells] & MET[overview/HealthMetrics] & CHART[overview/HealthHistoryChart] & WAKE[WakeButton · RefreshNowButton]
    end
    FN --> CARD
    HC --> MET & CHART
    WAKE --> HC
```

Data flows up only: the node reports, the platform stores and derives; the two reach actions go down
the FL-02 link as `machine`-family verbs and come back as a snapshot or an outcome.

## 2. Current state in the codebase

| Piece                                              | Where (verified)                                                                                                                                                                                                            | Reused as                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Heartbeat self-description and tiers               | `apps/node/src/core/heartbeat.ts:56-105` (`HeartbeatCapableClient`, `OPTIONAL_DESCRIPTION_FIELD_TIERS` newest first, `onAccepted`); `packages/contracts/src/fleet/fleet-node.types.ts:212-323` (`FleetNodeSelfDescription`) | `health` joins the newest tier                                                       |
| CPU / memory sampling already on the node          | `apps/node/src/core/resource-limits.ts:13-28` (`ResourceSample`), `:36-40` (`ResourceProbe`); `apps/node/src/node-io.ts:288-335` (`createResourceProbe`, delta CPU, `os.totalmem/freemem`)                                  | `health-probe.ts` reuses the probe; no second sampler                                |
| Disk probe                                         | `apps/node/src/core/telemetry-probe.ts:1-45` (never fails the beat, injected IO; `DiskProbeIo`)                                                                                                                             | Disk free + total for percent                                                        |
| GPU probe (vendor + model only)                    | `apps/node/src/core/gpu-probe.ts:19-26` (`GpuInfo { vendor, model }`)                                                                                                                                                       | Extended with utilisation / memory via `nvidia-smi --query-gpu`, `rocm-smi`, `ioreg` |
| Housekeeping report (the rule: report, never obey) | `apps/node/src/core/housekeeping-report.ts:1-35` (states the node sends no CPU/memory reading)                                                                                                                              | Same posture for health                                                              |
| Platform heartbeat handling and patch              | `packages/agent/src/fleet/fleet.service.ts:534-630` (`heartbeat`, `sanitizeByteCount`, `applyWorkerState`, notices), `:81-82` (offline after 5 min), `:958-984` (`listForUser` sweeps offline)                              | Stores `health`; emits samples                                                       |
| Node row health-adjacent columns                   | `packages/agent/src/entities/fleet-node.entity.ts:264` (`diskFreeBytes`), `:312-344` (worker state), `:380-398` (`quarantineNoticedAt`, `modelThrottles`), `:406-429` (floor, workspaces)                                   | Inputs to the state function                                                         |
| Worker states and model throttles contract         | `fleet-node.types.ts:132-160`; `packages/contracts/src/fleet/fleet-model-usage-limit.types.ts:1-50`; `FleetNodeView.modelThrottles` `:424`, `upgradeRequired` `:378`                                                        | Inputs to the state function                                                         |
| Clear limit now                                    | `apps/api/src/fleet/fleet.controller.ts:451-454` (`POST nodes/:id/clear-model-throttle`, audited `node.model-throttle-clear`); `fleet.service.ts:925-945`                                                                   | Called by the fix action; unchanged                                                  |
| Drawer rendering of states, throttles, upgrade     | `apps/web/src/components/settings/FleetNodeDrawer.tsx:229-234, 317-392, 493-505`; `fleet-node-drawer.shared.ts:114-151` (`fleetWorkerStateKey`, badge class)                                                                | Sentences generalise these keys                                                      |
| Runner pill row state                              | `apps/web/src/components/dashboard/runner-status.shared.ts:24-40` (`runnerRowState`, `runnerDotClass`)                                                                                                                      | `computer-state.ts` must agree with it                                               |
| Needs-a-look registry                              | FL-01 `packages/agent/src/fleet/needs-a-look/` (producer token)                                                                                                                                                             | Five producers registered                                                            |
| Link request path                                  | FL-02 `apps/api/src/fleet-link/fleet-link.service.ts` `request(nodeId, 'machine', verb, params, caller)`; node `apps/node/src/core/link/modules/machine.ts` verb router                                                     | `health.now`, `wake.send`                                                            |
| Capability tags                                    | `apps/node/src/core/capabilities.ts:277-330`; FL-02 module tag composition                                                                                                                                                  | `wake` tag from the health module when `manage` and a NIC with a MAC                 |
| Scheduled fleet task precedent                     | `packages/tasks/src/tasks/trigger/fleet-job-lease-sweeper.task.ts:1-40` (`schedules.task`, cron off the minute, `TriggerInternalModule` warning)                                                                            | Roll-up/retention task                                                               |
| Audit union                                        | `packages/contracts/src/fleet/fleet-panic.types.ts:60-131`                                                                                                                                                                  | Gains `node.wake`                                                                    |
| Migration shape                                    | `apps/api/src/migrations/1795161700000-AddFleetModelUsageLimits.ts` (guarded, portable `TableColumn`)                                                                                                                       | Both migrations                                                                      |

Missing today (verified): any CPU/memory/load/uptime/GPU-utilisation/pending-reboot/failed-services
field; any history table; any wake code or `macAddress`; any `health` jsonb; the state sentences.

## 3. Tech choices

| Concern             | Choice                                                                                                                                                                        | Why                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Probes              | `node:os` for CPU (delta via the existing `ResourceProbe`), memory, load, uptime; shell-outs for services, reboot, GPU, all with a 2 s budget and injected runner             | Zero new dependencies; same injection pattern as `telemetry-probe.ts`             |
| Snapshot on the row | `simple-json` `health` column (`FleetNodeHealthSnapshot & { at }`)                                                                                                            | CONTRACTS §4.1; one row read per card                                             |
| History             | One table `fleet_node_health_samples` with `resolution: 'raw' \| 'hourly'` and `(nodeId, resolution, at)` index                                                               | CONTRACTS §4.5 (columns and discriminator exactly); one retention job             |
| Roll-up             | Hourly cron task on the configured job runtime: `INSERT … SELECT avg(…) … GROUP BY` the hour, then delete raw > 7 d, hourly > 90 d; means only until spec §8b (a) is answered | Constitution IV; idempotent via `ON CONFLICT (nodeId, resolution, at) DO NOTHING` |
| Write path          | `FleetNodeHealthService.record(nodeId, snapshot)` behind `FLEET_HEALTH_HISTORY_ENABLED`, min 55 s between rows per node (in-memory last-write map + DB unique)                | Never on the heartbeat's critical path (fire-and-forget with error log)           |
| State derivation    | Pure `resolveComputerState(view): ComputerState` in contracts                                                                                                                 | Web, API, tools and tests share one function; must agree with `runnerRowState`    |
| Wake                | Sibling sends a UDP magic packet (`dgram`, broadcast to 255.255.255.255:9 and the subnet broadcast)                                                                           | No library; 102-byte frame; the only way for an outbound-only fleet               |
| Network identity    | `lanId = sha256(ownerId ‖ primary interface CIDR)` first 16 hex                                                                                                               | Match siblings without storing addresses                                          |
| Chart               | Existing charting dependency in `apps/web` (recharts, used by the runs ledger) with a text summary                                                                            | No new dependency                                                                 |
| Flags / limits      | `FLEET_HEALTH_HISTORY_ENABLED`; sample 60 s / 7 d / 90 d; wake 3 per 5 min; refresh 10 per min                                                                                | CONTRACTS §9, §10; the two rates are spec §8b (c) defaults until §10 lists them   |

## 4. Data model

### 4.1 Contracts (`packages/contracts/src/fleet/fleet-node-health.types.ts`, new)

```
FleetNodeHealthSnapshot {
  cpuPercent?, memPercent?, memTotalMiB?, memUsedMiB?,
  diskPercent?, diskFreeMiB?, diskTotalMiB?,
  loadAvg1?, cores?, uptimeSec?,
  gpu?: { vendor, model, utilPercent?, memUsedMiB?, memTotalMiB? } | null,
  pendingReboot?: boolean, failedServices?: number
}
FleetNodeHealthStored = FleetNodeHealthSnapshot & { at: string }   // platform receipt time
ComputerState = 'online'|'busy'|'offline'|'enrolling'|'paused'|'disabled'|'draining'|'quarantined'|'throttled'|'limited'|'upgrade-required'
resolveComputerState(view, now): { state, sentenceKey, params, action?: { kind, commandKey? | route? } }
diskLowSeverity(freeMiB, totalMiB, floorBytes | null): 'critical'|'warn'|null
```

Additions: `FleetNodeSelfDescription.health?`, `.macAddress?`, `.lanId?`; `FleetNodeView.health?`,
`.lanId?`, `.canWake?: { via: nodeId, name }`, `.lastWakeAttemptAt?`; `fleet-panic.types.ts` gains
`node.wake`.

### 4.2 Entities

- `fleet-node.entity.ts`: `health` (`simple-json`, nullable), `macAddress` (`varchar(17)`, nullable,
  owner-only), `lanId` (`varchar(16)`, nullable), `lastWakeAttemptAt` (`PortableDateColumn`, nullable).
- New `packages/agent/src/entities/fleet-node-health-sample.entity.ts` → `fleet_node_health_samples`
  with exactly the CONTRACTS §4.5 columns: `id uuid`, `nodeId uuid`, `at` timestamptz, `resolution
varchar(8)` (`raw|hourly`), `cpuPercent`, `memPercent`, `memTotalMiB`, `diskPercent`,
  `diskFreeMiB`, `loadAvg1`, `uptimeSec`, `gpu simple-json null`, `pendingReboot boolean`,
  `failedServices int`. (Peak columns wait on spec §8b (a).) Unique `(nodeId, resolution, at)`;
  index `(resolution, at)` for the sweep. Registered in `packages/agent/src/entities/index.ts` and
  `database/_entities-inventory.ts`.

### 4.3 Migrations (CONTRACTS §13 slots, both shipped in P1)

| Slot                                         | Contents                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1796030000000-CreateFleetNodeHealthSamples` | `CREATE TABLE fleet_node_health_samples` + indexes (the writer arrives in P2)                                                                                                                                  |
| `1796030100000-AddFleetNodeWakeFields`       | `ADD COLUMN health text NULL` (the snapshot, P1), `macAddress varchar(17) NULL`, `lanId varchar(16) NULL`, `lastWakeAttemptAt` timestamptz NULL (read and written from P3), each guarded by `findColumnByName` |

## 5. API surface

Under `@Controller('api/fleet')`, `FleetEnabledGuard`, authenticated; new file
`apps/api/src/fleet/fleet-health.controller.ts`.

| Method | Path                                         | DTO / query                           | Returns                                                       | Family / consent                                                 | Errors                                                                                                                                             |
| ------ | -------------------------------------------- | ------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/nodes/:id/health`                          | —                                     | `{ snapshot: FleetNodeHealthStored \| null, state, canWake }` | `view`                                                           | `not_found`                                                                                                                                        |
| POST   | `/nodes/:id/health`                          | — (refresh now)                       | `FleetNodeHealthStored`                                       | `view`; any open link, no further consent (CONTRACTS R-31, §2.1) | `unreachable` (link down), `consent_missing` (enrol-only node — no link possible), `kill_switch`, `limit_exceeded` (10/min)                        |
| GET    | `/nodes/:id/health/history`                  | `range: 1h\|24h\|7d\|90d`, `metrics?` | `{ resolution, points: [{ at, cpu, mem, disk }] }` (≤ 500)    | `view`                                                           | `not_found`, `invalid`; `{ disabled: true }` when the flag is off                                                                                  |
| POST   | `/nodes/:id/wake`                            | —                                     | `202 { via: { nodeId, name }, listenUntil }`                  | `machines` on target; sibling must advertise `wake` and `manage` | `unsupported_on_node` (no MAC / no sibling), `unreachable` (sibling link down), `kill_switch`, `limit_exceeded` (3 per 5 min), `permission_denied` |
| GET    | `/needs-a-look` (FL-01)                      | —                                     | items from the five producers                                 | —                                                                | —                                                                                                                                                  |
| POST   | `/nodes/:id/clear-model-throttle` (existing) | `{ provider? }`                       | existing                                                      | `machines` (added check)                                         | existing                                                                                                                                           |

Rate tiers: `medium` for reads; refresh and wake throttled per node as above (`@Throttle` plus a
per-node window in the service). Error envelope `{ error: { code, hint, details } }` (CONTRACTS §8);
hints: `unreachable` → `"last seen {relative}; wake it from {sibling}?"` when a sibling exists.

## 6. Node side

### 6.1 Module `apps/node/src/core/link/modules/health.ts` (FL-02 registry)

- **Tags:** `wake` when `manageEnabled` and a primary non-loopback interface with a MAC exists.
- **Verbs on the `machine` channel:** `health.now` → runs the probe, replies `{ snapshot }`;
  `wake.send { macAddress }` → validates the MAC, sends 3 magic packets 200 ms apart to
  `255.255.255.255:9` and the interface's broadcast, replies `{ sent: 3 }`.
- **Consent:** `health.now` is answered on any open link with no consent beyond the link itself
  (CONTRACTS R-31) — the `machine` channel opens for it even on a `--work`- or `--attend`-only node;
  `wake.send` needs `manage` on the sending sibling and the module refuses it without.

### 6.2 Probe `apps/node/src/core/health-probe.ts`

`probeHealth({ runner, resourceProbe, platform, fs, timeoutMs: 2000 }): Promise<FleetNodeHealthSnapshot>`
— every sub-probe independent, each wrapped in a 2 s timeout, failures drop the field.

| Fact              | Linux                                                                                                                                         | macOS                                                 | Windows                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| cpu / mem         | `ResourceProbe` (`os.cpus` delta, `os.totalmem/freemem`)                                                                                      | same                                                  | same                                                                                                                   |
| disk              | `telemetry-probe.ts` free + `statfs` total                                                                                                    | same                                                  | same (`fs.statfs` on the workspace volume)                                                                             |
| load / cores / up | `os.loadavg()[0]`, `os.cpus().length`, `os.uptime()`                                                                                          | same                                                  | `loadAvg1` absent (not meaningful); cores, uptime from `os`                                                            |
| gpu               | `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`; AMD `rocm-smi --showuse --showmemuse --json` | `ioreg -r -c IOAccelerator` (model only; util absent) | `nvidia-smi` when present; else model from `gpu-probe` only                                                            |
| pending reboot    | `/var/run/reboot-required` exists                                                                                                             | `null` (not exposed)                                  | registry keys `…\Component Based Servicing\RebootPending`, `…\WindowsUpdate\Auto Update\RebootRequired` via PowerShell |
| failed services   | `systemctl --failed --no-legend --plain \| wc -l`                                                                                             | `launchctl list` rows with non-zero last exit         | `Get-Service \| ? { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } \| measure`                            |
| mac / lanId       | `os.networkInterfaces()` first non-internal IPv4 with MAC; `lanId = sha256(ownerId ‖ cidr).slice(0,16)`                                       | same                                                  | same                                                                                                                   |

Wiring: `runtime.ts` `describe()` adds `health`, `macAddress`, `lanId`; `heartbeat.ts`
`OPTIONAL_DESCRIPTION_FIELD_TIERS` newest tier gains all three.

## 7. Plugin surface

None.

## 8. Web surface

- Overview blocks (FL-01 `registerOverviewBlock`): `overview/HealthMetrics.tsx` (six cards + reboot line + Refresh now),
  `overview/HealthHistoryChart.tsx` (ranges, toggles, a11y summary), `overview/WakePanel.tsx`
  under `apps/web/src/components/fleet/health/`; card cells and sparkline in
  `apps/web/src/components/fleet/overview/ComputerCards.tsx` read `node.health`.
- `fleet/health/computer-state.shared.ts` re-exports `resolveComputerState` and maps states to
  i18n keys; `ComputerHeader.tsx` and `FleetComputersTable.tsx` (FL-01) use it for the word + action.
- Producers' actions resolve to routes (`DASHBOARD_FLEET_COMPUTER(id, 'overview')`, `… 'settings'`)
  or copyable machine commands (`fleet.fixCommands.clearQuarantine`,
  `fleet.fixCommands.startWithConsent`, `fleet.fixCommands.upgrade` — not `fleet.commands.*`, which
  is FL-12's Commands namespace).
- BFF: `fleetAPI.health(id)`, `refreshHealth(id)`, `healthHistory(id, range)`, `wake(id)` in
  `apps/web/src/lib/api/fleet.ts`; server actions in `apps/web/src/lib/actions/fleet.ts`.
- i18n groups: `fleet.health.*` (cards, units, stale, noSnapshot, footprint, refreshNow, refreshDisabled*),
  `fleet.states.*`(eleven sentences + actions; extends FL-01's keys),`fleet.needsALook.kinds._`(diskLow critical/warn, throttled, limited, quarantined, consentMissing, helperUntrusted),`fleet.wake._`(button, waking, back, notYet, noSibling, noMac, rateLimited),`fleet.history._`(ranges, metrics, off, empty, summary),`fleet.fixCommands._`.
- Playwright: `apps/web/e2e/flow-fleet-health.spec.ts` (cards, metric slot states, state
  sentences, producers), `flow-fleet-health-history.spec.ts` (flag on/off, ranges),
  `flow-fleet-wake-refresh.spec.ts` (disabled variants, refresh via harness, wake via harness).

## 9. Agent / MCP / CLI surface

Defined here under the names FL-19's catalogue (plan §9.1) uses, CONTRACTS §11.3 shapes:
`fleet_nodes_health` (`readOnly: true`; `range?` returns history, `fresh: true` runs Refresh now —
a read under R-31), `fleet_nodes_needs_a_look` (`readOnly: true`), `fleet_nodes_wake`
(`destructive: false`, `confirmationClass: 'plain'`); the fleet-wide list rides FL-19's
`fleet_status`. CLI: `ever-works fleet nodes health [--range] [--fresh]`, `ever-works fleet nodes
wake`. All return the same envelopes as the API.

## 10. Background jobs

| Task                  | File                                                           | Trigger          | What                                                                                                       | Idempotency                                                         |
| --------------------- | -------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `fleet-health-rollup` | `packages/tasks/src/tasks/trigger/fleet-health-rollup.task.ts` | cron `7 * * * *` | Roll raw rows of the previous hour into one `hourly` row per node (means); delete raw > 7 d, hourly > 90 d | `ON CONFLICT DO NOTHING` on the unique key; deletes bounded by `at` |

Registered in `packages/tasks/src/tasks/trigger/index.ts` beside `fleet-job-lease-sweeper`; runs
with `TriggerInternalModule` (that task's header warns it fails silently otherwise). Sample writes
are inline from the heartbeat path through `FleetNodeHealthService` (not a job: one row, no retry).

## 11. Security & permissions

- Health is **report-only**: nothing in the snapshot is enforced or written back to the node.
- No hostnames, usernames, addresses or process names cross the wire; the GPU model string is
  bounded (64 chars) and sanitised like `workerStateReason`.
- `macAddress` is stored for the owner's computers only, shown masked (`…:3f:9a`) and never returned
  to a non-owner viewer; `lanId` is a salted hash.
- Reach actions: Wake → `FleetAccessService.assertFamily(node, caller, 'machines')` (FL-01) on the
  target; Refresh now → `assertFamily(node, caller, 'view')` (CONTRACTS §2.1) with no consent beyond
  the open link (R-31); consent checks and kill switch through `FleetLinkService` (FL-02); the
  sibling's own `manage` consent is required for `wake.send`; the node validates the MAC format and
  refuses broadcast to anything but its own interface's network.
- Rate limits: refresh 10/min/node, wake 3 per 5 min/node, enforced in the service and documented
  in the error hint.
- Audit: `node.wake { target, via }`; `node.model-throttle-clear` existing; reads unaudited.

## 12. Observability

- Metrics: `fleet_health_samples_written_total`, `fleet_health_samples_dropped_total{reason}`,
  `fleet_health_probe_ms{fact}` (node log), `fleet_needs_a_look_items{kind}`, `fleet_wake_attempts_total{outcome}`,
  `fleet_health_refresh_ms`.
- Logs: node logs one line per failed sub-probe per hour; API logs one line per dropped sample per
  node per hour.
- Activity log: none (health is telemetry; wake is fleet audit).

## 13. Phased rollout

| Phase | Ships                                                                                                                                                                         | Flag                                      | Green means                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| P1    | Contracts, node probe + heartbeat tier, both migrations (00 table, 01 `health` + wake columns), state function, sentences on cards/header/table, five producers, metric block | none beyond `FLEET_ENABLED` (telemetry)   | Conformance fixture green; cards show real numbers; producers' truth tables green        |
| P2    | Sample writer, roll-up task, history endpoint, chart + sparkline                                                                                                              | `FLEET_HEALTH_HISTORY_ENABLED` (prod off) | Retention test green; chart renders fixtures                                             |
| P3    | Health module verbs, wake and refresh endpoints and buttons (MAC/`lanId` already reported by the P1 heartbeat), tool shapes handed to FL-19                                   | same                                      | Harness: refresh round-trip on a `--work`-only node; wake through a sibling; rate limits |

Note: both migrations ship in P1 because CONTRACTS §13 puts the `health` snapshot column in slot
01 with the wake fields; the table (slot 00) waits for its writer in P2 and the wake columns for P3
— one slot, one PR, nothing re-stamped (program rule 10).

## 14. Test plan

- **Contracts (Vitest)** `packages/contracts/src/fleet/__tests__/fleet-node-health.spec.ts` —
  `resolveComputerState` truth table (status × workerState × modelThrottles × upgradeRequired ×
  staleness) incl. agreement with `runnerRowState`; `diskLowSeverity` at the boundaries (floor,
  floor + 1 GiB, 10%); snapshot bounds (percent 0–100, MiB ≤ 1 EiB).
- **Node (Vitest)** `apps/node/src/core/health-probe.spec.ts` — every sub-probe with a fake runner
  per OS; a hanging runner drops its field in 2 s; MAC/lanId derivation; `apps/node/src/core/heartbeat.spec.ts`
  extend (`health`, `macAddress`, `lanId` in the newest tier, dropped on 400);
  `apps/node/src/core/link/modules/health.spec.ts` — `health.now` answered on a `--work`-only link
  (R-31), `wake.send` (3 packets, MAC validation, refused without `manage`), `wake` tag conditions.
- **Agent (Jest)** `packages/agent/src/fleet/__tests__/fleet.service.health.spec.ts` — snapshot stored
  with receipt time, absent fields never overwrite; `fleet-node-health.service.spec.ts` — 55 s floor,
  flag off writes nothing, write failure logged not thrown; `needs-a-look.producers.spec.ts` — each
  producer's condition, severity, action, stable id; `helper-untrusted` silent without the field.
- **API (Jest)** `apps/api/src/fleet/fleet-health.controller.spec.ts` — GET shapes; POST refresh
  allowed for a `view`-audience member on a `--work`-only node; refresh codes (`unreachable`,
  `consent_missing` for an enrol-only node, `kill_switch`, 11th → `limit_exceeded`; a stranger 404s);
  history ranges and `{ disabled }`; wake preconditions and the 4th attempt;
  `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts` extend fixture with `health`.
- **Tasks (Jest)** `packages/tasks/src/__tests__/fleet-health-rollup.task.spec.ts` — roll-up means into `hourly` rows,
  idempotent re-run, retention boundaries at ±1 min.
- **Web unit (Vitest)** `computer-state.shared.unit.spec.ts`, `HealthMetrics.unit.spec.tsx` (six
  cards, "—", stale, footprint line), `HealthHistoryChart.unit.spec.tsx` (gaps, off, empty, summary
  text), `WakePanel.unit.spec.tsx` (every disabled reason), `ComputerCards.unit.spec.tsx` extend
  (cells + sparkline).
- **Playwright** §8.

## 15. Risks

| Risk                                                                    | Likelihood | Impact | Mitigation                                                                                           |
| ----------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------- |
| A slow probe (e.g. `nvidia-smi` on a sleeping GPU) delays the heartbeat | Medium     | High   | 2 s per sub-probe, probes run in parallel, result cached for the beat; probe runs off the beat timer |
| Sample table grows faster than expected                                 | Medium     | Medium | 55 s floor; roll-up hourly; metrics on rows written; footprint sentence keeps it honest              |
| State function disagrees with the runner pill                           | Medium     | Medium | Shared test asserting agreement with `runnerRowState` for every status                               |
| Wake packets leave the owner's network                                  | Low        | High   | Node sends only to its own interface's broadcast and the limited broadcast; MAC validated            |
| `lanId` collisions across owners                                        | Low        | Low    | Salted with owner id; siblings are matched within one owner only                                     |
| Windows pending-reboot registry read needs rights the service lacks     | Medium     | Low    | Field absent on failure; never blocks                                                                |

## 16. Constitution reconciliation

- **I / II** — no external integration or provider.
- **III** — telemetry only.
- **IV** — roll-up and retention run as a task on the configured job runtime via the trigger
  registry; sample writes are single inline inserts.
- **V** — two additive migrations.
- **VI** — tests per package in §14.
- **VII** — no secrets; addresses hashed/masked; probe output never logged verbatim.
- **VIII** — no plugin.
- **IX** — spec behaviour-only.
- **X** — optional fields; existing routes and columns untouched.

## 17. References

- Spec [`./spec.md`](./spec.md) · Tasks [`./tasks.md`](./tasks.md)
- [CONTRACTS](../CONTRACTS.md) §1.2, §3.3, §4.1, §4.5, §4.6, §7, §8, §9, §10, §11.2, §13 · [README](../README.md) D2, D8, rule 18
- FL-01 plan (registry, producers), FL-02 plan (`machine` channel, module registry)
- `docs/features/fleet.md` §"Health signals", §"Model usage limits", §"Remote node limits"
