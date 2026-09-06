# Feature O — Fleet / local-runner polish

Branch `session/feat-fleet`, based on `origin/develop`.

Brings the existing Fleet (user-enrolled machines leasing agent jobs) up to the
local-runner UX bar: an always-visible runner indicator, richer node telemetry,
a real local-vs-cloud routing preference, and a notice when a run that asked to
be local ends up in the cloud.

---

## Where the brief and the code disagreed

The brief was written before this area had been explored. Three of its
assumptions did not survive contact with the code, and the code won:

1. **"busy state" needs adding to the heartbeat.** It does not. Busy is already
   derived at the API edge from `FleetJobService.loadByNodeForUser`
   (`FleetNodeLoadView`), which counts live job claims. Putting it on the
   heartbeat would have been a second, laggier source of truth: a node that
   finishes a job would have to wait for its next beat to look idle again. The
   runner status projection therefore _derives_ `busy` and deliberately keeps it
   out of `FleetNodeStatus` — see the note on `FleetRunnerNodeView.busy`.

2. **"daemon version" is missing.** It already exists as `fleet_nodes.version`.
   What was genuinely missing is the AGENT-CLI version — the binary an
   `agent-task` step shells out to. The two are now distinct: `version` /
   `daemonVersion` on the wire, and the new `cliVersion`. Only `cliVersion` and
   `diskFreeBytes` are new columns.

3. **`queuedReason='waiting-for-runner'` on the run.** `agent_runs.queuedReason`
   exists, but it is owned by `RunDispatchGateService`, whose drain path
   (`drainForWork`) only promotes rows stamped `concurrency-limit`. Stamping a
   fleet reason there would have created a parked run nothing drains. The reason
   went onto **`fleet_jobs.queuedReason`** instead, where the lease CAS — which
   already writes the row — is the exact moment it stops being true. No second
   writer has to remember to clear it.

One pre-existing bug was fixed in passing: `FLEET_NODE_STATUSES` omitted
`paused`, a fully-supported status, so anything iterating that "canonical" list
skipped a real state.

---

## What shipped

### 1. Node telemetry (additive, backward-compatible)

| Column                      | Type          | Meaning                                       |
| --------------------------- | ------------- | --------------------------------------------- |
| `fleet_nodes.cliVersion`    | `varchar(64)` | Agent CLI on the machine, e.g. `claude 1.4.2` |
| `fleet_nodes.diskFreeBytes` | `bigint`      | Free bytes on the node's workspace volume     |

The compatibility contract is **asymmetric on purpose**:

- **enroll** writes the fields (the row is new; there is nothing to preserve);
- **heartbeat** writes them only when PRESENT. An absent field means "leave the
  stored value alone", which is what lets a daemon built before these fields
  existed keep beating without wiping a reading a newer build left behind.

Nonsense values are **refused, not clamped** (`sanitizeByteCount`): a clamped
figure is a believable number an operator would act on. `bigint` comes back as a
string on Postgres and a number on sqlite, so `FleetService.toView` is the one
place that normalizes it.

Node side (`apps/node/src/core/telemetry-probe.ts`), re-run on every beat:

- `detectAgentCliVersion` — ordered candidates `claude, codex, gemini, opencode`;
  reports the first that answers `--version`, keeping only the dotted-numeric
  token.
- `detectDiskFreeBytes` — via an injected probe; the real one
  (`createDiskProbe` in `node-io.ts`) uses `fs.statfs` and `bavail`, not `bfree`,
  so reserved blocks are not reported as usable headroom.

Both are optional and never fatal — a missing tool costs one field, never the
heartbeat. A null probe result **omits** the field rather than sending an
explicit null, which is what makes the "leave alone" rule work.

### 2. Runner status widget

`GET /api/fleet/runner-status` → `FleetRunnerStatusView`
(`total / online / busy / offline / drained / refreshIntervalSec /
loadUnavailable / nodes[]`).

`FleetRunnerStatusService` is the **single composer** behind both this endpoint
and the router's availability check, so the pill and the routing decision cannot
disagree about the same machines. It uses `listEnrolledForUser` (no cluster
merge): `k8s` nodes are not runners the platform leases onto, and merging them
would cost a Kubernetes round-trip on a path polled every 30s.

Web: `RunnerStatusPill` in the sidebar footer, `useRunnerStatusPolling` for the
cadence (taken from the payload, not a constant, so the caption cannot drift).
Renders nothing until the account has ≥1 enrolled node.

### 3. Execution routing preference

New table `fleet_execution_preferences` — one row per `(owner, scope)`, scope
being `user` (account-wide, `scopeId IS NULL`), `work` or `goal`.

| Mode                       | Behaviour when no runner is free                                              |
| -------------------------- | ----------------------------------------------------------------------------- |
| `local-wait`               | Enqueued on the fleet anyway, stamped `waiting-for-runner`. Never falls back. |
| `local-fallback` (default) | Runs in the cloud **and notifies**.                                           |
| `cloud`                    | Always the platform runtime; never notifies (the owner chose it).             |

Resolution is narrowest-wins (Work → Goal → account → default) and lives in
`resolveFleetExecutionMode` in `@ever-works/contracts` as a **pure function**, so
the router, the settings UI and the tests share one rule. The routing decision
itself is likewise pure (`decideFleetRouting`).

Precedence, in order — this matters:

1. `shouldDispatchToFleet` (runtime selector + `FLEET_NODE_RUNTIME_ENABLED`).
   A `no` here is final. No preference row opts a tenant INTO the fleet, and none
   outranks an operator draining it.
2. Only then the preference + availability.

`FleetTaskScopeResolverService` turns the dispatched `taskId` into `(workId,
goalId)`. It is provided by the api-side `TasksModule` rather than
`FleetApiModule`, because it needs `TaskRepository` — the same split
`SubAgentDelegationDepthResolverService` already uses.

### 4. Fallback notice

`NotificationService.notifyFleetRunnerFallback`, event key
`fleet_runner_fallback`, seeded by both the migration (Postgres) and
`NotificationEventTypeBootstrap` (SQLite/CI). Deduped per `(task, reason)`: a
Task retried in a loop while a laptop is closed produces one entry, but "busy"
becoming "offline" gets through, because that is news.

Best-effort by contract — a notification outage cannot turn a successful
fallback into a failed dispatch.

### 5. Eligibility-aware routing + queue SLA (self-build slice S, EW-775)

**The defect.** `decideFleetRouting` judged a FLEET-WIDE `{ total, online,
free }` while `FleetJobService.enqueue` pinned an `agent-task` to ONE node (the
Agent affinity) and stamped capability tags the lease scan filters on. An Agent
pinned to a closed laptop with five idle siblings made `free > 0`, the decision
was `fleet`, `local-fallback` never fired, and the row sat `queued` forever with
`queuedReason` null and no notice. Nothing bounded a queued row's age either —
reclaim only scans ACTIVE statuses.

**Routing over the eligible set.** `FleetRunRouterService.routeAgentTask` now
asks, BEFORE the job exists, the same two questions the enqueue path asks:

- the affinity, through `FleetJobService.resolveAgentTaskTarget` (the same
  method enqueue uses, so the two cannot disagree; a lookup that throws is
  judged "unpinned" and logged);
- the required tags, through the planner's new settings-only `requirements()`
  (`agentTaskRequiredCapabilities(provider)` in
  `fleet-agent-task-capabilities.ts` — ONE definition shared with
  `enqueueAgentTask`, so the row can never demand a tag the router did not count
  against). The plan itself is still built AFTER the decision.

`FleetRunnerStatusService.availability(userId, { targetNodeId,
requiredCapabilities })` counts only nodes the lease scan would accept and adds
`fleetTotal` + `pinnedNodeId`. Without a filter the result is the legacy
three-field shape. `decideFleetRouting` gains two reasons —
`no-eligible-runners` (fleet non-empty, eligible set empty: pinned node
unenrolled, or no node advertises the tags) and `pinned-runner-offline` — and
echoes `fleetRunnerCount` / `pinnedNodeId` on a fallback decision only when the
snapshot carried them. `FLEET_FALLBACK_REASONS` is the canonical list.

**Precise `runnerCount`** (follow-up 4, closed): the notice's `runnerCount` is
now the ELIGIBLE count, with `fleetRunnerCount` and `pinnedNodeId` alongside it
in `metadata`; the copy explains both new reasons. Dedup key unchanged.

**Queue SLA.** New `fleet_jobs.queuedAt` (when the row last ENTERED `queued`:
enqueue, reclaim, drain release; NOT reset by promotion) and
`FleetJobService.expireQueued(userId?)`: per kind, rows older than
`config.fleetNode.getQueuedMaxAgeSeconds(kind)` are failed through a CAS pinned
to `queued` + the observed `queuedAt` + not-cancelled (a claim / reclaim / cancel
that lands first wins, no event), with `error` =
`queued-max-age-exceeded: …` (`FLEET_JOB_QUEUE_EXPIRED_REASON`,
`isQueueExpiredError`) and ONE `fleet.job.completed` (source `queue-expired`).
The reconciler marks the run failed with that reason and files exactly one Inbox
notice titled **Fleet run never started: <task>** (body: how long it waited, the
pin, the tags, the three fixes). Rows with `queuedAt IS NULL` (written before the
column existed) are never touched. Runs inline on every lease poll (owner-scoped,
best-effort) and on the `fleet-job-lease-sweeper` cron (global — the only path
that reaches an owner whose every runner is offline).

| Env                                                  | Default                                              |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `FLEET_NODE_QUEUE_MAX_AGE_SECONDS`                   | per kind: `agent-task` 86400 (24h), checks 7200 (2h) |
| `FLEET_NODE_QUEUE_MAX_AGE_SECONDS_AGENT_TASK`        | overrides the above for that kind                    |
| `FLEET_NODE_QUEUE_MAX_AGE_SECONDS_ACCEPTANCE_CHECKS` | idem                                                 |
| `FLEET_NODE_QUEUE_MAX_AGE_SECONDS_BROWSER_CHECK`     | idem                                                 |

Clamped to `[60s, 7d]` by `clampQueuedMaxAgeSec`; unset / nonsense is the kind
default. **Deliberately not disableable** — this changes the documented
`local-wait` guarantee from "waits forever" to "waits up to the bound, then the
run FAILS (never falls back)". A tenant that wants longer raises the variable up
to the 7-day ceiling. The AgentRun sweeper's queued-too-long ESCALATION (60 min)
still fires first; the fleet SLA files the terminal NOTICE later — two Inbox
artefacts over one stuck run, by design.

**Promotion on heartbeat** (follow-up 3, closed): after a beat that leaves the
node `online`, `FleetController.heartbeat` calls
`FleetJobService.promoteWaitingForNode(nodeId)`, which re-reads the node row and
clears `waiting-for-runner` on the owner's queued rows this node could lease
(unbound or pinned to it, every tag advertised) — only when the node holds no
claim (a busy runner cannot take it, so the token stays true). Never throws,
never slows a rejected beat, leaves `queuedAt` alone.

Non-`agent-task` kinds have no run correlation and no notice producer; a queue
expiry on them settles the row (`error`, drawer failure entry) and nothing else.

---

## Data model

```
fleet_nodes                 + cliVersion varchar(64) NULL
                            + diskFreeBytes bigint NULL
fleet_jobs                  + queuedReason varchar(64) NULL
                            + queuedAt timestamp NULL        (slice S; idx_fleet_jobs_queued_at (status, queuedAt);
                                                              backfilled from createdAt for rows queued at upgrade)

fleet_execution_preferences   id uuid pk
                              userId uuid            → FK users ON DELETE CASCADE
                              organizationId uuid NULL
                              scopeType varchar(16)  'user' | 'work' | 'goal'
                              scopeId uuid NULL      NULL for the account row
                              mode varchar(24)       'local-wait' | 'local-fallback' | 'cloud'
                              createdAt / updatedAt
                              idx_fleet_exec_prefs_user   (userId)
                              idx_fleet_exec_prefs_scope  (userId, scopeType, scopeId)
```

`idx_fleet_exec_prefs_scope` is deliberately **not unique**. The account row's
`scopeId` is NULL, and neither Postgres nor sqlite treats NULLs as equal in a
unique index — so a unique index would enforce nothing for exactly the row most
likely to be double-written, while implying that it did. The invariant is held by
`FleetExecutionPreferenceRepository.upsert` (find-then-save), and
`resolveFleetExecutionMode` picks the first match, so even a duplicate resolves
deterministically. No FK on `scopeId`: a preference is advisory, and a row left
behind by a deleted Work simply stops matching.

Migration: `apps/api/src/migrations/1786920000000-FleetRunnerTelemetryAndRouting.ts`
— forward-only, per-step guards, portable DDL (`Table`/`TableIndex`/
`TableForeignKey`), full `down()`. Slice S adds
`1788200000000-AddFleetJobQueuedAt.ts` (same shape, spec on better-sqlite3).

---

## Endpoints

All owner-scoped behind the global auth guard and `FleetEnabledGuard`; the owner
comes from the session and is never accepted from the caller.

| Method   | Path                                                  | Purpose                          |
| -------- | ----------------------------------------------------- | -------------------------------- |
| `GET`    | `/api/fleet/runner-status`                            | Pill payload (throttled 120/min) |
| `GET`    | `/api/fleet/execution-preferences`                    | All configured preference rows   |
| `PUT`    | `/api/fleet/execution-preference`                     | Set one scope's mode             |
| `DELETE` | `/api/fleet/execution-preference?scopeType=&scopeId=` | Clear one scope (idempotent)     |

Existing `POST /api/fleet/enroll` and `POST /api/fleet/heartbeat` accept the two
new optional self-description fields.

## UI routes

- `/settings/fleet` — telemetry columns (Agent CLI, Disk free) + the new
  **Execution routing** section. Route constant added:
  `ROUTES.DASHBOARD_SETTINGS_FLEET`.
- Runner pill — sidebar footer on every dashboard page.

---

## Tests

| Command                                                                                              | Covers                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `cd packages/contracts && npx vitest run src/__tests__/fleet-execution-preference.spec.ts`           | 16 — narrowest-wins resolution, the full `decideFleetRouting` matrix, pill summary   |
| `cd packages/agent && npx jest --testPathPattern='fleet-node-telemetry'`                             | 14 — heartbeat backward-compat (old payload), refuse-not-clamp, bigint normalization |
| `cd packages/agent && npx jest --testPathPattern='fleet-execution-preference'`                       | 14 — scope/id validation, owner scoping, degradation                                 |
| `cd packages/agent && npx jest --testPathPattern='fleet-runner-fallback'`                            | 8 — notification producer, event key, dedup, sanitization                            |
| `cd packages/agent && npx jest --testPathPattern='fleet'`                                            | 61 — plus the pre-existing suites and the module pin                                 |
| `cd apps/api && npx jest --testPathPattern='fleet-run-routing'`                                      | 15 — the routing matrix end-to-end through the dispatch seam                         |
| `cd apps/api && npx jest --testPathPattern='fleet-runner-status'`                                    | 6 — composition + degradation + availability                                         |
| `cd apps/api && npx jest --testPathPattern='fleet-runner-routes'`                                    | 18 — endpoint authz scoping + DTO validation                                         |
| `cd apps/api && npx jest --testPathPattern='FleetRunnerTelemetryAndRouting'`                         | 6 — migration up/down/idempotency on better-sqlite3                                  |
| `cd apps/node && npx vitest run src/core/telemetry-probe.spec.ts`                                    | 24 — probes, parsing, never-fail-the-beat                                            |
| `cd apps/web && npx vitest run src/components/dashboard/runner-status.unit.spec.ts`                  | 9 — row state, byte + relative-time formatting                                       |
| `cd packages/plugins/job-runtime-node && npx vitest run`                                             | 21 — existing suite, still green                                                     |
| `cd packages/contracts && npx vitest run src/fleet src/__tests__/fleet-execution-preference.spec.ts` | slice S — eligibility-aware rule shapes, `clampQueuedMaxAgeSec`, barrel (99 symbols) |
| `cd packages/agent && npx jest --testPathPattern='fleet-job.queue-expiry'`                           | slice S — queue SLA (CAS, once-only event, per-kind cutoffs), heartbeat promotion    |
| `cd apps/api && npx jest --testPathPattern='fleet-run-routing\|fleet-runner-status'`                 | slice S — R5 pinned-to-offline routes to fallback / visible wait; eligible counts    |
| `cd apps/api && npx jest --testPathPattern='fleet-agent-task-reconciler\|fleet.controller'`          | slice S — "never started" notice exactly once; promotion only on an online beat      |
| `cd apps/api && npx jest --testPathPattern='AddFleetJobQueuedAt'`                                    | slice S — migration up/backfill/index/down on better-sqlite3                         |
| `cd apps/web && npx playwright test e2e/flow-fleet-runner-pill.spec.ts`                              | slice S — the pill against a real enrolled node (written; validated on CI)           |

`apps/web/e2e/api-public-contract.spec.ts` gains `/api/fleet/runner-status` and
`/api/fleet/execution-preferences` to the unauthenticated-401 matrix. The pill
renders on every dashboard page and polls constantly, so an accidental
`@Public()` there would leak one account's machine inventory.

The routing matrix is tested at two levels on purpose: the RULE is pure and
tested in contracts; the API suite tests the **wiring** — in particular that
`waiting-for-runner` reaches the job row and not just the router, which is the
assertion that catches a field wired at one end only.

## Verification

```
npx turbo build      --filter=@ever-works/contracts --filter=@ever-works/agent \
                     --filter=@ever-works/job-runtime-node-plugin --filter=ever-works-node
npx turbo type-check --filter=@ever-works/contracts --filter=@ever-works/agent \
                     --filter=@ever-works/job-runtime-node-plugin --filter=ever-works-node \
                     --filter=ever-works-api --filter=ever-works-web
```

All six pass. Build the workspace deps **before** type-checking `apps/api` —
turbo's `type-check` has no `dependsOn`, so a stale `dist` produces a screenful
of phantom `TS2307`s.

### Pre-existing breakage (NOT introduced here, NOT fixed here)

`npx turbo type-check --filter=ever-works-desktop-node` fails on `develop` with
the same two errors it fails with on this branch (verified by stashing the whole
branch and re-running against a freshly built `ever-works-node`):

- `src/main/identity.ts(75,3)` — `string | null | undefined` not assignable to
  `string | null` (`WorkerStatusView.throttleReason`);
- `src/shared/status-label.spec.ts(6,2)` — `worker?: WorkerStatusView | undefined`
  not assignable to a required `worker`.

Both are `exactOptionalPropertyTypes`-shaped mismatches in that app's own IPC
view types, untouched by this branch. Left alone rather than "fixed" in an
unrelated feature PR.

---

## Follow-ups

1. **Per-Work / per-Goal preference picker on the Work and Goal pages.** The API,
   the resolution rule and the router handle all three scopes today, and the
   settings page lists + clears narrower overrides — but it cannot yet _create_
   one, because that is a choice a user makes from the Work they mean, not from a
   dropdown of every Work they own.
2. **Surface `fleet_jobs.queuedReason` in the node detail drawer.** It is on the
   row and in `FleetJobView`; the drawer's history list does not render it yet, so
   "waiting for a free runner" is currently visible via the API but not the UI.
3. ~~**Promote a waiting fleet job when a runner comes online.**~~ Done in slice S
   (`FleetJobService.promoteWaitingForNode`, called from the heartbeat edge).
4. ~~**`runnerCount` in the fallback notification is coarse**~~ Done in slice S:
   `runnerCount` is the eligible count; `fleetRunnerCount` / `pinnedNodeId` ride
   alongside it.
5. ~~**e2e coverage for the pill itself.**~~ Written in slice S
   (`apps/web/e2e/flow-fleet-runner-pill.spec.ts`, enrolls a real node through the
   public protocol); runs on CI.
