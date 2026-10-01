# Implementation Plan: Upstream pull requests

> Translates [`spec.md`](./spec.md) into architecture and tech choices. The plan owns implementation detail; the
> spec owns behaviour. **Every path below was opened in the worktree before it was written down** — a path marked
> _(new)_ does not exist yet.

**Epic ID**: `APW-09-upstream-pull-requests`
**Spec**: [`./spec.md`](./spec.md) · **Tasks**: [`./tasks.md`](./tasks.md)
**Status**: `Draft`
**Last updated**: 2026-09-17
**Authored against**: `develop` @ `a655b53ca`

---

## 1. Current state in the codebase

### 1.1 What ships today

| Layer      | File                                                                                                                                                                                                                                                                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider   | [`packages/plugins/github/src/github-api.service.ts`](../../../../../packages/plugins/github/src/github-api.service.ts) `createPullRequest` (~635)                                                                                                                                                               | `pulls.create({ owner, repo, title, head, base, body, draft })` — **`head` passes through**, but the result maps `head: data.head.ref`, **dropping the head owner/repository**; no `maintainer_can_modify`; a missing body is replaced by `"Pull request from {head} to {base}"`.                                                                                                                                                                                                                                                                  |
| Provider   | same, `getPullRequest` (~663), `listPullRequests` (~736), `getPullRequestStatus` (~817), `readChecks` (~976)                                                                                                                                                                                                     | Same lossy head mapping; status reads the PR, check runs and commit statuses for the head sha; `reviewDecision` is read from an untyped `review_decision` field of the REST response.                                                                                                                                                                                                                                                                                                                                                              |
| Provider   | same, `createBranch` (~566)                                                                                                                                                                                                                                                                                      | `git.getRef('heads/{fromRef}')` then `createRef` — **accepts a branch name only**, not a commit sha.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Provider   | same, `getCompareDiff` (~1102)                                                                                                                                                                                                                                                                                   | `compareCommitsWithBasehead({ basehead: '<base>...<head>' })` — accepts `owner:branch` as `head` for a fork in the same network without change.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Contract   | [`packages/plugin/src/contracts/capabilities/git-provider.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/git-provider.interface.ts)                                                                                                                                                    | `CreatePROptions { owner, repo, title, head, base, body?, draft? }`; `GitPullRequest { number, title, state, head, base, url, … }`; optional `getPullRequestStatus?`, `getCompareDiff?`, `createBranch?`, `deleteBranch?`, `closePullRequest?`, `createPullRequestComment?`. No reviews list, no interaction limits.                                                                                                                                                                                                                               |
| Contract   | [`packages/plugin/src/contracts/capabilities/git-provider.pr-insights.ts`](../../../../../packages/plugin/src/contracts/capabilities/git-provider.pr-insights.ts)                                                                                                                                                | `deriveCiState` treats **`action_required` as `failing`** — correct for a Work's own CI, wrong for an upstream PR awaiting maintainer approval.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Contract   | [`packages/plugin/src/contracts/capabilities/workspace.interface.ts`](../../../../../packages/plugin/src/contracts/capabilities/workspace.interface.ts)                                                                                                                                                          | `WorkspaceProvisionSpec { repoUrl, baseRef, branch, bindingKey, depth?, auth? }`; `WorkspaceFinalizeOptions { commitMessage, push, identity?, pushCredential?, … }` — no squash.                                                                                                                                                                                                                                                                                                                                                                   |
| Scopes     | [`packages/plugin/src/common/github.scopes.ts`](../../../../../packages/plugin/src/common/github.scopes.ts)                                                                                                                                                                                                      | `GITHUB_FULL_SCOPES` includes `repo` (sufficient to open a PR on a public repository).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Facade     | [`packages/agent/src/facades/git.facade.ts`](../../../../../packages/agent/src/facades/git.facade.ts)                                                                                                                                                                                                            | `resolvePluginAndToken` order: explicit token → platform PAT for `ever-works-git` storage (needs `workId`) → **GitHub App installation token for the Work** (needs `workId`) → user OAuth account (`findUsableGitProviderAccount`) → plugin-settings PAT. `createPullRequest`, `getPullRequestStatus`, `getCompareDiff`, `mergePullRequest` (the one merge point).                                                                                                                                                                                 |
| Task PRs   | [`packages/agent/src/tasks-domain/task-workspace.service.ts`](../../../../../packages/agent/src/tasks-domain/task-workspace.service.ts) `openPullRequestForBranch` (~1414), `finalizeRun` (~1155)                                                                                                                | Same-repository PR from the Task branch into the Work's base; `simulateMerge` against the Work base; transitions to `in_review`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Approvals  | [`packages/agent/src/entities/agent-action-proposal.entity.ts`](../../../../../packages/agent/src/entities/agent-action-proposal.entity.ts)                                                                                                                                                                      | `actionType varchar(32)` over a closed union incl. `merge_pull_request`; `subjectKey varchar(200)` with UNIQUE `(actionType, subjectKey)`; `agentId` required; `decidedVia 'user' \| 'guardrail'`.                                                                                                                                                                                                                                                                                                                                                 |
| Approvals  | [`packages/agent/src/agent-approvals/agent-approvals.service.ts`](../../../../../packages/agent/src/agent-approvals/agent-approvals.service.ts) `createProposal`                                                                                                                                                 | Ownership check, `RISK_SCORER`, guardrail evaluation (auto-approval skipped when `humanDecisionRequired`; a `block` still rejects), since AW-24 folded with the resolved trust-ladder rung through `applyLadderToGuardrailDecision` / `PROPOSAL_ACTION_CATEGORY` in `packages/agent/src/safety/guardrail-interop.ts` (stricter wins; an unmapped action type is unaffected), Inbox mirror for pending rows. `approveAll` counts rows that `requiresIndividualDecision` (today `merge_pull_request` and email drafts) as `excluded`, not `skipped`. |
| Approvals  | [`packages/agent/src/agent-approvals/risk-scorer.ts`](../../../../../packages/agent/src/agent-approvals/risk-scorer.ts)                                                                                                                                                                                          | `merge_pull_request` → `destructive` by action type, not by payload; `crossScope` from payload.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Approvals  | [`packages/agent/src/agent-approvals/merge-approval.service.ts`](../../../../../packages/agent/src/agent-approvals/merge-approval.service.ts)                                                                                                                                                                    | **The precedent**: subject-keyed request (`merge:<taskId>:<prNumber>:<headSha>`), unique-index idempotency, `entitledToApprove`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Approvals  | [`packages/agent/src/agent-approvals/agent-action-proposal-decided.event.ts`](../../../../../packages/agent/src/agent-approvals/agent-action-proposal-decided.event.ts), [`packages/agent/src/email/email-draft-approval.listener.ts`](../../../../../packages/agent/src/email/email-draft-approval.listener.ts) | `AgentActionProposalDecidedEvent` fired after a decision; listeners filter by `actionType` and must be idempotent — the email-draft listener is the consumer pattern.                                                                                                                                                                                                                                                                                                                                                                              |
| Secrets    | [`packages/agent/src/utils/secret-scan.ts`](../../../../../packages/agent/src/utils/secret-scan.ts)                                                                                                                                                                                                              | `assertNoSecrets(body, fieldHint)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Docs       | [`docs/features/task-isolation.md`](../../../../../docs/features/task-isolation.md), [`docs/features/merge-policy.md`](../../../../../docs/features/merge-policy.md), [`docs/features/approvals-and-escalations.md`](../../../../../docs/features/approvals-and-escalations.md)                                  | Branch-per-Task, cleanup of Task branches only; one merge decision point; approvals/Inbox semantics ("executing the approved action is a follow-up" — except `merge_pull_request`).                                                                                                                                                                                                                                                                                                                                                                |
| Web        | [`apps/web/src/components/works/detail/WorkTabs.tsx`](../../../../../apps/web/src/components/works/detail/WorkTabs.tsx), [`apps/web/src/lib/constants.ts`](../../../../../apps/web/src/lib/constants.ts)                                                                                                         | Tab list per Work (`/works/:id/pull-requests`, `/tasks`, …); route constants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Web        | [`apps/web/src/components/tasks/TaskDetailClient.tsx`](../../../../../apps/web/src/components/tasks/TaskDetailClient.tsx)                                                                                                                                                                                        | Task detail sections; the action row APW-09 extends.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Migrations | [`apps/api/src/migrations/`](../../../../../apps/api/src/migrations)                                                                                                                                                                                                                                             | Newest `1791240000000-AddSafetyRailsCore.ts` on `ee45946e5` (`1791200100000-CreateOnboardingChecklists.ts` when authored).                                                                                                                                                                                                                                                                                                                                                                                                                         |

From sibling epics (consumed, not re-declared — CONTRACTS.md): `Work.sourceRepository.type = 'app_fork'` and
`sourceRepository.upstream { owner, repo, defaultBranch }` (APW-01); `IGitProviderPlugin.getRepository` → `source`,
`archived` and `GET /api/works/:id/upstream` sync status (APW-02); App spec `upstreamPullRequests.enabled` and
`display.protectedPaths` (APW-03 schema); delivery state, isolated-run admission, `AppChangeGuard` (APW-08).

### 1.2 The exact blockers

- **No cross-repository head on read.** `head: data.head.ref` loses `data.head.repo.full_name`, so a tracked PR cannot
  prove it came from the fork.
- **No `maintainer_can_modify`** on create.
- **No branch at an arbitrary commit.** `createBranch` resolves `heads/{fromRef}`; the upstream default-branch head
  exists in the fork network but not as a branch in the fork.
- **No fast-forward of an existing branch** for review follow-ups.
- **No review list, no interaction limits** on the capability.
- **Token order is wrong for this use.** With a `workId`, the facade prefers a platform PAT or a GitHub App
  installation token. An upstream PR must be authored by the member, so the token must be the member's OAuth
  connection **by construction**.
- **`action_required` reads as failing** in the shared roll-up.
- **Approvals do not execute** except merges. Opening must be driven by a listener, bound by a subject key.
- **Finalize always simulates a merge against the Work base and opens a same-repository PR.** A preparation Task
  needs "push only, one commit, compare against upstream".

### 1.3 Reuse, don't rebuild

- Task isolation for the preparation and review-follow-up runs (branch reuse via a pre-set `branchRef`).
- `AgentApprovalsService.createProposal` with `humanDecisionRequired: true`, a subject key and the Inbox mirror.
- The `AgentActionProposalDecidedEvent` listener pattern.
- `getCompareDiff` for the cross-repository diff (`main...maya:upstream-pr/x`).
- `readChecks` for the upstream head (via `getPullRequestStatus`), summarised by a new pure function.
- `assertNoSecrets` for the prepared diff and body.
- APW-08's `AppChangeGuard` path/field matchers for the exclusion list.

---

## 2. Architecture

### 2.1 Flow

```
 Task (merged, fork App Work) ── POST /api/works/:id/upstream-pull-requests {taskId, maintainerCanModify}
        │  UpstreamEligibilityService (pure rules + provider reads)  ── refuse → 422 {code}
        ▼
 UpstreamPullRequest(state=preparing) ── createBranchFromSha(fork, upstream-pr/<slug>-<hex>, upstreamHeadSha)
        │  Task(labels: upstream-pr:<id>, branchRef preset, isolation on) ── dispatchAgentRun (isolated admission)
        ▼
 run (Skill upstream-contribution) ── finalize: squashOnto(baseSha), identity = member, push only
        │  UpstreamPreparationVerifier: compare upstream base...fork:branch · exclusions · extra files · size ·
        │  secrets · 1 commit · checks evidence · signature/AI flags
        ├─ refused/failed/needs_signature
        ▼
 AgentApprovalsService.createProposal(actionType 'upstream_pull_request', subjectKey 'upstream-pr:open:<id>:<fp>',
        humanDecisionRequired, payload{display only}) ── state awaiting_approval, approvalExpiresAt = +72 h
        ▼  AgentActionProposalDecidedEvent (approved, decidedById === author)
 UPSTREAM_PR_OPEN_DISPATCHER → job upstream-pr-open
        re-verify fingerprint + eligibility + limits ── createPullRequest(upstream, head 'fork:branch',
        maintainerCanModify) with the member's OAuth token only ── state open, nextCheckAt = +30 min
        ▼
 job upstream-pr-status (every 10 min, ≤ 100 due) ── getPullRequestStatus + listPullRequestReviews
        summarizeUpstreamChecks · review diffing (seenReviewIds) · CLA detection · merged/closed · cadence
```

### 2.2 Components (agent package, `packages/agent/src/upstream-pull-requests/` _(new)_)

| Unit                                   | Responsibility                                                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream-eligibility.rules.ts`        | Pure: relation, setting, source Task merged, active proposal, limit windows → allowed or `{ code, nextSlotAt? }`.                                                                                                            |
| `upstream-eligibility.service.ts`      | Provider reads: upstream `getRepository` (archived, exists), fork `getRepository` (`source` = upstream), `getInteractionLimit`, member push permission on the fork, OAuth scope.                                             |
| `upstream-rate-limits.ts`              | Counting queries over `upstream_pull_requests` (opened in 24 h per upstream / overall; open per upstream; preparations started in 24 h; running per Work; pushes in 24 h).                                                   |
| `upstream-member-token.ts`             | `resolveMemberGitHubToken(userId, providerId)` — calls a new facade method that resolves **only** the user OAuth account (then the user's plugin-settings PAT), never a platform PAT or installation token.                  |
| `upstream-preparation.service.ts`      | Create row + fork branch + preparation Task; `onPreparationFinalized(task, finalize)`.                                                                                                                                       |
| `upstream-preparation.verifier.ts`     | Pure-ish verification over the compare result, source-change file set, exclusion globs, size (lockfiles excluded, APW-08 constant), secret scan, commit count, checks evidence, flags.                                       |
| `upstream-fingerprint.ts`              | `sha256(headSha \| title \| body \| upstreamFullName \| baseBranch \| headOwner:headBranch \| maintainerCanModify)`, hex; subject keys `upstream-pr:open:<id>:<fp>` / `upstream-pr:push:<id>:<fp>`.                          |
| `upstream-approval.listener.ts`        | `@OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME)`; filters `actionType === 'upstream_pull_request'`; refuses decisions whose `decidedById !== row.userId`; dispatches open/push; rejected → withdrawn + branch cleanup. |
| `upstream-open.service.ts`             | Re-verify + open + record.                                                                                                                                                                                                   |
| `upstream-status.service.ts`           | Poll one PR; `summarizeUpstreamChecks`; review diffing; CLA check detection; cadence; expiry of stale approvals; cleanup of branches for terminal rows.                                                                      |
| `upstream-review-follow-up.service.ts` | **Address review** Task on `upstream-pr/<…>--update-<n>` cut from the PR head; after finalize → verify → push approval → fast-forward the PR branch.                                                                         |
| `upstream-suggestion.service.ts`       | Suggestion on APW-08 `live` for Tasks labelled `upstream-candidate`, with the FR-34 limits.                                                                                                                                  |

### 2.3 The token rule (FR-24) — structural, not conventional

`GitFacadeService.getMemberAccountToken({ userId, providerId })` _(new)_ calls
`findUsableGitProviderAccount(userId, providerId)` and, failing that,
`getPatFromSettings(providerId, userId, undefined)`. It never receives a `workId`, so
neither `tryResolveEverWorksGitPlatformToken` nor `getInstallationTokenForWork` can run, and it passes the token
explicitly to every upstream call (`options.token`). A unit test asserts both short-circuits are unreachable from
`upstream-open.service.ts` by spying on them. The fork-side operations (create branch at sha, delete branch,
fast-forward) also use the member token: the member must be able to push to the fork (FR-3).

### 2.4 Checks summary (FR-30)

```ts
export function summarizeUpstreamChecks(
	checks: readonly GitPullRequestCheck[],
	complete: boolean
): 'passing' | 'failing' | 'pending' | 'waiting_for_maintainers' | 'unknown' {
	// action_required anywhere, nothing failing  → waiting_for_maintainers
	// failure | timed_out | startup_failure      → failing (CLA-named checks excluded: they set signatureState)
	// any not completed                          → pending
	// empty                                      → unknown (never passing)
	// all completed, none failing, complete      → passing; incomplete → pending
}
```

A check whose name matches `/\b(cla|contributor license)\b/i` (or a legacy status context of the same shape) that is
pending or failing sets `signatureState = 'cla_pending_check'` and blocks pushes (FR-19, S18).

### 2.5 Preparation finalize

**Which commit the preparation is measured against (added 2026-09-17, G01).** The prepared branch
`upstream-pr/{slug}-{4 hex}` is cut in the fork at the **upstream default-branch head**, and its sha is recorded on
the row as `upstreamBaseSha` in the same step that calls `createBranchFromSha` (§3.1). The preparation Task is then
provisioned **from that branch**: `TaskWorkspaceService.provisionForRun` resolves `baseRef` from the row whenever the
Task is bound to one (`row.preparationTaskId === task.id` → `row.headBranch`; `row.followUpTaskId === task.id` → the
follow-up branch of §2.6), instead of `work.taskIsolationBaseBranch`/the repository default. That single change is
what makes the rest correct: both workspace plugins compute `baseSha` as
`git rev-parse refs/remotes/origin/<baseRef>` (`local-workspace.plugin.ts:340-347`,
`sandbox-workspace.plugin.ts:165-172`), so `handle.baseSha` — and with it `task.baseSha` written by
`provisionForRun` (`task-workspace.service.ts:257-259`), the finalize empty check and `countChangedFiles`
(`local-workspace.plugin.ts:450-460`) — is the **upstream-side** commit, not the fork's own branch head. Squashing
onto the fork head would make `git merge-base --is-ancestor <sha> HEAD` (T13) refuse every preparation, because the
fork head is not an ancestor of a branch cut from upstream.

`TaskWorkspaceService.finalizeRun` and `finalizeRemotePush` gain one early branch, **placed before APW-08's
`AppChangeGuard` and before `simulateMerge`**: a Task bound to an `upstream_pull_requests` row —
`row.preparationTaskId === task.id` or `row.followUpTaskId === task.id`, looked up **by row**, never by a Task label
(G18) — calls `UpstreamPreparationService.onPreparationFinalized` (preparation) or
`UpstreamReviewFollowUpService.onFollowUpFinalized` (review follow-up) **instead of** `AppChangeGuard`,
`simulateMerge` and `openPullRequestForBranch`. Ordering matters twice over: APW-08's guard compares the branch
against the fork's base and would refuse an upstream-based branch, and a review follow-up must never reach
`openPullRequestForBranch` (`task-workspace.service.ts:1259-1272`) — a same-repository pull request inside the fork
is exactly what FR-31 forbids. `finalizeRemotePush` refuses both bindings (preparation is a cloud-only run, FR-6).

The cloud finalize passes two additive options to `workspaceFacade.finalize`: `squashOnto: row.upstreamBaseSha`
(one commit, FR-8) and `identity` = the member (`{login}` and the provider's no-reply address from `getUser`), plus
a message that carries no trailer, and `reportFiles: ['.ever-works/upstream-pr-report.json']` (FR-47, §4). The
review follow-up passes **no** `squashOnto` — reviewers expect incremental commits — and no report file. The
preparation Task moves to `in_review` while awaiting approval, `done` when opened, `cancelled` on
withdrawn/expired/refused/failed.

**Dispatch (added 2026-09-17, G09).** Preparation is dispatched through APW-08's `dispatchAgentRun`
(`task-transition.service.ts`) with two explicit properties:

- **Fleet is refused.** The dispatch carries the reviewer-run `delegationScope`
  (`task-transition.service.ts:869`), whose enforced narrowing is what a Fleet dispatcher already refuses
  (`fleet-delegation-scope-unenforceable`) — so "Fleet refused" is the existing G9 delegation-scope guard, not a new
  hook, and it stays true even if that guard is ever relaxed (`refuseAgentReviewRun`,
  `task-transition.service.ts:886-892`). The ephemeral branch kind is never prepared on a node: the squash and the
  member identity are enforced in the cloud finalize only, which is already a known gap (§12).
- **The brief rides `seedPendingInput`.** The source pull request's diff (≤ 256 KB) and the upstream guide files
  (each ≤ 64 KB) are seeded as fenced untrusted `user` turns through `seedPendingInput`
  (`task-transition.service.ts:870-897`), which drains before the first model round-trip and is **never** spliced
  into a system prompt — the same vehicle `RunSteeringService.resume` uses. That column is not a Fleet vehicle (the
  Fleet planner renders it as an owner-answer block), which is a second reason preparation does not run there.

**Safety rails (Resolution R-17).** The preparation and review follow-up Tasks are App Work Tasks, so APW-08's
handling applies unchanged: a run parked by the stop flag or an Agent/workspace pause is a **wait** — the 90-minute
preparation deadline (`UPSTREAM_TIMEOUTS.preparationMs`) is measured over running time only and the row stays
`preparing`; a safety-rail refusal makes the Task `needs_input` (Task `BLOCKED` + escalation `guardrail-refusal`) and
the row stays `preparing` with the clock paused until the member resumes or withdraws. Branch pushes happen in Task
finalize and the upstream pull request is opened by the `upstream-pr-open` job — never by the Agent
`commitToRepo` / `openPullRequest` tools — and only after the author's approval (§6).

### 2.6 Review follow-up (FR-31)

1. `createBranchFromSha(fork, '<headBranch>--update-<n>', row.headSha)`.
2. Task labelled `upstream-pr-update:<id>` (a **display** label — routing is by `row.followUpTaskId`, G18),
   `branchRef` preset to the update branch, provisioned by `provisionForRun` with `baseRef` = that branch (§2.5),
   brief = review bodies + inline comments (≤ 64 KB, fenced untrusted, as `seedPendingInput` entries, §2.5).
3. Finalize (no squash — reviewers expect incremental commits) → `onFollowUpFinalized`, which verifies the update
   diff (`<headBranch>...<update>` — measured from `handle.baseSha`, i.e. `row.headSha`) against the same exclusions
   and a 500-line update cap → push approval `upstream-pr:push:<id>:<fp>`. No merge simulation, no
   `openPullRequestForBranch`, no `createPullRequest` call in the fork's own repository: the follow-up Task's
   commits reach the pull request branch only as the approved fast-forward below.
4. On approval: `updateBranchRef(fork, headBranch, updateHeadSha, { force: false })` — a fast-forward only; a
   non-fast-forward (someone pushed to the PR branch) refuses with **"The pull request branch moved. Review it
   again."** and re-prepares the update approval.

---

## 3. Data model

**Workspace backup (Resolution R-25).** `UpstreamPullRequest` exports as `data/works/upstream-pull-requests.jsonl` through the parent Work ids; nothing is redacted ([tasks](./tasks.md) T35).

### 3.1 `upstream_pull_requests` _(new, P1)_

| Column                                                     | Type                                     | Notes                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                       | `uuid` PK                                |                                                                                                                                                                                                                                                          |
| `userId`                                                   | `uuid NOT NULL`                          | Author member. CASCADE with `user.id`.                                                                                                                                                                                                                   |
| `workId`                                                   | `uuid NOT NULL`                          | CASCADE with `works.id`.                                                                                                                                                                                                                                 |
| `sourceTaskId`                                             | `uuid NOT NULL`                          | No FK (a Task deletion must not erase a published PR's record).                                                                                                                                                                                          |
| `preparationTaskId`                                        | `uuid NULL`                              |                                                                                                                                                                                                                                                          |
| `followUpTaskId`                                           | `uuid NULL`                              | Latest review follow-up.                                                                                                                                                                                                                                 |
| `upstreamOwner` / `upstreamRepo`                           | `varchar(100)` each                      |                                                                                                                                                                                                                                                          |
| `baseBranch`                                               | `varchar(255)`                           |                                                                                                                                                                                                                                                          |
| `headOwner` / `headRepo`                                   | `varchar(100)` each                      |                                                                                                                                                                                                                                                          |
| `headBranch`                                               | `varchar(255)`                           | `upstream-pr/{slug≤40}-{4 hex}`.                                                                                                                                                                                                                         |
| `headSha`                                                  | `varchar(64) NULL`                       |                                                                                                                                                                                                                                                          |
| `upstreamBaseSha`                                          | `varchar(64) NULL`                       | **Added 2026-09-17 (G01).** The commit on the upstream default branch `headBranch` was cut from — the squash base (FR-8) and the commit the diff, extra-files and changed-file count are measured against. Never the fork's own branch head.             |
| `preparationStartedAt` / `preparationHeldSince`            | `timestamptz NULL` each                  | **Added 2026-09-17 (G14).** When the 90-minute running clock started, and when the row was last parked by a hold (null while running).                                                                                                                   |
| `preparationPausedMs`                                      | `bigint NOT NULL DEFAULT 0`              | **Added 2026-09-17 (G14).** Accumulated pause time, subtracted from the running clock.                                                                                                                                                                   |
| `state`                                                    | `varchar(24) NOT NULL`                   | `UPSTREAM_PULL_REQUEST_STATES`; default `preparing`.                                                                                                                                                                                                     |
| `number` / `url`                                           | `int NULL` / `varchar(512) NULL`         |                                                                                                                                                                                                                                                          |
| `title` / `body`                                           | `varchar(200) NULL` / `text NULL`        | Public text by design; kept for the approval and audit.                                                                                                                                                                                                  |
| `disclosureText`                                           | `varchar(300) NULL`                      |                                                                                                                                                                                                                                                          |
| `claUrl`                                                   | `varchar(512) NULL`                      | **Added 2026-09-17 (G04).** The agreement link the report carried; what the Inbox **Open the agreement** action opens (FR-19, S17).                                                                                                                      |
| `missingPieces`                                            | `simple-json NULL`                       | **Added 2026-09-17 (G04).** `≤ 10` short strings from the report's `doesNotPort` list (S21).                                                                                                                                                             |
| `maintainerCanModify`                                      | `boolean NOT NULL DEFAULT true`          |                                                                                                                                                                                                                                                          |
| `fingerprint`                                              | `varchar(64) NULL`                       |                                                                                                                                                                                                                                                          |
| `approvalProposalId` / `approvalExpiresAt`                 | `uuid NULL` / `timestamptz NULL`         |                                                                                                                                                                                                                                                          |
| `extraFilesAcknowledgedAt` / `extraFilesAcknowledgedById`  | `timestamptz NULL` / `uuid NULL`         | **Added 2026-09-17 (G06, FR-49).** The recorded **I've reviewed the extra files** acknowledgement; required by every door that can approve while `diffStats.extraFiles` is non-empty.                                                                    |
| `checksSummary` / `reviewSummary`                          | `varchar(32) NULL` / `varchar(24) NULL`  |                                                                                                                                                                                                                                                          |
| `signatureState`                                           | `varchar(24) NULL`                       | `cla_required` · `cla_acknowledged` · `cla_pending_check`.                                                                                                                                                                                               |
| `refusalCode` / `refusalDetail`                            | `varchar(32) NULL` / `varchar(500) NULL` | `refusalDetail` holds a quoted guide sentence (≤ 300) or a provider message, never a token. `reportInvalid` and `publishingOff` join `UPSTREAM_REFUSAL_CODES` (G10, FR-47).                                                                              |
| `diffStats`                                                | `simple-json NULL`                       | `{ files, additions, deletions, extraFiles: string[] (≤ 3) }`.                                                                                                                                                                                           |
| `checkResults`                                             | `simple-json NULL`                       | `≤ 10` of `{ command (≤ 200), exitCode, startedAt, endedAt, tail (≤ 50 lines, ≤ 8 KB), alsoRedOnBase, source: 'agent' }` — `source` is `'agent'` for every row today and is what the approval renders as **Reported by the preparation agent.** (FR-47). |
| `seenReviewIds`                                            | `simple-json NULL`                       | `≤ 200` provider review ids; the oldest is evicted past 200 (§4).                                                                                                                                                                                        |
| `pushTimestamps`                                           | `simple-json NULL`                       | `≤ 20` ISO times of approved pushes (24 h window).                                                                                                                                                                                                       |
| `forkBranchDeletedAt`                                      | `timestamptz NULL`                       |                                                                                                                                                                                                                                                          |
| `lastUpstreamActivityAt` / `lastCheckedAt` / `nextCheckAt` | `timestamptz NULL`                       |                                                                                                                                                                                                                                                          |
| `openedAt` / `mergedAt` / `closedAt`                       | `timestamptz NULL`                       |                                                                                                                                                                                                                                                          |
| `tenantId` / `organizationId`                              | `uuid NULL`                              | Scope-stamped by the subscriber.                                                                                                                                                                                                                         |
| `createdAt` / `updatedAt`                                  | `timestamptz`                            |                                                                                                                                                                                                                                                          |

Indexes: `idx_upr_work_state (workId, state)`;
`idx_upr_user_upstream_opened (userId, upstreamOwner, upstreamRepo, openedAt)`; `idx_upr_due (state, nextCheckAt)`;
`idx_upr_preparing_started (state, preparationStartedAt)` — **added 2026-09-17 (G14)**, so the status job can select
`preparing` rows that may have overrun without scanning the table; `uq_upr_active_source (sourceTaskId)` UNIQUE
partial `WHERE state IN ('preparing','needs_signature','awaiting_approval','opening','open')` (FR-5, S27).

Entity `packages/agent/src/entities/upstream-pull-request.entity.ts` _(new)_ registered in the four places the
entity drift specs check: `entities/index.ts`, `database/_entity-names.ts`, `database/_entities-inventory.ts`, and
the owning module's `TypeOrmModule.forFeature`.

### 3.1A `work_upstream_pr_settings` _(new, P2 — added 2026-09-17, G07/FR-48)_

The toggle's in-flight state lives here; the App spec stays the source of truth (D3, FR-48).

| Column                                        | Type                                                   | Notes                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                          | `uuid` PK                                              |                                                                                                                                              |
| `workId`                                      | `uuid NOT NULL`                                        | UNIQUE — one row per App Work. CASCADE with `works.id`.                                                                                      |
| `requestedEnabled`                            | `boolean NOT NULL`                                     | The value the member asked for.                                                                                                              |
| `requestedById` / `requestedAt`               | `uuid NOT NULL` / `timestamptz`                        | Who asked, when.                                                                                                                             |
| `changeBranch` / `changeNumber` / `changeUrl` | `varchar(255) NULL` / `int NULL` / `varchar(512) NULL` | The platform-authored App spec change carrying it: branch, setup pull request number and link (null for the direct-`commitFiles` path, R-4). |
| `appliedValue` / `appliedAt`                  | `boolean NULL` / `timestamptz NULL`                    | The value read back from the effective App spec once it merged.                                                                              |
| `refusalCode` / `refusalDetail`               | `varchar(32) NULL` / `varchar(500) NULL`               | Named refusal when no write path was available (FR-48).                                                                                      |
| `createdAt` / `updatedAt`                     | `timestamptz`                                          |                                                                                                                                              |

Index: `uq_wups_work (workId)` UNIQUE. Entity `work-upstream-pr-setting.entity.ts` _(new)_ registered like the row
above (including `database/index.ts`).

### 3.1B `upstream_pr_suggestions` _(new, P3 — added 2026-09-17, G20/FR-34)_

FR-34's counters and the dismissal record (S9, **Dismiss**).

| Column                         | Type                    | Notes                                                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | `uuid` PK               |                                                                                                                                                                                                                                                                      |
| `workId` / `taskId` / `userId` | `uuid NOT NULL` each    | UNIQUE `(taskId)` — at most one suggestion per Task (FR-34).                                                                                                                                                                                                         |
| `reason`                       | `varchar(300) NULL`     | The Agent's reason, as sent.                                                                                                                                                                                                                                         |
| `sentAt` / `dismissedAt`       | `timestamptz NULL` each | `sentAt` is stamped when the notice goes out and is what the 7-day window counts; a dismissed row is never re-sent (FR-34). Both null on a row the tool call created that has not been sent yet — `createdAt` is the marker the `app.change.live` handler looks for. |
| `createdAt` / `updatedAt`      | `timestamptz`           |                                                                                                                                                                                                                                                                      |

Indexes: `uq_ups_task (taskId)` UNIQUE; `idx_ups_work_sent (workId, sentAt)`. Entity
`upstream-pr-suggestion.entity.ts` _(new)_ registered like the row above. `POST …/suggestions/:taskId/dismiss`
(§5) writes `dismissedAt`; the Agent tool records the suggestion server-side from its call (G18), never from a Task
label.

### 3.2 Migration

`apps/api/src/migrations/1792090000000-CreateUpstreamPullRequests.ts` _(new)_ — reserved block `179209<slot>00000`,
slot 00. `up()`: create table + indexes (partial unique on Postgres and SQLite). `down()`: drop indexes and table.
`1792090100000-CreateUpstreamPrSuggestions.ts` _(new)_ — slot 01, FR-34's counters (G20).
`1792090200000-CreateWorkUpstreamPrSettings.ts` _(new)_ — slot 02, the toggle's pending state (G07).
Each `up()` creates only its own table and indexes and each `down()` drops only what its `up()` added, on both
engines, so a re-run is a no-op. Beyond these three tables the epic adds no schema change: the approval action type
is a varchar value and the App spec setting is file content. All three tables are classified for the workspace
backup (R-25, §3 preamble) and every entity is registered in `entities/index.ts`, `database/_entity-names.ts`,
`database/_entities-inventory.ts` and — for the feature-owned repositories — exported from
`packages/agent/src/database/index.ts` (the pattern every other epic's repository follows; a repository wired by
this epic's own module is **not** added to `database/_repository-inventory.ts`, which lists `DatabaseModule`'s own
providers only — `_repository-inventory.ts:21-27`).

### 3.3 Shared types — `packages/contracts/src/apps/upstream-pull-request.types.ts` _(new)_

In `packages/contracts/src/apps/`, the one folder for every App Works shared type (Resolution R-1), exported from
`packages/contracts/src/apps/index.ts` (created by APW-03 T1). No other contracts folder is created.

```ts
export const UPSTREAM_PULL_REQUEST_STATES = [
	'preparing',
	'needs_signature',
	'awaiting_approval',
	'opening',
	'open',
	'merged',
	'closed',
	'refused',
	'failed',
	'expired',
	'withdrawn'
] as const;
export const UPSTREAM_ACTIVE_STATES = ['preparing', 'needs_signature', 'awaiting_approval', 'opening', 'open'] as const;
export const UPSTREAM_CHECKS_SUMMARIES = [
	'passing',
	'failing',
	'pending',
	'waiting_for_maintainers',
	'unknown'
] as const;
export const UPSTREAM_REVIEW_SUMMARIES = ['none', 'approved', 'changes_requested', 'commented'] as const;
export const UPSTREAM_REFUSAL_CODES = [
	'archived',
	'collaboratorsOnly',
	'blocked',
	'networkMismatch',
	'aiNotAccepted',
	'dcoRequired',
	'tooLarge',
	'rateLimited',
	'doesNotPort',
	'checksRed',
	'tooManyExtraFiles',
	'connectionScope',
	'notForkPusher',
	'notFork',
	'disabled',
	'sourceNotMerged',
	'excludedPath',
	'secretDetected',
	'notSingleCommit',
	'fingerprintMismatch',
	'approvalExpired',
	'timedOut',
	'providerUnsupported',
	// Appended 2026-09-17 — never reordered, never removed (R-26). Spec §6.5 carries one copy row per value.
	'publishingOff', // FR-21: the member's publishing rung is off. Distinct from `blocked` (the provider's own refusal).
	'pullRequestsDisabled', // FR-4: the repository has pull requests switched off.
	'outsideContributorCap', // FR-4: the repository's cap on open pull requests from outside contributors.
	'platformCapReached', // FR-39: the platform-wide per-upstream ceiling.
	'maintainerOptOut', // FR-40: the project says it does not want automated contributions.
	'deniedUpstream', // FR-41: the operator deny list.
	'reportInvalid' // FR-47: the preparation report was missing, oversized or malformed → state `failed`.
] as const;
export const UPSTREAM_ERROR_CODES = ['activeProposal'] as const; // 409 bodies, not refusals (spec §6.5).

export const UPSTREAM_LIMITS = {
	// Every value below is the DEFAULT an operator may raise for the installation without a redeploy
	// (resolution R-31, CONTRACTS §7A: `EVER_WORKS_APP_UPSTREAM_PR_MAX_PER_DAY` covers
	// `openedOverallPer24h`, member 3 / organization 20). Raising one never removes the platform ceiling
	// below, and no product setting raises a value at will (FR-26).
	openedPerUpstreamPer24h: 1,
	// Ceiling only. The effective per-upstream open cap is the App Work's own setting,
	// `spec.upstreamPullRequests.maxOpen` (schema.md §20, default 3, valid 1–10, read through
	// AppSpecService.getEffectiveSpec). A hard-coded 2 here used to ignore the spec field entirely —
	// FR-26 — so this constant must never be read as the limit itself.
	openPerUpstreamCeiling: 10,
	openedOverallPer24h: 3,
	preparationsPer24h: 10,
	runningPreparationsPerWork: 1,
	pushesPerPrPer24h: 5,
	suggestionsPerWorkPer7d: 3,
	// Added 2026-09-17 (FR-39) — the platform-wide ceiling, counted across every App Work, member and
	// organization. Operator-set; the default is deliberately non-zero and it only ever narrows.
	platformOpenedPerUpstreamPer24h: 5
} as const;
export const UPSTREAM_SIZE = {
	maxChangedLines: 1_000,
	maxFiles: 30,
	maxExtraFiles: 3,
	maxUpdateChangedLines: 500
} as const;
export const UPSTREAM_TIMEOUTS = {
	preparationMs: 90 * 60_000,
	checkCommandMs: 30 * 60_000,
	checksTotalMs: 60 * 60_000,
	maxCheckCommands: 10,
	approvalTtlMs: 72 * 3_600_000,
	branchCleanupMs: 10 * 60_000,
	deletionCascadeMs: 10 * 60_000 // FR-45: the account-deletion cascade reuses FR-33's bound.
} as const;
export const UPSTREAM_POLLING = {
	earlyIntervalMs: 30 * 60_000,
	earlyWindowMs: 7 * 86_400_000,
	lateIntervalMs: 6 * 3_600_000,
	pauseAfterInactivityMs: 90 * 86_400_000,
	batch: 100,
	maxRequestsPerRead: 4
} as const;
export const UPSTREAM_TEXT = {
	titleMax: 72,
	bodyMax: 8_000,
	guideFileMaxBytes: 64 * 1024,
	quoteMax: 300,
	reviewBriefMaxBytes: 64 * 1024,
	maxMissingPieces: 10, // FR-47/S21
	reportMaxBytes: 32 * 1024, // FR-47: the report file itself
	maxSeenReviewIds: 200 // G23: the oldest id is evicted past this
} as const;
export const UPSTREAM_EXCLUDED_GLOBS = [
	'.works/**',
	'.ever-works/**', // Added 2026-09-17 (FR-47): the report never reaches the prepared branch or the PR.
	'.github/workflows/ever-works-*',
	'**/.env*',
	'**/*.pem',
	'**/*.key'
] as const;
export const UPSTREAM_DISCLOSURE =
	'This pull request was prepared with the help of an AI agent (Ever Works) and reviewed by @{login} before it was opened.';

// Added 2026-09-17 (G04, FR-47) — the preparation run's report. Written by the Agent to
// `.ever-works/upstream-pr-report.json`, read by the workspace plugin during finalize and dropped before the
// squash commit (see §4 `reportFiles`), validated here with AJV. A missing, oversized or malformed report
// fails the preparation with `reportInvalid`; nothing is ever inferred from a partial one.
export interface UpstreamPreparationReport {
	status: 'ready' | 'aiNotAccepted' | 'dcoRequired' | 'doesNotPort' | 'tooLarge' | 'needsSignature';
	claUrl?: string; // ≤ 512, https only — the `Open the agreement` target (S17)
	projectLimitLines?: number; // the project's own smaller size limit, when its guide states one (S19)
	title?: string; // ≤ UPSTREAM_TEXT.titleMax
	body?: string; // ≤ UPSTREAM_TEXT.bodyMax, disclosure line last
	aiPolicyQuote?: string; // ≤ UPSTREAM_TEXT.quoteMax, the sentence the guide states
	aiPolicyFile?: string; // the file the quotation came from, for the link
	doesNotPort?: string[]; // ≤ UPSTREAM_TEXT.maxMissingPieces short strings (S21)
	checks: {
		command: string; // ≤ 200
		exitCode: number;
		startedAt: string; // ISO — FR-12's 30-minute-per-command and 60-minute-total bounds are checked on these
		endedAt: string;
		alreadyRedOnBase?: boolean;
		lastLines?: string[]; // ≤ 50 lines, ≤ 8 KB
	}[];
}

// Added 2026-09-17 (G11) — the API's views, referenced by T10/T19 as the DTO's field list.
export interface UpstreamEligibilityView {
	allowed: boolean;
	code?: (typeof UPSTREAM_REFUSAL_CODES)[number];
	limit?: keyof typeof UPSTREAM_LIMITS; // FR-27: which limit refused
	nextSlotAt?: string; // ISO; absent for openPerUpstream (a slot opens when one there closes)
	target: { owner: string; repo: string; baseBranch: string; forkOwner: string; forkRepo: string };
	orgFork: boolean;
	maintainerCanModifyDefault: boolean; // the member's most recent row's value, else true (FR-24)
}
export interface UpstreamPullRequestView {
	id: string;
	sourceTaskId: string;
	state: (typeof UPSTREAM_PULL_REQUEST_STATES)[number];
	upstream: { owner: string; repo: string; baseBranch: string };
	head: { owner: string; repo: string; branch: string; sha: string | null };
	number: number | null;
	url: string | null;
	title: string | null;
	body: string | null;
	disclosureText: string | null;
	maintainerCanModify: boolean;
	checksSummary: (typeof UPSTREAM_CHECKS_SUMMARIES)[number] | null;
	reviewSummary: (typeof UPSTREAM_REVIEW_SUMMARIES)[number] | null;
	signatureState: 'cla_required' | 'cla_acknowledged' | 'cla_pending_check' | null;
	refusalCode: string | null;
	refusalDetail: string | null;
	diffStats: { files: number; additions: number; deletions: number; extraFiles: string[] } | null;
	extraFilesAcknowledgedAt: string | null;
	approvalProposalId: string | null;
	approvalExpiresAt: string | null;
	openedAt: string | null;
	mergedAt: string | null;
	closedAt: string | null;
	lastUpstreamActivityAt: string | null;
	nextCheckAt: string | null;
	createdAt: string;
	updatedAt: string;
}
export interface UpstreamPullRequestDetailView extends UpstreamPullRequestView {
	diff: GitDiffResult | null; // present while awaiting approval (300 files / 1 MB, §5)
	checkResults: UpstreamPreparationReport['checks'] | null; // agent-reported (FR-47)
	missingPieces: string[] | null;
	claUrl: string | null;
}

// Added 2026-09-17 (G23) — the review shape T2 implements, with the types the rule needs.
export interface GitPullRequestReview {
	id: number;
	state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
	author: string | null;
	submittedAt: string | null;
	body: string; // ≤ 8 KB
}
```

### 3.4 Activity (Resolution R-2)

`packages/agent/src/entities/activity-log.types.ts` gains one family `APP_UPSTREAM_PR = 'app_upstream_pr'` (append
only; varchar column, no migration). Every row has `actionType = 'app_upstream_pr'` and `action` = the dotted CONTRACTS
§6 event (`app.upstream_pr.proposed`, `.approved`, `.opened`, `.updated`, `.changes_requested`, `.needs_signature`,
`.refused`, `.withdrawn`, `.merged`, `.closed`, `.suggested`); `details` carry the upstream `owner/repo`, number, URL,
state and refusal code — never a title, body or diff (FR-37). `ActivityTypeBadge` maps `app_upstream_pr` →
`appUpstreamPr`.

**Live Feed kind and per-event status (added 2026-09-17, APW09-G03, program row).** The new family needs an explicit
decision in `packages/agent/src/activity-log/feed-kind.ts` — `FEED_KIND_RULES` holds one entry per
`ActivityActionType` member and `feed-kind.spec.ts:14-19` fails until one exists (`feed-kind.ts:48-52`). The family
is a **long-running operation that becomes a delivery record**, so it takes
`app_upstream_pr: 'deliveryWhenCompleted'`: while a proposal is being prepared or opened its rows read as **work**,
and an opened, merged or closed pull request reads as **delivery**. `ActivityStatus` is set per event, so this
family-level rule and the status together put a problem row in the Live Feed's problem bucket
(`FEED_PROBLEM_STATUSES = [FAILED, CANCELLED]`, `feed-kind.ts:35-38`):

| `action`                            | `ActivityStatus` | Reads as             |
| ----------------------------------- | ---------------- | -------------------- |
| `app.upstream_pr.proposed`          | `IN_PROGRESS`    | work                 |
| `app.upstream_pr.suggested`         | `COMPLETED`      | work                 |
| `app.upstream_pr.approved`          | `COMPLETED`      | work                 |
| `app.upstream_pr.needs_signature`   | `IN_PROGRESS`    | work (it is waiting) |
| `app.upstream_pr.opened`            | `COMPLETED`      | delivery             |
| `app.upstream_pr.updated`           | `COMPLETED`      | delivery             |
| `app.upstream_pr.changes_requested` | `COMPLETED`      | delivery             |
| `app.upstream_pr.merged`            | `COMPLETED`      | delivery             |
| `app.upstream_pr.closed`            | `COMPLETED`      | delivery             |
| `app.upstream_pr.withdrawn`         | `CANCELLED`      | work → problem       |
| `app.upstream_pr.expired`           | `FAILED`         | work → problem       |
| `app.upstream_pr.refused`           | `FAILED`         | work → problem       |
| `app.upstream_pr.failed`            | `FAILED`         | work → problem       |

T6 modifies `feed-kind.ts` and extends `feed-kind.spec.ts`; T31's structural spec asserts that every event in the
table above is written with a status, so a new event cannot ship without one. `app.upstream_pr.expired` and
`app.upstream_pr.failed` are **additions** to the eleven events CONTRACTS §6 already lists for this family (asked
for in the shared-file requests): `expired` is the 72-hour TTL of FR-23/S24 and `failed` is a preparation that
errored or timed out (FR-13, FR-47) — without them a row could leave `awaiting_approval` or `preparing` with no
Activity record, which FR-37 and the Live Feed both require. No existing event is renamed, retyped or removed.

---

## 4. Contract changes (plugin SDK, additive — Constitution X)

| Change                                                                                                                                                  | Owner  | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreatePROptions.headOwner?`, `headRepo?`, `maintainerCanModify?`                                                                                       | APW-09 | GitHub: `head` = `<headOwner>:<head>` when `headOwner` is set, else `head`; `maintainer_can_modify`; `head_repo` is sent **when `headOwner === owner`** (GitHub needs it only when base and head share an owner — the fork-network case; it is omitted in every other case, including the ordinary fork cross-owner case), G23.                                                                                                                                                                                                                                                                                                                                                                                      |
| `GitPullRequest.headRepoFullName?: string \| null` (+ on `GitPullRequestStatus`)                                                                        | APW-09 | Map `data.head.repo?.full_name` in create/get/list/status; `null` when the head repository was deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ListPullRequestsOptions.head?: string` (`owner:branch`)                                                                                                | APW-09 | **Added 2026-09-17 (G17).** GitHub `head=<owner>:<branch>`; used by §9.2's recovery path and its adopt-on-422 case, both covered by T17's specs. Today the options type carries `state`/`perPage`/`page` only (`git-provider.interface.ts:262-266`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GitDiffResult.totalCommits?: number`                                                                                                                   | APW-09 | **Added 2026-09-17 (G13).** Mapped from compare's `total_commits` in `getCompareDiff` (`github-api.service.ts:1114-1121`) and in `getPullRequestDiff`; optional, so every existing caller and provider is unchanged. The verifier's `notSingleCommit` check reads it instead of inferring a commit count from a file list.                                                                                                                                                                                                                                                                                                                                                                                           |
| `listPullRequestReviews?(owner, repo, number, token): Promise<GitPullRequestReview[]>` (`GitPullRequestReview` typed per §3.3, body ≤ 8 KB, ≤ 100)      | APW-09 | `pulls.listReviews`. The review summary is the latest **non-`pending`, non-`dismissed`** review per author, with `changes_requested` beating `approved` beating `commented`; `dismissed` and `pending` never contribute (G23).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `listPullRequestReviewComments?(owner, repo, number, token)` (≤ 100, body ≤ 4 KB)                                                                       | APW-09 | `pulls.listReviewComments`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `getInteractionLimit?(owner, repo, token): Promise<'none' \| 'existing_users' \| 'contributors_only' \| 'collaborators_only' \| null>`                  | APW-09 | `interactions.getRestrictionsForRepo`. A `403`/`404` is **not** `'none'` (G16): it returns `null`, which the eligibility service reads as "cannot tell" and never as "unrestricted"; the read is retried once with the member token and, still failing, it lifts no refusal. This method answers only the **temporary interaction limit**; `pullRequestsDisabled` and `outsideContributorCap` are the repository-level control and the outside-contributor cap of spec §2.3, which are **different settings** — T5's spike (G16) pins which provider read answers each one, and the refusal codes exist whether or not the read exists (an answer of "cannot tell" refuses nothing new and keeps today's behaviour). |
| `createBranchFromSha?(owner, repo, name, sha, token)`                                                                                                   | APW-09 | `git.createRef`. APW-02 P1 implements it too (CONTRACTS §2A: whichever lands first creates them) — T3 therefore adds `packages/plugins/github/src/github.plugin.ts` to its modify list and extends tests only where APW-02 already delegated it (G17).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `updateBranchRef?(owner, repo, name, sha, { force: false }, token)`                                                                                     | APW-09 | `git.updateRef({ force: false })`; 422 not-fast-forward → typed `BranchNotFastForwardError`. Same APW-02 coordination as the row above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `WorkspaceFinalizeOptions.squashOnto?: string`                                                                                                          | APW-09 | sandbox and local workspace plugins: `git reset --soft <sha>` then the single commit; refuse when `sha` is not an ancestor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WorkspaceFinalizeOptions.reportFiles?: string[]` + `WorkspaceFinalizeResult.reports?: { path: string; content: string }[]`                             | APW-09 | **Added 2026-09-17 (G04, FR-47).** The plugin reads each listed workspace-relative file (≤ 5 paths, each ≤ `UPSTREAM_TEXT.reportMaxBytes`), returns its content and **drops it from the tree before the squash commit**, so the preparation report can neither reach the prepared branch nor the pull request. An unreadable file is reported as an absent entry, never as a failed finalize. Optional: a finalize without `reportFiles` behaves exactly as today.                                                                                                                                                                                                                                                   |
| `GitFacadeService.getMemberAccountToken`, and facade pass-throughs for every method above (returning `null`/throwing `providerUnsupported` when absent) | APW-09 | §2.3. The absent-method error is the facade's existing `GitOperationNotSupportedError` (`git.facade.ts:149-158`) thrown after materialising the plugin (`typeof impl.<method> !== 'function'`), never a bare `GitFacadeError` — the lazy-plugin proxy over-reports optional methods, so presence must be tested on the instance (G17). Mapped to refusal `providerUnsupported`, never a `500`.                                                                                                                                                                                                                                                                                                                       |

Every GitHub mapping change is covered by a spec in `packages/plugins/github/src/__tests__/` beside the existing
`github-api.service.pr-insights.spec.ts`. Every method added to `IGitProviderPlugin` is also delegated in
`packages/plugins/github/src/github.plugin.ts` (its capability methods are explicit pass-throughs,
`github.plugin.ts:285-354`), which T1 and T3 list as a **Modify** target: a service method with no facade delegation
reads as absent to the lazy proxy and would surface every call as `providerUnsupported` (G17).

**The permissions this epic needs (EXT-14).** The scopes, App permissions, fine-grained PAT permissions and webhook
events every step above requires are rows **21–24** of [`GITHUB-PERMISSIONS.md`](../GITHUB-PERMISSIONS.md) §2, with
the three rows the 2026-09-17 audit adds (the interaction-limit read, the cross-repository compare read and the
maintainer-opt-out read) supplied to that document's owner in this epic's shared-file request. The short version, and
the part that must not drift: **opening, preparing, pushing and polling an upstream pull request all use the member's
own user token — never a platform PAT and never a GitHub App installation token** (FR-24, §2.3), which is why the
App's `Pull requests: write` permission cannot be used for any of them; the classic scope is `repo` (plus `read:org`
when the fork lives in an organization). This epic subscribes to **no** upstream events at all — upstream projects
send Ever Works none, which is exactly why FR-29 polls (row 23's event cell says so).

---

## 5. API

On a new controller `apps/api/src/works/upstream-pull-requests.controller.ts` _(new)_, `@Controller('api')`, following
`apps/api/src/works/work-runs.controller.ts`. All routes JWT-guarded; the two reads call APW-01's shared
`ensureCanViewOr404(workId, userId)` (resolution R-36: another account's App Work answers **404**, while `403` stays
for a member without the required role) and the writes call `ensureCanEdit`; another account's ids answer **404**.

| Method | Path                                                                  | Body / query                       | Returns                                                                                                                                                                                         | Throttle  |
| ------ | --------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `GET`  | `/api/works/:id/upstream-pull-requests`                               | `?state`, `limit ≤ 100` (20)       | `{ data: UpstreamPullRequestView[], meta: { total } }` — the Work's rows, the caller's and every other member's alike; each row carries the author so the section can say who proposed it (G11) | default   |
| `GET`  | `/api/works/:id/upstream-pull-requests/eligibility`                   | `?taskId`                          | `UpstreamEligibilityView` — `{ allowed, code?, limit?, nextSlotAt?, target, orgFork, maintainerCanModifyDefault }` (§3.3)                                                                       | 60 / min  |
| `POST` | `/api/works/:id/upstream-pull-requests`                               | `{ taskId, maintainerCanModify? }` | `202 { id, state: 'preparing', preparationTaskId }`                                                                                                                                             | 10 / hour |
| `GET`  | `/api/works/:id/upstream-pull-requests/:prId`                         | —                                  | `UpstreamPullRequestDetailView` — view + `diff` (from compare, capped 300 files / 1 MB) when awaiting approval                                                                                  | default   |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/signed`                  | —                                  | `202` — `cla_acknowledged`, preparation resumes (once)                                                                                                                                          | 10 / hour |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/acknowledge-extra-files` | —                                  | view — records `extraFilesAcknowledgedAt` for the caller; `409 extraFilesNotPresent` when the diff has none (FR-49, G06)                                                                        | 30 / min  |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/withdraw`                | —                                  | view (`withdrawn`)                                                                                                                                                                              | 30 / min  |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/check`                   | —                                  | view (fresh poll; min 60 s between manual checks)                                                                                                                                               | 10 / min  |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/address-review`          | —                                  | `202 { followUpTaskId }`                                                                                                                                                                        | 10 / hour |
| `POST` | `/api/works/:id/upstream-pull-requests/suggestions/:taskId/dismiss`   | —                                  | `204`                                                                                                                                                                                           | 30 / min  |

**Human-only routes (XC-07).** `POST …/:prId/signed` **and** the approval decision itself
(`POST /api/agent-approvals/:id/approve|reject`, and the Inbox reply that routes to it) carry `@HumanOnly()`
(`apps/api/src/safety/decorators/human-only.decorator.ts`, enforced by `HumanActorGuard`, which admits only
`authMethod === 'session'` and records a `rail_refusals` row with reason code `non-human-actor` —
`apps/api/src/safety/guards/human-actor.guard.ts:45-70`). Publishing under a person's name is the one action in this
epic a machine must never take, and FR-21 already forbids any guardrail, autonomy mode, schedule or agent from
approving it; the guard is how that statement is enforced at the door rather than by convention. The MCP whitelist
(§5 parity table) exposes neither route, and an API-key caller receives `403` (ACC-09-35).

**Parity (XC-23).** Every route above is documented with `@ApiOperation` and a DTO, and its reach beyond the web is
one of: an MCP tool (`apps/mcp/src/openapi-tools/whitelist.ts` over the OpenAPI operations), a CLI command
(`apps/cli/src/commands/`), a chat tool, or **not exposed** with the reason. Read-only tools carry a read hint; the
one destructive tool (withdraw) is never in the whitelist's auto-approve set.

| Route                                   | MCP tool                                                                                      | CLI command                    | Chat tool                         | Notes                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------- |
| `GET …/upstream-pull-requests`          | `list_upstream_pull_requests`                                                                 | `work upstream list`           | `list_upstream_pull_requests`     | read-only; the chat tool is the one the assistant uses to answer "where is my PR?" |
| `GET …/eligibility`                     | `check_upstream_eligibility`                                                                  | `work upstream eligibility`    | `check_upstream_eligibility`      | read-only                                                                          |
| `GET …/:prId`                           | `get_upstream_pull_request`                                                                   | `work upstream show`           | `get_upstream_pull_request`       | read-only; the diff is included only while awaiting approval                       |
| `POST …/` (propose)                     | **not exposed** — a person's deliberate act; an MCP or chat tool would let an agent start one | **not exposed**                | **not exposed**                   | FR-3, FR-21; the web dialog is the only door                                       |
| `POST …/:prId/acknowledge-extra-files`  | **not exposed** — it is the human acknowledgement FR-49 records                               | **not exposed**                | **not exposed**                   | web only                                                                           |
| `POST …/:prId/signed`                   | **not exposed** — `@HumanOnly()` (XC-07)                                                      | **not exposed**                | **not exposed**                   | web only                                                                           |
| `POST …/:prId/withdraw`                 | `withdraw_upstream_pull_request` (destructive hint)                                           | `work upstream withdraw`       | **not exposed**                   | FR-33; the tool requires an explicit confirmation argument                         |
| `POST …/:prId/check`                    | `check_upstream_pull_request_now`                                                             | `work upstream check`          | `check_upstream_pull_request_now` | read-triggering, rate-limited to 10/min                                            |
| `POST …/:prId/address-review`           | **not exposed** — it dispatches an agent run                                                  | `work upstream address-review` | **not exposed**                   | 10/hour                                                                            |
| `POST …/suggestions/:taskId/dismiss`    | **not exposed**                                                                               | **not exposed**                | `dismiss_upstream_suggestion`     | FR-34                                                                              |
| approval decision (`…/approve\|reject`) | **not exposed** — `@HumanOnly()` (XC-07)                                                      | **not exposed**                | **not exposed**                   | the approvals queue and the Inbox are the only doors (FR-21, R-18)                 |

`apps/mcp/src/openapi-tools/whitelist.ts` gains the five read/withdraw/check entries above with their hints, and a
registry-parity spec fails when a route in this table has neither a whitelist entry nor a recorded not-exposed
reason (ACC-09-36).

Approval decisions use the existing `POST /api/agent-approvals/:id/approve|reject`; `approve-all` **leaves out**
`upstream_pull_request` rows (counted as `excluded` through the existing `requiresIndividualDecision`, like
`merge_pull_request`) because each needs its own reviewed decision. FR-49's acknowledgement is a **precondition** of
an affirmative decision through every door, not a screen state: the approvals service itself refuses an approve when
`diffStats.extraFiles` is non-empty and the row carries no acknowledgement, so the Inbox reply
(`packages/agent/src/inbox/inbox.service.ts:802-825`, which calls `approvals.decide` directly) is covered by the same
rule (G06).

Enabling the setting (FR-48, G07): `PATCH` is not added — the App spec is the source of truth (D3). The Upstream tab
toggle is served by `UpstreamSettingService`, which **writes the change itself** through APW-03's `commitFiles` path —
one branch plus one commit, and a setup pull request where R-4 requires one — and records the request in
`work_upstream_pr_settings` (§3.1A). APW-08's `POST /api/works/:id/evolve` stays available and is used when the
member's own Agent resolves (`APP_WORK_AGENT_RESOLVER`) and an isolated runtime exists; it is **not** on the critical
path, because it answers `409 agentRequired` / `409 noIsolatedRuntime` (APW-08 tasks T25) and the toggle must work
without it. Until the change merges the toggle shows **"Waiting for the App spec change to merge."** — read from
§3.1A, so it survives a reload. When neither write path is available the toggle answers
`409 { code: 'settingWriteUnavailable' }` and changes nothing.

Error contract: `422 { code }` for every `UPSTREAM_REFUSAL_CODES` value raised synchronously, including the seven
appended codes of §3.3 (`publishingOff`, `pullRequestsDisabled`, `outsideContributorCap`, `platformCapReached`,
`maintainerOptOut`, `deniedUpstream`, `reportInvalid`);
`409 { code: 'activeProposal', id }` for FR-5 and `409 { code: 'settingWriteUnavailable' }` for FR-48;
`429 { code: 'rateLimited', limit: keyof UPSTREAM_LIMITS, nextSlotAt? }` for FR-26 and FR-39 — `limit` is what
selects the refusal copy (FR-27) and is absent from no `429` (G10). No `422` body ever carries a token, a diff or a
repository's file content; `refusalDetail` holds at most a quoted guide sentence (≤ 300) or the provider's own
message (≤ 500), and a secret-screen match records **the pattern name only** (G13).

---

## 6. Approvals

- `AgentActionProposalActionType` gains `'upstream_pull_request'` (21 characters, fits `varchar(32)`), appended to
  `AGENT_ACTION_PROPOSAL_ACTION_TYPES`.
- `RISK_SCORER`: `upstream_pull_request` → `cross_scope` **by action type** (like merges are destructive by type), so
  no payload omission can make it self-approvable.
- `createProposal` is called with `humanDecisionRequired: true`, `agentId` = the preparation Agent, `runId`, `title`
  `Approve pull request to {upstream}: {title}` (≤ 200), `subjectKey` from `upstream-fingerprint.ts`, payload display
  fields only (`upstreamPullRequestId`, workId, target, head, counts). The decision is **bound by `subjectKey`**,
  never by payload — same rule as `merge_pull_request`.
- **The proposal and the preparation Agent both belong to the proposing member (added 2026-09-17, G08).**
  `createProposal` only ever accepts an Agent owned by the caller (`agent-approvals.service.ts:156-163`), and every
  run of this epic is member-scoped (FR-24), so the two can never be different people. The Agent is resolved with
  `APP_WORK_AGENT_RESOLVER.resolve({ userId: member, workId })` (APW-08's rule, R-21) and, when it answers `null`,
  preparation is refused `409 { code: 'agentRequired' }` with the existing message — FR-35's "any member with edit
  access" remains true, and each such member proposes under their **own** Agent and their own GitHub connection.
- `approve-all` leaves the type out (§5): `requiresIndividualDecision` returns `true` for it, so it is counted
  `excluded`. `AgentApprovalsService` gains `expire(proposalId)` → `status 'rejected'`,
  `decidedVia 'expired'` (additive union member), used by the status job at 72 h. **`expire` fires no decided
  event** (it is not a decision by anybody, and the proposal was never approvable in bulk), and the listener
  therefore branches on `decidedVia === 'expired'` → row state `expired` with Activity
  `app.upstream_pr.expired`; a human rejection (or `guardrail`) keeps its existing mapping to `withdrawn`.
- Trust ladder (AW-24; binding as Resolution R-18): the proposal table `PROPOSAL_ACTION_CATEGORY` in
  `packages/agent/src/safety/guardrail-interop.ts` gains one appended row,
  `upstream_pull_request: 'publish.external'` — the `publish` rung. `applyLadderToGuardrailDecision` then makes an
  enforced `off` rung **block** the proposal (`decidedVia: 'guardrail'`, row → `refused` / `publishingOff`), and `draft` / `ask` keep it
  queued; `auto` has no effect because `humanDecisionRequired` already forbids auto-approval. The edit is append-only
  — no existing key is changed or reordered — and AW-24 P2's own appended action types are unaffected. `blocked`
  keeps its own meaning (the provider refused the account) and its own copy; the ladder refusal gets `publishingOff`
  because "GitHub refused: your account can't open pull requests" is not what happened (G10).
- Never approvable in bulk (R-18): `requiresIndividualDecision` in
  `packages/agent/src/agent-approvals/agent-approvals.service.ts` returns `true` for `upstream_pull_request`, so
  `approveAll` counts it `excluded` and the web approvals queue offers no bulk action for it.
- **Entitlement, kept additive (G08).** Approvals are decided by their owner and nobody else: `decide` resolves the
  proposal through `requireOwned(userId, id)` (`agent-approvals.service.ts:318-326, 499-505`) and stamps
  `decidedById = userId` (`:449-464`), so a decision by another account is a `404` and `decidedById` always equals
  the author. The listener's existing guard — `event.decidedById === row.userId`, else the row stays
  `awaiting_approval` and Activity records **"Only @{login} can approve publishing under their name."** — is
  **kept** as written, with one correction: it must **not** insert a second proposal, because
  `UNIQUE (actionType, subjectKey)` (`agent-action-proposal.entity.ts:128`) already holds the row for this
  fingerprint, so a re-open would collide. It instead re-raises the **same** proposal through the approvals service's
  existing re-open path when that path exists, and otherwise leaves the row `awaiting_approval`, notifies the author
  and records the refusal — which is what ACC-NEG-06's non-author case asserts. Nothing that a non-author could do
  yesterday becomes possible or impossible here; the branch simply stops claiming a second proposal.

---

## 7. Background work

| Job id               | File                                                                  | Trigger                       | Behaviour                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream-pr-status` | `packages/tasks/src/tasks/trigger/upstream-pr-status.task.ts` _(new)_ | cron `3-59/10 * * * *`        | ≤ 100 due rows (`state='open' AND nextCheckAt <= now`, oldest first); expire approvals past TTL; delete fork branches of terminal rows (`forkBranchDeletedAt IS NULL`); ≤ 4 provider requests per PR. |
| `upstream-pr-open`   | `packages/tasks/src/tasks/trigger/upstream-pr-open.task.ts` _(new)_   | `UPSTREAM_PR_OPEN_DISPATCHER` | CAS `awaiting_approval → opening`; re-verify fingerprint, TTL, eligibility, limits; open; `opening → open` or `refused`. 1 retry on 5xx only.                                                         |
| `upstream-pr-push`   | `packages/tasks/src/tasks/trigger/upstream-pr-push.task.ts` _(new)_   | `UPSTREAM_PR_PUSH_DISPATCHER` | Fingerprint + push limit + signature gate; fast-forward; record.                                                                                                                                      |

**Preparation deadline sweep (added 2026-09-17, G14).** The same `upstream-pr-status` tick additionally selects
`state='preparing'` rows through `idx_upr_preparing_started (state, preparationStartedAt)` (§3.1) and times one out
when `now − preparationStartedAt − preparationPausedMs > UPSTREAM_TIMEOUTS.preparationMs`, on **running** time only
(FR-13). The clock is maintained by the preparation service from APW-08's `classifyAppWorkRunStop` (APW-08 T46): a
`wait` — the workspace stop or an Agent/workspace pause — sets `preparationHeldSince` and leaves the row `preparing`;
the release adds `now − preparationHeldSince` to `preparationPausedMs` and clears it. A held row is therefore never
timed out, and a row that has genuinely spent 90 running minutes becomes `failed` with `timedOut` and Activity
`.failed`, exactly as FR-13 requires.

**Kill switches, deny list and opt-out (added 2026-09-17, XC-10/XC-22).** The dispatchers themselves — not the
endpoints that create work — read the operator switches, so an off switch fails closed whatever door the work came
through: `UPSTREAM_PR_OPEN_DISPATCHER` and `UPSTREAM_PR_PUSH_DISPATCHER` refuse when
**`EVER_WORKS_APP_UPSTREAM_PRS_ENABLED`** is `false` (resolution R-30 — the binding name and the binding default,
which is **`true`**: the family runs unless an operator turns it off; CONTRACTS §7), the status job dispatches no poll
when it is off, and `UpstreamPreparationService.start` refuses `disabled` before it creates a row. The denial check
(FR-41) is read once per eligibility evaluation and once again immediately before opening (§5), and the maintainer
opt-out (FR-40) is read from the same repository read the eligibility service already performs — both additive to
every existing refusal, neither replacing one.

**Account and organization deletion (added 2026-09-17, XC-14).** APW-01's `APP_WORKS_ACCOUNT_DELETION` handler calls
this epic's `stopTrackingForUser(userId)` / `stopTrackingForOrganization(organizationId)`: every row authored by
that member goes terminal, `nextCheckAt` is cleared so no poll is scheduled, in-flight open/push dispatches are
cancelled, fork branches this epic created are deleted within `UPSTREAM_TIMEOUTS.deletionCascadeMs`, and the
credential of record (FR-43) stops being used. Nothing upstream is edited, closed or deleted (FR-32); the rows
themselves are removed with the account by the platform's cascade.

Dispatchers `packages/agent/src/tasks/upstream-pr-open-dispatcher.ts` and `upstream-pr-push-dispatcher.ts` _(new)_ —
interface + `Symbol()` token, **propagating** dispatch errors (a dropped open leaves a row in `awaiting_approval`
that the status job re-dispatches after 15 minutes when its proposal is approved); symbols added to
`TASKS_BARREL_RUNTIME_SYMBOLS` in `packages/agent/src/tasks/_tasks-symbols.ts` and exported from
`packages/agent/src/tasks/index.ts`; bound through `buildJobRuntimeProviders` like every other dispatcher
(Constitution IV). Endpoints return `202`.

Preparation needs no dedicated job: it is a Task run dispatched through `TaskTransitionService.dispatchAgentRun`,
and verification runs inside finalize (§2.5).

---

## 8. Web

| Component                     | File                                                                                                                                                                                                           | Type   | Notes                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream tab page             | `apps/web/src/app/[locale]/(dashboard)/works/[id]/upstream/page.tsx` (created by APW-02 T30 — modified here)                                                                                                   | server | Resolution R-8: APW-02 creates the one route `/works/:id/upstream` with its relation card, readiness, sync status and Actions hygiene; this epic only appends the **Upstream pull requests** section below them, fetching its list beside APW-02's `GET /api/works/:id/upstream` in `Promise.all`.                                                                                     |
| UpstreamPullRequestsSection   | `apps/web/src/components/works/detail/upstream/UpstreamPullRequestsSection.tsx` _(new)_                                                                                                                        | client | Toggle, list rows, state/checks/review chips, **Check now**, **Withdraw**, empty state, the private-copy notice, and the paused-by-platform (FR-46) and credential-paused (FR-43) banners.                                                                                                                                                                                             |
| `UpstreamApprovalReview`      | `apps/web/src/components/works/detail/upstream/UpstreamApprovalReview.tsx` _(new)_                                                                                                                             | client | Target/head, title, body, diff (reuses `PullRequestDiffPanel` rendering from `apps/web/src/components/works/detail/pull-requests/`), checks, notes, extra-files tick, links to the approval decision. The tick posts `…/acknowledge-extra-files` (§5) and is what unlocks **Approve and open** — the API enforces the same rule, so hiding it here would not be a bypass (FR-49, G06). |
| ProposeUpstreamDialog         | `apps/web/src/components/tasks/ProposeUpstreamDialog.tsx` _(new)_                                                                                                                                              | client | Eligibility fetch, target, maintainer-edit checkbox (org-fork variant), limits line.                                                                                                                                                                                                                                                                                                   |
| Task action                   | `apps/web/src/components/tasks/TaskDetailClient.tsx` (modified)                                                                                                                                                | client | **Propose upstream** when eligible or disabled-with-reason.                                                                                                                                                                                                                                                                                                                            |
| Tab entry                     | none — APW-02 T30 adds the `Upstream` entry to `apps/web/src/components/works/detail/WorkTabs.tsx` and `ROUTES.DASHBOARD_WORK_UPSTREAM` (R-8)                                                                  | —      | This epic changes neither file.                                                                                                                                                                                                                                                                                                                                                        |
| Inbox and approvals rendering | `apps/web/src/components/inbox/InboxDecisionDetail.tsx`, `apps/web/src/components/approvals/ApprovalsQueue.tsx`, `apps/web/src/lib/api/agent-approvals.ts`, `apps/web/src/lib/api/agents.shared.ts` (modified) | client | The `upstream_pull_request` action type joins the web unions; the approval item links to `UpstreamApprovalReview`; the queue never offers it to bulk approval (R-18). The review, signature and suggestion notices use the Inbox notice kind **with actions** (§8.2), not a bare notice.                                                                                               |
| Client + actions              | `apps/web/src/lib/api/upstream-pull-requests.ts`, `apps/web/src/app/actions/works/upstream-pull-requests.ts` _(new)_                                                                                           | —      | Typed mirror; `revalidatePath` on the Work routes.                                                                                                                                                                                                                                                                                                                                     |

### 8.2 Inbox notices carry actions and reach their review (added 2026-09-17, G12)

The Inbox producer port's notice input is `{ title, body, agentId?, agentRunId?, taskId?, workId?, organizationId?,
notify? }` (`packages/agent/src/inbox/inbox-producer.port.ts:79-101`) — no actions, no links, no message keys — so
S6's **Address review** / **Open on GitHub**, S9's **Propose** / **Dismiss** and S17's **Open the agreement** /
**I've signed it — continue** have nowhere to live, and a title stored as text cannot be translated by
`dashboard.inbox.upstream.*` (FR-36). T36 extends the port **additively**:

- `InboxNoticeInput.messageKey?: string` + `params?: Record<string, string>` — the preferred form: the Inbox stores
  the key and its values and the client renders `dashboard.inbox.upstream.*`, so the notice is translatable like
  every other string. `title`/`body` are untouched for every existing producer.
- `InboxNoticeInput.actions?: { id: string; labelKey: string; href?: string; apiAction?: { path: string; body?:
Record<string, unknown> } }[]` — at most 2, rendered by `InboxDecisionDetail`. `href` is an external link
  (`https` only, the pull request itself); `apiAction` posts to an Ever Works route and revalidates it.
- `InboxProposalInput` for `upstream_pull_request` carries `payload.workId` and `payload.upstreamPullRequestId`, so
  the approval item can link to its review. Today the mirror carries `taskId` **only** for `merge_pull_request`
  (`agent-approvals.service.ts:233-240`); the two upstream fields are platform-derived exactly as that one is.
- The review is mounted at **`/works/:id/upstream?review=<prId>`** — APW-02's one Upstream route (R-8) with a query
  parameter that opens `UpstreamApprovalReview` for that row. The Inbox approval item and the list's **Review**
  button both link there. The route owns no page of its own (this epic still creates no page).

### 8.3 Keyboard and accessibility (added 2026-09-17, XC-25/FR-42)

Every component above meets FR-42's bar and each is covered by a Playwright a11y check in T24's lane: an axe scan
with no new violations; state chips carrying text (never colour alone); keyboard reachability with a visible focus
ring for the toggle, the dialog, the approval and its tick, and the list's **Review**, **Check now** and
**Withdraw**; `Esc` closing the dialog and the approval returning focus to the control that opened it; **Preparing**,
**Opening**, a new review and a refusal announced in a polite live region; and an `ar`/`he` render without clipped
chips or mirrored controls. The surfaces are named in ACC-09-30 so the check cannot silently disappear.

### 8.1 i18n

Keys under `apps/web/messages/en.json`, camelCase leaves, no literal dots; mirrored to the 20 sibling locales. Paths:

The tab label `dashboard.workDetail.upstream.tabName` belongs to APW-02 (R-8); this epic adds its leaves beside it.

- `dashboard.workDetail.upstream`:
    - `toggle` — "Propose changes upstream"
    - `toggleHelp` — "You approve every pull request before it is sent. Limits: 1 per day per project."
    - `togglePending` — "Waiting for the App spec change to merge."
    - `empty` — "No upstream pull requests yet. Propose one from a merged Task."
    - `linkRelation` — "This repository is the project itself — your Tasks' pull requests already go to it." (shown
      only when the route is opened directly for a link App Work; APW-02 lists no tab for links)
    - `privateCopy` — "A private copy isn't connected to {upstream} on GitHub, so it can't propose pull requests
      there. Use a fork to contribute."
    - `checkNow` — "Check now"
    - `trackingPaused` — "Tracking paused — no activity for 90 days."
    - `mergedNote` — "The next upstream sync will bring this change back into your fork."
    - `openOnGithub` — "Open on GitHub"; `withdraw` — "Withdraw"; `review` — "Review"
    - `pausedByPlatform` — "Upstream pull requests are paused by the platform." (FR-46)
    - `credentialPaused` — "Waiting for {member} to reconnect GitHub."; `credentialHandover` — "Hand over this App
      Work's GitHub connection" (FR-43)
    - `acknowledgeExtra` — "I've reviewed the extra files"; `acknowledgeRequired` — "Review the extra files before
      approving." (FR-49)
    - `agentReported` — "Reported by the preparation agent." (FR-47)
- `dashboard.workDetail.upstream.states`: `preparing`, `needsSignature`, `awaitingApproval`, `opening`, `open`,
  `merged`, `closed`, `refused`, `failed`, `expired`, `withdrawn` (copy per spec §6.1).
- `dashboard.workDetail.upstream.checks`: `passing`, `failing`, `pending`, `waitingForMaintainers`, `unknown`.
- `dashboard.workDetail.upstream.reviews`: `approved`, `changesRequested`, `commented`.
- `dashboard.workDetail.upstream.refusals`: one key per `UPSTREAM_REFUSAL_CODES` value — **30 after the 2026-09-17
  additions** (copy per spec §6.5) — and `dashboard.workDetail.upstream.limits`: one key per `keyof UPSTREAM_LIMITS`
  (including `openPerUpstreamCeiling`, `platformOpenedPerUpstreamPer24h`, `runningPreparationsPerWork`), which is what
  a `429 { limit }` renders (FR-27, G10). `dashboard.workDetail.upstream.errors.activeProposal` is the `409`'s copy.
- `dashboard.tasksPage.proposeUpstream`: `action`, `dialogTitle`, `to`, `change`, `explainer`, `nothingSent`,
  `maintainerEdits` ("Allow maintainers to edit this pull request"), `orgForkNote`, `limits`, `prepare`, `cancel`,
  `preparingRow`, `settingWriteUnavailable`.
- `dashboard.inbox.upstream`: `approvalTitle`, `changesRequested`, `signature`, `openAgreement`, `signedContinue`,
  `suggestion`, `propose`, `dismiss`, `merged`, `closed`, `onlyAuthorCanApprove`. The Inbox notices are rendered from
  `messageKey` + `params` (T36, §8.2), not from stored English text, so these keys are the notice bodies.
- `dashboard.workDetail.upstream.approval`:
    - `title` — "Open a pull request on {upstream}?"
    - `updateTitle` — "Push {count} commits to {upstream} #{number}?"
    - `expiresIn`, `asMember`, `maintainersCanEdit`, `titleLabel`, `descriptionLabel`, `diffLabel`, `checksLabel`,
      `notesLabel`, `followsTemplate`, `includesDisclosure`
    - `notInOriginal` — "Not in the original change"; `reviewedExtra` — "I've reviewed the extra files"
    - `alreadyFailing` — "Already failing on {upstream}:{branch}"
    - `approveOpen` — "Approve and open"; `approvePush` — "Approve and push"; `reject` — "Reject"
    - `stale` — "The proposal changed after you approved it. Review it again."
    - `agentReported` — "Reported by the preparation agent." (FR-47)
- `dashboard.activity.filters.types.appUpstreamPr` — "Upstream pull request" (the `ActivityTypeBadge` label, R-2).

---

## 9. Telemetry and failure modes

### 9.1 Events (counters and ids only — never titles, bodies, diffs, logins or repository names)

- `upstream_pr.proposed { workId, taskId }`
- `upstream_pr.refused { code, phase: 'eligibility' | 'verification' | 'open' }`
- `upstream_pr.approval_decided { outcome, hoursToDecision }`
- `upstream_pr.opened { minutesApprovalToOpen }`
- `upstream_pr.review { summary }`
- `upstream_pr.final { outcome: 'merged' | 'closed', daysOpen }`
- `upstream_pr.status_sweep { scanned, changed, failed, providerRequests }`

Names and property types live in `packages/monitoring/src/posthog/upstream-pr-events.ts` _(new, modelled on
`kb-events.ts`)_, whose emitter strips the keys `title`, `body`, `diff`, `login`, `owner`, `repo`, `repository`
before calling `capture` — stripped in dev (with a warning) and in production (silently), thrown only under
`NODE_ENV=test`, which is `kb-events.ts`'s `scrubPayload` behaviour (`:205-235`) and the reason the emitter is
modelled on it (G21). The services of this epic do **not** import the package: `@ever-works/agent` does not depend on
`@ever-works/monitoring` (`packages/agent/package.json`), so they take an injectable `UPSTREAM_PR_TELEMETRY` port
(`packages/agent/src/upstream-pull-requests/upstream-pr-telemetry.port.ts` _(new)_) which `apps/api` binds to
`emitUpstreamPrEvent` and which no-ops when unbound — the in-repo precedent injects its client the same way
(`knowledge-base-reconcile.service.ts:61-106`).

### 9.2 Failure modes

| Failure                                                        | Behaviour                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBranchFromSha` rejects an upstream sha in the fork      | `failed` with `providerUnsupported`; T5's spike (a) proves the network-object behaviour before P2 starts; fallback is APW-02's `syncForkBranch?` onto a platform-managed mirror branch.                                                        |
| Provider lacks any optional method used                        | `refused` / `providerUnsupported` from `GitOperationNotSupportedError` (`git.facade.ts:149-158`); the Upstream tab shows the feature as unavailable for this provider.                                                                         |
| Member token missing `repo` scope / revoked                    | `connectionScope`; no fallback to any other token, ever.                                                                                                                                                                                       |
| The credential of record is unusable (FR-43)                   | Background jobs pause with **"Waiting for {member} to reconnect GitHub."** and the handover action; nothing upstream is touched, and contribution runs still use the publishing member's own token.                                            |
| Open succeeds but recording fails                              | Next status tick finds the PR by `listPullRequests({ state: 'all', head: 'fork:branch' })` (`ListPullRequestsOptions.head`, §4) and repairs the row; **T17 tests both halves** (G17).                                                          |
| Provider 422 "a pull request already exists"                   | Adopt the existing PR only if its head repo and branch equal the row's; else `refused`. **T17 tests the adopt case** (G17).                                                                                                                    |
| Provider 403/422 outside-contributor cap or collaborators-only | `refused` / `outsideContributorCap` when the provider names its outside-contributor cap, else `collaboratorsOnly`; the message carries the provider reason (≤ 500 chars, no token). T5's spike (b) and (c) pin which read answers which (G16). |
| Pull requests switched off at the repository level             | `refused` / `pullRequestsDisabled` (spec §6.5's own copy, distinct from `collaboratorsOnly` and from `blocked`); preparation refuses before any branch is created.                                                                             |
| The project asks not to receive automated contributions        | `refused` / `maintainerOptOut` (FR-40) with the evidence the platform read; nothing is prepared.                                                                                                                                               |
| The upstream is on the operator deny list                      | `refused` / `deniedUpstream` (FR-41); existing rows stop polling and read **Refused** with the operator reason.                                                                                                                                |
| The platform-wide per-upstream ceiling is reached              | `429 { code: 'rateLimited', limit: 'platformOpenedPerUpstreamPer24h', nextSlotAt }` — refused even when the member's own allowance remains (FR-39).                                                                                            |
| Publishing is switched off in the member's autonomy settings   | `refused` / `publishingOff` (the `off` rung, §6) — no longer reported as `blocked`, whose copy is the provider's own refusal.                                                                                                                  |
| The preparation report is missing, oversized or malformed      | `failed` / `reportInvalid` (FR-47); nothing is proposed and the report never reaches the branch (`reportFiles`, §4).                                                                                                                           |
| Upstream head moved between approval and open                  | Open anyway (the diff is fixed by our head sha); GitHub reports mergeability; conflicts surface as review, not as a platform retry.                                                                                                            |
| Fork deleted                                                   | Row → `closed` on the next read (`headRepoFullName = null` and PR closed) or tracking continues if PR remains.                                                                                                                                 |
| Status read 404 (upstream deleted/private)                     | `closed` with `refusalDetail "The upstream repository is no longer reachable."`; polling stops.                                                                                                                                                |
| Dispatch fails after approval                                  | Propagates; status job re-dispatches approved-but-`awaiting_approval` rows after 15 minutes.                                                                                                                                                   |
| A preparation overruns 90 minutes of running time              | The status tick's `preparing` sweep fails the row with `timedOut`; a held row is never selected (FR-13, G14).                                                                                                                                  |
| A member's account or organization is deleted                  | Tracking stops, dispatches are cancelled, the fork branches this epic created are deleted within 10 minutes, and nothing upstream is edited (FR-45, G14's cascade).                                                                            |
| Either operator control is off (FR-46, FR-41)                  | The dispatchers read it themselves and fail closed — no preparation, open, push, poll or suggestion — and every surface stays readable (§7).                                                                                                   |

---

## 10. Test plan

### 10.1 Unit (agent package, Jest) — `packages/agent/src/upstream-pull-requests/__tests__/` _(new)_

`upstream-eligibility.rules.spec.ts` (every relation/setting/state/limit branch, `nextSlotAt`, `maxOpen` vs the
ceiling, the platform ceiling, the deny list, the `limit` key), `upstream-rate-limits.spec.ts` (24 h windows at
boundaries), `upstream-fingerprint.spec.ts` (each field changes the fingerprint), `upstream-preparation.verifier.spec.ts`
(exclusions incl. renames, extra files ≤ 3 and directory rule, size and project limit, secrets by pattern name only,
`totalCommits`, red-on-base, a truncated compare, the report's caps),
`summarize-upstream-checks.spec.ts` (`action_required` → waiting; CLA names excluded; empty → unknown; the review
summary rule and the 200-id eviction), `packages/agent/src/facades/__tests__/git.facade.member-token.spec.ts` (platform PAT and installation paths
never invoked; an absent optional method raises `GitOperationNotSupportedError`),
`upstream-approval.listener.spec.ts` (non-author decision ignored and no second proposal; `expired` → `expired`;
rejected → withdrawn + cleanup; idempotent re-delivery), `upstream-open.service.spec.ts` (the extra-files gate, the
`limit` key on a `429`, the lost-open recovery and the adopt-on-422 case),
`upstream-status.service.spec.ts` (cadence, pause at 90 days, one notice per review, merged/closed stop, the
`preparing` overrun sweep), `upstream-review-follow-up.service.spec.ts` (no `createPullRequest` for a follow-up;
non-fast-forward refusal), `upstream-setting.service.spec.ts` (the deterministic write path, the pending state, the
no-Agent and no-write-path cases), `upstream-signature.spec.ts` (CLA → `needs_signature`, one resume, DCO →
`refused/dcoRequired`, no sign-off ever), `upstream-suggestion.service.spec.ts` (nothing prepared before **Propose**;
1 per Task, 3 per App Work per 7 days; a dismissed Task is not re-offered; a hand-added label sends nothing),
`upstream-preparation.holds.spec.ts` (R-17: a parked run pauses the 90-minute clock; a rail refusal keeps the row
`preparing`; a released hold resumes it), `upstream-operator-policy.spec.ts` (both switches fail closed at the
dispatcher), `upstream-credential.service.spec.ts` (the credential of record, its pause and its handover),
`upstream-budget.spec.ts` (a run over the App Work's budget waits and opens nothing),
`upstream-deletion.handler.spec.ts` (tracking stops, branches go, nothing upstream is edited),
`upstream-pr-telemetry.spec.ts` (an unbound port no-ops), and the structural spec `no-merge-no-comment.spec.ts`
asserting no module in the folder references `mergePullRequest`, `closePullRequest` or `createPullRequestComment`,
that every event written has an `ActivityStatus` in §3.4's table, and that no source routes finalize by a Task label.

### 10.2 Plugin (Vitest)

`packages/plugins/github/src/__tests__/github-api.service.cross-repo.spec.ts` _(new)_ — head owner composition,
`maintainer_can_modify`, `head_repo` for a same-owner head only, `headRepoFullName` mapping on all four reads,
`totalCommits`, the `head=` list filter, reviews (all five states), review comments, interaction limits (404/403 →
`null`), `createBranchFromSha`, `updateBranchRef` fast-forward only. Workspace plugins: `squashOnto` specs beside
`packages/plugins/sandbox-workspace/src/` and `packages/plugins/local-workspace/src/` existing specs, extended with
`reportFiles` (the report comes back in `reports` and is absent from the commit). The fake GitHub's contract test
gains the upstream endpoints of T45.

### 10.3 API (Jest)

`apps/api/src/works/upstream-pull-requests.controller.spec.ts` _(new)_ — every route, codes (incl. the seven appended
refusal codes and `429 { limit }`), 404s, throttles, the acknowledgement route, the human-only refusals;
`apps/api/src/migrations/__tests__/CreateUpstreamPullRequests.spec.ts` _(new)_; approvals, extending
`packages/agent/src/agent-approvals/__tests__/agent-approvals.service.spec.ts` and `risk-scorer.spec.ts`: `approve-all`
excludes the type; `RISK_SCORER` flags it cross-scope with an empty payload; extending
`packages/agent/src/agents/__tests__/guardrails.ladder-interop.spec.ts`: `PROPOSAL_ACTION_CATEGORY.upstream_pull_request`
is `publish.external`, every pre-existing key unchanged, an enforced `off` rung → `block` (R-18); extending
`packages/agent/src/safety/guards/human-actor.guard.spec.ts` with the API-key refusal. No suite is added under
`apps/api/test/` (R-22).

### 10.4 e2e (Playwright)

| File                                                       | Golden path                                                                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/e2e/app-works-upstream-tab.spec.ts` _(new)_      | The pull requests section on APW-02's Upstream tab for a fork and a private copy (no tab for a link); toggle pending copy; list states and chips.                      |
| `apps/web/e2e/app-works-propose-upstream.spec.ts` _(new)_  | Task action → dialog → preparing row → approval review (provider mocked at the plugin boundary) → approve → open row; extra-files tick gating; stale fingerprint copy. |
| `apps/web/e2e/app-works-upstream-refusals.spec.ts` _(new)_ | Archived, rate-limited (next slot time), signature, AI-not-accepted copy.                                                                                              |

---

## 11. Phasing

### P1 — Foundations (Wave 1)

Plugin/facade contract additions (§4) with specs, `getMemberAccountToken`, entity + migration + contracts types,
`summarizeUpstreamChecks`, eligibility rules and `GET …/eligibility`, read-only list endpoint, the `createBranchFromSha`
spike. **Ships value alone**: the Task action renders its true eligibility; nothing is sent.

### P2 — Prepare, approve, open, track (Wave 2)

Preparation service + finalize branch + verifier, approval type + risk flag + listener, open job, status job,
Upstream tab, dialog, approval review, Inbox items, i18n, e2e. `upstream-contribution` Skill published to
`ever-works/skills`. The 2026-09-17 audit additions land inside these same phases and change no phase boundary:
T36–T45 (Inbox actions, the report contract, human-only routes, the switches and deny list, parity, the a11y lane,
the deletion cascade, the credential of record, the budget and the fake GitHub's upstream endpoints) all belong to
P2 except the two suggestions-era pieces T28 already places in P3.

### P3 — Reviews and suggestions (Wave 2)

Review follow-ups with push approvals and fast-forward, signature acknowledgement flow, agent suggestions (with a
`suggestUpstreamContribution` Agent tool that records the suggestion server-side in `upstream_pr_suggestions` — the
Task label `upstream-candidate` is display only, G18 — and is offered only on fork App Works with proposals on).

**Wave placement (unchanged, and the reason the epic's own text is consistent about it).** P1 is **Wave 1**; P2 and
P3 are **Wave 2**. That is the placement the spec's `**Program**:` line states, the placement
[`ACCEPTANCE.md`](../ACCEPTANCE.md)'s wave table uses for ACC-09-02, 03, 12, 14, 15, 17 and 23 (Wave 1) and for
ACC-E2E-08 (Wave 2), and the placement [`TRACKER.md`](../TRACKER.md)'s merge-order step 2 and [`README.md`](../README.md)
§4's Wave 1 row already carry. Nothing in this epic moves a phase between waves; the audit additions listed under
P2 above are inside Wave 2 and therefore add no new wave slot.

---

## 12. Constitution compliance checklist

- [x] **I — Plugin-first.** All provider work goes through `GitFacadeService` and `WorkspaceFacadeService`; every new
      provider method is an optional addition to the existing git and workspace capabilities.
- [x] **II — No hard-coded plugin ids.** No plugin id appears in core; the member token is resolved by provider id
      passed in, never a literal.
- [x] **III** — The enable switch lives in the App spec; the database stores proposal, tracking, in-flight setting and
      suggestion state only (§3.1A/§3.1B never hold a setting, only the request for one).
- [x] **IV** — Open, push and status are dispatched/scheduled jobs; endpoints return `202`.
- [x] **V** — Additive migrations in block `1792090000000`, slots 00–02; each `up()` guarded and each `down()` dropping
      only what its own `up()` added.
- [x] **VI** — Unit, plugin, API and e2e specs named in §10, including the structural "never merges", "member token
      only" and "no finalize by label" specs.
- [x] **VII** — Only the member's token is used and never stored on the row, logged or returned; bodies and diffs are
      screened with `scanForSecrets` and a match stores the pattern name only; the preparation report never reaches the
      branch; telemetry carries no content.
- [x] **VIII** — No plugin added.
- [x] **IX** — Names and paths live in this plan only.
- [x] **X** — Contract additions are optional fields/methods; `createPullRequest` behaves identically without the new
      fields.
- [x] **Program rules 9 and 10** — Upstream guides, templates, review comments and the preparation report are fenced
      untrusted content; no third-party product or vulnerability named.
- [x] **Program resolutions (CONTRACTS §0)** — R-1 types in `packages/contracts/src/apps/` (§3.3); R-2 Activity family
      `app_upstream_pr` (§3.4); R-4 the first write into the Work Repository (§5, FR-48); R-8 one Upstream tab created
      by APW-02 (§8); R-17 holds and rail refusals (§2.5); R-18 `publish` rung, `off` blocks, never bulk-approvable
      (§6); R-22 no `apps/api/test/` suites (§10); R-25 every table classified (§3.2, T35); R-26 additive-only (every
      2026-09-17 change appends and none renames or removes an id); R-27 the deploy-shape family is untouched by this
      epic.

---

## 13. Security and permissions (added 2026-09-17, SK-16)

Every route of §5 is JWT-guarded and scoped through `WorkOwnershipService`: **view** for the two reads (through
APW-01's `ensureCanViewOr404`, R-36), **edit** for every write, and a foreign Work id answers `404` (never `403`,
ACC-09-23). No route in this epic is `@Public`, none creates a scope or a role, and none is `@DelegatedRead` (a
delegated Ever ID token must not reach any of them — `R-19` admits delegated tokens only on routes marked with that
decorator, and ACC-09-35 additionally refuses a non-session actor on the two human-only ones; R-32 binds those two).

| Route                                                      | Who may call it                                      | Throttle  | Validating DTO          | Secret fields |
| ---------------------------------------------------------- | ---------------------------------------------------- | --------- | ----------------------- | ------------- |
| `GET …/upstream-pull-requests`                             | view access to the App Work                          | default   | `ListUpstreamQueryDto`  | none          |
| `GET …/upstream-pull-requests/eligibility`                 | view access                                          | 60 / min  | `EligibilityQueryDto`   | none          |
| `GET …/upstream-pull-requests/:prId`                       | view access                                          | default   | —                       | none          |
| `POST …/upstream-pull-requests`                            | **edit** + FR-3's GitHub condition                   | 10 / hour | `ProposeUpstreamDto`    | none          |
| `POST …/:prId/acknowledge-extra-files`                     | **edit**, the proposal's author                      | 30 / min  | —                       | none          |
| `POST …/:prId/signed`                                      | **edit** + `@HumanOnly()` (session only)             | 10 / hour | —                       | none          |
| `POST …/:prId/withdraw`                                    | **edit**, the proposal's author                      | 30 / min  | —                       | none          |
| `POST …/:prId/check`                                       | **edit**                                             | 10 / min  | —                       | none          |
| `POST …/:prId/address-review`                              | **edit**                                             | 10 / hour | —                       | none          |
| `POST …/suggestions/:taskId/dismiss`                       | **edit**, the member the suggestion was sent to      | 30 / min  | —                       | none          |
| `POST /api/agent-approvals/:id/approve\|reject` (existing) | the proposal's owner + `@HumanOnly()` (session only) | unchanged | unchanged               | none          |
| `POST /api/works/:id/upstream/credential/handover` (T43)   | **edit**                                             | 10 / hour | `CredentialHandoverDto` | none          |

**No secret ever crosses this epic's boundary.** The member's GitHub token is resolved per call
(`getMemberAccountToken`, §2.3), passed as `options.token`, never stored on a row, never logged and never returned;
`refusalDetail` holds at most a quoted guide sentence or the provider's own message; a secret-screen match records
the pattern name only (G13); the preparation report is read by the workspace plugin and dropped before the commit
(§4); and the telemetry emitter strips content keys before `capture` (§9.1). The only `https` URLs the API returns
are ones the provider itself supplied — the pull request URL and the agreement link — and both are validated as
`https` before storage. `x-secret` fields: none — no request or response in this epic carries one.

**The program's two normative registers (resolution R-37).** This epic owns rows **T-27** (publishing upstream in a
member's name without that member's decision), **T-28** (the prepared diff carries secrets, the App spec, platform
workflows or unrelated fork customisations), **T-29** (maintainers flooded — the programme becomes a spam source) and
**B-9** (upstream repositories ← pull requests sent in the member's name) of the §10 threat register, each mapped to
the control above and to its verifying ACC; and its three background jobs — `upstream-pr-status`, `upstream-pr-open`
and `upstream-pr-push` — are the APW-09 rows of §11's operational signals, whose named alerts
(`app_upstream_pr_poll_failing` on ≥ 5 consecutive poll failures being the one already recorded) are implemented by
T18's and T26's tasks. [`THREAT-MODEL.md`](../THREAT-MODEL.md) carries the same rows with their residual risk.

---

## 14. Risks and mitigations (added 2026-09-17, SK-16)

| Risk                                                                                               | Likelihood  | Impact   | Mitigation                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A prepared branch is squashed onto the fork's head, so every preparation is refused                | was certain | high     | `upstreamBaseSha` on the row plus `provisionForRun` resolving `baseRef` from the row (§2.5); ACC-09-24 and T15's assertion that the squash base equals the sha passed to `createBranchFromSha` (G01).                |
| A review follow-up reaches the normal finalize and opens a pull request inside the user's fork     | high        | high     | The follow-up row lookup and `onFollowUpFinalized` placed before `AppChangeGuard`/`simulateMerge` (§2.5, §2.6); T26 asserts `createPullRequest` is never called; T31's structural spec fails on a label route (G02). |
| The preparation Agent's report is prose the platform then guesses at                               | high        | high     | `UpstreamPreparationReport` with fixed caps, one named vehicle, validation and `reportInvalid` on anything else; the report never reaches the branch (FR-47, §4, T37) (G04).                                         |
| The PR-lane e2e and ACC-NEG-06 cannot run at all                                                   | high        | high     | T45 extends the fake GitHub with the endpoints this epic calls and a non-production seed; T24's command carries `EVER_WORKS_E2E_FAKES=1`; ACC-09-37 (G05).                                                           |
| The extra-files acknowledgement is bypassed through the Inbox or the approvals API                 | high        | high     | The acknowledgement is recorded on the row and enforced by the approvals service itself, so every door is covered (§5, §6; ACC-09-26) (G06).                                                                         |
| The enable toggle fails because no Agent resolves or no isolated runtime is free                   | certain     | medium   | The platform writes the App spec change itself (R-4's `commitFiles`/setup-PR paths); the `evolve` route stays as the alternative; the pending value is recorded (§3.1A, T20; ACC-09-27) (G07).                       |
| GitHub behaviours the eligibility and checks logic rest on are not what the spec assumes           | medium      | high     | T5's spike covers all five behaviours against the team's throwaway pair and records the answers in §9.2 before P2 starts; the refusal codes exist either way, and "cannot tell" never reads as "allowed" (G16).      |
| The platform floods one upstream through many members or organizations                             | medium      | high     | FR-39's platform-wide ceiling, counted across every App Work and member, plus the operator deny list and the maintainer opt-out (FR-40/FR-41; ACC-09-29) (XC-22).                                                    |
| A user-writable label drives routing, letting one Task steer another row's verifier                | medium      | high     | Finalize routes by row lookup only; labels are display only; the suggestion marker is recorded server-side (G18; T31's structural spec).                                                                             |
| A preparation runs forever because the deadline has no storage and no sweeper                      | medium      | medium   | `preparationStartedAt` / `preparationPausedMs` / `preparationHeldSince`, the `(state, preparationStartedAt)` index and the status tick's `preparing` sweep; a hold never counts (G14; ACC-09-38).                    |
| The verifier mis-counts commits or screens a truncated patch                                       | medium      | medium   | `GitDiffResult.totalCommits` from compare; refuse on `truncated`/`patchOmitted`; `scanForSecrets` with the pattern name only; `maxBytes` raised to the 1 MiB hard cap (G13).                                         |
| A machine approves publishing under a person's name                                                | low         | critical | `@HumanOnly()` on the decision and on `…/signed` plus `humanDecisionRequired` and the `publish` rung; ACC-09-35 (XC-07).                                                                                             |
| Background jobs act with a departed member's connection, or the wrong member's                     | medium      | high     | The credential of record with a named pause and an explicit handover (FR-43; ACC-09-32) (XC-18).                                                                                                                     |
| Contribution runs spend without a bound the App Work can see                                       | medium      | medium   | Runs booked against the App Work's `WorkBudget` through the platform's budget guard, with a wait rather than a failure (FR-44; ACC-09-33) (XC-19).                                                                   |
| An operator cannot stop upstream activity during an incident                                       | medium      | high     | `EVER_WORKS_UPSTREAM_PRS_ENABLED` read by the dispatchers themselves and failing closed, plus the deny list; nothing already upstream is withdrawn (FR-46; ACC-09-34) (XC-10).                                       |
| Account deletion leaves months of polling and orphaned fork branches behind                        | medium      | medium   | APW-01's deletion handler calls this epic's `stopTrackingFor*`; branches are removed within the same 10 minutes; nothing upstream is edited (FR-45; ACC-09-31) (XC-14).                                              |
| The new surfaces are unusable by keyboard, screen reader or in `ar`/`he`                           | medium      | medium   | FR-42's bar, plan §8.3 and T41's axe/keyboard/RTL lane, asserted by ACC-09-30 (XC-25).                                                                                                                               |
| New routes are unreachable from MCP, CLI or chat, so the "chat with your agents" promise is hollow | medium      | medium   | plan §5's parity table with a whitelist/CLI/chat row or a recorded not-exposed reason per route, enforced by a registry-parity spec (ACC-09-36) (XC-23).                                                             |

### Known gaps carried forward

- Preparation does not run on Fleet nodes (single-commit squash and member identity are enforced in the cloud
  finalize only). It is refused there by design (the delegation scope and `seedPendingInput` are not Fleet vehicles,
  §2.5), not by omission.
- AI-policy detection is agent-read, not a parser (spec §9, `CL-38`).
- Non-GitHub upstreams are unsupported until a provider implements the optional methods.
- The Upstream tab route belongs to APW-02 (R-8); P2 of this epic cannot ship its section before APW-02 P1 merges.
- T5's five spike answers (upstream-sha branch creation, pull requests disabled, the outside-contributor cap, a
  non-admin interaction-limit read, and how `action_required` surfaces) are **unverified until that spike runs**, and
  §9.2's rows name which refusal each one decides. Writing the code before the spike returns is what G16 warns about.
- `docs/adr/` does not exist in this repository, so the program's ADR-014/015/017 references are named and not linked
  (spec §12).
