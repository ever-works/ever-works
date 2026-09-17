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

`TaskWorkspaceService.finalizeRun` and `finalizeRemotePush` gain one early branch: a Task with label
`upstream-pr:<id>` calls `UpstreamPreparationService.onPreparationFinalized` **instead of** `simulateMerge` and
`openPullRequestForBranch`. The cloud finalize passes two additive options to `workspaceFacade.finalize`:
`squashOnto: task.baseSha` (one commit, FR-8) and `identity` = the member (`{login}` and the provider's no-reply
address from `getUser`), plus a message that carries no trailer. Fleet preparation is refused at dispatch (FR-6).
The preparation Task moves to `in_review` while awaiting approval, `done` when opened, `cancelled` on
withdrawn/expired/refused/failed.

**Safety rails (Resolution R-17).** The preparation and review follow-up Tasks are App Work Tasks, so APW-08's
handling applies unchanged: a run parked by the stop flag or an Agent/workspace pause is a **wait** — the 90-minute
preparation deadline (`UPSTREAM_TIMEOUTS.preparationMs`) is measured over running time only and the row stays
`preparing`; a safety-rail refusal makes the Task `needs_input` (Task `BLOCKED` + escalation `guardrail-refusal`) and
the row stays `preparing` with the clock paused until the member resumes or withdraws. Branch pushes happen in Task
finalize and the upstream pull request is opened by the `upstream-pr-open` job — never by the Agent
`commitToRepo` / `openPullRequest` tools — and only after the author's approval (§6).

### 2.6 Review follow-up (FR-31)

1. `createBranchFromSha(fork, '<headBranch>--update-<n>', row.headSha)`.
2. Task labelled `upstream-pr-update:<id>`, `branchRef` preset, brief = review bodies + inline comments (≤ 64 KB,
   fenced untrusted, `neutralizeControlTokens`).
3. Finalize (no squash — reviewers expect incremental commits) → verify the update diff (`<headBranch>...<update>`)
   against the same exclusions and a 500-line update cap → push approval `upstream-pr:push:<id>:<fp>`.
4. On approval: `updateBranchRef(fork, headBranch, updateHeadSha, { force: false })` — a fast-forward only; a
   non-fast-forward (someone pushed to the PR branch) refuses with **"The pull request branch moved. Review it
   again."** and re-prepares the update approval.

---

## 3. Data model

**Workspace backup (Resolution R-25).** `UpstreamPullRequest` exports as `data/works/upstream-pull-requests.jsonl` through the parent Work ids; nothing is redacted ([tasks](./tasks.md) T35).

### 3.1 `upstream_pull_requests` _(new, P1)_

| Column                                                     | Type                                     | Notes                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                                                       | `uuid` PK                                |                                                                                             |
| `userId`                                                   | `uuid NOT NULL`                          | Author member. CASCADE with `user.id`.                                                      |
| `workId`                                                   | `uuid NOT NULL`                          | CASCADE with `works.id`.                                                                    |
| `sourceTaskId`                                             | `uuid NOT NULL`                          | No FK (a Task deletion must not erase a published PR's record).                             |
| `preparationTaskId`                                        | `uuid NULL`                              |                                                                                             |
| `followUpTaskId`                                           | `uuid NULL`                              | Latest review follow-up.                                                                    |
| `upstreamOwner` / `upstreamRepo`                           | `varchar(100)` each                      |                                                                                             |
| `baseBranch`                                               | `varchar(255)`                           |                                                                                             |
| `headOwner` / `headRepo`                                   | `varchar(100)` each                      |                                                                                             |
| `headBranch`                                               | `varchar(255)`                           | `upstream-pr/{slug≤40}-{4 hex}`.                                                            |
| `headSha`                                                  | `varchar(64) NULL`                       |                                                                                             |
| `state`                                                    | `varchar(24) NOT NULL`                   | `UPSTREAM_PULL_REQUEST_STATES`; default `preparing`.                                        |
| `number` / `url`                                           | `int NULL` / `varchar(512) NULL`         |                                                                                             |
| `title` / `body`                                           | `varchar(200) NULL` / `text NULL`        | Public text by design; kept for the approval and audit.                                     |
| `disclosureText`                                           | `varchar(300) NULL`                      |                                                                                             |
| `maintainerCanModify`                                      | `boolean NOT NULL DEFAULT true`          |                                                                                             |
| `fingerprint`                                              | `varchar(64) NULL`                       |                                                                                             |
| `approvalProposalId` / `approvalExpiresAt`                 | `uuid NULL` / `timestamptz NULL`         |                                                                                             |
| `checksSummary` / `reviewSummary`                          | `varchar(32) NULL` / `varchar(24) NULL`  |                                                                                             |
| `signatureState`                                           | `varchar(24) NULL`                       | `cla_required` · `cla_acknowledged` · `cla_pending_check`.                                  |
| `refusalCode` / `refusalDetail`                            | `varchar(32) NULL` / `varchar(500) NULL` | `refusalDetail` holds a quoted guide sentence (≤ 300) or a provider message, never a token. |
| `diffStats`                                                | `simple-json NULL`                       | `{ files, additions, deletions, extraFiles: string[] (≤ 3) }`.                              |
| `checkResults`                                             | `simple-json NULL`                       | `≤ 10` of `{ command (≤ 200), exitCode, tail (≤ 50 lines, ≤ 8 KB) , alsoRedOnBase }`.       |
| `seenReviewIds`                                            | `simple-json NULL`                       | `≤ 200` provider review ids.                                                                |
| `pushTimestamps`                                           | `simple-json NULL`                       | `≤ 20` ISO times of approved pushes (24 h window).                                          |
| `forkBranchDeletedAt`                                      | `timestamptz NULL`                       |                                                                                             |
| `lastUpstreamActivityAt` / `lastCheckedAt` / `nextCheckAt` | `timestamptz NULL`                       |                                                                                             |
| `openedAt` / `mergedAt` / `closedAt`                       | `timestamptz NULL`                       |                                                                                             |
| `tenantId` / `organizationId`                              | `uuid NULL`                              | Scope-stamped by the subscriber.                                                            |
| `createdAt` / `updatedAt`                                  | `timestamptz`                            |                                                                                             |

Indexes: `idx_upr_work_state (workId, state)`;
`idx_upr_user_upstream_opened (userId, upstreamOwner, upstreamRepo, openedAt)`; `idx_upr_due (state, nextCheckAt)`;
`uq_upr_active_source (sourceTaskId)` UNIQUE partial
`WHERE state IN ('preparing','needs_signature','awaiting_approval','opening','open')` (FR-5, S27).

Entity `packages/agent/src/entities/upstream-pull-request.entity.ts` _(new)_ registered in the four places the
entity drift specs check: `entities/index.ts`, `database/_entity-names.ts`, `database/_entities-inventory.ts`, and
the owning module's `TypeOrmModule.forFeature`.

### 3.2 Migration

`apps/api/src/migrations/1792090000000-CreateUpstreamPullRequests.ts` _(new)_ — reserved block `179209<slot>00000`,
slot 00. `up()`: create table + indexes (partial unique on Postgres and SQLite). `down()`: drop indexes and table.
No other schema change in this epic (the approval action type is a varchar value; the App spec setting is file
content).

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
	'providerUnsupported'
] as const;

export const UPSTREAM_LIMITS = {
	openedPerUpstreamPer24h: 1,
	openPerUpstream: 2,
	openedOverallPer24h: 3,
	preparationsPer24h: 10,
	runningPreparationsPerWork: 1,
	pushesPerPrPer24h: 5,
	suggestionsPerWorkPer7d: 3
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
	branchCleanupMs: 10 * 60_000
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
	reviewBriefMaxBytes: 64 * 1024
} as const;
export const UPSTREAM_EXCLUDED_GLOBS = [
	'.works/**',
	'.github/workflows/ever-works-*',
	'**/.env*',
	'**/*.pem',
	'**/*.key'
] as const;
export const UPSTREAM_DISCLOSURE =
	'This pull request was prepared with the help of an AI agent (Ever Works) and reviewed by @{login} before it was opened.';
```

### 3.4 Activity (Resolution R-2)

`packages/agent/src/entities/activity-log.types.ts` gains one family `APP_UPSTREAM_PR = 'app_upstream_pr'` (append
only; varchar column, no migration). Every row has `actionType = 'app_upstream_pr'` and `action` = the dotted CONTRACTS
§6 event (`app.upstream_pr.proposed`, `.approved`, `.opened`, `.updated`, `.changes_requested`, `.needs_signature`,
`.refused`, `.withdrawn`, `.merged`, `.closed`, `.suggested`); `details` carry the upstream `owner/repo`, number, URL,
state and refusal code — never a title, body or diff (FR-37). `ActivityTypeBadge` maps `app_upstream_pr` →
`appUpstreamPr`.

---

## 4. Contract changes (plugin SDK, additive — Constitution X)

| Change                                                                                                                                                  | Owner  | Implementation                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CreatePROptions.headOwner?`, `headRepo?`, `maintainerCanModify?`                                                                                       | APW-09 | GitHub: `head` = `<headOwner>:<head>` when `headOwner` is set, else `head`; `maintainer_can_modify`; `head_repo` when `headRepo` differs from the fork's name (same-owner networks). |
| `GitPullRequest.headRepoFullName?: string \| null` (+ on `GitPullRequestStatus`)                                                                        | APW-09 | Map `data.head.repo?.full_name` in create/get/list/status; `null` when the head repository was deleted.                                                                              |
| `listPullRequestReviews?(owner, repo, number, token): Promise<GitPullRequestReview[]>` (`{ id, state, author, submittedAt, body ≤ 8 KB }`, ≤ 100)       | APW-09 | `pulls.listReviews`.                                                                                                                                                                 |
| `listPullRequestReviewComments?(owner, repo, number, token)` (≤ 100, body ≤ 4 KB)                                                                       | APW-09 | `pulls.listReviewComments`.                                                                                                                                                          |
| `getInteractionLimit?(owner, repo, token): Promise<'none' \| 'existing_users' \| 'contributors_only' \| 'collaborators_only' \| null>`                  | APW-09 | `interactions.getRestrictionsForRepo`.                                                                                                                                               |
| `createBranchFromSha?(owner, repo, name, sha, token)`                                                                                                   | APW-09 | `git.createRef`.                                                                                                                                                                     |
| `updateBranchRef?(owner, repo, name, sha, { force: false }, token)`                                                                                     | APW-09 | `git.updateRef({ force: false })`.                                                                                                                                                   |
| `WorkspaceFinalizeOptions.squashOnto?: string`                                                                                                          | APW-09 | sandbox and local workspace plugins: `git reset --soft <sha>` then the single commit; refuse when `sha` is not an ancestor.                                                          |
| `GitFacadeService.getMemberAccountToken`, and facade pass-throughs for every method above (returning `null`/throwing `providerUnsupported` when absent) | APW-09 | §2.3.                                                                                                                                                                                |

Every GitHub mapping change is covered by a spec in `packages/plugins/github/src/__tests__/` beside the existing
`github-api.service.pr-insights.spec.ts`.

---

## 5. API

On a new controller `apps/api/src/works/upstream-pull-requests.controller.ts` _(new)_, `@Controller('api')`, following
`apps/api/src/works/work-runs.controller.ts`. All routes JWT-guarded; `WorkOwnershipService.ensureCanView` /
`ensureCanEdit`; another account's ids answer **404**.

| Method | Path                                                                | Body / query                       | Returns                                                                        | Throttle  |
| ------ | ------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ | --------- |
| `GET`  | `/api/works/:id/upstream-pull-requests`                             | `?state`, `limit ≤ 100` (20)       | `{ data: UpstreamPullRequestView[], meta: { total } }`                         | default   |
| `GET`  | `/api/works/:id/upstream-pull-requests/eligibility`                 | `?taskId`                          | `{ allowed, code?, nextSlotAt?, target, orgFork, maintainerCanModifyDefault }` | 60 / min  |
| `POST` | `/api/works/:id/upstream-pull-requests`                             | `{ taskId, maintainerCanModify? }` | `202 { id, state: 'preparing', preparationTaskId }`                            | 10 / hour |
| `GET`  | `/api/works/:id/upstream-pull-requests/:prId`                       | —                                  | view + `diff` (from compare, capped 300 files / 1 MB) when awaiting approval   | default   |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/signed`                | —                                  | `202` — `cla_acknowledged`, preparation resumes (once)                         | 10 / hour |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/withdraw`              | —                                  | view (`withdrawn`)                                                             | 30 / min  |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/check`                 | —                                  | view (fresh poll; min 60 s between manual checks)                              | 10 / min  |
| `POST` | `/api/works/:id/upstream-pull-requests/:prId/address-review`        | —                                  | `202 { followUpTaskId }`                                                       | 10 / hour |
| `POST` | `/api/works/:id/upstream-pull-requests/suggestions/:taskId/dismiss` | —                                  | `204`                                                                          | 30 / min  |

Approval decisions use the existing `POST /api/agent-approvals/:id/approve|reject`; `approve-all` **leaves out**
`upstream_pull_request` rows (counted as `excluded` through the existing `requiresIndividualDecision`, like
`merge_pull_request`) because each needs its own reviewed decision.

Enabling the setting: `PATCH` is not added — the App spec is the source of truth (D3). The Upstream tab toggle calls
APW-08's `POST /api/works/:id/evolve` with a generated request to set `upstreamPullRequests.enabled`, or — when the
member can push to the source branch and no review rule protects it — APW-03's App spec write path if it offers one.
Until the spec change merges the toggle shows **"Waiting for the App spec change to merge."**

Error contract: `422 { code }` for every `UPSTREAM_REFUSAL_CODES` value raised synchronously;
`409 { code: 'activeProposal', id }` for FR-5; `429 { code: 'rateLimited', nextSlotAt }` for FR-26.

---

## 6. Approvals

- `AgentActionProposalActionType` gains `'upstream_pull_request'` (21 characters, fits `varchar(32)`), appended to
  `AGENT_ACTION_PROPOSAL_ACTION_TYPES`.
- `RISK_SCORER`: `upstream_pull_request` → `cross_scope` **by action type** (like merges are destructive by type), so
  no payload omission can make it self-approvable.
- `createProposal` is called with `humanDecisionRequired: true`, `agentId` = the preparation Agent, `runId`, `title`
  `Approve pull request to {upstream}: {title}` (≤ 200), `subjectKey` from `upstream-fingerprint.ts`, payload display
  fields only (`upstreamPullRequestId`, target, head, counts). The decision is **bound by `subjectKey`**, never by
  payload — same rule as `merge_pull_request`.
- `approve-all` leaves the type out (§5): `requiresIndividualDecision` returns `true` for it, so it is counted
  `excluded`. `AgentApprovalsService` gains `expire(proposalId)` → `status 'rejected'`,
  `decidedVia 'expired'` (additive union member), used by the status job at 72 h.
- Trust ladder (AW-24; binding as Resolution R-18): the proposal table `PROPOSAL_ACTION_CATEGORY` in
  `packages/agent/src/safety/guardrail-interop.ts` gains one appended row,
  `upstream_pull_request: 'publish.external'` — the `publish` rung. `applyLadderToGuardrailDecision` then makes an
  enforced `off` rung **block** the proposal (`decidedVia: 'guardrail'`, row → `refused` / `blocked`), and `draft` / `ask` keep it
  queued; `auto` has no effect because `humanDecisionRequired` already forbids auto-approval. The edit is append-only
  — no existing key is changed or reordered — and AW-24 P2's own appended action types are unaffected.
- Never approvable in bulk (R-18): `requiresIndividualDecision` in
  `packages/agent/src/agent-approvals/agent-approvals.service.ts` returns `true` for `upstream_pull_request`, so
  `approveAll` counts it `excluded` and the web approvals queue offers no bulk action for it.
- Listener entitlement: `event.decidedById === row.userId`, else the row stays `awaiting_approval`, the proposal is
  re-opened as a fresh pending proposal for the author, and Activity records **"Only @{login} can approve publishing
  under their name."**

---

## 7. Background work

| Job id               | File                                                                  | Trigger                       | Behaviour                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream-pr-status` | `packages/tasks/src/tasks/trigger/upstream-pr-status.task.ts` _(new)_ | cron `3-59/10 * * * *`        | ≤ 100 due rows (`state='open' AND nextCheckAt <= now`, oldest first); expire approvals past TTL; delete fork branches of terminal rows (`forkBranchDeletedAt IS NULL`); ≤ 4 provider requests per PR. |
| `upstream-pr-open`   | `packages/tasks/src/tasks/trigger/upstream-pr-open.task.ts` _(new)_   | `UPSTREAM_PR_OPEN_DISPATCHER` | CAS `awaiting_approval → opening`; re-verify fingerprint, TTL, eligibility, limits; open; `opening → open` or `refused`. 1 retry on 5xx only.                                                         |
| `upstream-pr-push`   | `packages/tasks/src/tasks/trigger/upstream-pr-push.task.ts` _(new)_   | `UPSTREAM_PR_PUSH_DISPATCHER` | Fingerprint + push limit + signature gate; fast-forward; record.                                                                                                                                      |

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

| Component                     | File                                                                                                                                                                                                           | Type   | Notes                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream tab page             | `apps/web/src/app/[locale]/(dashboard)/works/[id]/upstream/page.tsx` (created by APW-02 T30 — modified here)                                                                                                   | server | Resolution R-8: APW-02 creates the one route `/works/:id/upstream` with its relation card, readiness, sync status and Actions hygiene; this epic only appends the **Upstream pull requests** section below them, fetching its list beside APW-02's `GET /api/works/:id/upstream` in `Promise.all`. |
| `UpstreamPullRequestsSection` | `apps/web/src/components/works/detail/upstream/UpstreamPullRequestsSection.tsx` _(new)_                                                                                                                        | client | Toggle, list rows, state/checks/review chips, **Check now**, **Withdraw**, empty state, the private-copy notice.                                                                                                                                                                                   |
| `UpstreamApprovalReview`      | `apps/web/src/components/works/detail/upstream/UpstreamApprovalReview.tsx` _(new)_                                                                                                                             | client | Target/head, title, body, diff (reuses `PullRequestDiffPanel` rendering from `apps/web/src/components/works/detail/pull-requests/`), checks, notes, extra-files tick, links to the approval decision.                                                                                              |
| `ProposeUpstreamDialog`       | `apps/web/src/components/tasks/ProposeUpstreamDialog.tsx` _(new)_                                                                                                                                              | client | Eligibility fetch, target, maintainer-edit checkbox (org-fork variant), limits line.                                                                                                                                                                                                               |
| Task action                   | `apps/web/src/components/tasks/TaskDetailClient.tsx` (modified)                                                                                                                                                | client | **Propose upstream** when eligible or disabled-with-reason.                                                                                                                                                                                                                                        |
| Tab entry                     | none — APW-02 T30 adds the `Upstream` entry to `apps/web/src/components/works/detail/WorkTabs.tsx` and `ROUTES.DASHBOARD_WORK_UPSTREAM` (R-8)                                                                  | —      | This epic changes neither file.                                                                                                                                                                                                                                                                    |
| Inbox and approvals rendering | `apps/web/src/components/inbox/InboxDecisionDetail.tsx`, `apps/web/src/components/approvals/ApprovalsQueue.tsx`, `apps/web/src/lib/api/agent-approvals.ts`, `apps/web/src/lib/api/agents.shared.ts` (modified) | client | The `upstream_pull_request` action type joins the web unions; the approval item links to `UpstreamApprovalReview`; the queue never offers it to bulk approval (R-18). Review, signature and suggestion notices use the existing generic `notice` Inbox kind.                                       |
| Client + actions              | `apps/web/src/lib/api/upstream-pull-requests.ts`, `apps/web/src/app/actions/works/upstream-pull-requests.ts` _(new)_                                                                                           | —      | Typed mirror; `revalidatePath` on the Work routes.                                                                                                                                                                                                                                                 |

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
- `dashboard.workDetail.upstream.states`: `preparing`, `needsSignature`, `awaitingApproval`, `opening`, `open`,
  `merged`, `closed`, `refused`, `failed`, `expired`, `withdrawn` (copy per spec §6.1).
- `dashboard.workDetail.upstream.checks`: `passing`, `failing`, `pending`, `waitingForMaintainers`, `unknown`.
- `dashboard.workDetail.upstream.reviews`: `approved`, `changesRequested`, `commented`.
- `dashboard.workDetail.upstream.refusals`: one key per `UPSTREAM_REFUSAL_CODES` value (copy per spec §6.5).
- `dashboard.tasksPage.proposeUpstream`: `action`, `dialogTitle`, `to`, `change`, `explainer`, `nothingSent`,
  `maintainerEdits` ("Allow maintainers to edit this pull request"), `orgForkNote`, `limits`, `prepare`, `cancel`,
  `preparingRow`.
- `dashboard.inbox.upstream`: `approvalTitle`, `changesRequested`, `signature`, `openAgreement`, `signedContinue`,
  `suggestion`, `propose`, `dismiss`, `merged`, `closed`, `onlyAuthorCanApprove`.
- `dashboard.workDetail.upstream.approval`:
    - `title` — "Open a pull request on {upstream}?"
    - `updateTitle` — "Push {count} commits to {upstream} #{number}?"
    - `expiresIn`, `asMember`, `maintainersCanEdit`, `titleLabel`, `descriptionLabel`, `diffLabel`, `checksLabel`,
      `notesLabel`, `followsTemplate`, `includesDisclosure`
    - `notInOriginal` — "Not in the original change"; `reviewedExtra` — "I've reviewed the extra files"
    - `alreadyFailing` — "Already failing on {upstream}:{branch}"
    - `approveOpen` — "Approve and open"; `approvePush` — "Approve and push"; `reject` — "Reject"
    - `stale` — "The proposal changed after you approved it. Review it again."
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
`kb-events.ts`)_, whose `emitUpstreamPrEvent` refuses the keys `title`, `body`, `diff`, `login`, `owner`, `repo`,
`repository` before calling `capture`.

### 9.2 Failure modes

| Failure                                                        | Behaviour                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBranchFromSha` rejects an upstream sha in the fork      | `failed` with `providerUnsupported`; T-spike (tasks T5) proves the network-object behaviour before P2 starts; fallback is APW-02's `syncForkBranch?` onto a platform-managed mirror branch. |
| Provider lacks any optional method used                        | `refused` / `providerUnsupported`; the Upstream tab shows the feature as unavailable for this provider.                                                                                     |
| Member token missing `repo` scope / revoked                    | `connectionScope`; no fallback to any other token, ever.                                                                                                                                    |
| Open succeeds but recording fails                              | Next status tick finds the PR by `listPullRequests(state=all, head='fork:branch')` and repairs the row.                                                                                     |
| Provider 422 "a pull request already exists"                   | Adopt the existing PR only if its head repo and branch equal the row's; else `refused`.                                                                                                     |
| Provider 403/422 outside-contributor cap or collaborators-only | `refused` / `collaboratorsOnly`, message carries the provider reason (≤ 500 chars, no token).                                                                                               |
| Upstream head moved between approval and open                  | Open anyway (the diff is fixed by our head sha); GitHub reports mergeability; conflicts surface as review, not as a platform retry.                                                         |
| Fork deleted                                                   | Row → `closed` on the next read (`headRepoFullName = null` and PR closed) or tracking continues if PR remains.                                                                              |
| Status read 404 (upstream deleted/private)                     | `closed` with `refusalDetail "The upstream repository is no longer reachable."`; polling stops.                                                                                             |
| Dispatch fails after approval                                  | Propagates; status job re-dispatches approved-but-`awaiting_approval` rows after 15 minutes.                                                                                                |

---

## 10. Test plan

### 10.1 Unit (agent package, Jest) — `packages/agent/src/upstream-pull-requests/__tests__/` _(new)_

`upstream-eligibility.rules.spec.ts` (every relation/setting/state/limit branch, `nextSlotAt`),
`upstream-rate-limits.spec.ts` (24 h windows at boundaries), `upstream-fingerprint.spec.ts` (each field changes the
fingerprint), `upstream-preparation.verifier.spec.ts` (exclusions incl. renames, extra files ≤ 3 and directory rule,
size and project limit, secrets, commit count, red-on-base), `summarize-upstream-checks.spec.ts` (`action_required`
→ waiting; CLA names excluded; empty → unknown), `packages/agent/src/facades/__tests__/git.facade.member-token.spec.ts` (platform PAT and installation paths
never invoked), `upstream-approval.listener.spec.ts` (non-author decision ignored; rejected → withdrawn + cleanup;
idempotent re-delivery), `upstream-status.service.spec.ts` (cadence, pause at 90 days, one notice per review,
merged/closed stop), `upstream-review-follow-up.service.spec.ts` (non-fast-forward refusal),
`upstream-setting.service.spec.ts` (toggling files an App spec change and opens nothing upstream),
`upstream-signature.spec.ts` (CLA → `needs_signature`, one resume, DCO → `refused/dcoRequired`, no sign-off ever),
`upstream-suggestion.service.spec.ts` (nothing prepared before **Propose**; 1 per Task, 3 per App Work per 7 days),
`upstream-preparation.holds.spec.ts` (R-17: a parked run pauses the 90-minute clock; a rail refusal keeps the row
`preparing`), and the structural spec `no-merge-no-comment.spec.ts` asserting no module in the folder references
`mergePullRequest`, `closePullRequest` or `createPullRequestComment`.

### 10.2 Plugin (Vitest)

`packages/plugins/github/src/__tests__/github-api.service.cross-repo.spec.ts` _(new)_ — head owner composition,
`maintainer_can_modify`, `headRepoFullName` mapping on all four reads, reviews, review comments, interaction limits,
`createBranchFromSha`, `updateBranchRef` fast-forward only. Workspace plugins: `squashOnto` specs beside
`packages/plugins/sandbox-workspace/src/` and `packages/plugins/local-workspace/src/` existing specs.

### 10.3 API (Jest)

`apps/api/src/works/upstream-pull-requests.controller.spec.ts` _(new)_ — every route, codes, 404s, throttles;
`apps/api/src/migrations/__tests__/CreateUpstreamPullRequests.spec.ts` _(new)_; approvals, extending
`packages/agent/src/agent-approvals/__tests__/agent-approvals.service.spec.ts` and `risk-scorer.spec.ts`: `approve-all`
excludes the type; `RISK_SCORER` flags it cross-scope with an empty payload; extending
`packages/agent/src/agents/__tests__/guardrails.ladder-interop.spec.ts`: `PROPOSAL_ACTION_CATEGORY.upstream_pull_request`
is `publish.external`, every pre-existing key unchanged, an enforced `off` rung → `block` (R-18). No suite is added under
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
`ever-works/skills`.

### P3 — Reviews and suggestions (Wave 2)

Review follow-ups with push approvals and fast-forward, signature acknowledgement flow, agent suggestions (with a
`suggestUpstreamContribution` Agent tool that only labels the Task `upstream-candidate` and is offered only on fork App
Works with proposals on).

---

## 12. Constitution compliance checklist

- [x] **I — Plugin-first.** All provider work goes through `GitFacadeService` and `WorkspaceFacadeService`; every new
      provider method is an optional addition to the existing git and workspace capabilities.
- [x] **II — No hard-coded plugin ids.** No plugin id appears in core; the member token is resolved by provider id
      passed in, never a literal.
- [x] **III** — The enable switch lives in the App spec; the database stores proposal and tracking state only.
- [x] **IV** — Open, push and status are dispatched/scheduled jobs; endpoints return `202`.
- [x] **V** — One additive migration in block `1792090000000`.
- [x] **VI** — Unit, plugin, API and e2e specs named in §10, including the structural "never merges" and "member token
      only" specs.
- [x] **VII** — Only the member's token is used and never stored on the row, logged or returned; bodies and diffs are
      screened with `assertNoSecrets`; telemetry carries no content.
- [x] **VIII** — No plugin added.
- [x] **IX** — Names and paths live in this plan only.
- [x] **X** — Contract additions are optional fields/methods; `createPullRequest` behaves identically without the new
      fields.
- [x] **Program rules 9 and 10** — Upstream guides, templates and review comments are fenced untrusted content; no
      third-party product or vulnerability named.
- [x] **Program resolutions (CONTRACTS §0)** — R-1 types in `packages/contracts/src/apps/` (§3.3); R-2 Activity family
      `app_upstream_pr` (§3.4); R-8 one Upstream tab created by APW-02 (§8); R-17 holds and rail refusals (§2.5);
      R-18 `publish` rung, `off` blocks, never bulk-approvable (§6); R-22 no `apps/api/test/` suites (§10).

### Known gaps carried forward

- Preparation does not run on Fleet nodes (single-commit squash and member identity are enforced in the cloud
  finalize only).
- AI-policy detection is agent-read, not a parser (spec §9).
- Non-GitHub upstreams are unsupported until a provider implements the optional methods.
- The Upstream tab route belongs to APW-02 (R-8); P2 of this epic cannot ship its section before APW-02 P1 merges.
