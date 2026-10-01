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
      call `cloneOrPull({ owner, repo, branch: base, autoSwitchToMainBranch: false, checkoutKey })`,
      `switchBranch(provider, dir, target, create)`, keep the existing path confinement block verbatim,
      `commit(provider, …)`, `push({ dir, ref: target, remoteRef: target }, opts)`; return the real branch.
      **`checkoutKey` (APW08-G24).** `cloneOrPull` keys working copies and in-flight operations by
      plugin/owner/repo/branch/switch only (`packages/agent/src/facades/git.facade.ts:1386-1392`) and the directory
      is per owner-repo, so another caller of the same data repository (a generator that switches to `main`, the
      provisioner) can move the checkout under a commit — T2's lock serializes only this adapter's own calls on one
      `workId`. APW-02 P0 adds `GitCloneOptions.checkoutKey` with the convention `work:<workId>:<role>`
      (`packages/agent/src/facades/git.facade.ts`; CONTRACTS §3; APW-02 T4 `tasks.md:93-94`). So T3 and T4 pass
      `checkoutKey: 'work:<workId>:agent-commit'`, and the **ordering** between the two Wave 0 PRs is stated in both
      PR descriptions: if APW-02 P0 has not landed, the parameter is omitted and T3's test asserts the residual
      hazard directly — a concurrent `cloneOrPull` with `autoSwitchToMainBranch: true` on the same owner-repo must
      not share the directory, or the commit must be proved to still land on `target`. Either way the hazard is
      covered by a test rather than by an assumption.
      **Modify** `apps/api/src/agents/agents.module.spec.ts` — the existing `describe('… AGENT_GIT_FACADE PR gate')`
      block's `inject` expectation includes the appended `MergePolicyService`.
      **Test**: `cd apps/api && pnpm test agents.module.spec` — T1 cases 1–4, 6 and 7 pass; the PR-gate block passes
      (ACC-08-01, 02, 03, 05).
      **Done when**: those cases are green and `getRepoDir` is no longer called by the adapter (a spy asserts zero
      calls).

- [ ] **T4. Rewrite `openPullRequest`.**
      **Modify** `apps/api/src/agents/agents.module.ts` — same coordinate resolution **and the same
      `checkoutKey: 'work:<workId>:agent-commit'` as T3** (APW08-G24); `prGate.assertAllowed` keeps
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
      `taskIsolation = 'worktree'`, `taskIsolationBaseBranch = <source branch>`, **`taskIsolationTargetRepo = 'website'`**
      with an ownership-scoped update; idempotent.
      **Source branch when the spec omits one (APW08-G07).** `spec.source.branch` is **optional** in APW-03's schema
      (`schema.md:117`) and defaults to the repository's default branch, and defaults are never written back
      (`schema.md:20`) — so reading `spec.source.branch` alone leaves the column `null`, `isDeliveryTracked` is never
      true and FR-30 is silently off. The listener resolves, in order: the applied spec's `source.branch`; else
      `WorkAppSpecState`'s tracked branch; else the Work Repository's default branch through
      `GitFacadeService.getRepository`. It reads the Work Repository (`website` role) — never `data`.
      **Switch the Work's checks on (APW08-G02).** In the **same** update, set `checksPolicy = 'required'` when the
      applied spec declares at least one `required: true` check (leave the column untouched otherwise, so an owner's
      own `'warn'` survives), and `repoDeclaredCommands = { mode: 'allowlist', allow: <the existing list, [] by
default> }`. Without this, `readFleetRepoDeclaredCommands` returns an empty set
      (`packages/agent/src/tasks-domain/task-workspace.service.ts:556`) and the planner skips the read entirely
      (`apps/api/src/fleet/fleet-agent-task-planner.service.ts:560-583`), so FR-14 and FR-16 never apply and the run
      grades green having verified nothing. This touches **`app` only**; every other kind keeps `'off'`.
      **Notify the owner when the checks change (APW08-G19, FR-14).** The same listener records the applied spec hash
      and, when the `checks` list differs from the last hash it notified for, sends **one** notification through the
      existing Task-notification path linking to the App Checks admission card (T14). A re-application with the same
      checks notifies nobody. This is FR-14's "asked once" promise, which no task implemented before now.
      **Why `website` and not `data` (2026-09-17):** an App Work's app-code fork is the **Work Repository** — the
      `website` role, whose UI label is literally "Work Repository" (`work-capabilities.ts:40-49`) — while `data`
      holds the Work's _data_ (README §1 repository-role note, APW-01 plan §3.1). Setting the target to `data`
      would point every Task at the wrong repository, and it is not enough to set the field: **consume it.**
      `getRepoOwner()` still defaults to `data` (`work.entity.ts:831`) and `TaskWorkspaceService.provisionForRun`
      still hard-codes `getRepoOwner()` / `getDataRepo()` (`task-workspace.service.ts:219-220`), so the field is
      currently _declared but unconsumed_ — this task is what consumes it, and the same resolution must be honoured
      by the build (APW-05), the deployment (APW-06) and `GitFacadeService.getRepoDir`.
      **Modify** `packages/agent/src/tasks-domain/task-isolation.ts` — `resolveTaskIsolation` returns `'on'` when
      `work.kind === 'app'` and the Task has a Work (the `agentCanCommit === false` branch is unchanged here).
      **Modify** `packages/agent/src/tasks-domain/task-transition.service.ts` `dispatchAgentRun` — refuse an App Work
      Task whose Agent lacks `canCommitToRepo` with the FR-9 copy.
      **Modify** `packages/agent/src/tasks-domain/tasks.module.ts` — append the listener to `providers`.
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-isolation.app.spec.ts` (new) — `app` forced on with
      isolation off; a golden table proves every other kind unchanged (ACC-08-07, first half);
      `packages/agent/src/app-works/__tests__/app-spec-applied.listener.spec.ts` (new) — source branch `production` sets
      `taskIsolationBaseBranch = 'production'`; **a spec that omits `source.branch` falls back to the tracked branch
      and then to the repository default, and never leaves the column null** (ACC-08-43, unit half); a spec with a
      required check sets `checksPolicy = 'required'` and the allowlist mode while an owner's `'warn'` is preserved
      and no other kind is touched (ACC-08-41); the checks-change notification fires once per hash and not on a
      no-op re-application (ACC-08-44, first half); a second identical event writes nothing;
      `packages/agent/src/tasks-domain/__tests__/task-workspace.app-base-branch.spec.ts` (new) — on an App Work whose
      base is `production`, `provisionForRun` cuts the Task branch from `production` and `openPullRequestForBranch`
      targets `production`, never the repository default branch (ACC-08-06); **and a case proving the clone targets the
      `website`-role repository, not `<slug>-data`**; extend
      `packages/agent/src/tasks-domain/__tests__/task-transition.service.spec.ts` — an App Work Task with an Agent
      whose `canCommitToRepo` is `false` is refused with the FR-9 copy and no run is dispatched (ACC-08-07, second
      half). Run: `pnpm --filter @ever-works/agent test task-isolation task-workspace task-transition app-spec-applied`.
      **Done when**: all four specs are green and the pre-existing `task-isolation.spec.ts` passes unchanged.

- [ ] **T12. Isolated-run admission.**
      **Note (2026-09-25):** T12's cloud admission is what lets `APP_WORKS_CLOUD_PUSH_ENABLED` default on; until then
      `finalizeRun` refuses to publish App Work branches from cloud runs (T17 status, plan §2.5).
      **Depends on** APW-04's `IPipelinePlugin.enforcesRuntimeNetworking?: boolean` (CONTRACTS §3); if APW-04 has not
      landed, add that optional field to `packages/plugin/src/contracts/capabilities/pipeline-plugin.interface.ts`
      exactly as APW-04 specifies and set it only in `packages/plugins/claude-managed-agent/` — the one pipeline that
      enforces Environment networking today.
      **Create** `packages/agent/src/app-works/isolated-run-admission.ts` (new) — `isAppWorkRunAdmitted(task, plan)`:
      admit when the run is planned for a Fleet node, or when the resolved pipeline plugin has
      `enforcesRuntimeNetworking === true` and the Agent's resolved Environment is `limited`. No plugin id in core.
      **Name the placement source (APW08-G11).** As written the task cannot compile: `dispatchAgentRun` accepts only
      `{ generation, dedupKey, delegationScope, seedPendingInput, reviewId }`
      (`packages/agent/src/tasks-domain/task-transition.service.ts:853-915`) and placement is decided **later**, inside
      `dispatcher.enqueue`, by the routing adapter reading the tenant job-runtime config (`:1063-1076`) — there is no
      `plan` object and no `AppWorkRunPlacement` type. This task therefore declares
      `AppWorkRunPlacement = 'fleet' | 'cloud' | 'unknown'` in
      `packages/agent/src/app-works/isolated-run-admission.ts`, produced by that **job-runtime selector / fleet
      routing adapter** (added to this task's file list), and evaluates the predicate at **two** sites: (1)
      `dispatchAgentRun`, ahead of `RunDispatchGateService`, and (2) the **cloud worker's pre-flight**, so a router
      that falls back from Fleet to cloud between (1) and (2) cannot start a run the predicate refuses.
      `'unknown'` is treated as `'cloud'`.
      **Containment gates the Fleet branch (XC-06, SK-14, GAP-21; FR-12, FR-70).** A `'fleet'` placement is admitted
      only while the run's **reported containment** — `FleetAgentTaskContainment`
      (`packages/contracts/src/fleet/fleet-jobs.types.ts:1245`), normalized by `normalizeFleetAgentTaskContainment`
      (`:1301`) and carried by `apps/api/src/fleet/fleet-agent-task-reconciler.service.ts:959` — shows
      `isolatedHome === true` and no `isolated-home` downgrade. `'unknown'` containment is treated as a downgrade.
      The predicate returns a third outcome, `needs_input`, for a reported downgrade; the Task then shows
      `appRules.containmentDowngrade` with **Allow on this machine**, and the owner's allowance (one per node, stored
      like the EW-807 allow-list, withdrawable) admits it until withdrawn. The record the run got is put on the Task's
      Cost view by T48/T27. State plainly in the brief that **setup steps and App checks run with the machine's real
      home and toolchain**, so FR-14's admission — not containment — is their control.
      **The push credential is checked here too (GAP-15; FR-75).** Before a `'fleet'` placement is admitted the first
      time for an App Work, ask the git facade whether a GitHub App installation exists on the **Work Repository's
      owner** (the member's account for a fork), cache the answer per `(workId, owner)`, and refuse with the S28 copy
      naming that owner when it does not. This is the difference between a clear refusal at admission and a failed
      push after the model has run.
      **Modify** `packages/agent/src/tasks-domain/task-transition.service.ts` — refuse App Work dispatch when not
      admitted (`noIsolatedRuntime`, `noPushCredential`, or `needs_input` for a downgrade).
      **Coordinate (safety rails, Resolution R-17)**: keep this refusal ahead of `RunDispatchGateService`
      (`packages/agent/src/agents/run-admission-chain.ts`); do not add it to `DEFAULT_RUN_ADMISSION_CHAIN`, whose
      middlewares park rather than refuse.
      **Test**: `packages/agent/src/app-works/__tests__/isolated-run-admission.spec.ts` (new) — Fleet admitted; flag +
      limited admitted; flag + unrestricted refused; no flag refused; `'unknown'` placement refused; **Fleet with
      `isolatedHome: false` or an `isolated-home` downgrade → `needs_input`, and admitted again once the owner
      allows it** (ACC-08-34, ACC-08-08); **no push credential → `noPushCredential` with the S28 copy, and admitted
      once the installation exists** (ACC-08-39); an admitted App Work run whose Agent is paused is
      parked `agent-paused` by the existing chain, not refused (ACC-08-08, unit half). Run:
      `pnpm --filter @ever-works/agent test isolated-run-admission`.
      **Done when**: the nine cases are green.

## P1.4 — Checks

- [ ] **T13. App checks on Fleet nodes.**
      **Modify** `packages/agent/src/tasks-domain/repo-declared-commands.ts` — `parseRepoDeclaredCommands(spec, kind)`:
      for `kind === 'app'` map `spec.checks` (≤ 20) to `TaskAcceptanceCheck`; `repo` unchanged.
      **Keep the parser's id, carry the name (APW08-G03).** The check id is the **merge key** with owner-authored
      checks, and `REPO_DECLARED_COMMAND_ID_PREFIX = 'repo/'`
      (`packages/contracts/src/tasks/repo-declared-commands.types.ts:142`) is outside `ACCEPTANCE_CHECK_ID_PATTERN`
      precisely so a repository cannot spell an owner id — the fleet node also uses the prefix as an **authorship
      marker** to withhold run env grants (`apps/api/src/fleet/fleet-agent-task-planner.service.ts:586-589`). So an
      App spec check keeps the id the existing parser mints — `repo/` + the declaration's position — and the App spec
      `name` rides `TaskAcceptanceCheck.name` for display and for matching `Ever Works check: {name}`. Never
      `slug(name)`.
      `admitRepoDeclaredCommands` returns non-admitted checks as `not-admitted` results instead of refusing the run
      **for `app` only**.
      **The Work's switches are T11's job, not this one (APW08-G02).** This task reads `spec.checks` through the
      existing EW-807 gate; it assumes T11's listener has switched `checksPolicy` and `repoDeclaredCommands` on for an
      `app` Work, and it proves the negative case too — an App Work left at the defaults reports nothing green.
      **Modify** `packages/agent/src/tasks-domain/task-workspace.service.ts` `readFleetRepoDeclaredCommands` — pass
      `work.kind`.
      **Modify** `apps/api/src/fleet/fleet-agent-task-planner.service.ts` — carry `not-admitted` results into the gate
      so the gate is never green because of them.
      **Test**: `packages/agent/src/tasks-domain/__tests__/repo-declared-commands.app.spec.ts` (new) — mapping, the
      21st check ignored, allow-list admission, `not-admitted` result, a gate with one `not-admitted` required check is
      not green (ACC-08-10); **an App spec check whose `name` equals an owner check's id cannot replace, suppress or
      inherit it**, and receives no run env grants (ACC-08-33's authorship half, APW08-G03); **an App Work whose
      `checksPolicy`/`repoDeclaredCommands` are still at their defaults yields no admitted checks and no green gate**
      (ACC-08-41, negative half); `repo`-kind cases identical to `repo-declared-commands.spec.ts`. Run:
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

- [ ] **T15. App checks in the repository's CI — verification of APW-05 T41 (Resolution R-9, APW08-G05).**
      **Depends on** APW-05 T41, which **owns** `packages/plugins/github-actions-build/src/workflow/checks-job.ts`
      and the emission from `packages/plugins/github-actions-build/src/workflow/generator.ts` (APW-05 plan §4.14,
      normative). T15 writes **no second emitter** — a second `generator.ts` change for the same job is exactly the
      drift this task now prevents. It pins APW-05's emission against this epic's contract and fails on drift.
      **Verify** the emitted job: `strategy.matrix.check` lists the App spec checks in declared order (≤ 20,
      `fail-fast: false`, `max-parallel: 5`); each leg named `Ever Works check: ${{ matrix.check.name }}` so each
      check reports its own check run; job `permissions: contents: read` and nothing else; `timeout-minutes` from
      `timeoutSeconds`; checkout with `persist-credentials: false`; the command passed only through
      `env: EW_CHECK_COMMAND_B64` (base64, decoded to a temporary script) — **not** `env.CHECK_COMMAND`, which plan
      §9.6 named before this correction; job-level `continue-on-error` for `required: false`; no secret, `EW_`
      variable or cache reference; written for every build strategy and never changing a Build's status
      (CONTRACTS §3 row, R-9). Deterministic output (APW-05 FR-6).
      **Trigger set (settled — FR-76).** PR from the same repository **and** a push to the tracked branch. APW-05's
      generated file already triggers on both; APW-05's job-level `if:` guard and its checks-only file currently
      exclude the tracked-branch leg, so T15 records that as a **cross-epic request on APW-05 T41/T42** (an addition
      to those guards, never a replacement of the pull-request leg) and the golden fixture asserts both legs. The
      pull-request leg is what FR-16's gate reads.
      **Create** `packages/plugins/github-actions-build/src/__tests__/golden/app-checks-two.yml` (new) — APW-08's
      acceptance fixture for the emitted job.
      **Test**: extend `packages/plugins/github-actions-build/src/__tests__/generator.spec.ts` with a two-check fixture
      (one required, one not) — output equals the golden file on two runs; two matrix legs; no `secrets.` inside the
      `checks` job; the command appears only under `env`; `continue-on-error` only on the non-required leg; the
      tracked-branch leg present. Run:
      `pnpm --filter @ever-works/github-actions-build-plugin test generator` (the package name APW-05 T7 gives it).
      **Done when**: the spec is green, the golden workflow passes `actionlint` locally, and no diff to
      `generator.ts` is in this task's PR.

- [ ] **T16 (parallel with T15). Cloud gate never runs App checks; required vs advisory legs; the attempt budget.**
      **Modify** `packages/agent/src/tasks-domain/task-gates.ts` `resolveAcceptanceChecks` — for `work.kind === 'app'`,
      ignore any App spec source; only `checkDefaults` + Task checks resolve.
      **Modify** `packages/agent/src/tasks-domain/task-pr-status.service.ts` and
      `packages/agent/src/tasks-domain/task-ci-auto-resume.ts` / `task-ci-auto-resume.service.ts` (APW08-G04 —
      **this is not a test-only task**). Today `deriveCiState` reds on **any** completed failure whatever the check
      (`packages/plugin/src/contracts/capabilities/git-provider.pr-insights.ts:43-58`) and the merge gate skips unless
      `ciState === 'passing'` (`packages/agent/src/tasks-domain/task-merge-gate.service.ts:131-132`), so an advisory
      App check failing would red the gate and hold the merge — the opposite of FR-16. For an App Work: classify the
      `Ever Works check: {name}` legs through `AppWorkRulesService` **read at the PR base**, so a failing **required**
      leg makes `ciState = failing` and a failing **advisory** leg is ignored by the roll-up and only reported in
      `prChecks`. Take the resume budget from the Work's `maxGateAttempts`, not from the platform env var
      `TASK_CI_AUTO_RESUME_MAX_ATTEMPTS` (`packages/agent/src/config/index.ts:1590-1600`,
      `task-ci-auto-resume.ts:24-41`), and on exhaustion move the Task to `BLOCKED` with escalation `gate-exhausted`
      instead of filing only an Inbox notice (`task-ci-auto-resume.service.ts:594-598`). Every other Work kind keeps
      the env-var budget and the Inbox notice **unchanged** — this is a branch on `kind === 'app'` and nothing else
      moves.
      **Record one fact to verify, never assume.** Whether GitHub reports a failed job-level `continue-on-error` leg
      as a failing check run is **unverified**. Both this plan and APW-05 §4.14 assume it gives advisory semantics, so
      the classifier above reads the leg's `required` flag from the base-commit rules and therefore does not depend
      on the answer; write the observation (provider, run id, conclusion) into the PR description either way.
      **Fix S3's copy note.** S3 reads **"(attempt 2 of 3)"** while FR-17's default budget is 2 — S3 illustrates the
      copy shape with a non-default budget, and the copy is generated from the Work's actual budget.
      **Test**: extend `packages/agent/src/tasks-domain/__tests__/task-gates.spec.ts` with an `app` case — App spec
      checks never appear in the resolved set; `repo` and template cases unchanged.
      **Create** `packages/agent/src/tasks-domain/__tests__/task-pr-status.app-checks.spec.ts` (new) — ACC-08-09: a
      pull request status whose required `Ever Works check: type-check` leg failed sets `ciState = failing`, offers the
      CI fix loop once per attempt up to `maxGateAttempts`, then moves the Task to `BLOCKED` with escalation
      `gate-exhausted`; a failed non-required leg leaves the gate unchanged; **the budget comes from the Work and not
      from the env var**; **a provider that reports the advisory leg as failed still leaves the gate unchanged**
      (the fallback). Run: `pnpm --filter @ever-works/agent test task-gates task-pr-status`.
      **Done when**: both specs are green and `task-pr-status.service.spec.ts` passes unchanged.

## P1.5 — Guard, instructions, merge

- [ ] **T17. `AppChangeGuard`.**
      **Status (2026-09-25, wave 2, `86e1a3ddf`):**
      _Cloud path:_ judged before the push (`checkPaths` over `IWorkspacePlugin.branchChanges`, then publish by
      `publishSha`). Default-off behind `APP_WORKS_CLOUD_PUSH_ENABLED` until T12 lands (owner decision 2026-09-25);
      when T12 lands, revisit the default. The switch holds `finalizeRun` and the agent git tools through one gate
      (`appWorkCloudPushAllowed`, 2026-09-26, `cab3419e5`): off, `commitToRepo` / `openPullRequest` refuse an App Work
      with the FR-12 message and publish nothing; on, `commitToRepo` pushes after a pre-push `checkPaths` of the call's
      own files and `openPullRequest` runs `evaluate` first (plan §2.5, including the switch-on residual). The residual that the post-push compare still names the branch, not the sha,
      is recorded in `guardAppChange`'s docstring.
      _Residual (plan §2.5):_ both judgements (pre-push `branchChanges` and the post-push compare) use merge-base
      semantics, the pull request's view. A head cut from an old ancestor of the base is judged only by what it changed
      since that ancestor, so a workflow file that the ancestor carried and the base later removed (for example for
      security) can be published unnamed, and an `on: push` trigger in it runs on the push. Closing this needs a
      history-free comparison of the protected paths against a trusted remote task-branch tip, which neither the
      workspace contract nor the handle carries today. Candidate follow-up: add the tip sha at provision time to
      `WorkspaceHandle`, and add a protected-path tree check to the gate.
      _Primary-branch refusal marker:_ `tasks.branchGuardRefusal` (text, nullable; migration
      `1792110100000-AddTaskBranchGuardRefusal`) — `refuseChange` records the refusal text (capped at 4,000
      characters) only when the refused change reached the remote (the post-push gate, or a node reporting a branch
      that is not the Task's own); a refusal before the push neither writes nor clears it; cleared when a later
      full-branch judgement allows the branch, and on discard. The Task page's branch panel shows it as a refusal
      banner (`TaskBranchSection`, `task-guard-refusal-banner`), hidden once the branch is merged, cleaned or
      discarded, or the pull request is merged ([plan §3.5](./plan.md)).
      _Fleet path:_ unchanged — a node still pushes before the platform judges the branch; the per-job push credential
      is `contents: write` only (pinned in `fleet-push-credential.service.spec.ts`, never `workflows`), and the merge
      gate re-judges the head.
      **Create** `packages/agent/src/app-works/app-change-guard.ts` (new) — [plan §2.5](./plan.md): compare diff
      (`{ maxFiles: 300, maxBytes: 0 }`, refuse on `totalFiles >= 300` **or** `files.length < totalFiles` — never on
      `truncated` alone, because `capDiffFiles` also sets it when patch text exceeds the 256 KiB default and a
      five-file change with a big lockfile patch must not be refused as "over 300 files", APW08-G06), App spec
      protected paths through APW-03's `isProtectedPath` on `path` and `previousPath`, `.github/workflows/**` with
      `minimatch` (`dot: true`), App spec field protection through APW-03's `diffGuardedSpecBlocks(base, head)`
      (invalid head spec refuses; removals from `display.protectedPaths` and `agents.requireHumanMergePaths` are
      reported — APW08-G01, schema row APW-03 `schema.md:379`), lockfile-excluded size, guidance note vs 3× refusal,
      **the App spec's own `agents.maxPullRequestChangedFiles` (default 50) enforced as file guidance and as a
      `3 ×` refusal, kept alongside FR-21's shared 300-file ceiling and never replacing it** (APW08-G22),
      **the APW-04 provisioner exemption keyed on `WorkAppProvisioning.taskId` for the field rule only — never on a
      Task label, which any user or the `create_task` / `update_task` chat tools can set** (APW08-G23);
      `assertPathsAllowed(work, files)`.
      **Modify** `packages/agent/src/tasks-domain/task-workspace.service.ts` — call the guard in `finalizeRun` before
      `openPullRequestForBranch` and in `finalizeRemotePush` at the same point; refusal → Task `BLOCKED` +
      `postSystemMessage` with the §5.2 copy key; guidance note appended to the PR body.
      **Modify** `apps/api/src/agents/agents.module.ts` — for App Works, `commitToRepo` calls
      `assertPathsAllowed(files)` (FR-8; protected paths and `.github/workflows/**`) and `openPullRequest` runs
      `AppChangeGuard.evaluate` before `createPullRequest`, so the tools cannot bypass the guard (plan §2.3, R-17).
      **Modify** `packages/agent/src/tasks-domain/tasks.module.ts` — append the guard to `providers` and `exports`.
      **Test**: `packages/agent/src/app-works/__tests__/app-change-guard.spec.ts` (new) — every case in
      [plan §9.1](./plan.md) (ACC-08-11, 12, 14); **few files with a huge patch → not refused (APW08-G06)**; **exactly
      300 files → refused**; **an over-guidance file count notes, an over-`3 ×` count refuses** (APW08-G22); **a Task
      labelled `app-provision` by a user gets no exemption, and the real APW-04 provisioning Task does** (APW08-G23);
      extend `apps/api/src/agents/agents.module.spec.ts` — on an App Work,
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
      **Schema dependency (APW08-G01 — already discharged, recorded here so the dependency is visible).**
      `spec.agents.requireHumanMergePaths` (Glob[], ≤ 50, default `[]`) is now in APW-03's `agents` table
      (`APW-03-app-spec-and-catalog/schema.md:379`) and in the generated JSON Schema
      (`_build-artifacts/apw-03-schema/app-spec.schema.json:2012`), so a spec declaring it validates (C1 would
      otherwise report `unknown_field`) and the draft template's `recommendedAppSpec.agents.requireHumanMergePaths`
      (`mission-template-draft/.works/mission.yml:40-45`) opens a valid App spec PR. **Done**: nothing in T19.
      **Still on APW-03 (shared-file request, not this task):** T3/T12's bound and removal-reporting cases for the
      new list in APW-03 `tasks.md` / `plan.md:359` — `diffGuardedSpecBlocks` must report removals from
      `agents.requireHumanMergePaths` as well as from `display.protectedPaths` (CONTRACTS §2A). T17 already consumes
      the removal report.
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-merge-gate.app.spec.ts` (new) — with agent merge
      allowed, a diff touching a human-merge path is refused; an untouched diff merges; non-app Works unchanged
      (ACC-08-15). Run: `pnpm --filter @ever-works/agent test task-merge-gate`.
      **Done when**: the new spec and `task-merge-gate.service.spec.ts` are green.

## P1.6 — Delivery chain

- [ ] **T20. Pure delivery rules.**
      **Create** `packages/agent/src/app-works/task-delivery.rules.ts` (new) — `decideDelivery(input)` over merge sha,
      Builds, Deployments, ancestry answers, target and auto-deploy flags.
      **The input table is normative (APW08-G08).** `decideDelivery` implements **every row of plan §2.4's delivery
      input table** and nothing else: APW-05 Build `status` + `deployable` + `trigger` (including `blocked` for
      `build.strategy: auto`, `cancelled`, and `deployable: false`), APW-06 Deployment
      `QUEUED|DEPLOYING|VERIFYING|READY|READY+warnings|ERROR|ROLLED_BACK|CANCELED|SUPERSEDED` with `smokeResult`,
      the deploy target, the auto-deploy switch and `build.strategy` (`image` enters no `building`/`built` state;
      `none` closes at merge). `{outcome}` for `deploy_failed` distinguishes **failed**, **rolled back** and
      **rollback failed** from APW-06's own record. A state is never inferred from an input the table does not name
      — in particular, recording a Deployment never changes a delivery state on its own.
      **Test**: `packages/agent/src/app-works/__tests__/task-delivery.rules.spec.ts` (new) — **every row of plan
      §2.4's table is a case** (ACC-08-42), plus ACC-08-17, 18, 20, 21. Run:
      `pnpm --filter @ever-works/agent test task-delivery.rules`.
      **Done when**: every row of the table is a passing case and no case exists that the table does not name.

- [ ] **T21. `TaskDeliveryService`.**
      **Create** `packages/agent/src/app-works/task-delivery.service.ts` (new) — `isDeliveryTracked`, `recordMerge`
      (partial unique index = once; Activity `actionType: 'app_change'`, `action: 'app.change.merged'`),
      `reconcile(batch)` with compare-and-set writes, closing through
      `TaskTransitionService.transition(task, DONE, { actorType: 'agent' })`, carry-along, and
      `closeWithoutDeploy(userId, taskId, note)`.
      **`isDeliveryTracked` resolves the branch, not just the column (APW08-G07).** It asks
      `AppWorkRulesService.sourceBranch` when `work.taskIsolationBaseBranch` is null, so an App Work whose spec omits
      `source.branch` is still tracked rather than silently completing as today.
      **Portable writes (APW08-G17).** The compare-and-set is built per driver (plan §6): `IS NOT DISTINCT FROM` on
      `postgres`/`sqlite`, `<=>` on `mysql`. `recordMerge` takes the application lock before the first write so the
      once-only rule holds even where the unique index is redundant (`mysql` has no partial indexes; the plain
      `(workId, mergeCommitSha)` index of plan §3.5 is the MySQL form and is **stronger**, since repeated `NULL`s are
      distinct there).
      **Create** `packages/agent/src/app-works/delivery-follow-up.service.ts` (new) — follow-up Task creation (title,
      relation `follow-up`, priority `p1`, **`followUpKey = followup:<taskId>:<failureId>` as a column with a unique
      index — not a Task label, which any user can set or clear and which at 82 characters exceeds
      `@MaxLength(80, { each: true })`** (`apps/api/src/tasks/tasks.dto.ts:62-72`, APW08-G23), 200-line redacted log
      tail via the existing secret redaction helper, fenced), limits 2 per chain / 3 open per Work, escalation
      `delivery-failed` fallback, auto-cancel.
      **Modify** `packages/agent/src/tasks-domain/tasks.module.ts` — append both services.
      A run parked by the admission chain or a stop/pause rail is a wait, and a run refused at the safety gate is
      `needs_input`; neither is a delivery failure and neither opens a follow-up (Resolution R-17).
      **Test**: `packages/agent/src/app-works/__tests__/task-delivery.service.spec.ts` (new) — `recordMerge` idempotency,
      follow-up limits, escalation fallback, auto-cancel (ACC-08-16, 18, 19, 20, 22); **the same cases run under
      `describe.each(['postgres', 'sqlite', 'mysql', 'mariadb'])` for the compare-and-set and the uniqueness rule**
      (ACC-08-45); **an App Work whose spec omits `source.branch` is tracked** (ACC-08-43, service half);
      `packages/agent/src/app-works/__tests__/follow-up-key.spec.ts` (new) — the key is server-side, a user label
      changes nothing, and two identical failures open one Task (APW08-G23). Run:
      `pnpm --filter @ever-works/agent test task-delivery.service follow-up-key`.
      **Done when**: the specs are green.

- [ ] **T22. Hook the PR-status sweep.**
      **Modify** `packages/agent/src/tasks-domain/task-pr-status.service.ts` `syncDuePrStatuses` — when
      `after.prState === 'merged'`, ask `TaskDeliveryService.isDeliveryTracked(after, status)`; tracked →
      `recordMerge`, skip `completeOnMerge`; else unchanged. Inject the service `@Optional()`, appended last.
      **Refactor `refreshTask` to return the status (APW08-G10).** As written T22 cannot compile: the sweep loop holds
      only the `Task` `refreshTask` returns (`task-pr-status.service.ts:272-283`), `refreshTask` reads
      `GitPullRequestStatus` internally and returns the Task (`:377-397`), and `Task` stores no `baseRef` and no
      `mergeCommitSha`. Change `refreshTask` to return `{ task, status }` — single-flight and the in-memory cache
      patch unchanged, `status` nullable exactly where it is nullable today — and pass `status` into the hook. The
      fallback (persist `mergeCommitSha` and the base ref in the cache patch) adds a column and is **not** taken; it
      is recorded here so the choice is auditable.
      **Test**: `packages/agent/src/tasks-domain/__tests__/task-pr-status.delivery.spec.ts` (new) — tracked,
      untracked, other-branch (ACC-08-23), service absent; **`refreshTask`'s new return shape is asserted directly**;
      **an App Work whose spec omits `source.branch` is tracked** (ACC-08-43, sweep half). Run:
      `pnpm --filter @ever-works/agent test task-pr-status`.
      **Done when**: the new spec and `task-pr-status.service.spec.ts` are green, with its existing assertions
      unchanged.

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
      **Bind the token where APW-02 can see it (APW08-G18).** APW-02 creates
      `packages/agent/src/app-works/app-works.module.ts` (APW-02 T15 `tasks.md:231`) and injects the token as
      `@Optional()` into `AppUpstreamStateService` (APW-02 T19 `tasks.md:317-319`), but neither task list provides
      `{ provide: APP_WORK_AGENT_RESOLVER, useExisting: AppWorkAgentResolver }` in a module `AppWorksModule` imports
      — and an unbound `@Optional()` token is `undefined`, so APW-02's null-agent branch would run silently and
      ACC-08-32 / ACC-02-11 would pass without the resolver ever being consulted. So: provide the resolver **and**
      the token in `packages/agent/src/app-works/app-works.module.ts`, and **do not** have `AppWorksModule` import
      `TasksDomainModule` (that closes a cycle through `TaskTransitionService`); the resolver depends on repository
      providers only. T25 changes APW-02's module file and states so in the PR description.
      **Create** `apps/api/src/works/work-evolve.controller.ts` (new) and `apps/api/src/works/dto/evolve-work.dto.ts`
      (new); **create** `packages/agent/src/app-works/app-change-request.service.ts` (new) — kind check, Agent resolution
      through the resolver (`409 agentRequired` with ≤ 20 candidates), `evolve-app` Skill binding at Work scope once
      (**`installFromCatalog` first, then `createBinding` with a find-first check**: `createBinding` calls
      `getOne(userId, skillId)` and so requires an installed Skill row the user already owns
      (`packages/agent/src/skills/skills.service.ts:281-288`), and the unique index `uq_skill_binding`
      (`packages/agent/src/entities/skill-binding.entity.ts:33`) **throws** on a duplicate rather than being a no-op —
      and when the catalog Skill is not yet published the binding is **skipped, not failed** (APW08-G14; the Skill
      reaches `ever-works/skills` in P3 T41, so P1 must not depend on it)), `TasksService.create` + `dispatchAgentRun`,
      admission refusal. Returns `202`.
      **When nothing resolves (GAP-14; FR-42, S32).** A Blueprint-created App Work has no prior Task and nothing
      assigns it an Agent, so the card would offer an empty picker. When the resolver returns `null`, ask
      `AgentRepository.findByUserIdScoped(userId, { canCommitToRepo: true })`; when **that** is empty too, return
      `409 { code: 'agentRequired', createFromTemplate: { templateSlug, reason: 'noCommittableAgent' } }` and add
      `POST` support for the one-click path the card uses — create the Agent from the named catalog template, bind
      `evolve-app` at Work scope, assign it to the Work, then create and start the Task, in one round trip. Nothing is
      created without that explicit click, and a person who already owns a committable Agent keeps S25's picker
      unchanged.
      **Modify** `apps/api/src/works/works.module.ts` — register the controller; **modify**
      `packages/agent/src/tasks-domain/tasks.module.ts` — append the resolver and the service to `providers` and
      `exports`; **modify** `packages/agent/src/app-works/app-works.module.ts` — the token provider above.
      **Test**: `apps/api/src/works/work-evolve.controller.spec.ts` (new) — 202 shape, `notAppWork`, `agentRequired`
      with and without `createFromTemplate`, `noPushCredential`, `changesPaused`, cross-account 404, throttle
      metadata (ACC-08-08, 24, 29, ACC-08-39, ACC-08-40);
      `packages/agent/src/app-works/__tests__/app-work-agent-resolver.spec.ts` (new) — order, skips, `null` (ACC-08-32,
      resolver half); **a module-compilation case proving the injected `APP_WORK_AGENT_RESOLVER` is defined, not
      merely that the module compiles** (APW08-G18); **a case where the catalog Skill is absent and the Task is still
      created** (APW08-G14). Run: `cd apps/api && pnpm test work-evolve` and
      `pnpm --filter @ever-works/agent test app-work-agent-resolver`.
      **Done when**: both specs are green.

- [ ] **T26. Chat tool, card and Task thread posts.**
      **Modify** `apps/web/src/lib/ai/tools/generated/registry.ts` — append the `request_app_change` row
      ([plan §4](./plan.md)).
      **Give it a keyword slot (APW08-G20).** A generated registry entry with **no** keyword slot is gated out of
      every turn — that is the Mission-create outage the parity spec exists to prevent
      (`apps/web/src/lib/ai/tools/generated/registry-parity.unit.spec.ts:5-16`), `tool-selection.ts:62-145` requires
      slots under the program DoD rule, and generated tools may never be always-on (`tool-selection.ts:350-360`). So
      T26 also **modifies** `apps/web/src/lib/ai/tools/tool-selection.ts` with a `DOMAIN_KEYWORDS` slot (the app-work
      domain the tool belongs to) for `request_app_change`, plus parity cases.
      **Create** `apps/web/src/components/ai/ChatChangeCard.tsx` (new).
      **Modify** `packages/agent/src/app-works/task-delivery.service.ts` and
      `packages/agent/src/tasks-domain/task-workspace.service.ts` — post the FR-43 thread messages as `{ key, params }`
      through `postSystemMessage` / `TaskChatService` (**the storage for keyed posts is T54's; if T54 has not landed
      yet, post the pre-rendered string exactly as today and add the key in the same PR that lands T54's columns**).
      **Test**: `apps/web/src/components/ai/ChatChangeCard.unit.spec.tsx` (new) — confirmation copy, chain states,
      polling stops after 30 minutes; `apps/web/src/lib/ai/tools/generated/registry-parity.unit.spec.ts` stays green
      **and gains cases proving representative change requests ("add an SMS reminder to my app") reach the tool while
      unrelated turns do not** (ACC-08-46, APW08-G20); extend
      `packages/agent/src/app-works/__tests__/task-delivery.service.spec.ts` — one post per state change, in order
      (ACC-08-24). Run: `pnpm --filter ever-works-web test ChatChangeCard registry-parity`.
      **Done when**: the three specs are green.

## P1.8 — Web

- [ ] **T27. Chips, sections, dialog, filter.**
      **Create** `apps/web/src/components/tasks/TaskDeliveryChips.tsx`,
      `apps/web/src/components/tasks/TaskDeliverySection.tsx`, `apps/web/src/components/tasks/TaskCostSection.tsx`,
      `apps/web/src/components/works/detail/RequestChangeDialog.tsx` (all new).
      **Also create (additive, 2026-09-17):** `apps/web/src/components/tasks/TaskRunContainmentNotice.tsx` (the
      containment a run got, its downgrades and **Allow on this machine** — FR-70, XC-06) mounted inside
      `TaskCostSection`; and `apps/web/src/components/works/detail/WorkCostSummary.tsx` (FR-73's month spend, cap,
      remaining and alert, linking to the Task-level Cost section — XC-19).
      **Modify** `apps/web/src/components/tasks/TasksKanbanView.tsx` and `apps/web/src/components/tasks/TasksList.tsx`
      (chips after `GateChip`), `apps/web/src/components/tasks/TaskDetailClient.tsx` (Delivery above Checks; Cost
      last), `apps/web/src/components/tasks/TasksFilterSelects.tsx` (Delivery select for App Works),
      `apps/web/src/app/[locale]/(dashboard)/works/[id]/tasks/page.tsx` (`includeDelivery`, kind, header button),
      `apps/web/src/lib/api/tasks.ts`, `apps/web/src/app/actions/tasks.ts`,
      `apps/web/src/components/activity-log/ActivityTypeBadge.tsx` (`app_change` → `appChange`).
      **Test**: `TaskDeliveryChips.unit.spec.tsx`, `TaskDeliverySection.unit.spec.tsx`, `TaskCostSection.unit.spec.tsx`
      (all new, beside the components in `apps/web/src/components/tasks/`),
      `apps/web/src/components/tasks/TaskRunContainmentNotice.unit.spec.tsx`,
      `apps/web/src/components/works/detail/WorkCostSummary.unit.spec.tsx` and
      `apps/web/src/components/works/detail/RequestChangeDialog.unit.spec.tsx` (new) — every chip state text, the
      held/needs-input copy (FR-66, FR-67), polling stops at terminal states and after 30 minutes, confirm dialog
      focus return, unknown cost reads unknown, **the containment notice and its allow action** (ACC-08-34),
      **the Work cost rollup with cap and remaining** (ACC-08-37) — all ACC-08-17, 21, 22, 28; `TasksKanbanView.unit.spec.tsx` passes
      unchanged. Run: `pnpm --filter ever-works-web test TaskDelivery TaskCostSection RequestChangeDialog TasksKanbanView`.
      **Done when**: the specs are green.

- [ ] **T28. P1 i18n.**
      **Modify** `apps/web/messages/en.json` — `dashboard.tasksPage.delivery`, `.appRules` (incl. `runHeld`,
      `safetyRail`, `noAgentResolved`, **and the keys added 2026-09-17: `overFileGuidance`, `containmentDowngrade`,
      `allowOnThisMachine`, `changesPaused`, `repoTooLarge`, `noPushCredential`, `createAgentAndStart`,
      `createAndStart`, `specInvalidAtBase`, `diffUnreadable`** — APW08-G21 gave the §8.2 refusal copy and the S22 /
      S28 / FR-54 strings keys they never had), `.cost`, `.deliveryPosts`, `dashboard.workDetail.requestChange`,
      `dashboard.workDetail.costSummary` (new), `dashboard.activity.filters.types.appChange` from
      [plan §5.2](./plan.md); mirror keys into the 20 sibling locale
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
      **The per-run budget needs a mechanism that does not exist (APW08-G15).** `dispatchAgentRun` accepts only
      `{ generation, dedupKey, delegationScope, seedPendingInput, reviewId }`
      (`packages/agent/src/tasks-domain/task-transition.service.ts:853-915`) and **no per-run cost cap exists for
      cloud agent runs**: `maxBudgetCentsPerRun` is read only by the Idea/Work agent
      (`packages/agent/src/work-agent/work-agent.service.ts:360`) and Fleet has only the agent-settings
      `maxBudgetUsd` (`apps/api/src/fleet/fleet-agent-task-planner.service.ts:274`, `:328`). The template promises
      "$15.00 per run" (FR-57, S12), so T35 adds the mechanism rather than dropping the promise: a new
      `maxBudgetCents` option on `dispatchAgentRun`, stored on the run row and enforced by the cloud worker's spend
      check, and mapped to `execution.maxBudgetUsd` on the Fleet path (cents → USD, rounded **down** so the cap is
      never raised). A run stopped by its cap is **waiting** on FR-66's terms, not a delivery failure.
      **Also modify** `packages/agent/src/tasks-domain/task-transition.service.ts`,
      `packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` (cloud enforcement) and
      `apps/api/src/fleet/fleet-agent-task-planner.service.ts` (Fleet mapping) for it.
      **Modify** `packages/agent/src/missions/missions.module.ts` — provide the planner.
      **Coordinate**: AW-24 P3 T34 plans a workspace-pause start check in the same `evaluateAndRun`; place the Task
      branch after it so a paused workspace creates no Mission Task (added 2026-09-17, R-17).
      **Test**: `packages/agent/src/missions/__tests__/mission-tick.task-output.spec.ts` (new) — the cases of plan §9.1
      (ACC-08-26); **a run dispatched with a per-run budget carries it, the cloud worker stops at it, and the Fleet
      plan carries `maxBudgetUsd` rounded down** (APW08-G15); the existing `mission-tick.service.spec.ts` passes
      unchanged. Run: `pnpm --filter @ever-works/agent test mission-tick`.
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
      **Name the fetch (APW08-G13).** `MissionTemplateManifestService` is a pure parser with no fetcher
      (`packages/agent/src/missions/mission-template-manifest.service.ts:17-22`), so T38 also names one: the
      manifest is read through the **git facade** as a file read of `.works/mission.yml` at the template repository's
      recorded `branch` — the same facade read APW-05/06 use — with the template's `owner`/`repo`/`branch` from
      `findMissionTemplateConfig`; an unreadable or unparsable manifest leaves the Mission on its explicit values and
      records one warning rather than failing the create. A read endpoint for the web (`GET` on the template's
      manifest) is added to the missions controller in T40's task so the form can render the summary without a
      second fetch path.
      **Test**: `packages/agent/src/missions/__tests__/mission-template-defaults.spec.ts` (new) — including the two
      starter templates now having their defaults applied; **the manifest is fetched through the git facade at the
      template's branch, and an unreadable manifest leaves explicit values in place** (APW08-G13);
      `mission-template-manifest.service.spec.ts` passes
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
      **Retarget the "Use this Template" entry point (APW08-G13).** The catalog's **Use this Template** link goes to
      `/new?type=mission&template=<id>`, handled by `NewPageClient`
      (`apps/web/src/components/templates/TemplatesCatalog.tsx:376-390`;
      `apps/web/src/components/new/NewPageClient.tsx:355-371`) — not `/missions/new`. So the form work lands in
      **both** `NewMissionForm.tsx` (the standalone route) and the `NewPageClient` template path, sharing one
      component; neither entry point is removed and the standalone route keeps working.
      **Modify** `apps/web/messages/en.json` — `dashboard.missionsPage.buildOnApp`; mirror into the 20 sibling
      locales; add the sub-tree to `apps/web/src/lib/__tests__/app-works-evolve-messages.unit.spec.ts`.
      **Test**: `apps/web/src/components/missions/NewMissionForm.unit.spec.tsx` (new) — fields render only for an
      `appWork` manifest; the summary reads the FR-57 values; **Propose these rules** sends one evolve request and no
      App spec write; **the `/new?type=mission&template=…` path renders the same fields** (APW08-G13). Run:
      `pnpm --filter ever-works-web test NewMissionForm app-works-evolve-messages`.
      **Done when**: the specs are green.

- [ ] **T41. Catalog content and the template's real home (outside this monorepo).**
      **The seed mechanism decides the destination (APW08-G13, EXT-13).** The platform reads **one repository per
      template** — `MissionTemplateConfig { owner, repo, branch }`
      (`packages/agent/src/missions/mission-template.config.ts:27-60`) — and **no code reads `ever-works/missions`**
      (`git grep -n "ever-works/missions" -- apps packages` matches nothing). The draft's own header leaves the
      destination as either/or (`mission-template-draft/.works/mission.yml:3-5`). So T41 targets the standalone
      repository **`ever-works/build-on-open-source-app-mission-template`** (`.works/mission.yml` + the draft's
      `README.md` + `prompts/`) and adds the built-in `MissionTemplateConfig` row pointing at it.
      **Also create the catalog-conformant copy, alongside — never instead (EXT-13).** The live
      `ever-works/missions` layout is `templates/<slug>/{mission.yml,BRIEF.md,README.md}` plus a manifest row, and
      its `mission-template.schema.json` requires `slug`, `title`, `type`, `summary`, `schedule` and rejects
      `version`, `defaults`, `kb`, `appWork` and `suggestedGoals` as additional properties. So add, in this repo, a
      catalog-shaped copy under
      `docs/specs/features/app-works/APW-08-evolve-loop/mission-template-draft/catalog/templates/build-on-open-source-app/`
      — `mission.yml` (catalog shape, `type: SCHEDULED`, `schedule: '0 8 * * 1'`, `suggestedAgentTemplates`), `BRIEF.md`,
      `README.md` — plus `manifest-row.json`, and publish both from T41. The existing draft files are **kept exactly
      as they are**: the standalone repository needs them and the catalog copy is an addition for a human-facing
      listing. Neither is a replacement for the other.
      **The Skill's manifest row (APW08-G14).** `ever-works/skills` entries need a `manifest.json` row
      (`slug`, `skillPath`, `name`, `summary`, `tags`, `version`, `license`, `sourceUrl` —
      `docs/features/skills-catalog.md:75-78`) and the draft folder has only `SKILL.md`. T41 adds
      `skill-draft/manifest-row.json` beside it and publishes `skills/evolve-app/SKILL.md` **before** T25's binding
      ever needs it (P3 lands after P1; T25 must therefore skip the binding when the Skill is absent — see T25).
      **Modify** `packages/agent/src/missions/mission-template.config.ts` — add the built-in row (the existing seed
      mechanism) pointing at the standalone repository.
      **Test**: extend `packages/agent/src/missions/__tests__/mission-template-defaults.spec.ts` — the seed row
      resolves and its manifest parses with `appWork` and two `suggestedGoals`; the catalog copy parses against the
      catalog shape (a JSON-Schema check over the local file).
      **Done when**: the template card renders on `/templates` (Kind: Mission), the Skill appears in the catalog, and
      both `mission.yml` files exist with their distinct shapes.

- [ ] **T42. P3 e2e and gate.**
      **Modify** `apps/web/e2e/missions-task-output.spec.ts` — add **Use this Template**.
      **Test**: `cd apps/web && pnpm exec playwright test missions-task-output` and the root gate.
      **Done when**: both are green and ACC-08-27 is walked.

---

# Cross-phase closing tasks

- [ ] **T43. Telemetry.**
      **Create** `packages/monitoring/src/posthog/app-change-events.ts` (new, modelled on `kb-events.ts`) — the events of
      [plan §8.1](./plan.md) with typed properties and a forbidden-key guard.
      **Do not import `@ever-works/monitoring` from the agent package (APW08-G16).** `packages/agent/package.json`
      has no such dependency and existing agent telemetry deliberately avoids one, through an injected capture-client
      interface (`packages/agent/src/services/knowledge-base-reconcile.service.ts:55-66`) — and `emitKbEvent`, the
      model T43 copies, has no production caller, so copying it literally would produce dead code. So the agent-package
      emitters (`app-change-request.service.ts`, `app-change-guard.ts`, `task-delivery.service.ts`,
      `mission-tick.service.ts`) call an **injected capture-client port** declared in the agent package (one DI token,
      one interface, no `@ever-works/monitoring` import); `apps/api` binds that token to the real PostHog client and
      to `emitAppChangeEvent`, so the typed event and the forbidden-key guard stay in `monitoring` and run at the
      binding.
      **Modify** `packages/monitoring/src/posthog/index.ts` — export the module.
      **Test**: `packages/monitoring/src/posthog/__tests__/app-change-events.spec.ts` (new) — each event forwards its
      payload; a payload with `prompt`, `diff`, `path`, `log`, `title` or `body` throws before `capture` (ACC-08-30,
      telemetry half); **a dependency assertion that `packages/agent/package.json` still does not list
      `@ever-works/monitoring`** (APW08-G16). Run: `pnpm --filter @ever-works/monitoring test app-change-events`.
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
      **Name the producer of the signal (APW08-G09).** The classifier alone changes nothing: `evaluateSafety` turns a
      `held`/`refused` verdict into a tool result for the model and the run continues
      (`packages/agent/src/agents/agent-run.service.ts:1541-1580`), and no run status, event or callback carries
      `railId` out of the run. So T46 also **modifies** `packages/agent/src/agents/agent-run.service.ts` to record the
      **first non-stop** `refused`/`held` verdict on the run row (`runSafetyStop` = `{ railId, category }` only) and
      the parked `queuedReason` for a stop or pause; **modifies** the cloud run finisher
      (`packages/tasks/src/tasks/trigger/agent-task-execute.task.ts` and its worker service) and
      `apps/api/src/fleet/fleet-agent-task-reconciler.service.ts` to call `classifyAppWorkRunStop` on that record,
      so `wait` and `needs_input` are produced on **both** the cloud and the Fleet path and neither depends on the
      model reporting anything.
      **Modify** `packages/agent/src/tasks-domain/task-transition.service.ts` — on `needs_input`, Task → `BLOCKED` and
      escalation `guardrail-refusal` with `railId` and `category` only; **modify**
      `packages/agent/src/tasks-domain/task-ci-auto-resume.ts` and `packages/agent/src/app-works/task-delivery.service.ts` —
      a `wait` or `needs_input` stop consumes no gate attempt and opens no follow-up.
      **Test**: `packages/agent/src/app-works/__tests__/app-work-run-holds.spec.ts` (new) — every rail id and queued reason
      maps as stated; a parked run leaves `maxGateAttempts` untouched; a `ladder` refusal blocks the Task with one
      `guardrail-refusal` escalation and no follow-up (ACC-08-31); **an end-to-end case from a refused tool call in
      `AgentRunService` through the run row to a `BLOCKED` Task, on both the cloud finisher and the Fleet reconciler**
      (APW08-G09). Run:
      `pnpm --filter @ever-works/agent test app-work-run-holds`.
      **Done when**: the spec is green and `packages/agent/src/tasks-domain/__tests__/task-ci-auto-resume.spec.ts`
      passes unchanged.

---

# Additions (2026-09-17 — audit follow-ups: tool grants, containment, limits, cost, switches, a11y)

_Numbered from T47 so every earlier task id stays stable. All are P1 except where noted, and each one is an
**addition**: no task above is removed, renumbered or narrowed._

- [ ] **T47. The App Work Task tool policy (XC-05, FR-69).**
      **Create** `packages/agent/src/app-works/app-work-task-tool-policy.ts` (new) — `APP_WORK_TASK_TOOL_POLICY` and
      the constants of plan §3.4: deny outbound messaging (`sendEmail`, channel notifications, agent-to-agent
      messages), web fetch and search, every MCP tool, sub-agents and delegation, and every App Works mutation tool
      (`create_work`, `provisionAppWork`, `request_app_change`, deploy, env, target, upstream-PR); always allow
      `ask_human` and the read-only repository tools.
      **Modify** `packages/agent/src/agents/agent-tool.service.ts` `resolveAllowedTools` — apply the policy for an
      App Work run, before the list is frozen into the job payload.
      **Modify** `apps/api/src/agents/agents.module.ts` and `apps/api/src/fleet/fleet-agent-task-planner.service.ts` —
      **re-check the policy at dispatch**, the way APW-04 re-checks its Provisioner grants, so a chat surface that
      offers a denied tool cannot get it.
      **Modify** `packages/contracts/src/tasks/task-gates.types.ts` **only if** the policy needs a new refusal code;
      otherwise no contract change. CONTRACTS §3's APW-08 row gains the constant (shared-file request).
      **Test**: `packages/agent/src/app-works/__tests__/app-work-tool-policy.spec.ts` (new) — every denied group is
      denied for a tool the platform actually exposes; `ask_human` and read tools stay; the dispatch re-check refuses
      a run whose resolved list contains one; FR-24's instruction-file case changes nothing; a `group` counter is
      emitted with no tool argument (ACC-08-33). Run: `pnpm --filter @ever-works/agent test app-work-tool-policy`.
      **Done when**: the spec is green and APW-09's plan references this constant instead of a second list (a
      cross-epic request, not an edit here).

- [ ] **T48. Fleet containment: admission, record, and the Task view (XC-06, SK-14, GAP-21, FR-12, FR-70).**
      **Create** `packages/agent/src/app-works/run-containment.ts` (new) — `AppWorkRunContainment` (plan §3.4),
      `needsOwnerAllowance` (false-only or an `isolated-home` downgrade), and the pure admission predicate T12 calls.
      **Modify** `apps/api/src/fleet/fleet-agent-task-reconciler.service.ts` — carry the normalized containment onto
      the run's record beside the existing receipt, and call T46's classifier when it shows a downgrade.
      **Modify** `apps/api/src/works/work-evolve.controller.ts` — the
      `POST /api/works/:id/app-runs/allow-containment` route (plan §4) and the allowance store, which follows the
      EW-807 allow-list pattern: per node, additive, withdrawable, and never implied.
      **Modify** `packages/contracts/src/apps/task-delivery.types.ts` (T7's file) — `TaskCostView` gains
      `containment: AppWorkRunContainment | null`; `packages/agent/src/entities/task.entity.ts` gains nothing (the
      record rides the run).
      **Modify** `docs/specs/features/app-works/EXISTING-SUBSTRATE.md`, `ACCEPTANCE.md` and `README.md` §7 rule 9 —
      **shared-file requests** (the owner's files): the containment record, the clone-URL guard, and the honest
      statement that Fleet setup and checks run with the machine's real home.
      **Test**: `packages/agent/src/app-works/__tests__/run-containment.spec.ts` (new) — the coercion cases of
      `normalizeFleetAgentTaskContainment` read as _less_ contained; `hardened` and `ordinary` both admitted when
      `isolatedHome` is true; the allowance admits one node and not another; the record reaches `TaskCostView`
      (ACC-08-34); the reconciler leaves a non-App Task untouched. Run:
      `pnpm --filter @ever-works/agent test run-containment`.
      **Done when**: the spec is green and `fleet-agent-task-reconciler.spec.ts` passes unchanged.

- [ ] **T49. Operator kill switches for the evolve loop and auto-delivery (XC-10, FR-74, R-30).**
      **Read R-30's switches; do not invent a family.** `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED` already exists
      (CONTRACTS §7, R-30) and already names APW-08: `false` pauses auto-delivery and auto-deploy. The **new**-change
      switch is the one addition, requested from the lead as `EVER_WORKS_APP_CHANGES_ENABLED` (CONTRACTS §7 plus an
      **append** to R-30's list — an addition to R-30, never a change to it), default `true`, so adding the switch
      changes no behaviour.
      **Create** `packages/agent/src/app-works/app-work-switches.ts` (new) — `readAppWorkSwitches()` over those two
      names, **failing closed** on anything it does not recognise and defaulting **on**.
      **Modify** `packages/agent/src/tasks-domain/task-transition.service.ts` `dispatchAgentRun`,
      `packages/tasks/src/tasks/trigger/app-change-delivery.task.ts`,
      `packages/agent/src/missions/mission-tick.service.ts` `evaluateAndRun`,
      `packages/agent/src/goals/goal-orchestrator.service.ts` `applyDispatch`, and the merge hook in
      `packages/agent/src/tasks-domain/task-pr-status.service.ts` — each reads the switch **itself**, so the switch
      bites even for work created before it was flipped; with `EVER_WORKS_APP_CHANGES_ENABLED` off no new change run
      is dispatched, and with `EVER_WORKS_APP_AUTO_DEPLOY_ENABLED` off no auto-deploy is triggered by a merge and no
      follow-up is opened. `EVER_WORKS_APP_WORKS_ENABLED` (R-6) keeps its existing create/inspect meaning, untouched.
      **Nothing is deleted or hidden**: per R-30, jobs pause (a running job finishes its current step and parks), the
      UI is read-only with a banner, existing Deployments keep running and reads keep working.
      **Test**: `packages/agent/src/app-works/__tests__/app-work-kill-switch.spec.ts` (new) — each dispatcher refuses
      with the switch off; no auto-deploy fires; no follow-up opens; a read of an affected board still succeeds; an
      unparseable value fails closed; both defaults are on (ACC-08-38). Run:
      `pnpm --filter @ever-works/agent test app-work-kill-switch`.
      **Done when**: the spec is green and every pre-existing dispatcher spec passes unchanged with the switches at
      their defaults.

- [ ] **T50. One-off backfill of App Work isolation columns (APW08-G07).**
      **Create** `packages/agent/src/app-works/app-work-isolation-backfill.runner.ts` (new) — walks every
      `kind = 'app'` Work whose `taskIsolationBaseBranch` is unset, resolves the branch exactly as T11's listener does
      (applied spec → `WorkAppSpecState` tracked branch → Work Repository default branch) and writes
      `taskIsolation = 'worktree'`, `taskIsolationBaseBranch`, `taskIsolationTargetRepo = 'website'` through the same
      ownership-scoped update. **Idempotent and re-runnable**: a Work already carrying a base branch is skipped, and a
      second run writes nothing. This is a **job, not a migration** — it needs the git facade.
      **Modify** `packages/tasks/src/tasks/trigger/index.ts` (and the dispatcher registration) to expose it as a
      one-shot task; `docs/features/app-works-evolve.md` (T44) records it.
      **Why it is needed**: the listener fires only on an effective-hash change, so App Works created between APW-01/03
      landing and P1 are never visited — their merges would complete as today with no delivery chain at all.
      **Test**: `packages/agent/src/app-works/__tests__/app-work-isolation-backfill.spec.ts` (new) — a Work with a
      null column is filled from each of the three sources in order; a Work with a value is untouched; a second run
      writes nothing; a non-`app` Work is never visited; a Work whose repository is unreadable is counted and left
      alone rather than failing the run (ACC-08-43). Run:
      `pnpm --filter @ever-works/agent test app-work-isolation-backfill`.
      **Done when**: the spec is green.

- [ ] **T51. Ask the owner once about checks; classify a missing tool (APW08-G19, FR-14, FR-61).**
      **Modify** `packages/agent/src/app-works/app-spec-applied.listener.ts` (T11's file) — when the applied spec's
      `checks` differ from the checks the owner was last asked about (deduplicated on the applied spec hash), send
      **one** notification through the existing Task-notification path, linking to the App Checks admission card
      (T14). A re-application with the same checks notifies nobody.
      **Create** `apps/node/src/core/executors/acceptance-checks.missing-tool.ts` (new) — classify exit **127**
      (POSIX) and **9009** (Windows) as **missing tool**; the node runs checks with `spawn(command, { shell: true })`
      (`apps/node/src/core/executors/acceptance-checks.ts:363`), so without this a missing tool is an ordinary red
      exit code and FR-61's `error` state is unreachable.
      **Modify** `apps/node/src/core/executors/acceptance-checks.ts` and
      `apps/api/src/fleet/fleet-agent-task-planner.service.ts` — carry `error` with `appRules.missingTool`, record the
      node id on the Task/run, and exclude that node when the Task is re-offered (the existing Fleet exclusion
      mechanism).
      **Test**: extend `packages/agent/src/app-works/__tests__/app-spec-applied.listener.spec.ts` — one notification
      per hash, none on a no-op (ACC-08-44, first half); extend
      `apps/node/src/core/executors/acceptance-checks.spec.ts` — 127 and 9009 classify as missing tool, every other
      exit code does not; extend the fleet planner spec — the node is recorded and not re-offered (ACC-08-44, second
      half). Run: `pnpm --filter @ever-works/agent test app-spec-applied` and
      `pnpm --filter @ever-works/node test acceptance-checks`.
      **Done when**: the specs are green.

- [ ] **T52. Keyboard and accessibility for the P1 surfaces (XC-25, FR-71).**
      **Modify** `apps/web/src/components/tasks/TaskDeliveryChips.tsx`, `TaskDeliverySection.tsx`,
      `TaskCostSection.tsx`, `TaskRunContainmentNotice.tsx`,
      `apps/web/src/components/works/detail/RequestChangeDialog.tsx`, `WorkCostSummary.tsx`,
      `apps/web/src/components/ai/ChatChangeCard.tsx` — the accessibility bar of FR-71: no colour-only state (every
      chip has its text), full keyboard operability with a visible focus ring, `Esc` closes a dialog and returns focus
      to the opener, progress and completion announced in a polite live region, and a layout that mirrors correctly in
      `ar` and `he`.
      **Test**: `apps/web/e2e/app-works-a11y.spec.ts` (new) — axe over each surface with zero new violations;
      keyboard-only traversal of the Delivery section, both dialogs and the cost summary; focus return asserted;
      the Delivery section rendered in `ar` and `he` with no clipped chip and no mirrored control (ACC-08-35). Run:
      `cd apps/web && pnpm exec playwright test app-works-a11y`.
      **Done when**: the spec is green and the pre-existing e2e flows pass unchanged.

- [ ] **T53. Repository size limits come from one table (XC-29, FR-72).**
      **Consume** `packages/contracts/src/apps/apps-limits.ts` (CONTRACTS §2A — shared-file request; APW-01/03 own the
      file) — per stage, the maximum repository size and LFS support. This epic adds **no** limit of its own.
      **Modify** `packages/agent/src/app-works/isolated-run-admission.ts` (T12's file) and the workspace provisioning
      path — refuse before the run starts when the repository exceeds the limit for the stage it would use, with the
      S35 copy naming the size and the limit.
      **Consume** APW-01 inspect's size reading for the preview; add nothing to it.
      **Test**: `packages/agent/src/app-works/__tests__/repo-size-limit.spec.ts` (new) — the limit is read from the
      shared table; the refusing stage is the one Inspect named; the copy carries size and limit; a repository inside
      the limit is not refused; no local constant exists (a source-text assertion on the epic's own files)
      (ACC-08-36). Run: `pnpm --filter @ever-works/agent test repo-size-limit`.
      **Done when**: the spec is green.

- [ ] **T54. Keyed Task-thread posts (APW08-G12, FR-43).**
      **Create** `apps/api/src/migrations/1792080300000-AddTaskChatMessageKey.ts` (new) — plan §3.5 slot `03`:
      nullable `messageKey varchar(64)`, nullable `messageParams simple-json`, `authorId` **made nullable**
      (widening only) with a `system` `authorType`, and `followUpKey varchar(120) NULL` + `uq_tasks_follow_up_key` on
      `tasks`.
      **Modify** `packages/agent/src/entities/task-chat-message.entity.ts` — append the two columns and allow
      `authorId` null for `system` rows; **modify** `packages/agent/src/tasks-domain/task-workspace.service.ts`
      `postSystemMessage` to accept `{ key, params }` **in addition to** the existing `body` string, writing
      pre-rendered English into `body` as the fallback so every existing reader is unchanged.
      **Modify** `packages/agent/src/app-works/task-delivery.service.ts` (T26's posts) to store keys/params;
      **modify** the Task chat renderer in `apps/web` to render a stored key in the reader's locale, falling back to
      `body`.
      **Test**: `apps/api/src/migrations/__tests__/AddTaskChatMessageKey.spec.ts` (new) — re-runnable, `down()` drops
      only the added columns, every existing row keeps its `authorId`; extend
      `packages/agent/src/app-works/__tests__/task-delivery.service.spec.ts` — a post on a Task with **no Agent**
      stores `authorType: 'system'`, `authorId` null and a key; an existing `postSystemMessage` caller is unchanged
      (ACC-08-24, keyed half). Run: `cd apps/api && pnpm test AddTaskChatMessageKey` and
      `pnpm --filter @ever-works/agent test task-delivery.service`.
      **Done when**: the specs are green.

- [ ] **T55. Follow-up lineage and the provisioner exemption are not labels (APW08-G23).**
      **Modify** `packages/agent/src/app-works/delivery-follow-up.service.ts` (T21's file) — write `followUpKey` on
      the follow-up Task and dedupe on it; keep the existing `follow-up` Task relation as the lineage; **remove the
      label** from the dedup path (the relation and the column carry it), so clearing or editing labels changes no
      behaviour. Label length is not a constraint any more, and a later label update on that Task cannot fail
      validation (`apps/api/src/tasks/tasks.dto.ts:62-72`).
      **Modify** `packages/agent/src/app-works/app-change-guard.ts` (T17's file) — key the App-spec-field exemption on
      APW-04's `WorkAppProvisioning.taskId` (a lookup of the provisioning row for this Task), not on an
      `app-provision` label; **and cover APW-04's own finalize variants** (`APW-04 tasks.md:222-226`), which the label
      never matched either, so the Provisioner's Tasks are exempt on every one of its paths.
      **Test**: `packages/agent/src/app-works/__tests__/follow-up-key.spec.ts` (new) — a user-created Task labelled
      `app-provision` gets **no** exemption; a real provisioning Task does, on each of APW-04's finalize variants; two
      identical failures open one follow-up; a label edit neither creates nor cancels one; the key column accepts the
      full 82-character value. Run: `pnpm --filter @ever-works/agent test follow-up-key app-change-guard`.
      **Done when**: the specs are green and the pre-existing `app-change-guard.spec.ts` cases pass unchanged.

- [ ] **T56. Per-App-Work cost rollup against the Work budget (XC-19, FR-73).**
      **Modify** `apps/api/src/works/work-evolve.controller.ts` — `GET /api/works/:id/cost` returning
      `WorkCostRollup` (month spend, cap, remaining, alert state) through the **existing** `WorkBudget` /
      `WorkBudgetAlertState` entities and `BudgetGuardService` (`packages/agent/src/entities/work-budget.entity.ts`;
      the service `metrics.facade.ts` already uses) — no new spend account.
      **Modify** the App Work run paths (T25's `evolve`, T35's Mission dispatch, T21's follow-up, APW-09's
      preparation runs by request, and the managed Build/hosting charges) to book against the App Work's own
      `WorkBudget` through that guard; a refused run is **waiting** on FR-66's terms.
      **Create** `apps/web/src/components/works/detail/WorkCostSummary.tsx` (T27 owns the component; this task wires
      the budget half) and mount it on the App Work overview.
      **Test**: `packages/agent/src/app-works/__tests__/work-budget.spec.ts` (new) — every charge type books against
      the Work's budget; the alert threshold fires once; a refusal parks the run and opens no follow-up; unknown
      amounts total as unknown (ACC-08-37). Run: `pnpm --filter @ever-works/agent test work-budget`.
      **Done when**: the spec is green and the App Work overview shows cap, remaining and the link to a Task's Cost
      section.

---

## Definition of Done

- Every checkbox above is ticked; `pnpm format:check`, `lint`, `type-check`, `test`, `build` green at the root.
- The P0 PR shows the T1 tests red before and green after.
- Every non-app golden-table spec (isolation, gates, PR status, Goal rules, Mission tick) passes unchanged.
- ACC-08-01…ACC-08-45 walked against a running build; the APW-13 scenarios that depend on this epic are green.
- The known gaps in [plan §11](./plan.md) are still recorded, not silently closed, and the new ones added on
  2026-09-17 (the `ever-works/missions` schema mismatch, the unverified `continue-on-error` behaviour, the real-home
  caveat for Fleet setup and checks) are recorded alongside them.
- Nothing that existed before 2026-09-17 was removed, renumbered, weakened or marked obsolete: every id and every
  default in `spec.md`, `plan.md` and this file is still present (program Resolution R-26).
