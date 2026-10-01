import * as fs from 'node:fs';
import { Octokit, RequestError } from 'octokit';
import type {
	GitRepository,
	GitUser,
	GitOrganization,
	GitBranch,
	GitCommit,
	GitPullRequest,
	GitPullRequestAuthor,
	GitPullRequestFile,
	CreateRepoOptions,
	UpdateRepoOptions,
	CreatePROptions,
	MergeOptions,
	MergeResult,
	ForkRepositoryOptions,
	GitRepositoryWithPermissions,
	ListRepositoriesOptions,
	ListPullRequestsOptions,
	TransferRepoOptions,
	TransferRepoResult,
	GitCheckConclusion,
	GitCheckStatus,
	GitDiffFile,
	GitDiffOptions,
	GitDiffResult,
	GitPullRequestCheck,
	GitPullRequestStatus,
	GitReviewDecision,
	GitWorkflowRun,
	// App Works fork lifecycle (APW-02 T18).
	GitForkSyncResult,
	GitForkDivergence,
	// App Works fork lifecycle (APW-02 T19/T20/T21): the private copy, the Actions
	// hygiene pass and the webhooks.
	GitRepositoryCopyInput,
	GitRepositoryCopyResult,
	GitActionsPermissionsInput,
	GitActionsPermissionsResult,
	GitWorkflowRef,
	GitWebhookInput,
	GitProviderErrorDetails,
	// Upstream pull requests (APW-09 T2): the two review reads and the temporary
	// interaction limit.
	GitPullRequestReview,
	GitPullRequestReviewState,
	GitPullRequestReviewComment,
	GitInteractionLimit,
	IGitOperations
} from '@ever-works/plugin/git';
import {
	capChecks,
	capDiffFiles,
	deriveCiState,
	resolveDiffCaps,
	GitProviderRequestError
} from '@ever-works/plugin/git';
// Security (SSRF): the same lexical guard this plugin already applies to its own
// configurable `apiBaseUrl` (see `github.plugin.ts`). A webhook URL is
// member-supplied and handed to a third party to deliver to, so it gets the same
// treatment. Imported from the dedicated subpath because the guard pulls in
// node:net/dns and is intentionally not re-exported from the package root.
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';
import { GitHubVerifiedOrgService, parseVerifiedOrgs } from './github-verified-org.service.js';
import { toGitProviderError } from './github-errors.js';
// APW-13 T5: the non-production acceptance switch (CONTRACTS §7 row
// `EVER_WORKS_E2E_FAKES`). Imported from the leaf module rather than from
// `github.plugin.ts`, which imports this service — importing the plugin here
// would close a cycle.
import { resolveGitHubE2eFakeOrigin } from './e2e-fakes.js';

/**
 * PR insights (kanban run cockpit M5/M6) — GitHub's check vocabulary
 * mapped onto the provider-neutral contract vocabulary. Anything not
 * listed degrades to `unknown`/`null` rather than being guessed at: an
 * unrecognised conclusion must never be laundered into a pass.
 */
const CHECK_STATUS_MAP: Record<string, GitCheckStatus> = {
	queued: 'queued',
	in_progress: 'in_progress',
	waiting: 'queued',
	requested: 'queued',
	pending: 'queued',
	completed: 'completed'
};

const CHECK_CONCLUSION_MAP: Record<string, GitCheckConclusion> = {
	success: 'success',
	failure: 'failure',
	neutral: 'neutral',
	cancelled: 'cancelled',
	timed_out: 'timed_out',
	action_required: 'action_required',
	skipped: 'skipped',
	stale: 'stale',
	// Legacy commit-status states share the rollup vocabulary.
	error: 'failure'
};

const REVIEW_DECISION_MAP: Record<string, GitReviewDecision> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes_requested',
	REVIEW_REQUIRED: 'review_required'
};

// ── Upstream pull requests (APW-09 T1/T2) ────────────────────────────────────
//
// The cross-repository head, the review reads and the temporary interaction
// limit of an upstream pull request. Every mapping below is ADDITIVE: a call
// that passes none of the new fields sends exactly the request it sent before
// (T1's "omission" rule), and a provider read that cannot answer says so
// rather than inventing an answer.

/**
 * Review states, GitHub's spelling → the contract's (APW-09 T2).
 *
 * GitHub's five values are exactly the contract's five. An unrecognised value
 * degrades to `commented` rather than being dropped: keeping the review visible
 * with the WEAKEST effect is the one mapping that can neither invent an
 * approval nor hide a reviewer, and the review-summary rule
 * (`changes_requested` > `approved` > `commented`) already treats `commented`
 * as contributing nothing but a name.
 */
const REVIEW_STATE_MAP: Record<string, GitPullRequestReviewState> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes_requested',
	COMMENTED: 'commented',
	DISMISSED: 'dismissed',
	PENDING: 'pending'
};

/**
 * Reviews and inline review comments read per pull request — one page, which is
 * GitHub's maximum. APW-09 polls this list on every due row (`≤ 4 requests`),
 * so a second page is not free and is not asked for: the caller diffs review
 * ids between polls, and 100 reviews on one pull request is already past the
 * point where a reviewer's LATEST word is what matters.
 */
const REVIEWS_PER_PAGE = 100;

/** APW-09 `UPSTREAM_TEXT` bounds, applied where the strings enter the platform. */
const REVIEW_BODY_MAX_BYTES = 8 * 1024;
const REVIEW_COMMENT_BODY_MAX_BYTES = 4 * 1024;

/** The four values GitHub's interaction-limit endpoints can report. */
const INTERACTION_LIMITS: readonly GitInteractionLimit[] = [
	'none',
	'existing_users',
	'contributors_only',
	'collaborators_only'
];

/** Is this string one of the four contract interaction limits? */
function isInteractionLimit(value: unknown): value is GitInteractionLimit {
	return typeof value === 'string' && (INTERACTION_LIMITS as readonly string[]).includes(value);
}

/**
 * Truncate a provider string to at most `maxBytes` UTF-8 bytes, on a code-point
 * boundary.
 *
 * Capped HERE, where the provider's text enters the platform, because both
 * consumers are size-bounded: the status poll checks `body.length` and the
 * review follow-up seeds fenced review text into a Task brief bounded at 64 KB
 * in total. A cut string carries a trailing `…` so a reader can tell a short
 * review from a truncated one — the contract's review shapes have no
 * `truncated` flag, and a silently cut instruction is worse than a visibly cut
 * one. The ellipsis is inside the budget, so the result never exceeds
 * `maxBytes`.
 */
function truncateUtf8(text: string, maxBytes: number): string {
	// eslint-disable-next-line no-undef
	if (typeof TextEncoder !== 'function') return text.slice(0, maxBytes);

	// eslint-disable-next-line no-undef
	const encoder = new TextEncoder();
	if (encoder.encode(text).length <= maxBytes) return text;

	const ELLIPSIS = '…';
	const ELLIPSIS_BYTES = encoder.encode(ELLIPSIS).length;
	const budget = Math.max(0, maxBytes - ELLIPSIS_BYTES);

	let out = '';
	let spent = 0;
	// `for … of` iterates CODE POINTS, so a surrogate pair is never split into
	// two lone halves (which would be encoded as replacement characters).
	for (const char of text) {
		const size = encoder.encode(char).length;
		if (spent + size > budget) break;
		out += char;
		spent += size;
	}
	return out + ELLIPSIS;
}

/**
 * The pull-request payload fields the T1 mappings read. Structural because the
 * three reads (create/get/list/status) return the same three shapes and this
 * file only needs the nested head repository.
 */
interface PullRequestHeadPayload {
	readonly head?: {
		readonly repo?: { readonly full_name?: string } | null;
	} | null;
}

/**
 * `"{owner}/{repo}"` of the head branch's repository, or `null` when the
 * provider reported none — GitHub answers `head.repo: null` once the head
 * repository is deleted, and that is a real answer APW-09 tracks (a pull
 * request whose head repository is gone must not read as "still ours").
 */
function headRepoFullName(pr: PullRequestHeadPayload): string | null {
	return pr.head?.repo?.full_name ?? null;
}

/**
 * How many of a commit's workflow runs to read when looking for one named
 * workflow (release promotion lane, slice AI). A single commit in this
 * monorepo triggers well under a dozen workflows; 100 is one page and
 * covers every realistic repository without a second round trip.
 */
const WORKFLOW_RUNS_PER_PAGE = 100;

/** The subset of GitHub's workflow-run payload this reads. */
interface WorkflowRunPayload {
	id?: number;
	path?: string;
	head_sha?: string;
	status?: string | null;
	conclusion?: string | null;
	html_url?: string;
	run_attempt?: number;
	/** `pull_requests[]` on a workflow run — present for `pull_request` events. */
	pull_requests?: Array<{ number?: number } | null> | null;
}

/** GitHub's label shape, as it appears on a pull-request payload. */
interface LabelPayload {
	name?: string | null;
}

/**
 * Label NAMES off a pull-request payload.
 *
 * Returns `undefined` — not `[]` — when the payload carried no `labels`
 * key at all, because `GitPullRequest.labels` is absence-ambiguous by
 * contract: "this read did not report labels" and "this pull request has
 * none" are different facts and must not render identically.
 */
function labelNames(raw: unknown): readonly string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	return raw
		.map((label) => (typeof label === 'string' ? label : ((label as LabelPayload)?.name ?? null)))
		.filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/**
 * A repository's topics, as GitHub reported them (APW-03 T22 — the Blueprint
 * probe and website-template discovery read `ever-works-app-blueprint` off
 * these). A payload without a list leaves `topics` unreported: `[]` is GitHub
 * saying "no topics", which an absent key is not. Non-string entries are dropped
 * rather than cast into the contract. Shared by `getRepository` and the list
 * mapping so a single read and a listing report the same fact the same way.
 */
function reportedTopics(raw: unknown): string[] | undefined {
	return Array.isArray(raw) ? raw.filter((topic): topic is string => typeof topic === 'string') : undefined;
}

/**
 * Last path segment of a workflow reference, lowercased.
 *
 * Callers name the gate as `promotion-gate.yml` while GitHub reports
 * `.github/workflows/promotion-gate.yml`; comparing file names makes both
 * forms work and keeps a repository that moves its workflows directory
 * from silently reading as "gate absent".
 */
function workflowFileName(reference: string | null | undefined): string {
	if (typeof reference !== 'string') return '';
	const trimmed = reference.trim().toLowerCase();
	if (!trimmed) return '';
	const segments = trimmed.split('/');
	return segments[segments.length - 1] ?? '';
}

/** Pages of check-runs/statuses to read before giving up (rate budget). */
const CHECKS_PER_PAGE = 100;

/**
 * Merge approval (slice AE) — how many pages of check-runs / commit
 * statuses we will read for ONE commit before admitting we cannot see
 * them all.
 *
 * `ciState` is an authorization input now, so "we read the first page and
 * called it green" is not an answer. 5 × 100 covers every realistic PR
 * (this monorepo's own matrix is dozens, not hundreds); past that the
 * read reports `checksComplete: false` and the merge gate refuses rather
 * than rolling up a sample.
 */
const CHECKS_MAX_PAGES = 5;

/** GitHub file payload → the contract's provider-neutral diff row. */
function toDiffFile(file: {
	filename: string;
	status?: string;
	additions?: number;
	deletions?: number;
	patch?: string;
	previous_filename?: string;
}): GitDiffFile {
	return {
		path: file.filename,
		status: file.status ?? 'modified',
		// Renames and copies only — GitHub sends it for nothing else. A
		// reviewer shown only the new path cannot see that the old one is
		// gone (reviewer agent stage, slice AD).
		...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
		additions: file.additions ?? 0,
		deletions: file.deletions ?? 0,
		...(file.patch ? { patch: file.patch } : {})
	};
}

function sanitizeDescription(description?: string): string {
	if (!description) return '';
	return description
		.replace(/[\r\n]+/g, ' ')
		.trim()
		.slice(0, 500);
}

/**
 * The subset of a repository payload the fork path reads. Structural on purpose: the `POST /forks`
 * response is mapped WITHOUT a second `GET /repos/...`, which may legitimately still 404 while the
 * fork bakes.
 */
interface ForkRepositoryPayload {
	readonly owner: { readonly login: string };
	readonly name: string;
	readonly full_name: string;
	readonly description?: string | null;
	readonly default_branch: string;
	readonly private: boolean;
	readonly html_url: string;
	readonly clone_url: string;
	readonly fork?: boolean;
	readonly source?: { readonly full_name?: string } | null;
	readonly parent?: {
		readonly owner?: { readonly login: string } | null;
		readonly name?: string;
		readonly full_name: string;
	} | null;
}

// ── App Works fork lookup (APW-02 T17, plan §4.3) ────────────────────────────
//
// The three-step lookup `findExistingFork` runs: (1) the same-name identity
// check, (2) the fork network over GraphQL, filtered to the target owner, and
// (3) the REST fork listing, bounded at three pages. Steps 2 and 3 are the only
// reason a fork the member RENAMED is found at all (FR-10, S2, ACC-02-03).

/** Forks read per REST page. 100 is GitHub's maximum. */
const FORK_LOOKUP_PAGE_SIZE = 100;

/**
 * Pages of `GET /repos/{o}/{r}/forks` the lookup will read before giving up.
 *
 * §4.3 bounds the fallback here on purpose: the lookup runs before EVERY fork
 * request (T52), and a popular upstream has thousands of forks. Three pages
 * covers the realistic owner, and past them the answer is `null` — the fork
 * request then proceeds to `POST /forks`, which GitHub answers with the
 * existing fork rather than creating a second one.
 */
const FORK_LOOKUP_MAX_PAGES = 3;

/**
 * The GraphQL fork query, exactly the argument set plan §4.3 pins:
 * `forks(first: 100, affiliations: [OWNER, ORGANIZATION_MEMBER])` with
 * `nameWithOwner` + `owner.login` per node.
 *
 * `affiliations` is VIEWER-relative (GitHub: "OWNER will include only
 * repositories that the current viewer owns"), which is exactly what the
 * caller wants — the token belongs to the member whose fork we are looking
 * for — but it also means this step can only ever see forks owned by the
 * token's own user or by an organization that user belongs to. A fork under
 * any other owner is found by step 3, or not at all. Verified against
 * api.github.com on 2026-08-29: `nodejs/node` answered `totalCount: 0` for a
 * viewer with no fork of it, while the viewer's own fork of a repository it
 * does own came back as the single node.
 */
const FORK_SEARCH_QUERY = `query ($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		forks(first: ${FORK_LOOKUP_PAGE_SIZE}, affiliations: [OWNER, ORGANIZATION_MEMBER]) {
			nodes {
				nameWithOwner
				owner {
					login
				}
			}
		}
	}
}`;

/** One fork of the GraphQL connection, as much of it as the query selects. */
interface ForkSearchNode {
	readonly nameWithOwner?: string | null;
	readonly owner?: { readonly login?: string | null } | null;
}

/** The GraphQL answer, shaped by whether the repository and its forks exist. */
interface ForkSearchResponse {
	readonly repository?: {
		readonly forks?: { readonly nodes?: ReadonlyArray<ForkSearchNode | null> | null } | null;
	} | null;
}

/**
 * What a lookup is looking for. `targetName` is the repository NAME the caller
 * asked for — the upstream's own name unless `forkRepository` was given a
 * different one — and it is only used by step 1, the same-name check.
 */
interface ForkLookupTarget {
	readonly upstreamOwner: string;
	readonly upstreamRepo: string;
	readonly targetOwner: string;
	readonly targetName: string;
	readonly token: string;
	readonly baseUrl?: string;
}

/** Case-insensitive owner comparison; GitHub treats repository casing as cosmetic. */
function forkOwnerMatches(candidate: string | null | undefined, targetOwner: string): boolean {
	return typeof candidate === 'string' && candidate.toLowerCase() === targetOwner.toLowerCase();
}

/** `owner/name` → its two halves, or `null` when it is not a usable full name. */
function splitNameWithOwner(fullName: string | null | undefined): { owner: string; name: string } | null {
	if (typeof fullName !== 'string') return null;
	const separator = fullName.indexOf('/');
	if (separator <= 0 || separator === fullName.length - 1) return null;
	return { owner: fullName.slice(0, separator), name: fullName.slice(separator + 1) };
}

/**
 * Is this repository really a fork of `upstreamOwner/upstreamRepo`?
 *
 * Identity is checked, never just the name: a same-named repository that is not
 * a fork, or a fork of some other upstream, is NOT "already forked". `source`
 * is the network root while `parent` is the immediate ancestor, so a fork of a
 * fork (and a renamed upstream) is recognised through `source` first. The
 * comparison is case-insensitive because GitHub treats owner/repository casing
 * as cosmetic. Shared by every step of the lookup so all three agree.
 */
function isForkOfUpstream(
	candidate: {
		readonly isFork: boolean | null | undefined;
		readonly sourceFullName?: string | null;
		readonly parentFullName?: string | null;
	},
	upstreamOwner: string,
	upstreamRepo: string
): boolean {
	if (candidate.isFork !== true) return false;
	const upstream = candidate.sourceFullName ?? candidate.parentFullName ?? '';
	return upstream.toLowerCase() === `${upstreamOwner}/${upstreamRepo}`.toLowerCase();
}

// ── App Works private copy, Actions hygiene and webhooks (APW-02 T19–T21) ────
//
// The three plan §4.3 capabilities that were still missing after T17/T18. They
// share one rule: a refusal THIS side decides — a size ceiling, a webhook URL,
// a listing cap — is reported as the contract's own error type and never as a
// provider error GitHub did not send, and every bound the plan states is
// enforced here rather than documented.

/** Root attributes file whose `filter=lfs` marker refuses a private copy (FR-21). */
const GITATTRIBUTES_PATH = '.gitattributes';

/** The marker a `.gitattributes` must not carry for a private copy to be possible. */
const LFS_FILTER_MARKER = 'filter=lfs';

/** Workflows read per page. 100 is GitHub's maximum. */
const ACTIONS_WORKFLOW_PAGE_SIZE = 100;

/** `maxWorkflows` when the caller names none — plan §3.3's documented default. */
const ACTIONS_MAX_WORKFLOWS = 100;

/** Webhooks read per page. 100 is GitHub's maximum. */
const WEBHOOK_PAGE_SIZE = 100;

/**
 * Pages of `GET /repos/{o}/{r}/hooks` the create-or-update lookup reads.
 *
 * GitHub allows **20** hooks per repository, so one page is already five times
 * the provider's own ceiling: the bound exists so that a provider answering an
 * endless listing cannot make this call run forever, not because a real
 * repository is expected to page.
 */
const WEBHOOK_MAX_PAGES = 3;

/** What a hook's secret is replaced with wherever a diagnostic could carry it. */
const SECRET_PLACEHOLDER = '[redacted]';

/** The marker GitHub uses when the token is an App installation token. */
const APP_TOKEN_PERMISSION_MARKER = 'resource not accessible by integration';

/** The subset of GitHub's workflow payload the hygiene pass reads. */
interface ActionsWorkflowPayload {
	readonly id: number;
	readonly path: string;
	readonly state?: string | null;
}

/** The subset of GitHub's webhook payload the create-or-update lookup reads. */
interface WebhookPayload {
	readonly id?: number;
	readonly config?: { readonly url?: string | null } | null;
}

/**
 * A refusal decided here, not by GitHub, in the contract's one error type.
 *
 * §4.3 words these as "`unprocessable` + `too_large`" and "`uses_lfs`": the
 * reason is `unprocessable` — no provider call failed, the request cannot be
 * carried out — and the plan's own code says WHICH refusal it was. The contract
 * has no field for that code (`GitProviderErrorDetails` is `retryAt` /
 * `permission` only, and `packages/plugin` is not this plugin's to change), so
 * the code travels in `message`, the one channel left, while `reason` and
 * `status` stay exactly what the plan names and every caller that branches on
 * them is unaffected.
 *
 * The consequence is stated rather than hidden: for these refusals — and only
 * these — `message` is NOT the reason. A provider failure still arrives from
 * `toGitProviderError` with `message === reason`.
 */
function refusalError(code: string): GitProviderRequestError {
	const error = new GitProviderRequestError('unprocessable', 422);
	error.message = code;
	return error;
}

/**
 * The provider's own words for a failure, lowercased — the response body's
 * `message` and the error's message, exactly the two strings `github-errors.ts`
 * matches its markers against.
 */
function providerMessageLower(err: unknown): string {
	if (!(err instanceof Error)) return '';
	const data = (err as { response?: { data?: unknown } }).response?.data;
	const body =
		data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
			? (data as { message: string }).message
			: '';
	return `${body} ${err.message}`.trim().toLowerCase();
}

/**
 * Which permission a refused workflow enable/disable names (plan §4.3):
 * `administration` for a GitHub App installation token, `actions` for every
 * other credential.
 *
 * The token KIND is not visible from the request, only from GitHub's refusal —
 * "Resource not accessible by integration" is an App installation token. That
 * distinction is load-bearing for the caller, which has one state for a member
 * who must be sent to grant admin (`needs_admin`, plan §6.7) and another for a
 * missing App permission, so the two are told apart here, once.
 */
function actionsPermissionForRefusal(err: unknown): GitProviderErrorDetails['permission'] {
	return providerMessageLower(err).includes(APP_TOKEN_PERMISSION_MARKER) ? 'administration' : 'actions';
}

/**
 * Classify a failure of an Actions call, with §4.3's one override.
 *
 * `toGitProviderError` classifies every path — rate limits, SSO and OAuth-app
 * restrictions included, none of which this may mask. What it cannot know is
 * §4.3's own row for these endpoints: a 403 on a workflow enable/disable or on
 * the repository switch IS `permission_missing`, even when GitHub's wording
 * matches none of the markers §4.2 keys on (an OAuth token's refusal is plain
 * prose, and the classifier's documented fallback is `unprocessable` — which
 * would hide the one thing the member has to act on).
 */
function actionsFailure(err: unknown, permission: GitProviderErrorDetails['permission']): GitProviderRequestError {
	const mapped = toGitProviderError(err, permission);
	if (mapped.status === 403 && (mapped.reason === 'permission_missing' || mapped.reason === 'unprocessable')) {
		return new GitProviderRequestError('permission_missing', 403, { permission });
	}
	return mapped;
}

/**
 * The workflow-listing cap, as a usable page bound.
 *
 * §3.3 documents 100 as the default and names no maximum; a value that is not a
 * positive whole number (`0`, `-1`, `NaN`, `Infinity`) falls back to the
 * default rather than removing the bound — a cap of zero would silently turn
 * hygiene into a no-op that reports success.
 */
function resolveMaxWorkflows(requested: number | undefined): number {
	return typeof requested === 'number' && Number.isFinite(requested) && requested >= 1
		? Math.floor(requested)
		: ACTIONS_MAX_WORKFLOWS;
}

/**
 * Does this `.gitattributes` send anything to Git LFS?
 *
 * Comment lines are ignored — a commented-out rule sends nothing — and every
 * other line is matched literally for `filter=lfs`, which is how GitHub's own
 * LFS guidance writes it (space or tab). This is a search, not a full
 * `git check-attr` evaluation: the copy is refused when the file COULD send a
 * file to LFS, because isomorphic-git has no LFS filter and would check out
 * pointer files that nothing can hydrate.
 */
function usesLfsFilter(content: string): boolean {
	return content.split('\n').some((line) => !line.trimStart().startsWith('#') && line.includes(LFS_FILTER_MARKER));
}

/**
 * Remove one `cloneBranch` working copy, and never fail the copy over it.
 *
 * `IGitOperations` exposes NO removal for the directory `cloneBranch` returns:
 * the only removal it has, `removeLocalDir(owner, repo, checkoutKey?)`, resolves
 * the per-REPOSITORY checkout — a different directory that another caller may be
 * using at that very moment — so calling it here would delete somebody else's
 * working copy instead of ours. The directory therefore comes off with
 * `node:fs` directly, and a failure to remove it is swallowed:
 * `cloneBranch` names every directory uniquely (a fresh `Date.now()` suffix per
 * call) and clears its own target first, so a directory that survives can never
 * be reused by, or confused with, a later copy. A `removeDir(dir)` member on
 * `IGitOperations` is the additive fix, and it is not this plugin's to add.
 */
async function removeClonedDirectory(dir: string): Promise<void> {
	await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** The `config` object both hook endpoints take — one shape, two call sites. */
function webhookConfig(input: GitWebhookInput): {
	url: string;
	secret: string;
	content_type: 'json';
	insecure_ssl: '0';
} {
	return { url: input.url, secret: input.secret, content_type: 'json', insecure_ssl: '0' };
}

/**
 * What a webhook request must satisfy before GitHub is called at all.
 *
 * Each rule describes a hook nobody can use, so none of them is worth a round
 * trip — and each is enforced rather than assumed of the caller:
 *
 * - the URL must pass the SSRF guard this plugin already applies to its own
 *   `apiBaseUrl`. A hook aimed at loopback, a private range or a cloud-metadata
 *   alias is refused by GitHub's own delivery rules anyway, and storing one
 *   would leave a member believing an integration exists;
 * - the secret must be non-empty: FR-55 installs a SIGNED webhook, and an empty
 *   secret configures deliveries the receiver cannot verify;
 * - at least one event must be named: GitHub's default for an omitted `events`
 *   is `push`, so an empty list is a hook that fires on nothing — a silent
 *   no-op created by an explicit instruction.
 */
function webhookRefusal(input: GitWebhookInput): GitProviderRequestError | null {
	if (!isSafeWebhookUrl(input.url)) return refusalError('webhook_url_refused');
	if (input.secret.trim() === '') return refusalError('webhook_secret_required');
	if (input.events.length === 0) return refusalError('webhook_events_required');
	return null;
}

/**
 * Classify a webhook failure, and keep the signing secret out of it.
 *
 * `toGitProviderError` is the classifier (§4.2), but on this path it is also a
 * carrier: Octokit's `RequestError` keeps the exact request it made — its
 * `request.body` holds the JSON just sent, secret included — and the classifier
 * attaches that whole error as `cause`. So the message is scrubbed AND the
 * cause is replaced with a message-only error: a caller logging a webhook
 * failure (which it will — FR-58 forbids the secret in telemetry) must not be
 * able to leak the secret by accident.
 */
function webhookFailure(err: unknown, secret: string | undefined): GitProviderRequestError {
	const mapped = toGitProviderError(err, 'webhooks');
	const scrub = (text: string): string => (secret ? text.split(secret).join(SECRET_PLACEHOLDER) : text);

	const safe = new GitProviderRequestError(mapped.reason, mapped.status, mapped.details);
	safe.message = scrub(mapped.message);
	if (err instanceof Error) Object.assign(safe, { cause: new Error(scrub(err.message)) });
	return safe;
}

export class GitHubApiService {
	/**
	 * Verified-org membership check for PR authors. C-11 in the
	 * 2026-05-17 security audit — the community-PR pipeline uses
	 * `GitPullRequest.author.orgVerified` to decide whether to
	 * auto-apply a PR. Default constructed here so existing callers
	 * (`new GitHubApiService()`) keep working; tests may inject a
	 * custom instance.
	 */
	constructor(private readonly verifiedOrgService: GitHubVerifiedOrgService = new GitHubVerifiedOrgService()) {}

	private createOctokit(token: string, baseUrl?: string): Octokit {
		return new Octokit({
			...(token ? { auth: token } : {}),
			baseUrl: baseUrl || 'https://api.github.com'
		});
	}

	/**
	 * Build the `author` field for a `GitPullRequest` by inspecting
	 * the GitHub API `user` payload + (when configured) calling out
	 * to `GET /orgs/{org}/members/{username}` for each org in
	 * `COMMUNITY_PR_VERIFIED_ORGS`. Returns `undefined` when the
	 * upstream `user` is null (rare — ghost users).
	 *
	 * @param user GitHub user payload (`pr.user` from Octokit).
	 * @param token The same token used to fetch the PR — reused for
	 *   the membership lookup so the operator doesn't need a second
	 *   credential.
	 * @param baseUrl GitHub Enterprise base URL, if any.
	 */
	private async buildPrAuthor(
		user: { login?: string | null; type?: string | null } | null | undefined,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequestAuthor | undefined> {
		if (!user?.login) return undefined;

		const verifiedOrgs = parseVerifiedOrgs(process.env.COMMUNITY_PR_VERIFIED_ORGS);
		let orgVerified: boolean | undefined;
		if (verifiedOrgs.length > 0) {
			try {
				orgVerified = await this.verifiedOrgService.isVerifiedMember({
					username: user.login,
					token,
					baseUrl,
					verifiedOrgs
				});
			} catch {
				// Defensive: any unexpected exception means "couldn't verify".
				orgVerified = false;
			}
		}

		const author: GitPullRequestAuthor = {
			username: user.login,
			...(user.type ? { type: user.type } : {}),
			...(orgVerified === undefined ? {} : { orgVerified })
		};
		return author;
	}

	async getUser(token: string, baseUrl?: string): Promise<GitUser> {
		const octokit = this.createOctokit(token, baseUrl);
		const { data } = await octokit.rest.users.getAuthenticated();

		return {
			id: String(data.id),
			login: data.login,
			name: data.name ?? undefined,
			email: data.email ?? undefined,
			avatarUrl: data.avatar_url
		};
	}

	async getOrganizations(token: string, baseUrl?: string): Promise<GitOrganization[]> {
		const octokit = this.createOctokit(token, baseUrl);
		const { data } = await octokit.rest.orgs.listForAuthenticatedUser();

		return data.map((org) => ({
			id: String(org.id),
			login: org.login,
			name: org.description ?? undefined,
			avatarUrl: org.avatar_url
		}));
	}

	async getRepository(
		owner: string,
		repo: string,
		token: string,
		baseUrl?: string
	): Promise<GitRepositoryWithPermissions | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.get({ owner, repo });

			// ── Repository facts (APW-02 T16, plan §4.3) ────────────────────────
			// Every member below is OPTIONAL on `GitRepository`, and a payload that
			// does not carry one leaves the field ABSENT — never `false` / `0` /
			// "none". "The provider did not report it" and "the provider reported
			// no" are different facts, and only the second may be acted on.
			//
			// `empty` is the one fact GitHub does not report at all: `size` is 0
			// both for a repository that was created and never pushed to and for
			// one that is transiently reporting 0 while a fork bakes. `size === 0`
			// is therefore the ONLY trigger for the probe, and an absent (unknown)
			// size is left unreported rather than guessed at.
			const emptyDefaultBranch = async (): Promise<boolean | undefined> => {
				try {
					await octokit.rest.repos.getBranch({
						owner: data.owner.login,
						repo: data.name,
						branch: data.default_branch
					});
					// The default branch answers, so there is at least one commit.
					return false;
				} catch (err) {
					// A 404 on the default branch is GitHub's own "there is no commit
					// here", and that IS the fact. Anything else (403, 5xx, a
					// transport failure) means we could not find out: `empty` stays
					// unreported instead of asserting a state nobody reported.
					return err instanceof RequestError && err.status === 404 ? true : undefined;
				}
			};

			const empty = data.size === 0 ? await emptyDefaultBranch() : undefined;
			const requested = `${owner}/${repo}`;
			// §4.3 maps `license?.spdx_id`. `NOASSERTION` is GitHub saying "this is
			// a licence file I cannot name": reported, and not nameable, which the
			// contract spells `null` — NOT the `undefined` of "not reported". A
			// repository with no licence file at all reports `license: null`, and
			// §4.3's `?.` leaves it unreported rather than claiming `null`.
			const spdxId = data.license ? data.license.spdx_id : undefined;
			const named = typeof spdxId === 'string' && spdxId.trim() !== '' && spdxId.toUpperCase() !== 'NOASSERTION';
			const licenseSpdx = data.license ? (named ? spdxId : null) : undefined;
			// GitHub Enterprise's third value; anything unrecognised is left
			// unreported rather than cast into the contract's union.
			const visibility =
				data.visibility === 'public' || data.visibility === 'private' || data.visibility === 'internal'
					? data.visibility
					: undefined;
			// APW-03 T22 — the Blueprint probe reads `ever-works-app-blueprint` off
			// these; see `reportedTopics` for the absent-vs-empty rule.
			const topics = reportedTopics(data.topics);

			return {
				owner: data.owner.login,
				name: data.name,
				fullName: data.full_name,
				description: data.description ?? undefined,
				defaultBranch: data.default_branch,
				isPrivate: data.private,
				url: data.html_url,
				cloneUrl: data.clone_url,
				isFork: data.fork,
				parent: data.parent
					? {
							owner: data.parent.owner.login,
							name: data.parent.name,
							fullName: data.parent.full_name
						}
					: undefined,
				permissions: data.permissions
					? {
							admin: data.permissions.admin ?? false,
							push: data.permissions.push ?? false,
							pull: data.permissions.pull ?? false
						}
					: undefined,
				// The network root a fork came from — read before `parent`, which is
				// only the immediate ancestor (a fork of a fork shares `source`).
				...(data.source
					? {
							source: {
								owner: data.source.owner.login,
								name: data.source.name,
								fullName: data.source.full_name
							}
						}
					: {}),
				...(typeof data.allow_forking === 'boolean' ? { allowForking: data.allow_forking } : {}),
				...(typeof data.archived === 'boolean' ? { archived: data.archived } : {}),
				...(visibility ? { visibility } : {}),
				...(typeof data.stargazers_count === 'number' ? { stars: data.stargazers_count } : {}),
				...(typeof data.size === 'number' ? { sizeKb: data.size } : {}),
				...(licenseSpdx === undefined ? {} : { licenseSpdx }),
				...(empty === undefined ? {} : { empty }),
				...(topics === undefined ? {} : { topics }),
				// Octokit follows GitHub's 301 for a renamed repository, so the
				// payload's `full_name` is the RESOLVED name and the requested
				// coordinates are the only trace of the redirect. Case-insensitive
				// because GitHub treats owner/repository casing as cosmetic — a
				// difference in case alone is not a move.
				...(requested.toLowerCase() === data.full_name.toLowerCase() ? {} : { movedFrom: requested })
			};
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			// `repos.get` needs the Metadata permission (mandatory for a GitHub App
			// installation), so that is the permission a refusal names. Every other
			// reason comes straight from plan §4.2's table.
			throw toGitProviderError(err, 'metadata');
		}
	}

	async listRepositories(
		token: string,
		page: number = 1,
		perPage: number = 30,
		baseUrl?: string,
		options?: ListRepositoriesOptions
	): Promise<GitRepositoryWithPermissions[]> {
		const octokit = this.createOctokit(token, baseUrl);

		let data;
		if (options?.type === 'org' && options?.owner) {
			try {
				const response = await octokit.rest.repos.listForOrg({
					org: options.owner,
					page,
					per_page: perPage,
					sort: 'updated'
				});
				data = response.data;
			} catch (err) {
				if (err instanceof RequestError && (err.status === 404 || err.status === 403)) {
					return [];
				}
				throw err;
			}
		} else if (options?.type === 'user') {
			const response = await octokit.rest.repos.listForAuthenticatedUser({
				affiliation: 'owner',
				page,
				per_page: perPage,
				sort: 'updated'
			});
			data = response.data;
		} else {
			const response = await octokit.rest.repos.listForAuthenticatedUser({
				page,
				per_page: perPage,
				sort: 'updated'
			});
			data = response.data;
		}

		// APW-13 T5 (additive): the non-production acceptance switch. The mapping
		// below builds exactly one clone URL itself — the `full_name` fallback — so
		// that is the one place a fake lane has to redirect; a payload that reports
		// its own `clone_url` keeps GitHub's value, unchanged. The condition mirrors
		// `??` exactly (null or undefined, never an empty string), so the fallback
		// fires on the same payloads it fires on today. The rewrite is a copy, never
		// in place: the response object belongs to the provider and to every other
		// reader of it, and a fake URL must not leak into either.
		const e2eFakeOrigin = resolveGitHubE2eFakeOrigin();
		if (e2eFakeOrigin) {
			data = data.map((repo) =>
				repo.clone_url === undefined || repo.clone_url === null
					? { ...repo, clone_url: `${e2eFakeOrigin}/${repo.full_name}.git` }
					: repo
			);
		}

		return data.map((repo) => {
			// GitHub's list endpoints return `topics` on every repository, so a
			// listing reports them exactly as `getRepository` does. Website-template
			// discovery lists the catalog org and needs them to keep App Blueprints
			// (topic `ever-works-app-blueprint`) out of the website picker. Absent
			// key ⇒ the field stays absent (additive: the object is unchanged).
			const topics = reportedTopics(repo.topics);
			return {
				owner: repo.owner.login,
				name: repo.name,
				fullName: repo.full_name,
				description: repo.description ?? undefined,
				defaultBranch: repo.default_branch ?? 'main',
				isPrivate: repo.private,
				url: repo.html_url,
				cloneUrl: repo.clone_url ?? `https://github.com/${repo.full_name}.git`,
				isFork: repo.fork,
				permissions: repo.permissions
					? {
							admin: repo.permissions.admin ?? false,
							push: repo.permissions.push ?? false,
							pull: repo.permissions.pull ?? false
						}
					: undefined,
				...(topics === undefined ? {} : { topics })
			};
		});
	}

	async createRepository(options: CreateRepoOptions, token: string, baseUrl?: string): Promise<GitRepository> {
		const octokit = this.createOctokit(token, baseUrl);
		const sanitizedDesc = sanitizeDescription(options.description);

		let data;
		if (options.organization) {
			const existing = await this.getRepository(options.organization, options.name, token, baseUrl);
			if (existing) return existing;

			const res = await octokit.rest.repos.createInOrg({
				org: options.organization,
				name: options.name,
				description: sanitizedDesc,
				private: options.isPrivate ?? true
			});
			data = res.data;
		} else {
			const { data: user } = await octokit.rest.users.getAuthenticated();
			const existing = await this.getRepository(user.login, options.name, token, baseUrl);
			if (existing) return existing;

			const res = await octokit.rest.repos.createForAuthenticatedUser({
				name: options.name,
				description: sanitizedDesc,
				private: options.isPrivate ?? true
			});
			data = res.data;
		}

		return {
			owner: data.owner.login,
			name: data.name,
			fullName: data.full_name,
			description: data.description ?? undefined,
			defaultBranch: data.default_branch,
			isPrivate: data.private,
			url: data.html_url,
			cloneUrl: data.clone_url
		};
	}

	async deleteRepository(owner: string, repo: string, token: string, baseUrl?: string): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);
		await octokit.rest.repos.delete({ owner, repo });
	}

	async transferRepository(
		owner: string,
		repo: string,
		options: TransferRepoOptions,
		token: string,
		baseUrl?: string
	): Promise<TransferRepoResult> {
		const octokit = this.createOctokit(token, baseUrl);
		// GitHub's transfer API returns 202 with the source repo payload;
		// the new owner must accept the transfer on github.com before it
		// completes. The returned repo data describes the OLD location and
		// isn't useful to consumers — omit `newRepository` and let callers
		// re-resolve once the transfer settles.
		await octokit.rest.repos.transfer({
			owner,
			repo,
			new_owner: options.newOwner,
			...(options.teamIds && options.teamIds.length > 0 ? { team_ids: [...options.teamIds] } : {})
		});

		return {
			status: 'pending_recipient_acceptance',
			providerAcceptanceUrl: `https://github.com/${options.newOwner}`
		};
	}

	async updateRepository(
		owner: string,
		repo: string,
		data: UpdateRepoOptions,
		token: string,
		baseUrl?: string
	): Promise<GitRepository> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data: updated } = await octokit.rest.repos.update({
			owner,
			repo,
			private: data.isPrivate,
			description: data.description ? sanitizeDescription(data.description) : undefined,
			default_branch: data.defaultBranch
		});

		return {
			owner: updated.owner.login,
			name: updated.name,
			fullName: updated.full_name,
			description: updated.description ?? undefined,
			defaultBranch: updated.default_branch,
			isPrivate: updated.private,
			url: updated.html_url,
			cloneUrl: updated.clone_url
		};
	}

	async forkRepository(
		owner: string,
		repo: string,
		options: ForkRepositoryOptions,
		token: string,
		baseUrl?: string
	): Promise<GitRepository | null> {
		const octokit = this.createOctokit(token, baseUrl);

		// Where the fork lands — needed to look for an existing one before asking for another.
		const targetOwner = options.organization || (await this.getUser(token, baseUrl)).login;
		const targetName = options.name ?? repo;

		// Already forked is SUCCESS. GitHub answers a repeat fork request with the existing fork,
		// but resolving it here means the platform does not depend on that (nor spend a request
		// it may not get), and it can hand back a usable copy immediately.
		const existing = await this.findExistingForkFor(octokit, {
			upstreamOwner: owner,
			upstreamRepo: repo,
			targetOwner,
			targetName,
			token,
			baseUrl
		});
		if (existing) {
			// Whichever step found it, the copy exists and is usable now — the caller
			// must not be made to wait for a fork that was never requested.
			return { ...existing, forkReadiness: 'ready' };
		}

		const { data } = await octokit.rest.repos.createFork({
			owner,
			repo,
			name: options.name,
			organization: options.organization,
			default_branch_only: options.defaultBranchOnly
		});

		const newOwner = data.owner.login;
		const newName = data.name;

		// `waitForReady: false` — the caller wants the request back NOW. Fork readiness takes
		// seconds to minutes, so answer with the provider's own response and let a readiness
		// poller own the wait instead of holding an HTTP request open. The coordinates are
		// already usable for bookkeeping; the repository itself is not readable yet.
		if (options.waitForReady === false) {
			return this.toForkRepository(data as unknown as ForkRepositoryPayload, 'pending');
		}

		const REPO_CHECK_INTERVAL_MS = 5000;
		const MAX_REPO_CHECK_ATTEMPTS = 24;

		for (let attempt = 1; attempt <= MAX_REPO_CHECK_ATTEMPTS; attempt++) {
			try {
				await octokit.rest.repos.get({ owner: newOwner, repo: newName });
				const ready = await this.getRepository(newOwner, newName, token, baseUrl);
				return ready ? { ...ready, forkReadiness: 'ready' } : ready;
			} catch (err) {
				if (err instanceof RequestError && err.status === 404) {
					if (attempt < MAX_REPO_CHECK_ATTEMPTS) {
						await new Promise((resolve) => setTimeout(resolve, REPO_CHECK_INTERVAL_MS));
					}
				} else {
					throw err;
				}
			}
		}

		return null;
	}

	/**
	 * The fork of `upstreamOwner/upstreamRepo` that already exists under
	 * `targetOwner`, or `null` when there is none (plan §4.3, FR-10).
	 *
	 * A capability, not a helper of the create path: APW-01's inspect calls it
	 * per candidate owner, and `forkRepository` calls it before every create
	 * request (T52). A renamed fork is the case it exists for — a same-name check
	 * alone cannot see one — so the lookup runs all three steps:
	 *
	 * 1. `GET /repos/{targetOwner}/{upstreamRepo}` plus the identity check;
	 * 2. the fork network over GraphQL, filtered to `targetOwner`;
	 * 3. `GET /repos/{upstream}/forks`, at most {@link FORK_LOOKUP_MAX_PAGES} pages.
	 *
	 * Steps 2 and 3 never throw: a provider that cannot search leaves the answer
	 * `null` — "we could not search" is not "there is no fork" — and the caller
	 * proceeds to the provider's fork endpoint, which answers with the existing
	 * fork instead of creating a second one. Only step 1 propagates a failure,
	 * because it is a plain repository read that failed, and it does so as the
	 * contract's typed error.
	 *
	 * OPTIONAL on `IGitProviderPlugin`, so the four-argument shape is the
	 * contract's; `baseUrl` is this implementation's GitHub Enterprise endpoint
	 * and is additive.
	 */
	async findExistingFork(
		upstreamOwner: string,
		upstreamRepo: string,
		targetOwner: string,
		token: string,
		baseUrl?: string
	): Promise<GitRepository | null> {
		const octokit = this.createOctokit(token, baseUrl);
		return this.findExistingForkFor(octokit, {
			upstreamOwner,
			upstreamRepo,
			targetOwner,
			// Without a fork name the copy lands under the upstream's own name, which is
			// what step 1 checks. `forkRepository` passes the caller's name instead.
			targetName: upstreamRepo,
			token,
			baseUrl
		});
	}

	/**
	 * The three steps of §4.3, in order, against an Octokit the caller already
	 * holds (so `forkRepository` does not authenticate twice).
	 */
	private async findExistingForkFor(octokit: Octokit, target: ForkLookupTarget): Promise<GitRepository | null> {
		// 1. Same-name identity check — the pre-APW-02 lookup, unchanged.
		const sameName = await this.readSameNamedFork(octokit, target);
		if (sameName) return sameName;

		// 2. The fork network, asked for the target owner's forks.
		const viaForkNetwork = await this.findForkViaGraphql(octokit, target);
		if (viaForkNetwork) return viaForkNetwork;

		// 3. The REST fork listing, bounded.
		return this.findForkViaRestForks(octokit, target);
	}

	/**
	 * Step 1 — the same-name identity check.
	 *
	 * Identity is checked, never just the name: a same-named repository that is not a fork, or a
	 * fork of some other upstream, is NOT "already forked" and must still be forked. `source` is
	 * the immediate upstream while `parent` is the root of the fork network, so a fork of a fork
	 * (and a renamed upstream) is recognised through `source` first. The comparison is
	 * case-insensitive because GitHub treats owner/repository casing as cosmetic.
	 */
	private async readSameNamedFork(octokit: Octokit, target: ForkLookupTarget): Promise<GitRepository | null> {
		let data: ForkRepositoryPayload;

		try {
			const response = await octokit.rest.repos.get({ owner: target.targetOwner, repo: target.targetName });
			data = response.data as unknown as ForkRepositoryPayload;
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			// A repository read that failed for any other reason. Typed, like every
			// other repository read in this service (plan §4.2), with the permission
			// `repos.get` needs.
			throw toGitProviderError(err, 'metadata');
		}

		if (
			!isForkOfUpstream(
				{
					isFork: data.fork,
					sourceFullName: data.source?.full_name,
					parentFullName: data.parent?.full_name
				},
				target.upstreamOwner,
				target.upstreamRepo
			)
		) {
			return null;
		}

		return this.toForkRepository(data, 'ready');
	}

	/**
	 * Step 2 — the fork network over GraphQL, filtered to `targetOwner`.
	 *
	 * This is the step that finds a fork the member RENAMED: its name is nothing
	 * like the upstream's, so step 1's `GET /repos/{target}/{upstreamName}` 404s,
	 * but the fork is still owned by the target and still in the upstream's fork
	 * network.
	 *
	 * A GraphQL failure is not an error the caller must see — §4.3 answers it by
	 * falling through to step 3 — so the catch below degrades to `null` and lets
	 * the REST listing try. That covers a server without GraphQL, a schema or
	 * argument-set change, a scope the token lacks, and a transport failure.
	 */
	private async findForkViaGraphql(octokit: Octokit, target: ForkLookupTarget): Promise<GitRepository | null> {
		let nodes: ReadonlyArray<ForkSearchNode | null>;

		try {
			const data = await octokit.graphql<ForkSearchResponse>(FORK_SEARCH_QUERY, {
				owner: target.upstreamOwner,
				name: target.upstreamRepo
			});
			nodes = data?.repository?.forks?.nodes ?? [];
		} catch {
			// Deliberately swallowed: see this method's doc comment. The classified
			// error would name a failure the lookup is designed to survive.
			return null;
		}

		const match = nodes.find((node) => forkOwnerMatches(node?.owner?.login, target.targetOwner));
		if (!match) return null;

		const coordinates = splitNameWithOwner(match.nameWithOwner);
		if (!coordinates) return null;

		// The match is read back through the REST repository read §4.3 names, so the
		// caller gets the same repository object (and the same facts) every step
		// returns — and so the fork identity is confirmed by the provider rather
		// than taken on trust from a search hit.
		return this.readForkForLookup(coordinates.owner, coordinates.name, target);
	}

	/**
	 * Step 3 — `GET /repos/{upstream}/forks`, newest first, at most
	 * {@link FORK_LOOKUP_MAX_PAGES} pages.
	 *
	 * The fallback for a provider that could not answer step 2 (and the only step
	 * that can see a fork owned by somebody the token's user does not own or
	 * belong to). Paging stops at the first page that is not full, and every
	 * failure — including a rate limit — answers `null` rather than throwing, so
	 * the fork request can still proceed (§4.3).
	 */
	private async findForkViaRestForks(octokit: Octokit, target: ForkLookupTarget): Promise<GitRepository | null> {
		for (let page = 1; page <= FORK_LOOKUP_MAX_PAGES; page++) {
			let forks: ReadonlyArray<{ owner?: { login?: string | null } | null; name?: string | null } | null>;

			try {
				const { data } = await octokit.rest.repos.listForks({
					owner: target.upstreamOwner,
					repo: target.upstreamRepo,
					sort: 'newest',
					per_page: FORK_LOOKUP_PAGE_SIZE,
					page
				});
				forks = Array.isArray(data) ? data : [];
			} catch {
				// Same degradation as step 2: a search that could not run is not an
				// answer about the fork's existence.
				return null;
			}

			const match = forks.find((fork) => forkOwnerMatches(fork?.owner?.login, target.targetOwner));
			if (match?.name) {
				const repository = await this.readForkForLookup(
					match.owner?.login ?? target.targetOwner,
					match.name,
					target
				);
				if (repository) return repository;
			}

			// A short page is the last page — no fourth request, and no request at
			// all once the fork listing is exhausted.
			if (forks.length < FORK_LOOKUP_PAGE_SIZE) return null;
		}

		return null;
	}

	/**
	 * Read a fork the search found, and hand it back only if the provider still
	 * says it is a fork of this upstream. A repository that vanished (or was
	 * renamed again) between the search and the read reads as "not found", never
	 * as an error: the caller's next move is the same either way.
	 */
	private async readForkForLookup(
		owner: string,
		name: string,
		target: ForkLookupTarget
	): Promise<GitRepository | null> {
		let repository: GitRepositoryWithPermissions | null;

		try {
			repository = await this.getRepository(owner, name, target.token, target.baseUrl);
		} catch {
			// Includes a rate limit and a permission refusal: the lookup answers
			// `null` and the fork request proceeds (§4.3), which is strictly better
			// than failing a request GitHub would have answered with the fork.
			return null;
		}

		if (!repository) return null;

		return isForkOfUpstream(
			{
				isFork: repository.isFork,
				sourceFullName: repository.source?.fullName,
				parentFullName: repository.parent?.fullName
			},
			target.upstreamOwner,
			target.upstreamRepo
		)
			? repository
			: null;
	}

	/**
	 * Map a repository payload the fork path already holds, without a second API call. Deliberately
	 * separate from `getRepository`, which re-reads the repository and can 404 while a fork is
	 * still being created.
	 */
	private toForkRepository(data: ForkRepositoryPayload, forkReadiness: 'ready' | 'pending'): GitRepository {
		const parentFullName = data.parent?.full_name ?? '';
		const [parentOwnerFromName, parentNameFromName] = parentFullName.split('/');

		return {
			owner: data.owner.login,
			name: data.name,
			fullName: data.full_name,
			description: data.description ?? undefined,
			defaultBranch: data.default_branch,
			isPrivate: data.private,
			url: data.html_url,
			cloneUrl: data.clone_url,
			isFork: data.fork ?? true,
			parent: parentFullName
				? {
						owner: data.parent?.owner?.login ?? parentOwnerFromName ?? '',
						name: data.parent?.name ?? parentNameFromName ?? '',
						fullName: parentFullName
					}
				: undefined,
			forkReadiness
		};
	}

	/**
	 * Bring `forkOwner/forkRepo`'s `branch` up to date with the upstream branch it
	 * was forked from (`POST /repos/{fork}/merge-upstream`, plan §4.3).
	 *
	 * `conflict` and `unprocessable` are ANSWERS, not throws: 409 is GitHub saying
	 * "this needs a pull request", and 422 is "this branch cannot be synced" (a
	 * branch the upstream renamed away, for instance). The caller renders both
	 * rather than retrying, which is why they are part of the result type. Every
	 * other failure — including a permission refusal, which the merge needs
	 * `contents: write` for — leaves as the contract's typed error.
	 *
	 * `merged` is GitHub telling us it had to create a merge commit. APW-02 calls
	 * this only on a behind-only fork, so a `merged` is a race, recorded as
	 * fast-forward-equivalent with a warning (plan §4.3); nothing here merges
	 * anything the caller did not ask for.
	 */
	async syncForkBranch(
		forkOwner: string,
		forkRepo: string,
		branch: string,
		token: string,
		baseUrl?: string
	): Promise<GitForkSyncResult> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.mergeUpstream({
				owner: forkOwner,
				repo: forkRepo,
				branch
			});

			// GitHub types `merge_type` as OPTIONAL. A 200 without one says the branch
			// was synced but not how, and reading that as `up_to_date` would report
			// "nothing changed" about a branch that may have just moved — so an
			// unrecognised or absent `merge_type` reports `merged`, the outcome that
			// never under-reports a change.
			const outcome: GitForkSyncResult['outcome'] =
				data.merge_type === 'fast-forward'
					? 'fast_forwarded'
					: data.merge_type === 'none'
						? 'up_to_date'
						: 'merged';

			return {
				outcome,
				// Only when the provider actually named one: `baseBranch` absent is
				// "not reported", never an invented branch name.
				...(typeof data.base_branch === 'string' && data.base_branch !== ''
					? { baseBranch: data.base_branch }
					: {})
			};
		} catch (err) {
			if (err instanceof RequestError && err.status === 409) {
				return { outcome: 'conflict' };
			}
			if (err instanceof RequestError && err.status === 422) {
				return { outcome: 'unprocessable' };
			}
			// The merge writes to the fork's branch, so `contents: write` is the
			// permission a refusal names (plan §4.5).
			throw toGitProviderError(err, 'contents');
		}
	}

	/**
	 * How far `forkOwner/forkRepo`'s `forkBranch` has drifted from
	 * `upstreamOwner/upstreamBranch` (`GET /repos/{fork}/compare/{basehead}`,
	 * plan §4.3).
	 *
	 * The `basehead` names the upstream ref with its OWNER — the upstream lives in
	 * a different repository, so a bare `branch...branch` would compare the fork
	 * with itself. `ahead_by` / `behind_by` come straight from the comparison.
	 *
	 * `base_commit.sha` is the head of the BASE ref as the fork network resolves
	 * it, which is the upstream head the contract means by `upstreamHeadSha`
	 * (verified against api.github.com: comparing `main...v20.x` in `nodejs/node`
	 * reported `main`'s tip as `base_commit`, with `merge_base_commit` a different,
	 * older commit).
	 *
	 * `forkHeadSha` is the one value §4.3's single-call mapping cannot deliver: the
	 * comparison returns its commits in CHRONOLOGICAL order, so with `per_page: 1`
	 * the only commit in the list is the OLDEST of the range, and without a page
	 * limit the list is capped at 250 commits and is not the head either on a large
	 * comparison. The fork head is therefore read from the fork's own branch ref,
	 * which is the head by definition.
	 */
	async getForkDivergence(
		forkOwner: string,
		forkRepo: string,
		forkBranch: string,
		upstreamOwner: string,
		upstreamBranch: string,
		token: string,
		baseUrl?: string
	): Promise<GitForkDivergence> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
				owner: forkOwner,
				repo: forkRepo,
				basehead: `${upstreamOwner}:${upstreamBranch}...${forkBranch}`,
				// The counts and the base commit are the whole answer; the commit list
				// and the file list are not read.
				per_page: 1
			});

			const { data: head } = await octokit.rest.repos.getBranch({
				owner: forkOwner,
				repo: forkRepo,
				branch: forkBranch
			});

			return {
				aheadBy: comparison.ahead_by,
				behindBy: comparison.behind_by,
				upstreamHeadSha: comparison.base_commit.sha,
				forkHeadSha: head.commit.sha
			};
		} catch (err) {
			// A missing branch on either side is GitHub's 404 → `not_found`; a refusal
			// to read the contents names `contents` (plan §4.2, §4.5).
			throw toGitProviderError(err, 'contents');
		}
	}

	async createRepositoryFromTemplate(
		templateOwner: string,
		templateRepo: string,
		options: CreateRepoOptions,
		token: string,
		baseUrl?: string
	): Promise<GitRepository | null> {
		const octokit = this.createOctokit(token, baseUrl);
		const targetOwner = options.organization || (await this.getUser(token, baseUrl)).login;

		const existing = await this.getRepository(targetOwner, options.name, token, baseUrl);
		if (existing) return existing;

		await octokit.rest.repos.createUsingTemplate({
			template_owner: templateOwner,
			template_repo: templateRepo,
			owner: targetOwner,
			name: options.name,
			description: sanitizeDescription(options.description),
			private: options.isPrivate ?? true,
			include_all_branches: true
		});

		return this.getRepository(targetOwner, options.name, token, baseUrl);
	}

	async listBranches(owner: string, repo: string, token: string, baseUrl?: string): Promise<GitBranch[]> {
		const octokit = this.createOctokit(token, baseUrl);
		const branches: GitBranch[] = [];

		const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
		const defaultBranch = repoData.default_branch;

		for await (const response of octokit.paginate.iterator(octokit.rest.repos.listBranches, {
			owner,
			repo,
			per_page: 100
		})) {
			for (const branch of response.data) {
				branches.push({
					name: branch.name,
					commit: branch.commit.sha,
					isDefault: branch.name === defaultBranch,
					isProtected: branch.protected
				});
			}
		}

		return branches;
	}

	async createBranch(
		owner: string,
		repo: string,
		name: string,
		fromRef: string,
		token: string,
		baseUrl?: string
	): Promise<GitBranch> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data: ref } = await octokit.rest.git.getRef({
			owner,
			repo,
			ref: `heads/${fromRef}`
		});

		await octokit.rest.git.createRef({
			owner,
			repo,
			ref: `refs/heads/${name}`,
			sha: ref.object.sha
		});

		return {
			name,
			commit: ref.object.sha,
			isDefault: false,
			isProtected: false
		};
	}

	async deleteBranch(owner: string, repo: string, name: string, token: string, baseUrl?: string): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);
		await octokit.rest.git.deleteRef({
			owner,
			repo,
			ref: `heads/${name}`
		});
	}

	/**
	 * Create a branch ref pointing at an exact commit sha (APW-09's signature,
	 * landed here because APW-02 P1 needs it first — plan §3.3).
	 *
	 * Distinct from `createBranch`, whose `fromRef` is a branch NAME: pointing the
	 * upstream-sync branch at the upstream head needs a sha, and deleting and
	 * recreating the branch instead would close the pull request open on it.
	 *
	 * A 409 ("already exists") and a 422 ("Reference already exists" / a bad sha)
	 * are classified per plan §4.2 as `conflict` / `unprocessable` — the caller
	 * reads the existing branch rather than racing this call.
	 */
	async createBranchFromSha(
		owner: string,
		repo: string,
		name: string,
		sha: string,
		token: string,
		baseUrl?: string
	): Promise<GitBranch> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.git.createRef({
				owner,
				repo,
				ref: `refs/heads/${name}`,
				sha
			});

			return {
				name,
				commit: data.object.sha,
				isDefault: false,
				isProtected: false
			};
		} catch (err) {
			throw toGitProviderError(err, 'contents');
		}
	}

	/**
	 * Move an existing branch ref to a commit sha — **fast-forward only**.
	 *
	 * The request ALWAYS carries `force: false`. There is no force-move in this
	 * epic (ACC-02-10): a rewritten upstream history must never be pushed over the
	 * member's branch, so the caller's `{ force: false }` option is not forwarded —
	 * it exists to keep APW-09's signature (which types it `false`, making `true` a
	 * compile error rather than a silent rewrite). A 422 "not a fast forward" is
	 * therefore classified as `unprocessable` and is not retried.
	 */
	async updateBranchRef(
		owner: string,
		repo: string,
		name: string,
		sha: string,
		options: { force: false },
		token: string,
		baseUrl?: string
	): Promise<GitBranch> {
		const octokit = this.createOctokit(token, baseUrl);

		// `options` is deliberately unread: the only value its type allows is `false`,
		// and the request below hard-codes that, so nothing a caller passes can turn
		// this into a history rewrite.
		void options;

		try {
			const { data } = await octokit.rest.git.updateRef({
				owner,
				repo,
				ref: `heads/${name}`,
				sha,
				force: false
			});

			return {
				name,
				commit: data.object.sha,
				isDefault: false,
				isProtected: false
			};
		} catch (err) {
			throw toGitProviderError(err, 'contents');
		}
	}

	async getLatestCommit(
		owner: string,
		repo: string,
		branch: string,
		token: string,
		baseUrl?: string
	): Promise<GitCommit | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });

			return {
				sha: data.commit.sha,
				message: data.commit.commit.message,
				author: {
					name: data.commit.commit.author?.name,
					email: data.commit.commit.author?.email
				},
				date: data.commit.commit.committer?.date || new Date().toISOString()
			};
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	/**
	 * Open a pull request (APW-09 T1 — cross-repository head).
	 *
	 * Three additive options ride this call and NOTHING else changes about it:
	 *
	 * - `headOwner` composes `head` as `"{headOwner}:{head}"`, which is how
	 *   GitHub names a branch of another repository — without it `head` can only
	 *   ever mean a branch of the base repository, so an upstream pull request
	 *   from the member's fork is unexpressible.
	 * - `maintainerCanModify` is sent as `maintainer_can_modify` only when the
	 *   caller defined it: `false` is a choice the member made, and defaulting it
	 *   would rewrite that choice into "not specified".
	 * - `headRepo` is sent as `head_repo` **only when the head owner equals the
	 *   base owner** (plan §4, G23). GitHub needs the head repository named when
	 *   base and head share an owner (the same-fork-network case); in the
	 *   ordinary cross-owner case it resolves the head repository from `head`
	 *   and an extra `head_repo` is not sent.
	 *
	 * A call that passes none of them sends byte-for-byte the request this method
	 * sent before these options existed.
	 */
	async createPullRequest(options: CreatePROptions, token: string, baseUrl?: string): Promise<GitPullRequest> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.create({
			owner: options.owner,
			repo: options.repo,
			title: options.title,
			head: options.headOwner ? `${options.headOwner}:${options.head}` : options.head,
			base: options.base,
			body: options.body || `Pull request from ${options.head} to ${options.base}`,
			draft: options.draft || false,
			...(options.maintainerCanModify === undefined
				? {}
				: { maintainer_can_modify: options.maintainerCanModify }),
			...(options.headOwner === options.owner && options.headRepo ? { head_repo: options.headRepo } : {})
		});

		const author = await this.buildPrAuthor(data.user, token, baseUrl);
		return {
			number: data.number,
			title: data.title,
			state: data.merged ? 'merged' : (data.state as 'open' | 'closed'),
			head: data.head.ref,
			base: data.base.ref,
			url: data.html_url,
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			body: data.body ?? undefined,
			// `null` when the head repository was deleted; a real answer, not an
			// omission (APW-09 T1).
			headRepoFullName: headRepoFullName(data),
			...(author ? { author } : {})
		};
	}

	async getPullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequest | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: prNumber
			});

			const author = await this.buildPrAuthor(data.user, token, baseUrl);
			const labels = labelNames(data.labels);
			return {
				number: data.number,
				title: data.title,
				state: data.merged ? 'merged' : (data.state as 'open' | 'closed'),
				head: data.head.ref,
				base: data.base.ref,
				url: data.html_url,
				createdAt: data.created_at,
				updatedAt: data.updated_at,
				body: data.body ?? undefined,
				// APW-09 T1: which repository the head branch lives in — the
				// fact that makes a tracked upstream pull request provable.
				headRepoFullName: headRepoFullName(data),
				...(author ? { author } : {}),
				...(labels ? { labels } : {})
			};
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	async mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string,
		baseUrl?: string
	): Promise<MergeResult> {
		const octokit = this.createOctokit(token, baseUrl);

		// `sha` is GitHub's own optimistic-concurrency guard: the merge is
		// refused (409 `Head branch was modified`) when the pull request's
		// head is no longer this commit. The agent merge path pins it to
		// the head it just verified as green and approved, so a push that
		// lands in the gap between the check and this call cannot be
		// merged in place of what was reviewed. Omitted when the caller
		// does not supply one, which is the pre-existing behaviour.
		const { data } = await octokit.rest.pulls.merge({
			owner,
			repo,
			pull_number: prNumber,
			commit_title: options?.commitTitle,
			commit_message: options?.commitMessage,
			merge_method: options?.mergeMethod || 'merge',
			...(options?.expectedHeadSha ? { sha: options.expectedHeadSha } : {})
		});

		return {
			sha: data.sha,
			merged: data.merged,
			message: data.message
		};
	}

	/**
	 * List pull requests (APW-09 T1 — the `head` filter).
	 *
	 * `options.head` (`"{owner}:{branch}"`) is passed through when set and
	 * omitted otherwise, so an ordinary list request is unchanged. The filter is
	 * what answers "is there already a pull request for MY fork branch?" in one
	 * bounded request, which is the recovery path after a lost open (G17).
	 */
	async listPullRequests(
		owner: string,
		repo: string,
		options: ListPullRequestsOptions | undefined,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequest[]> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.list({
			owner,
			repo,
			state: options?.state || 'open',
			per_page: options?.perPage || 30,
			page: options?.page || 1,
			...(options?.head ? { head: options.head } : {})
		});

		// Map sequentially: the per-author verified-org call is cached, so
		// a batch of PRs from the same author hits GitHub once. Different
		// authors still trigger N lookups (bounded by per_page). The cap
		// in the community-PR pipeline (max 10/PR per run) keeps total
		// fan-out small enough to stay well under GitHub's 5000/hour
		// authenticated rate limit.
		const result: GitPullRequest[] = [];
		for (const pr of data) {
			const author = await this.buildPrAuthor(pr.user, token, baseUrl);
			const labels = labelNames(pr.labels);
			result.push({
				number: pr.number,
				title: pr.title,
				state: pr.merged_at ? 'merged' : (pr.state as 'open' | 'closed'),
				head: pr.head.ref,
				base: pr.base.ref,
				url: pr.html_url,
				createdAt: pr.created_at,
				updatedAt: pr.updated_at,
				body: pr.body ?? undefined,
				// APW-09 T1: the recovery path adopts an existing pull request
				// only when its head repository AND branch equal the row's.
				headRepoFullName: headRepoFullName(pr),
				...(author ? { author } : {}),
				...(labels ? { labels } : {})
			});
		}
		return result;
	}

	async getPullRequestFiles(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequestFile[]> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.listFiles({
			owner,
			repo,
			pull_number: prNumber,
			per_page: 100
		});

		return data.map((file) => ({
			filename: file.filename,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			patch: file.patch
		}));
	}

	/**
	 * PR insights (kanban M5) — PR state + review decision + rolled-up CI
	 * for the board's review pill.
	 *
	 * Three API reads, all bounded: the PR itself, its head commit's
	 * check-runs, and its head commit's legacy commit-statuses (many
	 * external CI providers still only publish the latter — reading both
	 * is what makes the dot honest across setups). A missing PR resolves
	 * to `null`; a checks read that 404s/403s (e.g. a token without
	 * `checks:read`) degrades to "no checks" rather than failing the
	 * whole status — a pill with an unknown dot beats no pill at all.
	 */
	async getPullRequestStatus(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequestStatus | null> {
		const octokit = this.createOctokit(token, baseUrl);

		let pr;
		try {
			const response = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
			pr = response.data;
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) return null;
			throw err;
		}

		const headSha: string | null = pr.head?.sha ?? null;
		// Merge approval (slice AE): roll up FIRST, cap SECOND. `capped` is
		// the display sample the pill renders; `checks` is the whole set
		// the verdict is computed over. Deriving `ciState` from `capped`
		// (which is what this did until the AE review) reports a red pull
		// request green the moment the failing leg sorts past index 20 —
		// and this repository's own CI runs far more than twenty legs,
		// with external commit statuses appended LAST so they were always
		// the ones dropped.
		const read = headSha
			? await this.readChecks(octokit, owner, repo, headSha)
			: { checks: [] as GitPullRequestCheck[], complete: true };
		const checks = read.checks;
		const capped = capChecks(checks);

		const merged = pr.merged === true || pr.merged_at != null;
		const state: GitPullRequestStatus['state'] = merged
			? 'merged'
			: pr.state === 'closed'
				? 'closed'
				: pr.draft === true
					? 'draft'
					: 'open';

		const rawDecision = (pr as { review_decision?: string | null }).review_decision;
		const reviewDecision: GitReviewDecision | null = rawDecision
			? (REVIEW_DECISION_MAP[rawDecision] ?? null)
			: null;

		return {
			number: pr.number,
			state,
			merged,
			mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
			headSha,
			baseRef: pr.base?.ref ?? null,
			reviewDecision,
			ciState: deriveCiState(checks),
			checks: capped,
			checksComplete: read.complete,
			// APW-09 T1: the status poll is what notices a tracked pull
			// request's head repository disappearing; `null` is that answer,
			// not an omission.
			headRepoFullName: headRepoFullName(pr),
			url: pr.html_url,
			title: pr.title
		};
	}

	/**
	 * Release promotion lane (slice AI) — the most recent
	 * `promotion-gate.yml`-style workflow run for one commit.
	 *
	 * ONE request: `GET /repos/{owner}/{repo}/actions/runs?head_sha=…`,
	 * then filter by workflow file. The alternative — asking
	 * `/actions/workflows/{file}/runs` directly — 404s whenever the
	 * workflow file is not on the repository's default branch, which is
	 * exactly the situation a release lane is in the day the workflow is
	 * introduced, and a 404 there is indistinguishable from "no runs".
	 * Filtering client-side keeps "the workflow has no run for this
	 * commit" (`null`) separate from "the lookup failed" (a throw), which
	 * the caller renders differently.
	 *
	 * A 404 on the repository itself resolves to `null`; every other error
	 * propagates, because a token without `actions:read` must surface as a
	 * BROKEN GATE and not as a missing run.
	 */
	async getWorkflowRunForCommit(
		owner: string,
		repo: string,
		workflowPath: string,
		headSha: string,
		token: string,
		baseUrl?: string
	): Promise<GitWorkflowRun | null> {
		const wanted = workflowFileName(workflowPath);
		if (!wanted || !headSha) return null;

		const octokit = this.createOctokit(token, baseUrl);
		let runs: WorkflowRunPayload[];
		try {
			const response = await octokit.rest.actions.listWorkflowRunsForRepo({
				owner,
				repo,
				head_sha: headSha,
				per_page: WORKFLOW_RUNS_PER_PAGE
			});
			runs = (response.data?.workflow_runs ?? []) as WorkflowRunPayload[];
		} catch (err) {
			// Only a missing REPOSITORY is an answer. A 403 (no
			// `actions:read`) or a 5xx is a broken lookup and must throw.
			if (err instanceof RequestError && err.status === 404) return null;
			throw err;
		}

		const matches = runs.filter((run) => workflowFileName(run.path) === wanted);
		if (matches.length === 0) return null;

		// Newest wins: a re-run of a red gate is the verdict that counts.
		// Ordered explicitly rather than trusting the API's default sort —
		// run id first (a later trigger is a later run), then `run_attempt`
		// as the tie-break, because a re-run keeps the run id and only bumps
		// the attempt.
		const newest = matches.reduce((best, run) => {
			const bestId = best.id ?? 0;
			const runId = run.id ?? 0;
			if (runId !== bestId) return runId > bestId ? run : best;
			return (run.run_attempt ?? 1) > (best.run_attempt ?? 1) ? run : best;
		});

		return {
			id: newest.id ?? 0,
			workflowPath: newest.path ?? workflowPath,
			headSha: newest.head_sha ?? headSha,
			status: CHECK_STATUS_MAP[newest.status ?? ''] ?? 'unknown',
			conclusion: newest.conclusion ? (CHECK_CONCLUSION_MAP[newest.conclusion] ?? null) : null,
			...(newest.html_url ? { url: newest.html_url } : {}),
			...(typeof newest.run_attempt === 'number' ? { runAttempt: newest.run_attempt } : {}),
			// Which pull request(s) this run was for. A run is keyed by
			// COMMIT, and one commit can head two pull requests; the caller
			// needs to be able to tell "this run is not about my pull
			// request" from "there is no run".
			...(Array.isArray(newest.pull_requests)
				? {
						pullRequestNumbers: newest.pull_requests
							.map((pr) => pr?.number)
							.filter((n): n is number => typeof n === 'number')
					}
				: {})
		};
	}

	/**
	 * Read check-runs AND commit-statuses for one commit and normalise
	 * both onto the contract vocabulary.
	 *
	 * Best-effort per source: a token missing one scope still gets the
	 * other half. But "best-effort" is now REPORTED rather than silently
	 * absorbed — `complete` is false whenever a source could not be read
	 * at all, or whenever the commit carries more checks than the page
	 * budget will fetch. `getPullRequestStatus` passes that straight
	 * through as `checksComplete`, and the merge gate refuses to treat an
	 * incomplete roll-up as green (merge approval, slice AE). The board's
	 * dot is unaffected — a mostly-right pill still beats no pill.
	 */
	private async readChecks(
		octokit: Octokit,
		owner: string,
		repo: string,
		ref: string
	): Promise<{ checks: GitPullRequestCheck[]; complete: boolean }> {
		const out: GitPullRequestCheck[] = [];
		let complete = true;

		try {
			let page = 1;
			let seen = 0;
			for (;;) {
				const { data } = await octokit.rest.checks.listForRef({
					owner,
					repo,
					ref,
					per_page: CHECKS_PER_PAGE,
					page
				});
				const runs = data.check_runs ?? [];
				for (const run of runs) {
					const check: GitPullRequestCheck = {
						name: run.name,
						status: CHECK_STATUS_MAP[run.status] ?? 'unknown',
						conclusion: run.conclusion ? (CHECK_CONCLUSION_MAP[run.conclusion] ?? null) : null,
						...(run.details_url ? { detailsUrl: run.details_url } : {})
					};
					out.push(check);
				}
				seen += runs.length;
				// `total_count` is GitHub's own count for the ref, so this
				// is the only honest way to know whether a page-1 read saw
				// everything. A response without it is taken at face value.
				const total = typeof data.total_count === 'number' ? data.total_count : seen;
				if (seen >= total || runs.length === 0) break;
				if (page >= CHECKS_MAX_PAGES) {
					complete = false;
					break;
				}
				page += 1;
			}
		} catch {
			// `checks:read` not granted, or a provider without the Checks
			// API. Fall through to commit statuses — but say so: a verdict
			// rolled up without the Checks API cannot claim to have seen
			// every Actions run on the commit.
			complete = false;
		}

		try {
			// Statuses are append-only per context — keep the newest per
			// context so a fixed re-run doesn't leave a stale red behind.
			// GitHub returns them newest-first, so the FIRST row wins.
			const newestByContext = new Map<string, { context: string; state: string; target_url?: string | null }>();
			let page = 1;
			for (;;) {
				const { data } = await octokit.rest.repos.listCommitStatusesForRef({
					owner,
					repo,
					ref,
					per_page: CHECKS_PER_PAGE,
					page
				});
				for (const status of data) {
					if (!newestByContext.has(status.context)) newestByContext.set(status.context, status);
				}
				// No total_count on this endpoint: a short page is the end.
				if (data.length < CHECKS_PER_PAGE) break;
				if (page >= CHECKS_MAX_PAGES) {
					complete = false;
					break;
				}
				page += 1;
			}
			for (const status of newestByContext.values()) {
				const settled = status.state !== 'pending';
				out.push({
					name: status.context,
					status: settled ? 'completed' : 'queued',
					conclusion: settled ? (CHECK_CONCLUSION_MAP[status.state] ?? null) : null,
					...(status.target_url ? { detailsUrl: status.target_url } : {})
				});
			}
		} catch {
			// Same posture — an unreadable source contributes nothing, and
			// is reported as a gap rather than as "there was nothing here".
			complete = false;
		}

		return { checks: out, complete };
	}

	/**
	 * PR insights (kanban M6) — capped PR diff. The file cap is applied at
	 * the REQUEST (`per_page`) so we never pull a 3,000-file PR into
	 * memory just to slice it; `capDiffFiles` then enforces the byte
	 * budget and the final file cap with the shared rule.
	 *
	 * APW-09 T1 adds `totalCommits` to the result. `pulls.listFiles` — the read
	 * this method is built on, and the only one that bounds the file cap at the
	 * request — carries NO commit count, so the count comes from the pull
	 * request itself (`pulls.get` → `commits`), which is the same question
	 * ("how many commits does this pull request hold?") answered by the only
	 * endpoint that holds it. That is one extra read on a display/approval path,
	 * and it is deliberately NON-FATAL: the diff is the answer, the commit count
	 * is advisory here (the upstream verifier reads it from `getCompareDiff`),
	 * so a failed count read returns the diff with the field absent —
	 * `undefined` meaning "this read did not report it", which is exactly what
	 * the contract's optional field says.
	 */
	async getPullRequestDiff(
		owner: string,
		repo: string,
		prNumber: number,
		opts: GitDiffOptions | undefined,
		token: string,
		baseUrl?: string
	): Promise<GitDiffResult> {
		const octokit = this.createOctokit(token, baseUrl);
		const { maxFiles } = resolveDiffCaps(opts);

		const { data } = await octokit.rest.pulls.listFiles({
			owner,
			repo,
			pull_number: prNumber,
			// One extra so `totalFiles > files.length` can prove there IS
			// more without a second round trip.
			per_page: Math.min(maxFiles + 1, 100)
		});

		const result = capDiffFiles(data.map(toDiffFile), opts);

		try {
			const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
			const commits = (pr.data as { commits?: unknown }).commits;
			return typeof commits === 'number' ? { ...result, totalCommits: commits } : result;
		} catch {
			return result;
		}
	}

	/**
	 * PR insights (kanban M6) — `base...head` compare for a branch that
	 * has no PR yet. Same caps, same shape, and (APW-09 T1) the compare's own
	 * `total_commits`, which is the count APW-09's `notSingleCommit` check reads
	 * — never the file count, which cannot express it.
	 */
	async getCompareDiff(
		owner: string,
		repo: string,
		base: string,
		head: string,
		opts: GitDiffOptions | undefined,
		token: string,
		baseUrl?: string
	): Promise<GitDiffResult> {
		const octokit = this.createOctokit(token, baseUrl);
		const { maxFiles } = resolveDiffCaps(opts);

		const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
			owner,
			repo,
			basehead: `${base}...${head}`,
			per_page: Math.min(maxFiles + 1, 100)
		});

		const result = capDiffFiles((data.files ?? []).map(toDiffFile), opts);
		return typeof data.total_commits === 'number' ? { ...result, totalCommits: data.total_commits } : result;
	}

	/**
	 * Every review on a pull request, oldest first (APW-09 T2).
	 *
	 * One bounded page (`per_page: 100`, GitHub's maximum) and a body cap of
	 * 8 KB per review, applied here rather than at each consumer: the status job
	 * reads this list on every due row, and the follow-up brief that quotes it is
	 * bounded too.
	 *
	 * `state` is mapped onto the contract's five values and `submittedAt` is
	 * `null` for a review GitHub reports without one (a `PENDING` review the
	 * caller of this token has started but not submitted). A provider failure is
	 * the contract's typed error, so a caller can tell "no reviews yet" (an empty
	 * array) from "the read failed" (a throw) — the two must never collapse.
	 */
	async listPullRequestReviews(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequestReview[]> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.pulls.listReviews({
				owner,
				repo,
				pull_number: prNumber,
				per_page: REVIEWS_PER_PAGE
			});

			return (data ?? []).slice(0, REVIEWS_PER_PAGE).map((review) => ({
				id: review.id,
				state: REVIEW_STATE_MAP[review.state ?? ''] ?? 'commented',
				author: review.user?.login ?? null,
				submittedAt: review.submitted_at ?? null,
				body: truncateUtf8(review.body ?? '', REVIEW_BODY_MAX_BYTES)
			}));
		} catch (err) {
			throw toGitProviderError(err, 'pull_requests');
		}
	}

	/**
	 * Inline review comments on a pull request (APW-09 T2) — the half of a
	 * review that says WHICH line, which is what a review follow-up Task is
	 * seeded with. One bounded page, 4 KB per body.
	 */
	async listPullRequestReviewComments(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequestReviewComment[]> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.pulls.listReviewComments({
				owner,
				repo,
				pull_number: prNumber,
				per_page: REVIEWS_PER_PAGE
			});

			return (data ?? []).slice(0, REVIEWS_PER_PAGE).map((comment) => ({
				id: comment.id,
				author: comment.user?.login ?? null,
				body: truncateUtf8(comment.body ?? '', REVIEW_COMMENT_BODY_MAX_BYTES),
				path: comment.path ?? null,
				// `line` is null on a comment GitHub considers outdated (the
				// diff moved under it) and for a file-level comment; the
				// ORIGINAL line is deliberately NOT substituted, because a
				// caller pointing an agent at a line must be told when the
				// anchor no longer exists rather than be sent to the wrong one.
				line: comment.line ?? null,
				createdAt: comment.created_at ?? null
			}));
		} catch (err) {
			throw toGitProviderError(err, 'pull_requests');
		}
	}

	/**
	 * The repository's TEMPORARY interaction limit (APW-09 T2, G16) —
	 * `'none' | 'existing_users' | 'contributors_only' | 'collaborators_only'`,
	 * or `null` for "cannot tell".
	 *
	 * The mapping is deliberately conservative in one direction only:
	 *
	 * - A `403` (a token without admin rights — GitHub's answer for this
	 *   endpoint) and a `404` (an invisible repository) answer `null`, never
	 *   `'none'`. "I was not allowed to look" is not "there is no limit", and a
	 *   caller that read it as unrestricted would open a pull request into a
	 *   repository that restricts interactions.
	 * - An EMPTY answer (GitHub's `204` when a repository has no temporary
	 *   limit) answers `null` too, which is the same rule the plan states
	 *   ("404/403/empty → null, never `'none'`"): `null` refuses nothing new,
	 *   and only a provider that literally reports a limit value is believed.
	 *   `'none'` therefore remains reachable for a provider that says it and is
	 *   never fabricated here.
	 * - Every other failure (a 5xx, a spent rate limit, a transport error)
	 *   THROWS rather than answering `null`: a broken read and an answer of
	 *   "cannot tell" send the operator to different places, and swallowing a
	 *   500 into a silent `null` would hide a provider that is down.
	 *
	 * This read answers the TEMPORARY limit only. `pullRequestsDisabled` and
	 * `outsideContributorCap` are the repository-level control and the
	 * outside-contributor cap — different settings, read elsewhere.
	 */
	async getInteractionLimit(
		owner: string,
		repo: string,
		token: string,
		baseUrl?: string
	): Promise<GitInteractionLimit | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const response = await octokit.rest.interactions.getRestrictionsForRepo({ owner, repo });
			// `204 No Content` (no temporary limit) arrives with no usable
			// body; the optional chain is what turns it into `null`.
			const limit = (response.data as { limit?: unknown } | undefined)?.limit;
			return isInteractionLimit(limit) ? limit : null;
		} catch (err) {
			if (err instanceof RequestError && (err.status === 403 || err.status === 404)) {
				return null;
			}
			throw err;
		}
	}

	async createPullRequestComment(
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
		token: string,
		baseUrl?: string
	): Promise<{ id: number; body: string }> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: prNumber,
			body
		});

		return { id: data.id, body: data.body || '' };
	}

	async closePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequest> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.update({
			owner,
			repo,
			pull_number: prNumber,
			state: 'closed'
		});

		const author = await this.buildPrAuthor(data.user, token, baseUrl);
		return {
			number: data.number,
			title: data.title,
			state: data.merged_at ? 'merged' : (data.state as 'open' | 'closed'),
			head: data.head.ref,
			base: data.base.ref,
			url: data.html_url,
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			body: data.body ?? undefined,
			...(author ? { author } : {})
		};
	}

	async repositoryExists(owner: string, repo: string, token: string, baseUrl?: string): Promise<boolean> {
		const repository = await this.getRepository(owner, repo, token, baseUrl);
		return repository !== null;
	}

	async hasRepositoryAccess(owner: string, repo: string, token: string, baseUrl?: string): Promise<boolean> {
		try {
			const octokit = this.createOctokit(token, baseUrl);
			await octokit.rest.repos.get({ owner, repo });
			return true;
		} catch (err) {
			if (err instanceof RequestError && (err.status === 404 || err.status === 403)) {
				return false;
			}
			throw err;
		}
	}

	async hasForkRelationship(
		forkOwner: string,
		forkRepo: string,
		parentOwner: string,
		parentRepo: string,
		token: string,
		baseUrl?: string
	): Promise<boolean> {
		const repository = await this.getRepository(forkOwner, forkRepo, token, baseUrl);
		if (!repository || !repository.isFork || !repository.parent) {
			return false;
		}

		return repository.parent.owner === parentOwner && repository.parent.name === parentRepo;
	}

	// Content access methods

	async getFileContent(
		owner: string,
		repo: string,
		path: string,
		token: string,
		ref?: string,
		baseUrl?: string
	): Promise<{ content: string; encoding: string } | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.getContent({
				owner,
				repo,
				path,
				ref
			});

			if ('content' in data && data.type === 'file') {
				const content = Buffer.from(data.content, 'base64').toString('utf-8');
				return { content, encoding: 'utf-8' };
			}

			return null;
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	/**
	 * EW-641 Phase 1B/d row 18b — list commits touching `path` via
	 * `GET /repos/{owner}/{repo}/commits?path=…`. Newest first, capped
	 * to `[1, 100]` (the GitHub `per_page` limit).
	 */
	async listFileCommits(
		owner: string,
		repo: string,
		path: string,
		token: string,
		limit?: number,
		baseUrl?: string
	): Promise<GitCommit[]> {
		const octokit = this.createOctokit(token, baseUrl);
		const perPage = typeof limit === 'number' ? Math.min(Math.max(Math.floor(limit), 1), 100) : 25;

		try {
			const { data } = await octokit.rest.repos.listCommits({
				owner,
				repo,
				path,
				per_page: perPage
			});

			// Some commits are signed by GitHub Actions / bots where the
			// `commit.author.name` field is set but `data.author` (the
			// repo-user record) is null — fall back to the commit-level
			// author so the dialog still shows a meaningful display name.
			return data.map(
				(row): GitCommit => ({
					sha: row.sha,
					message: row.commit.message,
					author: {
						name: row.commit.author?.name ?? row.author?.login ?? '',
						email: row.commit.author?.email ?? ''
					},
					date: row.commit.author?.date ?? row.commit.committer?.date ?? ''
				})
			);
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return [];
			}
			throw err;
		}
	}

	async getReadme(
		owner: string,
		repo: string,
		token: string,
		ref?: string,
		baseUrl?: string
	): Promise<{ content: string; path: string } | null> {
		const octokit = this.createOctokit(token, baseUrl);

		// Try GitHub's dedicated readme API first
		try {
			const { data } = await octokit.rest.repos.getReadme({
				owner,
				repo,
				ref
			});

			if (data.content && data.encoding === 'base64') {
				const content = Buffer.from(data.content, 'base64').toString('utf-8');
				return { content, path: data.name };
			}
		} catch {
			// Fall through to manual lookup
		}

		// Fallback: try common README filenames
		const readmeFiles = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];

		for (const filename of readmeFiles) {
			const result = await this.getFileContent(owner, repo, filename, token, ref, baseUrl);
			if (result) {
				return { content: result.content, path: filename };
			}
		}

		return null;
	}

	getRawFileUrl(owner: string, repo: string, branch: string, path: string): string {
		// Security (URL injection / path traversal): owner/repo/branch/path are
		// interpolated straight into a raw.githubusercontent.com URL whose result
		// is fed to fetch() (source-repo-analyzer) and may be rendered in the UI.
		// A segment containing `..`, an encoded slash (%2F), a backslash, or a
		// CR/LF sequence could traverse to a different repository or inject into
		// the URL. Reject those vectors; legitimate GitHub owner/repo/branch/path
		// values pass through unchanged. Fail closed by throwing -- the sole caller
		// wraps this in try/catch and falls through to the next candidate.
		const rejectSegment = (segment: string, allowSlash: boolean): void => {
			// Control chars (incl. CR/LF/NUL/DEL), backslash, and % (percent-encoding
			// such as %2F) are never valid here and all enable URL/path injection.
			for (let idx = 0; idx < segment.length; idx++) {
				const code = segment.charCodeAt(idx);
				const ch = segment[idx];
				if (code <= 0x1f || code === 0x7f || ch === '\\' || ch === '%') {
					throw new Error('getRawFileUrl: illegal character in URL segment');
				}
			}
			// A `..` or `.` that is a WHOLE path component (slash-delimited, or the
			// entire value) is traversal; a literal `..` inside a longer filename
			// (e.g. a..b.txt) is harmless and stays allowed.
			if (segment.split('/').some((p) => p === '..' || p === '.')) {
				throw new Error('getRawFileUrl: path traversal in URL segment');
			}
			// owner/repo/branch are single path segments and must not contain a
			// slash of their own; only path may legitimately contain `/`.
			if (!allowSlash && segment.includes('/')) {
				throw new Error('getRawFileUrl: unexpected slash in URL segment');
			}
		};
		rejectSegment(owner, false);
		rejectSegment(repo, false);
		rejectSegment(branch, false);
		rejectSegment(path, true);

		// APW-13 T5 (additive): the non-production acceptance switch. Every
		// validation above has already run, unchanged and before anything is built —
		// the switch changes the host only, never what is accepted as a segment. The
		// fake serves raw content under the same owner/repo/branch/path shape, so a
		// traversal is refused here exactly as it is on the real host.
		const e2eFakeOrigin = resolveGitHubE2eFakeOrigin();
		if (e2eFakeOrigin) {
			return `${e2eFakeOrigin}/${owner}/${repo}/${branch}/${path}`;
		}

		return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
	}

	async getWorkContents(
		owner: string,
		repo: string,
		path: string,
		token: string,
		baseUrl?: string
	): Promise<Array<{ name: string; type: 'file' | 'dir' | 'submodule' | 'symlink'; path: string }> | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.getContent({
				owner,
				repo,
				path
			});

			if (!Array.isArray(data)) {
				return null;
			}

			return data.map((item) => ({
				name: item.name,
				type: item.type as 'file' | 'dir' | 'submodule' | 'symlink',
				path: item.path
			}));
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	// ── App Works fork lifecycle (APW-02 T19–T21, plan §4.3) ────────────────

	/**
	 * Copy one branch of a source repository into a repository the platform owns
	 * (APW-02 T19 — plan §4.3, FR-21, ACC-02-15).
	 *
	 * Order is the feature. The two refusals §4.3 names happen BEFORE any git
	 * work, because both describe a clone that must not be started: a source
	 * larger than the caller's `maxSizeKb` ceiling (the caller has authorised
	 * that size and no larger), and a root `.gitattributes` that sends files to
	 * Git LFS (isomorphic-git has no LFS filter, so the copy would land a tree of
	 * pointer files nothing can hydrate). Both are `unprocessable` and carry the
	 * plan's own code — see {@link refusalError}.
	 *
	 * Then the idempotency half (FR-21, "safe to run twice"): when the target
	 * branch already points at the source head there is nothing to copy, so
	 * nothing is cloned, nothing is pushed, and the answer says so.
	 *
	 * Otherwise the source branch is cloned into a directory of its own
	 * (`cloneBranch` — never the shared per-repository checkout, which another
	 * caller may be rewriting at that instant), its `origin` is repointed at the
	 * TARGET's clone URL, and the branch is pushed under
	 * `input.branchName ?? input.sourceBranch`. The push carries no `force`
	 * member at all (ACC-02-10): a target branch that cannot be fast-forwarded is
	 * a conflict for the caller to resolve, never history to rewrite.
	 *
	 * `gitOps` is passed in rather than built here: the plugin owns the one
	 * `GitOperations` instance (created in `GitHubPlugin.onLoad`) together with
	 * its credentials, and a second one built behind its back would authenticate
	 * differently.
	 */
	async createRepositoryCopy(
		input: GitRepositoryCopyInput,
		token: string,
		baseUrl?: string,
		gitOps?: IGitOperations
	): Promise<GitRepositoryCopyResult> {
		// `cloneBranch` is OPTIONAL on `IGitOperations` — the contract says a caller
		// MUST verify it — and it is the only method that can produce the isolated
		// directory this copy needs. Checked before the first provider read: a
		// capability that cannot run must not read, let alone clone, first.
		if (typeof gitOps?.cloneBranch !== 'function') {
			throw refusalError('git_operations_unavailable');
		}

		const octokit = this.createOctokit(token, baseUrl);
		const branchName = input.branchName ?? input.sourceBranch;

		// 1. The source, for its size. `getRepository` is T16's single repository
		// read, so the ceiling is checked against the same fact the caller saw.
		const source = await this.getRepository(input.sourceOwner, input.sourceRepo, token, baseUrl);
		if (!source) {
			// A source the token cannot read is indistinguishable from one that is not
			// there, and GitHub answers 404 for both.
			throw new GitProviderRequestError('not_found', 404);
		}
		if (source.sizeKb === undefined || source.sizeKb > input.maxSizeKb) {
			// An UNREPORTED size is refused too, and that is deliberate: the ceiling is
			// the caller's authorisation, and a copy whose size cannot be compared to it
			// cannot be shown to be within it. GitHub always reports `size`; a provider
			// that does not gets the refusal rather than an unbounded clone.
			throw refusalError('too_large');
		}

		// 2. The LFS probe, on the branch being copied — a `.gitattributes` on the
		// default branch says nothing about a release branch that added its own.
		let attributes: { content: string } | null;
		try {
			attributes = await this.getFileContent(
				input.sourceOwner,
				input.sourceRepo,
				GITATTRIBUTES_PATH,
				token,
				input.sourceBranch,
				baseUrl
			);
		} catch (err) {
			// `getFileContent` predates the typed error and rethrows anything that is not
			// a 404 raw; §4.2's "new plugin methods throw only `GitProviderRequestError`"
			// is this method's contract, so the classification happens here.
			throw toGitProviderError(err, 'contents');
		}
		if (attributes !== null && usesLfsFilter(attributes.content)) {
			throw refusalError('uses_lfs');
		}

		// 3. The target, for its clone URL. The copy lands in a repository the caller
		// has already created (FR-21's empty repository); pushing into one that is not
		// there would fail at the git layer with a transport error naming nothing
		// actionable.
		const target = await this.getRepository(input.targetOwner, input.targetRepo, token, baseUrl);
		if (!target) {
			throw new GitProviderRequestError('not_found', 404);
		}

		// 4. The two heads the idempotency check compares: the source branch's, and the
		// target branch's when it exists at all.
		const sourceHead = await this.readBranchHead(octokit, input.sourceOwner, input.sourceRepo, input.sourceBranch);
		const targetHead = await this.readBranchHeadOrNone(octokit, input.targetOwner, input.targetRepo, branchName);
		if (targetHead !== undefined && targetHead === sourceHead) {
			return { pushedSha: sourceHead, alreadyUpToDate: true };
		}

		// 5. The copy itself. A git-layer failure — the clone, the remote rewrite, the
		// push — is not a GitHub API error, and §4.2 classifies what it cannot know as
		// `unprocessable` with the real status preserved (`0`: no response arrived). It
		// still leaves as the contract's error, because every new plugin method throws
		// only that, and the original travels as `cause` for whoever logs it.
		let dir: string;
		try {
			dir = await gitOps.cloneBranch({
				owner: input.sourceOwner,
				repo: input.sourceRepo,
				branch: input.sourceBranch,
				token
			});
		} catch (err) {
			// No directory to clean up: `cloneBranch` removes its own target before it
			// starts, and nothing of ours exists until it returns.
			throw toGitProviderError(err);
		}

		try {
			await gitOps.replaceRemote(dir, 'origin', target.cloneUrl);
			// No `force` member: `GitOperations.push` defaults it to `false`, and a
			// caller who cannot pass one cannot turn this into a rewrite. No
			// `maxRetries` either — the git layer's own default is not this method's to
			// change, and no retry is added on top of it.
			await gitOps.push({ dir, token, ref: input.sourceBranch, remoteRef: branchName });
			return { pushedSha: sourceHead, alreadyUpToDate: false };
		} catch (err) {
			throw toGitProviderError(err);
		} finally {
			// On every path out of the copy, error included: the working copy is this
			// call's own and holds a full checkout of the source.
			await removeClonedDirectory(dir);
		}
	}

	/**
	 * Apply a caller's Actions intent to one repository (APW-02 T20 — plan §4.3,
	 * FR-27, FR-30, ACC-02-08, ACC-02-20).
	 *
	 * Three independent instructions, each acted on only when the caller gives it
	 * (§3.3: "an omitted field means leave that alone"):
	 *
	 * - `enabled` — the repository-level switch (`PUT /actions/permissions`), sent
	 *   only when the field is present. When it is absent the current value is READ
	 *   instead, because `GitActionsPermissionsResult.actionsEnabled` has to report
	 *   what the repository is, and a guess is worse than one read.
	 * - `enableWorkflows` / `disableWorkflowsExcept` — the per-workflow half, over a
	 *   listing paginated up to `maxWorkflows` (100 by default).
	 * - `skipWorkflowIds` — ids never touched, in either direction (FR-27: they were
	 *   already judged, so re-enabling one is as wrong as disabling it).
	 *
	 * ONE deliberate reading of §4.3 lives here. §4.3 scopes the per-workflow half
	 * to `state === 'active'` workflows; read literally, `enableWorkflows` could
	 * only ever "enable" a workflow that is already active — exactly the case where
	 * APW-05 needs it to work, since hygiene disables everything but the build
	 * workflow first and the deploy workflow it later asks for is then
	 * `disabled_manually`. An id in `enableWorkflows` is therefore enabled whatever
	 * its state (the contract's own words for the field are "enable exactly these
	 * paths"), while DISABLING keeps §4.3's `active` restriction, so an
	 * already-disabled workflow is never touched and never reported as work done.
	 *
	 * The calls are made one at a time, in listing order, and a 403 STOPS the pass
	 * (§4.3). "Stop" is only meaningful — and only honest — with ordered calls: a
	 * parallel sweep would keep disabling after the first refusal and report a
	 * partial pass as a whole one.
	 */
	async setActionsPermissions(
		owner: string,
		repo: string,
		input: GitActionsPermissionsInput,
		token: string,
		baseUrl?: string
	): Promise<GitActionsPermissionsResult> {
		const octokit = this.createOctokit(token, baseUrl);
		const maxWorkflows = resolveMaxWorkflows(input.maxWorkflows);
		const skipIds = new Set(input.skipWorkflowIds ?? []);
		const enablePaths = new Set(input.enableWorkflows ?? []);
		const allowlist =
			input.disableWorkflowsExcept === undefined ? undefined : new Set(input.disableWorkflowsExcept);

		let actionsEnabled: boolean;
		if (input.enabled === undefined) {
			actionsEnabled = await this.readActionsEnabled(octokit, owner, repo);
		} else {
			await this.setActionsEnabled(octokit, owner, repo, input.enabled);
			actionsEnabled = input.enabled;
		}

		const { workflows, truncated } = await this.listWorkflowsUpTo(octokit, owner, repo, maxWorkflows);

		const seenIds: number[] = [];
		const disabled: GitWorkflowRef[] = [];
		const enabled: GitWorkflowRef[] = [];
		const kept: GitWorkflowRef[] = [];

		for (const workflow of workflows) {
			// Every id the pass looked at, skipped ones included: `seenIds` is the audit
			// half of the result, and a caller proves its `skipWorkflowIds` were honoured
			// by finding them here untouched.
			seenIds.push(workflow.id);
			if (skipIds.has(workflow.id)) continue;

			const ref: GitWorkflowRef = { id: workflow.id, path: workflow.path };

			if (enablePaths.has(workflow.path)) {
				await this.enableWorkflow(octokit, owner, repo, workflow.id);
				enabled.push(ref);
				continue;
			}

			if (allowlist !== undefined && workflow.state === 'active' && !allowlist.has(workflow.path)) {
				await this.disableWorkflow(octokit, owner, repo, workflow.id);
				disabled.push(ref);
				continue;
			}

			if (workflow.state === 'active') kept.push(ref);
		}

		return { actionsEnabled, disabled, kept, enabled, seenIds, truncated };
	}

	/**
	 * Install a signed webhook on a repository, updating the one already pointed at
	 * the same URL instead of adding a second (APW-02 T21 — plan §4.3, FR-55).
	 *
	 * Idempotence is by URL: a hook whose `config.url` equals the requested one is
	 * PATCHed to the requested events and secret and answers `created: false`.
	 * That is what makes a retried call safe — creating unconditionally would leave
	 * the receiver verifying two hooks for every event. The PATCH carries the whole
	 * `config` (URL, secret, `content_type`, `insecure_ssl`) rather than the two
	 * fields that changed, so the hook converges on the requested state whatever it
	 * was left in.
	 *
	 * Every failure leaves through {@link webhookFailure}, which never carries the
	 * signing secret — including on the `cause` the classifier would otherwise
	 * attach.
	 */
	async createWebhook(
		owner: string,
		repo: string,
		input: GitWebhookInput,
		token: string,
		baseUrl?: string
	): Promise<{ id: number; created: boolean }> {
		const refused = webhookRefusal(input);
		if (refused) throw refused;

		const octokit = this.createOctokit(token, baseUrl);
		const existing = await this.findWebhookByUrl(octokit, owner, repo, input.url, input.secret);
		const events = [...input.events];

		try {
			if (existing !== undefined) {
				const { data } = await octokit.rest.repos.updateWebhook({
					owner,
					repo,
					hook_id: existing,
					config: webhookConfig(input),
					events,
					active: true
				});
				// The id of the hook that was updated, whether or not the provider echoed
				// one back: `existing` is the hook we just told it to update.
				return { id: typeof data?.id === 'number' ? data.id : existing, created: false };
			}

			const { data } = await octokit.rest.repos.createWebhook({
				owner,
				repo,
				config: webhookConfig(input),
				events,
				active: true
			});
			return { id: data.id, created: true };
		} catch (err) {
			throw webhookFailure(err, input.secret);
		}
	}

	/**
	 * Remove a webhook (APW-02 T21 — plan §4.3).
	 *
	 * A 404 is SUCCESS: the hook is not there, which is exactly the state the
	 * caller asked for, so a delete retried after a half-failed flow does not
	 * report a failure that is not one.
	 */
	async deleteWebhook(owner: string, repo: string, hookId: number, token: string, baseUrl?: string): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			await octokit.rest.repos.deleteWebhook({ owner, repo, hook_id: hookId });
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) return;
			// No secret is in scope here: this call carries none.
			throw webhookFailure(err, undefined);
		}
	}

	/**
	 * One branch's head commit sha.
	 *
	 * Every failure — the 404 of a branch that is not there included — leaves as
	 * the contract's typed error, with `contents` named as the permission a refusal
	 * to read it needs (plan §4.2, §4.5).
	 */
	private async readBranchHead(octokit: Octokit, owner: string, repo: string, branch: string): Promise<string> {
		try {
			const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
			return data.commit.sha;
		} catch (err) {
			throw toGitProviderError(err, 'contents');
		}
	}

	/**
	 * The same read, for a branch that may legitimately not exist yet: the target of
	 * a copy is an EMPTY repository, so its branch is a 404 until the first push
	 * lands. Only a 404 answers `undefined`; anything else is still a failure.
	 */
	private async readBranchHeadOrNone(
		octokit: Octokit,
		owner: string,
		repo: string,
		branch: string
	): Promise<string | undefined> {
		try {
			const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
			return data.commit.sha;
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) return undefined;
			throw toGitProviderError(err, 'contents');
		}
	}

	/** The repository-level Actions switch, as the provider reports it. */
	private async readActionsEnabled(octokit: Octokit, owner: string, repo: string): Promise<boolean> {
		try {
			const { data } = await octokit.rest.actions.getGithubActionsPermissionsRepository({ owner, repo });
			return data.enabled;
		} catch (err) {
			// The repository switch is an administration write (§4.5); reading it back
			// needs the same access, so that is the permission a refusal names.
			throw actionsFailure(err, 'administration');
		}
	}

	/** `PUT /actions/permissions` — sent only when the caller asked for a value. */
	private async setActionsEnabled(octokit: Octokit, owner: string, repo: string, enabled: boolean): Promise<void> {
		try {
			await octokit.rest.actions.setGithubActionsPermissionsRepository({ owner, repo, enabled });
		} catch (err) {
			throw actionsFailure(err, 'administration');
		}
	}

	private async enableWorkflow(octokit: Octokit, owner: string, repo: string, workflowId: number): Promise<void> {
		try {
			await octokit.rest.actions.enableWorkflow({ owner, repo, workflow_id: workflowId });
		} catch (err) {
			throw actionsFailure(err, actionsPermissionForRefusal(err));
		}
	}

	private async disableWorkflow(octokit: Octokit, owner: string, repo: string, workflowId: number): Promise<void> {
		try {
			await octokit.rest.actions.disableWorkflow({ owner, repo, workflow_id: workflowId });
		} catch (err) {
			throw actionsFailure(err, actionsPermissionForRefusal(err));
		}
	}

	/**
	 * The repository's workflows, paginated, and never more than `maxWorkflows` of
	 * them (§4.3's cap; T20's "150 workflows with `maxWorkflows: 100`").
	 *
	 * `truncated` is answered rather than assumed: when the cap lands exactly on a
	 * page boundary the next page is peeked at, because "the cap was reached" and
	 * "the repository has more workflows than the cap" are different facts, and only
	 * the second one means the pass was partial — which §3.3 forbids reporting as a
	 * complete one.
	 */
	private async listWorkflowsUpTo(
		octokit: Octokit,
		owner: string,
		repo: string,
		maxWorkflows: number
	): Promise<{ workflows: ActionsWorkflowPayload[]; truncated: boolean }> {
		const workflows: ActionsWorkflowPayload[] = [];

		for (let page = 1; ; page++) {
			let pageItems: ActionsWorkflowPayload[];

			try {
				const { data } = await octokit.rest.actions.listRepoWorkflows({
					owner,
					repo,
					per_page: ACTIONS_WORKFLOW_PAGE_SIZE,
					page
				});
				pageItems = Array.isArray(data.workflows) ? (data.workflows as ActionsWorkflowPayload[]) : [];
			} catch (err) {
				throw actionsFailure(err, 'actions');
			}

			const room = maxWorkflows - workflows.length;
			workflows.push(...pageItems.slice(0, Math.max(room, 0)));

			// A short page is the last page GitHub has.
			const lastPage = pageItems.length < ACTIONS_WORKFLOW_PAGE_SIZE;

			if (workflows.length >= maxWorkflows) {
				if (pageItems.length > room) return { workflows, truncated: true };
				if (lastPage) return { workflows, truncated: false };
				return { workflows, truncated: await this.hasWorkflowsAtPage(octokit, owner, repo, page + 1) };
			}

			if (lastPage) return { workflows, truncated: false };
		}
	}

	/** One peek, so `truncated` reports the provider's answer and not an assumption. */
	private async hasWorkflowsAtPage(octokit: Octokit, owner: string, repo: string, page: number): Promise<boolean> {
		try {
			const { data } = await octokit.rest.actions.listRepoWorkflows({
				owner,
				repo,
				per_page: ACTIONS_WORKFLOW_PAGE_SIZE,
				page
			});
			return Array.isArray(data.workflows) && data.workflows.length > 0;
		} catch (err) {
			// A peek that failed is not "nothing lies beyond the cap": reporting a
			// complete pass off a read that never answered is the one outcome §3.3
			// forbids.
			throw actionsFailure(err, 'actions');
		}
	}

	/**
	 * The hook already pointed at `url`, if there is one.
	 *
	 * Bounded at {@link WEBHOOK_MAX_PAGES} pages: GitHub's own ceiling is 20 hooks
	 * per repository, so a real repository is answered by the first page, and the
	 * bound is what stops a provider that answers an endless listing.
	 */
	private async findWebhookByUrl(
		octokit: Octokit,
		owner: string,
		repo: string,
		url: string,
		secret: string
	): Promise<number | undefined> {
		for (let page = 1; page <= WEBHOOK_MAX_PAGES; page++) {
			let hooks: ReadonlyArray<WebhookPayload | null>;

			try {
				const { data } = await octokit.rest.repos.listWebhooks({
					owner,
					repo,
					per_page: WEBHOOK_PAGE_SIZE,
					page
				});
				hooks = Array.isArray(data) ? (data as WebhookPayload[]) : [];
			} catch (err) {
				throw webhookFailure(err, secret);
			}

			const match = hooks.find(
				(hook) =>
					typeof hook?.id === 'number' &&
					typeof hook?.config?.url === 'string' &&
					// The URL is compared as configured — trimmed, because a trailing newline
					// in a stored value is a paste artefact, not a different hook.
					hook.config.url.trim() === url
			);
			if (match && typeof match.id === 'number') return match.id;

			if (hooks.length < WEBHOOK_PAGE_SIZE) return undefined;
		}

		return undefined;
	}
}
