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
      `GitPullRequestStatus`.
      **Modify** `packages/plugins/github/src/github-api.service.ts` — `createPullRequest` composes `head` as
      `{headOwner}:{head}` when `headOwner` is set, sends `maintainer_can_modify` when defined, sends `head_repo` only
      when `headRepo` differs from the head owner's fork name; `createPullRequest`, `getPullRequest`,
      `listPullRequests`, `getPullRequestStatus` map `head.repo?.full_name ?? null`.
      **Test**: `packages/plugins/github/src/__tests__/github-api.service.cross-repo.spec.ts` (new) — composition,
      omission (a call without the new fields sends exactly today's request), mapping on all four reads, deleted head
      repository → `null` (ACC-09-14, provider half). Run: `pnpm --filter @ever-works/github-plugin test cross-repo`.
      **Done when**: the new spec is green and the existing `github-api.service.pr-insights.spec.ts` and
      `github-api.service.merge.spec.ts` pass unchanged.

- [ ] **T2 (parallel with T1). Reviews, review comments, interaction limits.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — `GitPullRequestReview`,
      `GitPullRequestReviewComment`, `listPullRequestReviews?`, `listPullRequestReviewComments?`,
      `getInteractionLimit?` (plan §4).
      **Modify** `packages/plugins/github/src/github-api.service.ts` and `packages/plugins/github/src/github.plugin.ts`
      — implement with `pulls.listReviews` (≤ 100, body ≤ 8 KB), `pulls.listReviewComments` (≤ 100, body ≤ 4 KB),
      `interactions.getRestrictionsForRepo` (404/empty → `'none'`).
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.service.cross-repo.spec.ts` — caps and
      truncation, the four interaction-limit values, 404 → `'none'`. Run: `pnpm --filter @ever-works/github-plugin test cross-repo`.
      **Done when**: the spec is green.

- [ ] **T3 (parallel with T1). Branch at a commit; fast-forward a branch.**
      **Modify** `packages/plugin/src/contracts/capabilities/git-provider.interface.ts` — `createBranchFromSha?`,
      `updateBranchRef?`.
      **Modify** `packages/plugins/github/src/github-api.service.ts` —
      `git.createRef({ ref: 'refs/heads/{name}', sha })`; `git.updateRef({ ref: 'heads/{name}', sha, force: false })`
      (422 not-fast-forward → typed `BranchNotFastForwardError`).
      **Test**: extend `packages/plugins/github/src/__tests__/github-api.service.cross-repo.spec.ts` — non-fast-forward
      is surfaced as the typed error, never retried with `force`.
      **Done when**: the spec is green.

- [ ] **T4. Facade pass-throughs and the member token.**
      **Modify** `packages/agent/src/facades/git.facade.ts` — pass-throughs for T1–T3 (absent method →
      `GitFacadeError('providerUnsupported')`, reads → `null`); **add**
      `getMemberAccountToken({ userId, providerId })` that resolves only `findUsableGitProviderAccount` then
      `getPatFromSettings(providerId, userId, undefined)`, and never accepts a `workId`.
      **Test**: `packages/agent/src/facades/__tests__/git.facade.member-token.spec.ts` (new) — spies prove
      `tryResolveEverWorksGitPlatformToken` and `getInstallationTokenForWork` are never called; no account + no PAT →
      `null` (ACC-09-14, token half). Run: `pnpm --filter @ever-works/agent test git.facade`.
      **Done when**: the new spec and the existing `git.facade.spec.ts` are green.

- [ ] **T5. Spike: a fork branch at an upstream-only commit.**
      **Modify** `docs/specs/features/app-works/APW-09-upstream-pull-requests/plan.md` §9.2 — record the outcome.
      Against a throwaway upstream repository and a fork both owned by the team: create a commit on the upstream
      default branch that the fork does not have; call `createBranchFromSha(fork, 'upstream-pr/spike', sha)` with the
      fork owner's token.
      **Test**: manual, run once against the throwaway pair; the provider response (status and message) is pasted into
      the PR description.
      **Done when**: the result (works / fails with the provider message) is recorded in plan §9.2; if it fails, a task
      is appended here to use APW-02's `syncForkBranch?` onto a mirror branch before P2 starts.

## P1.2 — Record and shared types

- [ ] **T6. Contracts and Activity family.**
      **Create** `packages/contracts/src/apps/upstream-pull-request.types.ts` (new) exactly as plan §3.3 (Resolution
      R-1 — the one shared types folder).
      **Modify** `packages/contracts/src/apps/index.ts` (created by APW-03 T1; if APW-03 has not landed, create it and
      add `export * from './apps/index.js';` to `packages/contracts/src/index.ts` exactly as APW-03 T1 specifies) —
      `export * from './upstream-pull-request.types.js';`.
      **Modify** `packages/agent/src/entities/activity-log.types.ts` — append `APP_UPSTREAM_PR = 'app_upstream_pr'`
      (Resolution R-2; the dotted `app.upstream_pr.*` event goes in `action`).
      **Test**: `packages/contracts/src/apps/__tests__/upstream-pull-request.types.spec.ts` (new) — pins every union and
      every number; extend `packages/agent/src/entities/__tests__/activity-log.types.spec.ts` with
      `['APP_UPSTREAM_PR', 'app_upstream_pr']`. Run: `pnpm --filter @ever-works/contracts test` and
      `pnpm --filter @ever-works/agent test activity-log.types`.
      **Done when**: both specs are green and `pnpm --filter @ever-works/contracts build` emits the declarations.

- [ ] **T7. Entity + migration.**
      **Create** `packages/agent/src/entities/upstream-pull-request.entity.ts` (new) per plan §3.1 (dates via
      `PortableDateColumn`, scope columns without relations, `@ManyToOne` to `User` and `Work` with
      `onDelete: 'CASCADE'`).
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts`.
      **Create** `apps/api/src/migrations/1792090000000-CreateUpstreamPullRequests.ts` (new) — table, four indexes
      (partial unique on both engines), `down()` drops only these.
      **Create** `packages/agent/src/database/repositories/upstream-pull-request.repository.ts` (new) — scoped finders,
      CAS state update `updateStateIf(id, userId, from, to, patch)`, limit-window counts, due-row selection.
      **Test**: `packages/agent/src/entities/__tests__/upstream-pull-request.entity.spec.ts` (new) — index names and
      scope columns; `apps/api/src/migrations/__tests__/CreateUpstreamPullRequests.spec.ts` (new) — re-runnable;
      `packages/agent/src/database/repositories/__tests__/upstream-pull-request.repository.spec.ts` (new) — a second
      active row for one source Task fails, a closed one does not. Run:
      `pnpm --filter @ever-works/agent test upstream-pull-request` and `cd apps/api && pnpm test CreateUpstreamPullRequests`.
      **Done when**: the specs are green and the drift checks in `packages/agent/src/database/database.module.spec.ts`
      pass.

## P1.3 — Eligibility

- [ ] **T8. Pure rules and limits.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-eligibility.rules.ts`,
      `packages/agent/src/upstream-pull-requests/upstream-rate-limits.ts`,
      `packages/agent/src/upstream-pull-requests/summarize-upstream-checks.ts`,
      `packages/agent/src/upstream-pull-requests/upstream-fingerprint.ts` (new).
      **Test**: `upr/upstream-eligibility.rules.spec.ts`, `upr/upstream-rate-limits.spec.ts`,
      `upr/summarize-upstream-checks.spec.ts`, `upr/upstream-fingerprint.spec.ts` (new) — every branch in plan §10.1,
      including 24-hour windows at `23:59:59` and `24:00:01` (ACC-09-02, 12, 15, 17). Run:
      `pnpm --filter @ever-works/agent test upstream-pull-requests`.
      **Done when**: the four specs are green.

- [ ] **T9. `UpstreamEligibilityService`.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-eligibility.service.ts` and
      `packages/agent/src/upstream-pull-requests/upstream-pull-requests.module.ts` (new) — reads APW-01
      `sourceRepository.type/upstream`, APW-03 App spec `upstreamPullRequests.enabled`, APW-08 delivery state (merged or
      later), APW-02 `getRepository` (`archived`, `source`), `getInteractionLimit`
      (`collaborators_only`/`contributors_only` → `collaboratorsOnly`), fork push permission and token scope via T4.
      **Modify** `apps/api/src/api.module.ts` — import `UpstreamPullRequestsModule`.
      **Test**: `upr/upstream-eligibility.service.spec.ts` (new) — each refusal code, and that the member token (never a
      Work-resolved token) is used for every read (ACC-09-02, 03). Run:
      `pnpm --filter @ever-works/agent test upstream-eligibility`.
      **Done when**: the spec is green.

- [ ] **T10. Read-only API.**
      **Create** `apps/api/src/works/upstream-pull-requests.controller.ts` (new) with
      `GET /api/works/:id/upstream-pull-requests` and `GET …/eligibility`; **create**
      `apps/api/src/works/dto/upstream-pull-request.dto.ts` (new); **modify** `apps/api/src/works/works.module.ts`.
      **Test**: `apps/api/src/works/upstream-pull-requests.controller.spec.ts` (new) — shapes, 404s for another
      account's ids, throttles (ACC-09-03, 23). Run: `cd apps/api && pnpm test upstream-pull-requests.controller`.
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
      `start(userId, workId, { taskId, maintainerCanModify })`: eligibility → row (`preparing`, unique active index) →
      branch name `upstream-pr/{slug≤40}-{4 hex}` → `createBranchFromSha` at the upstream default-branch head →
      preparation Task (title `Prepare upstream pull request: {source title}`, labels `upstream-pr:<id>`, `branchRef`
      preset, the source PR diff (≤ 256 KB) and upstream guide files (each ≤ 64 KB) attached to the brief as fenced
      untrusted content) → `dispatchAgentRun` (APW-08 isolated admission; Fleet refused) → returns `202`.
      **Modify** `packages/agent/src/tasks-domain/task-workspace.service.ts` — `finalizeRun`: for `upstream-pr:*`
      labels call `onPreparationFinalized` with `squashOnto: task.baseSha` and the member identity; skip
      `simulateMerge` and `openPullRequestForBranch`. `finalizeRemotePush`: refuse the label.
      **Test**: `upr/upstream-preparation.service.spec.ts` (new) — double start → one row (S27); Fleet refusal; the Task
      branch is the prepared branch cut from the upstream head; no same-repository PR is ever opened for the label
      (ACC-09-04). Run: `pnpm --filter @ever-works/agent test upstream-preparation`.
      **Done when**: the spec is green and `task-workspace.service.spec.ts` passes unchanged.

- [ ] **T16. Verifier.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-preparation.verifier.ts` (new) — `getCompareDiff`
      over `upstreamOwner/upstreamRepo`, `baseBranch...{forkOwner}:{headBranch}` with `{ maxFiles: 300 }`; refusals
      `excludedPath` (plan §3.3 globs + App spec protected paths, path and `previousPath`), `tooManyExtraFiles`,
      `tooLarge` (1,000 lines / 30 files or the project's smaller stated limit reported by the run),
      `secretDetected` (`assertNoSecrets` over patch, title and body), `notSingleCommit`, `checksRed` (unless
      `alreadyRedOnBase`), flags `aiNotAccepted` / `dcoRequired` / CLA; builds title (≤ 72), body (≤ 8,000) with the
      disclosure line last.
      **Test**: `upr/upstream-preparation.verifier.spec.ts` (new) — the fixture "fork with 40 unrelated commits" yields a
      diff with only the source files; every exclusion incl. renames; the 1,240-line and 300-line-limit refusals;
      `aiNotAccepted`; template filled with the disclosure last and no Ever Works link (ACC-09-05, 06, 07, 09, 16). Run:
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
      the listener ignores non-author decisions (re-raises for the author); open job: CAS → fingerprint/TTL/
      eligibility/limits → `createPullRequest` with `options.token` from `getMemberAccountToken` → `open`,
      `nextCheckAt = +30 min`, preparation Task `done`, Activity `actionType: 'app_upstream_pr'`,
      `action: 'app.upstream_pr.opened'`.
      **Test**: `upr/upstream-approval.listener.spec.ts`, `upr/upstream-open.service.spec.ts` (new) — non-author
      decision ignored; a changed head, title, body, base or maintainer choice opens nothing; a 73-hour-old approval
      opens nothing; the member token and `owner:branch` head are used; a second PR on one upstream in 24 h is refused
      with the next slot (ACC-09-11…ACC-09-15); extend `packages/agent/src/tasks/__tests__/job-runtime.providers.spec.ts`
      — the dispatcher count grows by one. Run: `pnpm --filter @ever-works/agent test upstream-approval upstream-open job-runtime.providers`.
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
      **Modify** `apps/api/src/works/upstream-pull-requests.controller.ts` — `POST` (propose), `GET :prId` (with diff),
      `POST :prId/signed`, `POST :prId/withdraw`, `POST :prId/check` (≥ 60 s apart); error contract of plan §5.
      **Test**: extend `apps/api/src/works/upstream-pull-requests.controller.spec.ts` — every route's shape and codes,
      `409 activeProposal`, `429 rateLimited` with `nextSlotAt`, the approval view carries the full diff, withdraw
      state, 404 for another account (ACC-09-03, 10, 12, 22, 23). Run:
      `cd apps/api && pnpm test upstream-pull-requests.controller`.
      **Done when**: the spec is green.

- [ ] **T20. Enable toggle via the App spec.**
      **Create** `packages/agent/src/upstream-pull-requests/upstream-setting.service.ts` (new) — reads
      `upstreamPullRequests.enabled` from the App spec; toggling files an App spec change through APW-08's
      `POST /api/works/:id/evolve` request builder (or APW-03's write path when offered); reports **pending** until the
      spec change merges.
      **Test**: `upr/upstream-setting.service.spec.ts` (new) — default off; toggling files exactly one App spec change
      request, opens no pull request upstream and reports pending until the merge (ACC-09-01). Run:
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
      `apps/web/src/components/inbox/InboxDecisionDetail.tsx` (approval item links to `UpstreamApprovalReview`),
      `apps/web/src/components/approvals/ApprovalsQueue.tsx` (never offered to bulk approval),
      `apps/web/src/lib/api/agent-approvals.ts` and `apps/web/src/lib/api/agents.shared.ts` (action type unions),
      `apps/web/src/components/activity-log/ActivityTypeBadge.tsx` (`app_upstream_pr` → `appUpstreamPr`).
      **Test**: `apps/web/src/components/works/detail/upstream/UpstreamPullRequestsSection.unit.spec.tsx`,
      `UpstreamApprovalReview.unit.spec.tsx` (beside it) and `apps/web/src/components/tasks/ProposeUpstreamDialog.unit.spec.tsx`
      (new) — state/check/review chip text, private-copy notice, org-fork maintainer note, the extra-files tick gates
      **Approve and open**, stale copy (ACC-09-10, 17); extend `apps/web/src/components/approvals/ApprovalsQueue.unit.spec.tsx`
      — an `upstream_pull_request` row is excluded from bulk approval; extend
      `apps/web/src/components/inbox/InboxDecisionsClient.unit.spec.tsx` — the approval item links to the review. Run:
      `pnpm --filter ever-works-web test Upstream ProposeUpstreamDialog ApprovalsQueue InboxDecisionsClient`.
      **Done when**: the specs are green and `WorkTabs.unit.spec.tsx` passes unchanged (this epic does not touch tabs).

- [ ] **T22. P2 i18n.**
      **Modify** `apps/web/messages/en.json` — every sub-tree in plan §8.1; mirror keys into the 20 sibling locales
      (`node apps/web/scripts/sync-locale-parity.mjs`).
      **Test**: `apps/web/src/lib/__tests__/app-works-upstream-messages.unit.spec.ts` (new) — every leaf of the plan §8.1
      sub-trees exists in all 21 locale files and no leaf key contains a `.` (ACC-09-23, strings half). Run:
      `pnpm --filter ever-works-web test app-works-upstream-messages`.
      **Done when**: the spec is green.

- [ ] **T23. Skill.**
      **Create** in `ever-works/skills`: `skills/upstream-contribution/SKILL.md` from
      [`skill-draft/SKILL.md`](./skill-draft/SKILL.md) and its `manifest.json` row.
      **Modify** `packages/agent/src/upstream-pull-requests/upstream-preparation.service.ts` — bind the Skill to the
      preparation Agent at Work scope on first use (idempotent).
      **Test**: extend `upr/upstream-preparation.service.spec.ts` — two preparations on one App Work create one binding.
      **Done when**: the spec is green and the Skill appears in the catalog.

- [ ] **T24. P2 e2e.**
      **Create** `apps/web/e2e/app-works-upstream-tab.spec.ts`, `apps/web/e2e/app-works-propose-upstream.spec.ts`,
      `apps/web/e2e/app-works-upstream-refusals.spec.ts` (new) per plan §10.4. No suite under `apps/api/test/` (R-22).
      **Test**: `cd apps/web && pnpm exec playwright test app-works-upstream-tab app-works-propose-upstream app-works-upstream-refusals`
      — pass (ACC-09-01, 03, 08, 09, 10, 12, 15, 17).
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
      and inline comments (≤ 64 KB) → finalize (no squash) → verify update diff (exclusions, ≤ 500 lines, secrets) →
      push approval → fast-forward via `updateBranchRef` (typed non-fast-forward refusal) → `pushTimestamps`.
      Blocked while `signatureState = 'cla_pending_check'`; ≤ 5 pushes per 24 h.
      **Modify** `apps/api/src/works/upstream-pull-requests.controller.ts` — `POST :prId/address-review`.
      **Test**: `upr/upstream-review-follow-up.service.spec.ts` (new) — nothing pushed before approval, then a
      fast-forward; non-fast-forward refusal; the 6th push in 24 h refused (ACC-09-18);
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
      offered only on fork App Works with proposals on; it adds the Task label `upstream-candidate` and nothing else.
      **Create** `packages/agent/src/upstream-pull-requests/upstream-suggestion.service.ts` (new) — on APW-08's
      `app.change.live` for a labelled Task: Inbox suggestion (≤ 1 per Task, ≤ 3 per App Work per 7 days); dismiss via
      `POST …/suggestions/:taskId/dismiss`.
      **Test**: `upr/upstream-suggestion.service.spec.ts` (new) — nothing prepared until **Propose**; the per-Task and
      7-day limits; a dismissed Task is not suggested again (ACC-09-21);
      `packages/agent/src/agents/__tests__/agent-tool-upstream-suggestion.spec.ts` (new) — the tool is offered only on
      fork App Works with proposals on and only labels the Task. Run:
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
      **Modify** `packages/monitoring/src/posthog/index.ts` — export it; the services of T15–T18 call
      `emitUpstreamPrEvent`.
      **Test**: `packages/monitoring/src/posthog/__tests__/upstream-pr-events.spec.ts` (new) — every event forwards its
      payload; a payload with `title`, `body`, `diff`, `login`, `owner`, `repo` or `repository` throws before `capture`
      (ACC-09-23, telemetry half). Run: `pnpm --filter @ever-works/monitoring test upstream-pr-events`.
      **Done when**: the spec is green.

- [ ] **T31. Structural guarantees.**
      **Create** `packages/agent/src/upstream-pull-requests/__tests__/no-merge-no-comment.spec.ts` (new) — scans the
      folder's sources for `mergePullRequest`, `closePullRequest`, `createPullRequestComment` and for any token
      resolution other than `getMemberAccountToken`; fails on a match.
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

- [ ] **T34. Holds and safety-rail refusals during preparation (added 2026-09-17, Resolution R-17).**
      **Modify** `packages/agent/src/upstream-pull-requests/upstream-preparation.service.ts` and
      `packages/agent/src/upstream-pull-requests/upstream-status.service.ts` — the 90-minute preparation deadline counts
      running time only, using APW-08's `classifyAppWorkRunStop` (APW-08 T46): a `wait` pauses the clock and keeps the
      row `preparing`; a `needs_input` stop keeps the row `preparing` with the clock paused and the Task `BLOCKED`.
      **Test**: `upr/upstream-preparation.holds.spec.ts` (new) — a run parked for 3 hours is not `timedOut`; a `ladder`
      refusal leaves the row `preparing` and opens nothing upstream; a released hold resumes the clock. Run:
      `pnpm --filter @ever-works/agent test upstream-preparation.holds`.
      **Done when**: the spec is green.

- [ ] **T35 (P1, lands with T7). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` — append to the `works` domain:
      `{ file: 'upstream-pull-requests.jsonl', entity: 'UpstreamPullRequest', scope: { by: 'parent', column: 'workId', from: 'workIds' } }`.
      `packages/agent/src/account-transfer/backup/redaction.ts` is **not** modified: title and body are public by
      design, `refusalDetail` never holds a token ([plan §3.1](./plan.md)), and no column has a secret-shaped name.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` —
      `UpstreamPullRequest` is referenced exactly once, in `works`, scoped `parent` on `workId` from `workIds`, not
      dropped; its planned query carries `within: { column: 'workId', ids }` with the registered Work ids.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green and a backup of a workspace
      with one upstream pull request lists `data/works/upstream-pull-requests.jsonl` with one record.

---

## Definition of Done

- Every checkbox is ticked; root `format:check`, `lint`, `type-check`, `test`, `build` green.
- T31's structural spec is green: no code path in this epic merges, closes or comments upstream, or uses any token but
  the member's.
- ACC-09-01…ACC-09-23 walked against a throwaway upstream repository the team owns — never a third-party project.
- The known gaps in plan §12 are still recorded.
