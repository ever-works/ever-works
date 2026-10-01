import { describe, expect, it } from 'vitest';

import { IMPORT_SOURCE_TYPES } from '../../api/work/import-source.dto.js';

import {
	APP_CREATE_IDEMPOTENCY_WINDOW_MS,
	APP_CREATE_LOCK_TTL_MS,
	APP_CREATE_RESPONSE_BUDGET_MS,
	APP_DEPLOY_TARGET_CHOICES,
	APP_INSPECT_CACHE_TTL_MS,
	APP_INSPECT_FIXED_PROVIDER_CALLS,
	APP_INSPECT_MAX_PROVIDER_CALLS,
	APP_INSPECT_OWNER_MIN_CALLS_REMAINING,
	APP_INSPECT_P95_BUDGET_MS,
	APP_INSPECT_RATE_LIMIT_PER_MINUTE,
	APP_PRIVATE_COPY_MAX_SIZE_KB,
	APP_PRIVATE_COPY_NAME_ATTEMPTS,
	APP_REPOSITORY_MODES,
	APP_REPOSITORY_URL_MAX_LENGTH,
	APP_SOURCE_BLUEPRINT_MATCH_SOURCES,
	APP_SOURCE_BLUEPRINT_STATUSES,
	APP_SOURCE_LICENSE_CLASSES,
	APP_SOURCE_LICENSE_SOURCES,
	APP_SOURCE_REASON_CODES,
	APP_SOURCE_REPOSITORY_NAME_SUFFIXES,
	APP_SOURCE_REPOSITORY_TYPE_BY_MODE,
	APP_SOURCE_REPOSITORY_TYPES,
	APP_SOURCE_SPEC_FILE,
	APP_SOURCE_SPEC_KIND,
	APP_SOURCE_SPEC_VERSION,
	APP_TARGET_OWNER_SCAN_LIMIT_P1,
	APP_TARGET_OWNER_SCAN_LIMIT_P2,
	APP_WORK_REPOSITORY_ROLE,
	appRepositoryUrlLengthExceeded,
	canStartTargetOwnerScan,
	isAppSourceReasonCode,
	resolveAppRepositoryModes,
	type AppRepositoryModeFacts,
	type AppSourceReasonCode
} from '../app-source.js';

import {
	APP_ACTIONS_HYGIENE_MAX_WORKFLOWS,
	APP_ACTIONS_STATES,
	APP_BEHIND_EVENT_STEP,
	APP_DIVERGENCE_DAILY_MS,
	APP_DIVERGENCE_TTL_MS,
	APP_FORK_READINESS_IDLE_MS,
	APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR,
	APP_FORK_READINESS_MAX_REDISPATCH,
	APP_FORK_READINESS_POLL_DELAYS_MS,
	APP_FORK_READINESS_POLL_INTERVAL_MS,
	APP_FORK_READINESS_READY_LATENCY_MS,
	APP_FORK_READINESS_REASONS,
	APP_FORK_READINESS_TIMEOUT_ENV,
	APP_FORK_READINESS_TIMEOUT_MS,
	APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS,
	APP_RATE_LIMIT_BACKOFF_BASE_MS,
	APP_RATE_LIMIT_BACKOFF_MAX_MS,
	APP_RATE_LIMIT_MIN_REMAINING,
	APP_RATE_LIMIT_RESET_GRACE_MS,
	APP_RATE_LIMITED_PERSISTENT_AFTER,
	APP_READINESS_FAILURE_REASONS,
	APP_READINESS_STATES,
	APP_SETUP_PR_CHECK_BATCH,
	APP_SETUP_PR_CHECK_ON_VIEW_MIN_INTERVAL_MS,
	APP_SYNC_REASONS,
	APP_SYNC_RESULTS,
	APP_UPSTREAM_CONFLICT_LABEL_PREFIX,
	APP_UPSTREAM_CONFLICT_MAX_PATHS,
	APP_UPSTREAM_STATUSES,
	APP_UPSTREAM_SYNC_ACK_BUDGET_MS,
	APP_UPSTREAM_SYNC_BRANCH,
	APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE,
	APP_UPSTREAM_SYNC_DISPATCH_BATCH,
	APP_UPSTREAM_SYNC_DISPATCH_CRON,
	APP_UPSTREAM_SYNC_JITTER_MAX_MS,
	APP_UPSTREAM_SYNC_LOCK_TTL_MS,
	APP_UPSTREAM_SYNC_MANUAL_PER_HOUR,
	APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS,
	APP_UPSTREAM_SYNC_MIN_INTERVAL_MS,
	APP_UPSTREAM_UNAVAILABLE_RECHECK_MS,
	APP_UPSTREAM_WARNING_CODES,
	appManualSyncAllowed,
	appRateLimitAllowsSync
} from '../app-upstream.js';

import {
	APP_REPOSITORY_STAGES,
	APP_REPOSITORY_STAGE_LIMITS,
	APP_REPOSITORY_STAGE_REFUSAL_CODES,
	APP_REPOSITORY_STAGES_WITHOUT_SPEC_LIMIT,
	APP_WORK_QUOTA_CAPS,
	appWorkQuotaAllows,
	firstRefusingRepositoryStage
} from '../apps-limits.js';

import {
	EVER_ID_DEFAULT_API_AUDIENCE,
	EVER_ID_DEFAULT_DISPLAY_NAME,
	EVER_ID_DELEGATED_AUTH_METHOD,
	EVER_ID_DELEGATED_SCOPES,
	EVER_ID_ERROR_CODE_WIRE_VALUES,
	EVER_ID_LIMITS,
	EVER_ID_LINKED_VIA,
	EVER_ID_QUERY_TOKEN_PARAMS,
	EVER_ID_REGISTRATION_PROVIDER,
	EVER_ID_SCOPES,
	EVER_ID_SIGNING_ALGS,
	EVER_ID_WIRE_ERROR_CODES,
	isEverIdAllowedIssuerCountAllowed,
	isEverIdClockSkewAllowed,
	type EverIdErrorCode
} from '../ever-id.js';

/**
 * Behavioural contract for the four App Works shared modules this file owns:
 * `app-source.ts` (APW-01 + APW-03), `apps-limits.ts` (CONTRACTS §2A),
 * `app-upstream.ts` (APW-02) and `ever-id.ts` (APW-12).
 *
 * These specs assert the CONTRACT, not the shapes: every closed union is pinned
 * member-for-member against the spec that fixes it, every number is pinned
 * against its spec line, and every pure helper is exercised at its boundary —
 * including the fail-closed side, because "we could not measure it" must never
 * read as "it is fine".
 */

/** Compile-time equality, so a widened or narrowed union fails to type-check. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `Equal<…>` to be `true` at compile time. */
type Expect<T extends true> = T;

/**
 * Restates the spec's reason-code list so the array and the derived union are
 * pinned to the SPEC rather than to each other.
 */
type SpecAppSourceReasonCodes =
	| 'invalid_url'
	| 'provider_not_connected'
	| 'insufficient_scope'
	| 'not_found'
	| 'sso_authorization_required'
	| 'oauth_app_restricted'
	| 'empty_repository'
	| 'no_push_access'
	| 'archived'
	| 'forking_disabled'
	| 'own_repository'
	| 'target_owner_unavailable'
	| 'target_owner_forbidden'
	| 'too_large_for_private_copy'
	| 'uses_lfs'
	| 'copy_name_unavailable'
	| 'in_use_by_another_account'
	| 'app_work_exists'
	| 'create_in_progress'
	| 'rate_limited'
	| 'managed_hosting_unavailable'
	| 'cluster_target_unavailable'
	| 'app_works_disabled'
	| 'blueprint_mismatch';

type _ReasonCodesExhaustive = Expect<Equal<AppSourceReasonCode, SpecAppSourceReasonCodes>>;

/** APW-02 spec.md:737-738 — the ten readiness failure reasons, restated. */
type SpecReadinessFailureReasons =
	| 'access_revoked'
	| 'dispatch_unavailable'
	| 'copy_refused'
	| 'too_large'
	| 'provider_unsupported'
	| 'timed_out'
	| 'setup_pull_request_closed'
	| 'handler_failed'
	| 'blueprint_apply_failed'
	| 'data_repository_missing';

/** APW-02 spec.md:739-742 — the fifteen sync reasons, restated. */
type SpecSyncReasons =
	| 'up_to_date'
	| 'fast_forwarded'
	| 'pull_request_opened'
	| 'pull_request_updated'
	| 'pull_request_merged'
	| 'pull_request_closed'
	| 'conflict'
	| 'held_for_workflow_review'
	| 'skipped_rate_limited'
	| 'skipped_budget'
	| 'license_worse'
	| 'disabled_by_spec'
	| 'paused'
	| 'provider_unsupported'
	| 'failed';

/** APW-02 spec.md:521-534 — the twelve warning rows of §6.2, restated. */
type SpecUpstreamWarningCodes =
	| 'upstreamArchived'
	| 'upstreamUnavailable'
	| 'forkMissing'
	| 'privateCopyMissing'
	| 'rateLimited'
	| 'defaultBranchRenamed'
	| 'privateCopyTooLarge'
	| 'historyRewritten'
	| 'needsAdmin'
	| 'appPermissionMissing'
	| 'notReady'
	| 'workflowsGated';

/** Asserts a closed set is exactly the spec's list and carries no duplicates. */
function assertClosedUnion(members: readonly string[], specList: readonly string[]): void {
	expect(members).toEqual(specList);
	expect(new Set(members).size).toBe(members.length);
}

/** Asserts a guard admits every member of its own union (a fixture of each). */
function everyMemberIsAccepted<T extends string>(members: readonly T[], guard: (value: unknown) => value is T): void {
	for (const member of members) {
		expect(guard(member)).toBe(true);
	}
}

/** The facts a repository presents before any mode is offered. */
function facts(overrides: Partial<AppRepositoryModeFacts> = {}): AppRepositoryModeFacts {
	return {
		canPush: true,
		archived: false,
		empty: false,
		allowForking: true,
		usesLfs: false,
		sizeKb: 1_024,
		visibility: 'public',
		isFork: false,
		isOwnRepository: false,
		isInUseByAnotherAccount: false,
		...overrides
	};
}

describe('APP_SOURCE_REPOSITORY_TYPES (CONTRACTS.md:266, APW-01 plan.md:293)', () => {
	it('pins the three persisted source types', () => {
		assertClosedUnion(APP_SOURCE_REPOSITORY_TYPES, ['app_link', 'app_fork', 'app_private_copy']);
	});

	it('maps every repository mode onto exactly one persisted source type', () => {
		expect(Object.keys(APP_SOURCE_REPOSITORY_TYPE_BY_MODE)).toEqual([...APP_REPOSITORY_MODES]);
		expect(Object.values(APP_SOURCE_REPOSITORY_TYPE_BY_MODE)).toEqual([...APP_SOURCE_REPOSITORY_TYPES]);
		expect(new Set(Object.values(APP_SOURCE_REPOSITORY_TYPE_BY_MODE)).size).toBe(APP_REPOSITORY_MODES.length);
	});

	it('does not widen IMPORT_SOURCE_TYPES — it still has exactly four members (CONTRACTS.md:267, APW-01 tasks.md:97)', () => {
		expect(IMPORT_SOURCE_TYPES).toEqual(['data_repo', 'awesome_readme', 'link_existing', 'works_config']);
		expect(IMPORT_SOURCE_TYPES).toHaveLength(4);
	});
});

describe('APP_DEPLOY_TARGET_CHOICES (APW-01 spec.md:404-408, resolution R-12 CONTRACTS.md:55)', () => {
	it('pins the three deploy targets in R-12 order', () => {
		assertClosedUnion(APP_DEPLOY_TARGET_CHOICES, ['none', 'your-cluster', 'ever-works-apps']);
	});

	it('is the only definition of the three values (CONTRACTS.md:335)', () => {
		expect(APP_DEPLOY_TARGET_CHOICES).toHaveLength(3);
	});
});

describe('APP_SOURCE_REASON_CODES (APW-01 spec.md:606-633)', () => {
	it('pins the 24 unavailable/create reason codes in spec order', () => {
		assertClosedUnion(APP_SOURCE_REASON_CODES, [
			'invalid_url',
			'provider_not_connected',
			'insufficient_scope',
			'not_found',
			'sso_authorization_required',
			'oauth_app_restricted',
			'empty_repository',
			'no_push_access',
			'archived',
			'forking_disabled',
			'own_repository',
			'target_owner_unavailable',
			'target_owner_forbidden',
			'too_large_for_private_copy',
			'uses_lfs',
			'copy_name_unavailable',
			'in_use_by_another_account',
			'app_work_exists',
			'create_in_progress',
			'rate_limited',
			'managed_hosting_unavailable',
			'cluster_target_unavailable',
			'app_works_disabled',
			'blueprint_mismatch'
		]);
		expect(APP_SOURCE_REASON_CODES).toHaveLength(24);
	});

	it('the guard accepts a fixture of every member', () => {
		everyMemberIsAccepted(APP_SOURCE_REASON_CODES, isAppSourceReasonCode);
	});

	it('the guard fails closed on anything that is not a member', () => {
		expect(isAppSourceReasonCode('invalid-url')).toBe(false);
		expect(isAppSourceReasonCode('INVALID_URL')).toBe(false);
		expect(isAppSourceReasonCode('invalid_url ')).toBe(false);
		expect(isAppSourceReasonCode('')).toBe(false);
		expect(isAppSourceReasonCode(undefined)).toBe(false);
		expect(isAppSourceReasonCode(null)).toBe(false);
		expect(isAppSourceReasonCode(42)).toBe(false);
		expect(isAppSourceReasonCode({ code: 'archived' })).toBe(false);
	});
});

describe('inspect numeric limits (APW-01 spec.md:290-303)', () => {
	it('APP_INSPECT_MAX_PROVIDER_CALLS is 15 (APW-01 spec.md:290)', () => {
		expect(APP_INSPECT_MAX_PROVIDER_CALLS).toBe(15);
	});

	it('APP_INSPECT_FIXED_PROVIDER_CALLS is 5 (APW-01 spec.md:302, plan.md:190)', () => {
		expect(APP_INSPECT_FIXED_PROVIDER_CALLS).toBe(5);
	});

	it('leaves the fork scan room inside the 15-call budget (APW-01 plan.md:187-191)', () => {
		expect(APP_INSPECT_FIXED_PROVIDER_CALLS + APP_INSPECT_OWNER_MIN_CALLS_REMAINING).toBeLessThanOrEqual(
			APP_INSPECT_MAX_PROVIDER_CALLS
		);
	});

	it('APP_INSPECT_P95_BUDGET_MS is 8_000 (APW-01 spec.md:291)', () => {
		expect(APP_INSPECT_P95_BUDGET_MS).toBe(8_000);
	});

	it('APP_INSPECT_CACHE_TTL_MS is 60_000 (APW-01 spec.md:291)', () => {
		expect(APP_INSPECT_CACHE_TTL_MS).toBe(60_000);
	});

	it('APP_INSPECT_RATE_LIMIT_PER_MINUTE is 30 (APW-01 spec.md:292, contracts/openapi/apw-01.openapi.yaml:38)', () => {
		expect(APP_INSPECT_RATE_LIMIT_PER_MINUTE).toBe(30);
	});

	it('APP_TARGET_OWNER_SCAN_LIMIT_P1 is 30 and from openapi x-throttle: 30 requests / 60 s per client (APW-01 spec.md:300)', () => {
		expect(APP_TARGET_OWNER_SCAN_LIMIT_P1).toBe(30);
	});

	it('APP_TARGET_OWNER_SCAN_LIMIT_P2 is 200 and never below P1 (APW-01 spec.md:300)', () => {
		expect(APP_TARGET_OWNER_SCAN_LIMIT_P2).toBe(200);
		expect(APP_TARGET_OWNER_SCAN_LIMIT_P2).toBeGreaterThan(APP_TARGET_OWNER_SCAN_LIMIT_P1);
	});

	it('APP_INSPECT_OWNER_MIN_CALLS_REMAINING is 3 (APW-01 spec.md:303, plan.md:191)', () => {
		expect(APP_INSPECT_OWNER_MIN_CALLS_REMAINING).toBe(3);
	});

	it('canStartTargetOwnerScan: a new owner starts at exactly 3 calls remaining and not at 2 (APW-01 spec.md:303)', () => {
		expect(canStartTargetOwnerScan(APP_INSPECT_OWNER_MIN_CALLS_REMAINING)).toBe(true);
		expect(canStartTargetOwnerScan(APP_INSPECT_OWNER_MIN_CALLS_REMAINING + 1)).toBe(true);
		expect(canStartTargetOwnerScan(APP_INSPECT_OWNER_MIN_CALLS_REMAINING - 1)).toBe(false);
		expect(canStartTargetOwnerScan(0)).toBe(false);
	});
});

describe('APP_REPOSITORY_URL_MAX_LENGTH (APW-01 spec.md:289, contracts/openapi/apw-01.openapi.yaml:201)', () => {
	it('is 400', () => {
		expect(APP_REPOSITORY_URL_MAX_LENGTH).toBe(400);
	});

	it('boundary: 400 characters is allowed, 401 is not', () => {
		expect(appRepositoryUrlLengthExceeded('x'.repeat(APP_REPOSITORY_URL_MAX_LENGTH))).toBe(false);
		expect(appRepositoryUrlLengthExceeded('x'.repeat(APP_REPOSITORY_URL_MAX_LENGTH + 1))).toBe(true);
	});

	it('fails closed on a non-string body', () => {
		expect(appRepositoryUrlLengthExceeded(undefined as unknown as string)).toBe(true);
		expect(appRepositoryUrlLengthExceeded(null as unknown as string)).toBe(true);
	});
});

describe('create limits (APW-01 spec.md:337-358)', () => {
	it('APP_PRIVATE_COPY_MAX_SIZE_KB is 512_000 = the 500 MB of FR-20 (APW-01 spec.md:337, plan.md:412)', () => {
		expect(APP_PRIVATE_COPY_MAX_SIZE_KB).toBe(512_000);
	});

	it('APP_PRIVATE_COPY_NAME_ATTEMPTS is 5 — the copy, then -copy-2 … -copy-5 (APW-01 spec.md:340, plan.md:413)', () => {
		expect(APP_PRIVATE_COPY_NAME_ATTEMPTS).toBe(5);
	});

	it('APP_CREATE_LOCK_TTL_MS is 120_000 (APW-01 spec.md:356)', () => {
		expect(APP_CREATE_LOCK_TTL_MS).toBe(120_000);
	});

	it('APP_CREATE_IDEMPOTENCY_WINDOW_MS is 600_000 = the 10-minute window (APW-01 spec.md:358, openapi:99-102)', () => {
		expect(APP_CREATE_IDEMPOTENCY_WINDOW_MS).toBe(600_000);
	});

	it('APP_CREATE_RESPONSE_BUDGET_MS is 10_000 (APW-01 spec.md:350)', () => {
		expect(APP_CREATE_RESPONSE_BUDGET_MS).toBe(10_000);
	});
});

describe('Work Repository naming and source spec (APW-01 spec.md:341-349, 374-375)', () => {
	it('APP_WORK_REPOSITORY_ROLE is the persisted website role, never data (APW-01 spec.md:271-274, CONTRACTS.md:254-261)', () => {
		expect(APP_WORK_REPOSITORY_ROLE).toBe('website');
	});

	it('pins the two name suffixes and keeps -website the default (APW-01 spec.md:341-347)', () => {
		expect(APP_SOURCE_REPOSITORY_NAME_SUFFIXES).toEqual({ app: '-app', default: '-website' });
	});

	it('APP_SOURCE_SPEC_FILE/VERSION/KIND are .works/works.yml, 2, app (APW-01 spec.md:374-375, CONTRACTS.md:99-100)', () => {
		expect(APP_SOURCE_SPEC_FILE).toBe('.works/works.yml');
		expect(APP_SOURCE_SPEC_VERSION).toBe(2);
		expect(APP_SOURCE_SPEC_KIND).toBe('app');
	});
});

describe('resolveAppRepositoryModes — link (APW-01 spec.md:328-329, FR-17)', () => {
	it('offers Link, and defaults to it, when the member can push to a non-fork', () => {
		const { modes, defaultMode } = resolveAppRepositoryModes(facts());
		expect(modes.link).toEqual({ available: true });
		expect(defaultMode).toBe('link');
	});

	it('refuses Link with no_push_access when the member cannot push', () => {
		const { modes, defaultMode } = resolveAppRepositoryModes(facts({ canPush: false }));
		expect(modes.link).toEqual({ available: false, reason: 'no_push_access' });
		expect(defaultMode).toBe('fork');
	});

	it('refuses Link with archived before anything else (APW-01 spec.md:329)', () => {
		const { modes } = resolveAppRepositoryModes(facts({ archived: true }));
		expect(modes.link).toEqual({ available: false, reason: 'archived' });
	});

	it('refuses Link with in_use_by_another_account (APW-01 spec.md:364-366, FR-26)', () => {
		const { modes } = resolveAppRepositoryModes(facts({ isInUseByAnotherAccount: true }));
		expect(modes.link).toEqual({ available: false, reason: 'in_use_by_another_account' });
	});

	it('defaults to Fork when the pasted repository is itself a fork the member can push to (APW-01 spec.md:332-334)', () => {
		const { modes, defaultMode } = resolveAppRepositoryModes(facts({ isFork: true }));
		expect(modes.link).toEqual({ available: true });
		expect(modes.fork).toEqual({ available: true });
		expect(defaultMode).toBe('fork');
	});

	it('fails closed with no default when neither Link nor Fork is available', () => {
		const { modes, defaultMode } = resolveAppRepositoryModes(facts({ archived: true, allowForking: false }));
		expect(modes.link.available).toBe(false);
		expect(modes.fork.available).toBe(false);
		expect(defaultMode).toBeNull();
	});
});

describe('resolveAppRepositoryModes — fork (APW-01 spec.md:331-334, FR-18)', () => {
	it('offers Fork when forking is allowed, the repository is not empty and is not the member’s own', () => {
		const { modes } = resolveAppRepositoryModes(facts());
		expect(modes.fork).toEqual({ available: true });
	});

	it('refuses Fork with forking_disabled', () => {
		const { modes } = resolveAppRepositoryModes(facts({ allowForking: false }));
		expect(modes.fork).toEqual({ available: false, reason: 'forking_disabled' });
	});

	it('refuses Fork with empty_repository', () => {
		const { modes } = resolveAppRepositoryModes(facts({ empty: true }));
		expect(modes.fork).toEqual({ available: false, reason: 'empty_repository' });
	});

	it('refuses Fork with own_repository', () => {
		const { modes } = resolveAppRepositoryModes(facts({ isOwnRepository: true }));
		expect(modes.fork).toEqual({ available: false, reason: 'own_repository' });
	});
});

describe('resolveAppRepositoryModes — private copy (APW-01 spec.md:337-340, FR-20)', () => {
	it('boundary: exactly 500 MB is copyable, one KB more is not', () => {
		expect(
			resolveAppRepositoryModes(facts({ sizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB })).modes['private-copy']
		).toEqual({
			available: true
		});
		expect(
			resolveAppRepositoryModes(facts({ sizeKb: APP_PRIVATE_COPY_MAX_SIZE_KB + 1 })).modes['private-copy']
		).toEqual({ available: false, reason: 'too_large_for_private_copy' });
	});

	it('refuses a private copy with uses_lfs', () => {
		const { modes } = resolveAppRepositoryModes(facts({ usesLfs: true }));
		expect(modes['private-copy']).toEqual({ available: false, reason: 'uses_lfs' });
	});

	it('refuses a private upstream whose owner disallows forking, but a public one of the same shape is copyable', () => {
		expect(
			resolveAppRepositoryModes(facts({ visibility: 'private', allowForking: false })).modes['private-copy']
		).toEqual({
			available: false,
			reason: 'forking_disabled'
		});
		expect(
			resolveAppRepositoryModes(facts({ visibility: 'private', allowForking: true })).modes['private-copy']
		).toEqual({
			available: true
		});
		expect(
			resolveAppRepositoryModes(facts({ visibility: 'public', allowForking: false })).modes['private-copy']
		).toEqual({
			available: true
		});
	});

	it('always reports all three modes, never a partial map', () => {
		const { modes } = resolveAppRepositoryModes(facts());
		expect(Object.keys(modes)).toEqual([...APP_REPOSITORY_MODES]);
	});
});

describe('resolveAppRepositoryModes — fail-closed on an unmeasurable size', () => {
	it('refuses the private copy when the size is missing or not a number', () => {
		const unmeasurable: Array<[string, number | null | undefined]> = [
			['undefined', undefined],
			['null', null],
			['NaN', Number.NaN],
			['Infinity', Number.POSITIVE_INFINITY],
			['-1', -1]
		];
		for (const [label, sizeKb] of unmeasurable) {
			const resolved = resolveAppRepositoryModes(facts({ sizeKb: sizeKb as number }));
			expect(resolved.modes['private-copy'], label).toEqual({
				available: false,
				reason: 'too_large_for_private_copy'
			});
			// Only the size gate is affected: an unmeasurable size must not
			// silently withdraw a mode the repository does qualify for.
			expect(resolved.modes.link, label).toEqual({ available: true });
		}
	});
});

describe('APP_SOURCE_LICENSE_CLASSES / _SOURCES (APW-01 spec.md:293-297, R-3 CONTRACTS.md:46; APW-03 schema.md:143)', () => {
	it('pins the four license classes', () => {
		assertClosedUnion(APP_SOURCE_LICENSE_CLASSES, ['green', 'amber', 'red', 'unknown']);
	});

	it('pins the three evidence sources of the App spec license block', () => {
		assertClosedUnion(APP_SOURCE_LICENSE_SOURCES, ['detected', 'blueprint', 'user']);
	});
});

describe('APP_SOURCE_BLUEPRINT_* (APW-01 spec.md:383-388, plan.md:396; APW-03 spec.md:410-417)', () => {
	it('pins the three preview statuses', () => {
		assertClosedUnion(APP_SOURCE_BLUEPRINT_STATUSES, ['matched', 'none', 'unavailable']);
	});

	it('pins the five match sources, including explicit', () => {
		assertClosedUnion(APP_SOURCE_BLUEPRINT_MATCH_SOURCES, ['manifest', 'alias', 'fork', 'probe', 'explicit']);
	});
});

describe('APP_REPOSITORY_STAGES and the per-stage limits (CONTRACTS.md:336)', () => {
	it('pins the four pipeline stages', () => {
		assertClosedUnion(APP_REPOSITORY_STAGES, ['private-copy', 'provisioning', 'build', 'sandbox']);
	});

	it('pins the stage refusal codes that a spec actually names', () => {
		assertClosedUnion(APP_REPOSITORY_STAGE_REFUSAL_CODES, [
			'too_large_for_private_copy',
			'uses_lfs',
			'repository-too-large'
		]);
	});

	it('the private copy stage carries the FR-20 ceiling and no LFS', () => {
		expect(APP_REPOSITORY_STAGE_LIMITS['private-copy'].maxSizeKb).toBe(512_000);
		expect(APP_REPOSITORY_STAGE_LIMITS['private-copy'].fetchesLfs).toBe(false);
	});

	it('the provisioning stage carries the 3 GiB of APW-04 FR-15 (spec.md:234)', () => {
		expect(APP_REPOSITORY_STAGE_LIMITS.provisioning.maxSizeKb).toBe(3 * 1024 * 1024);
	});

	it('names exactly the stages whose limit no spec states yet, so the day a number appears this fails', () => {
		expect(APP_REPOSITORY_STAGES_WITHOUT_SPEC_LIMIT).toEqual(['build', 'sandbox']);
		for (const stage of APP_REPOSITORY_STAGES_WITHOUT_SPEC_LIMIT) {
			expect(APP_REPOSITORY_STAGE_LIMITS[stage].maxSizeKb).toBeUndefined();
		}
	});

	it('firstRefusingRepositoryStage: 500 MB passes, 500 MB + 1 KB is refused by the private copy', () => {
		expect(firstRefusingRepositoryStage({ sizeKb: 512_000 })).toBeNull();
		expect(firstRefusingRepositoryStage({ sizeKb: 512_001 })).toBe('private-copy');
	});

	it('boundary: the provisioning ceiling is 3 GiB and one KB more is refused', () => {
		const provisioningOnly = ['provisioning'] as const;
		expect(firstRefusingRepositoryStage({ sizeKb: 3 * 1024 * 1024, stages: provisioningOnly })).toBeNull();
		expect(firstRefusingRepositoryStage({ sizeKb: 3 * 1024 * 1024 + 1, stages: provisioningOnly })).toBe(
			'provisioning'
		);
	});

	it('refuses the private copy stage for LFS before any size check', () => {
		expect(firstRefusingRepositoryStage({ sizeKb: 1, usesLfs: true })).toBe('private-copy');
		expect(firstRefusingRepositoryStage({ sizeKb: 1, usesLfs: true, stages: ['provisioning'] })).toBeNull();
	});

	it('fails closed on an unmeasurable size when a gated stage is in the path', () => {
		expect(firstRefusingRepositoryStage({})).toBe('private-copy');
		expect(firstRefusingRepositoryStage({ sizeKb: Number.NaN })).toBe('private-copy');
		expect(firstRefusingRepositoryStage({ sizeKb: null })).toBe('private-copy');
		expect(firstRefusingRepositoryStage({ sizeKb: -1, stages: ['provisioning'] })).toBe('provisioning');
	});

	it('reports nothing when no stage in the path has a spec limit', () => {
		expect(firstRefusingRepositoryStage({ sizeKb: 10 * 1024 * 1024, stages: ['build', 'sandbox'] })).toBeNull();
	});
});

describe('APP_WORK_QUOTA_CAPS (CONTRACTS.md:658-660, resolution R-31)', () => {
	it('pins APW-01’s three caps with their environment overrides', () => {
		expect(APP_WORK_QUOTA_CAPS).toEqual({
			activeAppWorks: { member: 25, org: 200, env: 'EVER_WORKS_APPS_MAX_ACTIVE' },
			createsPerDay: { member: 20, org: 100, env: 'EVER_WORKS_APPS_MAX_CREATES_PER_DAY' },
			privateCopies: { member: 10, org: 50, env: 'EVER_WORKS_APPS_MAX_PRIVATE_COPIES' }
		});
	});

	it('boundary: the 25th active App Work is admitted, the 26th is refused (CONTRACTS.md:658)', () => {
		const cap = APP_WORK_QUOTA_CAPS.activeAppWorks.member;
		expect(appWorkQuotaAllows(cap, cap - 1)).toBe(true);
		expect(appWorkQuotaAllows(cap, cap)).toBe(false);
		expect(appWorkQuotaAllows(cap, cap + 1)).toBe(false);
	});

	it('boundary: the organization scope is 200 (CONTRACTS.md:658)', () => {
		const cap = APP_WORK_QUOTA_CAPS.activeAppWorks.org;
		expect(appWorkQuotaAllows(cap, cap - 1)).toBe(true);
		expect(appWorkQuotaAllows(cap, cap)).toBe(false);
	});

	it('fails closed on a cap that is not a positive number', () => {
		expect(appWorkQuotaAllows(0, 0)).toBe(false);
		expect(appWorkQuotaAllows(-1, 0)).toBe(false);
		expect(appWorkQuotaAllows(Number.NaN, 0)).toBe(false);
	});
});

describe('APP_FORK_READINESS_* (APW-02 spec.md:284-310)', () => {
	it('pins the four readiness probes at 2, 4, 8 and 15 seconds (spec.md:288)', () => {
		expect(APP_FORK_READINESS_POLL_DELAYS_MS).toEqual([2_000, 4_000, 8_000, 15_000]);
	});

	it('APP_FORK_READINESS_POLL_INTERVAL_MS is 15_000 (APW-02 spec.md:288-289)', () => {
		expect(APP_FORK_READINESS_POLL_INTERVAL_MS).toBe(15_000);
	});

	it('APP_FORK_READINESS_TIMEOUT_MS is 900_000 = the 15 minutes of FR-18 (spec.md:289)', () => {
		expect(APP_FORK_READINESS_TIMEOUT_MS).toBe(900_000);
	});

	it('APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS is 5_000 and strictly below the deadline (spec.md:290-292)', () => {
		expect(APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS).toBe(5_000);
		expect(APP_FORK_READINESS_TIMEOUT_OVERRIDE_MIN_MS).toBeLessThan(APP_FORK_READINESS_TIMEOUT_MS);
	});

	it('APP_FORK_READINESS_READY_LATENCY_MS is 30_000 (APW-02 plan.md:427)', () => {
		expect(APP_FORK_READINESS_READY_LATENCY_MS).toBe(30_000);
	});

	it('APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR is 3 and APP_FORK_READINESS_MAX_REDISPATCH is 3 (spec.md:293-294, 302-303)', () => {
		expect(APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR).toBe(3);
		expect(APP_FORK_READINESS_MAX_REDISPATCH).toBe(3);
	});

	it('APP_FORK_READINESS_IDLE_MS is 600_000 = the 10 minutes of FR-23 (spec.md:302)', () => {
		expect(APP_FORK_READINESS_IDLE_MS).toBe(600_000);
	});

	it('THE TIMEOUT OVERRIDE IS NAMED AND IS NOT A PRODUCTION VALUE (APW-02 spec.md:290-292)', () => {
		expect(APP_FORK_READINESS_TIMEOUT_ENV).toBe('EVER_WORKS_APP_FORK_READINESS_TIMEOUT_MS');
	});

	it('pins the four readiness dispatch reasons', () => {
		assertClosedUnion(APP_FORK_READINESS_REASONS, ['initial', 'retry', 'redispatch', 'setup_merged']);
	});

	it('APP_SETUP_PR_CHECK_ON_VIEW_MIN_INTERVAL_MS is 60_000 and the batch is 50 (spec.md:306-307)', () => {
		expect(APP_SETUP_PR_CHECK_ON_VIEW_MIN_INTERVAL_MS).toBe(60_000);
		expect(APP_SETUP_PR_CHECK_BATCH).toBe(50);
	});
});

describe('APP_UPSTREAM_SYNC_* (APW-02 spec.md:327-360)', () => {
	it('the default schedule is Mondays 06:00 UTC (spec.md:329-330)', () => {
		expect(APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE).toBe('0 6 * * 1');
	});

	it('APP_UPSTREAM_SYNC_MIN_INTERVAL_MS is 3_600_000 = the hourly floor of FR-32 (spec.md:329-330)', () => {
		expect(APP_UPSTREAM_SYNC_MIN_INTERVAL_MS).toBe(3_600_000);
	});

	it('APP_UPSTREAM_SYNC_JITTER_MAX_MS is 300_000 = the stable 0–300 s delay (spec.md:330-331)', () => {
		expect(APP_UPSTREAM_SYNC_JITTER_MAX_MS).toBe(300_000);
	});

	it('APP_UPSTREAM_SYNC_MANUAL_PER_HOUR is 6, and the 7th manual sync in the hour is refused (spec.md:332-333)', () => {
		expect(APP_UPSTREAM_SYNC_MANUAL_PER_HOUR).toBe(6);
		expect(appManualSyncAllowed(APP_UPSTREAM_SYNC_MANUAL_PER_HOUR - 1)).toBe(true);
		expect(appManualSyncAllowed(APP_UPSTREAM_SYNC_MANUAL_PER_HOUR)).toBe(false);
		expect(appManualSyncAllowed(APP_UPSTREAM_SYNC_MANUAL_PER_HOUR + 1)).toBe(false);
	});

	it('APP_UPSTREAM_SYNC_ACK_BUDGET_MS is 2_000 = Sync now returns within 2 seconds (spec.md:332)', () => {
		expect(APP_UPSTREAM_SYNC_ACK_BUDGET_MS).toBe(2_000);
	});

	it('APP_UPSTREAM_SYNC_LOCK_TTL_MS is 1_800_000 = at most one sync per App Work (spec.md:334)', () => {
		expect(APP_UPSTREAM_SYNC_LOCK_TTL_MS).toBe(1_800_000);
	});

	it('the dispatcher ticks every 10 minutes with a batch of 50 (spec.md:379, CONTRACTS.md:480)', () => {
		expect(APP_UPSTREAM_SYNC_DISPATCH_CRON).toBe('*/10 * * * *');
		expect(APP_UPSTREAM_SYNC_DISPATCH_BATCH).toBe(50);
	});

	it('APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS is 20 (spec.md:373)', () => {
		expect(APP_UPSTREAM_SYNC_MAX_PROVIDER_CALLS).toBe(20);
	});

	it('the sync branch, conflict label and conflict path cap are fixed (spec.md:340-346)', () => {
		expect(APP_UPSTREAM_SYNC_BRANCH).toBe('ever-works/upstream-sync');
		expect(APP_UPSTREAM_CONFLICT_LABEL_PREFIX).toBe('app-upstream-conflict:');
		expect(APP_UPSTREAM_CONFLICT_MAX_PATHS).toBe(50);
	});

	it('APP_ACTIONS_HYGIENE_MAX_WORKFLOWS is 100 and FR-29 caps each list at 100 too (spec.md:320-322)', () => {
		expect(APP_ACTIONS_HYGIENE_MAX_WORKFLOWS).toBe(100);
	});

	it('APP_UPSTREAM_UNAVAILABLE_RECHECK_MS is 86_400_000 = the 24-hour re-check (spec.md:354-355)', () => {
		expect(APP_UPSTREAM_UNAVAILABLE_RECHECK_MS).toBe(86_400_000);
	});
});

describe('rate limits and budgets (APW-02 spec.md:371-379)', () => {
	it('APP_RATE_LIMIT_MIN_REMAINING is 300, and exactly 300 remaining still runs (spec.md:374-375)', () => {
		expect(APP_RATE_LIMIT_MIN_REMAINING).toBe(300);
		expect(appRateLimitAllowsSync(APP_RATE_LIMIT_MIN_REMAINING)).toBe(true);
		expect(appRateLimitAllowsSync(APP_RATE_LIMIT_MIN_REMAINING + 1)).toBe(true);
		expect(appRateLimitAllowsSync(APP_RATE_LIMIT_MIN_REMAINING - 1)).toBe(false);
	});

	it('APP_RATE_LIMIT_RESET_GRACE_MS is 60_000 (spec.md:374-375)', () => {
		expect(APP_RATE_LIMIT_RESET_GRACE_MS).toBe(60_000);
	});

	it('the backoff doubles from 60 s to at most 60 minutes (spec.md:376-377)', () => {
		expect(APP_RATE_LIMIT_BACKOFF_BASE_MS).toBe(60_000);
		expect(APP_RATE_LIMIT_BACKOFF_MAX_MS).toBe(3_600_000);
		expect(APP_RATE_LIMIT_BACKOFF_BASE_MS * 60).toBe(APP_RATE_LIMIT_BACKOFF_MAX_MS);
	});

	it('APP_RATE_LIMITED_PERSISTENT_AFTER is 3 (spec.md:378)', () => {
		expect(APP_RATE_LIMITED_PERSISTENT_AFTER).toBe(3);
	});

	it('the divergence TTL is 10 minutes and the daily refresh is 24 hours (spec.md:364-365)', () => {
		expect(APP_DIVERGENCE_TTL_MS).toBe(600_000);
		expect(APP_DIVERGENCE_DAILY_MS).toBe(86_400_000);
	});

	it('APP_BEHIND_EVENT_STEP is 25 (spec.md:368-369)', () => {
		expect(APP_BEHIND_EVENT_STEP).toBe(25);
	});
});

describe('APP_READINESS_STATES (APW-02 plan.md:353, spec.md:455-460)', () => {
	it('pins the five readiness states', () => {
		assertClosedUnion(APP_READINESS_STATES, ['preparing', 'ready', 'timed_out', 'failed', 'waiting_for_setup_pr']);
	});
});

describe('APP_SYNC_RESULTS and APP_SYNC_REASONS (APW-02 plan.md:354-363, tasks.md:739-742)', () => {
	it('pins the eight coarse last-result states', () => {
		assertClosedUnion(APP_SYNC_RESULTS, [
			'up_to_date',
			'fast_forwarded',
			'pull_request_opened',
			'pull_request_updated',
			'conflict',
			'skipped',
			'paused',
			'failed'
		]);
	});

	it('pins the fifteen fine-grained sync reasons', () => {
		assertClosedUnion(APP_SYNC_REASONS, [
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
		]);
	});

	it('both unions are append-only supersets of the states they came from', () => {
		expect(APP_SYNC_RESULTS).toHaveLength(8);
		expect(APP_SYNC_REASONS).toHaveLength(15);
		// The three coarse outcomes every run can reach are reasons too.
		for (const shared of ['up_to_date', 'conflict', 'failed']) {
			expect(APP_SYNC_RESULTS).toContain(shared);
			expect(APP_SYNC_REASONS).toContain(shared);
		}
	});
});

describe('APP_READINESS_FAILURE_REASONS (APW-02 tasks.md:737-738, spec.md:295-309)', () => {
	it('pins the ten failure reasons', () => {
		assertClosedUnion(APP_READINESS_FAILURE_REASONS, [
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
		]);
	});
});

describe('APP_UPSTREAM_WARNING_CODES (APW-02 spec.md:519-534)', () => {
	it('pins the §6.2 warning rows, camelCased, in table order', () => {
		assertClosedUnion(APP_UPSTREAM_WARNING_CODES, [
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
		]);
		// APW-02 tasks.md:742 says "the ten spec §6.2 rows"; the table has
		// twelve. R-26 (CONTRACTS.md:69) forbids dropping the two extra rows,
		// so the table wins and the count is asserted, not described.
		expect(APP_UPSTREAM_WARNING_CODES).toHaveLength(12);
	});
});

describe('APP_UPSTREAM_STATUSES and APP_ACTIONS_STATES (APW-02 plan.md:364-372)', () => {
	it('pins the five upstream statuses', () => {
		assertClosedUnion(APP_UPSTREAM_STATUSES, ['available', 'archived', 'unavailable', 'none', 'unknown']);
	});

	it('pins the six Actions hygiene states', () => {
		assertClosedUnion(APP_ACTIONS_STATES, [
			'pending',
			'clean',
			'needs_admin',
			'permission_missing',
			'failed',
			'not_applicable'
		]);
	});
});

describe('EVER_ID_LIMITS (APW-12 plan.md:256-286)', () => {
	it('pins every number to its spec line', () => {
		expect(EVER_ID_LIMITS).toEqual({
			stateBytes: 32, // spec FR-9 (spec.md:200-202)
			nonceBytes: 32, // spec FR-9 (spec.md:200-202)
			codeVerifierLength: 64, // spec FR-9 (spec.md:200-202)
			transactionTtlSeconds: 600, // spec FR-9 (spec.md:200-202)
			signUpPendingTtlSeconds: 600, // spec FR-23 (spec.md:237-239)
			connectPendingTtlSeconds: 300, // spec FR-26 (spec.md:247)
			idTokenMaxAgeSeconds: 600, // spec FR-11 (spec.md:209)
			connectMaxAuthAgeSeconds: 300, // spec FR-25 (spec.md:243)
			connectMaxSessionAgeSeconds: 43_200, // spec FR-25 (spec.md:242-243)
			defaultClockSkewSeconds: 60, // spec FR-2 (spec.md:182)
			maxClockSkewSeconds: 120, // spec FR-2 (spec.md:182)
			jwksCacheSeconds: 600, // spec FR-13 (spec.md:212)
			jwksUnknownKidCooldownSeconds: 30, // spec FR-13 (spec.md:212-213)
			jwksMaxStaleSeconds: 21_600, // spec FR-13 (spec.md:213-214)
			discoveryCacheSeconds: 3_600, // spec FR-14 (spec.md:216)
			outboundTimeoutMs: 5_000, // spec FR-15 (spec.md:218)
			logoutTokenMaxAgeSeconds: 300, // spec FR-33 (spec.md:265-266)
			replayWindowSeconds: 600, // spec FR-33 (spec.md:266-267)
			exchangeTokenMaxAgeSeconds: 300, // spec FR-40 (spec.md:286)
			delegatedTokenMaxLifetimeSeconds: 3_600, // spec FR-45 (spec.md:299-300)
			allowedIssuersMax: 3, // spec FR-2 + R-28 (spec.md:180-181, CONTRACTS.md:71)
			localClientsMax: 5, // spec FR-2 (spec.md:181)
			delegatedClientsMax: 10, // spec FR-31/FR-48 (spec.md:257)
			delegatedClientsWindowDays: 30, // spec FR-48 (spec.md:305)
			availabilityCacheSeconds: 60, // spec FR-5 (spec.md:188-189)
			delegatedClientNamesMax: 10, // spec FR-31 (spec.md:257)
			devicePollMinIntervalSeconds: 5, // spec FR-41 (spec.md:288)
			devicePollSlowDownStepSeconds: 5, // spec FR-41 (spec.md:288)
			deviceCodeMaxLifetimeSeconds: 900 // spec FR-41 (spec.md:289)
		});
	});

	it('boundary: a clock skew of 0 and 120 s is accepted, 121 s and a negative or fractional value are not (FR-2)', () => {
		expect(isEverIdClockSkewAllowed(0)).toBe(true);
		expect(isEverIdClockSkewAllowed(EVER_ID_LIMITS.defaultClockSkewSeconds)).toBe(true);
		expect(isEverIdClockSkewAllowed(EVER_ID_LIMITS.maxClockSkewSeconds)).toBe(true);
		expect(isEverIdClockSkewAllowed(EVER_ID_LIMITS.maxClockSkewSeconds + 1)).toBe(false);
		expect(isEverIdClockSkewAllowed(-1)).toBe(false);
		expect(isEverIdClockSkewAllowed(60.5)).toBe(false);
		expect(isEverIdClockSkewAllowed(Number.NaN)).toBe(false);
	});

	it('boundary: 1–3 allowed issuers, so 0 and 4 are refused (FR-2, R-28)', () => {
		expect(isEverIdAllowedIssuerCountAllowed(0)).toBe(false);
		expect(isEverIdAllowedIssuerCountAllowed(1)).toBe(true);
		expect(isEverIdAllowedIssuerCountAllowed(EVER_ID_LIMITS.allowedIssuersMax)).toBe(true);
		expect(isEverIdAllowedIssuerCountAllowed(EVER_ID_LIMITS.allowedIssuersMax + 1)).toBe(false);
	});

	it('the 0–5 local-client allowance is inside its own ceiling (FR-2)', () => {
		expect(EVER_ID_LIMITS.localClientsMax).toBe(5);
		expect(EVER_ID_LIMITS.localClientsMax).toBeGreaterThan(0);
	});
});

describe('Ever ID identity constants (APW-12 spec.md:294-306, plan.md:253-255)', () => {
	it('pins the registration provider, audience and display name', () => {
		expect(EVER_ID_REGISTRATION_PROVIDER).toBe('ever-id');
		expect(EVER_ID_DEFAULT_API_AUDIENCE).toBe('ever-works');
		expect(EVER_ID_DEFAULT_DISPLAY_NAME).toBe('Ever ID');
	});

	it('pins the two scopes (idp-options.md:203)', () => {
		expect(EVER_ID_SCOPES).toEqual({ APPS_READ: 'apps:read', SESSION_EXCHANGE: 'ever-works:session' });
	});

	it('delegated reads accept apps:read and nothing else (spec.md:296-297, plan.md:14)', () => {
		assertClosedUnion(EVER_ID_DELEGATED_SCOPES, ['apps:read']);
		expect(EVER_ID_DELEGATED_SCOPES).toContain(EVER_ID_SCOPES.APPS_READ);
		expect(EVER_ID_DELEGATED_SCOPES).not.toContain(EVER_ID_SCOPES.SESSION_EXCHANGE);
	});

	it('appends exactly one authMethod value and leaves session | api-key alone (R-19, CONTRACTS.md:62)', () => {
		expect(EVER_ID_DELEGATED_AUTH_METHOD).toBe('ever-id-delegated');
	});

	it('pins the six query keys a token may never arrive in (spec.md:223-224, plan.md:526-527)', () => {
		assertClosedUnion(EVER_ID_QUERY_TOKEN_PARAMS, [
			'access_token',
			'id_token',
			'logout_token',
			'token',
			'sessionToken',
			'code_verifier'
		]);
	});

	it('pins the three signing algorithms (spec.md:206-207)', () => {
		assertClosedUnion(EVER_ID_SIGNING_ALGS, ['RS256', 'ES256', 'EdDSA']);
	});

	it('pins the two linkedVia values (plan.md:190)', () => {
		assertClosedUnion(EVER_ID_LINKED_VIA, ['sign-up', 'settings']);
	});
});

describe('Ever ID error codes (APW-12 plan.md:288-304 against CONTRACTS.md:762-790)', () => {
	it('maps every plan-era member onto a snake_case wire code, one to one', () => {
		expect(Object.keys(EVER_ID_ERROR_CODE_WIRE_VALUES)).toHaveLength(EVER_ID_WIRE_ERROR_CODES.length);
		expect(new Set(Object.values(EVER_ID_ERROR_CODE_WIRE_VALUES)).size).toBe(EVER_ID_WIRE_ERROR_CODES.length);
		for (const wire of Object.values(EVER_ID_ERROR_CODE_WIRE_VALUES)) {
			expect(EVER_ID_WIRE_ERROR_CODES).toContain(wire);
			expect(wire).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});

	it('carries the four codes CONTRACTS §12 registers for APW-12', () => {
		expect(EVER_ID_WIRE_ERROR_CODES).toContain('ever_id_disabled');
		expect(EVER_ID_WIRE_ERROR_CODES).toContain('transaction_invalid');
		expect(EVER_ID_WIRE_ERROR_CODES).toContain('token_in_query');
		expect(EVER_ID_WIRE_ERROR_CODES).toContain('ever_id_signed_out');
	});

	it('the plan’s camelCase union still has its sixteen members (R-26: nothing is removed)', () => {
		const planMembers: EverIdErrorCode[] = [
			'everIdDisabled',
			'providerUnavailable',
			'transactionInvalid',
			'emailNotVerified',
			'emailInUse',
			'signUpNotAllowed',
			'subjectLinked',
			'userHasIssuer',
			'reauthRequired',
			'sessionRequired',
			'lastSignInMethod',
			'notConnected',
			'accountDisabled',
			'everIdSignedOut',
			'tokenInQuery',
			'insufficientScope'
		];
		expect(planMembers).toHaveLength(16);
		expect(EVER_ID_WIRE_ERROR_CODES).toHaveLength(16);
		expect(Object.keys(EVER_ID_ERROR_CODE_WIRE_VALUES)).toEqual(planMembers);
	});
});

describe('type-level pins', () => {
	it('the readiness reasons are exactly the spec list', () => {
		type _Check = Expect<Equal<(typeof APP_READINESS_FAILURE_REASONS)[number], SpecReadinessFailureReasons>>;
		expect(APP_READINESS_FAILURE_REASONS).toHaveLength(10);
	});

	it('the sync reasons are exactly the spec list', () => {
		type _Check = Expect<Equal<(typeof APP_SYNC_REASONS)[number], SpecSyncReasons>>;
		expect(APP_SYNC_REASONS).toHaveLength(15);
	});

	it('the warning codes are exactly the spec list', () => {
		type _Check = Expect<Equal<(typeof APP_UPSTREAM_WARNING_CODES)[number], SpecUpstreamWarningCodes>>;
		expect(APP_UPSTREAM_WARNING_CODES).toHaveLength(12);
	});
});

/** Keeps the compile-time aliases referenced so the file reads as intentional. */
type _AllTypePins = [_ReasonCodesExhaustive, SpecReadinessFailureReasons, SpecSyncReasons, SpecUpstreamWarningCodes];
