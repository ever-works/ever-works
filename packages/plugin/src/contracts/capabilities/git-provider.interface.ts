import type { IPlugin } from '../plugin.interface.js';
// App Works fork lifecycle (APW-02 T9/T10) — the types the optional members below consume.
import type {
	GitActionsPermissionsInput,
	GitActionsPermissionsResult,
	GitForkDivergence,
	GitForkSyncResult,
	GitRepositoryCopyInput,
	GitRepositoryCopyResult,
	GitWebhookInput
} from './git-provider.app-forks.js';

export interface GitAuth {
	readonly username: 'x-access-token' | 'oauth2' | string;
	readonly password: string;
}

export interface GitCommitter {
	readonly name?: string;
	readonly email?: string;
}

export interface GitRepository {
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly description?: string;
	readonly defaultBranch: string;
	readonly isPrivate: boolean;
	readonly url: string;
	readonly cloneUrl: string;
	readonly isFork?: boolean;
	readonly parent?: {
		readonly owner: string;
		readonly name: string;
		readonly fullName: string;
	};
	/**
	 * Set by `forkRepository` only. `pending` means the provider accepted the fork request but the
	 * repository is not readable yet, so the caller must NOT clone or push into it — a background
	 * readiness poller owns the wait.
	 *
	 * Absent on every other repository read, so existing callers are unaffected.
	 */
	readonly forkReadiness?: 'ready' | 'pending';

	// ── Repository facts (APW-02 P1, plan §3.3) ──────────────────────────────
	//
	// Nine OPTIONAL reads APW-01/APW-03/APW-05 use to describe an upstream
	// repository before the platform acts on it: is it forkable, is it archived,
	// is it empty, what licence does it carry, how big is it, did the provider
	// redirect us. Additive only — an implementation that reports none of them
	// still satisfies this interface, and every consumer must treat `undefined`
	// as "the provider did not report it", never as `false` / `0` / "none".

	/**
	 * The network root this repository was forked from, when it is a fork.
	 *
	 * Read FIRST, before `parent`, when checking whether an existing repository
	 * belongs to the same fork network (plan §4.3): a fork of a fork has
	 * `source.fullName` = the upstream everyone shares, while `parent` is only
	 * the immediate ancestor.
	 */
	readonly source?: { readonly owner: string; readonly name: string; readonly fullName: string };
	/** Provider-reported "forks allowed" switch. `undefined` = not reported. */
	readonly allowForking?: boolean;
	/** Archived repositories are read-only upstream: never a fork or copy source. */
	readonly archived?: boolean;
	/**
	 * Provider visibility. `internal` is GitHub Enterprise's third value and is
	 * NOT private — treating it as one would refuse a repository the caller may
	 * legitimately use.
	 */
	readonly visibility?: 'public' | 'private' | 'internal';
	/** Stargazers, as reported. A popularity signal only — never an authorisation input. */
	readonly stars?: number;
	/** Provider-reported size in KiB, the value `GitRepositoryCopyInput.maxSizeKb` is checked against. */
	readonly sizeKb?: number;
	/**
	 * Provider-detected SPDX id, or `null` when the provider found a licence it
	 * cannot identify (`NOASSERTION`). APW-03 classifies it; nothing here does.
	 *
	 * `undefined` and `null` differ: `undefined` is "not reported", `null` is
	 * "reported, and it is not a licence we can name".
	 */
	readonly licenseSpdx?: string | null;
	/** True when the default branch has no commit (a repository created but never populated). */
	readonly empty?: boolean;
	/**
	 * The `owner/name` the caller ASKED for, when the provider redirected to a
	 * different one (a rename). The coordinates on this object are the resolved
	 * ones; this field is what lets a caller notice the redirect at all.
	 */
	readonly movedFrom?: string;
}

export interface GitBranch {
	readonly name: string;
	readonly commit: string;
	readonly isDefault: boolean;
	readonly isProtected?: boolean;
}

export interface GitCommit {
	readonly sha: string;
	readonly message: string;
	readonly author: GitCommitter;
	readonly date: string;
}

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitFileChange {
	readonly path: string;
	readonly status: GitFileStatus;
	readonly oldPath?: string;
}

export interface GitCloneOptions {
	readonly owner: string;
	readonly repo: string;
	readonly token: string;
	readonly committer?: GitCommitter;
	readonly branch?: string;
	readonly autoSwitchToMainBranch?: boolean;
	/**
	 * Selects a working copy of its own for this call, instead of the one shared by every caller
	 * of `owner/repo`. Use it whenever the caller mutates the checkout (branch, files, remotes) or
	 * needs it to survive alongside another call for the same repository.
	 *
	 * Convention: `work:<workId>:<role>`. Optional — omitted means today's per-repository
	 * directory, so existing callers keep their current behaviour.
	 */
	readonly checkoutKey?: string;
	/**
	 * Declares that the remote repository MUST exist. When set, a missing or empty remote throws
	 * `RepositoryNotReadyError` instead of silently falling back to `git init` — which otherwise
	 * turns a typo'd, deleted or unauthorised repository into an empty local one that looks
	 * successful.
	 *
	 * Optional and opt-in: the lenient default (initialise and add the remote) is unchanged, and
	 * is still correct for a brand-new repository we are about to populate.
	 */
	readonly expectExisting?: boolean;
}

/**
 * Clone a SINGLE branch into a directory of its own.
 *
 * Distinct from {@link GitCloneOptions}: `branch` is required, and the
 * implementation is expected to give every call an isolated working
 * directory rather than a deterministic owner+repo one.
 */
export interface GitCloneBranchOptions {
	readonly owner: string;
	readonly repo: string;
	readonly branch: string;
	readonly token: string;
}

export interface GitPushOptions {
	readonly dir: string;
	readonly token: string;
	readonly force?: boolean;
	readonly maxRetries?: number;
	/**
	 * Local ref to push. When omitted the underlying git implementation
	 * pushes whatever branch HEAD happens to point at — correct only when
	 * the caller owns the checkout. Pass it explicitly whenever *which*
	 * branch gets pushed is part of the caller's intent.
	 */
	readonly ref?: string;
	/**
	 * Receiving branch on the remote. When omitted it is derived from the
	 * remote-tracking config of `ref`, falling back to `ref` itself. Pass
	 * it to push a local branch onto a differently-named remote branch, or
	 * to stop a `branch.<name>.merge` entry left over from the clone from
	 * silently choosing the destination.
	 */
	readonly remoteRef?: string;
	/**
	 * The repository this push is FOR. When both are given the push goes to
	 * the URL the provider computes for them, never to one read from the
	 * checkout's config — pass them whenever anything other than the platform
	 * itself (an agent tool, a model) has written into the checkout.
	 */
	readonly owner?: string;
	readonly repo?: string;
}

export interface CreateRepoOptions {
	readonly name: string;
	readonly description?: string;
	readonly isPrivate?: boolean;
	readonly organization?: string;
}

export interface UpdateRepoOptions {
	readonly isPrivate?: boolean;
	readonly description?: string;
	readonly defaultBranch?: string;
}

export interface ForkRepositoryOptions {
	readonly name?: string;
	readonly organization?: string;
	readonly defaultBranchOnly?: boolean;
	/**
	 * `false` returns as soon as the provider has ACCEPTED the fork request, with
	 * `forkReadiness: 'pending'`, instead of holding the caller while the fork bakes (seconds to
	 * minutes). The returned coordinates are already usable for bookkeeping, but the repository
	 * must not be cloned or pushed into until a readiness poller confirms it.
	 *
	 * Optional and opt-in: the default (`true`) keeps the existing blocking wait, so no existing
	 * caller changes behaviour.
	 */
	readonly waitForReady?: boolean;
}

export interface TransferRepoOptions {
	/** Provider login / namespace path the repo should be transferred to. */
	readonly newOwner: string;
	/** GitHub-specific; ignored by providers that don't support team grants. */
	readonly teamIds?: readonly number[];
}

export interface TransferRepoResult {
	/**
	 * `completed` — transfer landed synchronously.
	 * `pending_recipient_acceptance` — provider returned 202; recipient must
	 *   accept on the provider's web UI. Surface `providerAcceptanceUrl` so the
	 *   claim page can deep-link them.
	 */
	readonly status: 'completed' | 'pending_recipient_acceptance';
	readonly providerAcceptanceUrl?: string;
	readonly newRepository?: GitRepository;
}

export interface CreatePROptions {
	readonly owner: string;
	readonly repo: string;
	readonly title: string;
	readonly head: string;
	readonly base: string;
	readonly body?: string;
	readonly draft?: boolean;
	/**
	 * Cross-repository head (APW-09 T1, plan §4) — the OWNER the `head`
	 * branch lives under, when that is not the base repository's owner.
	 *
	 * Without it `head` is a bare branch name, which can only ever name a
	 * branch of the base repository: an upstream pull request whose head
	 * lives in the member's fork is unexpressible. GitHub spells the pair
	 * `head = "<headOwner>:<branch>"`; the provider composes it.
	 *
	 * OPTIONAL and additive. A call that omits it sends exactly the
	 * request it sent before this field existed, which is why every
	 * existing caller and provider compiles and behaves unchanged.
	 */
	readonly headOwner?: string;
	/**
	 * The head REPOSITORY's name, when it differs from `repo` (the member
	 * forked `upstream/widgets` to `member/widgets-fork`). GitHub needs it
	 * only in the one case plan §4 names — a head repository that shares
	 * the base owner (G23) — and a provider that cannot express a
	 * different head repository omits it rather than guessing.
	 */
	readonly headRepo?: string;
	/**
	 * "Allow edits and access to secrets by maintainers" — GitHub's
	 * `maintainer_can_modify`.
	 *
	 * OPTIONAL and only SENT when defined: `false` is a value the member
	 * chose, so a defaulting provider must not collapse "the member
	 * unchecked it" into "the caller did not say".
	 */
	readonly maintainerCanModify?: boolean;
}

export interface MergeOptions {
	readonly commitTitle?: string;
	readonly commitMessage?: string;
	readonly mergeMethod?: 'merge' | 'squash' | 'rebase';
	/**
	 * OPTIMISTIC-CONCURRENCY GUARD (merge approval, self-build slice AE).
	 *
	 * The commit the caller believes is the pull request's head. When set,
	 * an implementation MUST ask the provider to refuse the merge if the
	 * head has moved since — GitHub's `PUT /pulls/{n}/merge` takes exactly
	 * this as its `sha` parameter and answers 409.
	 *
	 * It exists because everything the platform decides about a pull
	 * request — CI is green, a human approved it, the diff is what was
	 * reviewed — is a statement about ONE commit, and between the decision
	 * and the merge call a push can replace it. Re-reading the head and
	 * then merging without pinning it just narrows the race; pinning
	 * closes it, because the provider evaluates the guard atomically with
	 * the merge.
	 *
	 * Optional on the contract so providers that cannot express the guard
	 * still compile. A provider that ignores it silently downgrades the
	 * guarantee to "recently checked", which is why the agent-side merge
	 * path ALSO re-reads the head immediately before calling.
	 */
	readonly expectedHeadSha?: string;
}

export interface MergeResult {
	readonly sha: string;
	readonly merged: boolean;
	readonly message?: string;
}

export interface GitUser {
	readonly id: string;
	readonly login: string;
	readonly name?: string;
	readonly email?: string;
	readonly avatarUrl?: string;
}

export interface GitOrganization {
	readonly id: string;
	readonly login: string;
	readonly name?: string;
	readonly avatarUrl?: string;
}

/**
 * Author info attached to a PR by the git-provider plugin.
 *
 * `orgVerified` is `true` iff the plugin has confirmed (via a provider API
 * call) that the author is a member of one of the operator-configured
 * "verified" organisations. The community-PR pipeline treats
 * `orgVerified !== true` as untrusted — see C-11 in the
 * 2026-05-17 security audit.
 *
 * Field is optional so existing provider implementations don't have to
 * populate it; consumers that need the verified-org check should treat
 * a missing `author` (or missing `orgVerified`) as "untrusted".
 */
export interface GitPullRequestAuthor {
	readonly username: string;
	readonly type?: 'User' | 'Bot' | 'Organization' | string;
	readonly orgVerified?: boolean;
}

export interface GitPullRequest {
	readonly number: number;
	readonly title: string;
	readonly state: 'open' | 'closed' | 'merged';
	readonly head: string;
	readonly base: string;
	readonly url: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly body?: string;
	readonly author?: GitPullRequestAuthor;
	/**
	 * Provider-side labels on the pull request, when the read that
	 * produced this object carried them.
	 *
	 * OPTIONAL and ABSENCE-AMBIGUOUS by construction: `undefined` means
	 * "this read did not report labels", never "there are none". A caller
	 * that treats a label as permission must therefore never infer safety
	 * from its absence — the release promotion lane reads
	 * `override-e2e-gate` off this to tell a human that a gate leg may
	 * have been WAIVED rather than green, which is a warning it adds, not
	 * a permission it grants.
	 */
	readonly labels?: readonly string[];
	/**
	 * `"{owner}/{repo}"` of the repository the head branch lives in, as the
	 * provider reports it — the field that makes an upstream pull request
	 * PROVABLE after the fact (APW-09 T1, plan §1.2/G17).
	 *
	 * `head` alone is a branch name, and a branch name says nothing about
	 * which repository it is in: a tracked upstream pull request whose
	 * head repository was deleted, renamed or never the fork would read
	 * exactly like one that came from the member's fork. `null` is a real
	 * answer — the provider reported no head repository (GitHub sends
	 * `head.repo: null` once the head repository is deleted) — and is
	 * deliberately distinct from `undefined`, which means "this read did
	 * not report it".
	 */
	readonly headRepoFullName?: string | null;
}

export interface GitRepositoryPermissions {
	readonly admin: boolean;
	readonly push: boolean;
	readonly pull: boolean;
}

export interface GitRepositoryWithPermissions extends GitRepository {
	readonly permissions?: GitRepositoryPermissions;
}

export interface ListRepositoriesOptions {
	owner?: string;
	type?: 'user' | 'org';
}

export interface GitPullRequestFile {
	readonly filename: string;
	readonly status: string;
	readonly additions: number;
	readonly deletions: number;
	readonly patch?: string;
}

export interface ListPullRequestsOptions {
	readonly state?: 'open' | 'closed' | 'all';
	readonly perPage?: number;
	readonly page?: number;
	/**
	 * Filter by head (`"{owner}:{branch}"`, GitHub's own `head` filter) —
	 * APW-09 T1 (G17).
	 *
	 * The upstream-recovery path asks "is there already a pull request for
	 * MY fork branch?" after a lost open, and answering it by listing
	 * every pull request and filtering locally both burns pages and can
	 * miss the row (a fork with many open pull requests). OPTIONAL: a
	 * provider without the filter omits the field and the caller keeps
	 * paging.
	 */
	readonly head?: string;
}

// ── PR insights (kanban run cockpit M5/M6) ─────────────────────────
//
// Two optional read capabilities used by the Tasks board to render a
// review pill (PR state + CI dot) and a diff preview without the
// browser ever talking to a provider API. Both are OPTIONAL: a
// git-provider plugin that cannot answer simply omits them, and the
// facade maps the absence to a caller-actionable 409 rather than a 500
// (the lazy-plugin proxy over-reports method presence, so callers must
// verify before calling — see `GitFacadeService`).

/** Lifecycle of a single CI check / status attached to a commit. */
export type GitCheckStatus = 'queued' | 'in_progress' | 'completed' | 'unknown';

/**
 * Terminal verdict of a check. `null` while the check has not completed.
 * The string set is deliberately provider-neutral — implementations map
 * their own vocabulary onto it.
 */
export type GitCheckConclusion =
	| 'success'
	| 'failure'
	| 'neutral'
	| 'cancelled'
	| 'timed_out'
	| 'action_required'
	| 'skipped'
	| 'stale';

export interface GitPullRequestCheck {
	/** Human name of the check. Plain text — never rendered as markup. */
	readonly name: string;
	readonly status: GitCheckStatus;
	readonly conclusion?: GitCheckConclusion | null;
	readonly detailsUrl?: string;
}

/**
 * Rolled-up CI verdict for the PR's head commit, in the exact vocabulary
 * the board's CI dot renders: green / red / amber / gray.
 */
export type GitCiState = 'passing' | 'failing' | 'pending' | 'unknown';

/** Aggregate review verdict across the PR's reviewers. */
export type GitReviewDecision = 'approved' | 'changes_requested' | 'review_required';

export interface GitPullRequestStatus {
	readonly number: number;
	/** `draft` is reported separately from `open` so the pill can say so. */
	readonly state: 'open' | 'draft' | 'closed' | 'merged';
	readonly merged: boolean;
	/** Provider's mergeability verdict; `null` when still being computed. */
	readonly mergeable?: boolean | null;
	readonly headSha?: string | null;
	/**
	 * The branch the pull request merges INTO (`main`, `develop`, …), as
	 * the provider reports it. Optional and additive.
	 *
	 * Reviewer agent stage (slice AD, EW-811): with `headSha` it pins a
	 * review diff to one commit — `getCompareDiff(baseRef, headSha)` — so
	 * the diff a reviewer reads is the content of the commit its verdict
	 * is bound to, not whatever the pull request's head happens to be a
	 * moment later. A caller that needs that guarantee refuses when this
	 * is absent.
	 */
	readonly baseRef?: string | null;
	readonly reviewDecision?: GitReviewDecision | null;
	/**
	 * Roll-up over EVERY check the provider reports for the head commit —
	 * never over the bounded `checks` sample below.
	 *
	 * Merge approval (slice AE) turned this from a display value into an
	 * authorization input (`GitFacadeService.assertAgentMayMerge` and
	 * `TaskMergeGateService` both refuse a merge unless it is `passing`),
	 * so an implementation that rolled up its own truncated display list
	 * would report a red pull request green. Roll up first, cap second.
	 */
	readonly ciState: GitCiState;
	/** Bounded list — implementations cap it (see `MAX_PR_CHECKS`). */
	readonly checks: readonly GitPullRequestCheck[];
	/**
	 * False when the implementation could NOT read the provider's whole
	 * check set for this commit (a source it lacks scope for, more checks
	 * than it is willing to page through), so `ciState` is a roll-up over
	 * a subset and a failure may be hiding in the part it never saw.
	 *
	 * Undefined means "not reported", which older implementations and
	 * simple doubles will leave as-is; only an explicit `false` is a
	 * warning. Display surfaces may ignore it — a mostly-right dot is
	 * still useful — but anything using `ciState` to AUTHORIZE (the merge
	 * gate) must treat `false` as "not green".
	 */
	readonly checksComplete?: boolean;
	readonly url?: string;
	readonly title?: string;
	/**
	 * `"{owner}/{repo}"` of the head branch's repository — the same fact
	 * `GitPullRequest.headRepoFullName` carries, on the STATUS read
	 * (APW-09 T1). The status poll is what notices that a tracked pull
	 * request's head repository has gone; `null` means the provider
	 * reported none, `undefined` that this read did not report it.
	 */
	readonly headRepoFullName?: string | null;
}

// ── Workflow runs (release promotion lane, self-build slice AI) ─────
//
// One OPTIONAL read capability, deliberately narrow: the verdict of ONE
// named workflow file for ONE commit.
//
// This is not the same question as `getPullRequestStatus`. That answers
// "should the board's dot be green?" by rolling up every check on the
// head commit, and that roll-up treats `skipped`, `neutral`, `stale` and
// `cancelled` as non-blocking — correct for a dot, and unusable as a
// release gate, where a gate that skipped itself is precisely the case
// that must not read as a pass. It also cannot prove ABSENCE: the
// `checks[]` it returns is a capped sample, so a named check missing from
// it may simply have sorted past the cap.
//
// A provider without workflows simply omits this, and the caller treats
// the absence as "the gate is unreadable", which is not a pass.

/**
 * One run of one workflow file against one commit.
 *
 * `status` / `conclusion` reuse the check vocabulary above on purpose:
 * providers already map their own words onto it, and a second vocabulary
 * for the same idea is a second place for a mapping to go wrong.
 */
export interface GitWorkflowRun {
	/** Provider-side run id — for the operator, not for logic. */
	readonly id: number;
	/**
	 * Workflow file this run belongs to, as the provider reports it
	 * (e.g. `.github/workflows/promotion-gate.yml`). Echoed back so a
	 * caller can assert it got the workflow it asked for.
	 */
	readonly workflowPath: string;
	/** The commit the run was for. */
	readonly headSha: string;
	readonly status: GitCheckStatus;
	/** `null` while the run has not completed. */
	readonly conclusion?: GitCheckConclusion | null;
	/** Deep link for the human who has to read the log. */
	readonly url?: string;
	/** Re-runs bump this; the newest attempt is the one reported. */
	readonly runAttempt?: number;
	/**
	 * Pull requests this run was triggered for, by number, when the
	 * provider reports them.
	 *
	 * A workflow run is keyed by COMMIT, and one commit can head more
	 * than one pull request — `stage` can be the head of both a
	 * `stage -> main` promotion and somebody's hotfix comparison. A run
	 * adopted off the commit alone therefore need not be the run for the
	 * pull request being judged, and the two can differ in exactly the
	 * way that matters (a per-pull-request override label).
	 *
	 * `undefined` means the provider did not say, which is NOT a licence
	 * to assume a match: the release promotion lane treats a run that
	 * names pull requests NOT including its own as no run at all.
	 */
	readonly pullRequestNumbers?: readonly number[];
}

// ── Upstream pull requests (APW-09 T2, plan §3.3/§4) ────────────────
//
// The two review reads and the temporary-interaction-limit read an upstream
// pull request needs, plus their element types. All three members are
// OPTIONAL on `IGitProviderPlugin` (declared at the foot of this file), and
// the calling rule is the one the fork-lifecycle group already states:
// **materialise the method on the plugin instance before calling it**,
// because the lazy-plugin proxy over-reports optional methods.
//
// Nothing here reuses `GitReviewDecision`: that type is GitHub's
// `review_decision` AGGREGATE ("the pull request as a whole"), and the
// review SUMMARY APW-09 derives (latest non-`pending`, non-`dismissed` review
// per author, `changes_requested` > `approved` > `commented`) cannot be
// computed from an aggregate that never says who reviewed or when.

/** The five review states a provider's review list is mapped onto. */
export type GitPullRequestReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';

/**
 * One review submitted on a pull request.
 *
 * The state union is closed and five-valued on purpose: `dismissed` and
 * `pending` are NOT folded into `commented`. A dismissed review no longer
 * counts for or against the pull request, and a pending one has not been
 * submitted at all, so a summary that treated either as a comment would
 * report a reviewer's opinion that the upstream project does not have.
 */
export interface GitPullRequestReview {
	/** Provider-side review id — the identity a status poll diffs on. */
	readonly id: number;
	readonly state: GitPullRequestReviewState;
	/** Reviewer login; `null` when the provider reports no author. */
	readonly author: string | null;
	/** ISO timestamp, or `null` for a review that was never submitted. */
	readonly submittedAt: string | null;
	/** Review body, capped by the implementation (APW-09: ≤ 8 KB). */
	readonly body: string;
}

/**
 * One inline review comment on a pull request — a comment on a line of a
 * file, which is the half of a review a follow-up Task must be seeded with
 * (a review's own `body` is the summary; the comments are the instructions).
 */
export interface GitPullRequestReviewComment {
	readonly id: number;
	/** Commenter login; `null` when the provider reports no author. */
	readonly author: string | null;
	/** Comment body, capped by the implementation (APW-09: ≤ 4 KB). */
	readonly body: string;
	/** File the comment is anchored to; `null` for a file-level comment. */
	readonly path: string | null;
	/**
	 * Line the comment is anchored to; `null` when the provider reports no
	 * line (an outdated comment on a commit the pull request no longer
	 * points at, or a provider without line anchors).
	 */
	readonly line: number | null;
	/** ISO timestamp, or `null` when the provider reports none. */
	readonly createdAt: string | null;
}

/**
 * A repository's TEMPORARY interaction limit — the four values GitHub's
 * `interaction-limits` endpoint can report.
 *
 * `null` (the return type of `getInteractionLimit?`) is a fifth answer and
 * NOT a synonym for `'none'`: it means "cannot tell" — the read was refused,
 * the repository is invisible, or the provider has no such capability — and
 * a caller must never read it as "unrestricted" (APW-09 G16).
 */
export type GitInteractionLimit = 'none' | 'existing_users' | 'contributors_only' | 'collaborators_only';

/** Hard caps a diff request may ask for. */
export interface GitDiffOptions {
	readonly maxBytes?: number;
	readonly maxFiles?: number;
}

export interface GitDiffFile {
	readonly path: string;
	/** Provider status verbatim (`added`/`modified`/`removed`/…). */
	readonly status: string;
	/**
	 * The path this file had BEFORE the change, for a rename or a copy
	 * (GitHub `previous_filename`). Optional and additive: absent for every
	 * other status, and for providers that do not report it.
	 *
	 * Reviewer agent stage (slice AD, EW-811): a rename is a change to the
	 * OLD path as well as the new one — moving a workflow file or a spec out
	 * of its active location is invisible in the new path's hunks alone —
	 * so the review brief prints it, and refuses a rename that lacks it.
	 */
	readonly previousPath?: string;
	readonly additions: number;
	readonly deletions: number;
	/** Unified patch; omitted when the byte budget was already spent. */
	readonly patch?: string;
	/** True when this file's own patch was dropped for the byte budget. */
	readonly patchOmitted?: boolean;
}

export interface GitDiffResult {
	readonly files: readonly GitDiffFile[];
	/** True when files and/or patches were dropped to honour the caps. */
	readonly truncated: boolean;
	/** Files the provider reported BEFORE the file cap was applied. */
	readonly totalFiles: number;
	readonly totalAdditions: number;
	readonly totalDeletions: number;
	/** Bytes of patch text actually returned. */
	readonly patchBytes: number;
	/**
	 * How many COMMITS the compared range holds, as the provider reports it
	 * (GitHub's compare payload carries `total_commits`) — APW-09 T1 (G13).
	 *
	 * It exists because a commit count cannot be derived from the file list
	 * at all: one commit can touch forty files and forty commits can touch
	 * one. APW-09's `notSingleCommit` check reads THIS and never the file
	 * count.
	 *
	 * OPTIONAL, and absence is meaningful: `undefined` is "this read did
	 * not report a commit count" (a provider whose diff endpoint has none,
	 * or a file-list-backed read), never "zero commits".
	 */
	readonly totalCommits?: number;
}

/**
 * Local git operations using isomorphic-git.
 * Implemented in BaseGitProvider - plugin developers extend that class.
 */
export interface IGitOperations {
	cloneOrPull(options: GitCloneOptions): Promise<string>;
	/**
	 * Clone one branch into a working directory of its own.
	 *
	 * `cloneOrPull` keys its directory on owner+repo only and switches the
	 * checkout back to the default branch, so it cannot express "give me
	 * THIS branch" for two branches of the same repo in one run. This does:
	 * every call gets its own directory with `branch` checked out, and the
	 * caller removes it when finished.
	 *
	 * Optional so existing providers keep compiling. Callers MUST verify
	 * the method is present before calling it — the lazy-plugin proxy
	 * over-reports optional methods (see `GitFacadeService`).
	 */
	cloneBranch?(options: GitCloneBranchOptions): Promise<string>;
	pull(dir: string, token: string, committer?: GitCommitter): Promise<void>;
	add(dir: string, paths: string | string[]): Promise<void>;
	addAll(dir: string): Promise<void>;
	commit(dir: string, message: string, committer?: GitCommitter): Promise<string | null>;
	push(options: GitPushOptions): Promise<void>;
	getCurrentBranch(dir: string): Promise<string | null>;
	getMainBranch(dir: string): Promise<string | null>;
	switchBranch(dir: string, branch: string, create?: boolean): Promise<string>;
	getStatus(dir: string): Promise<GitFileChange[]>;
	/**
	 * Absolute path of the working copy for `owner/repo`.
	 *
	 * The name is derived from the provider identity, the owner and the repository name
	 * byte-for-byte, so two distinct coordinates can never share a directory. `checkoutKey` asks
	 * for a working copy of its own instead (see `GitCloneOptions.checkoutKey`); omitting it keeps
	 * the per-repository directory every existing caller already uses.
	 */
	getLocalDir(owner: string, repo: string, checkoutKey?: string): string;
	removeLocalDir(owner: string, repo: string, checkoutKey?: string): Promise<void>;
	replaceRemote(dir: string, remote: string, url: string): Promise<void>;
	renameBranch(dir: string, oldName: string, newName: string): Promise<void>;
}

/**
 * Git provider plugin for provider-specific API operations.
 * Also includes local git operations (clone, push, commit) via IGitOperations.
 */
export interface IGitProviderPlugin extends IPlugin, IGitOperations {
	readonly providerName: string;

	// Authentication
	getAuth(token: string): GitAuth;
	getCloneUrl(owner: string, repo: string): string;
	getWebUrl(owner: string, repo: string): string;

	// Repository operations
	listRepositories?(
		token: string,
		page?: number,
		perPage?: number,
		options?: ListRepositoriesOptions
	): Promise<GitRepositoryWithPermissions[]>;
	createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository>;
	getRepository(owner: string, repo: string, token: string): Promise<GitRepositoryWithPermissions | null>;
	hasRepositoryAccess?(owner: string, repo: string, token: string): Promise<boolean>;
	deleteRepository(owner: string, repo: string, token: string): Promise<void>;
	updateRepository?(owner: string, repo: string, data: UpdateRepoOptions, token: string): Promise<GitRepository>;

	// User & organization
	getUser(token: string): Promise<GitUser>;
	getOrganizations(token: string): Promise<GitOrganization[]>;

	// Branch operations
	listBranches(owner: string, repo: string, token: string): Promise<GitBranch[]>;
	createBranch?(owner: string, repo: string, name: string, fromRef: string, token: string): Promise<GitBranch>;
	deleteBranch?(owner: string, repo: string, name: string, token: string): Promise<void>;

	// Pull request operations
	createPullRequest(options: CreatePROptions, token: string): Promise<GitPullRequest>;
	getPullRequest?(owner: string, repo: string, prNumber: number, token: string): Promise<GitPullRequest | null>;
	mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string
	): Promise<MergeResult>;

	// Repository ownership transfer (optional; providers without an equivalent API omit this)
	transferRepository?(
		owner: string,
		repo: string,
		options: TransferRepoOptions,
		token: string
	): Promise<TransferRepoResult>;

	// Fork & template operations
	forkRepository?(
		owner: string,
		repo: string,
		options: ForkRepositoryOptions,
		token: string
	): Promise<GitRepository | null>;
	createRepositoryFromTemplate?(
		templateOwner: string,
		templateRepo: string,
		options: CreateRepoOptions,
		token: string
	): Promise<GitRepository | null>;
	hasForkRelationship?(
		forkOwner: string,
		forkRepo: string,
		parentOwner: string,
		parentRepo: string,
		token: string
	): Promise<boolean>;

	// Community PR operations
	listPullRequests?(
		owner: string,
		repo: string,
		options: ListPullRequestsOptions | undefined,
		token: string
	): Promise<GitPullRequest[]>;
	getPullRequestFiles?(owner: string, repo: string, prNumber: number, token: string): Promise<GitPullRequestFile[]>;

	/**
	 * PR insights (kanban M5) — state + review decision + rolled-up CI
	 * verdict for the board's review pill. Returns `null` when the PR
	 * does not exist (never throws for a 404), so a deleted PR degrades
	 * to "no pill" instead of an error banner.
	 */
	getPullRequestStatus?(
		owner: string,
		repo: string,
		prNumber: number,
		token: string
	): Promise<GitPullRequestStatus | null>;

	/**
	 * PR insights (kanban M6) — capped diff for the board's preview
	 * sheet. Implementations MUST honour `opts.maxFiles`/`opts.maxBytes`
	 * and report `truncated: true` when anything was dropped: the caller
	 * shows a "see the full diff on the provider" link off that flag.
	 */
	getPullRequestDiff?(
		owner: string,
		repo: string,
		prNumber: number,
		opts: GitDiffOptions | undefined,
		token: string
	): Promise<GitDiffResult>;

	/**
	 * Release promotion lane (slice AI) — the MOST RECENT run of one
	 * named workflow file for one commit, or `null` when that workflow has
	 * no run for that commit.
	 *
	 * `null` and a throw mean different things and both matter: `null` is
	 * a real answer ("the gate never ran on this commit"), a throw is a
	 * broken lookup. Implementations MUST NOT collapse a failed read into
	 * `null` — the caller renders them differently and refuses on both,
	 * but sends the operator to different places.
	 *
	 * `workflowPath` may be given as a bare file name (`promotion-gate.yml`)
	 * or a repository path (`.github/workflows/promotion-gate.yml`);
	 * implementations match on the file name.
	 */
	getWorkflowRunForCommit?(
		owner: string,
		repo: string,
		workflowPath: string,
		headSha: string,
		token: string
	): Promise<GitWorkflowRun | null>;

	/**
	 * Same shape for a branch that has no PR yet (`base...head`). Cheap
	 * on providers with a compare endpoint; omit it where there is none.
	 */
	getCompareDiff?(
		owner: string,
		repo: string,
		base: string,
		head: string,
		opts: GitDiffOptions | undefined,
		token: string
	): Promise<GitDiffResult>;
	createPullRequestComment?(
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
		token: string
	): Promise<{ id: number; body: string }>;
	closePullRequest?(owner: string, repo: string, prNumber: number, token: string): Promise<GitPullRequest>;

	// Utility
	repositoryExists?(owner: string, repo: string, token: string): Promise<boolean>;
	getLatestCommit?(owner: string, repo: string, branch: string, token: string): Promise<GitCommit | null>;

	// Content access (for analyzing repositories)
	getFileContent?(
		owner: string,
		repo: string,
		path: string,
		ref?: string,
		token?: string
	): Promise<{ content: string; encoding: string } | null>;

	/**
	 * EW-641 Phase 1B/d row 18b — list commits that touched the given
	 * file path, newest first. Powers the KB "View Git history" dialog
	 * (`KnowledgeBaseService.getDocumentHistory` →
	 * `KnowledgeBaseGitMirrorService.listDocumentHistory` → here).
	 *
	 * Optional — providers that don't implement it surface as
	 * `{ items: [] }` to the dialog, which already handles the empty
	 * state. Default `limit` is 25; implementations should cap at 100.
	 */
	listFileCommits?(owner: string, repo: string, path: string, token: string, limit?: number): Promise<GitCommit[]>;

	getReadme?(
		owner: string,
		repo: string,
		ref?: string,
		token?: string
	): Promise<{ content: string; path: string } | null>;
	getRawFileUrl?(owner: string, repo: string, branch: string, path: string): string;
	getWorkContents?(
		owner: string,
		repo: string,
		path: string,
		token: string
	): Promise<Array<{ name: string; type: 'file' | 'dir' | 'submodule' | 'symlink'; path: string }> | null>;

	// ── Fork lifecycle (APW-02 T10, plan §3.3) ───────────────────────────────
	//
	// Nine OPTIONAL methods: the seven of APW-02 P1 plus APW-09's two branch-ref
	// moves (CONTRACTS §3 — whichever epic lands first creates them; APW-02 P1
	// lands in an earlier wave, so they are declared here and implemented in the
	// GitHub plugin with exactly these signatures).
	//
	// Every one of them carries the same calling rule, and it is not a formality:
	// **the caller MUST materialise the method on the plugin instance before
	// calling it** (`typeof impl.<method> === 'function'`). The lazy-plugin proxy
	// over-reports optional methods, so a call that skips that check reaches a
	// provider that never implemented the method and fails as a provider error
	// instead of the caller-actionable "this provider does not support it"
	// (`GitOperationNotSupportedError`, the existing 409 mapping — plan §4.2).
	//
	// Each method throws `GitProviderRequestError` on a provider failure; the
	// absence of the method is the caller's to detect, never the plugin's to
	// throw.

	/**
	 * Find a fork of `upstreamOwner/upstreamRepo` that already exists under
	 * `targetOwner`, or `null` when there is none (FR-10: never fork twice).
	 *
	 * The lookup is what keeps a renamed fork from being duplicated, so an
	 * implementation that cannot search must answer `null` honestly rather than
	 * guess — the request then proceeds to the provider's fork endpoint, which
	 * answers with the existing fork instead of creating a second one.
	 *
	 * OPTIONAL. Callers MUST materialise `findExistingFork` on the plugin before
	 * calling it: the lazy-plugin proxy over-reports optional methods, so an
	 * unmaterialised call fails as a provider error rather than as
	 * `providerUnsupported`.
	 */
	findExistingFork?(
		upstreamOwner: string,
		upstreamRepo: string,
		targetOwner: string,
		token: string
	): Promise<GitRepository | null>;

	/**
	 * Bring a fork's `branch` up to date with the upstream branch it was forked
	 * from. `conflict` and `unprocessable` are returned, not thrown.
	 *
	 * OPTIONAL. Callers MUST materialise `syncForkBranch` on the plugin before
	 * calling it (the lazy-plugin proxy over-reports optional methods).
	 */
	syncForkBranch?(forkOwner: string, forkRepo: string, branch: string, token: string): Promise<GitForkSyncResult>;

	/**
	 * How far a fork's branch has drifted from its upstream branch — the read
	 * behind "your fork is N behind". `upstreamHeadSha` is the upstream head as
	 * the fork network sees it, not the upstream repository's live head.
	 *
	 * OPTIONAL. Callers MUST materialise `getForkDivergence` on the plugin
	 * before calling it (the lazy-plugin proxy over-reports optional methods).
	 */
	getForkDivergence?(
		forkOwner: string,
		forkRepo: string,
		forkBranch: string,
		upstreamOwner: string,
		upstreamBranch: string,
		token: string
	): Promise<GitForkDivergence>;

	/**
	 * Copy one branch of a repository into another repository the platform owns
	 * — the `private-copy` repository mode. The source is cloned, never forked,
	 * so no fork relationship is created.
	 *
	 * `input.maxSizeKb` is the size the caller already authorised; an
	 * implementation refuses a larger source before doing any git work.
	 *
	 * OPTIONAL. Callers MUST materialise `createRepositoryCopy` on the plugin
	 * before calling it (the lazy-plugin proxy over-reports optional methods).
	 */
	createRepositoryCopy?(input: GitRepositoryCopyInput, token: string): Promise<GitRepositoryCopyResult>;

	/**
	 * Apply APW-05's Actions hygiene to a repository: the repo-level Actions
	 * switch, the workflows to enable, and the active workflows to disable.
	 *
	 * Omitted fields mean "leave that alone" — `disableWorkflowsExcept: []` is
	 * an instruction, `undefined` is not. Implementations report what they
	 * actually did (including `truncated` when the page cap was reached), and
	 * stop on a permission failure rather than half-applying the rest silently.
	 *
	 * OPTIONAL. Callers MUST materialise `setActionsPermissions` on the plugin
	 * before calling it (the lazy-plugin proxy over-reports optional methods).
	 */
	setActionsPermissions?(
		owner: string,
		repo: string,
		input: GitActionsPermissionsInput,
		token: string
	): Promise<GitActionsPermissionsResult>;

	/**
	 * Install a webhook on a repository. `created` is `false` when the provider
	 * reported an existing hook for the same URL and returned it instead of
	 * creating a second one (the idempotent case).
	 *
	 * APW-05 is the only caller (the `app-build-prepare` job installs the signed
	 * `workflow_run` receiver); adding a hook must never re-create one.
	 *
	 * OPTIONAL. Callers MUST materialise `createWebhook` on the plugin before
	 * calling it (the lazy-plugin proxy over-reports optional methods).
	 */
	createWebhook?(
		owner: string,
		repo: string,
		input: GitWebhookInput,
		token: string
	): Promise<{ id: number; created: boolean }>;

	/**
	 * Remove a webhook by id. Deleting hook `A` MUST NOT delete hook `B` — the
	 * id is the only address, so a provider that cannot delete by id omits this
	 * method rather than resolving the id to the wrong hook.
	 *
	 * OPTIONAL. Callers MUST materialise `deleteWebhook` on the plugin before
	 * calling it (the lazy-plugin proxy over-reports optional methods).
	 */
	deleteWebhook?(owner: string, repo: string, hookId: number, token: string): Promise<void>;

	/**
	 * Create a branch ref pointing at an exact commit sha.
	 *
	 * Distinct from `createBranch?`, whose `fromRef` is a branch name: pointing a
	 * sync or preparation branch at a sha needs this, because deleting and
	 * recreating the branch would close the pull request that is open on it
	 * (plan §3.3, APW-09's signature — §3.3 names no return type; `GitBranch` is
	 * the shape its sibling `createBranch?` returns).
	 *
	 * OPTIONAL. Callers MUST materialise `createBranchFromSha` on the plugin
	 * before calling it (the lazy-plugin proxy over-reports optional methods).
	 */
	createBranchFromSha?(owner: string, repo: string, name: string, sha: string, token: string): Promise<GitBranch>;

	/**
	 * Move an existing branch ref to a commit sha — **fast-forward only**.
	 *
	 * `options.force` is typed `false` on purpose: no force-move exists anywhere
	 * in this epic, so a supplier of `true` is a compile error rather than a
	 * silent history rewrite. A provider that answers "not a fast forward" is
	 * reported as `unprocessable`.
	 *
	 * OPTIONAL. Callers MUST materialise `updateBranchRef` on the plugin before
	 * calling it (the lazy-plugin proxy over-reports optional methods).
	 */
	updateBranchRef?(
		owner: string,
		repo: string,
		name: string,
		sha: string,
		options: { force: false },
		token: string
	): Promise<GitBranch>;

	// ── Upstream pull requests (APW-09 T2, plan §4) ──────────────────────────
	//
	// Three OPTIONAL reads an upstream pull request needs while it is open,
	// with the element types declared above. Same calling rule as the fork
	// group: materialise the member on the plugin before calling it.
	//
	// The two review lists THROW when absent rather than answering `[]`,
	// because an empty list is a fact ("nobody reviewed this yet") and the
	// absence is a different one ("this provider cannot answer"), and only
	// the caller can decide which of the two its surface should show. The
	// interaction limit is the exception: its absence answers `null`, which
	// is already this read's own honest answer for "cannot tell".

	/**
	 * Every review on a pull request, oldest first, bounded (APW-09: ≤ 100
	 * reviews, each `body` ≤ 8 KB).
	 *
	 * The bound is a real one, not a hint: a status poll reads this list on
	 * every due row, and GitHub's default page is 30. An implementation
	 * must not silently page past the cap — the caller derives its review
	 * summary from what it is given and diffs new ids on the next poll.
	 *
	 * OPTIONAL. Callers MUST materialise `listPullRequestReviews` on the
	 * plugin before calling it (the lazy-plugin proxy over-reports optional
	 * methods).
	 */
	listPullRequestReviews?(
		owner: string,
		repo: string,
		prNumber: number,
		token: string
	): Promise<GitPullRequestReview[]>;

	/**
	 * Inline review comments on a pull request, bounded (APW-09: ≤ 100
	 * comments, each `body` ≤ 4 KB) — the brief a review follow-up is
	 * seeded with.
	 *
	 * OPTIONAL. Callers MUST materialise `listPullRequestReviewComments` on
	 * the plugin before calling it.
	 */
	listPullRequestReviewComments?(
		owner: string,
		repo: string,
		prNumber: number,
		token: string
	): Promise<GitPullRequestReviewComment[]>;

	/**
	 * The repository's temporary interaction limit, or `null` for "cannot
	 * tell" — which includes every refused read (APW-09 G16: a 403, a 404
	 * and an empty answer are NOT `'none'`).
	 *
	 * This answers the TEMPORARY limit only. A repository that has pull
	 * requests switched off, or a cap on pull requests from outside
	 * contributors, are different repository-level settings with their own
	 * refusal codes; conflating them here would report an unrelated refusal
	 * as "interactions are restricted".
	 *
	 * OPTIONAL. Callers MUST materialise `getInteractionLimit` on the
	 * plugin before calling it.
	 */
	getInteractionLimit?(owner: string, repo: string, token: string): Promise<GitInteractionLimit | null>;
}

export function isGitProviderPlugin(plugin: IPlugin): plugin is IGitProviderPlugin {
	return plugin.capabilities.includes('git-provider');
}
