/**
 * App Works — the Upstream model: fork readiness, Actions hygiene, upstream
 * sync, divergence, and the closed reason-code sets the Upstream card, a test
 * id and a translation key are all derived from.
 *
 * Owning epic: **APW-02** (Fork lifecycle — readiness, Actions hygiene, upstream
 * sync, divergence, checkout keys).
 *
 * Spec: `docs/specs/features/app-works/APW-02-fork-lifecycle/spec.md`
 * Plan: `docs/specs/features/app-works/APW-02-fork-lifecycle/plan.md` §3.4
 * Tasks: `APW-02-fork-lifecycle/tasks.md` T50 (the three closed sets)
 * Bindings: `CONTRACTS.md` §0 (R-8, R-14, R-21), §2, §4 (job table).
 *
 * FR-65 is the reason this file exists: readiness reasons, sync results and
 * warning codes must each be a **closed set with one stable value per
 * user-visible state**, and a provider-specific failure must be reported through
 * the typed provider reason rather than a composed `handler_failed:<code>`
 * string.
 */

import type { AppRepositoryMode } from './app-source.js';

// ---------------------------------------------------------------------------
// Closed sets (APW-02 FR-65, plan.md:353-372, tasks.md:734-745)
// ---------------------------------------------------------------------------

/**
 * The five readiness states (plan.md:353, data-model.md:105, spec.md:455-460).
 *
 * `waiting_for_setup_pr` is a normal resting state, not a failure: a linked
 * repository and an adopted fork always pass through it (R-4).
 */
export const APP_READINESS_STATES = ['preparing', 'ready', 'timed_out', 'failed', 'waiting_for_setup_pr'] as const;

/** Union derived from {@link APP_READINESS_STATES}. */
export type AppReadinessState = (typeof APP_READINESS_STATES)[number];

/**
 * The eight coarse outcomes a sync run can end in (plan.md:354-363), reported as
 * `sync.lastResult`.
 *
 * Kept alongside {@link APP_SYNC_REASONS} rather than replaced by it: the plan
 * fixes this set, T50 adds a finer one, and nothing is ever removed (R-26).
 */
export const APP_SYNC_RESULTS = [
	'up_to_date',
	'fast_forwarded',
	'pull_request_opened',
	'pull_request_updated',
	'conflict',
	'skipped',
	'paused',
	'failed'
] as const;

/** Union derived from {@link APP_SYNC_RESULTS}. */
export type AppSyncResult = (typeof APP_SYNC_RESULTS)[number];

/**
 * The fifteen fine-grained sync reasons (tasks.md:739-742), reported as
 * `sync.lastReason` and written by the sync service — never a composed string.
 */
export const APP_SYNC_REASONS = [
	'up_to_date',
	'fast_forwarded',
	'pull_request_opened',
	'pull_request_updated',
	'pull_request_merged',
	'pull_request_closed',
	'conflict',
	'held_for_workflow_review',
	'skipped_rate_limited',
	'skipped_budget',
	'license_worse',
	'disabled_by_spec',
	'paused',
	'provider_unsupported',
	'failed'
] as const;

/** Union derived from {@link APP_SYNC_REASONS}. */
export type AppSyncReason = (typeof APP_SYNC_REASONS)[number];

/**
 * The ten readiness failure reasons (tasks.md:737-738) — one member per
 * user-visible state, written by the readiness handler and surfaced as
 * `readiness.reason`.
 *
 * `setup_pull_request_closed` (spec.md:309) and `access_revoked` (spec.md:295)
 * are the two the spec names directly; a provider failure is reported through
 * {@link AppReadinessHandlerReason}, never through a composed member.
 */
export const APP_READINESS_FAILURE_REASONS = [
	'access_revoked',
	'dispatch_unavailable',
	'copy_refused',
	'too_large',
	'provider_unsupported',
	'timed_out',
	'setup_pull_request_closed',
	'handler_failed',
	'blueprint_apply_failed',
	'data_repository_missing'
] as const;

/** Union derived from {@link APP_READINESS_FAILURE_REASONS}. */
export type AppReadinessFailureReason = (typeof APP_READINESS_FAILURE_REASONS)[number];

/**
 * The warning codes of spec §6.2, camelCased (spec.md:519-534, tasks.md:742-743).
 *
 * One member per table row, in table order. The task text says "the ten spec
 * §6.2 rows" while the table has twelve; the table is the source and dropping
 * the two extra rows would be a removal (R-26), so all twelve are here.
 */
export const APP_UPSTREAM_WARNING_CODES = [
	'upstreamArchived',
	'upstreamUnavailable',
	'forkMissing',
	'privateCopyMissing',
	'rateLimited',
	'defaultBranchRenamed',
	'privateCopyTooLarge',
	'historyRewritten',
	'needsAdmin',
	'appPermissionMissing',
	'notReady',
	'workflowsGated'
] as const;

/** Union derived from {@link APP_UPSTREAM_WARNING_CODES}. */
export type AppUpstreamWarningCode = (typeof APP_UPSTREAM_WARNING_CODES)[number];

/**
 * The upstream's own health (plan.md:364), derived from a provider read and
 * cached in the Upstream state row.
 */
export const APP_UPSTREAM_STATUSES = ['available', 'archived', 'unavailable', 'none', 'unknown'] as const;

/** Union derived from {@link APP_UPSTREAM_STATUSES}. */
export type AppUpstreamStatus = (typeof APP_UPSTREAM_STATUSES)[number];

/**
 * The Actions hygiene outcome (plan.md:365-372).
 *
 * `needs_admin` and `permission_missing` are named states that must NOT block
 * readiness or sync (FR-30); `not_applicable` is a linked repository, which
 * hygiene never touches (FR-31).
 */
export const APP_ACTIONS_STATES = [
	'pending',
	'clean',
	'needs_admin',
	'permission_missing',
	'failed',
	'not_applicable'
] as const;

/** Union derived from {@link APP_ACTIONS_STATES}. */
export type AppActionsState = (typeof APP_ACTIONS_STATES)[number];

/** Why a readiness job was dispatched (plan.md:433). */
export const APP_FORK_READINESS_REASONS = ['initial', 'retry', 'redispatch', 'setup_merged'] as const;

/** Union derived from {@link APP_FORK_READINESS_REASONS}. */
export type AppForkReadinessReason = (typeof APP_FORK_READINESS_REASONS)[number];

/** The Work Repository as the Upstream card reports it (plan.md:376-382). */
export interface AppUpstreamWorkRepositoryView {
	owner: string;
	repo: string;
	url: string;
	defaultBranch: string;
	/** `missing` is the FR-42 state: every background job stops and says so. */
	status: 'available' | 'missing';
}

/** The upstream as the Upstream card reports it (plan.md:383-390). */
export interface AppUpstreamView {
	owner: string;
	repo: string;
	url: string;
	defaultBranch: string;
	/** Set when upstream renamed its default branch and sync followed it (FR-43). */
	previousDefaultBranch?: string;
	status: AppUpstreamStatus;
}

/**
 * The readiness block of the Upstream response (plan.md:391-399 + tasks.md:743).
 *
 * `manualRetriesLeft` counts FR-19's 3-per-hour **Try again** allowance;
 * `handlerReason` carries the typed provider refusal (reason and the single
 * permission it needs, FR-54) instead of a composed string.
 */
export interface AppUpstreamReadinessView {
	state: AppReadinessState;
	reason?: AppReadinessFailureReason;
	handlerReason?: AppReadinessHandlerReason;
	startedAt: string;
	readyAt?: string;
	setupPullRequestUrl?: string;
	setupPullRequestNumber?: number;
	manualRetriesLeft: number;
}

/**
 * A typed provider refusal (tasks.md:743-745, FR-54).
 *
 * `code` is the provider's own reason, not a closed App Works set: the platform
 * layer already owns that union, and restating it here would give it two
 * definitions.
 */
export interface AppReadinessHandlerReason {
	code: string;
	permission?: string;
}

/** Commits ahead of and behind upstream, with when they were read (plan.md:400, FR-46/FR-47). */
export interface AppUpstreamDivergenceView {
	aheadBy: number;
	behindBy: number;
	computedAt: string;
	stale: boolean;
}

/** The sync block of the Upstream response (plan.md:401-415). */
export interface AppUpstreamSyncView {
	/** The App spec's five-field cron, or `null` when none is configured. */
	schedule: string | null;
	nextRunAt?: string;
	running: boolean;
	lastResult?: AppSyncResult;
	lastReason?: AppSyncReason;
	lastStartedAt?: string;
	lastFinishedAt?: string;
	lastCommitCount?: number;
	pullRequest?: { number: number; url: string };
	/** The one open conflict Task, reused rather than duplicated (FR-38). */
	conflictTaskId?: string;
	manualSyncsLeft: number;
	rateLimitedUntil?: string;
	rateLimitedPersistent: boolean;
}

/** The Actions hygiene block of the Upstream response (plan.md:416-421). */
export interface AppUpstreamActionsView {
	state: AppActionsState;
	disabled: Array<{ path: string }>;
	kept: Array<{ path: string }>;
	checkedAt?: string;
}

/** One warning, with its code and the parameters its copy interpolates (FR-65). */
export interface AppUpstreamWarning {
	code: AppUpstreamWarningCode;
	params?: Record<string, string>;
}

/**
 * `GET /api/works/:id/upstream` (plan.md:373-423, resolution R-8).
 *
 * `relation` reuses APW-01's mode union rather than restating the same three
 * values. `upstream` and `sync` are `null` for a linked App Work, which has no
 * upstream at all (FR-44).
 */
export interface AppUpstreamStateResponse {
	workId: string;
	relation: AppRepositoryMode;
	dataRepository: AppUpstreamWorkRepositoryView;
	upstream: AppUpstreamView | null;
	readiness: AppUpstreamReadinessView;
	divergence: AppUpstreamDivergenceView | null;
	sync: AppUpstreamSyncView | null;
	actions: AppUpstreamActionsView | null;
	warnings: AppUpstreamWarning[];
}

// ---------------------------------------------------------------------------
// Readiness limits (APW-02 FR-18 … FR-24a, plan.md:424-435)
// ---------------------------------------------------------------------------

/** The probe schedule after the request: 2, 4, 8 and 15 seconds (FR-18, spec.md:288). */
export const APP_FORK_READINESS_POLL_DELAYS_MS = [2_000, 4_000, 8_000, 15_000] as const;

/** Then every 15 seconds until the deadline (FR-18, spec.md:288-289). */
export const APP_FORK_READINESS_POLL_INTERVAL_MS = 15_000;

/** At most 15 minutes of checking, then **timed out** with one Activity entry (FR-18, spec.md:289). */
export const APP_FORK_READINESS_TIMEOUT_MS = 900_000;

/** The p95 target for a fork becoming ready (plan.md:427). */
export const APP_FORK_READINESS_READY_LATENCY_MS = 30_000;

/** **Try again** is limited to 3 per App Work per hour (FR-19, spec.md:293-294). */
export const APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR = 3;

/** A readiness job that never reported for 10 minutes is restarted, at most 3 times (FR-23, spec.md:302-303). */
export const APP_FORK_READINESS_MAX_REDISPATCH = 3;

/** A job that was never started or stopped reporting for 10 minutes is stale (FR-23, spec.md:302). */
export const APP_FORK_READINESS_IDLE_MS = 600_000;

/**
 * The floor a non-production installation may shorten the deadline to —
 * **never** applied in production, which always uses the 15 minutes (FR-18a,
 * spec.md:290-292).
 */
export const APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS = 5_000;

/** The environment variable that carries the non-production override (FR-18a). */
export const APP_FORK_READINESS_TIMEOUT_ENV = 'EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS';

/** An open setup pull request is checked at least every 10 minutes (FR-24a, spec.md:306-307). */
export const APP_SETUP_PR_CHECK_ON_VIEW_MIN_INTERVAL_MS = 60_000;

/** …and within 60 seconds of the App Work being viewed; at most this many per tick (FR-24a, CONTRACTS.md:480). */
export const APP_SETUP_PR_CHECK_BATCH = 50;

// ---------------------------------------------------------------------------
// Sync limits (APW-02 FR-32 … FR-53, plan.md:436-457)
// ---------------------------------------------------------------------------

/** Mondays at 06:00 UTC when the App spec declares no schedule (FR-32, spec.md:329-330). */
export const APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE = '0 6 * * 1';

/** A schedule firing more often than once an hour is treated as hourly (FR-32, spec.md:329-330). */
export const APP_UPSTREAM_SYNC_MIN_INTERVAL_MS = 3_600_000;

/** Each App Work's run is delayed by a stable 0–300 seconds (FR-32, spec.md:330-331). */
export const APP_UPSTREAM_SYNC_JITTER_MAX_MS = 300_000;

/** **Sync now** is limited to 6 per App Work per hour (FR-33, spec.md:332-333). */
export const APP_UPSTREAM_SYNC_MANUAL_PER_HOUR = 6;

/** **Sync now** answers within 2 seconds without waiting (FR-33, spec.md:332). */
export const APP_UPSTREAM_SYNC_ACK_BUDGET_MS = 2_000;

/** At most one sync runs per App Work at a time — the lock TTL (FR-34, spec.md:334). */
export const APP_UPSTREAM_SYNC_LOCK_TTL_MS = 1_800_000;

/** The dispatcher tick, every 10 minutes (CONTRACTS.md:480). */
export const APP_UPSTREAM_SYNC_DISPATCH_CRON = '*/10 * * * *';

/** At most 50 syncs per 10-minute tick (FR-53, spec.md:379). */
export const APP_UPSTREAM_SYNC_DISPATCH_BATCH = 50;

/** One sync makes at most 20 provider calls (FR-49, spec.md:373). */
export const APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS = 20;

/** The branch a sync pull request comes from (FR-36, spec.md:340-342). */
export const APP_UPSTREAM_SYNC_BRANCH = 'ever-works/upstream-sync';

/** The conflict Task's label prefix, one open Task per App Work (FR-38, spec.md:345-346). */
export const APP_UPSTREAM_CONFLICT_LABEL_PREFIX = 'app-upstream-conflict:';

/** Up to 50 conflicting paths are listed in the conflict Task (FR-38, spec.md:346). */
export const APP_UPSTREAM_CONFLICT_MAX_PATHS = 50;

/** Hygiene is capped at 100 workflows per run, and records at most 100 kept and 100 disabled (FR-28/FR-29). */
export const APP_ACTIONS_HYGIENE_MAX_WORKFLOWS = 100;

/** Fewer than 300 requests left in the member's budget skips the run until the reset plus 60 s (FR-50, spec.md:374-375). */
export const APP_RATE_LIMIT_MIN_REMAINING = 300;

/** The grace period added to the provider's reset time (FR-50, spec.md:374-375). */
export const APP_RATE_LIMIT_RESET_GRACE_MS = 60_000;

/** Secondary rate limits back off starting at 60 seconds (FR-51, spec.md:376-377). */
export const APP_RATE_LIMIT_BACKOFF_BASE_MS = 60_000;

/** …doubling to at most 60 minutes (FR-51, spec.md:377). */
export const APP_RATE_LIMIT_BACKOFF_MAX_MS = 3_600_000;

/** Three consecutive rate-limited runs make the notice persistent (FR-52, spec.md:378). */
export const APP_RATE_LIMITED_PERSISTENT_AFTER = 3;

/** Divergence counts are refreshed when the App Work is viewed and they are older than 10 minutes (FR-46). */
export const APP_DIVERGENCE_TTL_MS = 600_000;

/** …and at least once a day (FR-46, spec.md:364-365). */
export const APP_DIVERGENCE_DAILY_MS = 86_400_000;

/** "Upstream behind" is emitted when behind grows by 25 or more since the last emission (FR-48, spec.md:368-369). */
export const APP_BEHIND_EVENT_STEP = 25;

/** An unreadable upstream is re-checked every 24 hours (FR-41, spec.md:354-355). */
export const APP_UPSTREAM_UNAVAILABLE_RECHECK_MS = 86_400_000;

// ---------------------------------------------------------------------------
// The license gate's request reasons (APW-02 T26; CONTRACTS §2A)
// ---------------------------------------------------------------------------

/**
 * Why APW-03's license gate is asked to re-evaluate an App Work —
 * `AppLicenseService.request(workId, reason)`.
 *
 * Added by **APW-02 T26**, whose task text fixes the contract: "`AppLicenseService.request(workId,
 * reason)` gains its reason union in CONTRACTS §2A as part of this task's PR". The union did not
 * exist anywhere in this package, and it is declared here — in APW-02's own Upstream module, beside
 * the sync limits that produce two of its three members — rather than in a second file, so
 * `AppLicenseService` has exactly one reason vocabulary.
 *
 * Members, and the caller each one comes from:
 *
 * - `upstream_synced` — APW-02 §6.3 step 8 / FR-40: a sync moved the tracked branch
 *   (`APW-02/plan.md:751-752`, status service `app-upstream-state.service.ts:989`).
 * - `upstream_merged` — APW-02 FR-62 / T29: a sync pull request was merged, so the license is asked
 *   once more for the range that landed (`APW-02/tasks.md:719`).
 * - `blueprint_applied` — APW-03 §2.5 step 0: a Blueprint was applied and its `license` block may
 *   have changed the classification (`APW-03/plan.md:286`).
 *
 * APW-03 appends its own triggers (registry refresh, manual re-check, header evidence —
 * `CONTRACTS.md:487`) to this list when its job lands: the union is **append-only** (R-26), and a
 * caller that switches exhaustively over it gains a compile error rather than a silent default.
 */
export const APP_LICENSE_EVALUATION_REASONS = ['upstream_synced', 'upstream_merged', 'blueprint_applied'] as const;

/** Union derived from {@link APP_LICENSE_EVALUATION_REASONS}. */
export type AppLicenseEvaluationReason = (typeof APP_LICENSE_EVALUATION_REASONS)[number];

/**
 * Whether a manual **Sync now** may start, given how many ran in the current
 * hour — `at most 6`, so the seventh is refused (FR-33).
 *
 * Fails closed on anything that is not a non-negative count.
 */
export function appManualSyncAllowed(manualSyncsThisHour: number): boolean {
	return (
		Number.isFinite(manualSyncsThisHour) &&
		manualSyncsThisHour >= 0 &&
		manualSyncsThisHour < APP_UPSTREAM_SYNC_MANUAL_PER_HOUR
	);
}

/**
 * Whether the member's remaining provider budget lets a run start — FR-50 says
 * "fewer than 300 remaining", so exactly 300 still runs.
 *
 * Fails closed on an unknown budget.
 */
export function appRateLimitAllowsSync(remainingRequests: number): boolean {
	return Number.isFinite(remainingRequests) && remainingRequests >= APP_RATE_LIMIT_MIN_REMAINING;
}
