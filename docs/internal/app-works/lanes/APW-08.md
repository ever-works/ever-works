# APW-08 Evolve loop — lane log (B2 `aw-evolve`, overnight 2026-10-27)

Spec: [`docs/specs/features/app-works/APW-08-evolve-loop/`](../../../specs/features/app-works/APW-08-evolve-loop/)
(`spec.md`, `plan.md`, `tasks.md`). `CONTRACTS.md` wins over epic text. The per-step record is the ledger
(`docs/internal/app-works-build-progress.md` §6); this file is the lane's plan of record, decisions and questions.

## Plan of record

| Phase | Tasks           | What                                                                                                                                                                                           |
| ----- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | T47             | The App Work Task tool policy (security): one allow-list reported in groups, applied where tools are resolved, re-checked at dispatch, the fleet MCP bridge withheld.                          |
| 2     | T49             | The operator kill switches `EVER_WORKS_APP_CHANGES_ENABLED` / `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED`, read by every dispatcher that exists.                                                      |
| 3     | T18             | The run brief from the App rules at the base commit, instruction files fenced as untrusted (cloud and fleet).                                                                                  |
| 4     | T24 (cost), T56 | `GET /api/tasks/:id/cost`, `GET /api/works/:id/cost`, the plan §3.4 types. The delivery routes, `allow-containment` and the web surfaces wait for the delivery chain (T7–T9, T20–T23) and T48. |
| 5     | T27 (part)      | `RequestChangeDialog` and `WorkCostSummary` on the App Work overview, over `POST /evolve` and `GET /api/works/:id/cost`.                                                                       |

MERGED: #2961 → `develop` at `c400452a4` (phase 1, T47).
MERGED: #2965 → `develop` at `a104e182a` (phase 2, T49).
MERGED: #2967 → `develop` at `ff2ecee5d` (phase 3, T18).
MERGED: #2972 → `develop` at `336f2e0d4` (phase 4, T24 cost half + T56 read; CodeQL's type-confusion finding fixed in `24584e2b9`).

## Decisions

1. **T47 is an allow-list reported in groups.** Kept: `ask_human`, `commitToRepo`, `openPullRequest`,
   `submitTaskReview` and every `read.internal` tool. Everything else is denied as one of the spec's five groups or
   the additive sixth, `platform-action` (fleet computer acts, `editAgentFile`, `resolve_escalation`, any unclassified
   tool). A tool added tomorrow is withheld from App Work runs until it is classified. Names match case-insensitively
   (like the grant matrix); `mcp__x__ask_human` is still MCP.
2. **T47 scope.** A run on a Task on an App Work (any surface, Task-chat replies included), or a run of an
   App-Work-scoped Agent that is not its owner's own Conversation turn (heartbeats and delegated runs recall what
   earlier App Work runs read). The classifier fails closed on any unreadable row.
3. **T47 refusal is visible.** A dispatch re-check violation fails the run with `app_work_tool_policy: …` on the row, an
   ERROR run-log row and an `agent_run_failed` Activity row (`code`, `groups`); withheld tools are one WARN run-log
   row with the per-group counter. No tool argument is ever logged.
4. **T49 defaults ON.** CONTRACTS §7 lists both switches `true`, and the features already ship. Unset or blank = on,
   a known off spelling = off, an unrecognised value = off (fail closed). CONFIGURATION §3A's "Default (fail-closed):
   off" column is read as the unrecognised-value behaviour; an as-built note says so.
5. **T49 error code.** CONTRACTS §8 `switch_off` (503, `switchOff`), not the plan's `422 changesPaused`.
6. **T49 coverage.** `dispatchAgentRun` (the one choke point: board, chat, Goals, recurrence, fan-out),
   `AgentRunService.execute` (resume, drain, assign-task, queued before the flip), the fleet planner (model-cli), the
   evolve request, and APW-06's build-succeeded listener (auto-deploy). Review runs pass. The owner's domain-change
   rebuild and every manual Deploy stay.
7. **T18 placement.** The cloud brief is appended to the task-kind run's system message in `AgentRunService` (the
   executor `agent-task-execute` calls), not in the worker file, so the API process reads the rules with its own DI.
   The fleet brief puts the rules first in the never-truncated tail and the files last (dropped first on size).
8. **T18 token in a leaf port.** `APP_RUN_BRIEF_SOURCE` lives in `app-run-brief.port.ts`, so `AgentRunService`'s
   parameter decorator never depends on the rules / App spec services loading first.
9. **Cost views read the one ledger.** No new spend account, no migration. `GET /api/works/:id/cost` answers any Work
   kind (it reads that Work's own budget).

## Questions for the owner

- Keep T47's sixth group `platform-action`, or narrow the policy to the spec's five groups?
- T47 also covers an App-Work-scoped Agent's heartbeat and delegated runs. Confirm, or Task runs only?
- `commentOnTask` is denied on App Work runs because a comment wakes another Task's Agent; the run's own reply is still
  posted by the platform. OK?
- CONFIGURATION §3A says the R-30 switches default `off`, CONTRACTS §7 says `true`; built as unset = on,
  unrecognised = off. Confirm.
- The changes switch also stops APW-04 provisioning runs and Task-chat replies on App Work Tasks. Right scope?
- R-30 describes paused runs parking and resuming by themselves; today a refused run fails with `switch_off` and the
  Task is run again by hand. Build parking?
- Should Task-chat replies on an App Work Task carry the T18 brief too (today only task-kind runs do)?
- Should `GET /api/works/:id/cost` answer only App Works?

## Residuals (recorded, not fixed)

- A fleet node CLI's own built-in web tools are not governed by T47 (the payload has no field for them): T48, node side.
- Jobs already queued in `fleet_jobs` before a deploy are not re-planned (T47 bridge, T49 switch); a resumed or drained
  legacy `command`-mode fleet job does not pass the planner's model-cli path.
- T18's symlink refusal depends on the git provider: an in-repository link resolves to its target's content (fenced),
  a link out of the repository comes back as no file (refused).

## Next step

The delivery chain (T7–T9, T20–T23: `mergeCommitSha` on the git contract, the six `tasks` delivery columns in the
`179208…` block, `TaskDeliveryService`, the PR-status hook, `app-change-delivery`) unlocks `GET /api/tasks/:id/delivery`
and its close / follow-up routes, the web delivery chips, `ChatChangeCard`, and the APW08-G25 defaults (to be built
behind a flag). `RequestChangeDialog` and `WorkCostSummary` are built (phase 5); the delivery chips, the Task page's
Delivery and Cost sections and `ChatChangeCard` are not. P2 (T31–T37) has not started.
