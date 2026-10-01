/**
 * App Works — the fork-lifecycle plugin contract types (APW-02 T9).
 *
 * This module is the typed surface APW-02 P1 (the fork lifecycle), APW-01
 * (App Work creation), APW-05 (build preparation / Actions hygiene) and
 * APW-09 (upstream pull requests) compile against. The seven **optional**
 * members that consume these types are merged into `IGitProviderPlugin` by
 * `git-provider.interface.ts`; `capabilities/index.ts` re-exports this module
 * and `git/index.ts` re-exports it for plugin authors.
 *
 * **Additive-only (top priority).** Nothing here removes, renames, narrows or
 * makes required anything that exists: every type is new, the error class is
 * new, and every member it feeds is optional, so a git-provider plugin that
 * implements only the pre-existing surface (the GitHub plugin, a third-party
 * provider, a test double) still satisfies `IGitProviderPlugin` and behaves
 * exactly as it does today.
 *
 * Source, field for field: `docs/specs/features/app-works/APW-02-fork-lifecycle/plan.md`
 * §3.3 ("Plugin contract additions"), with the GitHub mapping rules in §4.3.
 *
 * Two notes on the transcription, neither of which changes a signature:
 *
 * - §3.3 declares the `details` bag inline in the `GitProviderRequestError`
 *   constructor. It is a named, exported interface here
 *   ({@link GitProviderErrorDetails}) so a caller can type the bag without
 *   reaching into `ConstructorParameters<…>`; the shape is identical.
 * - §3.3 gives `createBranchFromSha?` / `updateBranchRef?` as parameter lists
 *   only (they are APW-09's methods, CONTRACTS §3 row "added by APW-09"). Both
 *   return `Promise<GitBranch>` here — the existing branch shape the sibling
 *   `createBranch?` returns — because the plan does not name a return type.
 */

/**
 * Why a provider call failed, in vocabulary every consumer can branch on
 * without reading a provider's own error text.
 *
 * The mapping from provider signals to these reasons is per-implementation
 * (plan §4.2 is GitHub's table). `retryAt` and `permission` travel beside the
 * reason in {@link GitProviderRequestError.details} — a rate limit is only
 * actionable with the reset time, and a permission failure only with the
 * permission that is missing.
 */
export type GitProviderErrorReason =
	| 'not_found'
	| 'unauthorized'
	| 'rate_limited'
	| 'secondary_rate_limited'
	| 'sso_authorization_required'
	| 'oauth_app_restricted'
	| 'permission_missing'
	| 'conflict'
	| 'unprocessable';

/**
 * Caller-actionable detail carried by a {@link GitProviderRequestError}.
 *
 * Both fields are optional: a reason that has no extra detail simply omits them
 * rather than inventing a value. `retryAt` is an ISO-8601 timestamp (the
 * provider's own reset/`retry-after`), never a pre-computed delay, so a caller
 * that has to show the operator "try again at …" and one that has to sleep can
 * both read it.
 */
export interface GitProviderErrorDetails {
	/** ISO-8601 instant the caller may retry at, when the provider named one. */
	readonly retryAt?: string;
	/**
	 * The permission the failed call needed. `administration` and `actions` are
	 * the two an Actions-hygiene call can be refused for depending on whether
	 * the credential is an App installation token or a user token (plan §4.3).
	 */
	readonly permission?: 'contents' | 'pull_requests' | 'administration' | 'actions' | 'webhooks' | 'metadata';
}

/**
 * The single error every new fork-lifecycle plugin method throws.
 *
 * `reason` is the branch point, `status` the provider's HTTP status (kept so
 * existing `err.status` checks keep working — plan §4.2), and `details` the
 * optional `retryAt` / `permission` bag above. `message` is the reason itself.
 *
 * Extending `Error` is load-bearing: callers catch it as an `Error`, and a
 * `reason` they do not recognise must degrade to "the call failed", never to a
 * silently swallowed object.
 */
export class GitProviderRequestError extends Error {
	constructor(
		readonly reason: GitProviderErrorReason,
		readonly status: number,
		readonly details: GitProviderErrorDetails = {}
	) {
		super(reason);
	}
}

/**
 * Outcome of asking the provider to bring a fork's branch up to date with the
 * upstream branch it was forked from.
 *
 * `merged` is the provider telling us it had to create a merge commit (GitHub
 * `merge_type: merge`) — APW-02 only calls this on a behind-only fork, so a
 * `merged` is a race it records as fast-forward-equivalent with a warning
 * (plan §4.3). `conflict` and `unprocessable` are answers, not throws: the
 * caller renders "your fork needs attention" off them.
 */
export interface GitForkSyncResult {
	readonly outcome: 'fast_forwarded' | 'merged' | 'up_to_date' | 'conflict' | 'unprocessable';
	/** The branch the provider reported syncing, when it reports one. */
	readonly baseBranch?: string;
}

/**
 * How far a fork's branch has drifted from its upstream branch.
 *
 * `upstreamHeadSha` is the upstream head **as the fork network sees it** (the
 * compare's base commit), which is the commit a sync pull request would be
 * opened against — not necessarily the upstream repository's current head.
 */
export interface GitForkDivergence {
	readonly aheadBy: number;
	readonly behindBy: number;
	readonly upstreamHeadSha: string;
	readonly forkHeadSha: string;
}

/**
 * A private copy of a repository: one branch of the source, pushed into a
 * repository the platform owns.
 *
 * `maxSizeKb` is the size the caller has already authorised; an implementation
 * refuses a source larger than it (`unprocessable`, plan §4.3) rather than
 * starting a clone it cannot finish. `branchName` defaults to `sourceBranch`.
 */
export interface GitRepositoryCopyInput {
	readonly sourceOwner: string;
	readonly sourceRepo: string;
	readonly sourceBranch: string;
	readonly targetOwner: string;
	readonly targetRepo: string;
	readonly maxSizeKb: number;
	readonly branchName?: string;
}

/**
 * Result of {@link GitRepositoryCopyInput}'s copy.
 *
 * `alreadyUpToDate` is set when the target branch already pointed at the
 * source head, so a caller can tell "copied" from "there was nothing to copy"
 * — it is still a success, and `pushedSha` is still the commit now present in
 * the target.
 */
export interface GitRepositoryCopyResult {
	readonly pushedSha: string;
	readonly alreadyUpToDate: boolean;
}

/** One workflow file of a repository, as the Actions API reports it. */
export interface GitWorkflowRef {
	readonly id: number;
	readonly path: string;
}

/**
 * What a caller wants done to a repository's Actions state.
 *
 * Every field is optional and an omitted field means "leave that alone" —
 * which is why `disableWorkflowsExcept` is only acted on when present: an
 * empty array is a real instruction ("disable everything not listed"), while
 * `undefined` is not an instruction at all.
 */
export interface GitActionsPermissionsInput {
	/** Repo-level Actions switch; omitted = unchanged (APW-05 passes `true`). */
	readonly enabled?: boolean;
	/** Hygiene: disable every active workflow not listed here. */
	readonly disableWorkflowsExcept?: readonly string[];
	/** APW-05: enable exactly these paths. */
	readonly enableWorkflows?: readonly string[];
	/** Ids never touched — already judged (FR-27), so re-enabling them is wrong. */
	readonly skipWorkflowIds?: readonly number[];
	/** Page cap for the workflow listing; implementations default it to 100. */
	readonly maxWorkflows?: number;
}

/**
 * What the Actions call actually did, itemised.
 *
 * `seenIds` is the audit half: it is every workflow id the implementation
 * looked at, so a caller can prove its `skipWorkflowIds` were honoured and see
 * what a paginated read covered. `truncated` says the `maxWorkflows` cap was
 * reached before the repository's workflows ran out — a partial pass, which
 * hygiene must not report as a complete one.
 */
export interface GitActionsPermissionsResult {
	readonly actionsEnabled: boolean;
	readonly disabled: readonly GitWorkflowRef[];
	readonly kept: readonly GitWorkflowRef[];
	readonly enabled: readonly GitWorkflowRef[];
	readonly seenIds: readonly number[];
	readonly truncated: boolean;
}

/**
 * A webhook to install on a repository the platform now controls.
 *
 * `secret` is the signing secret the receiver verifies deliveries with; it is
 * passed in by the caller and MUST NOT be logged or echoed back by an
 * implementation.
 */
export interface GitWebhookInput {
	readonly url: string;
	readonly secret: string;
	readonly events: readonly string[];
}
