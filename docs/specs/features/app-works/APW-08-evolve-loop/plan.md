# Implementation Plan: Evolve loop

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation detail; the
> spec owns behaviour. **Every path below was opened in the worktree before it was written down** — a path marked
> _(new)_ does not exist yet.

**Epic ID**: `APW-08-evolve-loop`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-17
**Authored against**: `develop` @ `a655b53ca`
**Re-verified against**: `feat/app-works-implementation` @ `c99c2cc6f` (2026-09-17) — the Fleet containment record
(`FleetAgentTaskContainment`) and the workspace clone-URL guards are in the tree and are cited in §1.1 and §2.3;
the newest migration is still `1791240000000-AddSafetyRailsCore.ts`, below this epic's `179208…` block, so no
migration re-stamp is needed. Line citations written against `ee45946e5` in §1.1 and §1.2 describe the same code and
were re-read at their current paths.

---

## 1. Current state in the codebase

### 1.1 What ships today

| Layer                 | File                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent tools           | [`apps/api/src/agents/agents.module.ts`](../../../../../apps/api/src/agents/agents.module.ts) (the `AGENT_GIT_FACADE` provider, ~lines 597–749 on `ee45946e5`)                                                                                                                                                                                                                                                                                                                                                                                                                                      | Binds `commitToRepo` / `openPullRequest` for Agents. **Defective — see §1.2.** `inject: [GitFacadeService, AgentRepository, PullRequestGateService, WorkRepository]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Agent tools           | [`packages/agent/src/agents/agent-git-facade.ts`](../../../../../packages/agent/src/agents/agent-git-facade.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `AgentCommitToRepoInput` (`branch?` "Defaults to the Work's main branch"), `AgentOpenPullRequestInput` (`base?` "Defaults to the Work's default branch"), `AGENT_GIT_FACADE` token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Agent tools           | [`packages/agent/src/agents/agent-tool.service.ts`](../../../../../packages/agent/src/agents/agent-tool.service.ts) `buildCommitToRepoTool` / `buildOpenPullRequestTool` (~1251–1382)                                                                                                                                                                                                                                                                                                                                                                                                               | Descriptors; require `AgentScope.WORK` + `agent.workId`; forward to the facade; catch and return `{ error }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tests                 | [`apps/api/src/agents/agents.module.spec.ts`](../../../../../apps/api/src/agents/agents.module.spec.ts) `describe('api-side AgentsModule — AGENT_GIT_FACADE PR gate')`                                                                                                                                                                                                                                                                                                                                                                                                                              | Builds the real factory with stubs, but only asserts the PR gate is consulted — **never the coordinates**, which is how the defects survived.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tests                 | [`packages/agent/src/agents/__tests__/agent-tool-git.spec.ts`](../../../../../packages/agent/src/agents/__tests__/agent-tool-git.spec.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Descriptor gating + forwarding with a mocked `AgentGitFacade`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Git facade            | [`packages/agent/src/facades/git.facade.ts`](../../../../../packages/agent/src/facades/git.facade.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `getRepoDir('work', id, opts)` clones `work.sourceRepository.owner/repo` with `providerId: options.providerId ?? work.gitProvider`; `cloneOrPull` → `resolvePluginAndToken` → `resolvePlugin(providerId)` throws `'providerId is required'` on `''`. `commit(providerId, …)` uses `getPluginSync`, which falls back to **any** loaded git plugin. `push({ dir, ref?, remoteRef? })`, `switchBranch`, `createPullRequest`, `getCompareDiff`, `getFileContent(owner, repo, path, opts, ref)`, `getRepository`.                                                                                                                                            |
| Work                  | [`packages/agent/src/entities/work.entity.ts`](../../../../../packages/agent/src/entities/work.entity.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `gitProvider`, `sourceRepository` (import source), `getRepoOwner(type='data')` / `getDataRepo()` over `sourceRepository.relatedRepositories`, `taskIsolation` (`off`/`worktree`), `taskIsolationBaseBranch`, `checkDefaults`, `checksPolicy`, `maxGateAttempts`, `repoDeclaredCommands` (EW-807 allow-list), `mergePolicy`.                                                                                                                                                                                                                                                                                                                             |
| Repo kind             | [`packages/agent/src/services/work-lifecycle.service.ts`](../../../../../packages/agent/src/services/work-lifecycle.service.ts) `applyRepositoryWorkSource`                                                                                                                                                                                                                                                                                                                                                                                                                                         | Writes the repository under `relatedRepositories.data` "which is what `TaskWorkspaceService.provisionForRun` clones". The precedent APW-01 follows for `app`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Isolation             | [`packages/agent/src/tasks-domain/task-isolation.ts`](../../../../../packages/agent/src/tasks-domain/task-isolation.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `resolveTaskIsolation(task, work, { agentCanCommit })` → `'on' \| 'off'`; `taskBranchName`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Workspace             | [`packages/agent/src/tasks-domain/task-workspace.service.ts`](../../../../../packages/agent/src/tasks-domain/task-workspace.service.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `provisionForRun` (owner/repo = `getRepoOwner()`/`getDataRepo()`; base = `taskIsolationBaseBranch` or repo default), `describeFleetWorkspace`, `readFleetRepoDeclaredCommands` (reads `spec.tasks.setup/checks` only when `repoDeclaredCommands.mode === 'allowlist'`), `finalizeRun` → `simulateMerge` → `openPullRequestForBranch`, `finalizeRemotePush`, `postSystemMessage`.                                                                                                                                                                                                                                                                        |
| Gates                 | [`packages/agent/src/tasks-domain/task-gate-runner.service.ts`](../../../../../packages/agent/src/tasks-domain/task-gate-runner.service.ts), [`repo-declared-commands.ts`](../../../../../packages/agent/src/tasks-domain/repo-declared-commands.ts)                                                                                                                                                                                                                                                                                                                                                | Subprocess check runner over a dispatch-frozen set; `parseRepoDeclaredCommands(spec)` reads `spec.tasks` regardless of kind; `admitRepoDeclaredCommands` enforces the owner allow-list and refuses rather than drops.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Works config          | [`packages/agent/src/works-config/schema/works-config.schema.ts`](../../../../../packages/agent/src/works-config/schema/works-config.schema.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `KIND_SPEC_SCHEMAS` (no `app` yet — APW-03 adds it); `repoSpec.tasks.checks` documented as a trust boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PR status             | [`packages/agent/src/tasks-domain/task-pr-status.service.ts`](../../../../../packages/agent/src/tasks-domain/task-pr-status.service.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `syncDuePrStatuses` refreshes open PRs; on `merged` calls `completeOnMerge` → `TaskStatus.DONE` through `TaskTransitionService`; `offerRedGateToFixLoop` feeds red CI into the auto-resume loop; `resolveRepo` mirrors the workspace coordinates.                                                                                                                                                                                                                                                                                                                                                                                                       |
| PR sweep              | [`packages/tasks/src/tasks/trigger/task-pr-status-sync.task.ts`](../../../../../packages/tasks/src/tasks/trigger/task-pr-status-sync.task.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `schedules.task` `*/2 * * * *`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CI fix loop           | [`packages/agent/src/tasks-domain/task-ci-auto-resume.ts`](../../../../../packages/agent/src/tasks-domain/task-ci-auto-resume.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Budget `0..5`, default 2; `failing` is the only verdict that buys a resume.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Merge gate            | [`packages/agent/src/tasks-domain/task-merge-gate.service.ts`](../../../../../packages/agent/src/tasks-domain/task-merge-gate.service.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `onPullRequestStatusRefreshed(task, status)` — the one post-CI merge decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| PR gate               | [`packages/agent/src/policy/pull-request-gate.service.ts`](../../../../../packages/agent/src/policy/pull-request-gate.service.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `assertAllowed({ work, cwd, context })` for non-Task PR openers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Task                  | [`packages/agent/src/entities/task.entity.ts`](../../../../../packages/agent/src/entities/task.entity.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `workId`, `missionId`, `goalId`, `labels`, `branchRef`, `branchState`, `prNumber`, `prUrl`, `prState`, `ciState`, `prChecks`, `prHeadSha`, `ciHeadSha`, `latestRunId`. **No merge commit, no delivery state.**                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Task CRUD             | [`packages/agent/src/tasks-domain/tasks.service.ts`](../../../../../packages/agent/src/tasks-domain/tasks.service.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `CreateTaskInput` accepts `workId` + `missionId` + `goalId` together ("one Task with three associations").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Relations             | [`packages/agent/src/entities/task-relation.entity.ts`](../../../../../packages/agent/src/entities/task-relation.entity.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `TaskRelationKind = 'related' \| 'duplicates' \| 'follow-up'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Goals                 | [`packages/agent/src/entities/goal.entity.ts`](../../../../../packages/agent/src/entities/goal.entity.ts), [`goal-orchestrator.service.ts`](../../../../../packages/agent/src/goals/goal-orchestrator.service.ts) `applyDispatch` (~876–1030), [`goal-orchestrator-rules.ts`](../../../../../packages/agent/src/goals/goal-orchestrator-rules.ts)                                                                                                                                                                                                                                                   | **No `workId` on `goals`.** Iteration Tasks are created by `tasksService.create(goal.userId, { title: '[Goal] … — iteration N', goalId, agentId, labels: [GOAL_ITERATION_LABEL] })` then `transitions.dispatchAgentRun(task, agentId, { dedupKey: 'goal:<id>:<n>' })`. `decideGoalLoop` is pure; `runsInFlight >= maxConcurrent` → `wait` / `run-in-flight`.                                                                                                                                                                                                                                                                                            |
| Goals API             | [`apps/api/src/goals/goals.controller.ts`](../../../../../apps/api/src/goals/goals.controller.ts) (`api/me/goals`), [`apps/api/src/goals/dto/goal.dto.ts`](../../../../../apps/api/src/goals/dto/goal.dto.ts)                                                                                                                                                                                                                                                                                                                                                                                       | `CreateGoalDto` (title, goalKind, metric fields, …).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Missions              | [`packages/agent/src/missions/mission-tick.service.ts`](../../../../../packages/agent/src/missions/mission-tick.service.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tickDue` → `evaluateAndRun`: outstanding-Ideas cap → `WorkProposalService.generate({ source: MISSION, missionContext: { description, existingWorks } })` → optional auto-build. **Never creates Tasks.**                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Missions              | [`packages/agent/src/entities/mission.entity.ts`](../../../../../packages/agent/src/entities/mission.entity.ts), [`mission-work.entity.ts`](../../../../../packages/agent/src/entities/mission-work.entity.ts), [`database/repositories/mission-work.repository.ts`](../../../../../packages/agent/src/database/repositories/mission-work.repository.ts)                                                                                                                                                                                                                                            | `schedule`, `autoBuildWorks`, `outstandingIdeasCap`, `guardrailsOverride`, `missionTemplateRepo`; relations `created/improves/operates/markets/researches/retires`, `listForMissionWithWork`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Ideas                 | [`packages/agent/src/entities/work-proposal.entity.ts`](../../../../../packages/agent/src/entities/work-proposal.entity.ts), [`packages/agent/src/work-agent/idea-build-executor.service.ts`](../../../../../packages/agent/src/work-agent/idea-build-executor.service.ts)                                                                                                                                                                                                                                                                                                                          | `targetWorkId` exists, but building such an Idea calls `updateItemsGenerator` — directory generation, switched off for `app` (D1). Ideas also require `suggestedCategories/Fields/slugSuggestion`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Templates             | [`packages/agent/src/missions/mission-template.config.ts`](../../../../../packages/agent/src/missions/mission-template.config.ts), [`mission-template-manifest.service.ts`](../../../../../packages/agent/src/missions/mission-template-manifest.service.ts)                                                                                                                                                                                                                                                                                                                                        | Two hard-coded seed rows (`starter-business`, `starter-content`); zod manifest `defaults.{cadence, autoBuildWorks, outstandingIdeasCap, guardrails}`, `kb.seedPaths`, `recommendedWorkTemplates`; `applyDefaults(...)` **has no production caller**.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Chat                  | [`apps/web/src/lib/ai/tools/generated/registry.ts`](../../../../../apps/web/src/lib/ai/tools/generated/registry.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `create_task` (`workId` in body hint), `assign_task_to_agent` (`POST /api/agents/{id}/assign-task`), `get_task_spend`. Confirmation via `requiresConfirmation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Chat                  | [`apps/web/src/lib/ai/tools/work.tools.ts`](../../../../../apps/web/src/lib/ai/tools/work.tools.ts), [`docs/features/platform-chat.md`](../../../../../docs/features/platform-chat.md)                                                                                                                                                                                                                                                                                                                                                                                                              | Work tools; "It uses where you are": the page URL scopes the Work. Task chat threads are separate from the rail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Web board             | [`apps/web/src/components/tasks/TasksKanbanView.tsx`](../../../../../apps/web/src/components/tasks/TasksKanbanView.tsx) (~313–316), [`TaskDetailClient.tsx`](../../../../../apps/web/src/components/tasks/TaskDetailClient.tsx)                                                                                                                                                                                                                                                                                                                                                                     | Card chips `TaskBranchChip`, `TaskPrPill`, `TaskRunChip`, `GateChip`; detail sections `TaskChecksSection`, `TaskBranchSection`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Web Work tab          | [`apps/web/src/app/[locale]/(dashboard)/works/[id]/tasks/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/works/[id]/tasks/page.tsx>), [`apps/web/src/components/works/detail/WorkTabs.tsx`](../../../../../apps/web/src/components/works/detail/WorkTabs.tsx)                                                                                                                                                                                                                                                                                                                      | `tasksAPI.list({ workId, includeRun: true })` → `TasksScopedSection`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Costs                 | [`packages/contracts/src/runs/run-ledger.types.ts`](../../../../../packages/contracts/src/runs/run-ledger.types.ts) `RunReceipt`, [`apps/api/src/tasks/tasks.controller.ts`](../../../../../apps/api/src/tasks/tasks.controller.ts) `GET :id/spend`                                                                                                                                                                                                                                                                                                                                                 | Run receipts (AW-09) and a per-Task spend rollup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Escalations           | [`packages/contracts/src/agents/escalation.types.ts`](../../../../../packages/contracts/src/agents/escalation.types.ts), [`packages/agent/src/agents/escalation-confidence.ts`](../../../../../packages/agent/src/agents/escalation-confidence.ts)                                                                                                                                                                                                                                                                                                                                                  | Closed reason list + `REASON_PRIOR` record (exhaustive over the union).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Activity              | [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `ActivityActionType` enum (e.g. `GOAL_ITERATION_DISPATCHED`, `TASK_MERGED`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Fleet                 | [`docs/features/fleet.md`](../../../../../docs/features/fleet.md) §Capabilities, §How a fleet node pushes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `git-push` tag always required; push credential = GitHub App installation token narrowed to the Task's repositories.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Environments          | [`docs/features/environments.md`](../../../../../docs/features/environments.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `Limited` networking is **enforced only by the managed-agent pipeline plugin**; other pipelines treat it as advisory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Migrations            | [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Newest `1791240000000-AddSafetyRailsCore.ts` (re-verified on `ee45946e5`; `1791200100000-CreateOnboardingChecklists.ts` when authored); specs in `__tests__/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Run admission         | [`packages/agent/src/agents/run-admission-chain.ts`](../../../../../packages/agent/src/agents/run-admission-chain.ts), [`run-dispatch-gate.service.ts`](../../../../../packages/agent/src/agents/run-dispatch-gate.service.ts), [`agent-brake.service.ts`](../../../../../packages/agent/src/agents/agent-brake.service.ts) (AW-23, added after authoring)                                                                                                                                                                                                                                          | `DEFAULT_RUN_ADMISSION_CHAIN` = global stop flag (parks `kill-switch`) → Agent brake (parks `agent-paused` while the Agent is paused/archived; released on Resume) → Work valve → organization valve → credits. Parked runs are waiting, not stuck.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Safety rails          | [`packages/agent/src/safety/action-category.ts`](../../../../../packages/agent/src/safety/action-category.ts), [`safety-gate.port.ts`](../../../../../packages/agent/src/safety/safety-gate.port.ts), `AgentRunService.evaluateSafety` in [`agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts) (AW-24 P1, added after authoring)                                                                                                                                                                                                                                 | Every tool call passes `SAFETY_GATE` before the facade. `commitToRepo` / `openPullRequest` are `publish.external` (default rung `ask`, enforced only for an explicit rung until AW-24 P2 flips `SHIPPED_DEFAULT_RUNG_POLICY`). Task finalize pushes and PRs are not gated by the ladder — which is why the evolve loop commits and opens pull requests only through Task finalize (Resolution R-17). `apps/api/src/agents/agents.module.ts` binds `SAFETY_GATE` beside `RUN_KILL_SWITCH`.                                                                                                                                                               |
| Fleet containment     | [`packages/contracts/src/fleet/fleet-jobs.types.ts`](../../../../../packages/contracts/src/fleet/fleet-jobs.types.ts) (`FleetAgentTaskContainment` `:1245`, `FleetAgentTaskContainmentDowngrade` `:1224`, `FLEET_AGENT_TASK_EXECUTION_PATHS = ['hardened', 'ordinary']` `:1207`, `normalizeFleetAgentTaskContainment` `:1301`), [`fleet-agent-task-reconciler.service.ts`](../../../../../apps/api/src/fleet/fleet-agent-task-reconciler.service.ts) `:959`, [`isolated-home.ts`](../../../../../apps/node/src/core/model-execution/isolated-home.ts) (self-build slice AK, landed after authoring) | A Fleet run now **reports what containment it got**: the execution path, whether the model step's isolated home applied, and every downgrade the node declared (coerced toward _less_ containment, so a node cannot over-report). The isolated home is **environment construction only** — no filesystem boundary, no egress control — and the ordinary runner used by the model step deliberately keeps and back-fills `HOME`/`USERPROFILE`/`APPDATA` because a check needs a home to resolve a toolchain from. Setup steps and App checks therefore run with the machine's **real** home; §2.3 gates a Fleet placement on this record (FR-12, FR-70). |
| Workspace clone guard | [`fleet-task-workspace.types.ts`](../../../../../packages/contracts/src/fleet/fleet-task-workspace.types.ts) `:150` + `isRemoteCloneUrl` `:239`, `assertRemoteCloneUrl` in [`local-workspace.plugin.ts`](../../../../../packages/plugins/local-workspace/src/local-workspace.plugin.ts) `:1811` and [`sandbox-workspace.plugin.ts`](../../../../../packages/plugins/sandbox-workspace/src/sandbox-workspace.plugin.ts) (landed after authoring)                                                                                                                                                     | Both workspace plugins and the job spec refuse a clone URL that is not `http`/`https`/`ssh` or a `user@host` scp form, and refuse a URL carrying a NUL or a newline. §2.3 and §2.6 rely on this guard when a Task's repository coordinates reach the Fleet or sandbox workspace; the fake GitHub the acceptance harness points at is `http` on a hostname, so it still passes (GAP-21).                                                                                                                                                                                                                                                                 |

### 1.2 The exact blockers

**The Agent git tools (verified by reading, to be proven by the failing tests of T1).**

1. `commitToRepo` calls `git.getRepoDir('work', workId, { userId, workId, providerId: '' })`. Inside
   `getRepoDir`, `providerId: options.providerId ?? work.gitProvider` keeps `''` (`??` only replaces
   `null`/`undefined`); `cloneOrPull` → `resolvePluginAndToken` → `resolvePlugin('')` throws
   `GitFacadeError('providerId is required')`; `getRepoDir` swallows it and returns `null`; the tool throws
   _"could not resolve Work repo directory"_. **Every call fails.**
2. `getRepoDir` clones `work.sourceRepository.owner/repo` — the **import source** for imported Works, absent for
   template Works — not `relatedRepositories.data`, which every Task path uses.
3. `branch` is never used: the checkout is switched to main (`autoSwitchToMainBranch: true`), `push` is called
   without `ref`, and the result reports `branch ?? 'main'`. Fixing only the provider id would push agent commits
   straight onto the default branch.
4. `git.commit('github', …)` and `providerId = 'github'` hard-code a plugin id (Constitution II); `getPluginSync`
   then silently falls back to any loaded git plugin.
5. `openPullRequest` passes `owner: ''`, `repo: ''` and `base ?? 'main'`, ignoring `taskIsolationBaseBranch` and
   the repository default branch.
6. Concurrency: `cloneOrPull` coalesces by `(plugin, owner, repo, branch, switch)`, so two `commitToRepo` calls on
   one Work share one working copy with no lock.

_Re-verified on `develop` @ `ee45946e5` (2026-09-17): items 1–6 are unchanged. The only edits to
`apps/api/src/agents/agents.module.ts` since authoring are additive (AW-23 `AgentApprovalsModule` / `AgentIdentityService`, AW-24
`SafetyModule` and the `SAFETY_GATE` binding), which moved the provider to ~lines 597–749._

**The evolve loop.**

- `completeOnMerge` moves a merged Task to `DONE` immediately — the delivery chain has nowhere to live.
- Nothing links a Task to a Build or a Deployment; `GitPullRequestStatus` carries no merge commit id.
- `resolveTaskIsolation` lets any Task opt out; for `app` the Work's repository is third-party code.
- `readFleetRepoDeclaredCommands` only knows `spec.tasks.*`; the App spec's checks are `spec.checks` (CONTRACTS §1).
- The cloud gate runner spawns subprocesses on the worker that runs the pipeline — not an owner-controlled place
  for third-party code (README rule 9, D6).
- No protected-path or size check exists anywhere in finalize.
- `Goal` has no Work; `applyDispatch` creates iteration Tasks with no `workId`, so `provisionForRun` returns `null`.
- `MissionTickService` only produces Ideas; the Ideas `targetWorkId` path re-runs directory generation.
- `MissionTemplateManifestService.applyDefaults` is never called, so template defaults are not applied today.

### 1.3 What already exists and must be reused, not rebuilt

- **Task isolation + finalize** — the branch, the push, the pull request and the transition to `in_review`.
- **The PR-status sweep** — merge detection every 2 minutes; the delivery reconciler runs beside it, not instead.
- **The CI fix loop** — a red required App check in the repository's CI is `ciState = failing`, which already buys
  a bounded resume.
- **The owner allow-list (EW-807)** — `repoDeclaredCommands` + `admitRepoDeclaredCommands` is the admission for
  App checks on Fleet nodes. Same trust boundary, same refusal posture.
- **`getCompareDiff`** — changed files with `previousPath` for renames and `truncated`/`totalFiles`.
- **Task relations `follow-up`**, **Task chat `postSystemMessage`**, **escalations → Inbox**, **Run receipts**.
- **Merge policy** — the single decision point stays `canAgentMerge`; App human-merge paths add one refusal.
- **Mission↔Work relations** — `improves` / `operates` already exist with the right meaning.

---

## 2. Architecture

### 2.1 One rules resolver, one delivery reconciler, three small extensions

```
                 .works/works.yml @ Task base commit (Work Repository)
                                   │  AppSpecService.getEffectiveSpec(workId, baseSha) (APW-03)
                                   ▼
                 ┌──────────────────────────────────────────┐
                 │ AppWorkRulesService (NEW, agent pkg)      │
                 │ → { sourceBranch, checks[], protected[],  │
                 │     humanMerge[], instructionFiles[],     │
                 │     sizeGuidance }  (frozen per run)      │
                 └───────┬───────────────┬──────────────┬───┘
       dispatch brief ◄──┘               │              └──► Fleet admission (EW-807 allow-list)
                                         ▼
   finalizeRun / finalizeRemotePush ── AppChangeGuard (NEW) ── compare diff ──► PR or Blocked
                                         │
                                         ▼
   task-pr-status-sync (every 2 min) ── merged? ── kind app & base = sourceBranch?
                    │ no → completeOnMerge (unchanged)
                    │ yes → TaskDeliveryService.recordMerge  ──► Activity app.change.merged
                    ▼
   app-change-delivery (NEW, every 2 min) ── TaskDeliveryService.reconcile
        reads WorkBuild (APW-05) + WorkDeployment (APW-06) + isAncestorCommit
        ──► deliveryState ──► live: TaskTransition → DONE · failed: follow-up Task / escalation
```

### 2.2 Wave 0 — the repaired adapter

The adapter stops using `getRepoDir`. It resolves coordinates the way `TaskWorkspaceService` does:

```
work      = works.findById(workId)                      → refuse if absent
provider  = work.gitProvider                            → refuse if empty (no literal anywhere)
owner     = work.getRepoOwner('data'), repo = work.getDataRepo()
repoInfo  = git.getRepository(owner, repo, opts)        → defaultBranch
base      = work.taskIsolationBaseBranch?.trim() || repoInfo.defaultBranch
target    = input.branch?.trim() || base
policy    = mergePolicy.resolve({ workId, agentId })    → refuse if target ∈ protectedBranches
lock(workId):                                            (in-process keyed mutex, 120 s wait)
  dir = git.cloneOrPull({ owner, repo, branch: base, autoSwitchToMainBranch: false }, opts)
  git.switchBranch(provider, dir, target, create = !exists)
  write files (existing path-confinement kept verbatim) → App Work: AppChangeGuard.assertPathsAllowed
  sha = git.commit(provider, dir, message, committer)
  git.push({ dir, ref: target, remoteRef: target }, opts)
return { sha, branch: target, filesChanged }
```

`openPullRequest` uses the same `owner`/`repo`/`provider`/`base` resolution, keeps `prGate.assertAllowed` first,
and passes `base: input.base ?? base`. `MergePolicyService` is appended to the factory's `inject` list (arity
rule: append only). The keyed mutex is a small `Map<string, Promise<void>>` helper colocated with the adapter —
cross-process serialization is unnecessary because the working copy is per process.

### 2.3 Where App Work code runs (FR-12, FR-13)

- **Run admission.** `TaskTransitionService.dispatchAgentRun` (via the dispatch gate) refuses an App Work Task
  unless the run is planned for a Fleet node, or the resolved pipeline plugin declares
  `IPipelinePlugin.enforcesRuntimeNetworking === true` (owned by APW-04, CONTRACTS §3) **and** the Agent's resolved
  Environment is `limited`. The flag lives on the plugin — no plugin id in core (Constitution II). APW-04 needs the
  same predicate for provisioning; APW-08 consumes APW-04's flag and wraps it in `isAppWorkRunAdmitted(task, plan)`
  so a Fleet placement is the second admissible branch.
- **Where the placement comes from (APW08-G11).** `dispatchAgentRun` does **not** know where a run will go: it
  accepts `{ generation, dedupKey, delegationScope, seedPendingInput, reviewId }`
  ([`task-transition.service.ts`](../../../../../packages/agent/src/tasks-domain/task-transition.service.ts) `:853-915`)
  and placement is decided **later**, inside `dispatcher.enqueue`, by the routing adapter that reads the tenant's
  job-runtime config (`:1063-1076`). So `isAppWorkRunAdmitted` takes an explicit `AppWorkRunPlacement`, produced by
  the same **job-runtime selector / fleet routing adapter** that will place the run, and the admission check is
  evaluated at **two** sites, not one: (1) `dispatchAgentRun` refuses when the adapter's answer is `cloud` and the
  Agent's Environment is not `limited` — the refusal site FR-12 needs, ahead of `RunDispatchGateService` — and
  (2) the cloud worker refuses again before provisioning, so a router that silently falls back from Fleet to cloud
  between (1) and (2) cannot start a run the predicate would have refused. `AppWorkRunPlacement` is
  `'fleet' | 'cloud' | 'unknown'`; `'unknown'` is treated as `'cloud'`, so the predicate fails closed. The files
  added to T12 are the routing adapter and the cloud-worker pre-flight.
- **Fleet containment gates the placement (APW08, XC-06, SK-14, GAP-21; FR-12, FR-70).** A `'fleet'` placement is
  admissible only while the node's reported **containment** — `FleetAgentTaskContainment`, normalized by
  `normalizeFleetAgentTaskContainment` and carried onto the run by `fleet-agent-task-reconciler.service.ts:959` —
  shows `isolatedHome === true` and reports **no `isolated-home` downgrade**. A node reporting a downgrade stops with
  `needs_input` (not a red gate, not a delivery failure), and the Task shows `appRules.containmentDowngrade` with
  **Allow on this machine**; the allowance is one explicit owner action per node, stored like the EW-807 allow-list,
  and withdrawable. The record the run got (execution path, `isolatedHome`, the downgrade list) is written beside the
  run's receipt and rendered on the Task's **Cost** view (T48, T27). Because `isolated-home.ts` is environment
  construction only — no filesystem boundary, no egress control — the brief for a Fleet run states plainly that
  **setup steps and App checks run with the machine's real home and toolchain**, and FR-14's owner admission stays the
  only control there; README rule 9's "sandboxed" claim is qualified by this sentence, not replaced (GAP-21).
- **The push credential is checked before the first run (GAP-15; FR-75).** A Fleet run pushes with a GitHub App
  installation token ([`docs/features/fleet.md`](../../../../../docs/features/fleet.md) §How a fleet node pushes), and
  the installation belongs to the **repository's owner** — for a fork, the member's account, not `ever-works`. So the
  admission path asks the git facade for that installation once per App Work (cached, re-checked when the Work
  Repository's owner changes) and refuses with the S28 copy naming that owner; the refusal is `needs_input` on the
  Task, and the same Task starts unchanged once the installation is granted.
- **The App Work Task tool policy (XC-05; FR-69).** An App Work run reads third-party content — the fork's
  instruction files (FR-23), build failure excerpts, and later upstream `CONTRIBUTING` files and reviewer comments —
  while platform-side tools run **outside** the run sandbox, which FR-12(b) does not cover. So the run's tool list is
  filtered by `APP_WORK_TASK_TOOL_POLICY` (T47), a published constant that denies `sendEmail`, `searchWeb` and every
  outbound-fetch tool, `messageAgent` / `notifyChannel` / `delegateToAgent` / `createSubAgent`, every MCP tool, and
  every App Works mutation tool (`create_work`, `provisionAppWork`, `request_app_change`, deploy, env, target and
  upstream-PR tools), while allowing `ask_human` and the read-only repository tools. It is applied at
  `AgentToolService.resolveAllowedTools` and **re-checked at dispatch** the way APW-04 re-checks its grants, so a
  chat surface that offers a tool the policy denies cannot get it. APW-09 consumes the same policy; no new constant
  is duplicated there.
- **A refused action reaches the Task lifecycle (APW08-G09; FR-67).** `AgentRunService.evaluateSafety`
  ([`agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts) `:1541-1580`) turns a
  `held` or `refused` verdict into a **tool result for the model** and the run simply continues — no run status,
  event or callback carries `railId` out of the run, so FR-67 would have no producer. T46 therefore names the
  producer: `AgentRunService` records the **first non-stop** `refused`/`held` verdict on the run row (a
  `runSafetyStop` field carrying `railId` and `category` only) and, for a stop or pause rail, the parked
  `queuedReason`; the **run finisher** (cloud) and the **fleet-agent-task-reconciler** (Fleet) both call
  `classifyAppWorkRunStop` on that record, so `wait` and `needs_input` are produced on both paths and neither
  depends on the model choosing to report anything.
  _Safety rails (added 2026-09-17, AW-23/AW-24; binding as Resolution R-17):_ this refusal runs in
  `dispatchAgentRun` **before** the `RunDispatchGateService` admission chain and is not a middleware (it refuses; the
  chain parks). Every App Work run then passes the unchanged `DEFAULT_RUN_ADMISSION_CHAIN`.
    - **Parked = wait (FR-66).** A run parked by the admission chain with `queuedReason` `kill-switch` or
      `agent-paused`, or stopped at the safety gate by a stop or pause rail — `railId` `platform-stop`,
      `workspace-pause` or `scope-pause` (`packages/agent/src/safety/rails/`) — is waiting on a person: it consumes
      no gate attempt (`maxGateAttempts`), is never a delivery failure, opens no follow-up, and the Task shows
      `appRules.runHeld`. The deadline clock of the run is paused while it waits.
    - **Refused = needs input (FR-67).** Any other safety-gate `refused` or `held` verdict during an App Work run
      (`railId` `ladder`, `taxonomy`, `rules`, `grants`, `caps`) ends the run as `needs_input`: Task → `BLOCKED`,
      escalation `guardrail-refusal` (existing reason code) to the Inbox carrying `railId` and `category` only, no
      gate attempt consumed, no follow-up.
    - **Finalize, not tools (FR-68).** Every commit and pull request of the evolve loop is made by
      `TaskWorkspaceService.finalizeRun` / `finalizeRemotePush` (Task finalize), which the trust ladder does not gate.
      The run brief for an App Work Task (T18) tells the Agent that the Task pushes its branch and opens the pull
      request, so the loop never depends on `commitToRepo` / `openPullRequest`. Those tools stay `publish.external` at
      the safety gate: the P0 adapter adds no gate of its own, and an Agent with an explicit `off` / `draft` / `ask`
      rung for that category is refused or held before the adapter runs. The P0 fix still ships for their other
      callers; on an App Work the adapter cannot bypass the change guard — `commitToRepo` refuses protected paths and
      `.github/workflows/**` (`AppWorkChangeGate.checkPaths` over the call's own files and content; as built,
      2026-09-26) and `openPullRequest` runs `AppWorkChangeGate.evaluate` before `createPullRequest` (T17). Both
      tools answer to `APP_WORKS_CLOUD_PUSH_ENABLED` through the same gate as `finalizeRun` (§2.5).
- **Checks on a Fleet node.** `readFleetRepoDeclaredCommands` learns `kind: 'app'`: it parses `spec.checks`
  (mapped to `TaskAcceptanceCheck`: **the id the existing parser already mints — `repo/` + the declaration's
  position** — `kind: 'custom'`, `required`, `timeoutSec = timeoutSeconds` from APW-03's schema range 60–7,200,
  capped at 20) and admits them through `admitRepoDeclaredCommands` with the unchanged allow-list. The App spec
  `name` rides `TaskAcceptanceCheck.name` for display and for matching `Ever Works check: {name}` — it is **never**
  the id (APW08-G03): check ids are the merge key with owner-authored checks, and
  `REPO_DECLARED_COMMAND_ID_PREFIX = 'repo/'`
  ([`repo-declared-commands.types.ts`](../../../../../packages/contracts/src/tasks/repo-declared-commands.types.ts) `:142`)
  is outside `ACCEPTANCE_CHECK_ID_PATTERN` precisely so a repository cannot spell an owner id. That prefix is also
  the **authorship marker** the fleet node uses to withhold run env grants
  ([`fleet-agent-task-planner.service.ts`](../../../../../apps/api/src/fleet/fleet-agent-task-planner.service.ts) `:586-589`),
  so keeping `repo/` keeps that inference sound; an App spec check named like an owner check therefore cannot
  replace, suppress or inherit anything from it. A not-admitted check is reported `not-admitted` (new
  `TaskCheckResult.status` value — additive) instead of the current whole-run refusal, so FR-14's "gate never green"
  holds without blocking the run. A leg whose process exits **127** (POSIX "command not found") or **9009**
  (Windows) is classified **missing tool** and reported `error` with the FR-61 copy rather than red — the node runs
  checks through `spawn(command, { shell: true })`
  ([`acceptance-checks.ts`](../../../../../apps/node/src/core/executors/acceptance-checks.ts) `:363`), so a missing
  tool surfaces as a plain non-zero exit unless the code is classified; the failing node id is recorded on the Task
  and the fleet dispatcher does not re-offer that Task to it (T51).

- **The Work's own switches must be on (APW08-G02).** FR-14's **Not admitted** result and FR-16's red gate can only
  happen if the Work is actually reading App checks, and by default it is not: `Work.checksPolicy` defaults to
  `'off'` ([`work.entity.ts`](../../../../../packages/agent/src/entities/work.entity.ts) `:513-514`) and
  `repoDeclaredCommands` is `null`, i.e. `{ mode: 'off' }`, for every row
  ([`repo-declared-commands.types.ts`](../../../../../packages/contracts/src/tasks/repo-declared-commands.types.ts) `:157-160`).
  `readFleetRepoDeclaredCommands` returns an empty set unless the mode is `'allowlist'` (`:556`) and the planner
  skips the read entirely when `checksPolicy === 'off'`
  ([`fleet-agent-task-planner.service.ts`](../../../../../apps/api/src/fleet/fleet-agent-task-planner.service.ts) `:560-583`),
  so with the columns untouched the App spec's checks **never run and the run grades green having verified
  nothing**. Resolution — **additive to the App Work only, and never to another kind**: the `app.spec.applied`
  listener (§2.6) sets, in the same ownership-scoped update that writes the isolation columns,
  `checksPolicy = 'required'` when the applied spec declares at least one `required: true` check (and leaves the
  column alone otherwise, so an owner's own `'warn'` survives), and
  `repoDeclaredCommands = { mode: 'allowlist', allow: <the existing allow list, [] by default> }`. The App spec's
  checks are then read and each one still has to be admitted by the owner (FR-14); every other Work kind keeps
  `off`, so the EW-807 opt-in is unchanged for `repo`, `template` and every other kind.
- **Checks in the repository's CI (cloud runs) — a per-check matrix (Resolution R-9).** **APW-05 owns this job and
  APW-08 only verifies it (APW08-G05).** APW-05 T41 creates
  `packages/plugins/github-actions-build/src/workflow/checks-job.ts` and emits it from
  `packages/plugins/github-actions-build/src/workflow/generator.ts`; APW-05 plan §4.14 is normative for the emission
  and APW-05 FR-5 ("exactly one file") holds — the matrix job lives in the same generated workflow. APW-08 T15 adds
  **no second emitter**: it pins the emitted job with its own golden fixture and fails the build if APW-05's
  emission drifts from this epic's contract. The contract, as APW-05 emits it: `strategy.matrix.check` lists the App
  spec checks in App spec order (≤ 20, `fail-fast: false`, `max-parallel: 5`), each matrix leg is its own job named
  `Ever Works check: ${{ matrix.check.name }}` so GitHub reports **one check run per App spec check** under exactly
  that name, every leg has job `permissions: contents: read`, no `EW_` secret reference, no cache, `timeout-minutes`
  = `ceil(timeoutSeconds / 60)`, a checkout of the PR head with `persist-credentials: false`, and runs the command
  passed base64-encoded through `env: EW_CHECK_COMMAND_B64` (decoded to a temporary script) — never interpolated
  into `run:` (expression injection). A non-required check sets job-level `continue-on-error: true`, so its failure
  never fails the run (FR-13); a required one fails its leg. The job never changes a Build's status.
  **Trigger set (settled here, FR-76):** the job runs on a **same-repository pull request** _and_ on a push to the
  **tracked branch** — APW-05's generated file already triggers on both (`on: push { branches: [<tracked branch>] }`
  and `on: pull_request`), so the tracked-branch leg is an **addition** to the job's own `if:` guard and never a
  replacement for the pull-request leg; the checks-only file APW-05 emits for `image`/`none` strategies keeps
  `on: pull_request` and gains the same tracked-branch trigger for consistency. FR-16's gate reads the pull
  request's head commit; the tracked-branch leg is reported only. APW-05's T41/T42 `if:` guards are the one place
  the two epics still have to agree, and that is a shared-file request, not an APW-08 edit.
  The existing sweep then reads the legs as ordinary provider checks: a red required leg makes
  `ciState = failing`, which feeds the CI fix loop; `prChecks` renders every leg.
- **Required and advisory legs, and the attempt budget (APW08-G04; FR-16, FR-17).** T16 is not a test-only task.
  `deriveCiState` reds on **any** completed failure whatever the check
  ([`git-provider.pr-insights.ts`](../../../../../packages/plugin/src/contracts/capabilities/git-provider.pr-insights.ts) `:43-58`),
  and the merge gate skips unless `ciState === 'passing'`
  ([`task-merge-gate.service.ts`](../../../../../packages/agent/src/tasks-domain/task-merge-gate.service.ts) `:131-132`),
  so an advisory App check failing today would red the gate and hold the merge — the opposite of FR-16. For an App
  Work, `TaskPrStatusService` therefore classifies the `Ever Works check: {name}` legs through
  `AppWorkRulesService` **read at the PR base** before deriving `ciState`: a failing **required** leg makes
  `ciState = failing`; a failing **advisory** leg is ignored by the roll-up and only reported in `prChecks`. Two
  further facts live elsewhere today and are **added to this epic's path for App Works only**: the resume budget is
  the platform env var `TASK_CI_AUTO_RESUME_MAX_ATTEMPTS`
  ([`config/index.ts`](../../../../../packages/agent/src/config/index.ts) `:1590-1600`,
  [`task-ci-auto-resume.ts`](../../../../../packages/agent/src/tasks-domain/task-ci-auto-resume.ts) `:24-41`), not
  the Work's `maxGateAttempts`, and exhaustion files an Inbox notice
  ([`task-ci-auto-resume.service.ts`](../../../../../packages/agent/src/tasks-domain/task-ci-auto-resume.service.ts) `:594-598`)
  rather than `BLOCKED` + `gate-exhausted`. For an App Work the budget is the Work's `maxGateAttempts` and
  exhaustion moves the Task to `BLOCKED` with the `gate-exhausted` escalation; every other Work keeps the env-var
  budget and the Inbox notice **unchanged**, so this is a branch on `kind === 'app'` and nothing else moves. T16
  therefore **modifies** `task-pr-status.service.ts` and `task-ci-auto-resume(.service).ts` as well as adding its
  spec. One fact is **unverified and is recorded as a fact to verify, never assumed**: whether GitHub reports a
  failed job-level `continue-on-error` leg as a failing check run. Both this plan and APW-05 §4.14 rely on the
  advisory semantics, so T16 carries a fallback that does not depend on it — the App-spec-aware classifier above
  reads each leg's **required** flag from the base-commit rules, so even a provider that reports every leg as a
  failure leaves the advisory leg non-blocking. S3's copy reads **"(attempt 2 of 3)"** while FR-17's default budget
  is **2**: S3 illustrates the copy shape with a non-default budget of 3, and the copy is generated from the Work's
  actual budget, so both stand.
- **No implicit install (resolves APW-13 plan §13's APW-08 item).** A check runs exactly its declared command in a
  fresh checkout of the pull request head — on a Fleet node, in the Task worktree. Nothing installs dependencies
  first; a check that needs them declares the install in its own command (for example
  `yarn install --immutable && yarn type-check:ci --force`).
- **The cloud gate runner is never handed App checks.** `resolveAcceptanceChecks` for an `app` Work returns only
  the owner's `checkDefaults`/Task checks, never App spec checks.

### 2.4 Following a change (FR-29…FR-40)

- **Merge.** In `TaskPrStatusService.syncDuePrStatuses`, the `merged` branch asks
  `TaskDeliveryService.isDeliveryTracked(task, status)` — true when the Work is `app` and
  `status.baseRef === work.taskIsolationBaseBranch` (kept equal to `spec.source.branch`, §2.6). Tracked → `recordMerge`
  (sets `mergeCommitSha` from the new `GitPullRequestStatus.mergeCommitSha`, `deliveryState = 'merged'`, emits
  `app.change.merged` once via the partial unique index of §3.1) and **skips** `completeOnMerge`. Untracked →
  unchanged.
- **How the status reaches the hook (APW08-G10).** As written, T22 cannot compile: that loop holds only the `Task`
  `refreshTask` returns ([`task-pr-status.service.ts`](../../../../../packages/agent/src/tasks-domain/task-pr-status.service.ts) `:272-283`),
  and `refreshTask` reads `GitPullRequestStatus` internally and writes a cache patch, returning the Task
  (`:377-397`) — while `Task` stores **no** `baseRef` and **no** `mergeCommitSha`
  ([`task.entity.ts`](../../../../../packages/agent/src/entities/task.entity.ts); §3.1 adds a merge commit, not a
  base ref). T22 therefore refactors `refreshTask` to return `{ task, status }` (single-flight preserved, the
  in-memory cache patch unchanged) and passes `status` to the hook; the alternative — persisting `mergeCommitSha`
  and the base ref in the cache patch — is recorded in T22 as the fallback and would add a column, so the refactor
  is preferred. Every existing sweep test keeps its current assertions; the new spec covers tracked, untracked,
  other-branch and service-absent.
- **Which branch is tracked, when the spec omits one (APW08-G07).** `taskIsolationBaseBranch` is written only by
  the `app.spec.applied` listener from `spec.source.branch` (§2.6), and in APW-03's schema `source.branch` is
  **optional** — it defaults to the repository's default branch, and defaults are never written back into the file
  (APW-03 `schema.md` `:20`, `:117`). A spec that omits it therefore leaves the column `null`, `isDeliveryTracked`
  is never true, and FR-30 is silently off for that App Work. Fix, in this order: the listener resolves the branch
  from APW-03's `WorkAppSpecState` **tracked branch** when the applied spec has no `source.branch`, and falls back
  to the Work Repository's default branch read through `GitFacadeService.getRepository`; the same resolution is
  exposed as `AppWorkRulesService.sourceBranch` so `isDeliveryTracked` and `provisionForRun`
  ([`task-workspace.service.ts`](../../../../../packages/agent/src/tasks-domain/task-workspace.service.ts) `:231-233`)
  agree on one value. Because the listener fires only on an effective-hash change, App Works created between APW-01/03
  landing and this epic's P1 are never visited at all — T50 is a one-off **backfill** (a job, not a migration: it
  needs the git facade) that walks every `kind = 'app'` Work, writes the three isolation columns where they are
  unset, and is idempotent and re-runnable. T11 and T22 each gain a case with a spec that omits `source.branch`.
- **Reconcile.** `app-change-delivery` (every 2 minutes, ≤ 200 Tasks per tick, stalest `deliveryUpdatedAt`
  first) evaluates each tracked Task with the pure `decideDelivery(input)` over: newest `WorkBuild` rows for the
  Work on the source branch created after the merge, newest `WorkDeployment` rows linked to them, and
  `isAncestorCommit(mergeSha, candidateSha)` answers (cached per `(workId, mergeSha, candidateSha)` for 24 h).
- **Close.** `live` / `built`-with-target-None / strategy `none` →
  `TaskTransitionService.transition(task, DONE, { actorType: 'agent' })` — the same gates `completeOnMerge` passes
  today.
- **Fail.** `build_failed` / `deploy_failed` → `FollowUpService.open(task)` subject to the 2-per-change chain and
  3-open-per-Work limits, else `EscalationService.record({ reasonCode: 'delivery-failed' })`.
- **Carry-along.** Every reconcile also re-checks `deploy_failed`/`build_failed` Tasks against newer live
  Deployments (S24) and cancels their open automatic follow-ups.

**The delivery input table (APW08-G08; FR-30, FR-32, FR-34).** `decideDelivery(input)` is a pure function over
exactly the rows below and nothing else — this table **is** the test table T20 enumerates. Inputs are APW-05's
Build `status` (`queued` · `running` · `succeeded` · `failed` · `cancelled` · `blocked`,
[`APP_BUILD_STATUSES`](../APW-05-builds/plan.md) `:411`) with its `deployable` verdict and `trigger`, APW-06's
Deployment `status` (`QUEUED` · `DEPLOYING` · `VERIFYING` · `READY` · `READY` + `appRender.warnings` · `ERROR` ·
`ROLLED_BACK` · `CANCELED` · `SUPERSEDED`, APW-06 plan `:787`, `:978`) with its `smokeResult` (APW-06 plan `:974`),
the App Work's deploy target, its auto-deploy switch and the App spec's `build.strategy`.

| Input (containing the merge commit, newest first)                                                 | Delivery state                   | Why                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| No Build and no Deployment started yet                                                            | `merged`                         | FR-30's first row; the merge is recorded, nothing else has happened.                                                          |
| Build `queued` or `running`                                                                       | `building`                       | A Build of a containing commit is in flight.                                                                                  |
| Build `succeeded` with `deployable: true`, target **None**                                        | `built` → Task **Done**          | FR-32: a green Build of a containing commit closes a target-None App Work (S21).                                              |
| Build `succeeded` with `deployable: true`, auto-deploy **off**                                    | `built`                          | S20: **Built ✓ · Waiting for a deployment**, `Deploy now` / `Close without deploying`.                                        |
| Build `succeeded` with `deployable: true`, auto-deploy **on**, Deployment not yet started         | `built`                          | The Deployment has not begun; the next tick moves it.                                                                         |
| Build `succeeded` with `deployable: false`                                                        | `build_failed`                   | A not-deployable Build is a terminal failure (APW-05 §5.1); the reason rides the follow-up.                                   |
| Build `failed`                                                                                    | `build_failed`                   | FR-30.                                                                                                                        |
| Build `blocked` (incl. `strategyNotSupported` for `build.strategy: auto`)                         | `build_failed`                   | FR-32's added rule: a blocked strategy is a failure to build, not a wait.                                                     |
| Build `cancelled`                                                                                 | unchanged                        | A person stopped it; a newer containing Build decides (FR-34).                                                                |
| `build.strategy: image` or `none` with no Build and a Deployment `queued`/`DEPLOYING`/`VERIFYING` | `deploying`                      | FR-32's added rule: `image` runs no Build, so `building`/`built` are never entered.                                           |
| `build.strategy: none`, no Build, no Deployment                                                   | `built` → Task **Done**          | FR-32: closes at merge.                                                                                                       |
| Deployment `READY` and every in-cluster smoke check passed                                        | `live` → Task **Done**           | FR-30's `live` row.                                                                                                           |
| Deployment `READY` with `appRender.warnings`, or a failed **public** smoke check                  | `live`, `liveWithWarnings`       | FR-30's **Live ✓ (with warnings)**; never a failure (spec §9 `CL-08-1`).                                                      |
| Deployment `ERROR`                                                                                | `deploy_failed`                  | `{outcome}` = the recorded error outcome.                                                                                     |
| Deployment `ROLLED_BACK`                                                                          | `deploy_failed`                  | `{outcome}` = _rolled back_ — distinct from a plain failure (S7).                                                             |
| Deployment whose rollback itself failed                                                           | `deploy_failed`                  | `{outcome}` = _rollback failed_; this is the outcome the chip renders, and it is an APW-06 outcome, not a state of this epic. |
| Deployment `CANCELED`                                                                             | `built`                          | FR-34: a cancelled Deployment returns the state to `built`.                                                                   |
| Deployment `SUPERSEDED`, or a newer queued Deployment exists                                      | unchanged; the newer row decides | FR-34 — a replaced Deployment never changes a delivery state (owner fact, 2026-09-17).                                        |
| Provider lacks `isAncestorCommit`, and no exact-sha containing Build exists                       | `merged` (held)                  | §8.2: never claim live without proof.                                                                                         |
| Task already `live`, `closed_without_deploy`, or `Done`                                           | unchanged                        | `live` is terminal for the Task; carry-along only closes _other_ Tasks (S23, S24).                                            |

A `follow-up` is opened only from `build_failed` and `deploy_failed` (FR-36), never from `cancelled`,
`SUPERSEDED` or `live`-with-warnings (FR-40) — and **recording a Deployment never changes a delivery state on its
own**: only the rows above do, and every write is the compare-and-set of §6.

### 2.5 Protected paths and size (FR-20…FR-28)

`AppChangeGuard.evaluate({ work, rules, baseRef, headRef })` calls
`git.getCompareDiff(owner, repo, baseRef, headRef, { maxFiles: 300, maxBytes: 0 })`. Refuse when
`totalFiles >= 300` **or** `files.length < totalFiles` — never merely because `truncated` is set (APW08-G06).
`capDiffFiles` sets `truncated` for **two** different reasons: dropping whole file entries, and dropping **patch
text** past the byte budget, whose default is 256 KiB
([`git-provider.pr-insights.ts`](../../../../../packages/plugin/src/contracts/capabilities/git-provider.pr-insights.ts) `:22`, `:86-97`, `:114-140`).
A five-file change carrying a large lockfile patch would therefore have been refused with the copy "over 300 files",
although lockfiles are excluded from size (FR-25) and FR-51 plans dependency-update Tasks — exactly the changes this
guard must not block. This guard needs **paths and counts only**, so it asks for no patch text at all
(`maxBytes: 0`, which `resolveDiffCaps` clamps to `>= 0`) and ignores `truncated` unless the file list itself is
short. `HARD_DIFF_MAX_FILES = 300` (`:29`) means `maxFiles: 300` is the platform ceiling and the GitHub compare API
lists at most 300 files, so a change of exactly 300 is indistinguishable from a larger one — which is why FR-21's
wording is "300 or more". Match each `path` **and**
`previousPath` against `rules.protected ∪ ['.github/workflows/**']` with a glob matcher (minimatch, `dot: true`,
no brace expansion from repository input beyond the matcher's defaults); App spec protected paths go through
APW-03's `isProtectedPath(spec, path)` so both epics match globs identically. App spec field protection: when
`.works/works.yml` is in the diff, read `AppSpecService.getEffectiveSpec(workId, baseSha)` and the head version
(`getFileContent(…, headRef)` validated by `AppSpecService.validateDraft`) and call APW-03's
`diffGuardedSpecBlocks(before, after)`; refuse on `source`, `license`, `blueprint`, and on removals from
`display.protectedPaths` / `agents.requireHumanMergePaths` (removal reporting requested in CONTRACTS §1). An
invalid head spec is itself a refusal. Size = Σ(additions + deletions) over non-lockfile
files. Called from `finalizeRun` (before `openPullRequestForBranch`) and `finalizeRemotePush` (same place).
Refusal → `branchState` stays `pushed`, Task → `BLOCKED`, `postSystemMessage` with the exact copy.

**The cloud path is judged before the push, and is off by default (owner decision 2026-09-25, `86e1a3ddf`).**
`TaskWorkspaceService.finalizeRun` no longer pushes an App Work branch before the change gate judges it. For an App
Work with the gate bound, the cloud (API-side) run is committed locally (`push: false`), and then:

- **Default — refused.** Until FR-12's isolated-run admission (T12) lands, cloud App Work pushes are off: nothing is
  pushed, no pull request is opened, and the Task is blocked (`blocked-by-guard`) with a message naming FR-12 / T12
  and the two ways forward (an enrolled Fleet node, or an operator allowing cloud pushes).
- **`APP_WORKS_CLOUD_PUSH_ENABLED=true`** (exactly `'true'`, read per call through
  `config.everWorks.apps.cloudPushEnabled()` from the API process's environment, never captured at import; a changed
  value takes effect when the API restarts or is redeployed) turns on judge-before-push:
  `WorkspaceFacadeService.branchChanges` reads the merge-base diff paths (`--no-renames`, both sides of a rename) and
  the committed `.works/works.yml` blob at the local head sha; `AppWorkChangeGate.checkPaths` judges them with the
  Task's labels (`AppWorkChangePathsInput.taskLabels`, the same app-provision parity as `evaluate`);
  `finalize({ push: true, publishSha })` publishes exactly the judged sha and never runs `add -A` again, and
  `finalizeRun` throws — recording neither `pushed` nor a pull request — when the provider reports any other head.
  The post-push `evaluate` (size rule plus provider diff) and the pull-request tail are unchanged.
- sandbox-workspace and local-workspace implement `branchChanges` and `publishSha`, and read git objects literally
  (`--no-replace-objects -c core.commitGraph=false`, `GIT_GRAFT_FILE` pointed at a non-existent path, and
  `--ignore-submodules=none`), so a replace ref, a graft, a forged commit-graph or a submodule ignore setting cannot
  make the judge read something other than what `git push` sends; a planted graft fails closed. A provider without
  `branchChanges` is refused by the facade, so with the switch on a stale plugin dist blocks every cloud App Work
  finalize rather than pushing unjudged.
- Fleet paths are unchanged: a node still pushes before the platform judges the branch, with a `contents: write`-only
  push credential, and the merge gate re-judges the head.
- **One gate for every cloud publisher (2026-09-26, `cab3419e5`).** The switch has one reader
  (`config.everWorks.apps.cloudPushEnabled()`, `packages/agent/src/config/index.ts:1097`) and one gate,
  `appWorkCloudPushAllowed(kind)`, with its refusal text `appWorkCloudPushRefusal(consequence)`
  (`packages/agent/src/tasks-domain/app-work-cloud-push.ts`). Its only callers are the two API-side publishers:
  `TaskWorkspaceService.finalizeRun` (`task-workspace.service.ts:1698`, refusal at `:3229`) and the agent git tools in
  the `AGENT_GIT_FACADE` adapter (`apps/api/src/agents/agents.module.ts`, `assertAppWorkCloudPushAllowed`: `:1165` in
  `commitToRepo`, `:1443` in `openPullRequest`). With the switch off, both tools refuse an App Work before any
  provider, policy or git call and before the change gate, with `finalizeRun`'s FR-12 / T12 text. `commitToRepo`
  writes, commits and pushes nothing. `openPullRequest` opens no pull request: opening one runs the repository's
  `pull_request` workflows, so it is held like `finalizeRun`'s. With the switch on, the tools keep their judgement.
  `commitToRepo` refuses the base branch and judges the call's own files and content with `checkPaths` before it
  writes and pushes `refs/heads/<branch>` (`:1395`). `openPullRequest` runs `evaluate` on the verified head (`:1549`)
  before `createPullRequest` (`:1568`). The Fleet path never asks the gate: `AGENT_GIT_FACADE` is bound only in the API
  process (`:839`), and a node pushes with its own credential and is judged by `finalizeRemotePush` /
  `judgeAppWorkBranch` / the merge gate. Other Work kinds pass without the switch being read. The evolve loop does not
  use either tool (§2.3, "Finalize, not tools").
- **Residual (switch on).** `commitToRepo` judges each call's own delta (`checkPaths` over the paths and content it
  writes), not the branch. It pushes the local ref `refs/heads/<branch>` of the shared per-Work checkout
  (`agents.module.ts:1395`) after `switchBranch` checks out an existing local branch as it is (`:1304`), so commits
  already on that local branch are pushed without being judged again. Platform code only ever puts judged commits
  there. A cloud run whose model has a shell on the API host (the local-workspace plugin keeps its worktrees on that
  host, by default under `tmpdir()/ew-local-workspaces`) can plant commits in that checkout; that is T12 containment.
  The whole branch is judged only at `openPullRequest`'s `evaluate` and at the merge gate. Closing it in code needs a
  local-commit read in the git facade, so that the tool refuses a push whose new commit is not a direct child of the
  remote tip (or of the base, for a new branch).
- **Website-template sync never targets an App Work (2026-09-26, `08c05ee78`), whatever the switch says.** An App
  Work's `website` role is its Work Repository, so the template pipelines used to reach it with the platform
  credential: `WebsiteUpdateService.updateRepository` force-pushes (`website-update.service.ts:308`, `:377`), syncs
  every template branch (`:150`) and re-points the default branch (`:151`); `WebsiteGeneratorService.initialize`
  force-pushes (`website-generator.service.ts:161`) and then syncs branches with `cleanupExtraBranches`. Callers:
  `POST /api/works/:id/update-website` (MCP `update_website`, including a Fleet node's run token on `/api/works`),
  `switch-website-template`, the hourly `WebsiteTemplateSchedulerService`, `DeployService`'s dispatch fallback
  (`deploy.service.ts:2043`; App Works take `deployAppWork` first, `:315`), generation and import. None of it is an
  agent push, so the switch does not apply; instead both funnels refuse the kind through
  `assertNotAppWorkTemplateTarget` (`packages/agent/src/works/repository-work-guard.ts`) before any provider or git
  call (`website-update.service.ts:84`, `website-generator.service.ts:231`, entry
  `work-generation.service.ts:1038`), and the scheduler skips App Works (`website-template-scheduler.service.ts:70`).
- **Residual (recorded, not closed).** Both judgements — pre-push `branchChanges` and the post-push compare — use
  merge-base semantics, the pull request's view. A head cut from an **old** ancestor of the base is judged only by
  what it changed since that ancestor, so a workflow file that the ancestor carried and the base later removed can be
  published unnamed, and an `on: push` trigger in it runs on the push. Closing it needs a history-free comparison of
  the protected paths against a trusted remote task-branch tip, which neither the workspace contract nor the handle
  carries today (candidate: the tip sha on `WorkspaceHandle` at provision time, plus a protected-path tree check in the
  gate; or a history-free comparison of the protected globs only, `--no-replace-objects diff-tree -r --name-only`
  from the base sha to the head sha, limited to paths whose head content also differs from the remote Task branch, so
  a reused branch is not falsely refused). The post-push compare also still names the branch, not the sha
  (`guardAppChange`'s docstring).

**`maxPullRequestChangedFiles` is honoured, not dropped (APW08-G22).** APW-03's schema §18 declares
`agents.maxPullRequestChangedFiles` (default 50, 1–500) and no epic enforces it, while FR-21 uses 300 files.
Removing the field would be a removal (R-26), so `AppChangeGuard` **enforces both, as two different things**: the
shared hard ceiling is 300 files (the provider's list limit, FR-21, refused when the list cannot be read in full),
and the App spec's own `maxPullRequestChangedFiles` is the **guidance-and-refusal** the app sets for itself — a
change over it opens the pull request with the size note (`appRules.overFileGuidance: "Over the file guidance:
{count} of {limit} changed files."`) and a change over `3 ×` it is refused exactly as the line guidance is, on
FR-27's shape. `AppWorkRulesService` carries the value alongside `sizeGuidance` (plan §2.1, §3.4). It defaults to
50, so an App Work that never sets it gets the schema's default and never the guard's silence.

### 2.6 Keeping Work columns in step with the App spec

A listener on APW-03's in-process `AppSpecAppliedEvent` (`app.spec.applied`) sets, idempotently:
`taskIsolation = 'worktree'`, `taskIsolationBaseBranch = <source branch>` (read through
`AppSpecService.getEffectiveSpec(workId, event.commitSha)`; when the applied spec omits `source.branch` — it is
optional in APW-03's schema — the listener uses `WorkAppSpecState`'s tracked branch and falls back to the Work
Repository's default branch, §2.4), `taskIsolationTargetRepo = 'website'`, **`checksPolicy = 'required'`** when the
applied spec declares at least one `required: true` check (the column is left untouched otherwise, so an owner's own
`'warn'` survives) and **`repoDeclaredCommands = { mode: 'allowlist', allow: <the existing list, empty by default> }`**
— see §2.3's "The Work's own switches must be on" (APW08-G02). All six are written in **one** ownership-scoped
update, and every one of them is additive: a Work that already carries a wider allow-list keeps it, and no other
Work kind is touched.
`resolveTaskIsolation`
returns `'on'` for `work.kind === 'app'` regardless of `task.isolationMode`, and the dispatch path refuses an App
Work Task whose Agent lacks `canCommitToRepo` (FR-9) instead of silently running without a workspace.

Re-applying an App spec **notifies the owner once per spec hash** when the `checks` list changes — the FR-14
promise, which no task implemented (APW08-G19) — through the existing Task-notification path, deduplicated on the
applied spec hash so a no-op re-application notifies nobody (T51). The App Checks admission card (T14) is what the
notification links to; a Fleet node missing a tool a check needs is classified there too (§2.3).

### 2.7 Goals and Missions

- **Goals.** `goals.workId` (nullable). `applyDispatch` passes `workId: goal.workId ?? null` to
  `tasksService.create`. `advanceOne` computes `pullRequestsAwaitingMerge` = iteration Tasks of this Goal in
  `in_review` with `prState = 'open'`; `GoalLoopInput` gains optional `pullRequestsAwaitingMerge` counted into
  `runsInFlight` with new reason code `awaiting-merge`. A missing Work → `pause` with reason `work-unavailable`.
- **Missions (decision).** Path chosen: **a Mission output mode that files Tasks directly** —
  `missions.outputMode ∈ {ideas, tasks, both}`. Rejected: _Mission tick → Idea with `targetWorkId` → accept as
  Task_. Reasons, from the code: (1) an Idea row requires Work-factory fields (`suggestedCategories`,
  `suggestedFields`, `slugSuggestion`) that mean nothing for "add a feature"; (2) building an Idea with
  `targetWorkId` calls `updateItemsGenerator`, which the `app` kind switches off, so a second branch in the
  executor would be needed; (3) that executor is behind `config.ideaBuildExecutor` and the account-level Work
  agent gate, unrelated to Tasks; (4) `Task.missionId` + `Task.workId` already model "raised by a Mission, belongs
  to a Work", and the Agent Workspace vocabulary settles that "a Mission is a source of Tasks". The new branch
  in `evaluateAndRun` runs after the Ideas branch (so `both` keeps today's behaviour first) and calls
  `MissionTaskPlannerService.plan(mission, work, relation)` → `AiFacadeService.askJson` (the same facade
  `WorkProposalService` uses) with a fenced, untrusted block for Task titles and Work description.
- **Template.** `MissionsService.create` calls `MissionTemplateManifestService.applyDefaults` when
  `missionTemplateRepo` resolves (closing the no-caller gap), and the manifest schema learns additive keys
  `defaults.outputMode`, `defaults.taskOutput`, `appWork`, `suggestedGoals`.
  `templateInputs { product, business, appWorkId }` on create attach the `improves` relation and create the draft Goals
  (§3.4).

### 2.8 The agent-resolution rule (FR-9, FR-42 — Resolution R-21)

`packages/agent/src/app-works/app-work-agent-resolver.ts` _(new)_ exports `AppWorkAgentResolver` and the token
`APP_WORK_AGENT_RESOLVER`:
`resolve({ userId, workId }): Promise<{ agentId: string; source: 'recent-task' | 'pinned' | 'assigned' } | null>`.
First match wins:

1. the `agentId` of the most recently updated Task on the Work
   (`TaskRepository.findByUserIdFiltered(userId, { workId, status: [in_review, done] })`) whose Agent still exists;
2. else the only Agent from `AgentRepository.findByUserIdScoped(userId, { scope: 'work', workId })`;
3. else the only Agent from `AgentRepository.findByUserIdScoped(userId, { assignedWorkId: workId })`.

A candidate that is archived or has `canCommitToRepo === false` is skipped. `null` means "no Agent".

Consumers: `AppChangeRequestService` (the `evolve` endpoint and chat, T25 — `null` → `409 agentRequired`) and
APW-02's conflict Task creation (`AppUpstreamStateService.recordConflict`, APW-02 plan §6.5), which replaces its
own pinned/assigned lookup with this resolver: a result → `TasksService.create({ …, agentId })` (started as
APW-02 specifies); `null` → the Task is created with `agentId: null`, not dispatched, and APW-02 sends one
`NotificationService` notification to the owner (copy `appRules.noAgentResolved`). The resolver is pure over
repository reads and holds no state.

**The token must actually be bound, in a module APW-02 can see (APW08-G18).** APW-08 registers its services in
`TasksDomainModule` ([`tasks.module.ts`](../../../../../packages/agent/src/tasks-domain/tasks.module.ts)) while
APW-02 creates `packages/agent/src/app-works/app-works.module.ts` and injects `APP_WORK_AGENT_RESOLVER` as
`@Optional()` into `AppUpstreamStateService` (APW-02 tasks T15 `:231`, T19 `:317-319`). Nothing in either task list
provides `{ provide: APP_WORK_AGENT_RESOLVER, useExisting: AppWorkAgentResolver }` in a module `AppWorksModule`
imports, and an unbound `@Optional()` token resolves to `undefined` — so APW-02's null-agent branch would run
silently and ACC-08-32 / ACC-02-11 would pass without the resolver ever being consulted. T25 therefore states the
wiring explicitly: `AppWorkAgentResolver` and the token are provided in
`packages/agent/src/app-works/app-works.module.ts`, and `AppWorksModule` does **not** import `TasksDomainModule`
(which would close a cycle via `TaskTransitionService`); the resolver's own dependencies are repository providers
only. A module-compilation test asserts the injected token is **defined** — not merely that the module compiles.

**No Agent at all — the Blueprint path (GAP-14; FR-42, S32).** A Blueprint-created App Work has no prior Task (no
provisioner ran) and nothing in APW-01, APW-03 or APW-08 assigns it an Agent, so the resolver returns `null` and
S25's card would offer an empty picker. When the rule finds nothing, `AppChangeRequestService` asks
`AgentRepository.findByUserIdScoped(userId, { canCommitToRepo: true })`; when that is empty too, the `409` carries
`{ code: 'agentRequired', createFromTemplate: { templateSlug, reason: 'noCommittableAgent' } }` and the web card
offers one action — **Create and start** — which calls the existing agent-creation path with the named catalog
template, binds `evolve-app` at Work scope, assigns the Agent to the Work and then creates the Task, in a single
round trip. Nothing is created without that explicit click, and when the person already owns a committable Agent the
S25 picker is unchanged (T25).

---

## 3. Data model

**Workspace backup (Resolution R-25).** The new `tasks`, `goals` and `missions` columns need no backup change — `Task` already exports as `data/tasks/tasks.jsonl`, `Goal` and `Mission` as `data/missions/goals.jsonl` and `missions.jsonl` — and none of their names is secret-shaped.

### 3.1 `tasks` — six additive columns (P1)

| Column                 | Type               | Default | Why                                                                                            |
| ---------------------- | ------------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `mergeCommitSha`       | `varchar(64) NULL` | `NULL`  | The commit a Build/Deployment must contain.                                                    |
| `deliveryState`        | `varchar(24) NULL` | `NULL`  | One of `TASK_DELIVERY_STATES`; `NULL` = not tracked (every existing Task, every non-app Task). |
| `deliveryBuildId`      | `uuid NULL`        | `NULL`  | The `work_builds.id` that decided the current state. No FK (cross-epic table).                 |
| `deliveryDeploymentId` | `uuid NULL`        | `NULL`  | The `work_deployments.id` that decided it. No FK.                                              |
| `deliveryUpdatedAt`    | `timestamptz NULL` | `NULL`  | Reconciler ordering and "stale" detection. `PortableDateColumn`.                               |
| `deliveryClosedById`   | `uuid NULL`        | `NULL`  | Who chose **Close anyway**.                                                                    |

Indexes: `idx_tasks_delivery_due (deliveryState, deliveryUpdatedAt)`;
`uq_tasks_work_merge_commit (workId, mergeCommitSha)` UNIQUE partial `WHERE "mergeCommitSha" IS NOT NULL` — makes
"merge recorded once" (S29) a database guarantee (on MySQL the plain unique index of §3.5 — same guarantee, see
APW08-G17).

**Added 2026-09-17 (APW08-G23), in migration slot `03`, not among the six above:** `followUpKey varchar(120) NULL`
plus `uq_tasks_follow_up_key` UNIQUE — the **server-side** dedup key for automatic follow-up Tasks, so one failure
record opens one follow-up without relying on a user-editable Task label (see §6). NULL for every existing row and
for every Task that is not an automatic follow-up.

### 3.2 `goals` — one column (P2)

`workId uuid NULL` + `idx_goals_work (workId)`. No FK and no `@ManyToOne` (the entity's cycle-avoidance rule);
deletion is detected by the orchestrator (S26).

### 3.3 `missions` — three columns (P2)

| Column               | Type                  | Default   |
| -------------------- | --------------------- | --------- |
| `outputMode`         | `varchar(8) NOT NULL` | `'ideas'` |
| `taskOutput`         | `simple-json NULL`    | `NULL`    |
| `taskOutputNoticeAt` | `timestamptz NULL`    | `NULL`    |

`taskOutput`: `{ tasksPerTick: 1..3 (1), openTasksCap: 1..10 (3), agentId?: uuid }`. Read through
`normalizeMissionTaskOutput` on every use (fails toward the defaults).

### 3.4 Shared types — `packages/contracts/src/apps/task-delivery.types.ts` _(new)_

```ts
export const TASK_DELIVERY_STATES = [
	'merged',
	'building',
	'build_failed',
	'built',
	'deploying',
	'deploy_failed',
	'live',
	'closed_without_deploy'
] as const;
export type TaskDeliveryState = (typeof TASK_DELIVERY_STATES)[number];

export interface TaskDeliveryView {
	taskId: string;
	state: TaskDeliveryState | null;
	mergeCommitSha: string | null;
	pullRequest: { number: number; url: string; base: string; mergedAt: string | null } | null;
	build: { id: string; number: number | null; status: string; commitSha: string; logsUrl: string | null } | null;
	deployment: { id: string; number: number | null; status: string; outcome: string | null } | null;
	liveUrl: string | null;
	liveWithWarnings: boolean;
	carriedByLaterChange: boolean;
	followUps: Array<{ taskId: string; slug: string; status: string; automatic: boolean }>;
	history: Array<{ state: TaskDeliveryState; at: string; activityId: string | null }>;
}

export interface TaskCostView {
	runs: Array<{ runId: string; costCents: number | null; receiptUrl: string }>;
	builds: Array<{
		buildId: string;
		runnerMinutes: number | null;
		payer: 'github' | 'ever-works';
		costCents: number | null;
	}>;
	totalCents: number | null; // null when any Ever Works-billed amount is unknown
}

export const APP_CHECKS_MAX = 20;
export const APP_INSTRUCTION_FILES_MAX = 5;
export const APP_INSTRUCTION_FILES_SCHEMA_MAX = 10; // APW-03 schema §18; files 6–10 are read-not, and reported
export const APP_CHECK_TIMEOUT_SECONDS_MIN = 60; // APW-03 schema §17 owns these bounds (APW08-G22)
export const APP_CHECK_TIMEOUT_SECONDS_MAX = 7_200;
export const APP_CHECK_TIMEOUT_SECONDS_DEFAULT = 1_800;
export const APP_INSTRUCTION_FILE_MAX_BYTES = 32 * 1024;
export const APP_INSTRUCTION_FILES_TOTAL_MAX_BYTES = 64 * 1024;
export const APP_PR_SIZE_GUIDANCE_DEFAULT = 500;
export const APP_PR_SIZE_GUIDANCE_MIN = 50;
export const APP_PR_SIZE_GUIDANCE_MAX = 5_000;
export const APP_PR_SIZE_HARD_MULTIPLIER = 3;
export const APP_PR_FILES_GUIDANCE_DEFAULT = 50; // APW-03 schema §18 `agents.maxPullRequestChangedFiles`
export const APP_DIFF_FILES_MAX = 300;
export const APP_FOLLOW_UPS_PER_CHANGE_MAX = 2;
export const APP_FOLLOW_UPS_OPEN_PER_WORK_MAX = 3;
export const APP_FAILURE_LOG_TAIL_LINES = 200;
export const APP_DELIVERY_RECONCILE_BATCH = 200;
export const APP_COMMIT_LOCK_WAIT_MS = 120_000;
export const APP_LOCKFILE_BASENAMES = [
	'yarn.lock',
	'package-lock.json',
	'pnpm-lock.yaml',
	'bun.lockb',
	'Cargo.lock',
	'go.sum',
	'poetry.lock',
	'composer.lock',
	'Gemfile.lock'
] as const;
export const MISSION_OUTPUT_MODES = ['ideas', 'tasks', 'both'] as const;
```

Added 2026-09-17 (additive; no existing constant changes value or name):

```ts
/** FR-69 — the tool groups an App Work run never receives. Resolved to tool names by
 *  AgentToolService; APW-09 consumes this list rather than declaring its own. */
export const APP_WORK_TASK_DENIED_TOOL_GROUPS = [
	'outbound-messaging',
	'web-fetch',
	'mcp',
	'sub-agent',
	'app-works-mutation'
] as const;
/** The one tool the policy always re-allows, whatever else it denies. */
export const APP_WORK_TASK_ALWAYS_ALLOWED_TOOLS = ['ask_human'] as const;

/** FR-70 — what a Fleet run reported about its own containment. */
export interface AppWorkRunContainment {
	executionPath: 'hardened' | 'ordinary';
	isolatedHome: boolean;
	downgrades: Array<{ control: string; reason: string }>;
	/** True when isolatedHome is false or an `isolated-home` downgrade is present. */
	needsOwnerAllowance: boolean;
}

/** FR-61/FR-72 — the exit codes a check reports when a tool is missing, per platform. */
export const APP_CHECK_MISSING_TOOL_EXIT_CODES = [127, 9009] as const;

/** FR-72 — read from CONTRACTS §2A's shared limits table; never a number local to this epic. */
export const APP_REPO_SIZE_LIMIT_SOURCE = 'packages/contracts/src/apps/apps-limits.ts' as const;
```

Additive contract changes elsewhere: `TaskCheckResult.status` gains `'not-admitted'`
([`packages/contracts/src/tasks/task-gates.types.ts`](../../../../../packages/contracts/src/tasks/task-gates.types.ts));
`AgentEscalationReasonCode` gains `'delivery-failed'` (prior `0.85` in `REASON_PRIOR`); `GoalLoopReasonCode` gains
`'awaiting-merge'` and `'work-unavailable'`; `ActivityActionType` gains one family `APP_CHANGE = 'app_change'`
(Resolution R-2): every row has `actionType = 'app_change'` and `action` = the dotted CONTRACTS §6 event
(`app.change.merged`, `app.change.live`, `app.change.failed`, `app.change.closed`, `app.change.follow_up_opened`);
`details` carry ids, shas and state names only. `ActivityTypeBadge` maps `app_change` → `appChange`. Added
2026-09-17 (APW08-G21): the family gains one further dotted action, **`app.mission.nothing_to_file`** (`actionType`
`app_change`), which is the entry FR-54 records once per Mission per day when a tick files nothing, and the one
`mission-task-output` writes — the earlier draft named no action, so the entry could not be written at all. The
register row is CONTRACTS §6's APW-08 line (shared-file request, not an edit here).

The file sits in `packages/contracts/src/apps/` — the one folder for every App Works shared type (Resolution R-1) —
and is exported from `packages/contracts/src/apps/index.ts` (created by APW-03 T1).

### 3.5 Migrations (Constitution V, forward-only, reserved block `179208<slot>00000`)

| Slot | File                                                                     | Phase | `up()`                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00   | `apps/api/src/migrations/1792080000000-AddTaskDeliveryState.ts` _(new)_  | P1    | six `ADD COLUMN` on `tasks`; `idx_tasks_delivery_due`; partial unique `uq_tasks_work_merge_commit`.                                                                                                                                                                                                                                               |
| 01   | `apps/api/src/migrations/1792080100000-AddGoalWorkScope.ts` _(new)_      | P2    | `ADD COLUMN "workId" uuid NULL` on `goals`; `idx_goals_work`.                                                                                                                                                                                                                                                                                     |
| 02   | `apps/api/src/migrations/1792080200000-AddMissionTaskOutput.ts` _(new)_  | P2    | `outputMode varchar(8) NOT NULL DEFAULT 'ideas'`, `taskOutput text NULL`, `taskOutputNoticeAt` on `missions`.                                                                                                                                                                                                                                     |
| 03   | `apps/api/src/migrations/1792080300000-AddTaskChatMessageKey.ts` _(new)_ | P1    | `messageKey varchar(64) NULL`, `messageParams simple-json NULL` on `task_chat_messages`; `authorId` made **nullable** (widening only — every existing row keeps its value) together with a `system` `authorType`; a `followUpKey varchar(120) NULL` column plus `uq_tasks_follow_up_key` UNIQUE on `tasks` for APW08-G23's server-side dedup key. |

**Primary-branch refusal marker (added 2026-09-25, `86e1a3ddf`).** `tasks.branchGuardRefusal` (text, nullable;
migration `apps/api/src/migrations/1792110100000-AddTaskBranchGuardRefusal.ts`, stamped after APW-11's
`1792110000000` by coordinator direction because this block's slots 00–03 stay reserved for the migrations above; one
`ADD COLUMN`, no index, no backfill). `refuseChange` records the refusal text (capped at 4,000 characters) only when
the refused change reached the remote: the post-push gate, or a node reporting a branch that is not the Task's own. A
refusal before the push (cloud judge-before-push, or cloud pushes off — §2.5) neither writes nor clears it. It is
cleared when a later full-branch judgement allows the branch, and on discard. The Task page's branch panel shows it as
a refusal banner (`TaskBranchSection`, `task-guard-refusal-banner`), hidden once the branch is merged, cleaned or
discarded, or the pull request is merged. Linked (non-primary) repositories carry the same fact per entry
(`TaskLinkedPullRequest.refusedByGuard`).

`down()` drops only what `up()` added. Every column guarded with `table.findColumnByName` like
`1789900000000-AddWorkRepoDeclaredCommands.ts`, so re-runs are no-ops. SQLite: the partial unique index uses the
same `WHERE` syntax (supported); timestamps via `TIMESTAMP WITH TIME ZONE` on Postgres and `datetime` on SQLite,
branching on `queryRunner.connection.options.type`. P0 has **no migration**. Re-stamp before merge if `develop`
has moved past `1791240000000` (newest on `ee45946e5`; still below this epic's `179208…` block).

**MySQL and MariaDB are supported drivers — the delivery SQL must be portable (APW08-G17).** `DatabaseType` is not
two-valued: `'mysql' | 'mariadb'` are first-class
([`database.config.ts`](../../../../../packages/agent/src/database/database.config.ts) `:33-34`, normalized to the
`mysql` driver at `:208`), and a later commit fixed exactly this class of Postgres/SQLite-only SQL in the activity
feed repository, whose spec now runs every case under `describe.each(['mysql', 'mariadb'])`
([`activity-log.repository.feed.spec.ts`](../../../../../packages/agent/src/database/repositories/activity-log.repository.feed.spec.ts) `:183-190`).
Two things in this plan are not portable as first written, so both get a driver branch:

1. **Compare-and-set (§6).** `"deliveryState" IS NOT DISTINCT FROM :from` is Postgres/SQLite. MySQL's null-safe
   equality is `<=>`, so the write is built once per driver —
   `<=>` on `mysql`, `IS NOT DISTINCT FROM` on `postgres`/`sqlite` — or, if one statement is preferred, the portable
   `("deliveryState" = :from OR ("deliveryState" IS NULL AND :from IS NULL))`. All three spell the same predicate
   and the existing `insertion-order.ts` helper is the precedent for keeping one query text per driver.
2. **The "merge recorded once" index (§3.1).** MySQL has **no partial (filtered) indexes**, so
   `uq_tasks_work_merge_commit … WHERE "mergeCommitSha" IS NOT NULL` cannot exist there. On `mysql` the migration
   creates the plain unique index `(workId, mergeCommitSha)` — MySQL treats multiple `NULL`s in a unique index as
   distinct, so rows with no merge commit do not collide and the guarantee is **stronger**, not weaker — and the
   service additionally takes the application-level lock of §6 before the first write, so the once-only rule holds
   even on a driver where the index is redundant rather than load-bearing. S29's guarantee is therefore a database
   guarantee on all four drivers, and the migration spec (T9) and T21 both run MySQL cases.

---

## 4. API

All routes are JWT-guarded, scoped with `@CurrentUser()`, check Work access through `WorkOwnershipService`
(`ensureCanView` for reads, `ensureCanEdit` for writes), and answer **404** for another account's ids.

| Method         | Path                                            | Controller                                             | Body / query                                                                | Returns                                            | Throttle          |
| -------------- | ----------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------- | ----------------- |
| `POST`         | `/api/works/:id/evolve`                         | `apps/api/src/works/work-evolve.controller.ts` _(new)_ | `EvolveWorkDto { request (1–4000), agentId?, attachmentUploadIds? (≤ 10) }` | `202 { taskId, taskSlug, runId \| null, agentId }` | 10 / min per user |
| `GET`          | `/api/tasks/:id/delivery`                       | `apps/api/src/tasks/tasks.controller.ts`               | —                                                                           | `TaskDeliveryView`                                 | default           |
| `POST`         | `/api/tasks/:id/delivery/close`                 | same                                                   | `{ note? (≤ 500) }`                                                         | `TaskDeliveryView`                                 | 30 / min          |
| `POST`         | `/api/tasks/:id/delivery/follow-up`             | same                                                   | `{ escalationId }`                                                          | `202 { taskId }`                                   | 10 / min          |
| `GET`          | `/api/tasks/:id/cost`                           | same                                                   | —                                                                           | `TaskCostView`                                     | default           |
| `POST`         | `/api/works/:id/app-runs/allow-containment`     | `apps/api/src/works/work-evolve.controller.ts` _(new)_ | `{ nodeId, allow: boolean }`                                                | `204`                                              | 10 / min          |
| `GET`          | `/api/works/:id/cost` (added 2026-09-17)        | `apps/api/src/works/work-evolve.controller.ts` _(new)_ | `?month=` (optional, `YYYY-MM`)                                             | `WorkCostRollup` (spend, cap, remaining, alert)    | default           |
| `GET`          | `/api/tasks` (extended)                         | same                                                   | `deliveryState?`, `includeDelivery?`                                        | rows gain `delivery: { state, liveUrl } \| null`   | unchanged         |
| `POST`/`PATCH` | `/api/me/goals`, `/api/me/goals/:id` (extended) | `apps/api/src/goals/goals.controller.ts`               | `workId?: uuid \| null`                                                     | Goal DTO gains `workId`, `workName`                | unchanged         |
| `PATCH`        | `/api/me/missions/:id` (extended)               | `apps/api/src/missions/missions.controller.ts`         | `outputMode?`, `taskOutput?`                                                | Mission DTO gains both                             | unchanged         |
| `POST`         | `/api/me/missions` (extended)                   | same                                                   | `templateInputs? { product (≤ 80), business (≤ 80), appWorkId }`            | unchanged                                          | unchanged         |

Error contract:

| Situation                                                                                 | Status | Body                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evolve` on a non-`app` Work                                                              | `422`  | `{ code: 'notAppWork' }`                                                                                                                                      |
| `evolve` with no resolvable Agent and none passed                                         | `409`  | `{ code: 'agentRequired', candidates: [{ id, name }] (≤ 20), createFromTemplate?: { templateSlug, reason } }` (GAP-14)                                        |
| `evolve` with no admissible runtime                                                       | `422`  | `{ code: 'noIsolatedRuntime' }`                                                                                                                               |
| `evolve` with no push credential for the repository owner                                 | `422`  | `{ code: 'noPushCredential', owner }` — the S28 copy (GAP-15, FR-75)                                                                                          |
| `evolve` while the operator's change switch is off                                        | `422`  | `{ code: 'changesPaused' }` (XC-10, FR-74)                                                                                                                    |
| `delivery/close` on a Task not in a failed/built state                                    | `422`  | `{ code: 'notClosable', state }`                                                                                                                              |
| `delivery/follow-up` past the chain limit (manual)                                        | `422`  | `{ code: 'followUpLimit' }` — the endpoints answers **one** status code for every refusal, and `{ escalationId }` is consumed once per Inbox item (APW08-G21) |
| `delivery/follow-up` with an `escalationId` already consumed or belonging to another Task | `422`  | `{ code: 'followUpLimit' }` — same code, so a client never has to guess                                                                                       |
| `app-runs/allow-containment` with an unknown `nodeId`                                     | `404`  | `{ code: 'notFound' }`                                                                                                                                        |
| Goal `workId` change while the loop runs                                                  | `409`  | `{ code: 'loopRunning' }`                                                                                                                                     |
| Mission `outputMode: tasks` with no app relation                                          | `200`  | accepted; `warnings: ['noAppWorkRelation']`                                                                                                                   |

The follow-up endpoint's body is `{ escalationId }` because the S22 Inbox item offers **Try once more** and
**once per Inbox item** cannot be enforced without naming the item (APW08-G21): the escalation row is the
one-shot token, so its consumption and the `409`/`422` disagreement of the earlier draft are both settled here.
CONTRACTS §4's row is updated by the shared-file request, not by this epic.

Chat registry row (generated tools), appended to [`registry.ts`](../../../../../apps/web/src/lib/ai/tools/generated/registry.ts):

```ts
{
  toolName: 'request_app_change',
  method: 'POST',
  path: '/api/works/{id}/evolve',
  summary: 'Ask an agent to change an App Work (creates a Task on it and starts a run).',
  kind: 'action',
  params: [id('Work id')],
  body: true,
  bodyHint: 'request (what to change, verbatim), agentId (optional).',
  requiresConfirmation: true,
  canvas: 'TaskDetail',
}
```

---

## 5. Web

### 5.1 Reuse the Task board — no "Changes" page (decision)

Every Work already has a Tasks tab (`/works/[id]/tasks`) and the Kanban card already carries branch, PR, run and
gate chips. A separate "Changes" page would list exactly the same Tasks under a second noun (program rule 2) and
split the filters. The App Work view is the Tasks tab with delivery chips, a **Delivery** filter and a **Request a
change** button in its header.

| Component                  | File                                                                    | Type   | Notes                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskDeliveryChips`        | `apps/web/src/components/tasks/TaskDeliveryChips.tsx` _(new)_           | client | Rendered after `GateChip` in `TasksKanbanView` and `TasksList` when `task.delivery` is present.                                                                                              |
| `TaskDeliverySection`      | `apps/web/src/components/tasks/TaskDeliverySection.tsx` _(new)_         | client | Timeline rows, follow-up links, **Close anyway**, **Deploy now** (links APW-06 deploy), **Create a fix Task**. Polls `GET /delivery` every 10 s while any state is non-terminal, max 30 min. |
| `TaskCostSection`          | `apps/web/src/components/tasks/TaskCostSection.tsx` _(new)_             | client | Runs + Builds receipts, total with unknown handling.                                                                                                                                         |
| `RequestChangeDialog`      | `apps/web/src/components/works/detail/RequestChangeDialog.tsx` _(new)_  | client | Textarea + Agent select (`apps/web/src/components/tasks/AgentSelect.tsx` reused) + cost note; calls `requestAppChangeAction`.                                                                |
| `DeliveryFilterSelect`     | `apps/web/src/components/tasks/TasksFilterSelects.tsx` (modified)       | client | Adds the Delivery select, only when the scope is an App Work.                                                                                                                                |
| `ChatChangeCard`           | `apps/web/src/components/ai/ChatChangeCard.tsx` _(new)_                 | client | Canvas-less inline card for `request_app_change` results; polls like `TaskDeliverySection`.                                                                                                  |
| `GoalForm` field           | `apps/web/src/components/goals/GoalForm.tsx` (modified)                 | client | Optional Work select, reusing `apps/web/src/components/tasks/WorkSelect.tsx`; disabled while running.                                                                                        |
| `MissionOutputCard`        | `apps/web/src/components/missions/MissionOutputCard.tsx` _(new)_        | client | Output radio, limits, attached App Works; mounted in `MissionDetailClient.tsx`.                                                                                                              |
| `MissionTasksOnWorksPanel` | `apps/web/src/components/missions/MissionTasksOnWorksPanel.tsx` _(new)_ | server | `tasksAPI.list({ missionId, includeDelivery: true, limit: 20 })`.                                                                                                                            |
| Template form              | `apps/web/src/components/missions/NewMissionForm.tsx` (modified)        | client | When `template=build-on-open-source-app`: Product, Business, App Work fields and the summary block.                                                                                          |
| `WorkCostSummary`          | `apps/web/src/components/works/detail/WorkCostSummary.tsx` _(new)_      | server | FR-73: month spend, cap, remaining and alert state from `GET /api/works/:id/cost`; links to a Task's Cost section.                                                                           |
| `ContainmentNotice`        | `apps/web/src/components/tasks/TaskRunContainmentNotice.tsx` _(new)_    | client | FR-70: the containment the run got, its downgrades, and **Allow on this machine**; rendered inside `TaskCostSection`.                                                                        |

Modified: `TaskDetailClient.tsx` mounts `TaskDeliverySection` above `TaskChecksSection` and `TaskCostSection` at
the end; `apps/web/src/app/[locale]/(dashboard)/works/[id]/tasks/page.tsx` passes `includeDelivery: true` and the
Work kind; `apps/web/src/lib/api/tasks.ts`, `goals.ts`, `missions.ts` grow the new fields and methods;
`apps/web/src/app/actions/tasks.ts` gains `closeDeliveryAction`, `openDeliveryFollowUpAction`,
`requestAppChangeAction`.

### 5.2 i18n

Keys under `apps/web/messages/en.json`, camelCase leaves, no literal dots; mirrored into the 20 sibling locale
files. Listings are paths through nested objects.

`dashboard.tasksPage.delivery`:

```
delivery.sectionTitle          "Delivery"
delivery.merged                "Pull request #{number} merged into {branch}"
delivery.build                 "Build #{number} of {shortSha}"
delivery.deployment            "Deployment #{number}"
delivery.liveAt                "Live at {url}"
delivery.chipMerged            "Merged ✓ · Waiting for a build"
delivery.chipBuilding          "Build ⟳"
delivery.chipBuildFailed       "Build failed ✗"
delivery.chipBuilt             "Built ✓ · Waiting for a deployment"
delivery.chipDeploying         "Deploying ⟳"
delivery.chipDeployFailed      "Deploy failed ✗ ({outcome})"
delivery.chipLive              "Live ✓"
delivery.chipLiveWarnings      "Live ✓ (with warnings)"
delivery.chipCarried           "Live ✓ (with a later change)"
delivery.chipClosed            "Closed without deploying"
delivery.notDeployedBranch     "Merged into {branch} — not deployed by this app"
delivery.deployNow             "Deploy now"
delivery.closeWithoutDeploying "Close without deploying"
delivery.closeAnyway           "Close anyway"
delivery.closeConfirm          "Close this Task even though its change isn't live? The failure stays on record."
delivery.keepOpen              "Keep open"
delivery.createFixTask         "Create a fix Task"
delivery.followUp              "Follow-up: {slug} {title} ({status})"
delivery.followUpCancelled     "No longer needed — a later deployment containing this change is live."
delivery.ariaBuildSucceeded    "Build succeeded"
delivery.ariaDeployFailed      "Deployment failed, {outcome}"
delivery.filterLabel           "Delivery"
delivery.filterAny             "Any"
delivery.filterWaiting         "Waiting to merge"
delivery.filterBuilding        "Building"
delivery.filterDeploying       "Deploying"
delivery.filterLive            "Live"
delivery.filterFailed          "Failed"
delivery.filterClosed          "Closed without deploying"
```

`dashboard.tasksPage.appRules`:

```
appRules.protectedPath         "This change edits a protected path: {paths}. Protected by {rule}. Ask the agent to leave it out, or change the App spec."
appRules.tooManyFiles          "This change touches too many files to verify protected paths (over 300)."
appRules.tooLarge              "This change is too large to review ({lines} changed lines; the limit for this app is {limit}). Split it into smaller Tasks."
appRules.overGuidance          "Over the size guidance: {lines} of {guidance} changed lines."
appRules.humanMergePath        "This change touches {path}, which only a person may merge on this app."
appRules.noIsolatedRuntime     "This app's code can only run on one of your machines or in an isolated sandbox, and none is set up."
appRules.setOneUp              "Set one up"
appRules.notAdmitted           "Not admitted — review this check before it runs on your machines."
appRules.reviewChecks          "Review checks"
appRules.noCommitPermission    "This agent can't commit, and changes to an app always go through a branch."
appRules.andMore               "…and {count} more"
appRules.missingTool           "Error — a tool this check needs is missing on this machine"
appRules.runHeld               "Waiting — agent runs are paused."
appRules.safetyRail            "A safety rule stopped this change ({rail}). Review it in your Inbox."
appRules.noAgentResolved       "No agent could be chosen for {work}. Assign one to start this Task."
appRules.overFileGuidance      "Over the file guidance: {count} of {limit} changed files."
appRules.containmentDowngrade  "This machine runs app changes without an isolated home. Allow it once, or run this Task in an isolated sandbox."
appRules.allowOnThisMachine    "Allow on this machine"
appRules.changesPaused         "Changes to apps are paused by the operator."
appRules.repoTooLarge          "This app's repository is too big to check out here ({size}; this stage allows {limit})."
appRules.noPushCredential      "Ever Works can't push to {owner}/{repo} from your machines. Install the Ever Works GitHub App on {owner}."
appRules.createAgentAndStart   "No agent can commit yet. Create one for {work}?"
appRules.createAndStart        "Create and start"
appRules.specInvalidAtBase     "The App spec on {branch} is invalid — fix it before starting changes."
appRules.diffUnreadable        "Couldn't verify this change's files. Try again."
```

`dashboard.activity.filters.types.appChange`: `"App change"` (the `ActivityTypeBadge` label for `actionType`
`app_change`).

`dashboard.tasksPage.cost`: `sectionTitle "Cost"`, `runs "Runs {count} · {amount}"`, `builds "Builds {count} · {minutes} runner minutes ({payer})"`, `paidByGithub "Paid by your GitHub account"`, `unknown "unknown"`, `total "Total {amount}"`.

`dashboard.workDetail.requestChange`: `button "Request a change"`, `title "Start a change on {work}?"`, `body "{agent} will work on it. An agent run will start; runs are billed to your workspace."`, `start "Start"`, `cancel "Cancel"`, `pickAgent "Which agent should work on {work}?"`.

`dashboard.goalNew.work`: `label "Work (optional)"`, `hint "Iterations become Tasks on this Work. Can't be changed while the loop runs."`, `unavailable "The Work this Goal was scoped to no longer exists."`, `awaitingMerge "Waiting for iteration {iteration}'s pull request to be merged or closed."`.

`dashboard.missionDetail.output`: `title "Output"`, `ideas "Ideas"`, `tasks "Tasks on attached App Works"`, `both "Both"`, `tasksPerTick "Tasks per tick"`, `openCap "Open Tasks cap per Work"`, `appliesTo "Applies to Works attached as Improves or Operates."`, `noAppWork "Attach an App Work as Improves or Operates to file Tasks on it."`, `tasksOnWorks "Tasks on attached Works"`, `nothingToFile "No attached App Work to file Tasks on."`.

`dashboard.missionsPage.buildOnApp`: `product "Product"`, `business "Business"`, `appWork "App Work"`, `summary "Every Monday 08:00 UTC · up to {count} Tasks a week · {amount} per run"`, `backlogNote "New Tasks wait in Backlog for your approval."`, `suggestedGoals "Suggested Goals (created as drafts):"`, `rules "Recommended app rules: schema changes merged by a person, {lines}-line PRs"`, `proposeRules "Propose these rules"`, `create "Create Mission"`.

Chat thread posts (`dashboard.tasksPage.deliveryPosts`): `runStarted`, `prOpened`, `checksPassed`, `checksFailed`, `merged`, `buildStarted`, `buildSucceeded`, `buildFailed`, `deploying`, `live`, `deployFailed`, `followUpOpened` — copy verbatim from spec §6.4. System posts are rendered from keys in the recipient's locale at read time; the stored message carries the key and params, never a pre-rendered English string.

---

## 6. Background work

| Job                        | Where                                                                                                                           | Trigger                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-change-delivery`      | `packages/tasks/src/tasks/trigger/app-change-delivery.task.ts` _(new)_                                                          | cron `1-59/2 * * * *`   | Offset by one minute from `task-pr-status-sync` (`*/2`) so a merge recorded on an even minute is reconciled on the next odd one. ≤ 200 Tasks/tick; per-Task isolation; idempotent (pure decision over current rows). Emits `app.change.delivery.sweep` counters.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mission-tick` (extended)  | [`packages/tasks/src/tasks/trigger/mission-tick.task.ts`](../../../../../packages/tasks/src/tasks/trigger/mission-tick.task.ts) | unchanged (`* * * * *`) | Task output branch inside `MissionTickService.evaluateAndRun` (`packages/agent/src/missions/mission-tick.service.ts`); behind the workspace-pause start check that AW-24 P3 (T34, not yet built) plans for that method.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Follow-up creation         | inside `app-change-delivery`                                                                                                    | —                       | Dedup on a **server-side key**, not a Task label (APW08-G23): `followup:<originalTaskId>:<failedBuildOrDeploymentId>` is checked before create — one follow-up per failure record. Labels are user-editable, so a label can never be the thing that stops a duplicate Task; and two uuids plus the prefix make 82 characters, over `@MaxLength(80, { each: true })` ([`tasks.dto.ts`](../../../../../apps/api/src/tasks/tasks.dto.ts) `:62-72`), so the label form would fail a later label update on that Task. The lineage itself is the existing `follow-up` Task relation; the marker lives in a dedicated column, so a user who edits or clears the Task's labels changes no behaviour. |
| `mission-tick` task output | inside `mission-tick`                                                                                                           | —                       | The once-per-day notice is `taskOutputNoticeAt` on `missions` plus one Activity entry `app.mission.nothing_to_file` — never a Task label (FR-54, APW08-G21).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Operator kill switch       | every dispatcher named here                                                                                                     | read at dispatch        | `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED` and the evolve switch (CONTRACTS §7) are read by `TaskTransitionService.dispatchAgentRun`, `app-change-delivery`, `MissionTickService.evaluateAndRun`, `GoalOrchestratorService.applyDispatch` and the merge hook — never only by a controller — and each **fails closed**: off means no new change run, no auto-deploy from a merge, no follow-up. Existing Tasks, boards, chains and history stay readable (FR-74, XC-10, T49).                                                                                                                                                                                                                       |

`APP_CHANGE_DELIVERY_DISPATCHER` is **not** needed: the reconciler is a scheduled task and the merge hook runs
inside the existing sweep. Evolve requests dispatch the run through `TaskTransitionService.dispatchAgentRun`, which
already routes through the job runtime (Constitution IV); the endpoint returns `202`.

Mutual exclusion: a reconcile write is built per driver (APW08-G17): on `postgres` and `sqlite`
`UPDATE tasks SET "deliveryState" = :to … WHERE id = :id AND ("deliveryState" IS NOT DISTINCT FROM :from)`, on
`mysql` the null-safe `<=>` form of the same predicate; a lost race is a no-op the next tick repeats.

**Keyed Task-thread posts (APW08-G12; FR-43).** §5.2 says a stored system post carries a key and params and is
rendered in the reader's locale. Nothing in the platform can store that today: `task_chat_messages` has `body text`
and a **NOT NULL** `authorId` uuid
([`task-chat-message.entity.ts`](../../../../../packages/agent/src/entities/task-chat-message.entity.ts) `:44-51`),
and `postSystemMessage(input, body: string)` posts `authorType: 'agent'` with `authorId = input.agentId`
([`task-workspace.service.ts`](../../../../../packages/agent/src/tasks-domain/task-workspace.service.ts) `:2340-2351`)
— so a reconciler post on a Task with no Agent (R-21's `agentId: null` branch) would have no author at all. T54 adds
two **nullable** columns `messageKey` and `messageParams` to `task_chat_messages` (migration slot `03` of §3.5),
keeps `body` populated with the pre-rendered English as the fallback for every existing reader (so no reader is
broken by the addition), makes `authorId` nullable **only** for `authorType = 'system'` rows and adds a `system`
actor type, and renders the stored `messageKey`/`messageParams` in the recipient's locale in the Task chat. The
`deliveryPosts` keys of §5.2 are the keys; the existing `postSystemMessage` callers keep working unchanged and are
**not** converted, so nothing that posts today changes its shape.

---

## 7. Plugin boundaries and cross-epic contracts

- **No new plugin package.** Everything goes through `GitFacadeService`, `WorkspaceFacadeService`,
  `AiFacadeService` and the APW-05/06 services.
- **`IGitProviderPlugin` additions (owner APW-08, CONTRACTS §3):**
  `GitPullRequestStatus.mergeCommitSha?: string | null` (GitHub `merge_commit_sha` in `getPullRequestStatus`);
  `isAncestorCommit?(owner, repo, ancestorSha, descendantSha, token): Promise<boolean | null>` (GitHub
  `compareCommitsWithBasehead`, `status ∈ {ahead, identical}` → true, `behind|diverged` → false, 404 → null).
  Facade: `GitFacadeService.isAncestorCommit`, returning `null` when the provider lacks it — the reconciler then only
  accepts exact-sha matches.
- **Requirement on APW-05 (Resolution R-9; implemented by T15 in APW-05's generator
  `packages/plugins/github-actions-build/src/workflow/generator.ts`):** a `checks` job on same-repository pull
  requests and on the tracked branch that is a **matrix with one leg per App spec check** (≤ 20, `fail-fast: false`,
  `max-parallel: 5`), each leg named `Ever Works check: {name}` and reporting its own check run, job
  `permissions: contents: read`, no secrets, `EW_` variables or cache, commands passed via env (base64-encoded),
  job-level `continue-on-error` for `required: false`, written for every build strategy, never changing a Build's
  status, deterministic output (§2.3; CONTRACTS §3 row). APW-05 FR-5 ("exactly one file") is honoured — the job lives in the same file.
- **Provided to APW-02 (Resolution R-21):** `APP_WORK_AGENT_RESOLVER` (§2.8) for the upstream sync conflict Task.
- **Consumed from APW-05/06:** `WorkBuild` (commit, branch, status, receipt ref), `WorkDeployment.buildId` +
  status/outcome + `smokeResult`; APW-06 FR-23 auto-deploy switch; `app.build.*` / `app.deploy.*` Activity.
- **Consumed from APW-03:** `AppSpecService.getEffectiveSpec` / `validateDraft`, `diffGuardedSpecBlocks`,
  `isProtectedPath`, `AppSpecAppliedEvent`.
- **Consumed from APW-04:** `IPipelinePlugin.enforcesRuntimeNetworking` — no plugin id in core.
- **Consumed from APW-06:** Deployment states `DEPLOYING`, `VERIFYING`, `ROLLED_BACK`, `SUPERSEDED` (a superseded
  Deployment never changes a delivery state — FR-34) and `WorkAppRuntimeState` deploy target / auto-deploy.
- **Owned by APW-08 and consumed by APW-09 (XC-05):** `APP_WORK_TASK_TOOL_POLICY` (§3.4, §2.3) — the one tool
  policy for a run over third-party code. APW-09's preparation and follow-up runs take it from here; APW-09 does not
  declare a second list. CONTRACTS §3's APW-08 row is extended by the shared-file request.
- **Owned by APW-08 and consumed by nothing else yet (XC-06, XC-10, XC-19, XC-29):** `AppWorkRunContainment` (§3.4),
  the evolve/auto-delivery kill switches (CONTRACTS §7 — shared-file request; this epic only reads them), the App
  Work's `WorkBudget` wiring (§4, FR-73) and the shared stage-limits table read from
  `packages/contracts/src/apps/apps-limits.ts` (CONTRACTS §2A — shared-file request; this epic only reads it).

---

## 8. Telemetry and failure modes

### 8.1 Events (counters and ids only)

| Event                                 | Properties                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `app.change.started`                  | `{ workId, taskId, source: 'chat' \| 'board' \| 'goal' \| 'mission' }`                                                    |
| `app.change.guard_refused`            | `{ workId, taskId, reason: 'protected' \| 'too_many_files' \| 'too_large' \| 'spec_field' }`                              |
| `app.change.merged`                   | `{ workId, taskId }`                                                                                                      |
| `app.change.delivered`                | `{ workId, taskId, minutesMergeToLive, carried: boolean }`                                                                |
| `app.change.delivery_failed`          | `{ workId, taskId, phase: 'build' \| 'deploy', followUp: boolean }`                                                       |
| `app.change.closed_without_deploy`    | `{ workId, taskId }`                                                                                                      |
| `app.change.delivery.sweep`           | `{ scanned, changed, failed, durationMs }`                                                                                |
| `mission.task_output.tick`            | `{ missionId, worksConsidered, tasksFiled, skippedCap, skippedDuplicate }`                                                |
| `app.change.run_admitted`             | `{ workId, taskId, placement: 'fleet' \| 'cloud', containmentPath, isolatedHome: boolean, downgraded: boolean }` (XC-06)  |
| `app.change.blocked_by_switch`        | `{ workId, taskId, switch: 'evolve' \| 'auto_deploy' }` (XC-10)                                                           |
| `app.change.tool_denied`              | `{ workId, taskId, group }` — the tool **group** only, never a tool argument or the content it would have carried (XC-05) |
| `mission.task_output.nothing_to_file` | `{ missionId }` — the FR-54 daily entry, counted once per Mission per day (APW08-G21)                                     |

The names and property types live in one typed module, `packages/monitoring/src/posthog/app-change-events.ts`
_(new, modelled on `kb-events.ts`)_, whose `emitAppChangeEvent(client, distinctId, event)` refuses a forbidden
property key (`prompt`, `diff`, `path`, `paths`, `log`, `logTail`, `title`, `body`, `request`) the same way
`emitKbEvent` does.

### 8.2 Failure modes

| Failure                                              | Behaviour                                                                                                             | Why                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| App spec at base commit invalid or unreadable        | Run does not start: **"The App spec on {branch} is invalid — fix it before starting changes."**                       | Rules that cannot be read must not default to "no rules".       |
| `getCompareDiff` throws                              | No pull request; Task `BLOCKED` with **"Couldn't verify this change's files. Try again."**                            | Fail closed on a guard.                                         |
| Provider lacks `isAncestorCommit`                    | Exact-sha matching only; a coalesced Build leaves the state at `merged` until a later exact match or **Close anyway** | Never claim live without proof.                                 |
| APW-05/06 tables absent (epic not merged)            | `isDeliveryTracked` returns false → today's `completeOnMerge`                                                         | P1 degrades to current behaviour instead of stranding Tasks.    |
| Reconciler throws for one Task                       | Logged; others continue; `deliveryUpdatedAt` untouched so it is retried first                                         | Per-Task isolation, same as the PR sweep.                       |
| Follow-up creation fails                             | Escalation `delivery-failed` recorded instead                                                                         | A failure must reach a person.                                  |
| Two workers reconcile the same Task                  | Compare-and-set on `deliveryState`                                                                                    | Idempotent convergence.                                         |
| Commit lock wait exceeds 120 s                       | Tool returns the FR-6 error; nothing written                                                                          | Never interleave writes in a shared working copy.               |
| Mission planner returns prose / invalid JSON         | Tick files nothing for that Work; `skippedInvalid` counted                                                            | Never store a shape we did not ask for.                         |
| Goal's Work deleted mid-loop                         | `decideGoalLoop` → `pause` / `work-unavailable`                                                                       | S26.                                                            |
| Run parked by a stop or pause (R-17)                 | Waiting; no gate attempt, no follow-up, no delivery failure; resumes when released                                    | FR-66 — a person's hold is not a failure.                       |
| Safety rail refuses an action (R-17)                 | `needs_input`: Task `BLOCKED` + escalation `guardrail-refusal`; no gate attempt, no follow-up                         | FR-67 — a refusal needs a decision, not a retry.                |
| No Agent resolves for a system-opened Task           | Task unassigned, not dispatched; one owner notification (APW-02 sends it)                                             | FR-9 / R-21.                                                    |
| Fleet node reports a containment downgrade (XC-06)   | `needs_input`: no run starts; Task offers **Allow on this machine**; the allowance is per node and withdrawable       | FR-12/FR-70 — a machine that declined isolation has not failed. |
| Operator's change switch is off (XC-10)              | No run dispatched, no auto-deploy from a merge, no follow-up; Task shows `appRules.changesPaused`                     | FR-74 — an operator stop is a stop, not a failure.              |
| No push credential for the repository owner (GAP-15) | Run does not start; Task `needs_input` with the S28 copy naming the owner                                             | FR-75 — better at admission than at the push.                   |
| Repository over the stage's size limit (XC-29)       | Run does not start; S35 copy names the size and the limit; Inspect already named the stage                            | FR-72 — one limits table.                                       |
| Budget guard refuses a run (XC-19)                   | Waiting on FR-66's terms; no gate attempt, no follow-up                                                               | FR-73 — a cap is a person's decision, not a failure.            |
| A denied tool is requested (XC-05)                   | The tool is absent from the run's list; a direct call is refused like any other unknown tool; one `group` counter     | FR-69 — third-party content never widens the tool list.         |
| Chat thread post with no Agent (G12)                 | Posted as `authorType: 'system'` with `authorId` NULL and a `messageKey`; renders in the reader's locale              | R-21 creates unassigned Tasks, and they still need posts.       |
| Task labels edited by a user (G23)                   | No behaviour changes: the exemption is keyed on APW-04's `WorkAppProvisioning.taskId` and the dedup on `followUpKey`  | A label is user input and can never be a permission.            |

---

## 9. Test plan

### 9.1 Unit — agent package (Jest)

| File                                                                                        | Covers                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/src/app-works/__tests__/app-work-rules.service.spec.ts` _(new)_             | Reads rules at base ref; caps (20 checks, 5 files, 32/64 KB); invalid spec → refusal; defaults (500 guidance).                                                                                                                                              |
| `packages/agent/src/app-works/__tests__/app-change-guard.spec.ts` _(new)_                   | Protected glob hit on path and `previousPath`; `.github/workflows/**`; spec-field changes; removal from protected lists; 300-file and truncated refusal; lockfile exclusion; guidance note vs 3× refusal; APW-04 exemption.                                 |
| `packages/agent/src/app-works/__tests__/task-delivery.rules.spec.ts` _(new)_                | `decideDelivery` table: every state transition in spec §5.3, carry-along, target None, strategy none, cancelled/skipped Deployments, live-with-warnings.                                                                                                    |
| `packages/agent/src/app-works/__tests__/task-delivery.service.spec.ts` _(new)_              | `recordMerge` idempotency (unique index), follow-up limits (2 per chain, 3 open per Work), escalation fallback, auto-cancel of follow-ups.                                                                                                                  |
| `packages/agent/src/tasks-domain/__tests__/task-pr-status.delivery.spec.ts` _(new)_         | Tracked merge skips `completeOnMerge`; untracked merge unchanged; other-branch merge unchanged (S19).                                                                                                                                                       |
| `packages/agent/src/tasks-domain/__tests__/task-isolation.app.spec.ts` _(new)_              | `app` forces `on`; other kinds byte-identical (golden table).                                                                                                                                                                                               |
| `packages/agent/src/tasks-domain/__tests__/repo-declared-commands.app.spec.ts` _(new)_      | `spec.checks` mapping; allow-list admission; `not-admitted` result; `repo` kind unchanged.                                                                                                                                                                  |
| `packages/agent/src/goals/__tests__/goal-orchestrator-rules.awaiting-merge.spec.ts` _(new)_ | `awaiting-merge` counts into the ceiling; `work-unavailable`; every pre-existing case identical.                                                                                                                                                            |
| `packages/agent/src/goals/__tests__/goal-orchestrator.work-scope.spec.ts` _(new)_           | Iteration Task created with `workId`; null `workId` unchanged.                                                                                                                                                                                              |
| `packages/agent/src/missions/__tests__/mission-tick.task-output.spec.ts` _(new)_            | `ideas` untouched; `tasks`/`both`; caps; duplicate titles; backlog vs todo+dispatch; ≤ 5 Works; once-per-day notice.                                                                                                                                        |
| `packages/agent/src/missions/__tests__/mission-template-defaults.spec.ts` _(new)_           | `applyDefaults` wired on create; new manifest keys; explicit nulls not clobbered.                                                                                                                                                                           |
| `packages/agent/src/app-works/__tests__/app-spec-applied.listener.spec.ts` _(new)_          | Source branch `production` → `taskIsolationBaseBranch = 'production'`, `taskIsolation = 'worktree'`; second event is a no-op.                                                                                                                               |
| `packages/agent/src/tasks-domain/__tests__/task-workspace.app-base-branch.spec.ts` _(new)_  | ACC-08-06: an App Work Task's branch is cut from `production` and its pull request targets `production`, never the repository default branch.                                                                                                               |
| `packages/agent/src/tasks-domain/__tests__/task-pr-status.app-checks.spec.ts` _(new)_       | ACC-08-09: a red required `Ever Works check: {name}` leg → gate red, one fix-loop resume per attempt, `BLOCKED` + escalation `gate-exhausted` when spent; a red non-required leg changes nothing.                                                           |
| `packages/agent/src/app-works/__tests__/isolated-run-admission.spec.ts` _(new)_             | Fleet admitted; enforcing pipeline + `limited` admitted; unrestricted or no flag refused; an admitted run whose Agent is paused is parked, not refused.                                                                                                     |
| `packages/agent/src/app-works/__tests__/app-work-run-holds.spec.ts` _(new)_                 | ACC-08-31: parked (`kill-switch`, `agent-paused`, stop/pause rails) consumes no attempt and opens no follow-up; `ladder`/`rules` refusal → `BLOCKED` + `guardrail-refusal`, no attempt, no follow-up.                                                       |
| `packages/agent/src/app-works/__tests__/app-work-agent-resolver.spec.ts` _(new)_            | ACC-08-32: recent-task → pinned → assigned order; archived and `canCommitToRepo: false` skipped; two pinned and no recent Task → `null`.                                                                                                                    |
| `packages/agent/src/app-works/__tests__/app-work-tool-policy.spec.ts` _(new)_               | ACC-08-33 (XC-05): every denied group is denied for a tool the platform actually exposes; `ask_human` and the read tools stay; the dispatch re-check refuses a run whose resolved list contains one; an instruction file cannot add one.                    |
| `packages/agent/src/app-works/__tests__/run-containment.spec.ts` _(new)_                    | ACC-08-34 (XC-06, GAP-21): `needsOwnerAllowance` for `isolatedHome: false` and for an `isolated-home` downgrade; `hardened`/`ordinary` both admitted; a coerced (over-reported) containment is read as _less_ contained; the record reaches `TaskCostView`. |
| `packages/agent/src/app-works/__tests__/app-work-kill-switch.spec.ts` _(new)_               | ACC-08-38 (XC-10): each dispatcher refuses with the switch off, no auto-deploy fires on a merge, no follow-up opens, and a running Task is left exactly as it was.                                                                                          |
| `packages/agent/src/app-works/__tests__/repo-size-limit.spec.ts` _(new)_                    | ACC-08-36 (XC-29): the limit comes from the shared table; the stage that refuses is the one Inspect named; the copy names size and limit.                                                                                                                   |
| `packages/agent/src/app-works/__tests__/work-budget.spec.ts` _(new)_                        | ACC-08-37 (XC-19): every Run and managed Build books against the App Work's `WorkBudget`; a refusal parks the run; the rollup totals unknown as unknown.                                                                                                    |
| `packages/agent/src/app-works/__tests__/follow-up-key.spec.ts` _(new)_                      | ACC-08-47 (G23): the dedup key is server-side, two uuids exceed no column limit, a user-added or user-cleared label changes nothing, and the APW-04 exemption is keyed on `WorkAppProvisioning.taskId` on every finalize path.                              |

### 9.2 API (Jest)

- `apps/api/src/agents/agents.module.spec.ts` — **P0 failing-first** block (T1): providerId never `''` and equals
  `work.gitProvider` (with `gitlab`); data-repo coordinates (import source ignored); branch honoured on switch and
  push `ref`; protected-branch refusal writes nothing; PR owner/repo/base; lock serialization; no `'github'` literal
  in the factory source (read the file text in the test).
- `apps/api/src/works/work-evolve.controller.spec.ts` _(new)_ — 202 shape, `notAppWork`, `agentRequired`,
  `noIsolatedRuntime`, cross-account 404, throttle metadata.
- `apps/api/src/tasks/tasks.controller.delivery.spec.ts` _(new)_ — delivery, close, follow-up, cost, filters, 404s.
- `apps/api/src/goals/goals.controller.spec.ts`, `apps/api/src/missions/missions.controller.spec.ts` _(new — neither
  exists on `ee45946e5`)_ — `workId` scope checks and `409 loopRunning`; `outputMode` / `taskOutput` and the
  `noAppWorkRelation` warning.
- `apps/api/src/migrations/__tests__/AddTaskDeliveryState.spec.ts`, `AddGoalWorkScope.spec.ts`,
  `AddMissionTaskOutput.spec.ts` _(new)_ — re-runnable, no `DROP` of pre-existing columns.

### 9.3 Plugin (Vitest)

`packages/plugins/github/src/__tests__/github-api.service.ancestry.spec.ts` (new) — `mergeCommitSha` mapping; `isAncestorCommit`
for ahead / identical / behind / diverged / 404.

### 9.4 e2e (Playwright)

| File                                                 | Golden path                                                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/e2e/app-works-evolve-chat.spec.ts`         | Work chat → confirmation → Task created → chain card renders (API mocked at the provider boundary).                                                                                                               |
| `apps/web/e2e/app-works-delivery-chips.spec.ts`      | Seeded Tasks in each delivery state render the right chip text; Delivery filter narrows; **Close anyway** confirm.                                                                                                |
| `apps/web/e2e/app-works-guard-refusals.spec.ts`      | Protected path, too large and not-admitted copy on Task detail.                                                                                                                                                   |
| `apps/web/e2e/goals-work-scope.spec.ts`              | Goal form Work select; disabled while running.                                                                                                                                                                    |
| `apps/web/e2e/missions-task-output.spec.ts`          | Output card, limits, Tasks-on-Works panel, template form summary.                                                                                                                                                 |
| `apps/web/e2e/app-works-a11y.spec.ts` _(new, XC-25)_ | FR-71/ACC-08-35: axe on the chips, Delivery section, Cost section, Request-a-change dialog and chain card; `Esc` returns focus; every chip state present as text; the Delivery section rendered in `ar` and `he`. |

Pre-existing specs that must pass unchanged: `flow-task-isolation-gates-contract.spec.ts`, `flow-task-branch-gate-ui-journey.spec.ts`, `flow-goal-lifecycle.spec.ts`, `flow-goals-lifecycle-deep.spec.ts`,
`flow-mission-crud-schedule.spec.ts`, `flow-mission-guardrails.spec.ts`. The owner's end-to-end example is wired into
[`ACCEPTANCE.md`](../ACCEPTANCE.md) by APW-13.

### 9.5 Translations and telemetry (ACC-08-30)

- `apps/web/src/lib/__tests__/app-works-evolve-messages.unit.spec.ts` _(new, Vitest)_ — loads all 21
  `apps/web/messages/*.json`; every leaf under the sub-trees of §5.2 exists in every locale and no leaf key contains a
  literal `.`.
- `packages/monitoring/src/posthog/__tests__/app-change-events.spec.ts` _(new, Jest)_ — every §8.1 event forwards
  its typed payload; a payload carrying any forbidden key (prompt, diff, path, log line, title) throws before
  `capture` is called.

### 9.6 APW-05 generator (Vitest, in APW-05's package)

`packages/plugins/github-actions-build/src/__tests__/generator.spec.ts` gains a two-check fixture (one required, one
not) with golden file `src/__tests__/golden/app-checks-two.yml` _(new)_: two matrix legs named
`Ever Works check: {name}`, `fail-fast: false`, `permissions: contents: read`, no `secrets.` inside the `checks` job,
the command only through `env.EW_CHECK_COMMAND_B64` (base64 — **not** `env.CHECK_COMMAND`, see APW08-G05),
`continue-on-error` only on the non-required leg, the tracked-branch leg as well as the pull-request one (FR-76),
byte-identical on two runs. **APW-08 owns the golden fixture and the assertion, not the emitter** — APW-05 T41 owns
`checks-job.ts` and the `generator.ts` emission (APW-05 plan §4.14); the test file lives in APW-05's package, which
is why this section must not be read as a second implementation.

---

## 10. Phasing

### P0 — Agent git tools (Wave 0, independent PR, FR-1…FR-8)

Failing tests first, then the adapter rewrite of §2.2, the `MergePolicyService` injection, the keyed lock, the
tool-description updates. No migration, no UI. **Ships alone.**

### P1 — The loop on an App Work (Wave 1, FR-9…FR-44, FR-61…FR-68)

Rules resolver, forced isolation + base branch sync, isolated-run admission, Fleet `spec.checks` admission, the CI
check job requirement, change guard, human-merge paths, delivery columns + reconciler + follow-ups + escalation
reason, `evolve` endpoint + chat tool + card, board chips + Delivery section + Cost section, i18n.
**Depends on** APW-01, APW-03, APW-05 P1, APW-06 P1 being merged; degrades to today's behaviour without them (§8.2).

**Added to P1 on 2026-09-17** (they are all P1-scoped because each one either gates or explains a P1 behaviour):
the tool policy (T47), the containment admission and record (T48), the one-off backfill (T50), the checks-change
notification and the missing-tool classification (T51), the accessibility pass (T52), the shared size limits (T53),
the follow-up key and label-exemption repair (T55), the keyed chat posts (T54), the per-App-Work cost rollup (T56),
and the checks-admission switches the listener now writes (§2.3, T11). The operator kill switches (T49) ship in P1
because they are what an operator needs **before** the loop runs for real.

### P2 — Goals and Missions (Wave 1, FR-45…FR-55)

Goal `workId` + awaiting-merge rule + form field; Mission output mode + planner + panels.

### P3 — Mission template (Wave 1 tail, FR-56…FR-60)

Manifest keys, `applyDefaults` wiring, template inputs, draft Goals, template form, catalog entry, the
`ever-works/missions` content from [`mission-template-draft/`](./mission-template-draft/) and the `evolve-app`
Skill from [`skill-draft/SKILL.md`](./skill-draft/SKILL.md) published to `ever-works/skills`.

---

## 11. Constitution compliance checklist

- [x] **I — Plugin-first.** No integration added; git/AI through facades; the two provider additions are optional
      methods on the existing git capability.
- [x] **II — No hard-coded plugin ids.** P0 removes the two `'github'` literals; the isolated-run predicate reads the
      pipeline plugin's `enforcesRuntimeNetworking` flag (APW-04).
- [x] **III — Source-of-truth repositories.** App rules are read from `.works/works.yml` in the Work Repository at
      the base commit; the database stores derived delivery state only; the template proposes App spec changes by
      pull request.
- [x] **IV — Job runtime.** Reconciler is a scheduled task; runs dispatch through the existing valve; `evolve`
      returns `202`.
- [x] **V — Forward-only migrations.** Three additive migrations in the reserved block; no rename, no drop.
- [x] **VI — Tests first.** P0 starts with failing tests; every service has a named spec; five e2e specs.
- [x] **VII — Secrets.** Failure logs are redacted and fenced; checks in CI get no secrets; telemetry has no content.
- [x] **VIII — Plugin counts.** No plugin added; `built-in-plugins.md` untouched.
- [x] **IX — Behaviour-first spec.** Names and paths live here only.
- [x] **X — Backwards compatibility.** New fields optional; non-app Works byte-identical (golden-table tests);
      `completeOnMerge` unchanged for untracked Tasks.
- [x] **Program rules 9 and 10.** Repository content fenced as untrusted; no infrastructure or competitor names.
- [x] **Program resolutions (CONTRACTS §0).** R-1 shared types in `packages/contracts/src/apps/` (§3.4); R-2 one
      Activity family `app_change` (§3.4); R-9 per-check CI matrix (§2.3, §7); R-17 holds are waits, rail refusals
      are `needs_input`, commits and pull requests only through Task finalize (§2.3); R-21 agent-resolution rule shared
      with APW-02 (§2.8); R-22 no `apps/api/test/` suites (§9); **R-26 additive-only** — every addition in this
      revision adds a requirement, a scenario, an acceptance id or a task, keeps every existing id stable and changes
      no default's flexibility, and the two places where existing text was corrected (the App spec's timeout bounds
      and `taskIsolationTargetRepo`) were corrected **toward** the schema owner and the owner's `website`-role
      decision, both of which are wider than the text they replace; **R-27 deploy shapes** — nothing here narrows a
      deploy shape, and recording a Deployment never changes a delivery state (§2.4).

### Known gaps carried forward

- `.github/workflows/**` protection is blanket (spec §9).
- Checks for cloud runs require a pull request to exist (spec §9); the CI fix loop, not "no PR on red", governs.
- The isolated-run predicate depends on a pipeline that enforces Environment networking; today that is one
  pipeline plugin.
- Mission Task output is limited to App Works.
- `MissionTemplateManifestService.applyDefaults` gets its first caller here; the two starter templates' manifests
  start being honoured at the same time — called out in the P3 PR description.
- Fleet setup steps and App checks run with the machine's **real** home and toolchain; the containment record covers
  the model step only, and FR-14's owner admission is the control for checks (§2.3, XC-06). README rule 9's
  "sandboxed" wording is qualified there, and the qualification is a shared-file request.
- Whether GitHub reports a failed job-level `continue-on-error` leg as a failing check run is **not verified**;
  §2.3's classifier does not depend on the answer.
- The `ever-works/missions` catalog's own `mission-template.schema.json` rejects this epic's draft manifest
  (`slug`, `title`, `type`, `summary`, `schedule` required; `version`, `defaults`, `kb`, `appWork`,
  `suggestedGoals` additional). The seed mechanism reads one repository per template (`MissionTemplateConfig`
  `{owner, repo, branch}`), and no code reads `ever-works/missions` — so T41 targets the standalone repository and
  EXT-13's catalog-conformant copy is added **alongside** the draft, never instead of it (see
  `mission-template-draft/catalog/`).
- `spec.checks` and `spec.tasks` are read from the same file; an App spec that declares both keeps both, and this
  epic reads only `spec.checks`.

---

## 12. Security & permissions (added 2026-09-17 — SK-16)

Per [plan-template §8](../../../../../.specify/templates/plan-template.md): who may call each endpoint, which new
`@Public()` endpoints exist, new scopes or roles, secret fields, and the validating DTO. **No new `@Public()`
endpoint and no new scope or role is added by this epic.** Every route below is JWT-guarded, scoped with
`@CurrentUser()`, checks Work access through `WorkOwnershipService`, and answers **404** for another account's ids
(FR-63, ACC-08-29); `ensureCanView` guards reads, `ensureCanEdit` guards writes.

| Route                                                           | Who may call it                                                                           | Throttle          | Validating DTO                                                                                                          | Secret fields                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /api/works/:id/evolve`                                    | Work member with **edit** access; the Work must be `kind = app`                           | 10 / min per user | `EvolveWorkDto` (`request` 1–4000, `agentId?` uuid, `attachmentUploadIds?` ≤ 10, `acceptContainmentDowngrade?` boolean) | none — `request` is untrusted text and is fenced in the brief, never a credential     |
| `GET /api/tasks/:id/delivery`                                   | Work member with **view** access                                                          | default           | —                                                                                                                       | none                                                                                  |
| `POST /api/tasks/:id/delivery/close`                            | **edit** access; the Task must be in a failed or `built` state                            | 30 / min          | `CloseDeliveryDto` (`note?` ≤ 500)                                                                                      | none                                                                                  |
| `POST /api/tasks/:id/delivery/follow-up`                        | **edit** access; `{ escalationId }` must be an escalation of **this** Task and unconsumed | 10 / min          | `DeliveryFollowUpDto` (`escalationId` uuid)                                                                             | none                                                                                  |
| `GET /api/tasks/:id/cost`                                       | Work member with **view** access                                                          | default           | —                                                                                                                       | none                                                                                  |
| `GET /api/tasks` (extended)                                     | unchanged; `deliveryState` / `includeDelivery` narrow nothing                             | unchanged         | existing `ListTasksDto` + two optional fields                                                                           | none                                                                                  |
| `GET /api/works/:id/cost` _(new, FR-73)_                        | Work member with **view** access                                                          | default           | `WorkCostQueryDto` (`month?` `YYYY-MM`)                                                                                 | none                                                                                  |
| `POST /api/works/:id/app-runs/allow-containment` _(new, FR-70)_ | **edit** access; the `nodeId` must be a node enrolled to this account's Fleet             | 10 / min          | `AllowContainmentDto` (`nodeId`, `allow` boolean)                                                                       | none — the record stored is a containment **description**, never a machine credential |
| `POST`/`PATCH /api/me/goals`, `/api/me/goals/:id` (extended)    | owner of the Goal; `workId` must be reachable in the Goal's own scope                     | unchanged         | existing `CreateGoalDto` / `UpdateGoalDto` + `workId?`                                                                  | none                                                                                  |
| `PATCH /api/me/missions/:id` (extended)                         | owner of the Mission                                                                      | unchanged         | existing Mission DTO + `outputMode?`, `taskOutput?`                                                                     | none                                                                                  |
| `POST /api/me/missions` (extended)                              | owner of the Mission; `appWorkId` must be a Work the caller owns                          | unchanged         | existing DTO + `templateInputs?` (`product` ≤ 80, `business` ≤ 80, `appWorkId` uuid)                                    | none                                                                                  |

**No public route.** This epic adds none: the App spec JSON Schema, the catalog and the launcher routes that are
`@Public()` belong to APW-03 and APW-11, and APW-08 only reads them. **No `@DelegatedRead` route** either — APW-12's
delegated scope reaches APW-11's launcher reads, not this epic's.

**Secrets this epic touches.** (a) The **Fleet push credential** is a GitHub App installation token minted by the
existing fleet path; this epic only _checks that it can be minted_ (FR-75) and never stores, logs or returns it.
(b) **Failure-log excerpts** in a follow-up Task's description pass the existing secret-redaction helper and are
fenced as untrusted content (FR-36) — no `EW_` value, token or env value may appear. (c) **Instruction files** and
the Mission planner's titles/descriptions are fenced untrusted repository content (FR-23, §2.7). (d) The
**containment record** and the **allow-on-this-machine** flag carry no credential and no host secret — node id,
execution path, `isolatedHome` and downgrade control names only (§3.4). (e) **Telemetry** carries no prompt, diff,
path or log line, and the typed event module refuses a forbidden property key before `capture` (§8.1, FR-65).
**No `x-secret` field is added by this epic.**

**The trust boundary this epic moves.** An App Work run reads third-party repository content, so the run's tool list
is the containment that matters most: FR-69's policy (§2.3, T47) denies outbound messaging, web fetch, MCP,
sub-agents and every App Works mutation tool, is re-checked at dispatch, and cannot be widened by an instruction
file. The App Change Guard reads the rules from the **base commit** and refuses before any pull request exists, so a
branch cannot relax the rules it is judged by (FR-20).

---

## 13. Risks & mitigations (added 2026-09-17 — SK-16)

| Risk                                                                                                                          | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Fleet run's containment is weaker than "owner holds the blast radius" implies (XC-06, SK-14)                                | High       | High   | Admission requires a reported isolated home and no `isolated-home` downgrade; the owner must allow a downgrade once per node; the record is shown on the Task; setup and checks are stated to run with the real home, so FR-14's admission — not containment — is their control (§2.3, T48, FR-70). |
| Third-party instruction files steer an Agent's platform-side tools (XC-05)                                                    | High       | High   | The App Work Task tool policy denies messaging, web, MCP, sub-agents and all App Works mutations, is re-checked at dispatch, and is shared with APW-09 (FR-69, T47).                                                                                                                                |
| App checks never run because the Work's switches default off, so runs grade green having verified nothing (G02)               | High       | High   | The `app.spec.applied` listener switches `checksPolicy` and `repoDeclaredCommands` on for `app` only, and a not-admitted check is reported `not-admitted` so the gate cannot be green (§2.3, §2.6, T11, T13, ACC-08-41).                                                                            |
| A cheap dependency update is refused as "over 300 files" because patch text was truncated (G06)                               | Medium     | Medium | The guard asks for paths and counts only (`maxBytes: 0`) and refuses on `totalFiles >= 300` or a short list — never on `truncated` alone (§2.5, T17).                                                                                                                                               |
| An advisory App check reds the merge gate, or a required one never blocks it (G04)                                            | Medium     | High   | Legs are classified through `AppWorkRulesService` at the PR base; the budget is the Work's `maxGateAttempts`; exhaustion is `BLOCKED` + `gate-exhausted`; the `continue-on-error` behaviour is a recorded fact to verify, with a fallback that does not depend on it (§2.3, T16).                   |
| FR-30 is silently off for an App Work whose spec omits `source.branch` (G07)                                                  | High       | Medium | Branch resolved from `WorkAppSpecState`/the repository default, one shared value for tracking and provisioning, plus a re-runnable backfill for Works created before P1 (§2.4, T50, ACC-08-43).                                                                                                     |
| `decideDelivery` guesses at Build and Deployment inputs (G08)                                                                 | Medium     | High   | One normative input table, per APW-05 status and APW-06 state including `blocked`, `cancelled`, `SUPERSEDED` and the `image` strategy; T20 enumerates its rows (§2.4, ACC-08-42).                                                                                                                   |
| A safety-rail refusal never reaches the Task, so FR-67 cannot happen (G09)                                                    | Medium     | Medium | The run row records the first non-stop refusal; the cloud run finisher and the Fleet reconciler both classify it; T46 names those files (§2.3).                                                                                                                                                     |
| Delivery SQL is Postgres/SQLite-only on a supported MySQL/MariaDB installation (G17)                                          | Medium     | High   | Driver branch for the compare-and-set, a plain unique index on MySQL (stronger, not weaker), an application lock, and MySQL cases in T9/T21 (§3.5, ACC-08-45).                                                                                                                                      |
| The resolver token is unbound, so conflict Tasks silently get no Agent (G18)                                                  | Medium     | Medium | Explicit provider in `AppWorksModule`, no cycle through `TasksDomainModule`, and a module-compilation test asserting the injection is defined (§2.8, T25).                                                                                                                                          |
| `APP_WORK_AGENT_RESOLVER` module wiring drifts when `TasksDomainModule` is refactored                                         | Low        | Low    | `packages/agent/src/app-works/__tests__/app-works.module.spec.ts` (APW-02 T15) plus T25's defined-token assertion fail the build rather than silently degrading.                                                                                                                                    |
| A follow-up dedup or provisioner exemption can be forged with a Task label (G23)                                              | Medium     | Medium | The exemption keys on APW-04's `WorkAppProvisioning.taskId`; dedup keys on a server-side `followUpKey` with a unique index; tests prove a user label grants nothing (§3.1, §6, T55).                                                                                                                |
| A keyed system post cannot be stored, so posts on unassigned Tasks fail (G12)                                                 | Medium     | Low    | Two nullable columns, `authorId` nullable only for `system` rows, `body` kept as the English fallback, and the renderer added in T54 (§6).                                                                                                                                                          |
| `PATCH /api/works/:id` allow-lists are the only admission for checks, so an owner who never visits the card sees Not admitted | Medium     | Low    | The card is linked from the notification FR-14 promises, and Not admitted is visible on the gate rather than silent (§2.6, T14, T51).                                                                                                                                                               |
| The two epics' `checks` job triggers disagree (G05)                                                                           | Medium     | Medium | APW-05 owns the emission and APW-08 verifies it against a golden fixture; the settled contract is PR **and** tracked branch, stated in §2.3 and FR-76; APW-05's `if:` guards are a shared-file request.                                                                                             |
| Repository size limits drift between create, provisioning, builds and the loop (XC-29)                                        | Low        | Medium | One shared stage-limits table (CONTRACTS §2A), read by this epic; Inspect names the first stage that would refuse; no local number (§2.3, T53, FR-72).                                                                                                                                              |
| App Works spend is invisible and uncapped across provisioning, evolve, upstream and managed use (XC-19)                       | Medium     | Medium | Every charge books against the App Work's own `WorkBudget` through the budget guard; the overview shows cap and remaining; a refusal is a wait (§4, T54, FR-73).                                                                                                                                    |
| The operator cannot stop background App Works activity (XC-10)                                                                | Medium     | High   | Kill switches read by the dispatchers themselves, failing closed, added before the loop runs for real (§6, T49, FR-74).                                                                                                                                                                             |
| A Blueprint-created App Work has no Agent, so the chat change flow dead-ends (GAP-14)                                         | High       | Medium | The confirmation card offers one template with `evolve-app` bound, commit permission and an admissible runtime, and assigns it in the same action (FR-42, S32, T25, ACC-08-40).                                                                                                                     |
| A Fleet evolve needs a GitHub App installation the create flow never checks (GAP-15)                                          | High       | Medium | The installation is checked at admission, per App Work, and refused with the S28 copy naming the owner (FR-75, T12, ACC-08-39).                                                                                                                                                                     |
| New surfaces are unusable by keyboard or screen reader, or break in RTL (XC-25)                                               | Medium     | Medium | FR-71, ACC-08-35 and a Playwright a11y spec covering chips, both dialogs, the Cost section and `ar`/`he` (T52).                                                                                                                                                                                     |
| The mission template is drafted against a catalog layout the platform never reads (EXT-13, G13)                               | High       | Low    | T41 targets the standalone seed repository the config mechanism actually resolves; the catalog-conformant copy is added **alongside** the draft and CONTRACTS §8 is corrected by shared-file request.                                                                                               |
| A deploy shape is narrowed or a Deployment changes a delivery state (R-26, R-27)                                              | Low        | High   | §2.4's table is exhaustive and admits no row that records a Deployment as a state change by itself; R-27's family is untouched; §11's R-26 line records the audit.                                                                                                                                  |
