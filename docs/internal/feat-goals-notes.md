# Goals — autonomy layer (DoD, budgets, orchestrator loop, limits)

Branch: `session/feat-goals`. Extends the EXISTING Goals module (PR-8 "Goals &
Metrics" + the G1 judgment layer) toward an autonomous goal-execution loop with
operator controls. Everything is additive: a Goal that never opts into the loop
behaves exactly as it did.

## What shipped

1. **Definition of Done** — a Goal carries an ordered checklist
   `[{id, text, status: open|done|waived, evidence?, note?, source?, proposed?}]`
   with a server-computed rollup ("N done · N waived · N open"). Criteria are
   operator-authored, or proposed by a planning run and approved by the operator.
2. **Per-Goal budgets + limits** — `spendCapCents`, a `spentCents` rollup derived
   from linked runs' `costCents`, `wallClockLimitHours`,
   `stuckThresholdIterations`, `sessionBudgetMinutes`, `gracePeriodMinutes`,
   `executionTarget`, `plannerModelHint` / `workerModelHint`, `assignedAgentId`.
   Edited live through an "Adjust limits" dialog.
3. **Iteration loop state** — `iteration`, `lastProgressIteration`,
   `activeAgentId`, `loopStatus` (`running|paused|done|cancelled|stuck`),
   `loopStartedAt`. Controls: Advance, Nudge, Pause, Restart session, Cancel.
4. **Orchestrator** — `GoalOrchestratorService` evaluates DoD progress + budgets
   and either dispatches the next iteration to a routed agent or stops the loop,
   recording the REASONING for every decision in a new `goal_events` table
   rendered as the Orchestrator tab. Cron-driven (`goal-advance-dispatcher`,
   every 5 minutes) over the existing Trigger.dev internal-RPC topology.
5. **Goal detail tabs** — Definition of Done | Progress log | Sessions |
   Orchestrator | Results, plus archive/unarchive and an Archived catalog view.

## Design decisions worth reviewing

### An iteration IS a Task (reuses dispatch wholesale)

Nothing here re-implements dispatch. One iteration = one auto-created Task
`[Goal] <title> — iteration N` filed against `tasks.goalId`, assigned to the
routed agent, then handed to `TaskTransitionService.dispatchAgentRun` — the same
path a kanban "Run" click takes. That buys the concurrency valve, credits
precheck, workspace isolation, quality gates and the run cockpit for free, and it
is why the Sessions tab is simply "the runs of this Goal's Tasks" and the spend
rollup is `SUM(agent_runs.costCents)` over them.

### `loopStatus` is a NEW column, not new `GoalStatus` members

The brief asked for a status extension `running|paused|done|cancelled|stuck`.
**The code disagreed and the code won.** `goals.status` drives the
metric-evaluation dispatcher's claim predicate
(`status = 'active' AND nextCheckAt <= now`), the activate/pause state machine,
and the `?status=` list filter — all pinned by e2e specs
(`flow-goals-validation-authz-matrix.spec.ts`). A Goal can legitimately be
metric-ACTIVE while its iteration loop is paused, so these are two independent
axes. Folding `cancelled`/`stuck` into `status` would both widen those pinned
contracts and make the two meanings inseparable.

### Spend is stored in CENTS, not dollars

The brief said `spendCapUsd`. The only thing that ever adds to `spentCents` is
`agent_runs.costCents`, which is already cents; a dollars column would need a
lossy conversion on every rollup. The column is `spendCapCents`, the API speaks
cents end to end, and the ONE conversion to dollars lives in the limits dialog
(input) and `formatCents` (display).

### `assignedAgentId` was added beyond the brief's column list

The routing rule the brief specified — "goal's assigned agent, else round-robin
over goal-linked agents" — needs a place to record the pin. `activeAgentId` is
the agent currently working, which is a different fact. Agents have no `goalId`
column, so "goal-linked agents" is derived: the distinct `agentId` of Tasks filed
against the Goal, oldest first. A Goal with neither a pin nor history has nothing
to route to and is marked `stuck` with reason `no-candidate-agent` rather than
silently idling.

### The decision is a pure function

Every branch lives in `decideGoalLoop` (`goal-orchestrator-rules.ts`); the
service only does I/O. Ordering is the contract:

1. loop not running → `noop`
2. DoD complete → `complete` (**beats** an exhausted budget — finishing inside
   the last budgeted iteration must not read as "paused: out of money")
3. spend cap reached → `pause` (**no grace** — a money ceiling that keeps
   spending is not a ceiling)
4. wall clock reached → `pause`, unless `gracePeriodMinutes` is set AND a run is
   in flight AND elapsed < limit + grace, in which case `wait`
5. no DoD progress for `stuckThresholdIterations` → `stuck` (**after** the
   ceilings: over-budget and stuck have different operator remedies, and the
   ceiling is what stopped it)
6. run in flight → `wait`
7. no candidate agent → `stuck`
8. otherwise → `dispatch`, pinned agent first, else round-robin at
   `nextIteration % candidates.length`

`wait`/`noop` write NO log line — a 5-minute cron logging "still running" would
bury the decisions that matter.

### Planner proposals are inert until approved

`summarizeDoD` excludes `proposed: true` criteria from `total`, `open`, `done`
and `complete`. A planning run therefore cannot move (in either direction) the
finish line it is supposed to be working toward. Approval currently rides the
existing notification path.

### Progress signature ignores cosmetic edits

Stuck detection compares `dodProgressSignature` (sorted `id:status` pairs) across
iterations. Rewording a waiver note is not progress; if it reset the clock, a
loop could look busy forever without moving.

## Data model

`goals` (additive, migration `1785010000000-AddGoalOrchestration`):

| column                                 | type              | note                                          |
| -------------------------------------- | ----------------- | --------------------------------------------- |
| `dodCriteria`                          | simple-json       | `GoalDoDCriterion[]`, NULL = metric-only Goal |
| `spendCapCents`                        | int null          | NULL = uncapped                               |
| `spentCents`                           | int, default 0    | derived rollup, refreshed on advance          |
| `wallClockLimitHours`                  | int null          | anchored on `loopStartedAt`                   |
| `stuckThresholdIterations`             | int null          |                                               |
| `sessionBudgetMinutes`                 | int null          | advisory, carried into the iteration brief    |
| `gracePeriodMinutes`                   | int null          | extends the wall clock only                   |
| `executionTarget`                      | varchar(16) null  | `cloud` \| `local-runner`, advisory           |
| `plannerModelHint` / `workerModelHint` | varchar(120) null | free strings                                  |
| `iteration` / `lastProgressIteration`  | int, default 0    |                                               |
| `activeAgentId` / `assignedAgentId`    | uuid null         | current / pinned                              |
| `loopStatus`                           | varchar(16) null  | see above                                     |
| `loopStartedAt` / `archivedAt`         | timestamp null    |                                               |

Index `idx_goals_loop_status` backs the orchestrator due-scan (NULL never
matches, so the cheap case is one indexed lookup returning zero rows).

`goal_events` (new, migration `1785020000000-CreateGoalEvents`): `id`, `goalId`
(FK CASCADE), `userId`, `kind`
(`route|dispatch|complete|limit|nudge|control|dod`), `message` (text — the
verbatim reasoning), `agentId?`, `taskId?` (raw uuids, **no FK**: a log line must
survive deletion of what it describes), `iteration`, `metadata` (simple-json),
`tenantId`/`organizationId`, `createdAt`. Append-only, no update path. Indexes
`idx_goal_events_goal_created` and `idx_goal_events_goal_iteration`. Registered
in `_entities-inventory.ts` + `_entity-names.ts` + the entities barrel.

Additive `ActivityActionType` members: `GOAL_LOOP_STARTED|_PAUSED|_RESUMED|
_CANCELLED|_COMPLETED`, `GOAL_ITERATION_DISPATCHED`, `GOAL_ITERATION_NUDGED`,
`GOAL_LIMIT_TRIPPED`, `GOAL_DOD_UPDATED`, `GOAL_ARCHIVED`, `GOAL_UNARCHIVED`
(the column is a plain varchar, so no migration).

## Endpoints (all under the existing `GoalsController`, `api/me/goals`)

| method | path                                     | note                                               |
| ------ | ---------------------------------------- | -------------------------------------------------- |
| GET    | `/:id/events?limit=`                     | orchestrator log, newest first                     |
| GET    | `/:id/sessions`                          | iteration Tasks + latest run each                  |
| PATCH  | `/:id/limits`                            | budgets + hints; `null` CLEARS a ceiling           |
| PUT    | `/:id/dod`                               | replace the checklist; `criteria: null` clears     |
| POST   | `/:id/dod/propose`                       | planner-authored entries (inert until approved)    |
| POST   | `/:id/dod/approve`                       | approve all, or `criterionIds`                     |
| PATCH  | `/:id/dod/:criterionId`                  | tick / untick / waive-with-note                    |
| POST   | `/:id/advance`                           | run the router now (10/min — can start a paid run) |
| POST   | `/:id/nudge`                             | steer the live run via `RunSteeringService`        |
| POST   | `/:id/loop/start\|resume\|pause\|cancel` |                                                    |
| POST   | `/:id/loop/restart`                      | cancel in-flight + dispatch fresh (10/min)         |
| POST   | `/:id/spend-rollup`                      | recompute `spentCents` from linked runs            |
| POST   | `/:id/archive` · `/:id/unarchive`        |                                                    |
| GET    | `/?archived=true\|false\|all`            | archived view (default hides archived)             |

Every new DTO field is copied explicitly in the controller body-mapping, and
`undefined` (leave alone) is preserved as distinct from `null` (clear) — a
mapping that collapsed the two would make "remove this cap" impossible while the
DTO advertised it.

## UI routes

- `/goals` — gains an Active/Archived view toggle and an archived empty state.
- `/goals/[id]` — tab strip (Definition of Done | Progress log | Sessions |
  Orchestrator | Results); header carries the loop badge, iteration counter,
  spend-vs-cap, DoD rollup, and the loop controls plus the existing metric
  lifecycle controls. New components under `apps/web/src/components/goals/`:
  `GoalDodPanel`, `GoalLimitsDialog`, `GoalOrchestratorLog`, `GoalSessionsPanel`,
  `GoalResultsPanel`, `goal-loop-ui`.

i18n keys added under `dashboard.goalDetail.{tabs,loop,dod,limits,orchestrator,
sessions,results}` and `dashboard.goalsPage.{viewToggle,emptyArchived}` to **all
21** locale files (English string copied verbatim; no machine translation).

Results renders the agent-authored summary as pre-wrapped text, not through a
markdown renderer — model output on a page that also carries operator controls is
not worth handing to an HTML renderer for nicer headings.

## Test commands

```bash
# agent domain (Jest) — 152 tests across the goals suite
cd packages/agent && npx jest --testPathPattern='src/goals/'

# migrations (Jest, in-memory better-sqlite3)
cd apps/api && npx jest --testPathPattern='migrations/__tests__/(AddGoalOrchestration|CreateGoalEvents)'

# trigger RPC wiring pins
cd apps/api && npx jest --testPathPattern='trigger/trigger-internal'

# web unit
cd apps/web && npx vitest run src/components/missions/MissionGoalsPanel.unit.spec.tsx

# types (build shared packages FIRST — turbo type-check has no dependsOn)
npx turbo build --filter=@ever-works/agent --filter=@ever-works/contracts
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

New/updated specs: `goal-dod.spec.ts` (18), `goal-orchestrator-rules.spec.ts`
(27 — the decision table), `goal-orchestrator.service.spec.ts` (36 — dispatch
wiring, spend rollup, nudge→steer, loop control, archive, sessions),
`AddGoalOrchestration.spec.ts` (6), `CreateGoalEvents.spec.ts` (6).
`flow-mission-goals-evaluation-chain.spec.ts`'s `GOAL_DTO_KEYS` pin was extended
with the 17 new DTO fields (same-PR rule for pinned surfaces).

## Known follow-ups

- **Inbox approval item.** The brief asked for planner-proposed DoD criteria to
  raise an Inbox approval. The Inbox feature does not exist on this branch's
  base, so `proposeDodCriteria` emits the existing notification path
  (`NotificationCategory.AGENT`, deduped per goal). Swap the notification for an
  Inbox item when that feature lands.
- **AI routing.** v1 routing is deterministic (pin → round-robin over goal
  history) and the `reasoning` strings say so. An AI router would append its own
  rationale to the same `goal_events.message` column; nothing else changes.
- **`executionTarget` is advisory only.** It is recorded on every dispatch event
  but does not yet steer job-runtime selection — the Fleet/tenant runtime
  resolver is the place that would consume it.
- **No e2e coverage for the new endpoints.** The unit + migration suites cover
  the behaviour; an API-level e2e (`flow-goal-orchestrator-*.spec.ts`) mirroring
  `flow-goals-lifecycle-deep.spec.ts` would be a cheap follow-up but was left out
  rather than shipping a flaky spec against a cron-driven surface.
- **`GoalCard` does not yet show loop state.** The list card still renders only
  the metric progress; adding the loop badge + DoD rollup there is a small,
  purely presentational follow-up.

## Pre-existing breakage observed (NOT introduced here, NOT "fixed")

- `apps/api` type-check reports 4 module-resolution errors that exist on the base
  commit: `@ever-works/k8s-plugin` (unbuilt plugin, referenced only by
  `deploy.e2e.spec.ts`) and three `@src/*` alias collisions where apps/api's
  tsconfig resolves `packages/agent` source files
  (`database.config.ts`, `work-generation-history.entity.ts`, `work.entity.ts`).
- `apps/web` ESLint reports `react-hooks/set-state-in-effect` on
  `GoalsList.tsx:53` — that `useEffect` is unchanged from the base commit.
