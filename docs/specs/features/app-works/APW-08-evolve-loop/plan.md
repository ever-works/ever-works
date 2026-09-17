# Implementation Plan: Evolve loop

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation detail; the
> spec owns behaviour. **Every path below was opened in the worktree before it was written down** — a path marked
> _(new)_ does not exist yet.

**Epic ID**: `APW-08-evolve-loop`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-17
**Authored against**: `develop` @ `a655b53ca`

---

## 1. Current state in the codebase

### 1.1 What ships today

| Layer         | File                                                                                                                                                                                                                                                                                                                                                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent tools   | [`apps/api/src/agents/agents.module.ts`](../../../../../apps/api/src/agents/agents.module.ts) (the `AGENT_GIT_FACADE` provider, ~lines 597–749 on `ee45946e5`)                                                                                                                                                                                                      | Binds `commitToRepo` / `openPullRequest` for Agents. **Defective — see §1.2.** `inject: [GitFacadeService, AgentRepository, PullRequestGateService, WorkRepository]`.                                                                                                                                                                                                                                                                                                                                        |
| Agent tools   | [`packages/agent/src/agents/agent-git-facade.ts`](../../../../../packages/agent/src/agents/agent-git-facade.ts)                                                                                                                                                                                                                                                     | `AgentCommitToRepoInput` (`branch?` "Defaults to the Work's main branch"), `AgentOpenPullRequestInput` (`base?` "Defaults to the Work's default branch"), `AGENT_GIT_FACADE` token.                                                                                                                                                                                                                                                                                                                          |
| Agent tools   | [`packages/agent/src/agents/agent-tool.service.ts`](../../../../../packages/agent/src/agents/agent-tool.service.ts) `buildCommitToRepoTool` / `buildOpenPullRequestTool` (~1251–1382)                                                                                                                                                                               | Descriptors; require `AgentScope.WORK` + `agent.workId`; forward to the facade; catch and return `{ error }`.                                                                                                                                                                                                                                                                                                                                                                                                |
| Tests         | [`apps/api/src/agents/agents.module.spec.ts`](../../../../../apps/api/src/agents/agents.module.spec.ts) `describe('api-side AgentsModule — AGENT_GIT_FACADE PR gate')`                                                                                                                                                                                              | Builds the real factory with stubs, but only asserts the PR gate is consulted — **never the coordinates**, which is how the defects survived.                                                                                                                                                                                                                                                                                                                                                                |
| Tests         | [`packages/agent/src/agents/__tests__/agent-tool-git.spec.ts`](../../../../../packages/agent/src/agents/__tests__/agent-tool-git.spec.ts)                                                                                                                                                                                                                           | Descriptor gating + forwarding with a mocked `AgentGitFacade`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Git facade    | [`packages/agent/src/facades/git.facade.ts`](../../../../../packages/agent/src/facades/git.facade.ts)                                                                                                                                                                                                                                                               | `getRepoDir('work', id, opts)` clones `work.sourceRepository.owner/repo` with `providerId: options.providerId ?? work.gitProvider`; `cloneOrPull` → `resolvePluginAndToken` → `resolvePlugin(providerId)` throws `'providerId is required'` on `''`. `commit(providerId, …)` uses `getPluginSync`, which falls back to **any** loaded git plugin. `push({ dir, ref?, remoteRef? })`, `switchBranch`, `createPullRequest`, `getCompareDiff`, `getFileContent(owner, repo, path, opts, ref)`, `getRepository`. |
| Work          | [`packages/agent/src/entities/work.entity.ts`](../../../../../packages/agent/src/entities/work.entity.ts)                                                                                                                                                                                                                                                           | `gitProvider`, `sourceRepository` (import source), `getRepoOwner(type='data')` / `getDataRepo()` over `sourceRepository.relatedRepositories`, `taskIsolation` (`off`/`worktree`), `taskIsolationBaseBranch`, `checkDefaults`, `checksPolicy`, `maxGateAttempts`, `repoDeclaredCommands` (EW-807 allow-list), `mergePolicy`.                                                                                                                                                                                  |
| Repo kind     | [`packages/agent/src/services/work-lifecycle.service.ts`](../../../../../packages/agent/src/services/work-lifecycle.service.ts) `applyRepositoryWorkSource`                                                                                                                                                                                                         | Writes the repository under `relatedRepositories.data` "which is what `TaskWorkspaceService.provisionForRun` clones". The precedent APW-01 follows for `app`.                                                                                                                                                                                                                                                                                                                                                |
| Isolation     | [`packages/agent/src/tasks-domain/task-isolation.ts`](../../../../../packages/agent/src/tasks-domain/task-isolation.ts)                                                                                                                                                                                                                                             | `resolveTaskIsolation(task, work, { agentCanCommit })` → `'on' \| 'off'`; `taskBranchName`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Workspace     | [`packages/agent/src/tasks-domain/task-workspace.service.ts`](../../../../../packages/agent/src/tasks-domain/task-workspace.service.ts)                                                                                                                                                                                                                             | `provisionForRun` (owner/repo = `getRepoOwner()`/`getDataRepo()`; base = `taskIsolationBaseBranch` or repo default), `describeFleetWorkspace`, `readFleetRepoDeclaredCommands` (reads `spec.tasks.setup/checks` only when `repoDeclaredCommands.mode === 'allowlist'`), `finalizeRun` → `simulateMerge` → `openPullRequestForBranch`, `finalizeRemotePush`, `postSystemMessage`.                                                                                                                             |
| Gates         | [`packages/agent/src/tasks-domain/task-gate-runner.service.ts`](../../../../../packages/agent/src/tasks-domain/task-gate-runner.service.ts), [`repo-declared-commands.ts`](../../../../../packages/agent/src/tasks-domain/repo-declared-commands.ts)                                                                                                                | Subprocess check runner over a dispatch-frozen set; `parseRepoDeclaredCommands(spec)` reads `spec.tasks` regardless of kind; `admitRepoDeclaredCommands` enforces the owner allow-list and refuses rather than drops.                                                                                                                                                                                                                                                                                        |
| Works config  | [`packages/agent/src/works-config/schema/works-config.schema.ts`](../../../../../packages/agent/src/works-config/schema/works-config.schema.ts)                                                                                                                                                                                                                     | `KIND_SPEC_SCHEMAS` (no `app` yet — APW-03 adds it); `repoSpec.tasks.checks` documented as a trust boundary.                                                                                                                                                                                                                                                                                                                                                                                                 |
| PR status     | [`packages/agent/src/tasks-domain/task-pr-status.service.ts`](../../../../../packages/agent/src/tasks-domain/task-pr-status.service.ts)                                                                                                                                                                                                                             | `syncDuePrStatuses` refreshes open PRs; on `merged` calls `completeOnMerge` → `TaskStatus.DONE` through `TaskTransitionService`; `offerRedGateToFixLoop` feeds red CI into the auto-resume loop; `resolveRepo` mirrors the workspace coordinates.                                                                                                                                                                                                                                                            |
| PR sweep      | [`packages/tasks/src/tasks/trigger/task-pr-status-sync.task.ts`](../../../../../packages/tasks/src/tasks/trigger/task-pr-status-sync.task.ts)                                                                                                                                                                                                                       | `schedules.task` `*/2 * * * *`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CI fix loop   | [`packages/agent/src/tasks-domain/task-ci-auto-resume.ts`](../../../../../packages/agent/src/tasks-domain/task-ci-auto-resume.ts)                                                                                                                                                                                                                                   | Budget `0..5`, default 2; `failing` is the only verdict that buys a resume.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Merge gate    | [`packages/agent/src/tasks-domain/task-merge-gate.service.ts`](../../../../../packages/agent/src/tasks-domain/task-merge-gate.service.ts)                                                                                                                                                                                                                           | `onPullRequestStatusRefreshed(task, status)` — the one post-CI merge decision.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PR gate       | [`packages/agent/src/policy/pull-request-gate.service.ts`](../../../../../packages/agent/src/policy/pull-request-gate.service.ts)                                                                                                                                                                                                                                   | `assertAllowed({ work, cwd, context })` for non-Task PR openers.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Task          | [`packages/agent/src/entities/task.entity.ts`](../../../../../packages/agent/src/entities/task.entity.ts)                                                                                                                                                                                                                                                           | `workId`, `missionId`, `goalId`, `labels`, `branchRef`, `branchState`, `prNumber`, `prUrl`, `prState`, `ciState`, `prChecks`, `prHeadSha`, `ciHeadSha`, `latestRunId`. **No merge commit, no delivery state.**                                                                                                                                                                                                                                                                                               |
| Task CRUD     | [`packages/agent/src/tasks-domain/tasks.service.ts`](../../../../../packages/agent/src/tasks-domain/tasks.service.ts)                                                                                                                                                                                                                                               | `CreateTaskInput` accepts `workId` + `missionId` + `goalId` together ("one Task with three associations").                                                                                                                                                                                                                                                                                                                                                                                                   |
| Relations     | [`packages/agent/src/entities/task-relation.entity.ts`](../../../../../packages/agent/src/entities/task-relation.entity.ts)                                                                                                                                                                                                                                         | `TaskRelationKind = 'related' \| 'duplicates' \| 'follow-up'`.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Goals         | [`packages/agent/src/entities/goal.entity.ts`](../../../../../packages/agent/src/entities/goal.entity.ts), [`goal-orchestrator.service.ts`](../../../../../packages/agent/src/goals/goal-orchestrator.service.ts) `applyDispatch` (~876–1030), [`goal-orchestrator-rules.ts`](../../../../../packages/agent/src/goals/goal-orchestrator-rules.ts)                   | **No `workId` on `goals`.** Iteration Tasks are created by `tasksService.create(goal.userId, { title: '[Goal] … — iteration N', goalId, agentId, labels: [GOAL_ITERATION_LABEL] })` then `transitions.dispatchAgentRun(task, agentId, { dedupKey: 'goal:<id>:<n>' })`. `decideGoalLoop` is pure; `runsInFlight >= maxConcurrent` → `wait` / `run-in-flight`.                                                                                                                                                 |
| Goals API     | [`apps/api/src/goals/goals.controller.ts`](../../../../../apps/api/src/goals/goals.controller.ts) (`api/me/goals`), [`apps/api/src/goals/dto/goal.dto.ts`](../../../../../apps/api/src/goals/dto/goal.dto.ts)                                                                                                                                                       | `CreateGoalDto` (title, goalKind, metric fields, …).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Missions      | [`packages/agent/src/missions/mission-tick.service.ts`](../../../../../packages/agent/src/missions/mission-tick.service.ts)                                                                                                                                                                                                                                         | `tickDue` → `evaluateAndRun`: outstanding-Ideas cap → `WorkProposalService.generate({ source: MISSION, missionContext: { description, existingWorks } })` → optional auto-build. **Never creates Tasks.**                                                                                                                                                                                                                                                                                                    |
| Missions      | [`packages/agent/src/entities/mission.entity.ts`](../../../../../packages/agent/src/entities/mission.entity.ts), [`mission-work.entity.ts`](../../../../../packages/agent/src/entities/mission-work.entity.ts), [`database/repositories/mission-work.repository.ts`](../../../../../packages/agent/src/database/repositories/mission-work.repository.ts)            | `schedule`, `autoBuildWorks`, `outstandingIdeasCap`, `guardrailsOverride`, `missionTemplateRepo`; relations `created/improves/operates/markets/researches/retires`, `listForMissionWithWork`.                                                                                                                                                                                                                                                                                                                |
| Ideas         | [`packages/agent/src/entities/work-proposal.entity.ts`](../../../../../packages/agent/src/entities/work-proposal.entity.ts), [`packages/agent/src/work-agent/idea-build-executor.service.ts`](../../../../../packages/agent/src/work-agent/idea-build-executor.service.ts)                                                                                          | `targetWorkId` exists, but building such an Idea calls `updateItemsGenerator` — directory generation, switched off for `app` (D1). Ideas also require `suggestedCategories/Fields/slugSuggestion`.                                                                                                                                                                                                                                                                                                           |
| Templates     | [`packages/agent/src/missions/mission-template.config.ts`](../../../../../packages/agent/src/missions/mission-template.config.ts), [`mission-template-manifest.service.ts`](../../../../../packages/agent/src/missions/mission-template-manifest.service.ts)                                                                                                        | Two hard-coded seed rows (`starter-business`, `starter-content`); zod manifest `defaults.{cadence, autoBuildWorks, outstandingIdeasCap, guardrails}`, `kb.seedPaths`, `recommendedWorkTemplates`; `applyDefaults(...)` **has no production caller**.                                                                                                                                                                                                                                                         |
| Chat          | [`apps/web/src/lib/ai/tools/generated/registry.ts`](../../../../../apps/web/src/lib/ai/tools/generated/registry.ts)                                                                                                                                                                                                                                                 | `create_task` (`workId` in body hint), `assign_task_to_agent` (`POST /api/agents/{id}/assign-task`), `get_task_spend`. Confirmation via `requiresConfirmation`.                                                                                                                                                                                                                                                                                                                                              |
| Chat          | [`apps/web/src/lib/ai/tools/work.tools.ts`](../../../../../apps/web/src/lib/ai/tools/work.tools.ts), [`docs/features/platform-chat.md`](../../../../../docs/features/platform-chat.md)                                                                                                                                                                              | Work tools; "It uses where you are": the page URL scopes the Work. Task chat threads are separate from the rail.                                                                                                                                                                                                                                                                                                                                                                                             |
| Web board     | [`apps/web/src/components/tasks/TasksKanbanView.tsx`](../../../../../apps/web/src/components/tasks/TasksKanbanView.tsx) (~313–316), [`TaskDetailClient.tsx`](../../../../../apps/web/src/components/tasks/TaskDetailClient.tsx)                                                                                                                                     | Card chips `TaskBranchChip`, `TaskPrPill`, `TaskRunChip`, `GateChip`; detail sections `TaskChecksSection`, `TaskBranchSection`.                                                                                                                                                                                                                                                                                                                                                                              |
| Web Work tab  | [`apps/web/src/app/[locale]/(dashboard)/works/[id]/tasks/page.tsx`](<../../../../../apps/web/src/app/[locale]/(dashboard)/works/[id]/tasks/page.tsx>), [`apps/web/src/components/works/detail/WorkTabs.tsx`](../../../../../apps/web/src/components/works/detail/WorkTabs.tsx)                                                                                      | `tasksAPI.list({ workId, includeRun: true })` → `TasksScopedSection`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Costs         | [`packages/contracts/src/runs/run-ledger.types.ts`](../../../../../packages/contracts/src/runs/run-ledger.types.ts) `RunReceipt`, [`apps/api/src/tasks/tasks.controller.ts`](../../../../../apps/api/src/tasks/tasks.controller.ts) `GET :id/spend`                                                                                                                 | Run receipts (AW-09) and a per-Task spend rollup.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Escalations   | [`packages/contracts/src/agents/escalation.types.ts`](../../../../../packages/contracts/src/agents/escalation.types.ts), [`packages/agent/src/agents/escalation-confidence.ts`](../../../../../packages/agent/src/agents/escalation-confidence.ts)                                                                                                                  | Closed reason list + `REASON_PRIOR` record (exhaustive over the union).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Activity      | [`packages/agent/src/entities/activity-log.types.ts`](../../../../../packages/agent/src/entities/activity-log.types.ts)                                                                                                                                                                                                                                             | `ActivityActionType` enum (e.g. `GOAL_ITERATION_DISPATCHED`, `TASK_MERGED`).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Fleet         | [`docs/features/fleet.md`](../../../../../docs/features/fleet.md) §Capabilities, §How a fleet node pushes                                                                                                                                                                                                                                                           | `git-push` tag always required; push credential = GitHub App installation token narrowed to the Task's repositories.                                                                                                                                                                                                                                                                                                                                                                                         |
| Environments  | [`docs/features/environments.md`](../../../../../docs/features/environments.md)                                                                                                                                                                                                                                                                                     | `Limited` networking is **enforced only by the managed-agent pipeline plugin**; other pipelines treat it as advisory.                                                                                                                                                                                                                                                                                                                                                                                        |
| Migrations    | [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations)                                                                                                                                                                                                                                                                                                | Newest `1791240000000-AddSafetyRailsCore.ts` (re-verified on `ee45946e5`; `1791200100000-CreateOnboardingChecklists.ts` when authored); specs in `__tests__/`.                                                                                                                                                                                                                                                                                                                                               |
| Run admission | [`packages/agent/src/agents/run-admission-chain.ts`](../../../../../packages/agent/src/agents/run-admission-chain.ts), [`run-dispatch-gate.service.ts`](../../../../../packages/agent/src/agents/run-dispatch-gate.service.ts), [`agent-brake.service.ts`](../../../../../packages/agent/src/agents/agent-brake.service.ts) (AW-23, added after authoring)          | `DEFAULT_RUN_ADMISSION_CHAIN` = global stop flag (parks `kill-switch`) → Agent brake (parks `agent-paused` while the Agent is paused/archived; released on Resume) → Work valve → organization valve → credits. Parked runs are waiting, not stuck.                                                                                                                                                                                                                                                          |
| Safety rails  | [`packages/agent/src/safety/action-category.ts`](../../../../../packages/agent/src/safety/action-category.ts), [`safety-gate.port.ts`](../../../../../packages/agent/src/safety/safety-gate.port.ts), `AgentRunService.evaluateSafety` in [`agent-run.service.ts`](../../../../../packages/agent/src/agents/agent-run.service.ts) (AW-24 P1, added after authoring) | Every tool call passes `SAFETY_GATE` before the facade. `commitToRepo` / `openPullRequest` are `publish.external` (default rung `ask`, enforced only for an explicit rung until AW-24 P2 flips `SHIPPED_DEFAULT_RUNG_POLICY`). Task finalize pushes and PRs are not gated by the ladder — which is why the evolve loop commits and opens pull requests only through Task finalize (Resolution R-17). `apps/api/src/agents/agents.module.ts` binds `SAFETY_GATE` beside `RUN_KILL_SWITCH`.                    |

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
                 .works/works.yml @ Task base commit (data repository)
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
      `.github/workflows/**` (`AppChangeGuard.assertPathsAllowed`) and `openPullRequest` runs
      `AppChangeGuard.evaluate` before `createPullRequest` (T17).
- **Checks on a Fleet node.** `readFleetRepoDeclaredCommands` learns `kind: 'app'`: it parses `spec.checks`
  (mapped to `TaskAcceptanceCheck`: `id = slug(name)`, `kind: 'custom'`, `required`, `timeoutSec = timeoutSeconds`
  clamped 1..3600, capped at 20) and admits them through `admitRepoDeclaredCommands` with the
  unchanged allow-list. A not-admitted check is reported `not-admitted` (new `TaskCheckResult.status` value —
  additive) instead of the current whole-run refusal, so FR-14's "gate never green" holds without blocking the
  run.
- **Checks in the repository's CI (cloud runs) — a per-check matrix (Resolution R-9).** APW-05's build workflow
  (`.github/workflows/ever-works-build.yml`, CONTRACTS §9) carries one `checks` job on same-repository pull requests
  and on the tracked branch (APW-05 FR-11) whose `strategy.matrix.check` lists the App spec checks in App spec order
  (≤ 20), with `fail-fast: false` and `max-parallel: 5`. Each matrix leg is its own job named `Ever Works check: ${{ matrix.check.name }}`, so GitHub
  reports **one check run per App spec check** under exactly that name. Every leg has job
  `permissions: contents: read`, no `EW_` secret reference, `timeout-minutes` = `ceil(timeoutSeconds / 60)`,
  checkout of the PR head with `persist-credentials: false`, no secrets, `EW_` variables or cache, and runs the command
  passed base64-encoded through `env: EW_CHECK_COMMAND_B64` (decoded to a temporary script) — never interpolated into
  `run:` (expression injection). A non-required check sets job-level `continue-on-error: ${{ !matrix.check.required }}`,
  so its failure never fails the run (FR-13); a required one fails its leg. The job never changes a Build's status. **This is a requirement on
  APW-05's workflow generator**, implemented in T15; APW-05 FR-5 ("exactly one file") holds — the matrix job lives
  in the same file. The existing sweep then reads the legs as ordinary provider checks: a red required leg makes
  `ciState = failing`, which feeds the CI fix loop; `prChecks` renders every leg.
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

### 2.5 Protected paths and size (FR-20…FR-28)

`AppChangeGuard.evaluate({ work, rules, baseRef, headRef })` calls
`git.getCompareDiff(owner, repo, baseRef, headRef, { maxFiles: 300 })`. Refuse when `truncated` or
`totalFiles >= 300`. Match each `path` **and**
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

### 2.6 Keeping Work columns in step with the App spec

A listener on APW-03's in-process `AppSpecAppliedEvent` (`app.spec.applied`) sets, idempotently:
`taskIsolation = 'worktree'`, `taskIsolationBaseBranch = spec.source.branch` (read through
`AppSpecService.getEffectiveSpec(workId, event.commitSha)`), `taskIsolationTargetRepo = 'data'`.
`resolveTaskIsolation`
returns `'on'` for `work.kind === 'app'` regardless of `task.isolationMode`, and the dispatch path refuses an App
Work Task whose Agent lacks `canCommitToRepo` (FR-9) instead of silently running without a workspace.

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
"merge recorded once" (S29) a database guarantee.

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
export const APP_INSTRUCTION_FILE_MAX_BYTES = 32 * 1024;
export const APP_INSTRUCTION_FILES_TOTAL_MAX_BYTES = 64 * 1024;
export const APP_PR_SIZE_GUIDANCE_DEFAULT = 500;
export const APP_PR_SIZE_GUIDANCE_MIN = 50;
export const APP_PR_SIZE_GUIDANCE_MAX = 5_000;
export const APP_PR_SIZE_HARD_MULTIPLIER = 3;
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

Additive contract changes elsewhere: `TaskCheckResult.status` gains `'not-admitted'`
([`packages/contracts/src/tasks/task-gates.types.ts`](../../../../../packages/contracts/src/tasks/task-gates.types.ts));
`AgentEscalationReasonCode` gains `'delivery-failed'` (prior `0.85` in `REASON_PRIOR`); `GoalLoopReasonCode` gains
`'awaiting-merge'` and `'work-unavailable'`; `ActivityActionType` gains one family `APP_CHANGE = 'app_change'`
(Resolution R-2): every row has `actionType = 'app_change'` and `action` = the dotted CONTRACTS §6 event
(`app.change.merged`, `app.change.live`, `app.change.failed`, `app.change.closed`, `app.change.follow_up_opened`);
`details` carry ids, shas and state names only. `ActivityTypeBadge` maps `app_change` → `appChange`.

The file sits in `packages/contracts/src/apps/` — the one folder for every App Works shared type (Resolution R-1) —
and is exported from `packages/contracts/src/apps/index.ts` (created by APW-03 T1).

### 3.5 Migrations (Constitution V, forward-only, reserved block `179208<slot>00000`)

| Slot | File                                                                    | Phase | `up()`                                                                                                        |
| ---- | ----------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| 00   | `apps/api/src/migrations/1792080000000-AddTaskDeliveryState.ts` _(new)_ | P1    | six `ADD COLUMN` on `tasks`; `idx_tasks_delivery_due`; partial unique `uq_tasks_work_merge_commit`.           |
| 01   | `apps/api/src/migrations/1792080100000-AddGoalWorkScope.ts` _(new)_     | P2    | `ADD COLUMN "workId" uuid NULL` on `goals`; `idx_goals_work`.                                                 |
| 02   | `apps/api/src/migrations/1792080200000-AddMissionTaskOutput.ts` _(new)_ | P2    | `outputMode varchar(8) NOT NULL DEFAULT 'ideas'`, `taskOutput text NULL`, `taskOutputNoticeAt` on `missions`. |

`down()` drops only what `up()` added. Every column guarded with `table.findColumnByName` like
`1789900000000-AddWorkRepoDeclaredCommands.ts`, so re-runs are no-ops. SQLite: the partial unique index uses the
same `WHERE` syntax (supported); timestamps via `TIMESTAMP WITH TIME ZONE` on Postgres and `datetime` on SQLite,
branching on `queryRunner.connection.options.type`. P0 has **no migration**. Re-stamp before merge if `develop`
has moved past `1791240000000` (newest on `ee45946e5`; still below this epic's `179208…` block).

---

## 4. API

All routes are JWT-guarded, scoped with `@CurrentUser()`, check Work access through `WorkOwnershipService`
(`ensureCanView` for reads, `ensureCanEdit` for writes), and answer **404** for another account's ids.

| Method         | Path                                            | Controller                                             | Body / query                                                                | Returns                                            | Throttle          |
| -------------- | ----------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------- | ----------------- |
| `POST`         | `/api/works/:id/evolve`                         | `apps/api/src/works/work-evolve.controller.ts` _(new)_ | `EvolveWorkDto { request (1–4000), agentId?, attachmentUploadIds? (≤ 10) }` | `202 { taskId, taskSlug, runId \| null, agentId }` | 10 / min per user |
| `GET`          | `/api/tasks/:id/delivery`                       | `apps/api/src/tasks/tasks.controller.ts`               | —                                                                           | `TaskDeliveryView`                                 | default           |
| `POST`         | `/api/tasks/:id/delivery/close`                 | same                                                   | `{ note? (≤ 500) }`                                                         | `TaskDeliveryView`                                 | 30 / min          |
| `POST`         | `/api/tasks/:id/delivery/follow-up`             | same                                                   | —                                                                           | `202 { taskId }`                                   | 10 / min          |
| `GET`          | `/api/tasks/:id/cost`                           | same                                                   | —                                                                           | `TaskCostView`                                     | default           |
| `GET`          | `/api/tasks` (extended)                         | same                                                   | `deliveryState?`, `includeDelivery?`                                        | rows gain `delivery: { state, liveUrl } \| null`   | unchanged         |
| `POST`/`PATCH` | `/api/me/goals`, `/api/me/goals/:id` (extended) | `apps/api/src/goals/goals.controller.ts`               | `workId?: uuid \| null`                                                     | Goal DTO gains `workId`, `workName`                | unchanged         |
| `PATCH`        | `/api/me/missions/:id` (extended)               | `apps/api/src/missions/missions.controller.ts`         | `outputMode?`, `taskOutput?`                                                | Mission DTO gains both                             | unchanged         |
| `POST`         | `/api/me/missions` (extended)                   | same                                                   | `templateInputs? { product (≤ 80), business (≤ 80), appWorkId }`            | unchanged                                          | unchanged         |

Error contract:

| Situation                                              | Status | Body                                                                                |
| ------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------- |
| `evolve` on a non-`app` Work                           | `422`  | `{ code: 'notAppWork' }`                                                            |
| `evolve` with no resolvable Agent and none passed      | `409`  | `{ code: 'agentRequired', candidates: [{ id, name }] (≤ 20) }`                      |
| `evolve` with no admissible runtime                    | `422`  | `{ code: 'noIsolatedRuntime' }`                                                     |
| `delivery/close` on a Task not in a failed/built state | `422`  | `{ code: 'notClosable', state }`                                                    |
| `delivery/follow-up` past the chain limit (manual)     | `200`  | allowed once per Inbox item (`Try once more`), else `409 { code: 'followUpLimit' }` |
| Goal `workId` change while the loop runs               | `409`  | `{ code: 'loopRunning' }`                                                           |
| Mission `outputMode: tasks` with no app relation       | `200`  | accepted; `warnings: ['noAppWorkRelation']`                                         |

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

| Job                       | Where                                                                                                                           | Trigger                 | Notes                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-change-delivery`     | `packages/tasks/src/tasks/trigger/app-change-delivery.task.ts` _(new)_                                                          | cron `1-59/2 * * * *`   | Offset by one minute from `task-pr-status-sync` (`*/2`) so a merge recorded on an even minute is reconciled on the next odd one. ≤ 200 Tasks/tick; per-Task isolation; idempotent (pure decision over current rows). Emits `app.change.delivery.sweep` counters. |
| `mission-tick` (extended) | [`packages/tasks/src/tasks/trigger/mission-tick.task.ts`](../../../../../packages/tasks/src/tasks/trigger/mission-tick.task.ts) | unchanged (`* * * * *`) | Task output branch inside `MissionTickService.evaluateAndRun` (`packages/agent/src/missions/mission-tick.service.ts`); behind the workspace-pause start check that AW-24 P3 (T34, not yet built) plans for that method.                                          |
| Follow-up creation        | inside `app-change-delivery`                                                                                                    | —                       | Dedup key `followup:<originalTaskId>:<failedBuildOrDeploymentId>` as a Task label, checked before create — one follow-up per failure record.                                                                                                                     |

`APP_CHANGE_DELIVERY_DISPATCHER` is **not** needed: the reconciler is a scheduled task and the merge hook runs
inside the existing sweep. Evolve requests dispatch the run through `TaskTransitionService.dispatchAgentRun`, which
already routes through the job runtime (Constitution IV); the endpoint returns `202`.

Mutual exclusion: a reconcile write is
`UPDATE tasks SET "deliveryState" = :to … WHERE id = :id AND ("deliveryState" IS NOT DISTINCT FROM :from)`; a lost
race is a no-op the next tick repeats.

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

---

## 8. Telemetry and failure modes

### 8.1 Events (counters and ids only)

| Event                              | Properties                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `app.change.started`               | `{ workId, taskId, source: 'chat' \| 'board' \| 'goal' \| 'mission' }`                       |
| `app.change.guard_refused`         | `{ workId, taskId, reason: 'protected' \| 'too_many_files' \| 'too_large' \| 'spec_field' }` |
| `app.change.merged`                | `{ workId, taskId }`                                                                         |
| `app.change.delivered`             | `{ workId, taskId, minutesMergeToLive, carried: boolean }`                                   |
| `app.change.delivery_failed`       | `{ workId, taskId, phase: 'build' \| 'deploy', followUp: boolean }`                          |
| `app.change.closed_without_deploy` | `{ workId, taskId }`                                                                         |
| `app.change.delivery.sweep`        | `{ scanned, changed, failed, durationMs }`                                                   |
| `mission.task_output.tick`         | `{ missionId, worksConsidered, tasksFiled, skippedCap, skippedDuplicate }`                   |

The names and property types live in one typed module, `packages/monitoring/src/posthog/app-change-events.ts`
_(new, modelled on `kb-events.ts`)_, whose `emitAppChangeEvent(client, distinctId, event)` refuses a forbidden
property key (`prompt`, `diff`, `path`, `paths`, `log`, `logTail`, `title`, `body`, `request`) the same way
`emitKbEvent` does.

### 8.2 Failure modes

| Failure                                       | Behaviour                                                                                                             | Why                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| App spec at base commit invalid or unreadable | Run does not start: **"The App spec on {branch} is invalid — fix it before starting changes."**                       | Rules that cannot be read must not default to "no rules".    |
| `getCompareDiff` throws                       | No pull request; Task `BLOCKED` with **"Couldn't verify this change's files. Try again."**                            | Fail closed on a guard.                                      |
| Provider lacks `isAncestorCommit`             | Exact-sha matching only; a coalesced Build leaves the state at `merged` until a later exact match or **Close anyway** | Never claim live without proof.                              |
| APW-05/06 tables absent (epic not merged)     | `isDeliveryTracked` returns false → today's `completeOnMerge`                                                         | P1 degrades to current behaviour instead of stranding Tasks. |
| Reconciler throws for one Task                | Logged; others continue; `deliveryUpdatedAt` untouched so it is retried first                                         | Per-Task isolation, same as the PR sweep.                    |
| Follow-up creation fails                      | Escalation `delivery-failed` recorded instead                                                                         | A failure must reach a person.                               |
| Two workers reconcile the same Task           | Compare-and-set on `deliveryState`                                                                                    | Idempotent convergence.                                      |
| Commit lock wait exceeds 120 s                | Tool returns the FR-6 error; nothing written                                                                          | Never interleave writes in a shared working copy.            |
| Mission planner returns prose / invalid JSON  | Tick files nothing for that Work; `skippedInvalid` counted                                                            | Never store a shape we did not ask for.                      |
| Goal's Work deleted mid-loop                  | `decideGoalLoop` → `pause` / `work-unavailable`                                                                       | S26.                                                         |
| Run parked by a stop or pause (R-17)          | Waiting; no gate attempt, no follow-up, no delivery failure; resumes when released                                    | FR-66 — a person's hold is not a failure.                    |
| Safety rail refuses an action (R-17)          | `needs_input`: Task `BLOCKED` + escalation `guardrail-refusal`; no gate attempt, no follow-up                         | FR-67 — a refusal needs a decision, not a retry.             |
| No Agent resolves for a system-opened Task    | Task unassigned, not dispatched; one owner notification (APW-02 sends it)                                             | FR-9 / R-21.                                                 |

---

## 9. Test plan

### 9.1 Unit — agent package (Jest)

| File                                                                                        | Covers                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent/src/app-works/__tests__/app-work-rules.service.spec.ts` _(new)_             | Reads rules at base ref; caps (20 checks, 5 files, 32/64 KB); invalid spec → refusal; defaults (500 guidance).                                                                                                              |
| `packages/agent/src/app-works/__tests__/app-change-guard.spec.ts` _(new)_                   | Protected glob hit on path and `previousPath`; `.github/workflows/**`; spec-field changes; removal from protected lists; 300-file and truncated refusal; lockfile exclusion; guidance note vs 3× refusal; APW-04 exemption. |
| `packages/agent/src/app-works/__tests__/task-delivery.rules.spec.ts` _(new)_                | `decideDelivery` table: every state transition in spec §5.3, carry-along, target None, strategy none, cancelled/skipped Deployments, live-with-warnings.                                                                    |
| `packages/agent/src/app-works/__tests__/task-delivery.service.spec.ts` _(new)_              | `recordMerge` idempotency (unique index), follow-up limits (2 per chain, 3 open per Work), escalation fallback, auto-cancel of follow-ups.                                                                                  |
| `packages/agent/src/tasks-domain/__tests__/task-pr-status.delivery.spec.ts` _(new)_         | Tracked merge skips `completeOnMerge`; untracked merge unchanged; other-branch merge unchanged (S19).                                                                                                                       |
| `packages/agent/src/tasks-domain/__tests__/task-isolation.app.spec.ts` _(new)_              | `app` forces `on`; other kinds byte-identical (golden table).                                                                                                                                                               |
| `packages/agent/src/tasks-domain/__tests__/repo-declared-commands.app.spec.ts` _(new)_      | `spec.checks` mapping; allow-list admission; `not-admitted` result; `repo` kind unchanged.                                                                                                                                  |
| `packages/agent/src/goals/__tests__/goal-orchestrator-rules.awaiting-merge.spec.ts` _(new)_ | `awaiting-merge` counts into the ceiling; `work-unavailable`; every pre-existing case identical.                                                                                                                            |
| `packages/agent/src/goals/__tests__/goal-orchestrator.work-scope.spec.ts` _(new)_           | Iteration Task created with `workId`; null `workId` unchanged.                                                                                                                                                              |
| `packages/agent/src/missions/__tests__/mission-tick.task-output.spec.ts` _(new)_            | `ideas` untouched; `tasks`/`both`; caps; duplicate titles; backlog vs todo+dispatch; ≤ 5 Works; once-per-day notice.                                                                                                        |
| `packages/agent/src/missions/__tests__/mission-template-defaults.spec.ts` _(new)_           | `applyDefaults` wired on create; new manifest keys; explicit nulls not clobbered.                                                                                                                                           |
| `packages/agent/src/app-works/__tests__/app-spec-applied.listener.spec.ts` _(new)_          | Source branch `production` → `taskIsolationBaseBranch = 'production'`, `taskIsolation = 'worktree'`; second event is a no-op.                                                                                               |
| `packages/agent/src/tasks-domain/__tests__/task-workspace.app-base-branch.spec.ts` _(new)_  | ACC-08-06: an App Work Task's branch is cut from `production` and its pull request targets `production`, never the repository default branch.                                                                               |
| `packages/agent/src/tasks-domain/__tests__/task-pr-status.app-checks.spec.ts` _(new)_       | ACC-08-09: a red required `Ever Works check: {name}` leg → gate red, one fix-loop resume per attempt, `BLOCKED` + escalation `gate-exhausted` when spent; a red non-required leg changes nothing.                           |
| `packages/agent/src/app-works/__tests__/isolated-run-admission.spec.ts` _(new)_             | Fleet admitted; enforcing pipeline + `limited` admitted; unrestricted or no flag refused; an admitted run whose Agent is paused is parked, not refused.                                                                     |
| `packages/agent/src/app-works/__tests__/app-work-run-holds.spec.ts` _(new)_                 | ACC-08-31: parked (`kill-switch`, `agent-paused`, stop/pause rails) consumes no attempt and opens no follow-up; `ladder`/`rules` refusal → `BLOCKED` + `guardrail-refusal`, no attempt, no follow-up.                       |
| `packages/agent/src/app-works/__tests__/app-work-agent-resolver.spec.ts` _(new)_            | ACC-08-32: recent-task → pinned → assigned order; archived and `canCommitToRepo: false` skipped; two pinned and no recent Task → `null`.                                                                                    |

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

| File                                            | Golden path                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/web/e2e/app-works-evolve-chat.spec.ts`    | Work chat → confirmation → Task created → chain card renders (API mocked at the provider boundary).                |
| `apps/web/e2e/app-works-delivery-chips.spec.ts` | Seeded Tasks in each delivery state render the right chip text; Delivery filter narrows; **Close anyway** confirm. |
| `apps/web/e2e/app-works-guard-refusals.spec.ts` | Protected path, too large and not-admitted copy on Task detail.                                                    |
| `apps/web/e2e/goals-work-scope.spec.ts`         | Goal form Work select; disabled while running.                                                                     |
| `apps/web/e2e/missions-task-output.spec.ts`     | Output card, limits, Tasks-on-Works panel, template form summary.                                                  |

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
the command only through `env.CHECK_COMMAND`, `continue-on-error` only on the non-required leg; byte-identical on two
runs.

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
- [x] **III — Source-of-truth repositories.** App rules are read from `.works/works.yml` in the data repository at
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
      with APW-02 (§2.8); R-22 no `apps/api/test/` suites (§9).

### Known gaps carried forward

- `.github/workflows/**` protection is blanket (spec §9).
- Checks for cloud runs require a pull request to exist (spec §9); the CI fix loop, not "no PR on red", governs.
- The isolated-run predicate depends on a pipeline that enforces Environment networking; today that is one
  pipeline plugin.
- Mission Task output is limited to App Works.
- `MissionTemplateManifestService.applyDefaults` gets its first caller here; the two starter templates' manifests
  start being honoured at the same time — called out in the P3 PR description.
