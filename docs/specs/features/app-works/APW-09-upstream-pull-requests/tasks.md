# Task Breakdown: Upstream pull requests

> Ordered tasks derived from [`plan.md`](./plan.md). Each is small enough to land in one PR and ships with tests
> per **Constitution VI**. The schema task ships its migration in the same PR per **Constitution V**.

**Epic ID**: `APW-09-upstream-pull-requests`
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
- Phase boundaries are ship boundaries: `develop` stays green and deployable.
- Migration timestamps come from the reserved block `179209<slot>00000`; re-stamp if `develop` moved past
  `1791240000000` (newest on `ee45946e5`, re-verified 2026-09-17).
- **Never** run anything in this epic against a real third-party repository during development: provider calls are
  mocked at the plugin boundary, and manual verification uses a throwaway upstream repository the team owns.
- Program resolutions applied (CONTRACTS §0): R-1 (types in `packages/contracts/src/apps/`), R-2 (Activity family
  `app_upstream_pr`), R-8 (APW-02 owns the Upstream tab), R-17 (holds and rail refusals), R-18 (`publish` rung, never
  bulk-approvable), R-22 (no `apps/api/test/` suites). `upr/` below = `packages/agent/src/upstream-pull-requests/__tests__/`.

---

# Phase P1 — Foundations (Wave 1)

_Delivers the provider contract, the record, eligibility and the member-token rule. Nothing is ever sent upstream in
this phase._

## P1.1 — Provider contract

- [ ] **T1. Cross-repository pull request fields.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — `CreatePROptions.headOwner?`,
      `headRepo?`, `maintainerCanModify?`; `GitPullRequest.headRepoFullName?: string | null`; the same field on
      `GitPullRequestStatus`; `ListPullRequestsOptions.head?: string` (`owner:branch` — plan §4, G17);
      `GitDiffResult.totalCommits?: number` (G13); `GitPullRequestReview` typed as plan §3.3 (G23); and the optional
      methods themselves (`createBranchFromSha?`, `updateBranchRef?`, `listPullRequestReviews?`,
      `listPullRequestReviewComments?`, `getInteractionLimit?`) unless APW-02 T10 has already added them
      (CONTRACTS §2A: whichever lands first creates them, APW-09 keeps the semantics).
      **Modify** `packages/plugins/github/src/github-api.service.ts` — `createPullRequest` composes `head` as
      `{headOwner}:{head}` when `headOwner` is set, sends `maintainer_can_modify` when defined, sends `head_repo` when
      `headOwner === owner` (G23); `createPullRequest`, `getPullRequest`, `listPullRequests`, `getPullRequestStatus`
      map `head.repo?.full_name ?? null`; `getCompareDiff` and `getPullRequestDiff` map compare's `total_commits`;
      `listPullRequests` passes `head` through when set.
      **Modify** `packages/plugins/github/src/github.plugin.ts` — delegate every method added to the capability
      (`github.plugin.ts:285-354` is an explicit pass-through list; a method with no delegation reads as absent to the
      lazy-plugin proxy and every call would surface as `providerUnsupported`, G17).
      **Test**: `packages/plugins/github/src/__tests__/github-api.service.cross-repo.spec.ts` (new) — composition,
      omission (a call without the new fields sends exactly today's request), `head_repo` sent only for a same-owner
      head, mapping on all four reads, deleted head repository → `null`, `totalCommits` mapped, `head=` on a list
      (ACC-09-14, provider half). Run: `pnpm --filter @ever-works/github-plugin test cross-repo`.
      **Done when**: the new spec is green and the existing `github-api.service.pr-insights.spec.ts` and
      `github-api.service.merge.spec.ts` pass unchanged.

- [ ] **T2 (parallel with T1). Reviews, review comments, interaction limits.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — `GitPullRequestReview`,
      `GitPullRequestReviewComment`, `listPullRequestReviews?`, `listPullRequestReviewComments?`,
      `getInteractionLimit?` (plan §4).
      **Modify** `packages/plugins/github/src/github-api.service.ts` and `packages/plugins/github/src/github.plugin.ts`
      — implement with `pulls.listReviews` (≤ 100, body ≤ 8 KB, `id` a number, `state` mapped onto plan §3.3's union),
      `pulls.listReviewComments` (≤ 100, body ≤ 4 KB), `interactions.getRestrictionsForRepo` (404/403/empty →
      **`null`**, never `'none'` — G16: "cannot tell" must not read as "unrestricted").
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.service.cross-repo.spec.ts` — caps and
      truncation, the four interaction-limit values, 404 **and** 403 → `null`, the five review states including
      `dismissed` and `pending`. Run: `pnpm --filter @ever-works/github-plugin test cross-repo`.
      **Done when**: the spec is green.

- [ ] **T3 (parallel with T1). Branch at a commit; fast-forward a branch.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — `createBranchFromSha?`,
      `updateBranchRef?` (skip the interface edit when APW-02 T10 already added them with these signatures).
      **Landed early (recorded 2026-09-17):** APW-02 T9/T10 have **already** added both to the interface —
      `createBranchFromSha?(owner, repo, name, sha, token)` at `git-provider.interface.ts:935` and
      `updateBranchRef?(owner, repo, name, sha, { force: false }, token)` at `:948`, both optional, both returning
      `Promise<GitBranch>` (matching the sibling `createBranch?`; no return type was fixed before). So the interface
      modification above is a **skip**, and this task's remaining scope is the plugin implementation, the facade
      passthrough and the tests — **do not re-declare the two methods**. This is a pointer, not a change of scope:
      nothing in T3 is withdrawn, and if a different return type is ever wanted it changes in this epic **and** in
      APW-02 in one PR (CONTRACTS §3).
      **Modify** `packages/plugins/github/src/github-api.service.ts` —
      `git.createRef({ ref: 'refs/heads/{name}', sha })`; `git.updateRef({ ref: 'heads/{name}', sha, force: false })`
      (422 not-fast-forward → typed `BranchNotFastForwardError`).
      **Modify** `packages/plugins/github/src/github.plugin.ts` — delegate both methods, unless APW-02 T18 has already
      done it (CONTRACTS §2A; in that case this task **extends its tests only** and changes no implementation —
      G17).
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.service.cross-repo.spec.ts` — non-fast-forward
      is surfaced as the typed error, never retried with `force`. Run: `pnpm --filter @ever-works/github-plugin test cross-repo`.
      **Done when**: the spec is green.

- [ ] **T4. Facade pass-throughs and the member token.**
      **Modify** `packages/agent/src/facades/git.facade.ts` — pass-throughs for T1–T3 (absent method →
      `GitOperationNotSupportedError` after materialising the plugin and testing `typeof impl.<method> === 'function'`
      — `git.facade.ts:143-158`, never a bare `GitFacadeError('providerUnsupported')`, whose signature is
      `(message, operation, providerId?)`, G17; reads → `null`); **add**
      `getMemberAccountToken({ userId, providerId })` that resolves only `findUsableGitProviderAccount` then
      `getPatFromSettings(providerId, userId, undefined)`, and never accepts a `workId`.
      **Test**: `packages/agent/src/facades/__tests__/git.facade.member-token.spec.ts` (new) — spies prove
      `tryResolveEverWorksGitPlatformToken` and `getInstallationTokenForWork` are never called; no account + no PAT →
      `null`; a provider without `createBranchFromSha` throws `GitOperationNotSupportedError` and not `GitFacadeError`
      (ACC-09-14, token half). Run: `pnpm --filter @ever-works/agent test git.facade`.
      **Done when**: the new spec and the existing `git.facade.spec.ts` are green.

- [ ] **T5. Spike: a fork branch at an upstream-only commit, and the two provider behaviours G16 flags.**
      **Modify** `docs/specs/features/app-works/APW-09-upstream-pull-requests/plan.md` §9.2 — record the outcome.
      Against a throwaway upstream repository and a fork both owned by the team: (a) create a commit on the upstream
      default branch that the fork does not have; call `createBranchFromSha(fork, 'upstream-pr/spike', sha)` with the
      fork owner's token. Then, on the same throwaway pair, (b) **turn pull requests off at the repository level** and
      try to open one — record the status, the `code` and whether any read answers it (`getRepository`,
      `interactions.getRestrictionsForRepo`, or open-time only); (c) **exhaust the outside-contributor cap** (or read
      the repository's cap) and record what the provider answers; (d) with a **non-admin** token, read the interaction
      limit and record whether a 403/404 distinguishes "no limit" from "cannot tell"; (e) open a pull request as a
      first-time contributor and record how `action_required` surfaces — in `checks.listForRef`
      (`github-api.service.ts:989`), in workflow runs, or in check suites — because FR-30's summary depends on it.
      **Test**: manual, run once against the throwaway pair; every provider response (status and message) is pasted
      into the PR description.
      **Done when**: all five results are recorded in plan §9.2 — (a) decides whether the `syncForkBranch?` mirror
      branch fallback is needed; (b) and (c) pin the reads behind `pullRequestsDisabled` and `outsideContributorCap`;
      (d) pins `getInteractionLimit`'s `null`; (e) pins whether `summarizeUpstreamChecks` needs
      `getWorkflowRunForCommit` as an input (if it does, a task is appended here to add it).

## P1.2 — Record and shared types

- [ ] **T6. Contracts and Activity family.**
      **Create** `packages/contracts/src/apps/upstream-pull-request.types.ts` (new) exactly as plan §3.3 (Resolution
      R-1 — the one shared types folder), including the seven appended refusal codes, `UPSTREAM_ERROR_CODES`,
      `UpstreamPreparationReport`, `UpstreamEligibilityView`, `UpstreamPullRequestView`,
      `UpstreamPullRequestDetailView` and `GitPullRequestReview`.
      **Modify** `packages/contracts/src/apps/index.ts` (created by APW-03 T1; if APW-03 has not landed, create it and
      add `export * from './apps/index.js';` to `packages/contracts/src/index.ts` exactly as APW-03 T1 specifies) —
      `export * from './upstream-pull-request.types.js';`.
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append `APP_UPSTREAM_PR = 'app_upstream_pr'`
      (Resolution R-2; the dotted `app.upstream_pr.*` event goes in `action`).
      **Modify** `packages/agent/src/activity-log/feed-kind.ts` — append
      `[ActivityActionType.APP_UPSTREAM_PR]: 'deliveryWhenCompleted'` to `FEED_KIND_RULES` (APW09-G03: the table-driven
      spec at `feed-kind.spec.ts:14-19` fails until every member has an explicit entry, and the comment at
      `feed-kind.ts:48-52` says so). No existing rule is changed or reordered.
      **Modify** nothing in `packages/contracts/src/api/shared-view/publishable-activity.ts`: resolution R-34 classifies
      every new family, and App Works events default to **`NEVER_PUBLISH`** — `app_upstream_pr` must stay off
      `PUBLISHABLE_ACTIVITY_ACTIONS` (its Live Feed narration names a repository and a pull-request number).
      **Test**: `packages/contracts/src/apps/__tests__/upstream-pull-request.types.spec.ts` (new) — pins every union,
      every number and every copy-bearing code (30 refusals + `activeProposal`); extend
      `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` with `['APP_UPSTREAM_PR', 'app_upstream_pr']`;
      extend `packages/agent/src/activity-log/feed-kind.spec.ts` — the new member is mapped, and with
      `ActivityStatus.FAILED` for `app.upstream_pr.refused` / `.failed` / `.expired` it resolves to the problem kind
      while `COMPLETED` `app.upstream_pr.opened` resolves to delivery (plan §3.4); extend
      `packages/agent/src/shared-views/__tests__/publishable-activity.spec.ts` — `app_upstream_pr` is on
      `NEVER_PUBLISH_ACTIVITY_ACTIONS` and not on the publishable allowlist (R-34; that spec already fails until every
      kind is classified). Run:
      `pnpm --filter @ever-works/contracts test` and `pnpm --filter @ever-works/agent test activity-log.types feed-kind publishable-activity`.
      **Done when**: all three specs are green and `pnpm --filter @ever-works/contracts build` emits the declarations.

- [ ] **T7. Entity + migrations.**
      **Create** `packages/agent/src/entities/upstream-pull-request.entity.ts` (new) per plan §3.1 (dates via
      `PortableDateColumn`, scope columns without relations, `@ManyToOne` to `User` and `Work` with
      `onDelete: 'CASCADE'`), including the 2026-09-17 additions: `upstreamBaseSha` (G01),
      `preparationStartedAt` / `preparationPausedMs` / `preparationHeldSince` (G14), `claUrl` / `missingPieces`
      (G04) and `extraFilesAcknowledgedAt` / `extraFilesAcknowledgedById` (G06).
      **Create** `packages/agent/src/entities/work-upstream-pr-setting.entity.ts` and
      `packages/agent/src/entities/upstream-pr-suggestion.entity.ts` (new) per plan §3.1A/§3.1B (G07, G20).
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts`.
      **Create** `apps/api/src/migrations/1792090000000-CreateUpstreamPullRequests.ts` (new) — table, five indexes
      (partial unique on both engines, incl. `idx_upr_preparing_started`), `down()` drops only these;
      `apps/api/src/migrations/1792090100000-CreateUpstreamPrSuggestions.ts` and
      `apps/api/src/migrations/1792090200000-CreateWorkUpstreamPrSettings.ts` (new) — slots 01 and 02, each with its
      own guarded `up()` and its own `down()`.
      **Create** `packages/agent/src/database/repositories/upstream-pull-request.repository.ts` (new) — scoped finders,
      CAS state update `updateStateIf(id, userId, from, to, patch)`, limit-window counts, due-row selection,
      `findByPreparationTaskId` / `findByFollowUpTaskId` (the row lookups G18 routes finalize by), the due-`preparing`
      selection G14's sweep needs, and `stopTrackingForUser` / `stopTrackingForOrganization` (XC-14).
      **Modify** `packages/agent/src/database/index.ts` — export the new repositories (the pattern every feature-owned
      repository follows; `database/index.ts:59-60` shows the Agents/Tasks precedent). Do **not** add them to
      `packages/agent/src/database/_repository-inventory.ts`: that list is `DatabaseModule`'s own providers only
      (`_repository-inventory.ts:21-27`), and the drift spec asserts the two lengths are equal
      (`database.module.spec.ts:48-51`), so an entry there without a `DatabaseModule` provider turns the suite red.
      **Test**: `packages/agent/src/entities/__tests__/upstream-pull-request.entity.spec.ts` (new) — index names and
      scope columns; `apps/api/src/migrations/__tests__/CreateUpstreamPullRequests.spec.ts` (new) — all three
      migrations re-runnable; `packages/agent/src/database/repositories/__tests__/upstream-pull-request.repository.spec.ts`
      (new) — a second active row for one source Task fails, a closed one does not; the two row lookups; a
      `preparing` row whose running time exceeds 90 minutes is selected and a held one is not (ACC-09-24, 25, 34, 38).
      Run: `pnpm --filter @ever-works/agent test upstream-pull-request` and
      `cd apps/api && pnpm test CreateUpstreamPullRequests`.
      **Done when**: the specs are green and the drift checks in `packages/agent/src/database/database.module.spec.ts`
      pass **unchanged**.

## P1.3 — Eligibility

- [ ] **T8. Pure rules and limits.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-eligibility.rules.ts`,
      `packages/agent/src/upstream-pull-requests/upstream-rate-limits.ts`,
      `packages/agent/src/upstream-pull-requests/summarize-upstream-checks.ts`,
      `packages/agent/src/upstream-pull-requests/upstream-fingerprint.ts` (new).
      `upstream-eligibility.rules.ts` takes the App spec's `upstreamPullRequests.maxOpen` (default 3, hard ceiling 10,
      FR-26 — the effective open-per-upstream cap is `min(maxOpen, UPSTREAM_LIMITS.openPerUpstreamCeiling)` and the
      constant is a ceiling, never the limit, G15), the platform-wide per-upstream ceiling
      (`UPSTREAM_LIMITS.platformOpenedPerUpstreamPer24h`, FR-39) and the operator deny list (FR-41) as inputs, and
      returns the refusing `limit` key alongside the code so the API can build the `429` body (FR-27, G10).
      `summarizeUpstreamChecks` returns `unknown` for a **non-empty** list it cannot classify, and never `passing`
      for an empty one; the review-summary rule is plan §4's — latest non-`pending`, non-`dismissed` review per
      author, `changes_requested` > `approved` > `commented` (G23) — and `seenReviewIds` evicts the oldest id past
      `UPSTREAM_TEXT.maxSeenReviewIds`.
      **Test**: `upr/upstream-eligibility.rules.spec.ts`, `upr/upstream-rate-limits.spec.ts`,
      `upr/summarize-upstream-checks.spec.ts`, `upr/upstream-fingerprint.spec.ts` (new) — every branch in plan §10.1,
      including 24-hour windows at `23:59:59` and `24:00:01`, `maxOpen` 1/3/10 against the ceiling, the platform
      ceiling refusing while the member's own allowance remains, the deny list, the five review states and the
      200-id eviction (ACC-09-02, 12, 15, 17, 28, 29). Run:
      `pnpm --filter @ever-works/agent test upstream-pull-requests`.
      **Done when**: the four specs are green.

- [ ] **T9. `UpstreamEligibilityService`.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-eligibility.service.ts` and
      `packages/agent/src/upstream-pull-requests/upstream-pull-requests.module.ts` (new) — reads APW-01
      `sourceRepository.type/upstream`, APW-03 App spec `upstreamPullRequests.enabled` **and `.maxOpen`** through
      `AppSpecService.getEffectiveSpec` (G15), APW-08 delivery state (merged or later), APW-02 `getRepository`
      (`archived`, `source`, the pull-requests-disabled flag), `getInteractionLimit`
      (`collaborators_only`/`contributors_only` → `collaboratorsOnly`, `null` → "cannot tell", never "allowed",
      G16), the maintainer opt-out marker (FR-40) and the operator deny list (FR-41), fork push permission and token
      scope via T4. `UpstreamPullRequestsModule` wires its own `TypeOrmModule.forFeature([UpstreamPullRequest,
WorkUpstreamPrSetting, UpstreamPrSuggestion])` and provides `UpstreamPullRequestRepository` (T7).
      **Modify** `apps/api/src/api.module.ts` — import `UpstreamPullRequestsModule`.
      **Test**: `upr/upstream-eligibility.service.spec.ts` (new) — each refusal code (including `pullRequestsDisabled`,
      `outsideContributorCap`, `maintainerOptOut`, `deniedUpstream`), `maxOpen` honoured per App Work, and that the
      member token (never a Work-resolved token) is used for every read (ACC-09-02, 03, 29). Run:
      `pnpm --filter @ever-works/agent test upstream-eligibility`.
      **Done when**: the spec is green.

- [ ] **T10. Read-only API.**
      **Create** `apps/api/src/works/upstream-pull-requests.controller.ts` (new) with
      `GET /api/works/:id/upstream-pull-requests` and `GET …/eligibility`; **create**
      `apps/api/src/works/dto/upstream-pull-request.dto.ts` (new) — the field lists are plan §3.3's
      `UpstreamPullRequestView`, `UpstreamEligibilityView` and (added by T19) `UpstreamPullRequestDetailView`, each
      with `@ApiProperty` so the OpenAPI document is complete for the parity table (G11, XC-23);
      **modify** `apps/api/src/works/works.module.ts`.
      **Test**: `apps/api/src/works/upstream-pull-requests.controller.spec.ts` (new) — shapes (every view field
      present, no row leaks `fingerprint`), `list` returns other members' rows for the same Work with their author,
      a foreign `workId` answers `404`, throttles (ACC-09-03, 23, 36). Run:
      `cd apps/api && pnpm test upstream-pull-requests.controller`.
      **Done when**: the spec is green.

- [ ] **T11. P1 web: eligibility on the Task.**
      **Create** `apps/web/src/lib/api/upstream-pull-requests.ts` (new) and
      `apps/web/src/components/tasks/ProposeUpstreamAction.tsx` (new) — a disabled **Propose upstream** button with the
      reason for fork App Works, hidden for link, since nothing can be prepared yet.
      **Modify** `apps/web/src/components/tasks/TaskDetailClient.tsx` — mount it.
      **Modify** `apps/web/messages/en.json` — `dashboard.tasksPage.proposeUpstream.action` and
      `dashboard.workDetail.upstream.refusals.*`; mirror keys into the 20 sibling locales.
      **Test**: `apps/web/src/components/tasks/ProposeUpstreamAction.unit.spec.tsx` (new) — hidden for link, disabled
      with the S10 copy for a private copy, disabled without push access (ACC-09-02). Run:
      `pnpm --filter ever-works-web test ProposeUpstreamAction`.
      **Done when**: the spec is green.

- [ ] **T12. P1 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` (APW-09 notes) and this file's P1 checkboxes.
      **Test**: root `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done when**: the commands are green and ACC-09-02 and ACC-09-03 (eligibility half) are walked.

---

# Phase P2 — Prepare, approve, open, track (Wave 2)

- [ ] **T13. Workspace squash.**
      **Modify** `packages/plugin/src/contracts/capabilities/workspace.interface.ts` —
      `WorkspaceFinalizeOptions.squashOnto?: string`.
      **Modify** the finalize implementations in `packages/plugins/sandbox-workspace/src/` and
      `packages/plugins/local-workspace/src/` — `git merge-base --is-ancestor <sha> HEAD` else refuse;
      `git reset --soft <sha>`; single commit with `identity`; push.
      **Modify** `packages/agent/src/facades/workspace.facade.ts` — pass through.
      **Test**: `packages/plugins/sandbox-workspace/src/__tests__/sandbox-workspace.squash.spec.ts` and
      `packages/plugins/local-workspace/src/__tests__/local-workspace.squash.spec.ts` (new) — 3 agent commits become 1;
      non-ancestor refused; omitted option unchanged (ACC-09-04, workspace half). Run:
      `pnpm --filter @ever-works/sandbox-workspace-plugin test squash` and
      `pnpm --filter @ever-works/local-workspace-plugin test squash`.
      **Done when**: both specs are green and the existing `sandbox-workspace.spec.ts` / `local-workspace.spec.ts` pass.

- [ ] **T14. Approval type (Resolution R-18).**
      **Modify** `packages/agent/src/entities/agent-action-proposal.entity.ts` — append `'upstream_pull_request'` to
      the union and `AGENT_ACTION_PROPOSAL_ACTION_TYPES`; `AgentActionProposalDecidedVia` gains `'expired'`.
      **Modify** `packages/agent/src/agent-approvals/risk-scorer.ts` — cross-scope by action type.
      **Modify** `packages/agent/src/agent-approvals/agent-approvals.service.ts` — `requiresIndividualDecision` returns
      `true` for the type, so `approveAll` counts it `excluded` (never approvable in bulk); add `expire(proposalId)`.
      **Modify** `packages/agent/src/safety/guardrail-interop.ts` — append
      `upstream_pull_request: 'publish.external'` (the `publish` rung) to the proposal table `PROPOSAL_ACTION_CATEGORY`;
      append-only beside AW-24 P2's own action types.
      **Test**: extend `packages/agent/src/agent-approvals/__tests__/risk-scorer.spec.ts` — an empty payload still flags
      cross-scope; extend `packages/agent/src/agent-approvals/__tests__/agent-approvals.service.spec.ts` — guardrail
      `autonomous` never auto-approves; `approveAll` counts it `excluded`; `expire` sets `decidedVia: 'expired'`;
      extend `packages/agent/src/agents/__tests__/guardrails.ladder-interop.spec.ts` — the new key maps to
      `publish.external`, every pre-existing key is unchanged, an enforced `off` rung returns `block` and the proposal
      is rejected with `decidedVia: 'guardrail'` (ACC-09-11, 13). Run:
      `pnpm --filter @ever-works/agent test risk-scorer agent-approvals.service guardrails.ladder-interop`.
      **Done when**: the three specs are green.

- [ ] **T15. Preparation service and finalize branch.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-preparation.service.ts` (new) —
      `start(userId, workId, { taskId, maintainerCanModify })`: the operator switch (T39) → eligibility → row
      (`preparing`, unique active index, `upstreamBaseSha` = the upstream default-branch head read in this same step,
      G01) → branch name `upstream-pr/{slug≤40}-{4 hex}` → `createBranchFromSha` at that sha → preparation Task
      (title `Prepare upstream pull request: {source title}`, labels `upstream-pr:<id>`, `branchRef` **preset to
      `row.headBranch`**, the source PR diff (≤ 256 KB) and upstream guide files (each ≤ 64 KB) seeded through
      `seedPendingInput` as fenced untrusted entries — never in the system prompt, task-transition.service.ts:870-897,
      G09) → `dispatchAgentRun` with the reviewer `delegationScope` so a Fleet dispatcher refuses it (G09) →
      returns `202`.
      **Modify** `packages/agent/src/tasks-domain/task-workspace.service.ts` — **two** early branches, both by row
      lookup and both **before** APW-08's `AppChangeGuard` and `simulateMerge` (G01, G02, G09):
      `provisionForRun` resolves `baseRef` from the row when `row.preparationTaskId === task.id` (`row.headBranch`)
      or `row.followUpTaskId === task.id` (the follow-up branch), so `handle.baseSha` and `task.baseSha` are the
      upstream-side commit; `finalizeRun` calls `onPreparationFinalized` with `squashOnto: row.upstreamBaseSha` and the
      member identity for a preparation Task, and `UpstreamReviewFollowUpService.onFollowUpFinalized` (no squash) for a
      follow-up Task, skipping `simulateMerge` and `openPullRequestForBranch` for both. `finalizeRemotePush` refuses
      both bindings. Routing is by `findByPreparationTaskId` / `findByFollowUpTaskId`, **never** by a Task label —
      labels are free-form and client-writable (`apps/api/src/tasks/tasks.dto.ts:62-72, 224-234`), so a hand-added
      `upstream-pr:<id>` must change nothing (G18).
      **Test**: `upr/upstream-preparation.service.spec.ts` (new) — double start → one row (S27); Fleet refusal; the
      Task branch is the prepared branch cut from the upstream head; **the squash base equals the sha passed to
      `createBranchFromSha`** and not the fork's branch head (ACC-09-24); no same-repository PR is ever opened for a
      preparation or a follow-up binding, asserted on `createPullRequest` never being called (ACC-09-04, 25); a Task
      carrying a hand-added label is finalized normally (G18). Run:
      `pnpm --filter @ever-works/agent test upstream-preparation`.
      **Done when**: the spec is green and `task-workspace.service.spec.ts` passes unchanged.

- [ ] **T16. Verifier.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-preparation.verifier.ts` (new) — `getCompareDiff`
      over `upstreamOwner/upstreamRepo`, `baseBranch...{forkOwner}:{headBranch}` with `{ maxFiles: 300, maxBytes:
1024 * 1024 }` (the hard cap is 1 MiB, `pr-insights.ts:28`; the default 256 KiB at `:22` silently drops
      patches, G13); `notSingleCommit` reads `GitDiffResult.totalCommits` (T1) and counts the **commit count**, never
      the file list (G13); refusals `excludedPath` (plan §3.3 globs incl. `.ever-works/**` + App spec protected paths,
      path and `previousPath`), `tooManyExtraFiles`, `tooLarge` (1,000 lines / 30 files or the project's smaller
      stated limit reported by the run), `secretDetected` (`scanForSecrets` and **the pattern name only** stored —
      never `assertNoSecrets`, whose `BadRequestException` embeds the matched sample,
      `packages/agent/src/utils/secret-scan.ts:47-55`, G13), `tooLarge`/`secretDetected` when the compare is
      `truncated` or any file carries `patchOmitted` (APW-08's guard refuses `truncated` too, APW-08 plan §2.5),
      `checksRed` (unless `alreadyRedOnBase`), the FR-47 report validation (`reportInvalid`, `missingPieces ≤ 10`,
      check bounds), and flags `aiNotAccepted` / `dcoRequired` / CLA; builds title (≤ 72), body (≤ 8,000) with the
      disclosure line last.
      **Test**: `upr/upstream-preparation.verifier.spec.ts` (new) — the fixture "fork with 40 unrelated commits" yields a
      diff with only the source files; every exclusion incl. renames; the 1,240-line and 300-line-limit refusals;
      `aiNotAccepted`; template filled with the disclosure last and no Ever Works link; a truncated compare and a
      `patchOmitted` file both refuse; a secret match stores the pattern name and no sample; a report with 11 checks,
      one 31-minute check or an 81-minute total refuses `reportInvalid` (ACC-09-05, 06, 07, 09, 16, 39). Run:
      `pnpm --filter @ever-works/agent test upstream-preparation.verifier`.
      **Done when**: the spec is green.

- [ ] **T17. Proposal, listener, open job.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-approval.listener.ts`,
      `packages/agent/src/upstream-pull-requests/upstream-open.service.ts`,
      `packages/agent/src/tasks/upstream-pr-open-dispatcher.ts`, `packages/tasks/src/tasks/trigger/upstream-pr-open.task.ts`
      (all new).
      **Modify** `packages/agent/src/tasks/_tasks-symbols.ts` (alphabetical), `packages/agent/src/tasks/index.ts`,
      `packages/agent/src/tasks/job-runtime.providers.ts` (`DISPATCHER_SYMBOLS` + 1 and its arity comment),
      `packages/tasks/src/trigger/trigger.module.ts`, `packages/tasks/src/trigger/trigger.service.ts`,
      `packages/tasks/src/tasks/trigger/index.ts`.
      Proposal via `createProposal({ actionType: 'upstream_pull_request', humanDecisionRequired: true, subjectKey })`;
      the listener ignores non-author decisions (**kept** as written, but it never inserts a second proposal — the
      `UNIQUE (actionType, subjectKey)` index already holds that row, `agent-action-proposal.entity.ts:128`; it
      re-raises the same proposal when the service offers a re-open path and otherwise leaves the row
      `awaiting_approval`, notifies the author and records the refusal, G08); `decidedVia === 'expired'` → row state
      `expired` + Activity `app.upstream_pr.expired` (G08); open job: CAS → fingerprint/TTL/**extra-files
      acknowledgement**/eligibility/limits → `createPullRequest` with `options.token` from `getMemberAccountToken` →
      `open`, `nextCheckAt = +30 min`, preparation Task `done`, Activity `actionType: 'app_upstream_pr'`,
      `action: 'app.upstream_pr.opened'`. The **409 `activeProposal`** path and the **429 with `limit`** are built
      here from T8's rules (G10), the recovery path uses `listPullRequests({ state: 'all', head: 'fork:branch' })`
      (T1) and adopts an existing pull request only when its head repo and branch equal the row's (G17), and the
      operator switches of T39 are read before any provider call.
      **Test**: `upr/upstream-approval.listener.spec.ts`, `upr/upstream-open.service.spec.ts` (new) — non-author
      decision ignored and no second proposal inserted; a changed head, title, body, base or maintainer choice opens
      nothing; a 73-hour-old approval opens nothing and lands on `expired` (not `withdrawn`); the member token and
      `owner:branch` head are used; a second PR on one upstream in 24 h is refused with the **`limit` key and** the
      next slot; an unacknowledged extra-file diff cannot be approved and the open job refuses it as well
      (ACC-09-11…ACC-09-15, 26); the lost-open recovery and the adopt-on-422 case both pass; extend
      `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts` — the dispatcher count grows by one. Run:
      `pnpm --filter @ever-works/agent test upstream-approval upstream-open job-runtime.providers`.
      **Done when**: the specs are green.

- [ ] **T18. Status job.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-status.service.ts` (new),
      `packages/tasks/src/tasks/trigger/upstream-pr-status.task.ts` (new, cron `3-59/10 * * * *`).
      **Modify** `packages/tasks/src/tasks/trigger/index.ts` — export it.
      Per due row (≤ 100): `getPullRequestStatus` + `listPullRequestReviews` (≤ 4 requests); `summarizeUpstreamChecks`;
      new review ids → Inbox notice per review; CLA-named checks → `signatureState`; merged/closed → final + Activity;
      cadence (30 min / 6 h / pause 90 days); expire approvals past 72 h (`expire`); delete fork branches of terminal
      rows within 10 minutes (`deleteBranch`, `forkBranchDeletedAt`); re-dispatch approved rows stuck 15 minutes.
      **Test**: `upr/upstream-status.service.spec.ts` (new) — one Inbox notice per review, cadence and pause, branch deletion (ACC-09-17, 18, 19, 20, 22);
      `packages/tasks/src/__tests__/upstream-pr-status.task.spec.ts` (new) — cron string and batch size. Run:
      `pnpm --filter @ever-works/agent test upstream-status` and `pnpm --filter @ever-works/trigger-tasks test upstream-pr-status`.
      **Done when**: both specs are green.

- [ ] **T19. Write endpoints.**
      **Modify** `apps/api/src/works/upstream-pull-requests.controller.ts` — `POST` (propose), `GET :prId` (with diff,
      returning `UpstreamPullRequestDetailView`), `POST :prId/signed`, `POST :prId/acknowledge-extra-files` (records
      the acknowledgement for the caller; `409 extraFilesNotPresent` when the diff marks none — G06, FR-49),
      `POST :prId/withdraw`, `POST :prId/check` (≥ 60 s apart); error contract of plan §5, **including the seven
      appended refusal codes, `409 activeProposal`, `409 settingWriteUnavailable` and a `429` body that always carries
      `limit`** (G10). `POST :prId/signed` carries `@HumanOnly()` (see T38).
      **Test**: extend `apps/api/src/works/upstream-pull-requests.controller.spec.ts` — every route's shape and codes,
      `409 activeProposal`, `429 rateLimited` with `limit` **and** `nextSlotAt` (and `limit: 'openPerUpstream'` with no
      `nextSlotAt`), `publishingOff` distinguished from `blocked`, the approval view carries the full diff, the
      acknowledgement route's two outcomes and its effect on an approve arriving through the API, withdraw state, 404
      for another account (ACC-09-03, 10, 12, 22, 23, 26, 28). Run:
      `cd apps/api && pnpm test upstream-pull-requests.controller`.
      **Done when**: the spec is green.

- [ ] **T20. Enable toggle via the App spec (deterministic, with a recorded pending state).**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-setting.service.ts` (new) — reads
      `upstreamPullRequests.enabled` from the effective App spec and, on a toggle, writes the change **itself**:
      `commitFiles` onto a branch plus a setup pull request where R-4 requires one (the same pattern APW-03's apply
      job uses), recording `requestedEnabled`, the branch and the pull request in `work_upstream_pr_settings`
      (T7, §3.1A). The service **offers** APW-08's `POST /api/works/:id/evolve` request builder as the alternative
      when `APP_WORK_AGENT_RESOLVER.resolve({ userId: member, workId })` answers and an isolated runtime exists, and
      handles `409 agentRequired` / `409 noIsolatedRuntime` by falling back to the deterministic path instead of
      failing the request (APW-08 T25 returns both today) — the toggle must never depend on an Agent being
      resolvable. With no write path at all it answers `409 settingWriteUnavailable`. `read()` reports
      **pending** while `requestedEnabled` differs from the applied value, so the answer survives a reload.
      **Test**: `upr/upstream-setting.service.spec.ts` (new) — default off; toggling opens no pull request upstream
      and files exactly one App spec change; with no resolvable Agent and no isolated runtime the deterministic path
      is still taken; with no write path it refuses with the code and changes nothing; `read()` reports pending until
      the change merges and the applied value afterwards (ACC-09-01, 27). Run:
      `pnpm --filter @ever-works/agent test upstream-setting`.
      **Done when**: the spec is green.

- [ ] **T21. Upstream pull requests section, dialog, approval review (Resolution R-8).**
      **Modify** `apps/web/src/app/[locale]/(dashboard)/works/[id]/upstream/page.tsx` (created by APW-02 T30 — the one
      Upstream tab with its relation card, readiness, sync status and Actions hygiene) — append the **Upstream pull
      requests** section below APW-02's cards. This epic creates no page, no relation card and no tab entry.
      **Create** `apps/web/src/components/works/detail/upstream/UpstreamPullRequestsSection.tsx`,
      `apps/web/src/components/works/detail/upstream/UpstreamApprovalReview.tsx`,
      `apps/web/src/components/tasks/ProposeUpstreamDialog.tsx`,
      `apps/web/src/app/actions/works/upstream-pull-requests.ts` (all new).
      **Modify** `apps/web/src/components/tasks/ProposeUpstreamAction.tsx` (enable the action),
      `apps/web/src/components/inbox/InboxDecisionDetail.tsx` (approval item links to `UpstreamApprovalReview` at
      `/works/:id/upstream?review=<prId>`, and notice actions render — T36),
      `apps/web/src/components/approvals/ApprovalsQueue.tsx` (never offered to bulk approval),
      `apps/web/src/lib/api/agent-approvals.ts` and `apps/web/src/lib/api/agents.shared.ts` (action type unions),
      `apps/web/src/components/activity-log/ActivityTypeBadge.tsx` (`app_upstream_pr` → `appUpstreamPr`).
      **Test**: `apps/web/src/components/works/detail/upstream/UpstreamPullRequestsSection.unit.spec.tsx`,
      `UpstreamApprovalReview.unit.spec.tsx` (beside it) and `apps/web/src/components/tasks/ProposeUpstreamDialog.unit.spec.tsx`
      (new) — state/check/review chip text, private-copy notice, org-fork maintainer note, the extra-files tick gates
      **Approve and open** and posts the acknowledgement, the agent-reported check label, stale copy, the pending
      toggle copy, the paused-by-platform and credential-paused banners (ACC-09-10, 17, 27, 28, 32, 34, 39); extend
      `apps/web/src/components/approvals/ApprovalsQueue.unit.spec.tsx` — an `upstream_pull_request` row is excluded
      from bulk approval; extend `apps/web/src/components/inbox/InboxDecisionsClient.unit.spec.tsx` — the approval
      item links to the review route. Run:
      `pnpm --filter ever-works-web test Upstream ProposeUpstreamDialog ApprovalsQueue InboxDecisionsClient`.
      **Done when**: the specs are green and `WorkTabs.unit.spec.tsx` passes unchanged (this epic does not touch tabs).

- [ ] **T22. P2 i18n.**
      **Modify** `apps/web/messages/en.json` — every sub-tree in plan §8.1, **one `refusals` leaf per value of
      `UPSTREAM_REFUSAL_CODES` after the seven 2026-09-17 additions (30)** and the `rateLimited` leaves keyed by
      `limit` (G10); mirror keys into the 20 sibling locales
      (`node apps/web/scripts/sync-locale-parity.mjs`).
      **Test**: `apps/web/src/lib/__tests__/app-works-upstream-messages.unit.spec.ts` (new) — every leaf of the plan §8.1
      sub-trees exists in all 21 locale files, the `refusals` tree has exactly one leaf per code **and no leaf for a
      code that does not exist**, every `limit` key of `UPSTREAM_LIMITS` has copy, and no leaf key contains a `.`
      (ACC-09-23, 28, strings half). Run: `pnpm --filter ever-works-web test app-works-upstream-messages`.
      **Done when**: the spec is green.

- [ ] **T23. Skill.**
      **Create** in `ever-works/skills`: `skills/upstream-contribution/SKILL.md` from
      [`skill-draft/SKILL.md`](./skill-draft/SKILL.md) and its `manifest.json` row — including the report contract
      (T37: the file path, the schema and the caps, FR-47) and the FR-12 bounds the Skill states.
      **Modify** `packages/agent/src/upstream-pull-requests/upstream-preparation.service.ts` — bind the Skill to the
      preparation Agent at Work scope on first use (idempotent).
      **Test**: extend `upr/upstream-preparation.service.spec.ts` — two preparations on one App Work create one binding.
      **Done when**: the spec is green and the Skill appears in the catalog.

- [ ] **T24. P2 e2e.**
      **Create** `apps/web/e2e/app-works-upstream-tab.spec.ts`, `apps/web/e2e/app-works-propose-upstream.spec.ts`,
      `apps/web/e2e/app-works-upstream-refusals.spec.ts` (new) per plan §10.4. No suite under `apps/api/test/` (R-22).
      Every spec in this lane runs against the fake GitHub: the command carries `EVER_WORKS_E2E_FAKES=1` (it is the
      single non-production hook CONTRACTS §7 defines, and without it the lane talks to the real GitHub — G05), and
      each spec asserts that no provider call left the fake.
      **Test**: `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test app-works-upstream-tab app-works-propose-upstream app-works-upstream-refusals`
      — pass (ACC-09-01, 03, 08, 09, 10, 12, 15, 17, 26, 30, 37), including the axe scan and the `ar`/`he` render of
      FR-42 (XC-25) in `app-works-upstream-tab`.
      **Done when**: the three specs pass.

- [ ] **T25. P2 ship gate.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` and this file's P2 checkboxes.
      **Test**: root `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done when**: the commands are green and ACC-09-01…ACC-09-17, 19, 20, 22, 23 are walked against a throwaway
      upstream repository.

---

# Phase P3 — Reviews and suggestions (Wave 2)

- [ ] **T26. Address review.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-review-follow-up.service.ts`,
      `packages/agent/src/tasks/upstream-pr-push-dispatcher.ts`, `packages/tasks/src/tasks/trigger/upstream-pr-push.task.ts`
      (all new); register symbols, exports and runtime bindings in the files T17 modified.
      Flow per plan §2.6: update branch from the PR head → Task `upstream-pr-update:<id>` with fenced review bodies
      and inline comments (≤ 64 KB) seeded through `seedPendingInput` → finalize (no squash) →
      `onFollowUpFinalized` verifies the update diff (exclusions, ≤ 500 lines, secrets) → push approval → fast-forward
      via `updateBranchRef` (typed non-fast-forward refusal) → `pushTimestamps`.
      Blocked while `signatureState = 'cla_pending_check'`; ≤ 5 pushes per 24 h.
      **Modify** `packages/agent/src/tasks-domain/task-workspace.service.ts` — a Task bound to `row.followUpTaskId`
      (looked up by row, never by the `upstream-pr-update:<id>` label) calls `onFollowUpFinalized` from `finalizeRun`
      **before** APW-08's `AppChangeGuard` and `simulateMerge`, and `finalizeRemotePush` refuses it: without this the
      follow-up Task reaches `simulateMerge` against the fork base and then `openPullRequestForBranch`
      (`task-workspace.service.ts:1235-1272`), opening a pull request **inside the fork** (G02). The
      control-token neutralisation this brief needs is a **new shared helper** in `packages/contracts/src/apps/`
      (e.g. `neutralizeUntrustedText`) — `neutralizeControlTokens` is a module-private function in
      `apps/api/src/fleet/fleet-agent-task-planner.service.ts:77` and `packages/agent` cannot import it (G22).
      **Modify** `apps/api/src/works/upstream-pull-requests.controller.ts` — `POST :prId/address-review`.
      **Test**: `upr/upstream-review-follow-up.service.spec.ts` (new) — a follow-up finalize calls
      `onFollowUpFinalized` and **`createPullRequest` is never called**; nothing pushed before approval, then a
      fast-forward; non-fast-forward refusal; the 6th push in 24 h refused (ACC-09-18, 25);
      `packages/tasks/src/__tests__/upstream-pr-push.task.spec.ts` (new) — the job calls the service once per dispatch;
      extend the controller spec with `address-review`. Run:
      `pnpm --filter @ever-works/agent test upstream-review-follow-up` and `pnpm --filter @ever-works/trigger-tasks test upstream-pr-push`.
      **Done when**: the specs are green.

- [ ] **T27. Signature acknowledgement flow.**
      **Modify** `packages/agent/src/upstream-pull-requests/upstream-preparation.service.ts` — `needs_signature` pause and
      one-time resume on `…/signed`; DCO → `refused/dcoRequired`.
      **Test**: `upr/upstream-signature.spec.ts` (new) — a CLA yields `needs_signature`; `signed` resumes exactly once; DCO
      refuses with `dcoRequired`; no `Signed-off-by` trailer or agreement call is ever produced (ACC-09-08). Run:
      `pnpm --filter @ever-works/agent test upstream-signature`.
      **Done when**: the spec is green.

- [ ] **T28. Agent suggestions.**
      **Modify** `packages/agent/src/agents/agent-tool.service.ts` — add `suggestUpstreamContribution({ reason ≤ 300 })`,
      offered only on fork App Works with proposals on; it **records the suggestion server-side** (a
      `upstream_pr_suggestions` row, §3.1B, G20) and the label `upstream-candidate` is display only.
      **Modify** `packages/agent/src/safety/action-category.ts` — append
      `suggestUpstreamContribution: 'write.internal'` to `ENTRY_POINT_CATEGORY` (`action-category.ts:49`), so the tool
      is not unclassified, and extend `entry-point-coverage.spec.ts` (G22).
      **Create** `packages/agent/src/upstream-pull-requests/upstream-suggestion.service.ts` (new) — on APW-08's
      `app.change.live`, for a Task with a **recorded** suggestion marker (the `upstream_pr_suggestions` row the tool
      call created, §3.1B): Inbox suggestion, `sentAt` stamped when the notice goes out (≤ 1 per Task, ≤ 3 per App
      Work per 7 days, counted from `sentAt` — **not** from the Task label, which a person can add by hand, G18);
      dismiss via `POST …/suggestions/:taskId/dismiss`, which writes `dismissedAt` so the Task is never suggested
      again.
      **Test**: `upr/upstream-suggestion.service.spec.ts` (new) — nothing prepared until **Propose**; the per-Task and
      7-day limits hold across a restart (the rows, not an in-memory counter); a dismissed Task is not suggested
      again; a hand-added `upstream-candidate` label with no recorded suggestion sends nothing (ACC-09-21, 40);
      `packages/agent/src/agents/__tests__/agent-tool-upstream-suggestion.spec.ts` (new) — the tool is offered only on
      fork App Works with proposals on and only records a suggestion. Run:
      `pnpm --filter @ever-works/agent test upstream-suggestion agent-tool-upstream-suggestion`.
      **Done when**: both specs are green.

- [ ] **T29. P3 e2e and gate.**
      **Modify** `apps/web/e2e/app-works-propose-upstream.spec.ts` — add **Address review** and a suggestion.
      **Test**: `cd apps/web && pnpm exec playwright test app-works-propose-upstream` and the root gate.
      **Done when**: both are green and ACC-09-18, ACC-09-21 are walked; P3 ticked.

---

# Cross-phase closing tasks

- [ ] **T30. Telemetry.**
      **Create** `packages/monitoring/src/posthog/upstream-pr-events.ts` (new, modelled on `kb-events.ts`) — plan §9.1.
      **Modify** `packages/monitoring/src/posthog/index.ts` — export it.
      **Create** `packages/agent/src/upstream-pull-requests/upstream-pr-telemetry.port.ts` (new) — an injectable
      `UPSTREAM_PR_TELEMETRY` interface + `Symbol()` token in `packages/agent` (`emit(event, payload)`), because
      `@ever-works/agent` does **not** depend on `@ever-works/monitoring` (its dependencies are
      `@ever-works/agent-plugins`, `@ever-works/contracts`, `@ever-works/plugin` and third-party packages —
      `packages/agent/package.json`), so T15–T18 cannot import the emitter (G21). The services of T15–T18 take the
      port by injection and **no-op when it is not bound**, which is the in-repo precedent
      (`knowledge-base-reconcile.service.ts:61-106` injects its client rather than reaching for a package);
      `apps/api` binds it to `emitUpstreamPrEvent` in the module that provides this epic's services.
      **Test**: `packages/monitoring/src/posthog/__tests__/upstream-pr-events.spec.ts` (new) — every event forwards its
      payload; a payload with `title`, `body`, `diff`, `login`, `owner`, `repo` or `repository` is **stripped**, and
      the strip is asserted in all three modes: `NODE_ENV=test` fails loudly, dev warns and strips, production strips
      silently — exactly `kb-events.ts:205-235`'s `scrubPayload` behaviour, whose docstring says a runtime throw in
      production is too much surface for how many call sites it serves (T30's earlier "throws" wording described no
      shipped behaviour — G21); and `upr/upstream-pr-telemetry.spec.ts` (new) — a service with no port bound emits
      nothing and does not throw (ACC-09-23, telemetry half). Run:
      `pnpm --filter @ever-works/monitoring test upstream-pr-events` and
      `pnpm --filter @ever-works/agent test upstream-pr-telemetry`.
      **Done when**: both specs are green.

- [ ] **T31. Structural guarantees.**
      **Create** `packages/agent/src/upstream-pull-requests/__tests__/no-merge-no-comment.spec.ts` (new) — scans the
      folder's sources for `mergePullRequest`, `closePullRequest`, `createPullRequestComment` and for any token
      resolution other than `getMemberAccountToken`; fails on a match. It also asserts the two structural rules this
      epic's audit added: every `app.upstream_pr.*` event the sources write is in plan §3.4's status table (so none
      ships without an `ActivityStatus`), and no source in the folder routes finalize by a Task label.
      **Test**: `pnpm --filter @ever-works/agent test no-merge-no-comment` — green, and red when a
      `mergePullRequest` reference is added to any file in the folder (ACC-09-19, 14).
      **Done when**: both outcomes are observed and the red run's output is pasted into the PR description.

- [ ] **T32. Docs.**
      **Create** `docs/features/app-works-upstream-pull-requests.md` (behaviour, limits, signatures, disclosure, the
      publishing setting). **Modify** `apps/docs/sidebarsPlatform.ts` (list it),
      `docs/features/approvals-and-escalations.md` (the new approval type is executed on approval, author-only, never
      in approve-all), `docs/specs/features/app-works/TRACKER.md`.
      **Test**: `pnpm --filter ever-works-docs build`.
      **Done when**: the docs build has no broken-link warning for the new page.

- [ ] **T33. Statuses.**
      **Modify** `spec.md`, `plan.md` and this file — status `Implemented`.
      **Test**: re-read every gate in plan §12 against the merged code.
      **Done when**: every checklist item still holds and the known gaps are still recorded.

- [ ] **T34. Holds, the 90-minute deadline's storage and its sweep (added 2026-09-17, Resolution R-17; extended
      2026-09-17 by G14).**
      **Modify** `packages/agent/src/upstream-pull-requests/upstream-preparation.service.ts`,
      `packages/agent/src/upstream-pull-requests/upstream-preparation.holds.ts` _(new)_ and
      `packages/agent/src/upstream-pull-requests/upstream-status.service.ts` — the 90-minute preparation deadline
      counts running time only, using APW-08's `classifyAppWorkRunStop` (APW-08 T46): a `wait` pauses the clock by
      stamping `preparationHeldSince` and keeps the row `preparing`; the release adds `now − preparationHeldSince` to
      `preparationPausedMs` and clears it; a `needs_input` stop keeps the row `preparing` with the clock paused and
      the Task `BLOCKED`. `preparationStartedAt` is set when the run is dispatched (T15). The status job selects
      `state='preparing'` rows through `idx_upr_preparing_started` (T7) and fails one that has spent
      `UPSTREAM_TIMEOUTS.preparationMs` of running time with `timedOut` + Activity `.failed` — a parked row is never
      selected as overrun and never timed out (plan §7, ACC-09-38).
      **Test**: `upr/upstream-preparation.holds.spec.ts` (new) — a run parked for 3 hours is not `timedOut`; a `ladder`
      refusal leaves the row `preparing` and opens nothing upstream; a released hold resumes the clock;
      `upstream-status.service.spec.ts` gains the sweep cases: a `preparing` row at 90 running minutes fails, one at
      89 does not, and one held at 200 wall-clock minutes does not. Run:
      `pnpm --filter @ever-works/agent test upstream-preparation.holds upstream-status`.
      **Done when**: the specs are green.

- [ ] **T35 (P1, lands with T7). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain:
      `{ file: 'upstream-pull-requests.jsonl', entity: 'UpstreamPullRequest', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`,
      `{ file: 'upstream-pr-suggestions.jsonl', entity: 'UpstreamPrSuggestion', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`
      and
      `{ file: 'work-upstream-pr-settings.jsonl', entity: 'WorkUpstreamPrSetting', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`
      (the two tables G07 and G20 add — every table an App Works epic adds is classified in the same PR, R-25).
      `packages/agent/src/account-transfer/backup/redaction.ts` is **not** modified: title and body are public by
      design, `refusalDetail` never holds a token ([plan §3.1](./plan.md)), the setting row holds a branch name and a
      pull request number, and the suggestion row holds the Agent's reason — no column has a secret-shaped name.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` —
      `UpstreamPullRequest`, `UpstreamPrSuggestion` and `WorkUpstreamPrSetting` are each referenced exactly once, in
      `works`, scoped `parent` on `workId` from `workIds`, not dropped; each planned query carries
      `within: { column: 'workId', ids }` with the registered Work ids.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green and a backup of a workspace
      with one upstream pull request lists `data/works/upstream-pull-requests.jsonl` with one record.

---

- [ ] **T36 (P2). Inbox notices carry actions and reach their review (added 2026-09-17, G12/FR-36, plan §8.2).**
      **Modify** `packages/agent/src/inbox/inbox-producer.port.ts` — append to `InboxNoticeInput`, additively and
      without changing any existing field (`inbox-producer.port.ts:79-101` today carries title, body, agentId,
      agentRunId, taskId, workId, organizationId, notify only): `messageKey?: string`,
      `params?: Record<string, string>`, and
      `actions?: { id: string; labelKey: string; href?: string; apiAction?: { path: string; body?: Record<string, unknown> } }[]`
      (≤ 2; `href` is `https` only). Every existing producer is unaffected — an input without the new fields behaves
      exactly as today.
      **Modify** `packages/agent/src/inbox/inbox.service.ts` — persist and return the new fields with the notice.
      **Modify** `packages/agent/src/agent-approvals/agent-approvals.service.ts` — the Inbox mirror sends
      `payload.workId` and `payload.upstreamPullRequestId` for `actionType === 'upstream_pull_request'`, derived by
      the platform exactly as `taskId` already is for `merge_pull_request` (`:233-240`).
      **Modify** `apps/web/src/components/inbox/InboxDecisionDetail.tsx`, `apps/web/src/lib/api/inbox.ts` — render the
      actions (`href` as an external link, `apiAction` as a POST + revalidate) and resolve `messageKey` through
      `dashboard.inbox.upstream.*`.
      **Modify** `packages/agent/src/upstream-pull-requests/upstream-status.service.ts` and
      `upstream-suggestion.service.ts` — the review, signature and suggestion notices use `messageKey` + `actions`
      instead of stored English text (S6, S9, S17), and the approval item links to
      `/works/:id/upstream?review=<prId>`.
      **Test**: `packages/agent/src/inbox/__tests__/inbox-notice-actions.spec.ts` (new) — an input without the new
      fields is byte-identical to today; actions are capped at 2 and a non-`https` `href` is refused; the four notice
      kinds carry their `messageKey` and the right actions; extend `upr/upstream-status.service.spec.ts` — the
      signature notice carries **Open the agreement** (`href` = the report's `claUrl`, now stored on the row, T7) and
      **I've signed it — continue** (`apiAction` to `…/signed`); extend
      `apps/web/src/components/inbox/InboxDecisionsClient.unit.spec.tsx` — the actions render and the approval item
      links to the review route (ACC-09-18, 21, 23). Run:
      `pnpm --filter @ever-works/agent test inbox-notice-actions upstream-status` and
      `pnpm --filter ever-works-web test InboxDecisionsClient`.
      **Done when**: the specs are green and every existing Inbox producer's spec passes unchanged.

- [ ] **T37 (P2). The preparation report contract, FR-12's enforcer and the workspace report vehicle (added
      2026-09-17, G04/FR-47, plan §3.3, §4).**
      **Modify** `packages/contracts/src/apps/upstream-pull-request.types.ts` — `UpstreamPreparationReport` as plan
      §3.3 (status union, `claUrl` ≤ 512, `projectLimitLines`, title ≤ 72, body ≤ 8,000, `aiPolicyQuote` ≤ 300,
      `aiPolicyFile`, `doesNotPort` ≤ 10, `checks` ≤ 10 with `startedAt`/`endedAt`/`exitCode`/`alreadyRedOnBase`/
      `lastLines`), plus its AJV schema and the validator that returns a typed refusal.
      **Modify** `packages/plugin/src/contracts/capabilities/workspace.interface.ts` —
      `WorkspaceFinalizeOptions.reportFiles?: string[]` and
      `WorkspaceFinalizeResult.reports?: { path: string; content: string }[]` (plan §4), and implement both in
      `packages/plugins/sandbox-workspace/src/` and `packages/plugins/local-workspace/src/`: read each listed
      workspace-relative file (≤ 5 paths, ≤ `UPSTREAM_TEXT.reportMaxBytes` each) **and drop it from the tree before the
      squash commit**, so the report can neither reach the prepared branch nor the pull request.
      **Modify** `packages/agent/src/facades/workspace.facade.ts` — pass the option through.
      **Modify** `packages/agent/src/upstream-pull-requests/upstream-preparation.service.ts` — the brief names
      `.ever-works/upstream-pr-report.json` as the only report vehicle, `onPreparationFinalized` validates it with the
      T16 validator, refuses `reportInvalid` when it is absent, oversized or malformed, and stores `claUrl`,
      `missingPieces`, `title`, `body` and `checkResults` (with `source: 'agent'`) from it. The report is **never**
      inferred from the run's prose.
      **Modify** `docs/specs/features/app-works/APW-09-upstream-pull-requests/skill-draft/SKILL.md` — step 8 names the
      file, the exact schema, the caps and the FR-12 bounds; a Skill body that reports in prose fails T16's validation.
      **Test**: extend `upr/upstream-preparation.verifier.spec.ts` — a valid report parses; missing, 33 KB, invalid JSON,
      an unknown `status`, 11 checks, a 31-minute check, an 81-minute total, a 51-line tail and 11 missing pieces are
      each refused `reportInvalid`/bounded as plan §3.3 states; extend
      `packages/plugins/sandbox-workspace/src/__tests__/sandbox-workspace.squash.spec.ts` and the local twin — a
      report file listed in `reportFiles` comes back in `reports` and is **absent from the commit** (ACC-09-39). Run:
      `pnpm --filter @ever-works/agent test upstream-preparation.verifier` and
      `pnpm --filter @ever-works/sandbox-workspace-plugin test squash`.
      **Done when**: the specs are green and a finalize with no `reportFiles` behaves exactly as today.

- [ ] **T38 (P2). Human-only approval and signature routes (added 2026-09-17, XC-07; plan §5).**
      **Modify** `apps/api/src/agent-approvals/agent-approvals.controller.ts` (or the controller that owns
      `POST /api/agent-approvals/:id/approve|reject`) and
      `apps/api/src/works/upstream-pull-requests.controller.ts` — apply `@HumanOnly()`
      (`apps/api/src/safety/decorators/human-only.decorator.ts`) to the approve and reject handlers and to
      `POST …/:prId/signed`, and register `HumanActorGuard` where those controllers are declared so the decorator is
      enforced. Publishing under a member's name and declaring that a signature exists are the two acts no API key, MCP
      tool, chat tool, schedule or Fleet run may perform (FR-21).
      **Modify** `apps/mcp/src/openapi-tools/whitelist.ts` — neither route appears (see T40's parity table).
      **Test**: extend `apps/api/src/safety/guards/human-actor.guard.spec.ts` — an `authMethod: 'api-key'` request gets
      `403` and a `rail_refusals` row with reason `non-human-actor`; extend
      `apps/api/src/works/upstream-pull-requests.controller.spec.ts` and the approvals controller spec — the same two
      routes succeed in a session and refuse an API key, with **no** state change and no provider call on the refusal
      (ACC-09-35). Run: `cd apps/api && pnpm test human-actor upstream-pull-requests.controller agent-approvals`.
      **Done when**: the specs are green and every pre-existing `@HumanOnly()` route's spec passes unchanged.

- [ ] **T39 (P2). The operator kill switch and the operator deny list (added 2026-09-17, XC-10/XC-22, FR-41/FR-46).**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-operator-policy.ts` (new) — reads
      **`EVER_WORKS_APP_UPSTREAM_PRS_ENABLED`** (resolution R-30's binding name; the binding default is **`true`** —
      the family runs unless an operator turns it off, CONTRACTS §7) and the deny list, and exposes `isPaused()` /
      `isDenied(owner, repo)`.
      **Modify** `upstream-preparation.service.ts`, `upstream-open.service.ts`, `upstream-status.service.ts`,
      `upstream-suggestion.service.ts`, the two dispatchers and `packages/tasks/src/tasks/trigger/upstream-pr-status.task.ts`
      — each reads the switch **itself** before doing any work and fails closed (no preparation row, no open, no push,
      no poll, no suggestion); the deny list refuses at eligibility and again immediately before opening. Neither
      switch withdraws, closes or deletes anything already upstream (FR-46), and the tab shows
      **"Upstream pull requests are paused by the platform."** (T21).
      **Modify** `apps/api/src/works/upstream-pull-requests.controller.ts` — `GET …/eligibility` reports the pause so
      the toggle can render it; the deny list is read-only to members (an operator route is APW-10's, this epic only
      consumes it).
      **Test**: `upr/upstream-operator-policy.spec.ts` (new) — the switch defaults off in production, every dispatcher
      refuses with it off and performs **zero** provider calls, and turning it back on resumes with no row rewritten;
      `upstream-eligibility.service.spec.ts` gains `deniedUpstream`; the controller spec gains the paused eligibility
      shape (ACC-09-29, 34). Run: `pnpm --filter @ever-works/agent test upstream-operator-policy upstream-eligibility`.
      **Done when**: the specs are green and the switch is read at the dispatcher, not only at the endpoint.

- [ ] **T40 (P2). MCP, CLI and chat parity (added 2026-09-17, XC-23; plan §5's parity table).**
      **Modify** `apps/mcp/src/openapi-tools/whitelist.ts` — add `list_upstream_pull_requests`,
      `check_upstream_eligibility`, `get_upstream_pull_request`, `check_upstream_pull_request_now` with read hints and
      `withdraw_upstream_pull_request` with the destructive hint and its confirmation argument. The five
      human-only/deliberate routes (propose, acknowledge-extra-files, signed, address-review, the approval decision)
      stay out, as plan §5 records.
      **Create** `apps/cli/src/commands/work/upstream.command.ts` (new, registered in that folder's `index.ts`) —
      `work upstream list|show|eligibility|check|withdraw|address-review`, matching the table.
      **Modify** `apps/web/src/lib/ai/tools/generated/registry.ts` — the three read-only chat tools
      (`list_upstream_pull_requests`, `check_upstream_eligibility`, `get_upstream_pull_request`), plus
      `check_upstream_pull_request_now` and `dismiss_upstream_suggestion`.
      **Modify** every route in `apps/api/src/works/upstream-pull-requests.controller.ts` — `@ApiOperation` +
      `@ApiResponse` so the OpenAPI document carries them (the whitelist is generated from it).
      **Test**: `apps/mcp/src/openapi-tools/__tests__/upstream-parity.spec.ts` (new) — every route in plan §5's table has
      either a whitelist entry with the stated hint or a recorded not-exposed reason, and the spec fails when a route is
      added without a row; `apps/cli/src/commands/work/__tests__/upstream.command.spec.ts` (new) — the commands exist and
      hit the stated paths; the registry spec asserts the chat tools' read-only scopes (ACC-09-36). Run:
      `pnpm --filter @ever-works/mcp test upstream-parity` and `pnpm --filter ever-works-cli test upstream.command`.
      **Done when**: the specs are green and the generated OpenAPI document lists every route of §5.

- [ ] **T41 (P2). Keyboard and accessibility lane (added 2026-09-17, XC-25/FR-42; plan §8.3).**
      **Modify** `apps/web/e2e/app-works-upstream-tab.spec.ts`, `app-works-propose-upstream.spec.ts` and
      `app-works-upstream-refusals.spec.ts` — an axe scan per surface (toggle, list, chips, dialog, approval, refusals)
      asserting **no new violations** against a recorded baseline; keyboard-only operation of the toggle, dialog,
      approval tick, **Review**, **Check now** and **Withdraw** with a visible focus ring; `Esc` closing the dialog and
      focus returning to the opening control; a polite live region announcing **Preparing**, **Opening**, a new review
      and a refusal; and an `ar` and `he` render with no clipped chip or mirrored control.
      **Modify** the components of plan §8 — the pieces the scan finds (labels, `aria-*`, focus management, the live
      region) — without changing any copy or behaviour.
      **Test**: `cd apps/web && pnpm exec playwright test app-works-upstream-tab app-works-propose-upstream app-works-upstream-refusals`
      with the a11y assertions enabled, plus `pnpm --filter ever-works-web test Upstream` for the unit-level focus
      behaviour (ACC-09-30). Run in the same lane as T24.
      **Done when**: the three specs pass with the axe checks on and the recorded baseline is committed.

- [ ] **T42 (P2). Account and organization deletion stops tracking (added 2026-09-17, XC-14/FR-45).**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-deletion.handler.ts` (new) —
      `stopTrackingForUser(userId)` / `stopTrackingForOrganization(organizationId)`: every row of that member (or of
      every App Work the organization owns) goes terminal, `nextCheckAt` is cleared, in-flight open/push dispatches are
      cancelled, fork branches this epic created are deleted within `UPSTREAM_TIMEOUTS.deletionCascadeMs`, and no
      further provider call uses that account. Nothing upstream is edited, closed or deleted (FR-32).
      **Modify** APW-01's `APP_WORKS_ACCOUNT_DELETION` handler registration (the handler itself is APW-01's, per
      CONTRACTS) to call it — this task adds the APW-09 side only, and if APW-01 has not landed the port yet, this task
      adds the consumer binding behind the existing `UserAccountDeletionEvent` (`apps/api/src/events/index.ts:128`).
      **Test**: `upr/upstream-deletion.handler.spec.ts` (new) — after the handler, no poll is scheduled, the two
      dispatchers are cancelled, the branches are deleted within the bound, the account's token is never used again,
      and **no** `mergePullRequest` / `closePullRequest` / `createPullRequestComment` call is made; the status job's
      due-row selection returns none of that member's rows (ACC-09-31). Run:
      `pnpm --filter @ever-works/agent test upstream-deletion`.
      **Done when**: the spec is green and APW-01's cascade spec passes with this handler registered.

- [ ] **T43 (P2). The credential of record and its handover (added 2026-09-17, XC-18/FR-43).**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-credential.service.ts` (new) — reads and records
      the App Work's **credential of record** (the member who created it, whose connection performed the fork, D2 /
      APW-01 FR-15), answers `resolveForBackgroundJob(workId)` and reports the paused reason when it is unusable
      (member left the organization, lost access, disconnected, or the scope was withdrawn). The record is APW-02's
      upstream state where it already carries one; this epic adds only the read and the pause.
      **Modify** the background jobs of §7 and APW-05's build polling callers — they resolve through this service
      instead of a Work-resolved token, and when it reports unusable they pause with the named reason instead of
      failing, writing Activity `app.upstream_pr.refused`-free notes (no state change) and no upstream call.
      **Modify** `apps/api/src/works/upstream-pull-requests.controller.ts` — expose the pause state on the tab's read,
      and the handover action (`POST /api/works/:id/upstream/credential/handover`, edit access required) that makes the
      caller's own connection the credential of record for work not yet started.
      **Modify** `apps/web/src/components/works/detail/upstream/UpstreamPullRequestsSection.tsx` — the
      **"Waiting for {member} to reconnect GitHub."** banner with the handover action (plan §6.1's copy table).
      **Test**: `upr/upstream-credential.service.spec.ts` (new) — the recorded member is the fork's creator; an
      unusable credential pauses the jobs with the reason and makes no provider call; a handover changes the credential
      for work not yet started and re-authors nothing already opened; the preparation and push paths still use the
      publishing member's own token (FR-24), never the credential of record (ACC-09-32). Run:
      `pnpm --filter @ever-works/agent test upstream-credential`.
      **Done when**: the spec is green.

- [ ] **T44 (P2). Contribution runs booked against the App Work's budget (added 2026-09-17, XC-19/FR-44).**
      **Modify** `packages/agent/src/upstream-pull-requests/upstream-preparation.service.ts` and
      `upstream-review-follow-up.service.ts` — every run this epic dispatches goes through the platform's
      `BudgetGuardService` against the App Work's own `WorkBudget` (`packages/agent/src/budgets/budget-guard.service.ts`,
      `packages/agent/src/entities/work-budget.entity.ts`) before the run is dispatched, exactly as the evolve loop's
      runs do. A budget refusal is a **wait**: the row keeps its state, nothing is opened or pushed, the member sees
      the reset time, and the run resumes when the budget allows. The existing per-feature caps (FR-26, APW-08's
      per-Mission cap) keep applying unchanged — the budget is an additional bound.
      **Modify** `apps/api/src/works/upstream-pull-requests.controller.ts` — the write routes surface the wait as
      `202 { state, waiting: 'budget', resetAt }` rather than a `422`, and `GET …/:prId` carries it.
      **Test**: `upr/upstream-budget.spec.ts` (new) — a preparation over the cap dispatches no run, opens nothing and
      reports the reset time; the same Work's other counters are untouched; the alert fires at the Work's threshold;
      and a run under the cap dispatches exactly once (ACC-09-33). Run:
      `pnpm --filter @ever-works/agent test upstream-budget`.
      **Done when**: the spec is green and the budget guard's own spec passes unchanged.

- [ ] **T45 (P2). The fake GitHub's upstream endpoints and the PR-lane seed (added 2026-09-17, G05/ACC-09-37).**
      **Modify** APW-13's fake (`apps/web/e2e/fakes/github-fake/`, APW-13 plan §8.3) — add the REST subset this epic
      calls and nothing else: `POST /repos/:o/:r/git/refs`, `PATCH|DELETE /repos/:o/:r/git/refs/heads/*`,
      `GET /repos/:o/:r/interaction-limits`, `GET /repos/:o/:r/pulls/:n`, `GET /repos/:o/:r/pulls/:n/reviews`,
      `GET /repos/:o/:r/pulls/:n/comments`, `GET /repos/:o/:r/commits/:ref/check-runs`,
      `GET /repos/:o/:r/commits/:ref/status`, and `GET /repos/:o/:r/commits/:ref/statuses`; extend
      `GET /repos/:o/:r/compare/:basehead` to answer `total_commits` (T1); extend the control API
      (`POST /_control/seed`) to seed `upstream_pull_requests` rows and a matching approval proposal. Every seed route
      is honoured **only** when `EVER_WORKS_E2E_FAKES=1` and `NODE_ENV !== 'production'`, exactly like the fake's API
      base switch (APW-13 plan §8.3), and the fake records every call for the "zero writes" assertions.
      **Test**: the fake's contract test replays the newly recorded real responses (APW-13 §8.3's existing pattern);
      `apps/web/e2e/app-works-propose-upstream.spec.ts` (T24) completes a preparation to `awaiting_approval` against
      the fake with **no** call leaving it, which is what ACC-NEG-06's "an `awaiting_approval` proposal seeded"
      precondition needs and what no epic defined until now (ACC-09-37). Run:
      `cd apps/web && EVER_WORKS_E2E_FAKES=1 pnpm exec playwright test app-works-propose-upstream`.
      **Done when**: the spec passes against the fake and the fake's contract test is green.

- [ ] **T46 (P2–P3 ship gate extension). Walk the new acceptance ids.**
      **Modify** `docs/specs/features/app-works/TRACKER.md` (APW-09 notes) and this file's P2/P3 checkboxes — including
      ACC-09-24…ACC-09-40, which are the audit additions of 2026-09-17.
      **Test**: root `pnpm format:check && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      **Done when**: the commands are green and ACC-09-24…ACC-09-40 are walked (each one either passes or names the
      blocker in the epic's known-gaps list — never silently skipped).

---

## Definition of Done

- Every checkbox is ticked; root `format:check`, `lint`, `type-check`, `test`, `build` green.
- T31's structural spec is green: no code path in this epic merges, closes or comments upstream, or uses any token but
  the member's.
- ACC-09-01…ACC-09-23 walked against a throwaway upstream repository the team owns — never a third-party project.
- The known gaps in plan §12 are still recorded.
