# Fleet — run reconciliation + cancellation (agent execution v2, slice B)

Branch `feat/fleet-node-run-reconciliation`, stacked on `feat/fleet-node-agent-execution`
(slice A, #2297). Program: Workspace `knowledge/notes/2026-09-02-self-build-fleet-program.md`,
gaps **G2** (no result reconciliation) and **G3** (cancellation not wired). Jira EW-764.

Before this, a fleet node could finish an `agent-task` and the platform never noticed:
`FleetJobService.completeJob` wrote `fleet_jobs.result` and stopped. The `AgentRun` stayed
`queued` until the stuck sweeper reaped it hours later, the Task board never moved, the Goals
orchestrator never saw an iteration end, and the branch the node pushed never became a pull
request. Cancelling such a run flipped the row and left the PC's CLI running to completion,
because `NodeDispatcherFactory.cancel` had no store `cancel` and the run canceller only knew
Trigger.dev.

## What shipped

| Layer                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ever-works/agent` events       | `FleetJobLeasedEvent` (`fleet.job.leased`) and `FleetJobCompletedEvent` (`fleet.job.completed`, with `source` = `node-report` / `lease-exhausted` / `cancelled` and the verdict `result` / `error` ON the event). Emitted by `FleetJobService` through an `@Optional()` `EventEmitter2` appended last (positional-arity rule).                                                                                                                                                                                                          |
| `@ever-works/agent` fleet        | `FleetJobService.cancel(jobId)` → `queued-dropped` (row failed with `FLEET_JOB_CANCELLED_ERROR`, completion event) / `cancel-requested` (active row flagged) / `terminal` / `not-found`. `heartbeatJob` REFUSES the beat of a flagged job — the "lease lost" signal the node already aborts on; `completeJob` still accepts the node's report. `FleetJobRepository.cancelQueued` / `requestCancel` (both CAS-pinned). `toJobView` carries `cancelRequestedAt`.                                                                          |
| entity + migration               | `fleet_jobs.cancelRequestedAt` (nullable timestamp), `1787700000000-AddFleetJobCancelRequestedAt` (portable `TableColumn`, guarded, `down()`), spec on better-sqlite3.                                                                                                                                                                                                                                                                                                                                                                  |
| `@ever-works/agent` tasks-domain | `TaskWorkspaceService.finalizeRemotePush()` — the finalize path for a branch pushed elsewhere: record branch/base on the Task, then the SAME PR-open + review-transition + merge-policy tail the cloud path uses, extracted into `openPullRequestForBranch` (behaviour unchanged for `finalizeRun`). Idempotent on a Task that already has a PR.                                                                                                                                                                                        |
| `apps/api` fleet                 | `FleetAgentTaskReconcilerService` (`@OnEvent`, provided by the api `TasksModule` like the planner): lease → `markStarted` (CAS) + board denorm + activity line naming the node; complete → gate results + changed-files telemetry on the run → `markCompleted` with the CLI's summary / `markFailed` with the node's reason → `finalizeRemotePush` when the node pushed → Task chat message from the agent (redacted) → Inbox notice on failure → `RunDispatchGateService.drainForWork`. Operator-cancelled jobs only mirror the board. |
| `apps/api` cancel path           | `createFleetJobStore.cancel` wired to `FleetJobService.cancel`; `createFleetAwareAgentRunCanceller` (uuid-shaped remote id → fleet first, `not-found` falls through to Trigger.dev) bound as `AGENT_RUN_CANCELLER` in `AgentsModule`.                                                                                                                                                                                                                                                                                                   |

## Where the brief and the code disagreed

1. **Verdict on the event, not on the wire view.** `FleetJobView` deliberately omits `result` /
   `error` (a 256 KB result on every Fleet list, and a node's own report echoed back to it, are
   neither wanted). The reconciler needs exactly that pair, so `FleetJobCompletedEvent` carries it.
2. **No polling.** The plan considered polling `NodeJobRuntimePlugin.getRunStatus` like the
   Trigger provider. Events are strictly better here: the completion is a single server-side
   write we already own, and polling would add a cron to learn something the write already knew.
3. **Cancel is a refused heartbeat, not a message.** Transport is outbound-only; the node polls.
   The job heartbeat is the one channel the node listens on while running, and "lease lost" is a
   path it already handles (abort, report). No new endpoint, no new node build required — an
   older node build cancels correctly too.
4. **`cancelled` completions do not re-settle the run.** The operator path flipped the run to
   `cancelled` before asking the runtime; the reconciler only mirrors the board for that source.
   Every other terminal write is CAS-guarded (`NON_TERMINAL`), so a duplicate event is a no-op.

## Verification

```sh
cd packages/agent && npx jest src/fleet src/events src/tasks-domain/__tests__/task-workspace   # incl. fleet-job.cancel-and-events, task-workspace-remote-push
cd apps/api && npx jest src/fleet src/migrations/__tests__/AddFleetJobCancelRequestedAt.spec.ts  # reconciler, canceller, migration + existing
```

Type-checks: `@ever-works/agent`, `ever-works-api`.

## Follow-ups

- **G — MCP tools** so the CLI on the node can `ask_human` mid-run; today a blocked run ends with
  an explanation in its final message (reconciled as a completed run with that summary).
- **E — node drawer** should render the job outcome the reconciler now records on the run
  (summary, checks, branch, PR).
- Merge simulation is skipped on the remote path (no checkout on the platform side); the PR
  itself is the conflict signal. A `simulateMerge` against the provider API is possible later.
