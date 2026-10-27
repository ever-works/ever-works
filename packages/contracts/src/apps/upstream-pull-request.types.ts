/**
 * APW-09 — Upstream pull requests: the shared vocabulary (plan §3.3, Resolution R-1).
 *
 * Types, closed unions, constants and pure helpers only — no I/O. The API, the web
 * app and the agent package read the same states, refusal codes and limits from here,
 * so a value the API can answer is a value the web can render and a column can hold.
 *
 * NOTHING here may be removed, reordered or narrowed (CONTRACTS R-26): a union gains
 * members at its end, a limit is raised deliberately.
 *
 * Two deliberate departures from plan §3.3, both additive:
 *
 * - `GitPullRequestReview` is NOT redeclared here. APW-09 T2 already landed it in the
 *   plugin SDK (`packages/plugin/src/contracts/capabilities/git-provider.interface.ts`),
 *   which is where the provider implementations read it; a second declaration would be
 *   two answers to one question.
 * - `UpstreamPullRequestDetailView.diff` is typed by {@link UpstreamPullRequestDiffView},
 *   a structural subset of the plugin's `GitDiffResult`, because this package depends on
 *   no other workspace package.
 */

/** Every state an upstream pull request record can be in (FR-28). Append-only. */
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
export type UpstreamPullRequestState = (typeof UPSTREAM_PULL_REQUEST_STATES)[number];

/** The states that hold a source Task's one active slot (FR-5, the partial unique index). */
export const UPSTREAM_ACTIVE_STATES = [
	'preparing',
	'needs_signature',
	'awaiting_approval',
	'opening',
	'open'
] as const satisfies readonly UpstreamPullRequestState[];
export type UpstreamActiveState = (typeof UPSTREAM_ACTIVE_STATES)[number];

/** Final states: nothing moves a record out of one (FR-32). */
export const UPSTREAM_TERMINAL_STATES = [
	'merged',
	'closed',
	'refused',
	'failed',
	'expired',
	'withdrawn'
] as const satisfies readonly UpstreamPullRequestState[];

/** States a member may still withdraw from — everything before the pull request exists (FR-33). */
export const UPSTREAM_WITHDRAWABLE_STATES = [
	'preparing',
	'needs_signature',
	'awaiting_approval'
] as const satisfies readonly UpstreamPullRequestState[];

/** `true` ⇔ the state holds the source Task's active slot. */
export function isUpstreamActiveState(state: unknown): state is UpstreamActiveState {
	return (UPSTREAM_ACTIVE_STATES as readonly unknown[]).includes(state);
}

export const UPSTREAM_CHECKS_SUMMARIES = [
	'passing',
	'failing',
	'pending',
	'waiting_for_maintainers',
	'unknown'
] as const;
export type UpstreamChecksSummary = (typeof UPSTREAM_CHECKS_SUMMARIES)[number];

export const UPSTREAM_REVIEW_SUMMARIES = ['none', 'approved', 'changes_requested', 'commented'] as const;
export type UpstreamReviewSummary = (typeof UPSTREAM_REVIEW_SUMMARIES)[number];

export const UPSTREAM_SIGNATURE_STATES = ['cla_required', 'cla_acknowledged', 'cla_pending_check'] as const;
export type UpstreamSignatureState = (typeof UPSTREAM_SIGNATURE_STATES)[number];

/** Every refusal (spec §6.5 has one copy row per value). Append-only — never reordered (R-26). */
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
	// Appended 2026-09-17 (G10, G16, XC-22).
	'publishingOff',
	'pullRequestsDisabled',
	'outsideContributorCap',
	'platformCapReached',
	'maintainerOptOut',
	'deniedUpstream',
	'reportInvalid'
] as const;
export type UpstreamRefusalCode = (typeof UPSTREAM_REFUSAL_CODES)[number];

/** `409` bodies that are not refusals (spec §6.5). Append-only. */
export const UPSTREAM_ERROR_CODES = ['activeProposal'] as const;
export type UpstreamErrorCode = (typeof UPSTREAM_ERROR_CODES)[number];

/**
 * FR-26 / FR-39 limits. Every value is the DEFAULT; an operator may raise one for the
 * installation without a redeploy (R-31). `openPerUpstreamCeiling` is a CEILING only:
 * the effective open cap is the App spec's `upstreamPullRequests.maxOpen` (default 3)
 * clamped to it — never this constant on its own (G15).
 */
export const UPSTREAM_LIMITS = {
	openedPerUpstreamPer24h: 1,
	openPerUpstreamCeiling: 10,
	openedOverallPer24h: 3,
	preparationsPer24h: 10,
	runningPreparationsPerWork: 1,
	pushesPerPrPer24h: 5,
	suggestionsPerWorkPer7d: 3,
	platformOpenedPerUpstreamPer24h: 5
} as const;
export type UpstreamLimitKey = keyof typeof UPSTREAM_LIMITS;

/**
 * The `limit` value a `429 rateLimited` names. `openPerUpstream` is the per-App-Work
 * open cap (the spec's `maxOpen`, clamped by {@link UPSTREAM_LIMITS.openPerUpstreamCeiling});
 * it opens a slot when a pull request there merges or closes, so it never carries a
 * `nextSlotAt` (spec §6.5).
 */
export const UPSTREAM_RATE_LIMIT_KEYS = [
	'openedPerUpstreamPer24h',
	'openPerUpstream',
	'openedOverallPer24h',
	'preparationsPer24h',
	'runningPreparationsPerWork',
	'pushesPerPrPer24h',
	'platformOpenedPerUpstreamPer24h'
] as const;
export type UpstreamRateLimitKey = (typeof UPSTREAM_RATE_LIMIT_KEYS)[number];

/** The App spec's `upstreamPullRequests.maxOpen` when absent, and its valid range (schema §20). */
export const UPSTREAM_MAX_OPEN_DEFAULT = 3;
export const UPSTREAM_MAX_OPEN_MIN = 1;

/** The effective open-per-upstream cap: the spec's `maxOpen`, clamped to [1, ceiling] (FR-26, G15). */
export function effectiveUpstreamMaxOpen(maxOpen: unknown): number {
	const value = typeof maxOpen === 'number' && Number.isInteger(maxOpen) ? maxOpen : UPSTREAM_MAX_OPEN_DEFAULT;
	return Math.min(Math.max(value, UPSTREAM_MAX_OPEN_MIN), UPSTREAM_LIMITS.openPerUpstreamCeiling);
}

/** The window every `…Per24h` limit counts over. */
export const UPSTREAM_LIMIT_WINDOW_MS = 24 * 3_600_000;

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
	deletionCascadeMs: 10 * 60_000
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
	maxMissingPieces: 10,
	reportMaxBytes: 32 * 1024,
	maxSeenReviewIds: 200
} as const;

export const UPSTREAM_EXCLUDED_GLOBS = [
	'.works/**',
	'.ever-works/**',
	'.github/workflows/ever-works-*',
	'**/.env*',
	'**/*.pem',
	'**/*.key'
] as const;

export const UPSTREAM_DISCLOSURE =
	'This pull request was prepared with the help of an AI agent (Ever Works) and reviewed by @{login} before it was opened.';

/**
 * How a record came to exist (an addition to plan §3.1, recorded in the APW-09 lane log):
 * `proposal` is the prepare → approve → open flow; `direct` is the member's own
 * `POST /api/works/:id/upstream-pr`, which opens a draft from an existing fork branch
 * with no preparation step and no approval of its own (the member is the one acting).
 */
export const UPSTREAM_PULL_REQUEST_ORIGINS = ['proposal', 'direct'] as const;
export type UpstreamPullRequestOrigin = (typeof UPSTREAM_PULL_REQUEST_ORIGINS)[number];

/** The Activity family (R-2) and its dotted events (CONTRACTS §6, plan §3.4). Append-only. */
export const UPSTREAM_PR_ACTIVITY_ACTION_TYPE = 'app_upstream_pr' as const;
export const UPSTREAM_PR_ACTIVITY_EVENTS = [
	'app.upstream_pr.proposed',
	'app.upstream_pr.approved',
	'app.upstream_pr.opened',
	'app.upstream_pr.updated',
	'app.upstream_pr.changes_requested',
	'app.upstream_pr.needs_signature',
	'app.upstream_pr.refused',
	'app.upstream_pr.withdrawn',
	'app.upstream_pr.merged',
	'app.upstream_pr.closed',
	'app.upstream_pr.suggested',
	'app.upstream_pr.expired',
	'app.upstream_pr.failed'
] as const;
export type UpstreamPrActivityEvent = (typeof UPSTREAM_PR_ACTIVITY_EVENTS)[number];

/** The preparation run's report (FR-47), validated before anything is inferred from it. */
export interface UpstreamPreparationReport {
	status: 'ready' | 'aiNotAccepted' | 'dcoRequired' | 'doesNotPort' | 'tooLarge' | 'needsSignature';
	claUrl?: string;
	projectLimitLines?: number;
	title?: string;
	body?: string;
	aiPolicyQuote?: string;
	aiPolicyFile?: string;
	doesNotPort?: string[];
	checks: {
		command: string;
		exitCode: number;
		startedAt: string;
		endedAt: string;
		alreadyRedOnBase?: boolean;
		lastLines?: string[];
	}[];
}

/** `GET /api/works/:id/upstream-pull-requests/eligibility` (plan §3.3, §5). */
export interface UpstreamEligibilityView {
	allowed: boolean;
	code?: UpstreamRefusalCode;
	/** FR-27: which limit refused, when `code === 'rateLimited' | 'platformCapReached'`. */
	limit?: UpstreamRateLimitKey;
	/** ISO; absent for `openPerUpstream`. */
	nextSlotAt?: string;
	/** The limit's numeric value, for the `{count}` placeholder of the copy (spec §6.5). */
	limitValue?: number;
	target: { owner: string; repo: string; baseBranch: string; forkOwner: string; forkRepo: string } | null;
	orgFork: boolean;
	maintainerCanModifyDefault: boolean;
	/** The App Work's repository relation (`fork` · `private-copy` · `link`), so the web can hide or explain. */
	relation: string | null;
	/** `true` while only the read half of APW-09 has shipped: nothing can be prepared yet. */
	preparationAvailable: boolean;
}

/** One row of `GET /api/works/:id/upstream-pull-requests` (plan §3.3). */
export interface UpstreamPullRequestView {
	id: string;
	sourceTaskId: string | null;
	/** The author: whose GitHub account the pull request carries (G11). */
	userId: string;
	origin: UpstreamPullRequestOrigin;
	state: UpstreamPullRequestState;
	upstream: { owner: string; repo: string; baseBranch: string };
	head: { owner: string; repo: string; branch: string; sha: string | null };
	number: number | null;
	url: string | null;
	draft: boolean;
	title: string | null;
	body: string | null;
	disclosureText: string | null;
	maintainerCanModify: boolean;
	checksSummary: UpstreamChecksSummary | null;
	reviewSummary: UpstreamReviewSummary | null;
	signatureState: UpstreamSignatureState | null;
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

/** The diff the approval shows — a structural subset of the plugin SDK's `GitDiffResult`. */
export interface UpstreamPullRequestDiffView {
	files: {
		filename: string;
		status?: string;
		additions?: number;
		deletions?: number;
		patch?: string;
		previousFilename?: string;
	}[];
	truncated?: boolean;
	totalCommits?: number;
}

export interface UpstreamPullRequestDetailView extends UpstreamPullRequestView {
	diff: UpstreamPullRequestDiffView | null;
	checkResults: UpstreamPreparationReport['checks'] | null;
	missingPieces: string[] | null;
	claUrl: string | null;
}

/** `GET /api/works/:id/upstream-pull-requests` — the list envelope (plan §5). */
export interface UpstreamPullRequestListResponse {
	data: UpstreamPullRequestView[];
	meta: { total: number };
}

/** The list route's page size: default and ceiling (plan §5). */
export const UPSTREAM_LIST_DEFAULT_LIMIT = 20;
export const UPSTREAM_LIST_MAX_LIMIT = 100;

/** The i18n leaf every refusal code renders under (`dashboard.workDetail.upstream.refusals.<code>`). */
export const UPSTREAM_REFUSAL_MESSAGE_KEY_PREFIX = 'dashboard.workDetail.upstream.refusals' as const;
