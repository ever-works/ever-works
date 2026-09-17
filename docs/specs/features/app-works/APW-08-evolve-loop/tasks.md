# Task Breakdown: Evolve loop

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with tests
> per **Constitution VI**. Schema tasks ship their migration in the same PR per **Constitution V**.

**Epic ID**: `APW-08-evolve-loop`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. `(new)` marks a file that does not exist yet; every other
  path was checked with `git ls-files` on `develop` @ `ee45946e5`.
- Every task carries **Create**/**Modify**, **Test** and **Done when**. "Done when" is checkable without reading the
  diff.
- Add new tasks at the bottom rather than renumbering.
- Phase boundaries are ship boundaries: `develop` must be green and deployable at the end of each phase.
- Commands run from the monorepo root unless stated; migrations are authored from `apps/api/`.
- Migration timestamps come from the reserved block `179208<slot>00000`; re-stamp if `develop` moved past
  `1791240000000` (newest on `ee45946e5`, re-verified 2026-09-17).
- Program resolutions applied (CONTRACTS §0): R-1 (shared types in `packages/contracts/src/apps/`), R-2 (one Activity
  family `app_change`), R-9 (per-check CI matrix), R-17 (safety rails), R-21 (agent-resolution rule), R-22 (no
  `apps/api/test/` suites).

---

# Phase P0 — Agent git tools (Wave 0, independent PR `fix/apw-08-agent-git-tools`)

_Delivers FR-1…FR-8. No migration, no UI._

- [ ] **T1. Write the failing tests first.**
      **Modify** `apps/api/src/agents/agents.module.spec.ts` — add a `describe` block titled
      `api-side AgentsModule — AGENT_GIT_FACADE coordinates (APW-08 P0)` that builds the real factory from
      `findProvider(AGENT_GIT_FACADE)` with stubs. Each case asserts today's defect **before** any production change.
      Case 1 — `commitToRepo` on a Work with `gitProvider: 'gitlab'` never passes `providerId: ''` to any git call and
      passes `'gitlab'` to `commit` and `push` (today: `getRepoDir` receives `''`, `commit` receives `'github'`).
      Case 2 — the clone targets `work.getRepoOwner('data')` / `work.getDataRepo()`; a Work whose `sourceRepository`
      points at a different import source is **not** cloned (today: `getRepoDir` reads `sourceRepository.owner/repo`).
      Case 3 — `commitToRepo({ branch: 'feature-x' })` switches to `feature-x`, pushes with `ref: 'feature-x'`, and the
      result's `branch` is `feature-x` (today: no switch, no `ref`, `branch ?? 'main'`).
      Case 4 — `commitToRepo` with no branch on a Work whose base branch is `main` and whose resolved merge policy
      protects `main` writes no file, calls no `commit` / `push`, and rejects with the FR-3 copy.
      Case 5 — `openPullRequest` calls `createPullRequest` with the Work Repository's owner and repo (today `''`/`''`)
      and `base` = `work.taskIsolationBaseBranch` when set, else the repository default branch.
      Case 6 — two concurrent `commitToRepo` calls on one Work do not interleave (the second `switchBranch` starts
      after the first `push` resolves).
      Case 7 — a source-text assertion: the factory body in `apps/api/src/agents/agents.module.ts` contains no
      `'github'` literal.
      **Test**: `cd apps/api && pnpm test agents.module.spec` — the seven new cases fail on `develop` and every
      pre-existing case in the file still passes (ACC-08-01…ACC-08-05, red half).
      **Done when**: the red output of the seven cases is pasted into the PR description, and the same command is green
      after T3 and T4.
      **Note (re-verified on `ee45946e5`)**: the spec file now mocks `@ever-works/agent/safety` at module scope and
      pins the `SAFETY_GATE` binding (AW-24); keep both the module mock and the binding assertion. The safety gate
      runs in `AgentRunService.invokeTool` above this adapter, so these factory-level cases need no rung setup, and
      the adapter must not add a second gate (Resolution R-17).

- [ ] **T2. Keyed commit lock.**
      **Create** `apps/api/src/agents/work-commit-lock.ts` (new) — `withWorkCommitLock(workId, fn, waitMs = 120_000)`
      over a `Map<string, Promise<void>>`; rejects with `Another commit to this Work is in progress.` when the wait
      elapses; the entry is released when `fn` throws.
      **Test**: `apps/api/src/agents/work-commit-lock.spec.ts` (new) — two calls on one `workId` run in order; calls on
      two `workId`s run concurrently; a wait past `waitMs` rejects with the exact copy; a throwing `fn` releases the
      lock for the next caller. Run: `cd apps/api && pnpm test work-commit-lock`.
      **Done when**: the four cases pass.

- [ ] **T3. Rewrite `commitToRepo`.**
      **Modify** `apps/api/src/agents/agents.module.ts` — per [plan §2.2](./plan.md): resolve Work → provider from
      `work.gitProvider` (refuse when empty) → data-repo coordinates → `getRepository` default branch → base →
      target; resolve merge policy through `MergePolicyService` (`packages/agent/src/policy/merge-policy.service.ts`;
      append it to the factory `inject` array — append only); refuse a protected target; inside `withWorkCommitLock`
      call `cloneOrPull({ owner, repo, branch: base, autoSwitchToMainBranch: false })`,
      `switchBranch(provider, dir, target, create)`, keep the existing path confinement block verbatim,
      `commit(provider, …)`, `push({ dir, ref: target, remoteRef: target }, opts)`; return the real branch.
      **Modify** `apps/api/src/agents/agents.module.spec.ts` — the existing `describe('… AGENT_GIT_FACADE PR gate')`
      block's `inject` expectation includes the appended `MergePolicyService`.
      **Test**: `cd apps/api && pnpm test agents.module.spec` — T1 cases 1–4, 6 and 7 pass; the PR-gate block passes
      (ACC-08-01, 02, 03, 05).
      **Done when**: those cases are green and `getRepoDir` is no longer called by the adapter (a spy asserts zero
      calls).

- [ ] **T4. Rewrite `openPullRequest`.**
      **Modify** `apps/api/src/agents/agents.module.ts` — same coordinate resolution; `prGate.assertAllowed` keeps
      running first with `cwd` from a `cloneOrPull` of the base branch;
      `createPullRequest({ owner, repo, head, base: input.base ?? base, … }, { userId, providerId: work.gitProvider, workId })`;
      refuse when the head branch does not exist (`listBranches`).
      **Test**: `cd apps/api && pnpm test agents.module.spec` — T1 case 5 passes; a new case asserts a missing head
      branch is refused with the FR-5 copy and no `createPullRequest` call (ACC-08-04).
      **Done when**: T1 case 5, the missing-head case and every pre-existing PR-gate case are green.

- [ ] **T5 (parallel with T4). Tool contract wording.**
      **Modify** `packages/agent/src/agents/agent-git-facade.ts` — `branch` doc: "Defaults to the Work's Task base
      branch; refused when that branch is protected by the merge policy."
      **Modify** `packages/agent/src/agents/agent-tool.service.ts` `buildCommitToRepoTool` description to match.
      **Test**: extend `packages/agent/src/agents/__tests__/agent-tool-git.spec.ts` — the description mentions the
      protected-branch refusal; forwarding to the facade is unchanged. Run:
      `pnpm --filter @ever-works/agent test agent-tool-git`.
      **Done when**: the spec is green.

- [ ] **T6. P0 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-08 row notes ("P0 merged") and this file's P0
      checkboxes.
      **Test**: `pnpm format:check && pnpm lint && pnpm type-check && pnpm test` at the root.
      **Done when**: all four commands are green and the PR merges alone, with T1's red output in its description.

---

# Phase P1 — The loop on an App Work (Wave 1)

_Delivers FR-9…FR-44 and FR-61…FR-68. Requires APW-01, APW-03, APW-05 P1, APW-06 P1 on `develop`; every
integration point degrades to today's behaviour when their tables are absent (plan §8.2)._

## P1.1 — Contracts and provider additions

- [ ] **T7. Shared types.**
      **Create** `packages/contracts/src/apps/task-delivery.types.ts` (new) exactly as [plan §3.4](./plan.md)
      (Resolution R-1).
      **Modify** `packages/contracts/src/apps/index.ts` (created by APW-03 T1; if APW-03 has not landed, create it and
      add `export * from './apps/index.js';` to `packages/contracts/src/index.ts` exactly as APW-03 T1 specifies) —
      `export * from './task-delivery.types.js';`.
      **Modify** `packages/contracts/src/tasks/task-gates.types.ts` — `TaskCheckResult.status` gains `'not-admitted'`.
      **Modify** `packages/contracts/src/agents/escalation.types.ts` — append `'delivery-failed'` to the union and to
      `AGENT_ESCALATION_REASON_CODES`; **modify** `packages/agent/src/agents/escalation-confidence.ts` —
      `REASON_PRIOR['delivery-failed'] = 0.85`.
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append one family
      `APP_CHANGE = 'app_change'` (Resolution R-2; the dotted `app.change.*` event goes in `action`).
      **Test**: `packages/contracts/src/apps/__tests__/task-delivery.types.spec.ts` (new) pins the state union and
      every numeric constant; `packages/contracts/src/agents/__tests__/escalation.types.spec.ts` (new) asserts
      `'delivery-failed'` is the last entry of `AGENT_ESCALATION_REASON_CODES` and every earlier entry is unchanged;
      `packages/agent/src/agents/__tests__/escalation-confidence.spec.ts` (new) asserts the `0.85` prior; extend
      `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` with `['APP_CHANGE', 'app_change']`.
      Run: `pnpm --filter @ever-works/contracts test` and `pnpm --filter @ever-works/agent test activity-log.types`.
      **Done when**: the specs are green, `pnpm --filter @ever-works/contracts build` emits declarations, and
      `import { TASK_DELIVERY_STATES } from '@ever-works/contracts'` resolves from `apps/api`.

- [ ] **T8. Merge commit and ancestry on the git capability.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` —
      `GitPullRequestStatus.mergeCommitSha?: string | null`; optional
      `isAncestorCommit?(owner, repo, ancestorSha, descendantSha, token): Promise<boolean | null>`.
      **Modify** `packages/plugins/github/src/github-api.service.ts` — map `pr.merge_commit_sha` in
      `getPullRequestStatus`; implement `isAncestorCommit` with `repos.compareCommitsWithBasehead`
      (`ahead|identical` → true, `behind|diverged` → false, 404 → null). Expose through the plugin class.
      **Modify** `packages/agent/src/facades/git.facade.ts` — `isAncestorCommit(owner, repo, a, d, options)` returning
      `null` when the provider lacks the method.
      **Test**: `packages/plugins/github/src/__tests__/github-api.service.ancestry.spec.ts` (new, beside
      `github-api.service.pr-insights.spec.ts`) — five compare outcomes + `mergeCommitSha` mapping;
      `packages/agent/src/facades/__tests__/git.facade.ancestor.spec.ts` (new) — pass-through and `null` for a
      provider without the method. Run: `pnpm --filter @ever-works/github-plugin test` and
      `pnpm --filter @ever-works/agent test git.facade`.
      **Done when**: both new specs are green and `github-api.service.pr-insights.spec.ts` passes unchanged.

## P1.2 — Schema

- [ ] **T9. Task delivery columns + migration.**
      **Modify** `packages/agent/src/entities/task.entity.ts` — append the six columns of [plan §3.1](./plan.md)
      (dates via `PortableDateColumn`) and both indexes. Append only.
      **Create** `apps/api/src/migrations/1792080000000-AddTaskDeliveryState.ts` (new) — guarded `ADD COLUMN`s, the
      two indexes (partial unique on both engines), `down()` drops only these.
      **Test**: `apps/api/src/migrations/__tests__/AddTaskDeliveryState.spec.ts` (new) — a second `up()` is a no-op; no
      pre-existing column is dropped or renamed; `down()` removes exactly the six columns and two indexes. Run:
      `cd apps/api && pnpm test AddTaskDeliveryState`.
      **Done when**: the spec is green and a database with existing Tasks migrates with every existing Task reading
      `deliveryState = NULL`.

## P1.3 — App rules, isolation, runtime admission

- [ ] **T10. `AppWorkRulesService`.**
      **Create** `packages/agent/src/app-works/app-work-rules.service.ts` (new) and export it from
      `packages/agent/src/app-works/index.ts` (created by APW-02 T15; the one App Works services folder) — `resolve(work, baseSha)` calls APW-03's `AppSpecService.getEffectiveSpec(workId, baseSha)` and returns
      `{ sourceBranch, checks (≤ 20), protectedPaths, humanMergePaths, instructionFiles (≤ 5), sizeGuidance }` with
      `sizeGuidance` defaulting to 500, clamped 50..5000; an `invalid` or unreadable spec throws
      `AppSpecUnreadableError` naming the branch. Never reads the Task branch.
      **Modify** `packages/agent/src/tasks-domain/tasks.module.ts` — append `AppWorkRulesService` to `providers` and
      `exports` (append only; the apps services live in this module to avoid a module cycle with
      `TaskTransitionService`).
      **Test**: `packages/agent/src/app-works/__tests__/app-work-rules.service.spec.ts` (new) — `getEffectiveSpec` is called
      with the base sha, never the head; caps and defaults of plan §9.1; invalid spec → `AppSpecUnreadableError`. Run:
      `pnpm --filter @ever-works/agent test app-work-rules`.
      **Done when**: the spec is green.

- [ ] **T11. Keep the Work in step with the App spec; force isolation.**
      **Create** `packages/agent/src/app-works/app-spec-applied.listener.ts` (new) — `@OnEvent` for APW-03's
      `AppSpecAppliedEvent` (`app.spec.applied`); read the spec at `event.commitSha`, then set
      `taskIsolation = 'worktree'`, `taskIsolationBaseBranch = spec.source.branch`, **`taskIsolationTargetRepo = 'website'`**
      with an ownership-scoped update; idempotent.
      **Why `website` and not `data` (2026-09-17):** an App Work's app-code fork is the **Work Repository** — the
      `website` role, whose UI label is literally "Work Repository" (`work-capabilities.ts:40-49`) — while `data`
      holds the Work's *data* (README §1 repository-role note, APW-01 plan §3.1). Setting the target to `data`
      would point every Task at the wrong repository, and it is not enough to set the field: **consume it.**
      `getRepoOwner()` still defaults to `data` (`work.entity.ts:831`) and `TaskWorkspaceService.provisionForRun`
      still hard-codes `getRepoOwner()` / `getDataRepo()` (`task-workspace.service.ts:219-220`), so the field is
      currently *declared but unconsumed* — this task is what consumes it, and the same resolution must be honoured
      by the build (APW-05), the deployment (APW-06) and `GitFacadeService.getRepoDir`.
      **Modify** `packages/agent/src/tasks-domain/task-isolation.ts` — `resolveTaskIsolation` returns `'on'` when
      `work.kind === 'app'` and the Task has a Work (the `agentCanCommit === false` branch is unchanged here).
      **Modify** `packages/agent/src/tasks-domain/task-transition.service.ts` `dispatchAgentRun` — refuse an App Work
      Task whose Agent lacks `canCommitToRepo` with the FR-9 copy.
      **Modify** `packages/agent/src/tasks-domain/tasks.module.ts` — append the listener to `providers`.
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-isolation.app.spec.ts` (new) — `app` forced on with
      isolation off; a golden table proves every other kind unchanged (ACC-08-07, first half);
      `packages/agent/src/app-works/__tests__/app-spec-applied.listener.spec.ts` (new) — source branch `production` sets
      `taskIsolationBaseBranch = 'production'`; a second event writes nothing;
      `packages/agent/src/tasks-domain/__tests__/task-workspace.app-base-branch.spec.ts` (new) — on an App Work whose
      base is `production`, `provisionForRun` cuts the Task branch from `production` and `openPullRequestForBranch`
      targets `production`, never the repository default branch (ACC-08-06); **and a case proving the clone targets the
      `website`-role repository, not `<slug>-data`**; extend
      `packages/agent/src/tasks-domain/__tests__/task-transition.service.spec.ts` — an App Work Task with an Agent
      whose `canCommitToRepo` is `false` is refused with the FR-9 copy and no run is dispatched (ACC-08-07, second
      half). Run: `pnpm --filter @ever-works/agent test task-isolation task-workspace task-transition app-spec-applied`.
      **Done when**: all four specs are green and the pre-existing `task-isolation.spec.ts` passes unchanged.

- [ ] **T12. Isolated-run admission.**
      **Depends on** APW-04's `IPipelinePlugin.enforcesRuntimeNetworking?: boolean` (CONTRACTS §3); if APW-04 has not
      landed, add that optional field to `packages/plugin/src/contracts/capabilities/pipeline-plugin.interface.ts`
      exactly as APW-04 specifies and set it only in `packages/plugins/claude-managed-agent/` — the one pipeline that
      enforces Environment networking today.
      **Create** `packages/agent/src/app-works/isolated-run-admission.ts` (new) — `isAppWorkRunAdmitted(task, plan)`: admit
      when the run is planned for a Fleet node, or when the resolved pipeline plugin has
      `enforcesRuntimeNetworking === true` and the Agent's resolved Environment is `limited`. No plugin id in core.
      **Modify** `packages/agent/src/tasks-domain/task-transition.service.ts` — refuse App Work dispatch when not
      admitted (`noIsolatedRuntime`).
      **Coordinate (safety rails, Resolution R-17)**: keep this refusal ahead of `RunDispatchGateService`
      (`packages/agent/src/agents/run-admission-chain.ts`); do not add it to `DEFAULT_RUN_ADMISSION_CHAIN`, whose
      middlewares park rather than refuse.
      **Test**: `packages/agent/src/app-works/__tests__/isolated-run-admission.spec.ts` (new) — Fleet admitted; flag +
      limited admitted; flag + unrestricted refused; no flag refused; an admitted App Work run whose Agent is paused is
      parked `agent-paused` by the existing chain, not refused (ACC-08-08, unit half). Run:
      `pnpm --filter @ever-works/agent test isolated-run-admission`.
      **Done when**: the five cases are green.

## P1.4 — Checks

- [ ] **T13. App checks on Fleet nodes.**
      **Modify** `packages/agent/src/tasks-domain/repo-declared-commands.ts` — `parseRepoDeclaredCommands(spec, kind)`:
      for `kind === 'app'` map `spec.checks` (≤ 20) to `TaskAcceptanceCheck`; `repo` unchanged.
      `admitRepoDeclaredCommands` returns non-admitted checks as `not-admitted` results instead of refusing the run
      **for `app` only**.
      **Modify** `packages/agent/src/tasks-domain/task-workspace.service.ts` `readFleetRepoDeclaredCommands` — pass
      `work.kind`.
      **Modify** `apps/api/src/fleet/fleet-agent-task-planner.service.ts` — carry `not-admitted` results into the gate
      so the gate is never green because of them.
      **Test**: `packages/agent/src/tasks-domain/__tests__/repo-declared-commands.app.spec.ts` (new) — mapping, the
      21st check ignored, allow-list admission, `not-admitted` result, a gate with one `not-admitted` required check is
      not green (ACC-08-10); `repo`-kind cases identical to `repo-declared-commands.spec.ts`. Run:
      `pnpm --filter @ever-works/agent test repo-declared-commands`.
      **Done when**: the new spec and the pre-existing `repo-declared-commands.spec.ts` and
      `task-workspace-repo-declared-commands.spec.ts` are green.

- [ ] **T14. Review-checks surface.**
      **Create** `apps/web/src/components/works/detail/AppChecksAdmissionCard.tsx` (new) — lists App spec checks with
      admitted state and **Admit for my machines**, writing the existing `repoDeclaredCommands` allow-list
      (`packages/agent/src/dto/update-work.dto.ts`) via `PATCH /api/works/:id`.
      **Modify** `apps/web/src/components/works/detail/settings/QualityGatesSettings.tsx` — mount the card for
      `work.kind === 'app'` only.
      **Test**: `apps/web/src/components/works/detail/AppChecksAdmissionCard.unit.spec.tsx` (new) — admitted and
      not-admitted rows render their text; **Admit for my machines** sends exactly the listed command; the card is
      absent for other kinds. Run: `pnpm --filter ever-works-web test AppChecksAdmissionCard`.
      **Done when**: the spec is green.

- [ ] **T15. App checks in the repository's CI — per-check matrix (with APW-05, Resolution R-9).**
      **Modify** `packages/plugins/github-actions-build/src/workflow/generator.ts` (created by APW-05 T8) — when the
      App spec has checks, emit one `checks` job on same-repository pull requests and on the tracked branch whose
      `strategy.matrix.check` lists the checks in App spec order (≤ 20) with `fail-fast: false` and `max-parallel: 5`; job name `Ever Works check: ${{ matrix.check.name }}`
      so each check reports its own check run; job `permissions: contents: read`; `timeout-minutes` from
      `timeoutSeconds`; checkout with `persist-credentials: false`; the command passed only through
      `env: EW_CHECK_COMMAND_B64` (base64, decoded to a temporary script); job-level
      `continue-on-error: ${{ !matrix.check.required }}` for non-required checks; no secret, `EW_` variable or cache
      reference; written for every build strategy and never changing a Build's status (CONTRACTS §3 row, R-9). Deterministic output (APW-05 FR-6). This replaces
      the earlier single-job, one-step-per-check design.
      **Create** `packages/plugins/github-actions-build/src/__tests__/golden/app-checks-two.yml` (new).
      **Test**: extend `packages/plugins/github-actions-build/src/__tests__/generator.spec.ts` with a two-check fixture
      (one required, one not) — output equals the golden file on two runs; two matrix legs; no `secrets.` inside the
      `checks` job; the command appears only under `env`; `continue-on-error` only on the non-required leg. Run:
      `pnpm --filter <github-actions-build package> test generator` (package name set by APW-05 T7).
      **Done when**: the spec is green and the golden workflow passes `actionlint` locally.

- [ ] **T16 (parallel with T15). Cloud gate never runs App checks.**
      **Modify** `packages/agent/src/tasks-domain/task-gates.ts` `resolveAcceptanceChecks` — for `work.kind === 'app'`,
      ignore any App spec source; only `checkDefaults` + Task checks resolve.
      **Test**: extend `packages/agent/src/tasks-domain/__tests__/task-gates.spec.ts` with an `app` case — App spec
      checks never appear in the resolved set; `repo` and template cases unchanged.
      **Create** `packages/agent/src/tasks-domain/__tests__/task-pr-status.app-checks.spec.ts` (new) — ACC-08-09: a
      pull request status whose required `Ever Works check: type-check` leg failed sets `ciState = failing`, offers the
      CI fix loop once per attempt up to `maxGateAttempts`, then moves the Task to `BLOCKED` with escalation
      `gate-exhausted`; a failed non-required leg leaves the gate unchanged. Run:
      `pnpm --filter @ever-works/agent test task-gates task-pr-status`.
      **Done when**: both specs are green and `task-pr-status.service.spec.ts` passes unchanged.

## P1.5 — Guard, instructions, merge

- [ ] **T17. `AppChangeGuard`.**
      **Create** `packages/agent/src/app-works/app-change-guard.ts` (new) — [plan §2.5](./plan.md): compare diff (≤ 300
      files, refuse on `truncated`), App spec protected paths through APW-03's `isProtectedPath` on `path` and
      `previousPath`, `.github/workflows/**` with `minimatch` (`dot: true`), App spec field protection through APW-03's
      `diffGuardedSpecBlocks(base, head)` (invalid head spec refuses), lockfile-excluded size, guidance note vs 3×
      refusal, APW-04 `app-provision` label exemption for the field rule only; `assertPathsAllowed(work, files)`.
      **Modify** `packages/agent/src/tasks-domain/task-workspace.service.ts` — call the guard in `finalizeRun` before
      `openPullRequestForBranch` and in `finalizeRemotePush` at the same point; refusal → Task `BLOCKED` +
      `postSystemMessage` with the §5.2 copy key; guidance note appended to the PR body.
      **Modify** `apps/api/src/agents/agents.module.ts` — for App Works, `commitToRepo` calls
      `assertPathsAllowed(files)` (FR-8; protected paths and `.github/workflows/**`) and `openPullRequest` runs
      `AppChangeGuard.evaluate` before `createPullRequest`, so the tools cannot bypass the guard (plan §2.3, R-17).
      **Modify** `packages/agent/src/tasks-domain/tasks.module.ts` — append the guard to `providers` and `exports`.
      **Test**: `packages/agent/src/app-works/__tests__/app-change-guard.spec.ts` (new) — every case in
      [plan §9.1](./plan.md) (ACC-08-11, 12, 14); extend `apps/api/src/agents/agents.module.spec.ts` — on an App Work,
      `commitToRepo` with a protected file writes nothing and `openPullRequest` on a guarded diff calls no
      `createPullRequest`. Run: `pnpm --filter @ever-works/agent test app-change-guard` and
      `cd apps/api && pnpm test agents.module.spec`.
      **Done when**: both specs are green.

- [ ] **T18. Run brief: protected paths, size guidance, instruction files.**
      **Modify** `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` (cloud) and
      `apps/api/src/fleet/fleet-agent-task-planner.service.ts` `composeInstructions` (Fleet) — for App Works prepend
      the protected paths and size guidance and the line "This Task pushes its branch and opens the pull request for
      you" (R-17), and append instruction files read at the base ref inside a fenced `UNTRUSTED REPOSITORY CONTENT`
      block, each passed through `neutralizeControlTokens`; enforce 5 / 32 KB / 64 KB; refuse symlinks and paths
      outside the repository.
      **Test**: `apps/api/src/fleet/fleet-agent-task-planner.app-brief.spec.ts` (new) — injected text is fenced and
      changes no tool list; limits enforced; a symlinked file refused (ACC-08-13); extend
      `packages/tasks/src/__tests__/agent-task-execute.task.spec.ts` with the same three cases for the cloud brief.
      Run: `cd apps/api && pnpm test fleet-agent-task-planner` and `pnpm --filter @ever-works/trigger-tasks test agent-task-execute`.
      **Done when**: both specs are green.

- [ ] **T19. Human-merge paths.**
      **Modify** `packages/agent/src/tasks-domain/task-merge-gate.service.ts` `evaluate` — for App Works, when the pull
      request diff touches `humanMergePaths`, refuse the agent merge with code `human-merge-path` and the FR-28 copy
      (recorded like other refusals).
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-merge-gate.app.spec.ts` (new) — with agent merge
      allowed, a diff touching a human-merge path is refused; an untouched diff merges; non-app Works unchanged
      (ACC-08-15). Run: `pnpm --filter @ever-works/agent test task-merge-gate`.
      **Done when**: the new spec and `task-merge-gate.service.spec.ts` are green.

## P1.6 — Delivery chain

- [ ] **T20. Pure delivery rules.**
      **Create** `packages/agent/src/app-works/task-delivery.rules.ts` (new) — `decideDelivery(input)` over merge sha,
      Builds, Deployments, ancestry answers, target and auto-deploy flags.
      **Test**: `packages/agent/src/app-works/__tests__/task-delivery.rules.spec.ts` (new) — the full table of plan §9.1
      (ACC-08-17, 18, 20, 21). Run: `pnpm --filter @ever-works/agent test task-delivery.rules`.
      **Done when**: every row of the table is a passing case.

- [ ] **T21. `TaskDeliveryService`.**
      **Create** `packages/agent/src/app-works/task-delivery.service.ts` (new) — `isDeliveryTracked`, `recordMerge`
      (partial unique index = once; Activity `actionType: 'app_change'`, `action: 'app.change.merged'`),
      `reconcile(batch)` with compare-and-set writes, closing through
      `TaskTransitionService.transition(task, DONE, { actorType: 'agent' })`, carry-along, and
      `closeWithoutDeploy(userId, taskId, note)`.
      **Create** `packages/agent/src/app-works/delivery-follow-up.service.ts` (new) — follow-up Task creation (title,
      relation `follow-up`, priority `p1`, label `followup:<taskId>:<failureId>`, 200-line redacted log tail via the
      existing secret redaction helper, fenced), limits 2 per chain / 3 open per Work, escalation `delivery-failed`
      fallback, auto-cancel.
      **Modify** `packages/agent/src/tasks-domain/tasks.module.ts` — append both services.
      A run parked by the admission chain or a stop/pause rail is a wait, and a run refused at the safety gate is
      `needs_input`; neither is a delivery failure and neither opens a follow-up (Resolution R-17).
      **Test**: `packages/agent/src/app-works/__tests__/task-delivery.service.spec.ts` (new) — `recordMerge` idempotency,
      follow-up limits, escalation fallback, auto-cancel (ACC-08-16, 18, 19, 20, 22). Run:
      `pnpm --filter @ever-works/agent test task-delivery.service`.
      **Done when**: the spec is green.

- [ ] **T22. Hook the PR-status sweep.**
      **Modify** `packages/agent/src/tasks-domain/task-pr-status.service.ts` `syncDuePrStatuses` — when
      `after.prState === 'merged'`, ask `TaskDeliveryService.isDeliveryTracked(after, status)`; tracked →
      `recordMerge`, skip `completeOnMerge`; else unchanged. Inject the service `@Optional()`, appended last.
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-pr-status.delivery.spec.ts` (new) — tracked,
      untracked, other-branch (ACC-08-23), service absent. Run: `pnpm --filter @ever-works/agent test task-pr-status`.
      **Done when**: the new spec and `task-pr-status.service.spec.ts` are green.

- [ ] **T23. `app-change-delivery` schedule.**
      **Create** `packages/tasks/src/tasks/trigger/app-change-delivery.task.ts` (new) — `schedules.task` cron
      `1-59/2 * * * *`, `withWorkerContext`, `TaskDeliveryService.reconcile({ limit: 200 })`, logs counters.
      **Modify** `packages/tasks/src/tasks/trigger/index.ts` — export it.
      **Test**: `packages/tasks/src/__tests__/app-change-delivery.task.spec.ts` (new, beside
      `task-pr-status-sync.task.spec.ts`) — cron string, batch size 200, one failing Task does not abort the tick. Run:
      `pnpm --filter @ever-works/trigger-tasks test app-change-delivery`.
      **Done when**: the spec is green.

## P1.7 — API and chat

- [ ] **T24. Delivery and cost endpoints.**
      **Modify** `apps/api/src/tasks/tasks.controller.ts` — `GET :id/delivery`, `POST :id/delivery/close`,
      `POST :id/delivery/follow-up`, `GET :id/cost`; list query `deliveryState`, `includeDelivery`; throttles and
      error codes per [plan §4](./plan.md); `ensureCanView` / `ensureCanEdit`.
      **Test**: `apps/api/src/tasks/tasks.controller.delivery.spec.ts` (new) — shapes, codes, cross-account 404
      (ACC-08-19, 22, 28, 29). Run: `cd apps/api && pnpm test tasks.controller.delivery`.
      **Done when**: the spec is green and the existing `tasks.controller.*.spec.ts` files pass unchanged.

- [ ] **T25. `evolve` endpoint and the agent-resolution rule.**
      **Create** `packages/agent/src/app-works/app-work-agent-resolver.ts` (new) — `AppWorkAgentResolver` +
      `APP_WORK_AGENT_RESOLVER` per [plan §2.8](./plan.md) (Resolution R-21): recent Task → only pinned → only
      assigned; archived or non-committing Agents skipped. Exported from `packages/agent/src/app-works/index.ts` for
      APW-02's conflict Task.
      **Create** `apps/api/src/works/work-evolve.controller.ts` (new) and `apps/api/src/works/dto/evolve-work.dto.ts`
      (new); **create** `packages/agent/src/app-works/app-change-request.service.ts` (new) — kind check, Agent resolution
      through the resolver (`409 agentRequired` with ≤ 20 candidates), `evolve-app` Skill binding at Work scope once
      (existing `SkillsService.createBinding` in `packages/agent/src/skills/skills.service.ts`, idempotent on the
      unique index), `TasksService.create` + `dispatchAgentRun`, admission refusal. Returns `202`.
      **Modify** `apps/api/src/works/works.module.ts` — register the controller; **modify**
      `packages/agent/src/tasks-domain/tasks.module.ts` — append the resolver and the service to `providers` and
      `exports`.
      **Test**: `apps/api/src/works/work-evolve.controller.spec.ts` (new) — 202 shape, `notAppWork`, `agentRequired`,
      `noIsolatedRuntime`, cross-account 404, throttle metadata (ACC-08-08, 24, 29);
      `packages/agent/src/app-works/__tests__/app-work-agent-resolver.spec.ts` (new) — order, skips, `null` (ACC-08-32,
      resolver half). Run: `cd apps/api && pnpm test work-evolve` and
      `pnpm --filter @ever-works/agent test app-work-agent-resolver`.
      **Done when**: both specs are green.

- [ ] **T26. Chat tool, card and Task thread posts.**
      **Modify** `apps/web/src/lib/ai/tools/generated/registry.ts` — append the `request_app_change` row
      ([plan §4](./plan.md)).
      **Create** `apps/web/src/components/ai/ChatChangeCard.tsx` (new).
      **Modify** `packages/agent/src/app-works/task-delivery.service.ts` and
      `packages/agent/src/tasks-domain/task-workspace.service.ts` — post the FR-43 thread messages as `{ key, params }`
      through `postSystemMessage` / `TaskChatService`.
      **Test**: `apps/web/src/components/ai/ChatChangeCard.unit.spec.tsx` (new) — confirmation copy, chain states,
      polling stops after 30 minutes; `apps/web/src/lib/ai/tools/generated/registry-parity.unit.spec.ts` stays green;
      extend `packages/agent/src/app-works/__tests__/task-delivery.service.spec.ts` — one post per state change, in order
      (ACC-08-24). Run: `pnpm --filter ever-works-web test ChatChangeCard registry-parity`.
      **Done when**: the three specs are green.

## P1.8 — Web

- [ ] **T27. Chips, sections, dialog, filter.**
      **Create** `apps/web/src/components/tasks/TaskDeliveryChips.tsx`,
      `apps/web/src/components/tasks/TaskDeliverySection.tsx`, `apps/web/src/components/tasks/TaskCostSection.tsx`,
      `apps/web/src/components/works/detail/RequestChangeDialog.tsx` (all new).
      **Modify** `apps/web/src/components/tasks/TasksKanbanView.tsx` and `apps/web/src/components/tasks/TasksList.tsx`
      (chips after `GateChip`), `apps/web/src/components/tasks/TaskDetailClient.tsx` (Delivery above Checks; Cost
      last), `apps/web/src/components/tasks/TasksFilterSelects.tsx` (Delivery select for App Works),
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/tasks/page.tsx` (`includeDelivery`, kind, header button),
      `apps/web/src/lib/api/tasks.ts`, `apps/web/src/app/actions/tasks.ts`,
      `apps/web/src/components/activity-log/ActivityTypeBadge.tsx` (`app_change` → `appChange`).
      **Test**: `TaskDeliveryChips.unit.spec.tsx`, `TaskDeliverySection.unit.spec.tsx`, `TaskCostSection.unit.spec.tsx`
      (all new, beside the components in `apps/web/src/components/tasks/`) and
      `apps/web/src/components/works/detail/RequestChangeDialog.unit.spec.tsx` (new) — every chip state text, the
      held/needs-input copy (FR-66, FR-67), polling stops at terminal states and after 30 minutes, confirm dialog
      focus return, unknown cost reads unknown (ACC-08-17, 21, 22, 28); `TasksKanbanView.unit.spec.tsx` passes
      unchanged. Run: `pnpm --filter ever-works-web test TaskDelivery TaskCostSection RequestChangeDialog TasksKanbanView`.
      **Done when**: the specs are green.

- [ ] **T28. P1 i18n.**
      **Modify** `apps/web/messages/en.json` — `dashboard.tasksPage.delivery`, `.appRules` (incl. `runHeld`,
      `safetyRail`, `noAgentResolved`), `.cost`, `.deliveryPosts`, `dashboard.workDetail.requestChange`,
      `dashboard.activity.filters.types.appChange` from [plan §5.2](./plan.md); mirror keys into the 20 sibling locale
      files (`node apps/web/scripts/sync-locale-parity.mjs`). camelCase leaves, no literal dots.
      **Test**: `apps/web/src/lib/__tests__/app-works-evolve-messages.unit.spec.ts` (new) — every leaf of those
      sub-trees exists in all 21 `apps/web/messages/*.json` files and no leaf key contains a `.` (ACC-08-30, strings
      half). Run: `pnpm --filter ever-works-web test app-works-evolve-messages`.
      **Done when**: the spec is green and the parity script reports zero keys added on a second run.

- [ ] **T29. P1 e2e.**
      **Create** `apps/web/e2e/app-works-evolve-chat.spec.ts`, `apps/web/e2e/app-works-delivery-chips.spec.ts`,
      `apps/web/e2e/app-works-guard-refusals.spec.ts` (new) per [plan §9.4](./plan.md); prefer `getByTestId` for board
      cards. API behaviour is asserted here or in the controller specs — never in `apps/api/test/` (Resolution R-22).
      **Test**: `cd apps/web && pnpm exec playwright test app-works-evolve-chat app-works-delivery-chips app-works-guard-refusals flow-task-isolation-gates-contract flow-task-branch-gate-ui-journey`
      — all pass (ACC-08-08, 10, 11, 14, 17, 21, 22, 24).
      **Done when**: the three new specs pass and `flow-task-isolation-gates-contract.spec.ts` and
      `flow-task-branch-gate-ui-journey.spec.ts` pass unchanged.

- [ ] **T30. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` (APW-08 notes) and this file's P1 checkboxes.
      **Test**: root `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done when**: the commands are green and ACC-08-06…ACC-08-24, ACC-08-28…32 are walked on a running build with a
      fixture App Work, each observation recorded in the PR description.

---

# Phase P2 — Goals and Missions (Wave 1)

_Delivers FR-45…FR-55._

- [ ] **T31. Goal Work scope — schema and API.**
      **Modify** `packages/agent/src/entities/goal.entity.ts` — append `workId` (uuid, nullable, no relation) and
      `@Index('idx_goals_work', ['workId'])`.
      **Create** `apps/api/src/migrations/1792080100000-AddGoalWorkScope.ts` (new).
      **Modify** `apps/api/src/goals/dto/goal.dto.ts` (`workId?: string | null`, `@IsUUID`),
      `apps/api/src/goals/goals.controller.ts`, `packages/agent/src/goals/goals.service.ts` — validate reachability in
      the Goal's scope; `409 loopRunning` on change while running.
      **Test**: `apps/api/src/migrations/__tests__/AddGoalWorkScope.spec.ts` (new) — re-runnable, no drop; extend
      `apps/api/src/goals/dto/goal.dto.spec.ts` — `workId` accepts a uuid or `null`, rejects other strings; extend
      `packages/agent/src/goals/__tests__/goals.service.spec.ts` — unreachable Work refused, change while running →
      `loopRunning`; `apps/api/src/goals/goals.controller.spec.ts` (new) — `workId` round-trips and another account's
      Work answers not found. Run: `cd apps/api && pnpm test AddGoalWorkScope goal` and
      `pnpm --filter @ever-works/agent test goals.service`.
      **Done when**: the specs are green.

- [ ] **T32. Orchestrator.**
      **Modify** `packages/agent/src/goals/goal-orchestrator.service.ts` — `applyDispatch` passes
      `workId: goal.workId ?? null`; `advanceOne` computes `pullRequestsAwaitingMerge` and detects a missing Work.
      **Modify** `packages/agent/src/goals/goal-orchestrator-rules.ts` — optional `pullRequestsAwaitingMerge` counted
      into in-flight with reason `awaiting-merge`; `workUnavailable` → `pause` / `work-unavailable`.
      **Test**: `packages/agent/src/goals/__tests__/goal-orchestrator-rules.awaiting-merge.spec.ts`,
      `packages/agent/src/goals/__tests__/goal-orchestrator.work-scope.spec.ts` (new) — ACC-08-25 unit half; the
      existing `goal-orchestrator-rules.spec.ts` passes unchanged. Run:
      `pnpm --filter @ever-works/agent test goal-orchestrator`.
      **Done when**: the specs are green.

- [ ] **T33 (parallel with T32). Goal form.**
      **Modify** `apps/web/src/components/goals/GoalForm.tsx`, `apps/web/src/components/goals/goal-form-payload.ts`,
      `apps/web/src/components/goals/GoalDetailClient.tsx`, `apps/web/src/lib/api/goals.ts` — optional Work select
      reusing `apps/web/src/components/tasks/WorkSelect.tsx`, disabled while running; Work chip on detail; log copy
      keys.
      **Test**: extend `apps/web/src/components/goals/GoalForm.unit.spec.tsx` — the Work select sends `workId`, is
      disabled while the loop runs, and clears to `null`. Run: `pnpm --filter ever-works-web test GoalForm`.
      **Done when**: the spec is green.

- [ ] **T34. Mission output — schema and API.**
      **Modify** `packages/agent/src/entities/mission.entity.ts` — append `outputMode`, `taskOutput`,
      `taskOutputNoticeAt`.
      **Create** `apps/api/src/migrations/1792080200000-AddMissionTaskOutput.ts` (new) and
      `packages/agent/src/missions/mission-task-output.ts` (new, `normalizeMissionTaskOutput`).
      **Modify** `packages/agent/src/missions/missions.service.ts`, `apps/api/src/missions/missions.controller.ts`,
      `apps/api/src/missions/dto/mission.dto.ts` — accept both; warning `noAppWorkRelation`.
      **Test**: `apps/api/src/migrations/__tests__/AddMissionTaskOutput.spec.ts` (new) — re-runnable, default
      `'ideas'`; `packages/agent/src/missions/__tests__/mission-task-output.spec.ts` (new) — normalizer table (bounds,
      defaults, garbage → defaults); extend `apps/api/src/missions/dto/mission.dto.spec.ts` — `outputMode` enum and
      `taskOutput` bounds; `apps/api/src/missions/missions.controller.spec.ts` (new) — `noAppWorkRelation` warning.
      Run: `cd apps/api && pnpm test AddMissionTaskOutput mission` and
      `pnpm --filter @ever-works/agent test mission-task-output`.
      **Done when**: the specs are green.

- [ ] **T35. Planner and tick branch.**
      **Create** `packages/agent/src/missions/mission-task-planner.service.ts` (new) — `AiFacadeService.askJson` with
      schema `{ tasks: [{ title (≤ 120), description (≤ 4000) }] }`, fenced untrusted titles/description, ≤
      `tasksPerTick`.
      **Modify** `packages/agent/src/missions/mission-tick.service.ts` `evaluateAndRun` — after the Ideas branch, for
      `tasks`/`both`: `MissionWorkRepository.listForMissionWithWork` → ≤ 5 App Works with `improves`/`operates` →
      open-cap check (`TasksService` list by `missionId` + `workId`, open statuses) → dedupe by normalised title →
      `TasksService.create({ missionId, workId, labels: ['mission-task'], status })` → `dispatchAgentRun` when not
      requiring approval, with the run budget from `guardrailsOverride.maxBudgetCentsPerRun`; once-per-day notice via
      `taskOutputNoticeAt`.
      **Modify** `packages/agent/src/missions/missions.module.ts` — provide the planner.
      **Coordinate**: AW-24 P3 T34 plans a workspace-pause start check in the same `evaluateAndRun`; place the Task
      branch after it so a paused workspace creates no Mission Task (added 2026-09-17, R-17).
      **Test**: `packages/agent/src/missions/__tests__/mission-tick.task-output.spec.ts` (new) — the cases of plan §9.1
      (ACC-08-26); the existing `mission-tick.service.spec.ts` passes unchanged. Run:
      `pnpm --filter @ever-works/agent test mission-tick`.
      **Done when**: the specs are green.

- [ ] **T36. Mission web.**
      **Create** `apps/web/src/components/missions/MissionOutputCard.tsx`,
      `apps/web/src/components/missions/MissionTasksOnWorksPanel.tsx` (new).
      **Modify** `apps/web/src/components/missions/MissionDetailClient.tsx`, `apps/web/src/lib/api/missions.ts`.
      **Test**: `apps/web/src/components/missions/MissionOutputCard.unit.spec.tsx` and
      `apps/web/src/components/missions/MissionTasksOnWorksPanel.unit.spec.tsx` (new) — output radio, limits, the
      no-App-Work notice, 20 rows per page; `MissionDetailClient.unit.spec.tsx` passes unchanged. Run:
      `pnpm --filter ever-works-web test Mission`.
      **Done when**: the specs are green.

- [ ] **T37. P2 i18n, e2e, gate.**
      **Modify** `apps/web/messages/en.json` — `dashboard.goalNew.work`, `dashboard.missionDetail.output`; mirror into
      the 20 sibling locales.
      **Modify** `apps/web/src/lib/__tests__/app-works-evolve-messages.unit.spec.ts` — add the two sub-trees.
      **Create** `apps/web/e2e/goals-work-scope.spec.ts`, `apps/web/e2e/missions-task-output.spec.ts` (new).
      **Test**: `pnpm --filter ever-works-web test app-works-evolve-messages` and
      `cd apps/web && pnpm exec playwright test goals-work-scope missions-task-output flow-goal-lifecycle flow-goals-lifecycle-deep flow-mission-crud-schedule flow-mission-guardrails`.
      **Done when**: all pass (the four pre-existing flows unchanged) and ACC-08-25/26 are walked.

---

# Phase P3 — The **Build on an open-source app** template (Wave 1 tail)

_Delivers FR-56…FR-60._

- [ ] **T38. Manifest keys and the missing `applyDefaults` caller.**
      **Modify** `packages/agent/src/missions/mission-template-manifest.service.ts` — optional `defaults.outputMode`,
      `defaults.taskOutput`, top-level `appWork { requiredRelation, recommendedAppSpec }` and
      `suggestedGoals[] { title (≤ 200), goalKind: 'delivery', dodCriteria[] (1–10, ≤ 300 chars) }`; `applyDefaults`
      carries `outputMode`/`taskOutput`.
      **Modify** `packages/agent/src/missions/missions.service.ts` `create` — when `missionTemplateRepo` resolves,
      fetch and apply the manifest (explicit create-time values win, explicit nulls kept).
      **Test**: `packages/agent/src/missions/__tests__/mission-template-defaults.spec.ts` (new) — including the two
      starter templates now having their defaults applied; `mission-template-manifest.service.spec.ts` passes
      unchanged (ACC-08-27, unit half). Run: `pnpm --filter @ever-works/agent test mission-template`.
      **Done when**: the specs are green.

- [ ] **T39. Template inputs.**
      **Modify** `packages/agent/src/missions/missions.service.ts`, `apps/api/src/missions/dto/mission.dto.ts` —
      `templateInputs { product (≤ 80), business (≤ 80), appWorkId }`: title interpolation, `improves` relation via
      `MissionWorkRepository.attach`, draft delivery Goals via `GoalsService` with `workId` + `mission_goals` link.
      **Test**: extend `packages/agent/src/missions/__tests__/missions.service.spec.ts` — relation created, two draft
      Goals scoped and linked, App spec untouched (no git call). Run:
      `pnpm --filter @ever-works/agent test missions.service`.
      **Done when**: the spec is green.

- [ ] **T40. Template form and "Propose these rules".**
      **Modify** `apps/web/src/components/missions/NewMissionForm.tsx` — the three fields and summary when the selected
      template's manifest has `appWork`; **Propose these rules** calls `POST /api/works/:id/evolve` with a generated
      request describing `recommendedAppSpec` (human-merge paths, size guidance).
      **Modify** `apps/web/messages/en.json` — `dashboard.missionsPage.buildOnApp`; mirror into the 20 sibling
      locales; add the sub-tree to `apps/web/src/lib/__tests__/app-works-evolve-messages.unit.spec.ts`.
      **Test**: `apps/web/src/components/missions/NewMissionForm.unit.spec.tsx` (new) — fields render only for an
      `appWork` manifest; the summary reads the FR-57 values; **Propose these rules** sends one evolve request and no
      App spec write. Run: `pnpm --filter ever-works-web test NewMissionForm app-works-evolve-messages`.
      **Done when**: the specs are green.

- [ ] **T41. Catalog content (outside this monorepo).**
      **Create** in `ever-works/missions` the template folder from [`mission-template-draft/`](./mission-template-draft/)
      and in `ever-works/skills` `skills/evolve-app/SKILL.md` from [`skill-draft/SKILL.md`](./skill-draft/SKILL.md)
      plus its `manifest.json` row.
      **Modify** `packages/agent/src/missions/mission-template.config.ts` — add the built-in row (the existing seed
      mechanism) pointing at it.
      **Test**: extend `packages/agent/src/missions/__tests__/mission-template-defaults.spec.ts` — the seed row
      resolves and its manifest parses with `appWork` and two `suggestedGoals`.
      **Done when**: the template card renders on `/templates` (Kind: Mission) and the Skill appears in the catalog.

- [ ] **T42. P3 e2e and gate.**
      **Modify** `apps/web/e2e/missions-task-output.spec.ts` — add **Use this Template**.
      **Test**: `cd apps/web && pnpm exec playwright test missions-task-output` and the root gate.
      **Done when**: both are green and ACC-08-27 is walked.

---

# Cross-phase closing tasks

- [ ] **T43. Telemetry.**
      **Create** `packages/monitoring/src/posthog/app-change-events.ts` (new, modelled on `kb-events.ts`) — the events of
      [plan §8.1](./plan.md) with typed properties and a forbidden-key guard.
      **Modify** `packages/monitoring/src/posthog/index.ts` — export it; **modify** the emitting services
      (`packages/agent/src/app-works/app-change-request.service.ts`, `app-change-guard.ts`, `task-delivery.service.ts`,
      `packages/agent/src/missions/mission-tick.service.ts`) to call `emitAppChangeEvent`.
      **Test**: `packages/monitoring/src/posthog/__tests__/app-change-events.spec.ts` (new) — each event forwards its
      payload; a payload with `prompt`, `diff`, `path`, `log`, `title` or `body` throws before `capture` (ACC-08-30,
      telemetry half). Run: `pnpm --filter @ever-works/monitoring test app-change-events`.
      **Done when**: the spec is green.

- [ ] **T44. Docs.**
      **Create** `docs/features/app-works-evolve.md` (behaviour: delivery states, rules, follow-ups, Goals/Missions
      scope, holds and safety-rail refusals). **Modify** `docs/features/missions.md` (Output), `docs/features/goals.md`
      (Work), `docs/features/mission-templates.md` (defaults now applied; new keys), `apps/docs/sidebarsPlatform.ts`
      (list the new page), `docs/specs/features/app-works/TRACKER.md`.
      **Test**: `pnpm --filter ever-works-docs build`.
      **Done when**: the docs build has no broken-link warning for the new page.

- [ ] **T45. Statuses.**
      **Modify** `spec.md`, `plan.md` and this file — status `Implemented`.
      **Test**: re-read every gate in [plan §11](./plan.md) against the merged code.
      **Done when**: every checklist item still holds and the known gaps are still recorded.

- [ ] **T46. Safety-rail holds on App Work runs (added 2026-09-17, Resolution R-17).**
      **Create** `packages/agent/src/app-works/app-work-run-holds.ts` (new) — `classifyAppWorkRunStop(input)` → `wait` for a
      parked run (`queuedReason` `kill-switch` / `agent-paused`) or a `platform-stop` / `workspace-pause` /
      `scope-pause` verdict; `needs_input` for any other safety-gate `refused` / `held` verdict; `null` otherwise
      ([plan §2.3](./plan.md)).
      **Modify** `packages/agent/src/tasks-domain/task-transition.service.ts` — on `needs_input`, Task → `BLOCKED` and
      escalation `guardrail-refusal` with `railId` and `category` only; **modify**
      `packages/agent/src/tasks-domain/task-ci-auto-resume.ts` and `packages/agent/src/app-works/task-delivery.service.ts` —
      a `wait` or `needs_input` stop consumes no gate attempt and opens no follow-up.
      **Test**: `packages/agent/src/app-works/__tests__/app-work-run-holds.spec.ts` (new) — every rail id and queued reason
      maps as stated; a parked run leaves `maxGateAttempts` untouched; a `ladder` refusal blocks the Task with one
      `guardrail-refusal` escalation and no follow-up (ACC-08-31). Run:
      `pnpm --filter @ever-works/agent test app-work-run-holds`.
      **Done when**: the spec is green and `packages/agent/src/tasks-domain/__tests__/task-ci-auto-resume.spec.ts`
      passes unchanged.

---

## Definition of Done

- Every checkbox above is ticked; `pnpm format:check`, `lint`, `type-check`, `test`, `build` green at the root.
- The P0 PR shows the T1 tests red before and green after.
- Every non-app golden-table spec (isolation, gates, PR status, Goal rules, Mission tick) passes unchanged.
- ACC-08-01…ACC-08-32 walked against a running build; the APW-13 scenarios that depend on this epic are green.
- The known gaps in [plan §11](./plan.md) are still recorded, not silently closed.
