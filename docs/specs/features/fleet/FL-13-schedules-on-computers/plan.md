# FL-13 — Schedules on computers · Implementation plan

> How [`spec.md`](./spec.md) gets built. Implementation detail belongs here, not in the spec
> (Constitution IX). Every path below was opened at this branch's base (`origin/develop`
> `e4334baf7`) before it was cited.

**Epic ID:** `FL-13-schedules-on-computers`
**Spec:** [`./spec.md`](./spec.md) · **Tasks:** [`./tasks.md`](./tasks.md)
**Status:** `Draft`
**Created:** 2026-10-18
**Last updated:** 2026-10-18

---

## 1. Architecture summary

```mermaid
flowchart LR
    subgraph Web
        CT[Computer › Schedules tab]
        AS[Activity › Schedules]
        HC[Hub › Commands › Schedule this…]
    end
    CT & AS & HC -->|POST/PATCH /api/fleet/commands (cadence)| API[FleetCommandsController]
    AS -->|GET /api/schedules*| SC[SchedulesController]
    API --> CS[FleetCommandService + FleetScheduleService]
    CS -->|fleet_commands.cadence| DB[(Postgres)]
    SC --> SV[SchedulesService: node_schedule source]
    SV --> DB
    CS -->|schedule.sync {definitions}| RL[Node link relay (FL-02)]
    RL --> NS[Node: schedules module]
    NS -->|schedules/<id>.json| FS[(node config dir)]
    NS -->|timer loop → link/modules/command/command-runner.ts (FL-12)| OS[login shell]
    NS -->|schedule.runs {since} on link open / every 5 min| RL
    RL -->|head/tail, exit, scheduledFor| CS
    CS -->|fleet_command_runs| DB
    CS -->|node.schedule.* · node.command.run| AU[(fleet_audit)]
    CS -->|schedule-failed| NL[NeedsALookProducer (FL-01)]
    subgraph Agent-session schedules
        RT[task-recurrence-dispatcher task] -->|Task instance + Run| RR[FleetRunRouter]
        RR -->|agent-session job (FL-04), targetNodeId from affinity| NODE2[Node: session daemon]
    end
```

Two clocks, deliberately: Command schedules tick **on the machine**; Agent-session schedules tick
**on the platform** (they must create a Task instance and a Run) and are placed on the machine by
the existing router.

## 2. Current state in the codebase

| Piece                                              | Where (verified at HEAD)                                                                                                                                                                                                    | Reused as                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Unified schedule read model, seven sources         | `packages/agent/src/schedules/schedule-view.types.ts:17-24` (`ScheduleSourceType`), `:44-104` (`ScheduleView`), `:115-126` (health reasons, repair classes)                                                                 | `node_schedule` member; three new health reasons                                                                     |
| Source list and projection                         | `packages/agent/src/schedules/schedules.service.ts:85-93` (`SOURCE_TYPES`), `:59` (`MAX_PER_SOURCE`), `:106-116` (`ProjectedRow`/`Collected`)                                                                               | One more collector reading `fleet_commands WHERE cadence IS NOT NULL`                                                |
| Row controls                                       | `packages/agent/src/schedules/schedule-controls.ts:39` (`buildScheduleControls`); control service `schedule-control.service.ts:78-96` (`SOURCE_TYPES`, `parseScheduleId`), `:104-110` (delegation posture)                  | New branch delegating to `FleetScheduleService`                                                                      |
| Health and repair                                  | `packages/agent/src/schedules/schedule-health.service.ts:36` (`ScheduleCadenceKind`), `:153` (`evaluateScheduleHealth`), `:240` (`proposeScheduleRepair`)                                                                   | New cadence kind `node-cadence`, new reasons                                                                         |
| Cadence describers                                 | `packages/agent/src/schedules/cadence.ts:27,83,121,126,171` (`describeCron`, `describeRrule`, `describeEventDriven`, `describeIntervalMinutes`, `computeNextCronFire`)                                                      | Reused for cron and interval forms; a zone-aware next-fire helper is added to contracts                              |
| Schedules API                                      | `apps/api/src/schedules/schedules.controller.ts:50-59` (`api/schedules`, optional `ScheduleControlService`), `:61` list; `page`, `health`, `run-now`, `pause`, `resume`                                                     | Unchanged routes serve the new source; `disable-all` gains a scope                                                   |
| Schedules web                                      | `apps/web/src/components/schedules/` — `SchedulesWorkspace.tsx`, `ScheduleSourceChips.tsx`, `ScheduleRowMenu.tsx`, `ScheduleHealthBadge.tsx`, `ScheduleHealthBanner.tsx`, `SchedulesCreateMenu.tsx`, `SchedulesFilters.tsx` | Extended, never duplicated                                                                                           |
| AW-10 breaker, repair, editor components (planned) | AW-10 plan §5 table (`DisableAllDialog.tsx`, `BreakerUndoBanner.tsx`, `FixAllDialog.tsx`, `CadencePicker.tsx`, `ScheduleEditorDialog.tsx`), `POST /api/schedules/disable-all` (AW-10 plan §4.6)                             | Breaker scope `node`; cadence picker reused inside the new dialog                                                    |
| Recurring Tasks                                    | `packages/agent/src/entities/task.entity.ts:596-606` (`isRecurring`, `recurrenceRule` XOR cron), `:24-25` (dispatcher clones instances); `packages/tasks/src/tasks/trigger/task-recurrence-dispatcher.task.ts`              | Agent-session schedules are recurring Tasks                                                                          |
| Agent ↔ Node affinity (Organization-scoped)        | `packages/agent/src/fleet/fleet-agent-node-affinity.service.ts:22-25, 39-50`                                                                                                                                                | "Pinned to a computer" = affinity; dialog lists pinned Agents only                                                   |
| Commands, runs, runner, output store               | FL-12 plan §4–§6 (`fleet_commands` with `cadence`, `name`, `enabled`, `lastRunAt`, `nextRunAt`; `apps/node/src/core/link/modules/command/command-runner.ts`)                                                                | The body of every Command schedule                                                                                   |
| Node config dir and owner-only files               | `apps/node/src/core/config-store.ts:39-45`                                                                                                                                                                                  | `<configDir>/schedules/`                                                                                             |
| Node runtime registrations; link module registry   | `apps/node/src/core/runtime.ts:739,749,947,1062` (executors); FL-02 `apps/node/src/core/link/modules/index.ts` (CONTRACTS R-40); shared resolver `apps/node/src/core/link/allowed-roots.ts` (R-39)                          | The `schedule` module registers there and starts its loop with `--manage`; `cwd` is checked with the shared resolver |
| Zero-dependency time-zone handling in contracts    | `packages/contracts/src/fleet/fleet-model-usage-limit.types.ts:25` (`Intl` only)                                                                                                                                            | Pattern for the shared next-fire helper                                                                              |
| Needs-a-look shape and producer registry           | CONTRACTS §4.6, R-23; FL-01 plan §3 (`NeedsALookProducer` interface, Nest multi-provider token)                                                                                                                             | `schedule-failed` producer                                                                                           |
| Audit action union                                 | `packages/contracts/src/fleet/fleet-panic.types.ts:60-148`                                                                                                                                                                  | Six `node.schedule.*` values                                                                                         |

Missing today: any source that names a machine (`schedules.service.ts:85-93`), any node-side timer
or schedule cache (EXISTING-SUBSTRATE §4), any `schedule-failed` producer, any time-zone
fact about a node (`packages/contracts/src/fleet/fleet-node.types.ts:329-368` has none).

## 3. Tech choices

| Concern                | Choice                                                                                                                                             | Why                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Where definitions live | `fleet_commands` rows with `cadence` (R-2); node cache `<configDir>/schedules/<id>.json`, owner-only                                               | No new table; the machine holds a copy so it can run offline                       |
| Cadence shape          | CONTRACTS §4.4 `{ kind: 'interval'\|'cron'\|'daily'\|'weekdays', expr, at, timezone: 'node' }`; "specific days" → `cron`; "hourly" → `interval 60` | Fixed by contract                                                                  |
| Next-fire computation  | `packages/contracts/src/fleet/fleet-schedule-cadence.ts` (new, pure, `Intl.DateTimeFormat` only) shared by API, node and web                       | One algorithm, three consumers; no `cron-parser` on the node (bundle size, parity) |
| Node timer             | Single `setTimeout` to the earliest next fire (re-armed after each fire/sync), not a 1 s tick                                                      | Low wake-ups on laptops; drift-free (recomputed from the wall clock)               |
| Missed-run policy      | `lastFireAt` persisted per schedule in the cache; on start, fires due since then within the fixed 60-min grace collapse to one run                 | Spec FR-16; CONTRACTS §6                                                           |
| Storage                | New columns `simple-json` text / `varchar` enums validated in code (CONTRACTS §4 storage types)                                                    | One migration for SQLite (CI, e2e) and Postgres                                    |
| Run execution          | FL-12 `link/modules/command/command-runner.ts` with `timeoutSec = 21600` and a per-schedule mutex                                                  | Reuse; one process model                                                           |
| History on the node    | `<configDir>/schedules/<id>/runs.jsonl` (index) + `<id>/<runId>.log` (output), ring of 30                                                          | Same ring pattern as FL-12 output store                                            |
| Reconciliation         | `schedule.runs { since }` returns runs newer than the platform's watermark; idempotent by `runId`                                                  | Link may drop; platform may lag                                                    |
| Agent-session fires    | Existing recurring-Task dispatcher → `FleetRunRouter` → FL-04 `agent-session` job with `targetNodeId` from affinity                                | No second scheduler (README §3 refusal)                                            |
| Breaker scope          | AW-10 `disable-all` body gains `scope: 'node', nodeId`                                                                                             | Additive                                                                           |
| i18n                   | `fleet.schedules.*`; the view's shared strings stay under `dashboard.schedules.*` (`apps/web/messages/en.json:3911`)                               | CONTRACTS §11.4; no duplication of existing keys                                   |

## 4. Data model

### 4.1 Columns (additive) — `packages/agent/src/entities/`

CONTRACTS §4.4 already gives `fleet_commands` its cadence fields (`cadence`, `name`, `enabled`,
`lastRunAt`, `nextRunAt`, created by FL-12's table). The grace (60 min) and the failure pause
(five in a row) are fixed by CONTRACTS §6, so they are constants, not columns; the computer's time
zone is `FleetNode.timeZone`, not a per-schedule copy; the failure streak and the last run's
status are read from `fleet_command_runs` (index `(commandId, startedAt)`).

**Proposed CONTRACTS §4.4 additions** (spec §8b; the implementing PR amends CONTRACTS):
`fleet-command.entity.ts` gains `pausedAt` (date, null), `pausedReason varchar(24)?` (`user ·
failure-streak · breaker`, validated in code), `syncGeneration int default 0`, `syncedGeneration int
default 0` (what the node acknowledged) and `deletedAt` (date, null; soft delete keeps history 30
days, U13); `fleet-command-run.entity.ts` gains `scheduledFor` (date, null — the fire a run belongs
to; null for Run now). Status values `skipped-overlap`, `skipped-offline` are already in the
FL-12 union (CONTRACTS §4.4).

`fleet-node.entity.ts` gains `timeZone varchar(64)?` (CONTRACTS §4.1), reported in the heartbeat
`FleetNodeSelfDescription` (CONTRACTS §1.1).

### 4.2 Migrations

| Slot                                                              | Contents                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/migrations/1796130000000-AddFleetCommandCadence.ts` | The §4.1 columns on `fleet_commands` and `fleet_command_runs`; index `idx_fleet_commands_schedule (userId, enabled) WHERE cadence IS NOT NULL` and `idx_fleet_command_runs_scheduled (commandId, scheduledFor)` |
| `apps/api/src/migrations/1796130100000-AddFleetNodeTimeZone.ts`   | `fleet_nodes.timeZone`                                                                                                                                                                                          |

Additive, forward-only; `down` drops exactly what `up` added.

### 4.3 Contracts

- `packages/contracts/src/fleet/fleet-schedule-cadence.ts` (new): `FleetScheduleCadence` type,
  `nextFire(cadence, zone, after)`, `describeCadence(cadence, locale)`, `isValidCadence`,
  `FLEET_SCHEDULE_RUN_CAP_SEC = 21600`, `FLEET_SCHEDULE_HISTORY = 30`, `FLEET_SCHEDULES_PER_NODE = 50`
  (CONTRACTS §10), `FLEET_SCHEDULE_MISSED_GRACE_SEC = 3600`, `FLEET_SCHEDULE_FAILURE_PAUSE = 5`
  (CONTRACTS §6).
- `fleet-commands.types.ts` (FL-12): link messages `schedule.sync { generation, definitions:
FleetScheduleDefinition[] }` answered `{ requestId, result: { generation, held: string[] } }`
  (`generation` proposed, spec §8b), `schedule.runs { since }` → `{ runs: FleetScheduleRunReport[] }`,
  `schedule.runNow { id }` — exactly CONTRACTS §3.3's three verbs; pause, resume, edits and deletes
  re-send the full set through `schedule.sync`.
- `fleet-node.types.ts`: optional `timeZone` on `FleetNodeSelfDescription` and `FleetNodeView`.
- `fleet-panic.types.ts`: `node.schedule.create|update|delete|run|pause|resume`.
- `packages/agent/src/schedules/schedule-view.types.ts`: `'node_schedule'` in `ScheduleSourceType`;
  `nodeId?`, `nodeName?`, `nodeTimeZone?`, `nextRunAtNodeLocal?` optional on `ScheduleView`;
  reasons `consent-missing · node-removed · node-unsupported`; control reason keys `nodeOffline`, `consentMissing`.

## 5. API surface

Run now, Pause and Resume go through the **existing** Schedules routes with a `node_schedule:<id>`
id (the schedule-control service delegates to `FleetScheduleService`), so there is one control
path for every source; the computer tab lists through the existing `GET /api/schedules?node=<id>`.
Confirmations follow CONTRACTS §2.2 (`confirm: true`; without it `409 confirmation_required`).

| Method | Path                                                                               | DTO / shape                                                                                                                                    | Auth / family                        | Rate   | Errors                                                                                                               |
| ------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/fleet/commands` (FL-12) with `cadence`, `name`                               | `RunCommandDto` + `cadence`, `name`, `confirm` → `201 FleetCommandView`                                                                        | `schedules` audience, `manage`       | 20/min | `invalid` (cadence), `permission_denied`, `kill_switch`, `confirmation_required`, `limit_exceeded` (50 per computer) |
| PATCH  | `/api/fleet/commands/:id`                                                          | `UpdateScheduleDto` (any field but kind; `nodeId` = move, needs `confirm`)                                                                     | same                                 | 20/min | `not_found`, `invalid`, `permission_denied`, `limit_exceeded` (move to a full computer)                              |
| DELETE | `/api/fleet/commands/:id`                                                          | `{ confirm: true }` → `204` (soft: `deletedAt`)                                                                                                | same, `confirm`                      | 20/min | `not_found`, `confirmation_required`                                                                                 |
| GET    | `/api/fleet/commands/:id/runs?limit=30`                                            | → `FleetCommandRunView[]` incl. `scheduledFor`, skip reasons                                                                                   | audience                             | 60/min | `not_found`                                                                                                          |
| POST   | `/api/fleet/nodes/:id/schedules/agent-session` (proposed §11.2 addition, spec §8b) | `CreateAgentSessionScheduleDto { name, agentId, prompt, checkoutId?, cadence, confirm }` → `201 ScheduleView`                                  | `schedules` audience, `work` consent | 20/min | `invalid` (Agent not pinned → hint), `permission_denied`, `limit_exceeded`                                           |
| GET    | `/api/schedules*` (existing)                                                       | now include `node_schedule` rows; `?node=<id>` filter on the list and `/page` (both kinds for one computer)                                    | existing                             | —      | —                                                                                                                    |
| POST   | `/api/schedules/:id/run-now\|pause\|resume` (existing)                             | `node_schedule:<id>` delegates to the fleet service; run-now gains an optional `confirm` body field (FR-25; additive, other sources ignore it) | existing                             | —      | `unreachable`, `busy`, `kill_switch`, `consent_missing`, `confirmation_required`                                     |
| POST   | `/api/schedules/disable-all` (AW-10)                                               | body gains `scope: 'node', nodeId`                                                                                                             | existing                             | —      | `SCHEDULE_SCOPE_TOO_LARGE`                                                                                           |

The Rate column is a proposed CONTRACTS §10.1 addition (spec §8b), enforced as written until it
lands.

## 6. Node side

**Module (CONTRACTS R-40):** `apps/node/src/core/link/modules/schedule.ts` — the `schedule`
`NodeModule` (channel handler, `schedules` tag), one entry in `apps/node/src/core/link/modules/index.ts`;
helpers under `apps/node/src/core/link/modules/schedule/`: `schedule-store.ts` (cache
read/write/atomic replace), `schedule-clock.ts` (next-fire, missed-run collapse), `schedule-loop.ts`
(single armed timer, per-schedule mutex, 6 h cap via FL-12's `command-runner.ts`) and
`schedule-history.ts` (ring of 30). The loop is started by `apps/node/src/core/runtime.ts` only with
`--manage` and runs whether or not the link is open (CONTRACTS §6); the module advertises
`schedules` (CONTRACTS §1.2) when the cache dir is writable.

| OS      | Timer     | Service mode (so a closed lid still runs)                                  | P3 native fallback                                                             |
| ------- | --------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Linux   | node loop | `packaging/systemd/ever-works-node@.service` (existing)                    | cron block `# ever-works-node schedules` → `ever-works-node schedule-run <id>` |
| macOS   | node loop | launchd agent (packaging follow-up, FL-02)                                 | LaunchAgent per schedule                                                       |
| Windows | node loop | `packaging/windows/install-service.ps1` (existing, runs as enrolling user) | Task Scheduler folder `\EverWorks\`                                            |

Link protocol (`schedule` family, one channel per link, opened lazily by the platform):

1. On link open the platform sends `schedule.sync { generation, definitions[] }` with **every**
   enabled Command schedule for that node; the node replaces its cache atomically, deletes files
   not in the set, re-arms the loop, and answers the request `{ requestId, result: { generation,
held } }` (`generation` is the proposed field, spec §8b).
2. Any create/update/pause/resume/delete bumps `syncGeneration` and re-sends the full set
   (sets are small; full replace is idempotent and simple).
3. `schedule.runs { since }` on link open and every 5 min → node returns runs with `runId`,
   `scheduledFor`, `startedAt`, `endedAt`, `exitCode`, `status`, `outputHead`, `outputTail`,
   `truncated`; the platform upserts by `runId`.
4. `schedule.runNow { id }` → node runs immediately (mutex applies → `busy`).
5. The node refuses the channel without `--manage` (`consent_missing`) and refuses definitions
   whose `cwd` fails `isUnderAllowedRoot` (shared resolver `apps/node/src/core/link/allowed-roots.ts`,
   R-39) and is not the owner's home (`invalid`).
6. Kill switch (R-24, CONTRACTS §3.2): on FL-02's `link.pause` the loop stops and in-flight runs
   end `failed` with `failedReason: kill-switch`; `link.resume` re-arms it without replaying fires
   older than the grace; `link.drain` ends in-flight runs with `failedReason: drain`. The last state
   received is persisted in the cache and honoured while the link is down (spec §8b default).

Consents: `manage` (Command schedules); Agent-session fires need `work` (FL-04 job). Environment:
FL-12's allow-listed env. Time zone: the node reports `Intl.DateTimeFormat().resolvedOptions().timeZone`
on every heartbeat.

## 7. Plugin surface

None.

## 8. Web surface

- Computer page tab `schedules` registered in `apps/web/src/components/fleet/registry.ts`
  (FL-01), route `/fleet/computers/[id]?tab=schedules`.
- Components `apps/web/src/components/fleet/schedules/`: `ComputerSchedulesTab.tsx`,
  `NodeScheduleRow.tsx` (wraps `ScheduleWorkspaceRow.tsx` with the two-zone cadence cell),
  `NewNodeScheduleDialog.tsx` (reuses AW-10 `CadencePicker.tsx` when present, else its own
  six-form picker), `ScheduleRunHistory.tsx`, `ScheduleTimeZoneNote.tsx`, `schedules.shared.ts`
  (pure: two-zone formatting, control reasons, breaker count).
- Extensions: `ScheduleSourceChips.tsx` (+ Computer), `SchedulesFilters.tsx` (+ Computer),
  `SchedulesCreateMenu.tsx` (+ On a computer…), `ScheduleRowMenu.tsx` (+ Move, Delete for
  `node_schedule`), `ScheduleHealthBadge.tsx` (new reasons), `DisableAllDialog.tsx` (scope node).
- FL-12 `CommandComposer.tsx` gains **Schedule this…**.
- Server actions in `apps/web/src/app/actions/dashboard/schedules.ts` (`createNodeSchedule`, `updateNodeSchedule`, `deleteNodeSchedule`, `listNodeScheduleRuns`); `apps/web/src/lib/api/schedules.ts` gains the fleet calls.
- i18n: `fleet.schedules.{tab,dialog,cadence,history,health,breaker,errors,unattendedCredentialNote}`.
- Playwright: `apps/web/e2e/flow-fleet-schedules.spec.ts`, `flow-fleet-schedules-agent-session.spec.ts`, `flow-fleet-schedules-contract.spec.ts`.

## 9. Agent / MCP / CLI surface

| Surface | Names                                                                                                                                                                                                 | Annotation                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent   | `fleet_schedules_list`, `fleet_schedules_get`, `fleet_schedules_runs`                                                                                                                                 | `readOnly: true`                                                                                                                                                   |
| Agent   | `fleet_schedules_create`, `fleet_schedules_update`, `fleet_schedules_delete`, `fleet_schedules_run`                                                                                                   | `destructive: true`, `confirmationClass: confirm`; AW-24 `agent.fanout` for create/update, `write.destructive` for delete, `machine.run` for run (FL-19 catalogue) |
| Agent   | `fleet_schedules_pause`, `fleet_schedules_resume`                                                                                                                                                     | `destructive: false`, `confirmationClass: plain`, AW-24 `agent.fanout`                                                                                             |
| MCP     | the same nine names as the Agent tools (`fleet_schedules_list` … `fleet_schedules_resume`, CONTRACTS §11.3)                                                                                           | `readOnlyHint` / `destructiveHint` in `apps/mcp/src/openapi-tools/whitelist.ts`                                                                                    |
| CLI     | `ever-works fleet schedules create\|list\|get\|update\|run\|pause\|resume\|runs\|delete` with `--on`, `--every`, `--at`, `--days`, `--cron`, `--command`, `--agent`, `--prompt`, `--folder`, `--json` | exit `0/1/2`; `apps/cli/src/commands/fleet/schedule.ts`                                                                                                            |

## 10. Background jobs

| Task (job-runtime provider, `*_DISPATCHER`) | File                                                                  | When        | Does                                                                                                                                                                                              | Idempotency                           |
| ------------------------------------------- | --------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `fleet-schedule-reconciler`                 | `packages/tasks/src/tasks/trigger/fleet-schedule-reconciler.task.ts`  | every 5 min | For every linked node with schedules: `schedule.runs { since }`; upsert runs; read the streak from the last five runs; raise/clear `schedule-failed`; apply the five-failure pause (CONTRACTS §6) | upsert by `runId`; watermark per node |
| `task-recurrence-dispatcher` (existing)     | `packages/tasks/src/tasks/trigger/task-recurrence-dispatcher.task.ts` | existing    | Fires pinned recurring Tasks; the router places the Run on the pinned node as an `agent-session` job                                                                                              | existing                              |
| `fleet-schedule-missed-sweeper`             | same reconciler                                                       | every 5 min | Cancels Agent-session fires whose job aged out past the grace (the Run and its Task instance, reason "offline past the grace window"); the history shows them as skipped — offline                | by Task instance id                   |

## 11. Security & permissions

- Who: `schedules` family audience per computer (default owner); Organization roles from FL-01.
- Consent: `manage` for Command schedules; `work` for Agent-session fires; refused with the consent named.
- The node refuses: sync without `--manage`; `cwd` outside allowed roots (R-39 resolver); a definition over 8 KiB (proposed limit, spec §8b); more than one run per schedule; a run past 6 h.
- Credentials: none stored (D6). The FR-26 sentence is the user-visible statement; the plan adds a doc note that the node's own scrubber strips the provider API-key variables the two CLIs read (the existing protected-value list in `apps/node/src/core/executors/model-transcript.ts:44-51`) from reported output.
- Redaction: definitions, output and audit pass `redactSecrets`; field names avoid the audit redaction key words.
- Audit: `node.schedule.*` rows `{ family: 'schedules', target, requestedBy, confirmationClass, outcome, before, after }`; reconciled runs write `node.command.run` with `requestedBy: schedule:<commandId>`.
- Kill switch / drain: R-24 — loop stops, runs end; Agent-session fires are Runs and end as Runs do.

## 12. Observability

- Metrics: `fleet_schedule_fires_total{status}`, `fleet_schedule_skipped_total{reason}`, `fleet_schedule_sync_lag_seconds`, `fleet_schedule_failure_streak_pauses_total`, `fleet_schedule_reconcile_runs_total`.
- Activity log: `schedule_created|updated|paused|resumed|deleted` with `sourceType: node_schedule`, `origin` (`row · bulk · breaker · failure-streak`), reusing AW-10's event names.
- Needs-a-look: `schedule-failed` items; Inbox notices on streak pause.

## 13. Phased rollout

| Phase | Flag                     | Contents                                                                                                                                                                                |
| ----- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | `FLEET_COMMANDS_ENABLED` | Migration, contracts, `node_schedule` source, fleet schedule service, routes, node module (cache, loop, history, channel), computer tab, Activity rows, reconciler, producer, CLI       |
| P2    | same                     | Agent-session schedules (route, dialog variant, FR-26 note, affinity check), cost on rows (FL-20 feed), new NEVER RUNS reasons + repairs, breaker scope node, Agent tools + MCP entries |
| P3    | same                     | Native-scheduler fallback per OS (`ever-works-node schedule-run <id>`); editors for missed-run grace and failure threshold only once CONTRACTS §6 makes them per schedule (spec §8b)    |

## 14. Test plan

| Package              | Runner     | Specs                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts` | Vitest     | `src/fleet/__tests__/fleet-schedule-cadence.spec.ts` — every cadence form across DST boundaries in three zones; invalid inputs; `describeCadence`                                                                                                                                                                                                                                       |
| `packages/agent`     | Jest       | `src/schedules/__tests__/schedules.service.node-schedule.spec.ts` (projection, thirteen fields, counts); `schedule-health.spec.ts` extended (three reasons); `schedule-controls.spec.ts` extended; `src/fleet/__tests__/fleet-schedule.service.spec.ts` (sync generation, pause/resume, streak, producer, move, delete)                                                                 |
| `apps/api`           | Jest       | `src/fleet/fleet-commands.controller.schedules.spec.ts` (every code+hint; offline save; busy); `src/schedules/schedules.controller.spec.ts` extended (`node_schedule:` ids, `?node=`); breaker scope spec                                                                                                                                                                               |
| `apps/node`          | Vitest     | `src/core/link/modules/schedule/schedule-store.spec.ts` (atomic replace, owner-only); `schedule-clock.spec.ts` (next fire, missed collapse, grace edges); `schedule-loop.spec.ts` (mutex → overlap skip, 6 h cap, `link.pause` / `link.resume`, re-arm after sync); `schedule-history.spec.ts` (ring of 30); `src/core/link/modules/schedule.spec.ts` (refusals, reconcile idempotency) |
| `packages/tasks`     | Jest       | `src/__tests__/fleet-schedule-reconciler.task.spec.ts` — upsert, streak, producer raise/clear, missed sweeper                                                                                                                                                                                                                                                                           |
| `apps/cli`           | Vitest     | `src/commands/fleet/__tests__/schedule.spec.ts`                                                                                                                                                                                                                                                                                                                                         |
| `apps/web`           | Vitest     | `components/fleet/schedules/schedules.shared.unit.spec.ts` (two-zone text, reasons); `NewNodeScheduleDialog.unit.spec.tsx` (FR-26 sentence verbatim; unpinned Agent disabled)                                                                                                                                                                                                           |
| `apps/web`           | Playwright | `e2e/flow-fleet-schedules.spec.ts`; `e2e/flow-fleet-schedules-agent-session.spec.ts`; `e2e/flow-fleet-schedules-contract.spec.ts`                                                                                                                                                                                                                                                       |

## 15. Risks

| Risk                                                                        | Likelihood | Impact | Mitigation                                                                                                                      |
| --------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Two clocks drift (platform shows a next fire the node computed differently) | Medium     | Low    | One shared pure algorithm in contracts; node reports its computed next fire in its `schedule.sync` answer and the UI prefers it |
| DST edge cases                                                              | High       | Medium | Property tests across DST transitions; "02:30 on a spring-forward day" fires at the next valid minute, documented               |
| Laptop asleep → catch-up storms                                             | Medium     | Medium | Collapse to one run; grace window; failure streak                                                                               |
| Agent affinity semantics surprise users (pins the whole Agent)              | High       | Medium | Dialog never pins as a side effect; CONTRACTS R-29 keeps affinity as the only pin, so the dialog says what pinning means        |
| FL-04 `agent-session` job lands late                                        | Medium     | High   | P2 gated; P1 ships Command schedules alone                                                                                      |

## 16. Constitution reconciliation

I n/a · II n/a · III metadata only · IV reconciler and recurring fires run as job-runtime tasks; the node loop is machine-side by contract · V two slot migrations (`1796130000000`, `1796130100000`) · VI tests per package · VII D6, redaction · VIII n/a · IX spec code-free · X additive unions and optional fields.

## 17. References

Spec `./spec.md` · Tasks `./tasks.md` · CONTRACTS R-29, R-39, R-40, §1.1, §3.2, §3.3, §4.1, §4.4, §6, §7, §8, §10, §12, §13 · FL-12 plan · FL-04 plan (`agent-session` job) · FL-01 plan (registry, `NeedsALookProducer`, roles) · AW-10 plan §4.6, §5 · `docs/specs/features/schedules/spec.md`
