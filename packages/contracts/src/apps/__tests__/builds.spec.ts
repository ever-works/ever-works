import { describe, expect, it } from 'vitest';

import {
	APP_BUILD_BLOCKED_ACTIONS,
	APP_BUILD_BLOCKED_REASONS,
	APP_BUILD_BLOCKED_REASON_ACTIONS,
	APP_BUILD_CANCEL_REASONS,
	APP_BUILD_CHECK_NAME_PREFIX,
	APP_BUILD_CHECKS_MAX,
	APP_BUILD_CHECKS_MAX_PARALLEL,
	APP_BUILD_EVENT_NAMES,
	APP_BUILD_EXCERPT_MAX_LINES,
	APP_BUILD_EXCERPT_MAX_LINE_CHARS,
	APP_BUILD_FAILURE_CLASSES,
	APP_BUILD_FAILURE_COPY_EN,
	APP_BUILD_KINDS,
	APP_BUILD_LIST_MAX_PAGE_SIZE,
	APP_BUILD_LIST_PAGE_SIZE,
	APP_BUILD_MANAGED_CONCURRENCY,
	APP_BUILD_MANAGED_DEFAULTS,
	APP_BUILD_MANAGED_MAXIMUMS,
	APP_BUILD_MAX_VALUES,
	APP_BUILD_NOT_DEPLOYABLE_REASONS,
	APP_BUILD_RESTRICTED_VALUE_LITERAL,
	APP_BUILD_RUNNER_CLASSES,
	APP_BUILD_RUNNER_HEADROOM_GIB,
	APP_BUILD_RUNNERS,
	APP_BUILD_SECRET_CHECK_MIN_CHARS,
	APP_BUILD_SECRET_MAX_BYTES,
	APP_BUILD_SECRET_PREFIX,
	APP_BUILD_SIGNATURE_STATES,
	APP_BUILD_STATUSES,
	APP_BUILD_STATUS_EVENT_MAP,
	APP_BUILD_STRATEGIES,
	APP_BUILD_SWEEP_CRON,
	APP_BUILD_TRIGGERS,
	APP_BUILD_VERIFICATION_RESULT_MAX_SMOKE,
	APP_BUILD_VERIFY_MEMORY_GIB,
	APP_BUILD_VERIFY_PLAN_MAX_CHARS,
	APP_BUILD_VERIFY_PLAN_MAX_COMPONENTS,
	APP_BUILD_VERIFY_PLAN_MAX_DEPENDENCIES,
	APP_BUILD_VERIFY_PLAN_MAX_ENV_ENTRIES,
	APP_BUILD_VERIFY_PLAN_MAX_JOBS,
	APP_BUILD_VERIFY_PLAN_MAX_SMOKE,
	APP_BUILD_VERIFY_PROMPTED_SECRET,
	APP_BUILD_VERIFY_TIMEOUT_MINUTES,
	APP_BUILD_WORKFLOW_BRANCH,
	APP_BUILD_WORKFLOW_PATH,
	APP_VERIFICATION_DEPENDENCY_CONTAINERS,
	APP_VERIFICATION_PLAN_VERSION,
	BUILD_SERVICE_DEFAULTS,
	BUILD_SERVICE_HOST,
	appBuildCheckName,
	appBuildEventNameForStatus,
	appBuildRunnerCapacity,
	buildFailureExcerpt,
	computeBuildInputsHash,
	evaluateBuildDeployability,
	evaluateBuildRunnerFit,
	evaluateBuildServicePort,
	isAppBuildCheckJobName,
	resolveBuildServiceEnv,
	resolveBuildServiceKind,
	resolveBuildServicePort,
	sha256Hex,
	type AppBuildDeployabilityInput,
	type AppBuildStatus
} from '../builds.js';

import {
	APP_ENV_ALPHABETS,
	APP_ENV_DOTENV_MAX_BYTES,
	APP_ENV_DOTENV_MAX_LINES,
	APP_ENV_GENERATOR_KINDS,
	APP_ENV_KEYPAIR_DEFAULT_FORMAT,
	APP_ENV_KEYPAIR_FORMATS,
	APP_ENV_KEYPAIR_RAW_TYPES,
	APP_ENV_KEYPAIR_TYPES,
	APP_ENV_MAX_STORED,
	APP_ENV_NAME_PATTERN,
	APP_ENV_ORIGINS,
	APP_ENV_PATTERN_BUDGET_MS,
	APP_ENV_PHASES,
	APP_ENV_PUBLIC_HALF_MAX_BYTES,
	APP_ENV_PUBLIC_HALF_SUFFIX,
	APP_ENV_PUBLIC_PREFIXES,
	APP_ENV_PUTS_PER_MINUTE,
	APP_ENV_RECIPE_SOURCES,
	APP_ENV_REDACT_MIN_CHARS,
	APP_ENV_RESERVED_PREFIX,
	APP_ENV_ROTATIONS_PER_HOUR,
	APP_ENV_RUNNER_RECIPE_ENDPOINTS,
	APP_ENV_STORED_ORIGINS,
	APP_ENV_TEMPLATE_MAX_DEPTH,
	APP_ENV_TOTAL_MAX_BYTES,
	APP_ENV_UNRESOLVED_REASONS,
	APP_ENV_VALIDATION_REFUSAL_CODES,
	APP_ENV_VALUE_MAX_BYTES,
	appEnvDependencyFingerprint,
	appEnvDependencyPasswordToken,
	appEnvGeneratorFingerprint,
	appEnvKeypairFormatSupported,
	appEnvPublicHalfName,
	appEnvStoredFingerprint,
	appEnvTemplateFingerprint,
	hasAppEnvPublicPrefix,
	type AppEnvOrigin,
	type AppEnvPhase,
	type AppEnvRecipeSource
} from '../app-env.js';

import {
	APP_DEPENDENCY_BACKUP_OVERDUE_MS,
	APP_DEPENDENCY_BACKUP_POLICIES,
	APP_DEPENDENCY_BACKUP_STATES,
	APP_DEPENDENCY_BUCKET_OUTPUT_PATTERN,
	APP_DEPENDENCY_DEFAULT_SIZE_GIB,
	APP_DEPENDENCY_ENV_VARS,
	APP_DEPENDENCY_EXTERNAL_TEST_MS,
	APP_DEPENDENCY_INACTIVE_STATUSES,
	APP_DEPENDENCY_KINDS,
	APP_DEPENDENCY_MANAGED,
	APP_DEPENDENCY_OUTPUTS,
	APP_DEPENDENCY_OUTPUT_NAMES,
	APP_DEPENDENCY_PROVIDER_IDS,
	APP_DEPENDENCY_READY_DEADLINE_MS,
	APP_DEPENDENCY_RELAY_DAILY_LIMIT,
	APP_DEPENDENCY_RELAY_LIMITS,
	APP_DEPENDENCY_RETRY_DELAY_MS,
	APP_DEPENDENCY_STATUSES,
	APP_DEPENDENCY_TARGETS,
	APP_DEPENDENCY_TOKEN_SCHEME,
	APP_DEPENDENCY_TOKEN_UNKNOWN_CODE,
	APP_DEPENDENCY_TRANSIENT_ATTEMPTS,
	appDependencyBlocksDeploy,
	appDependencyDefaultSizeGiB,
	appDependencyOutputNames,
	appDependencyReadyDeadlineMs,
	appDependencyToken,
	canDeleteAppDependencyData,
	isAppDependencyBackupOverdue,
	isAppDependencyOutputSecret,
	isAppDependencySizeChangeAllowed,
	parseAppDependencyToken
} from '../app-dependencies.js';

import {
	TENANT_POSTGRES_DATABASE_CONNECTION_LIMIT,
	TENANT_POSTGRES_DATABASE_PREFIX,
	TENANT_POSTGRES_DEFAULT_PORT,
	TENANT_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
	TENANT_POSTGRES_PASSWORD_PATTERN,
	TENANT_POSTGRES_ROLE_ATTRIBUTES,
	TENANT_POSTGRES_ROLE_CONNECTION_LIMIT,
	TENANT_POSTGRES_ROLE_PREFIX,
	TENANT_POSTGRES_STATEMENT_TIMEOUT_MS,
	buildTenantPostgresDdl,
	isPlatformDataServer,
	normaliseDataServerEndpoint,
	parseDataServerUrl,
	platformDataServerEndpoints,
	quoteTenantPostgresIdentifier
} from '../tenant-postgres-ddl.js';

import {
	APPS_TIER_API_GROUP,
	APPS_TIER_API_VERSION,
	APPS_TIER_AUTO_REOPENABLE_REASON_CODES,
	APPS_TIER_BILLING_QUARANTINE_CATEGORY,
	APPS_TIER_CLOSED_REASON_CODES,
	APPS_TIER_CONTROL_NAMESPACE_DEFAULT,
	APPS_TIER_DEPENDENCY_PHASES,
	APPS_TIER_DEPLOY_PHASES,
	APPS_TIER_EGRESS_NOTICE_SHARE,
	APPS_TIER_EGRESS_THROTTLE_MBPS,
	APPS_TIER_ELIGIBILITY_DISABLED_REASONS,
	APPS_TIER_ELIGIBILITY_REASONS,
	APPS_TIER_EVENT_NAMES,
	APPS_TIER_JOB_PHASES,
	APPS_TIER_JOB_STATUSES,
	APPS_TIER_MAX_COMPONENTS,
	APPS_TIER_MAX_COMPONENT_REPLICAS,
	APPS_TIER_MAX_COMPONENT_VOLUMES,
	APPS_TIER_MAX_CRON,
	APPS_TIER_MAX_ENV_NAMES,
	APPS_TIER_MAX_HOSTS,
	APPS_TIER_MAX_IMAGES,
	APPS_TIER_MAX_JOBS,
	APPS_TIER_MAX_JOB_TIMEOUT_SECONDS,
	APPS_TIER_MAX_SEALED_ENV_BYTES,
	APPS_TIER_MAX_SMOKE,
	APPS_TIER_MAX_WORK_BYTES,
	APPS_TIER_MIN_CRON_INTERVAL_MS,
	APPS_TIER_NOTIFICATION_IDS,
	APPS_TIER_OPEN_REFUSED_CODE,
	APPS_TIER_PAUSE_ALL_CATEGORY,
	APPS_TIER_PAUSE_ALL_CONFIRMATION,
	APPS_TIER_POLICY_DEFAULT_SCOPE,
	APPS_TIER_PRICEBOOK_VERSION,
	APPS_TIER_PRICE_GROUP,
	APPS_TIER_PRICE_KEYS,
	APPS_TIER_PRICE_UNITS,
	APPS_TIER_PROBE_REASON_CODES,
	APPS_TIER_QUARANTINE_CATEGORIES,
	APPS_TIER_QUARANTINE_SOURCES,
	APPS_TIER_QUOTA_CEILINGS,
	APPS_TIER_QUOTA_PROFILES,
	APPS_TIER_QUOTA_PROFILE_NAMES,
	APPS_TIER_SCOPES,
	APPS_TIER_SIGNAL_KINDS,
	APPS_TIER_SIGNAL_SEVERITIES,
	APPS_TIER_SMOKE_SCOPES,
	APPS_TIER_SMOKE_STATUSES,
	APPS_TIER_STATES,
	APPS_TIER_USAGE_UNITS,
	APPS_TIER_WORK_DEGRADED_REASONS,
	APPS_TIER_WORK_DESIRED_STATES,
	APPS_TIER_WORK_PHASES,
	APPS_TIER_WORK_REFUSAL_CODES,
	ATTESTATION_NOTICE_DAYS,
	ATTESTATION_TTL_DAYS,
	DETECTOR_QUARANTINE_MS,
	GATE_MAX_AGE_HOURS,
	GATE_WATCH_INTERVAL_MIN,
	HEARTBEAT_MAX_AGE_MS,
	IMAGE_ALLOWANCE_MAX_DAYS,
	LAUNCH_GATE_ITEMS,
	LAUNCH_GATE_ITEM_IDS,
	LAUNCH_GATE_KINDS,
	LAUNCH_GATE_OUTCOMES,
	LAUNCH_GATE_PHASES,
	PROBE_ATTEMPTS,
	PROBE_CONNECT_TIMEOUT_MS,
	PULL_CREDENTIAL_MAX_MS,
	QUARANTINE_EDGE_MS,
	QUARANTINE_ISOLATE_MS,
	QUARANTINE_SCALE_MS,
	RELEASE_RESTORE_MS,
	REMOVED_DATA_RETENTION_DAYS,
	SELF_CHECK_BUDGET_MS,
	SELF_CHECK_INTERVAL_HOURS,
	appsTierReceiptIdempotencyKey,
	clampAppsTierQuotaProfile,
	evaluateAppsTierPolicyState,
	isSemverLessThan,
	launchGateItemsForPhase,
	resolveAppsTierQuotaProfile,
	type AppsTierPolicyEvaluationInput,
	type AppsTierState,
	type AppsTierWorkPhase
} from '../apps-tier.js';

/**
 * Contract tests for the five modules `packages/contracts/src/apps/` adds:
 * APW-05's build model, APW-07's env and dependency models and its tenant DDL,
 * and APW-10's managed-tier model.
 *
 * Conventions: every test name cites the spec line it pins, closed unions are
 * checked for duplicates AND against a compile-time exhaustive map (so a new
 * member cannot be added without editing this file), and every numeric ceiling
 * is asserted together with its `+ 1` boundary.
 */

/** No duplicates in a closed union array. */
function expectNoDuplicates(name: string, members: readonly string[]): void {
	expect(new Set(members).size, `${name} must not repeat a member`).toBe(members.length);
}

/** The array is exactly the spec's list, in the spec's order. */
function expectExactMembers(name: string, members: readonly string[], expected: readonly string[]): void {
	expectNoDuplicates(name, members);
	expect([...members], `${name} must be exactly the spec's members, in order`).toEqual(expected);
}

/**
 * The derived union accepts exactly the array's members: the map is typed as a
 * total `Record<Union, true>`, so a member added to the union but not here is a
 * compile error under `pnpm type-check:tests`, while a member added to the array
 * is a runtime mismatch here.
 */
function expectExhaustive<T extends string>(members: readonly T[], exhaustive: Record<T, true>): void {
	expect(Object.keys(exhaustive).sort()).toEqual([...members].sort());
}

describe('builds.ts — closed unions (APW-05 plan.md:417–462)', () => {
	it('APP_BUILD_STATUSES is exactly the six stored statuses of plan.md:323', () => {
		expectExactMembers('APP_BUILD_STATUSES', APP_BUILD_STATUSES, [
			'queued',
			'running',
			'succeeded',
			'failed',
			'cancelled',
			'blocked'
		]);
		expectExhaustive<AppBuildStatus>(APP_BUILD_STATUSES, {
			queued: true,
			running: true,
			succeeded: true,
			failed: true,
			cancelled: true,
			blocked: true
		});
	});

	it('APP_BUILD_TRIGGERS is exactly the four triggers of plan.md:324', () => {
		expectExactMembers('APP_BUILD_TRIGGERS', APP_BUILD_TRIGGERS, [
			'push',
			'pull_request',
			'manual',
			'verification'
		]);
	});

	it('APP_BUILD_FAILURE_CLASSES is exactly the 14 classes of plan.md:419–434', () => {
		expectExactMembers('APP_BUILD_FAILURE_CLASSES', APP_BUILD_FAILURE_CLASSES, [
			'outOfMemory',
			'diskFull',
			'dockerfileError',
			'dependencyDownloadFailed',
			'registryPushDenied',
			'missingBuildValue',
			'secretInImage',
			'timeout',
			'workflowInvalid',
			'digestMismatch',
			'verificationFailed',
			'egressBlocked',
			'lost',
			'unknown'
		]);
	});

	it('APP_BUILD_BLOCKED_REASONS is plan.md:435–451 plus the two the plan adds later', () => {
		expectExactMembers('APP_BUILD_BLOCKED_REASONS', APP_BUILD_BLOCKED_REASONS, [
			'workflowPending',
			'workflowEditedByHand',
			'workflowWriteFailed',
			'actionsDisabled',
			'missingBuildValues',
			'runnerTooSmall',
			'tooManyBuildValues',
			'buildValueTooLarge',
			'secretLimitReached',
			'strategyNotSupported',
			'specInvalid',
			'gitConnectionMissing',
			'repositoryUnavailable',
			'managedConcurrencyLimit',
			'buildValueNameReserved',
			// plan.md:827 — the member §4.5 adds for a port-less unknown build service.
			'buildServicePortRequired',
			// plan.md:1056 — the member §4.10 adds for a verification that needs smtp.
			'verificationDependencyUnsupported'
		]);
	});

	it('APP_BUILD_NOT_DEPLOYABLE_REASONS is exactly plan.md:452–462, in verdict order', () => {
		expectExactMembers('APP_BUILD_NOT_DEPLOYABLE_REASONS', APP_BUILD_NOT_DEPLOYABLE_REASONS, [
			'notSucceeded',
			'pullRequest',
			'verification',
			'specInvalid',
			'staleInputs',
			'secretCheckFailed',
			'digestUnconfirmed',
			'criticalVulnerability',
			'unsigned'
		]);
	});

	it('every other closed union is duplicate-free', () => {
		expectNoDuplicates('APP_BUILD_CANCEL_REASONS', APP_BUILD_CANCEL_REASONS);
		expectNoDuplicates('APP_BUILD_RUNNER_CLASSES', APP_BUILD_RUNNER_CLASSES);
		expectNoDuplicates('APP_BUILD_SIGNATURE_STATES', APP_BUILD_SIGNATURE_STATES);
		expectNoDuplicates('APP_BUILD_STRATEGIES', APP_BUILD_STRATEGIES);
		expectNoDuplicates('APP_BUILD_KINDS', APP_BUILD_KINDS);
		expectNoDuplicates('APP_BUILD_EVENT_NAMES', APP_BUILD_EVENT_NAMES);
	});

	it('APP_BUILD_STRATEGIES is exactly R-13 (plan.md:536)', () => {
		expectExactMembers('APP_BUILD_STRATEGIES', APP_BUILD_STRATEGIES, ['dockerfile', 'image', 'auto', 'none']);
	});

	it('APP_BUILD_CANCEL_REASONS is exactly plan.md:326', () => {
		expectExactMembers('APP_BUILD_CANCEL_REASONS', APP_BUILD_CANCEL_REASONS, ['user', 'superseded']);
	});
});

describe('builds.ts — status to event (APW-05 plan.md:1538–1547)', () => {
	it('maps every status exactly as the table says, and blocked publishes nothing', () => {
		expect(appBuildEventNameForStatus('queued')).toBe('app.build.queued');
		expect(appBuildEventNameForStatus('running')).toBe('app.build.started');
		expect(appBuildEventNameForStatus('succeeded')).toBe('app.build.succeeded');
		expect(appBuildEventNameForStatus('failed')).toBe('app.build.failed');
		expect(appBuildEventNameForStatus('cancelled')).toBe('app.build.cancelled');
		expect(appBuildEventNameForStatus('blocked')).toBeNull();
	});

	it('is total over the status union — a future status cannot map to a hole', () => {
		for (const status of APP_BUILD_STATUSES) {
			expect(Object.prototype.hasOwnProperty.call(APP_BUILD_STATUS_EVENT_MAP, status), status).toBe(true);
		}
		expect(Object.keys(APP_BUILD_STATUS_EVENT_MAP)).toHaveLength(APP_BUILD_STATUSES.length);
	});

	it('APP_BUILD_EVENT_NAMES is exactly the five CONTRACTS §6 names of plan.md:1510–1512', () => {
		expectExactMembers('APP_BUILD_EVENT_NAMES', APP_BUILD_EVENT_NAMES, [
			'app.build.queued',
			'app.build.started',
			'app.build.succeeded',
			'app.build.failed',
			'app.build.cancelled'
		]);
		// `blocked` is deliberately absent: it is not a CONTRACTS §6 name (plan.md:1547).
		expect([...APP_BUILD_EVENT_NAMES]).not.toContain('app.build.blocked');
	});
});

describe('builds.ts — failure copy and blocked actions (spec.md:520–573)', () => {
	it('every failure class has a copy entry — a new class without copy fails here', () => {
		for (const failureClass of APP_BUILD_FAILURE_CLASSES) {
			const copy = APP_BUILD_FAILURE_COPY_EN[failureClass];
			expect(copy, `APP_BUILD_FAILURE_COPY_EN is missing ${failureClass}`).toBeDefined();
			expect(copy.title.trim().length, `${failureClass}.title`).toBeGreaterThan(0);
			expect(copy.suggestion.trim().length, `${failureClass}.suggestion`).toBeGreaterThan(0);
		}
		expect(Object.keys(APP_BUILD_FAILURE_COPY_EN)).toHaveLength(APP_BUILD_FAILURE_CLASSES.length);
	});

	it('pins the verbatim titles of spec.md:520–535', () => {
		expect(APP_BUILD_FAILURE_COPY_EN.outOfMemory.title).toBe('Ran out of memory');
		expect(APP_BUILD_FAILURE_COPY_EN.diskFull.title).toBe('Ran out of disk space');
		expect(APP_BUILD_FAILURE_COPY_EN.dockerfileError.title).toBe('The Dockerfile failed at step {step} of {total}');
		expect(APP_BUILD_FAILURE_COPY_EN.dependencyDownloadFailed.title).toBe("Couldn't download dependencies");
		expect(APP_BUILD_FAILURE_COPY_EN.registryPushDenied.title).toBe("Couldn't push the image");
		expect(APP_BUILD_FAILURE_COPY_EN.missingBuildValue.title).toBe('A build value is missing: {names}');
		expect(APP_BUILD_FAILURE_COPY_EN.secretInImage.title).toBe(
			'A secret would have been published inside the image: {name}'
		);
		expect(APP_BUILD_FAILURE_COPY_EN.timeout.title).toBe('Took longer than {minutes} minutes');
		expect(APP_BUILD_FAILURE_COPY_EN.workflowInvalid.title).toBe('The workflow file is invalid');
		expect(APP_BUILD_FAILURE_COPY_EN.digestMismatch.title).toBe('The pushed image could not be confirmed');
		expect(APP_BUILD_FAILURE_COPY_EN.verificationFailed.title).toBe("The app didn't pass its smoke tests");
		expect(APP_BUILD_FAILURE_COPY_EN.egressBlocked.title).toBe('Network access was blocked');
		expect(APP_BUILD_FAILURE_COPY_EN.lost.title).toBe('Lost track of this build');
		expect(APP_BUILD_FAILURE_COPY_EN.unknown.title).toBe('Something else went wrong');
	});

	it('pins the timeout ceiling the copy states (spec.md:529)', () => {
		expect(APP_BUILD_FAILURE_COPY_EN.timeout.suggestion).toContain('maximum 180');
	});

	it('every blocked reason maps to an action key — a new reason without a decision fails here', () => {
		for (const reason of APP_BUILD_BLOCKED_REASONS) {
			expect(
				Object.prototype.hasOwnProperty.call(APP_BUILD_BLOCKED_REASON_ACTIONS, reason),
				`APP_BUILD_BLOCKED_REASON_ACTIONS is missing ${reason}`
			).toBe(true);
			const action = APP_BUILD_BLOCKED_REASON_ACTIONS[reason];
			if (action !== null) {
				expect([...APP_BUILD_BLOCKED_ACTIONS], `${reason} names an unknown action`).toContain(action);
			}
		}
		expect(Object.keys(APP_BUILD_BLOCKED_REASON_ACTIONS)).toHaveLength(APP_BUILD_BLOCKED_REASONS.length);
	});

	it('APP_BUILD_BLOCKED_ACTIONS is exactly the eight i18n leaves of plan.md:1582', () => {
		expectExactMembers('APP_BUILD_BLOCKED_ACTIONS', APP_BUILD_BLOCKED_ACTIONS, [
			'reviewPullRequest',
			'turnOnActions',
			'setValue',
			'useLargerRunner',
			'openRepositorySettings',
			'reconnectGithub',
			'rebuild',
			'openEnvironment'
		]);
	});

	it('pins the reason to action pairs of spec.md:547–573', () => {
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.workflowPending).toBe('reviewPullRequest');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.workflowEditedByHand).toBe('reviewPullRequest');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.workflowWriteFailed).toBe('rebuild');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.actionsDisabled).toBe('turnOnActions');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.missingBuildValues).toBe('setValue');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.runnerTooSmall).toBe('useLargerRunner');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.tooManyBuildValues).toBe('openEnvironment');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.buildValueTooLarge).toBe('openEnvironment');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.buildServicePortRequired).toBe('openEnvironment');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.buildValueNameReserved).toBe('openEnvironment');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.secretLimitReached).toBe('openRepositorySettings');
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.gitConnectionMissing).toBe('reconnectGithub');
		// The five notices spec.md:568–572 draws with no action at all.
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.verificationDependencyUnsupported).toBeNull();
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.strategyNotSupported).toBeNull();
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.specInvalid).toBeNull();
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.repositoryUnavailable).toBeNull();
		expect(APP_BUILD_BLOCKED_REASON_ACTIONS.managedConcurrencyLimit).toBeNull();
	});
});

describe('builds.ts — numeric limits (APW-05 plan.md:503–541)', () => {
	it('pins the count ceilings with their +1 boundary', () => {
		// plan.md:508 — §4.7:901 refuses more than 50 values.
		expect(APP_BUILD_MAX_VALUES).toBe(50);
		expect(APP_BUILD_MAX_VALUES + 1).toBe(51);
		// plan.md:539 — §4.14:1144 caps App spec checks at 20.
		expect(APP_BUILD_CHECKS_MAX).toBe(20);
		expect(APP_BUILD_CHECKS_MAX + 1).toBe(21);
		// plan.md:540 — `max-parallel` of the checks matrix.
		expect(APP_BUILD_CHECKS_MAX_PARALLEL).toBe(5);
		// plan.md:520–521 — §4.9:1000 keeps the last 20 lines, each cut to 300 characters.
		expect(APP_BUILD_EXCERPT_MAX_LINES).toBe(20);
		expect(APP_BUILD_EXCERPT_MAX_LINES + 1).toBe(21);
		expect(APP_BUILD_EXCERPT_MAX_LINE_CHARS).toBe(300);
		expect(APP_BUILD_EXCERPT_MAX_LINE_CHARS + 1).toBe(301);
		// plan.md:531–532 — the Builds-list page bounds of §5:1183.
		expect(APP_BUILD_LIST_PAGE_SIZE).toBe(20);
		expect(APP_BUILD_LIST_MAX_PAGE_SIZE).toBe(100);
		expect(APP_BUILD_LIST_MAX_PAGE_SIZE + 1).toBe(101);
		// plan.md:510 — §4.11:1075 skips values shorter than 8 characters.
		expect(APP_BUILD_SECRET_CHECK_MIN_CHARS).toBe(8);
	});

	it('pins the byte ceilings with their +1 boundary', () => {
		// plan.md:509 — §4.7:902 refuses any value over 48,000 bytes.
		expect(APP_BUILD_SECRET_MAX_BYTES).toBe(48_000);
		expect(APP_BUILD_SECRET_MAX_BYTES + 1).toBe(48_001);
		// plan.md:529 — §4.10:1026 caps the base64url plan at 60,000 characters.
		expect(APP_BUILD_VERIFY_PLAN_MAX_CHARS).toBe(60_000);
		expect(APP_BUILD_VERIFY_PLAN_MAX_CHARS + 1).toBe(60_001);
	});

	it('pins the verification window and memory of FR-53 (plan.md:527–528)', () => {
		expect(APP_BUILD_VERIFY_TIMEOUT_MINUTES).toBe(30);
		expect(APP_BUILD_VERIFY_TIMEOUT_MINUTES + 1).toBe(31);
		expect(APP_BUILD_VERIFY_MEMORY_GIB).toBe(12);
		expect(APP_BUILD_VERIFY_MEMORY_GIB + 1).toBe(13);
	});

	it('pins the managed plan, its ceilings and its concurrency (plan.md:533–535)', () => {
		expect(APP_BUILD_MANAGED_DEFAULTS).toEqual({ vcpu: 4, memoryGiB: 12, diskGiB: 30, timeoutMinutes: 60 });
		expect(APP_BUILD_MANAGED_MAXIMUMS).toEqual({ vcpu: 16, memoryGiB: 64, timeoutMinutes: 180 });
		expect(APP_BUILD_MANAGED_MAXIMUMS.timeoutMinutes).toBe(APP_BUILD_MANAGED_DEFAULTS.timeoutMinutes * 3);
		expect(APP_BUILD_MANAGED_CONCURRENCY).toEqual({ perAppWork: 1, perAccount: 3 });
	});

	it('pins the names, paths and reserved value of plan.md:503–507, 541', () => {
		expect(APP_BUILD_WORKFLOW_PATH).toBe('.github/workflows/ever-works-build.yml');
		expect(APP_BUILD_WORKFLOW_BRANCH).toBe('ever-works/build-workflow');
		expect(APP_BUILD_SECRET_PREFIX).toBe('EW_');
		expect(APP_BUILD_VERIFY_PROMPTED_SECRET).toBe('EW_VERIFY__PROMPTED');
		expect(APP_BUILD_CHECK_NAME_PREFIX).toBe('Ever Works check: ');
		// XC-01 / plan.md:928 — a fixed non-secret marker, never a stored value.
		expect(APP_BUILD_RESTRICTED_VALUE_LITERAL).toBe('ew-restricted');
	});

	it('pins the runner table of plan.md:523–526', () => {
		expect(APP_BUILD_RUNNERS.githubPublic).toEqual({
			label: 'ubuntu-latest',
			vcpu: 4,
			memoryGiB: 16,
			runnerClass: 'github-public'
		});
		expect(APP_BUILD_RUNNERS.githubPrivate).toEqual({
			label: 'ubuntu-latest',
			vcpu: 2,
			memoryGiB: 7,
			runnerClass: 'github-private'
		});
		expect(APP_BUILD_RUNNER_HEADROOM_GIB).toBe(2);
	});

	it('pins the sweep cron of plan.md:1399', () => {
		expect(APP_BUILD_SWEEP_CRON).toBe('*/2 * * * *');
	});
});

describe('builds.ts — runner fit boundary (APW-05 plan.md:1330–1332, FR-23)', () => {
	it('reserves 2 GiB of the runner total', () => {
		expect(appBuildRunnerCapacity(APP_BUILD_RUNNERS.githubPublic)).toEqual({ vcpu: 4, memoryGiB: 14 });
		expect(appBuildRunnerCapacity(APP_BUILD_RUNNERS.githubPrivate)).toEqual({ vcpu: 2, memoryGiB: 5 });
	});

	it('accepts a declaration exactly at the ceiling and refuses ceiling + 1', () => {
		const capacity = appBuildRunnerCapacity(APP_BUILD_RUNNERS.githubPublic).memoryGiB;
		expect(evaluateBuildRunnerFit(APP_BUILD_RUNNERS.githubPublic, capacity).fits).toBe(true);
		const over = evaluateBuildRunnerFit(APP_BUILD_RUNNERS.githubPublic, capacity + 1);
		expect(over.fits).toBe(false);
		expect(over).toEqual({ fits: false, blockedReason: 'runnerTooSmall', maxMemoryGiB: capacity });
	});

	it('never blocks a Build when memory is absent (APW05-G14, FR-23)', () => {
		expect(evaluateBuildRunnerFit(APP_BUILD_RUNNERS.githubPrivate, undefined).fits).toBe(true);
	});
});

describe('builds.ts — BUILD_SERVICE_DEFAULTS (APW-05 plan.md:810–833)', () => {
	it('pins the loopback host and the recognised env defaults', () => {
		expect(BUILD_SERVICE_HOST).toBe('127.0.0.1');
		expect(BUILD_SERVICE_DEFAULTS.postgres.env).toEqual({
			POSTGRES_USER: 'ever-works-build',
			POSTGRES_PASSWORD: 'ever-works-build',
			POSTGRES_DB: 'app'
		});
		expect(BUILD_SERVICE_DEFAULTS.redis.env).toEqual({});
		expect(BUILD_SERVICE_DEFAULTS.minio.env).toEqual({
			MINIO_ROOT_USER: 'ever-works-build',
			MINIO_ROOT_PASSWORD: 'ever-works-build'
		});
		// The spec names the SMTP row by description, not by image prefix (plan.md:821),
		// so it is selected by service name and carries no prefix rule.
		expect(BUILD_SERVICE_DEFAULTS.smtp.imagePrefixes).toEqual([]);
	});

	it('pins the container ports of plan.md:816–821', () => {
		expect(BUILD_SERVICE_DEFAULTS.postgres.containerPort).toBe(5432);
		expect(BUILD_SERVICE_DEFAULTS.redis.containerPort).toBe(6379);
		expect(BUILD_SERVICE_DEFAULTS.minio.containerPort).toBe(9000);
		expect(BUILD_SERVICE_DEFAULTS.smtp.containerPort).toBe(1025);
	});

	it('matches images by the plan prefix rule and reports an unknown image as null', () => {
		expect(resolveBuildServiceKind('postgres:16')).toBe('postgres');
		expect(resolveBuildServiceKind('redis:7-alpine')).toBe('redis');
		expect(resolveBuildServiceKind('minio/minio:latest')).toBe('minio');
		expect(resolveBuildServiceKind('registry.example.com/acme/db:1')).toBeNull();
	});

	it('lets a declared env replace only the default of the same name (plan.md:823)', () => {
		expect(resolveBuildServiceEnv('postgres', [{ name: 'POSTGRES_DB', value: 'other' }])).toEqual({
			POSTGRES_USER: 'ever-works-build',
			POSTGRES_PASSWORD: 'ever-works-build',
			POSTGRES_DB: 'other'
		});
		expect(resolveBuildServiceEnv('redis', [{ name: 'REDIS_ARGS', value: '--appendonly yes' }])).toEqual({
			REDIS_ARGS: '--appendonly yes'
		});
		expect(resolveBuildServiceEnv('postgres')).toEqual(BUILD_SERVICE_DEFAULTS.postgres.env);
	});

	it('emits "<published>:<container port>" and requires a port for an unknown image', () => {
		expect(resolveBuildServicePort('postgres:16')).toBe('5432:5432');
		expect(resolveBuildServicePort('postgres:16', 5433)).toBe('5433:5432');
		expect(resolveBuildServicePort('minio/minio:latest')).toBe('9000:9000');
		expect(resolveBuildServicePort('registry.example.com/acme/db:1')).toBeNull();
		expect(resolveBuildServicePort('registry.example.com/acme/db:1', 8080)).toBe('8080:8080');
	});

	it('blocks an unknown service without a port instead of emitting one (plan.md:825–827)', () => {
		expect(evaluateBuildServicePort({ name: 'db', image: 'registry.example.com/acme/db:1' })).toEqual({
			ok: false,
			blockedReason: 'buildServicePortRequired'
		});
		expect(evaluateBuildServicePort({ name: 'db', image: 'registry.example.com/acme/db:1', port: 8080 })).toEqual({
			ok: true,
			published: '8080:8080'
		});
	});
});

describe('builds.ts — check-run naming (APW-05 plan.md:1150–1151)', () => {
	it('renders exactly "Ever Works check: {name}"', () => {
		expect(appBuildCheckName('lint')).toBe('Ever Works check: lint');
		expect(appBuildCheckName('type-check')).toBe('Ever Works check: type-check');
	});

	it('recognises only its own prefixes', () => {
		expect(isAppBuildCheckJobName(appBuildCheckName('lint'))).toBe(true);
		expect(isAppBuildCheckJobName('build')).toBe(false);
		expect(isAppBuildCheckJobName('Ever Works check lint')).toBe(false);
	});
});

describe('builds.ts — buildFailureExcerpt (APW-05 plan.md:1000)', () => {
	it('keeps at most 20 lines, ending at the matched line', () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
		const excerpt = buildFailureExcerpt(lines, 30);
		expect(excerpt).toHaveLength(APP_BUILD_EXCERPT_MAX_LINES);
		expect(excerpt[excerpt.length - 1]).toBe('line 30');
		expect(excerpt[0]).toBe('line 11');
	});

	it('is unchanged at 19 lines and trims at 20 and 21 (+1 / -1 boundary)', () => {
		const nineteen = Array.from({ length: APP_BUILD_EXCERPT_MAX_LINES - 1 }, (_, index) => `l${index}`);
		const twenty = Array.from({ length: APP_BUILD_EXCERPT_MAX_LINES }, (_, index) => `l${index}`);
		expect(buildFailureExcerpt(nineteen)).toHaveLength(APP_BUILD_EXCERPT_MAX_LINES - 1);
		expect(buildFailureExcerpt(twenty)).toHaveLength(APP_BUILD_EXCERPT_MAX_LINES);
		expect(buildFailureExcerpt([...twenty, 'l20'])).toHaveLength(APP_BUILD_EXCERPT_MAX_LINES);
	});

	it('cuts each line at 300 characters (300 kept, 301 cut)', () => {
		const atLimit = 'x'.repeat(APP_BUILD_EXCERPT_MAX_LINE_CHARS);
		const overLimit = 'y'.repeat(APP_BUILD_EXCERPT_MAX_LINE_CHARS + 1);
		const excerpt = buildFailureExcerpt([atLimit, overLimit]);
		expect(excerpt[0]).toHaveLength(APP_BUILD_EXCERPT_MAX_LINE_CHARS);
		expect(excerpt[1]).toHaveLength(APP_BUILD_EXCERPT_MAX_LINE_CHARS);
	});

	it('defaults to the last 20 lines when no match line is given', () => {
		const lines = Array.from({ length: 25 }, (_, index) => `line ${index}`);
		const excerpt = buildFailureExcerpt(lines);
		expect(excerpt[0]).toBe('line 5');
		expect(excerpt).toHaveLength(APP_BUILD_EXCERPT_MAX_LINES);
	});
});

describe('builds.ts — sha256Hex known-answer vectors (FIPS 180-4)', () => {
	it('hashes the empty string', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('hashes "abc"', () => {
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('hashes a 56-character message (the padding-block boundary)', () => {
		expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
		);
	});
});

describe('builds.ts — computeBuildInputsHash (APW-05 plan.md:905, 1244)', () => {
	it('is deterministic for the same input', () => {
		const values = [
			{ name: 'DATABASE_URL', fingerprint: 'v3' },
			{ name: 'API_KEY', fingerprint: 'v1' }
		];
		expect(computeBuildInputsHash(values)).toBe(computeBuildInputsHash(values));
		// A structurally identical rebuild of the same list must hash identically —
		// the hash is over the values, not over the array identity.
		expect(computeBuildInputsHash([...values])).toBe(computeBuildInputsHash(values));
	});

	it('is independent of the resolver iteration order', () => {
		const sorted = [
			{ name: 'API_KEY', fingerprint: 'v1' },
			{ name: 'DATABASE_URL', fingerprint: 'v3' }
		];
		expect(computeBuildInputsHash([...sorted].reverse())).toBe(computeBuildInputsHash(sorted));
	});

	it('changes when one fingerprint changes', () => {
		const before = [{ name: 'API_KEY', fingerprint: 'v1' }];
		const after = [{ name: 'API_KEY', fingerprint: 'v2' }];
		expect(computeBuildInputsHash(after)).not.toBe(computeBuildInputsHash(before));
	});

	it('changes when one name changes', () => {
		expect(computeBuildInputsHash([{ name: 'A', fingerprint: 'v1' }])).not.toBe(
			computeBuildInputsHash([{ name: 'B', fingerprint: 'v1' }])
		);
	});

	it('changes when a value is added', () => {
		const one = [{ name: 'A', fingerprint: 'v1' }];
		const two = [...one, { name: 'B', fingerprint: 'v1' }];
		expect(computeBuildInputsHash(two)).not.toBe(computeBuildInputsHash(one));
	});

	it('hashes the empty list to sha256("") — the zero-value preparation of plan.md:1250', () => {
		expect(computeBuildInputsHash([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('refuses a name or a fingerprint containing a separator, so the encoding stays injective', () => {
		// Without this guard `{name:'A', fingerprint:'B\0C'}` and `{name:'A\0B',
		// fingerprint:'C'}` would render the same canonical string. Env names match
		// APW-07's `^[A-Z_][A-Z0-9_]{0,127}$` and every fingerprint is `v<n>`,
		// `d<n>`, `t<hex>` or a hex digest, so neither can occur in practice.
		expect(() => computeBuildInputsHash([{ name: 'A', fingerprint: 'B\u0000C' }])).toThrow(/fingerprint/);
		expect(() => computeBuildInputsHash([{ name: 'A\u0000B', fingerprint: 'C' }])).toThrow(/env name/);
		expect(() => computeBuildInputsHash([{ name: 'A', fingerprint: 'B\u0001C' }])).toThrow(/fingerprint/);
	});

	it('returns 64 lower-case hex characters', () => {
		expect(computeBuildInputsHash([{ name: 'API_KEY', fingerprint: 'v1' }])).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe('builds.ts — evaluateBuildDeployability (APW-05 plan.md:1232–1242)', () => {
	const deployableInput: AppBuildDeployabilityInput = {
		status: 'succeeded',
		trigger: 'push',
		branch: 'main',
		trackedBranch: 'main',
		specValidAtCommit: true,
		secretsSyncedAtEpochMs: 1_000,
		startedAtEpochMs: 1_000,
		buildInputsHash: 'hash',
		currentInputsHash: 'hash',
		secretCheck: 'passed',
		digestConfirmed: true,
		buildKind: 'github-actions',
		signatureState: null,
		scan: null,
		policy: { blockFixableCritical: false }
	};

	it('reports the happy path as deployable with no reason', () => {
		expect(evaluateBuildDeployability(deployableInput)).toEqual({ deployable: true, notDeployableReason: null });
	});

	it('returns the FIRST failing clause, in the plan order', () => {
		// Everything wrong at once: `notSucceeded` outranks every later clause.
		const everythingWrong: AppBuildDeployabilityInput = {
			...deployableInput,
			status: 'failed',
			trigger: 'pull_request',
			branch: 'feature',
			specValidAtCommit: null,
			secretsSyncedAtEpochMs: null,
			buildInputsHash: null,
			secretCheck: 'failed',
			digestConfirmed: false
		};
		expect(evaluateBuildDeployability(everythingWrong).notDeployableReason).toBe('notSucceeded');
	});

	it('refuses a verification Build with `verification` (FR-54)', () => {
		expect(evaluateBuildDeployability({ ...deployableInput, trigger: 'verification' }).notDeployableReason).toBe(
			'verification'
		);
	});

	it('refuses a pull-request Build with `pullRequest`', () => {
		expect(evaluateBuildDeployability({ ...deployableInput, trigger: 'pull_request' }).notDeployableReason).toBe(
			'pullRequest'
		);
	});

	it('refuses a Build of another branch with `pullRequest`', () => {
		expect(evaluateBuildDeployability({ ...deployableInput, branch: 'feature' }).notDeployableReason).toBe(
			'pullRequest'
		);
	});

	it('treats a null specValidAtCommit as `specInvalid`', () => {
		expect(evaluateBuildDeployability({ ...deployableInput, specValidAtCommit: null }).notDeployableReason).toBe(
			'specInvalid'
		);
	});

	it('accepts a sync exactly at startedAt and refuses one millisecond later', () => {
		expect(
			evaluateBuildDeployability({ ...deployableInput, secretsSyncedAtEpochMs: 1_000, startedAtEpochMs: 1_000 })
				.deployable
		).toBe(true);
		expect(
			evaluateBuildDeployability({ ...deployableInput, secretsSyncedAtEpochMs: 1_001, startedAtEpochMs: 1_000 })
				.notDeployableReason
		).toBe('staleInputs');
	});

	it('treats a null hash or a null stamp as `staleInputs` (plan.md:1247)', () => {
		expect(evaluateBuildDeployability({ ...deployableInput, buildInputsHash: null }).notDeployableReason).toBe(
			'staleInputs'
		);
		expect(
			evaluateBuildDeployability({ ...deployableInput, secretsSyncedAtEpochMs: null }).notDeployableReason
		).toBe('staleInputs');
		expect(evaluateBuildDeployability({ ...deployableInput, startedAtEpochMs: null }).notDeployableReason).toBe(
			'staleInputs'
		);
	});

	it('treats a rotated value as `staleInputs`', () => {
		expect(evaluateBuildDeployability({ ...deployableInput, currentInputsHash: 'other' }).notDeployableReason).toBe(
			'staleInputs'
		);
	});

	it('accepts `not_needed` and refuses `failed` and a null secret check', () => {
		expect(evaluateBuildDeployability({ ...deployableInput, secretCheck: 'not_needed' }).deployable).toBe(true);
		expect(evaluateBuildDeployability({ ...deployableInput, secretCheck: 'failed' }).notDeployableReason).toBe(
			'secretCheckFailed'
		);
		expect(evaluateBuildDeployability({ ...deployableInput, secretCheck: null }).notDeployableReason).toBe(
			'secretCheckFailed'
		);
	});

	it('refuses an unconfirmed digest', () => {
		expect(evaluateBuildDeployability({ ...deployableInput, digestConfirmed: false }).notDeployableReason).toBe(
			'digestUnconfirmed'
		);
	});

	it('refuses an unsigned managed Build and accepts a signed one', () => {
		expect(
			evaluateBuildDeployability({ ...deployableInput, buildKind: 'apps-builder', signatureState: 'unsigned' })
				.notDeployableReason
		).toBe('unsigned');
		expect(
			evaluateBuildDeployability({ ...deployableInput, buildKind: 'apps-builder', signatureState: 'signed' })
				.deployable
		).toBe(true);
	});

	it('applies the fixable-critical clause only to the managed builder, at 0 vs 1', () => {
		const scan = { critical: 3, high: 1, medium: 0, low: 0, fixableCritical: 1 };
		expect(
			evaluateBuildDeployability({
				...deployableInput,
				buildKind: 'apps-builder',
				signatureState: 'signed',
				scan,
				policy: { blockFixableCritical: true }
			}).notDeployableReason
		).toBe('criticalVulnerability');
		expect(
			evaluateBuildDeployability({
				...deployableInput,
				buildKind: 'apps-builder',
				signatureState: 'signed',
				scan: { ...scan, fixableCritical: 0 },
				policy: { blockFixableCritical: true }
			}).deployable
		).toBe(true);
		// The clause is scoped to `buildKind === 'apps-builder'` — a GitHub-hosted
		// Build is unaffected by a scan it never produced.
		expect(
			evaluateBuildDeployability({ ...deployableInput, scan, policy: { blockFixableCritical: true } }).deployable
		).toBe(true);
	});
});

describe('builds.ts — AppVerificationPlan v1 limits (plan.md:1042–1050, verify-plan.schema.json)', () => {
	it('pins the version literal', () => {
		expect(APP_VERIFICATION_PLAN_VERSION).toBe(1);
	});

	it('pins the array caps with their +1 boundary', () => {
		// verify-plan.schema.json:14, 19, 24, 30, 34.
		expect(APP_BUILD_VERIFY_PLAN_MAX_COMPONENTS).toBe(10);
		expect(APP_BUILD_VERIFY_PLAN_MAX_COMPONENTS + 1).toBe(11);
		expect(APP_BUILD_VERIFY_PLAN_MAX_DEPENDENCIES).toBe(3);
		expect(APP_BUILD_VERIFY_PLAN_MAX_DEPENDENCIES + 1).toBe(4);
		expect(APP_BUILD_VERIFY_PLAN_MAX_JOBS).toBe(10);
		expect(APP_BUILD_VERIFY_PLAN_MAX_JOBS + 1).toBe(11);
		expect(APP_BUILD_VERIFY_PLAN_MAX_SMOKE).toBe(20);
		expect(APP_BUILD_VERIFY_PLAN_MAX_SMOKE + 1).toBe(21);
		expect(APP_BUILD_VERIFY_PLAN_MAX_ENV_ENTRIES).toBe(100);
		expect(APP_BUILD_VERIFY_PLAN_MAX_ENV_ENTRIES + 1).toBe(101);
		// plan.md:341 sizes the STORED column separately from the plan input.
		expect(APP_BUILD_VERIFICATION_RESULT_MAX_SMOKE).toBe(50);
		expect(APP_BUILD_VERIFICATION_RESULT_MAX_SMOKE).toBeGreaterThan(APP_BUILD_VERIFY_PLAN_MAX_SMOKE);
	});

	it('pins the fixed dependency container names of plan.md:1052', () => {
		expect(APP_VERIFICATION_DEPENDENCY_CONTAINERS).toEqual({
			postgres: 'ew-dep-postgres',
			redis: 'ew-dep-redis',
			objectStorage: 'ew-dep-object-storage'
		});
	});
});

describe('app-env.ts — closed unions (APW-07 plan.md:237–258)', () => {
	it('APP_ENV_ORIGINS is exactly plan.md:237 and the stored subset is plan.md:182', () => {
		expectExactMembers('APP_ENV_ORIGINS', APP_ENV_ORIGINS, ['generated', 'derived', 'prompted', 'user', 'default']);
		expectExhaustive<AppEnvOrigin>(APP_ENV_ORIGINS, {
			generated: true,
			derived: true,
			prompted: true,
			user: true,
			default: true
		});
		// `default` is not a stored origin: it describes a row that follows the spec.
		expect([...APP_ENV_STORED_ORIGINS]).not.toContain('default');
	});

	it('APP_ENV_PHASES is exactly plan.md:238', () => {
		expectExactMembers('APP_ENV_PHASES', APP_ENV_PHASES, ['build', 'runtime', 'both']);
		expectExhaustive<AppEnvPhase>(APP_ENV_PHASES, { build: true, runtime: true, both: true });
	});

	it('APP_ENV_GENERATOR_KINDS is exactly FR-10 (plan.md:239)', () => {
		expectExactMembers('APP_ENV_GENERATOR_KINDS', APP_ENV_GENERATOR_KINDS, [
			'base64',
			'hex',
			'chars',
			'uuid',
			'keypair'
		]);
	});

	it('APP_ENV_KEYPAIR_TYPES and FORMATS are exactly FR-14 and R-11 (plan.md:246–247)', () => {
		expectExactMembers('APP_ENV_KEYPAIR_TYPES', APP_ENV_KEYPAIR_TYPES, [
			'ed25519',
			'ec-p256',
			'rsa-2048',
			'rsa-4096'
		]);
		expectExactMembers('APP_ENV_KEYPAIR_FORMATS', APP_ENV_KEYPAIR_FORMATS, ['pem', 'base64url-raw', 'pkcs12']);
		expectExactMembers('APP_ENV_KEYPAIR_RAW_TYPES', APP_ENV_KEYPAIR_RAW_TYPES, ['ed25519', 'ec-p256']);
		expect(APP_ENV_KEYPAIR_DEFAULT_FORMAT).toBe('pem');
	});

	it('APP_ENV_RECIPE_SOURCES is the union of the plan and the verify-plan schema', () => {
		expectExactMembers('APP_ENV_RECIPE_SOURCES', APP_ENV_RECIPE_SOURCES, [
			'generate',
			'literal',
			'template',
			'prompted',
			'derived'
		]);
		expectExhaustive<AppEnvRecipeSource>(APP_ENV_RECIPE_SOURCES, {
			generate: true,
			literal: true,
			template: true,
			prompted: true,
			derived: true
		});
	});

	it('every other app-env union is duplicate-free', () => {
		expectNoDuplicates('APP_ENV_PUBLIC_PREFIXES', APP_ENV_PUBLIC_PREFIXES);
		expectNoDuplicates('APP_ENV_VALIDATION_REFUSAL_CODES', APP_ENV_VALIDATION_REFUSAL_CODES);
		expectNoDuplicates('APP_ENV_UNRESOLVED_REASONS', APP_ENV_UNRESOLVED_REASONS);
	});

	it('APP_ENV_PUBLIC_PREFIXES is exactly FR-20 (plan.md:251–258)', () => {
		expectExactMembers('APP_ENV_PUBLIC_PREFIXES', APP_ENV_PUBLIC_PREFIXES, [
			'NEXT_PUBLIC_',
			'VITE_',
			'PUBLIC_',
			'REACT_APP_',
			'NUXT_PUBLIC_',
			'EXPO_PUBLIC_'
		]);
	});

	it('APP_ENV_UNRESOLVED_REASONS is exactly plan.md:121–125 and 449', () => {
		expectExactMembers('APP_ENV_UNRESOLVED_REASONS', APP_ENV_UNRESOLVED_REASONS, [
			'missingRequired',
			'noPrimaryDomain',
			'noBuildService',
			'dependencyNotReady',
			'notAvailableAtBuild',
			'relayNotSelected',
			'templateUnresolvable'
		]);
	});
});

describe('app-env.ts — numbers and alphabets (APW-07 plan.md:249–269)', () => {
	it('pins the alphabets exactly (FR-10: alnum 62 characters)', () => {
		expect(APP_ENV_ALPHABETS.alnum).toHaveLength(62);
		expect(APP_ENV_ALPHABETS['alnum-symbols'].startsWith(APP_ENV_ALPHABETS.alnum)).toBe(true);
		expect(APP_ENV_ALPHABETS['alnum-symbols'].slice(62)).toBe('!#%+,-.:=?@^_~');
		expect(APP_ENV_ALPHABETS['hex-lower']).toBe('0123456789abcdef');
		expect(APP_ENV_ALPHABETS.base64url).toHaveLength(64);
	});

	it('pins the name grammar, reserved prefix and public-half ceiling (FR-15, FR-18)', () => {
		expect(APP_ENV_NAME_PATTERN).toBe('^[A-Z_][A-Z0-9_]{0,127}$');
		expect(APP_ENV_RESERVED_PREFIX).toBe('EVER_WORKS_');
		expect(APP_ENV_PUBLIC_HALF_SUFFIX).toBe('_PUBLIC');
		expect(APP_ENV_PUBLIC_HALF_MAX_BYTES).toBe(16_384);
		expect(APP_ENV_PUBLIC_HALF_MAX_BYTES + 1).toBe(16_385);
	});

	it('pins the value and total ceilings with their +1 boundary (FR-18, FR-31)', () => {
		expect(APP_ENV_VALUE_MAX_BYTES).toBe(65_536);
		expect(APP_ENV_VALUE_MAX_BYTES + 1).toBe(65_537);
		expect(APP_ENV_TOTAL_MAX_BYTES).toBe(1_048_576);
		expect(APP_ENV_TOTAL_MAX_BYTES + 1).toBe(1_048_577);
		expect(APP_ENV_MAX_STORED).toBe(300);
		expect(APP_ENV_MAX_STORED + 1).toBe(301);
	});

	it('pins the dotenv, pattern-budget, SLA and rate limits (FR-9, FR-13, FR-17, FR-28, FR-34)', () => {
		expect(APP_ENV_DOTENV_MAX_BYTES).toBe(65_536);
		expect(APP_ENV_DOTENV_MAX_LINES).toBe(500);
		expect(APP_ENV_DOTENV_MAX_LINES + 1).toBe(501);
		expect(APP_ENV_PATTERN_BUDGET_MS).toBe(50);
		expect(APP_ENV_ROTATIONS_PER_HOUR).toBe(10);
		expect(APP_ENV_PUTS_PER_MINUTE).toBe(30);
		expect(APP_ENV_TEMPLATE_MAX_DEPTH).toBe(10);
		expect(APP_ENV_TEMPLATE_MAX_DEPTH + 1).toBe(11);
		expect(APP_ENV_REDACT_MIN_CHARS).toBe(6);
	});
});

describe('app-env.ts — pure helpers (APW-07 plan.md:397, 447, FR-14)', () => {
	it('derives <NAME>_PUBLIC from the entry name (FR-14)', () => {
		expect(appEnvPublicHalfName('JWT_KEY')).toBe('JWT_KEY_PUBLIC');
	});

	it('uppercases the dependency kind into DEP_<KIND>_PASSWORD (plan.md:447)', () => {
		expect(appEnvDependencyPasswordToken('postgres')).toBe('DEP_POSTGRES_PASSWORD');
		expect(appEnvDependencyPasswordToken('objectStorage')).toBe('DEP_OBJECTSTORAGE_PASSWORD');
	});

	it('refuses base64url-raw for RSA and pkcs12 without a password entry (FR-14, R-11)', () => {
		expect(appEnvKeypairFormatSupported('ed25519', 'base64url-raw')).toBe(true);
		expect(appEnvKeypairFormatSupported('ec-p256', 'base64url-raw')).toBe(true);
		expect(appEnvKeypairFormatSupported('rsa-2048', 'base64url-raw')).toBe(false);
		expect(appEnvKeypairFormatSupported('rsa-4096', 'base64url-raw')).toBe(false);
		expect(appEnvKeypairFormatSupported('rsa-4096', 'pkcs12')).toBe(false);
		expect(appEnvKeypairFormatSupported('rsa-4096', 'pkcs12', 'PKCS12_PASSPHRASE')).toBe(true);
		expect(appEnvKeypairFormatSupported('rsa-4096', 'pem')).toBe(true);
	});

	it('detects a browser-exposed prefix (FR-20)', () => {
		expect(hasAppEnvPublicPrefix('NEXT_PUBLIC_API_URL')).toBe(true);
		expect(hasAppEnvPublicPrefix('API_URL')).toBe(false);
	});

	it('builds the generator fingerprint of plan.md:397, deterministically', () => {
		expect(appEnvGeneratorFingerprint({ kind: 'base64', bytes: 24 })).toBe('base64:24');
		expect(appEnvGeneratorFingerprint({ kind: 'hex', bytes: 32 })).toBe('hex:32');
		expect(appEnvGeneratorFingerprint({ kind: 'chars', length: 40, alphabet: 'alnum' })).toBe('chars:40:alnum');
		expect(appEnvGeneratorFingerprint({ kind: 'uuid' })).toBe('uuid');
		expect(appEnvGeneratorFingerprint({ kind: 'keypair', keypair: { type: 'ed25519' } })).toBe(
			'keypair:ed25519:pem'
		);
		expect(
			appEnvGeneratorFingerprint({
				kind: 'keypair',
				keypair: { type: 'rsa-2048', format: 'pkcs12', passwordEnv: 'PKCS12_PASSPHRASE' }
			})
		).toBe('keypair:rsa-2048:pkcs12:PKCS12_PASSPHRASE');
		// Same input, same fingerprint; a changed kind changes it (FR-12).
		expect(appEnvGeneratorFingerprint({ kind: 'chars', length: 40, alphabet: 'alnum' })).toBe(
			appEnvGeneratorFingerprint({ kind: 'chars', length: 40, alphabet: 'alnum' })
		);
		expect(appEnvGeneratorFingerprint({ kind: 'chars', length: 40, alphabet: 'alnum' })).not.toBe(
			appEnvGeneratorFingerprint({ kind: 'chars', length: 40, alphabet: 'base64url' })
		);
	});

	it('renders the stored and dependency fingerprints of plan.md:138–139', () => {
		expect(appEnvStoredFingerprint(3)).toBe('v3');
		expect(appEnvDependencyFingerprint(7)).toBe('d7');
		expect(appEnvStoredFingerprint(3)).not.toBe(appEnvDependencyFingerprint(3));
	});

	it('renders a secret template fingerprint that is order-independent and change-sensitive', () => {
		const pairs = [
			{ placeholder: 'A', fingerprint: 'v1' },
			{ placeholder: 'B', fingerprint: 'v2' }
		];
		expect(appEnvTemplateFingerprint('url', pairs)).toBe(appEnvTemplateFingerprint('url', pairs));
		expect(appEnvTemplateFingerprint('url', [...pairs].reverse())).toBe(appEnvTemplateFingerprint('url', pairs));
		expect(appEnvTemplateFingerprint('other', pairs)).not.toBe(appEnvTemplateFingerprint('url', pairs));
		expect(appEnvTemplateFingerprint('url', [{ placeholder: 'A', fingerprint: 'v9' }])).not.toBe(
			appEnvTemplateFingerprint('url', [{ placeholder: 'A', fingerprint: 'v1' }])
		);
	});
});

describe('app-env.ts — runner recipe grammar (APW-07 plan.md:447)', () => {
	it('pins the fixed dependency host grammar', () => {
		expect(APP_ENV_RUNNER_RECIPE_ENDPOINTS).toEqual({
			postgres: { host: 'postgres', port: 5432, user: 'ever-works-build', database: 'app' },
			redis: { host: 'redis', port: 6379, password: '' },
			objectStorage: { host: 'object-storage', port: 9000, accessKeyId: 'ever-works-build' }
		});
	});
});

describe('app-dependencies.ts — kinds, outputs and statuses (APW-07 plan.md:296–325)', () => {
	it('APP_DEPENDENCY_KINDS is exactly FR-35 (plan.md:296)', () => {
		expectExactMembers('APP_DEPENDENCY_KINDS', APP_DEPENDENCY_KINDS, [
			'postgres',
			'redis',
			'objectStorage',
			'smtp'
		]);
	});

	it('APP_DEPENDENCY_TARGETS is exactly plan.md:470', () => {
		expectExactMembers('APP_DEPENDENCY_TARGETS', APP_DEPENDENCY_TARGETS, ['your-cluster', 'ever-works-apps']);
	});

	it('APP_DEPENDENCY_OUTPUTS matches FR-40, secret flags included', () => {
		expect(APP_DEPENDENCY_OUTPUTS).toEqual({
			postgres: {
				url: true,
				directUrl: true,
				host: false,
				port: false,
				database: false,
				user: false,
				password: true
			},
			redis: { url: true, host: false, port: false, password: true },
			objectStorage: {
				endpoint: false,
				region: false,
				accessKeyId: true,
				secretAccessKey: true,
				'bucket.*': false
			},
			smtp: { host: false, port: false, user: false, password: true, from: false, secure: false }
		});
		expect(APP_DEPENDENCY_BUCKET_OUTPUT_PATTERN).toBe('bucket.*');
	});

	it('lists each kind output names in FR-40 order', () => {
		expect([...appDependencyOutputNames('postgres')]).toEqual([
			'url',
			'directUrl',
			'host',
			'port',
			'database',
			'user',
			'password'
		]);
		expect([...appDependencyOutputNames('smtp')]).toEqual(['host', 'port', 'user', 'password', 'from', 'secure']);
		expect(Object.keys(APP_DEPENDENCY_OUTPUT_NAMES)).toHaveLength(APP_DEPENDENCY_KINDS.length);
	});

	it('answers the secret flag exactly, and fails closed for an unknown output', () => {
		expect(isAppDependencyOutputSecret('postgres', 'url')).toBe(true);
		expect(isAppDependencyOutputSecret('postgres', 'host')).toBe(false);
		expect(isAppDependencyOutputSecret('smtp', 'password')).toBe(true);
		expect(isAppDependencyOutputSecret('objectStorage', 'endpoint')).toBe(false);
		expect(isAppDependencyOutputSecret('objectStorage', 'bucket.photos')).toBe(true);
		expect(isAppDependencyOutputSecret('postgres', 'somethingElse')).toBe(true);
	});

	it('every app-dependency union is duplicate-free', () => {
		expectNoDuplicates('APP_DEPENDENCY_STATUSES', APP_DEPENDENCY_STATUSES);
		expectNoDuplicates('APP_DEPENDENCY_BACKUP_POLICIES', APP_DEPENDENCY_BACKUP_POLICIES);
		expectNoDuplicates('APP_DEPENDENCY_BACKUP_STATES', APP_DEPENDENCY_BACKUP_STATES);
		expectNoDuplicates('APP_DEPENDENCY_PROVIDER_IDS', APP_DEPENDENCY_PROVIDER_IDS);
		expectNoDuplicates('APP_DEPENDENCY_INACTIVE_STATUSES', APP_DEPENDENCY_INACTIVE_STATUSES);
	});

	it('APP_DEPENDENCY_STATUSES is exactly plan.md:210 plus §4.9a:641, and the inactive pair is plan.md:225', () => {
		// `awaiting_config` is plan §4.9a:641's pre-provisioning state — "New status
		// `awaiting_config` … `reconcile` inserts the row in `awaiting_config` for such
		// a provider and dispatches nothing; no deadline runs" — added by the
		// 2026-09-17 fix pass, and it is what stops an external provider reaching
		// `failed deadlineExceeded` inside the 30-second SMTP deadline. APW-07 T2 names
		// it explicitly ("`APP_DEPENDENCY_STATUSES` incl. `awaitingConfig`"). The pin
		// stays EXACT: a status added without this list still fails here.
		expectExactMembers('APP_DEPENDENCY_STATUSES', APP_DEPENDENCY_STATUSES, [
			'pending',
			'awaiting_config',
			'provisioning',
			'ready',
			'degraded',
			'failed',
			'kept',
			'deleting',
			'deleted'
		]);
		expectExactMembers('APP_DEPENDENCY_INACTIVE_STATUSES', APP_DEPENDENCY_INACTIVE_STATUSES, ['kept', 'deleted']);
	});

	it('APP_DEPENDENCY_PROVIDER_IDS is exactly CONTRACTS §3:369', () => {
		expectExactMembers('APP_DEPENDENCY_PROVIDER_IDS', APP_DEPENDENCY_PROVIDER_IDS, [
			'k8s-inline-postgres',
			'k8s-inline-redis',
			'k8s-inline-minio',
			'smtp-external',
			's3-external',
			'platform-smtp-relay',
			'managed-postgres',
			'managed-redis',
			'managed-object-storage',
			'managed-smtp'
		]);
	});
});

describe('app-dependencies.ts — limits (APW-07 plan.md:304–325)', () => {
	it('pins the readiness deadlines of FR-41 with a +1 boundary', () => {
		expect(APP_DEPENDENCY_READY_DEADLINE_MS).toEqual({
			postgres: 600_000,
			redis: 300_000,
			objectStorage: 600_000,
			smtp: 30_000
		});
		expect(appDependencyReadyDeadlineMs('postgres')).toBe(600_000);
		expect(appDependencyReadyDeadlineMs('postgres') + 1).toBe(600_001);
		expect(appDependencyReadyDeadlineMs('redis')).toBe(300_000);
		expect(appDependencyReadyDeadlineMs('smtp')).toBe(30_000);
		expect(APP_DEPENDENCY_EXTERNAL_TEST_MS).toBe(30_000);
	});

	it('pins the default sizes of FR-37 and answers null for a kind without one', () => {
		expect(APP_DEPENDENCY_DEFAULT_SIZE_GIB).toEqual({ postgres: 10, objectStorage: 20, redis: 1 });
		expect(appDependencyDefaultSizeGiB('postgres')).toBe(10);
		expect(appDependencyDefaultSizeGiB('objectStorage')).toBe(20);
		expect(appDependencyDefaultSizeGiB('redis')).toBe(1);
		expect(appDependencyDefaultSizeGiB('smtp')).toBeNull();
	});

	it('pins the retry, refresh and relay limits of FR-39/FR-42/FR-43', () => {
		expect(APP_DEPENDENCY_TRANSIENT_ATTEMPTS).toBe(3);
		expect(APP_DEPENDENCY_TRANSIENT_ATTEMPTS + 1).toBe(4);
		expect(APP_DEPENDENCY_RETRY_DELAY_MS).toBe(300_000);
		expect(APP_DEPENDENCY_RELAY_DAILY_LIMIT).toBe(200);
		expect(APP_DEPENDENCY_RELAY_DAILY_LIMIT + 1).toBe(201);
		expect(APP_DEPENDENCY_RELAY_LIMITS).toEqual({
			perAccountPerDay: 1_000,
			perOrganizationPerDay: 5_000,
			suspendBounceRate: 0.05
		});
	});

	it('pins the managed tier semantics of FR-52/FR-53/FR-50 (plan.md:317–325)', () => {
		expect(APP_DEPENDENCY_MANAGED).toEqual({
			pgRoleConnectionLimit: 20,
			pgDatabaseConnectionLimit: 25,
			pgStatementTimeoutMs: 60_000,
			pgIdleInTransactionTimeoutMs: 60_000,
			bucketQuotaGiB: 10,
			redisMaxMemoryMiB: 256,
			backupMaxAgeMs: 86_400_000
		});
		// The zone's own schedule target is 24 h; the CARD's overdue line is 26 h.
		expect(APP_DEPENDENCY_MANAGED.backupMaxAgeMs).toBe(24 * 3_600_000);
		expect(APP_DEPENDENCY_BACKUP_OVERDUE_MS).toBe(26 * 3_600_000);
		expect(APP_DEPENDENCY_BACKUP_OVERDUE_MS).toBeGreaterThan(APP_DEPENDENCY_MANAGED.backupMaxAgeMs);
	});

	it('names the APW-07 operator env vars once (R-30, plan.md:667–681)', () => {
		expect(APP_DEPENDENCY_ENV_VARS.depsEnabled).toBe('EVER_WORKS_APP_DEPS_ENABLED');
		expect(APP_DEPENDENCY_ENV_VARS.mailRelayEnabled).toBe('EVER_WORKS_APP_MAIL_RELAY_ENABLED');
		expect(APP_DEPENDENCY_ENV_VARS.privateAllowlist).toBe('EVER_WORKS_APP_DEPENDENCY_PRIVATE_ALLOWLIST');
		expect(APP_DEPENDENCY_ENV_VARS.relayDailyLimitPerAccount).toBe('EVER_WORKS_APP_RELAY_DAILY_LIMIT_PER_ACCOUNT');
		expect(APP_DEPENDENCY_ENV_VARS.relayDailyLimitPerOrganization).toBe(
			'EVER_WORKS_APP_RELAY_DAILY_LIMIT_PER_ORGANIZATION'
		);
		expect(APP_DEPENDENCY_ENV_VARS.relaySuspendBounceRate).toBe('EVER_WORKS_APP_RELAY_SUSPEND_BOUNCE_RATE');
		expect(APP_DEPENDENCY_ENV_VARS.mailMaxPerDay).toBe('EVER_WORKS_APP_MAIL_MAX_PER_DAY');
	});
});

describe('app-dependencies.ts — the in-zone token (CONTRACTS §3:370–371)', () => {
	it('builds and round-trips ew-dep://<kind>/<output>', () => {
		expect(APP_DEPENDENCY_TOKEN_SCHEME).toBe('ew-dep://');
		const token = appDependencyToken('postgres', 'url');
		expect(token).toBe('ew-dep://postgres/url');
		expect(parseAppDependencyToken(token)).toEqual({ kind: 'postgres', output: 'url' });
		expect(parseAppDependencyToken(appDependencyToken('objectStorage', 'bucket.photos'))).toEqual({
			kind: 'objectStorage',
			output: 'bucket.photos'
		});
	});

	it('returns null for anything the zone must refuse', () => {
		// The DEPENDENCY_TOKEN_UNKNOWN cases of APW-10 plan.md:276.
		expect(parseAppDependencyToken('ew-dep://mysql/url')).toBeNull();
		expect(parseAppDependencyToken('ew-dep://postgres')).toBeNull();
		expect(parseAppDependencyToken('ew-dep://postgres/')).toBeNull();
		expect(parseAppDependencyToken('ew-dep:///url')).toBeNull();
		expect(parseAppDependencyToken('ew-dep://postgres/a/b')).toBeNull();
		expect(parseAppDependencyToken('postgres://host/db')).toBeNull();
		expect(APP_DEPENDENCY_TOKEN_UNKNOWN_CODE).toBe('DEPENDENCY_TOKEN_UNKNOWN');
	});
});

describe('app-dependencies.ts — pure decisions (FR-46, FR-48, FR-62, FR-63)', () => {
	it('marks a backup overdue only beyond 26 hours (FR-48)', () => {
		const now = Date.parse('2026-09-17T12:00:00.000Z');
		expect(isAppDependencyBackupOverdue(new Date(now - APP_DEPENDENCY_BACKUP_OVERDUE_MS).toISOString(), now)).toBe(
			false
		);
		expect(
			isAppDependencyBackupOverdue(new Date(now - APP_DEPENDENCY_BACKUP_OVERDUE_MS - 1).toISOString(), now)
		).toBe(true);
	});

	it('never calls a missing or unparseable timestamp overdue (FR-48)', () => {
		const now = Date.parse('2026-09-17T12:00:00.000Z');
		expect(isAppDependencyBackupOverdue(null, now)).toBe(false);
		expect(isAppDependencyBackupOverdue(undefined, now)).toBe(false);
		expect(isAppDependencyBackupOverdue('not-a-date', now)).toBe(false);
	});

	it('allows a same-size or larger dependency but never a shrink (FR-63)', () => {
		expect(isAppDependencySizeChangeAllowed(null, 5).allowed).toBe(true);
		expect(isAppDependencySizeChangeAllowed(10, 10).allowed).toBe(true);
		expect(isAppDependencySizeChangeAllowed(10, 11).allowed).toBe(true);
		expect(isAppDependencySizeChangeAllowed(10, 9)).toEqual({
			allowed: false,
			refusal: 'dependencySizeShrink'
		});
	});

	it('requires edit access and the typed slug to delete dependency data (FR-46)', () => {
		expect(canDeleteAppDependencyData({ hasEditAccess: true, confirmSlug: 'my-app', workSlug: 'my-app' })).toBe(
			true
		);
		expect(canDeleteAppDependencyData({ hasEditAccess: true, confirmSlug: null, workSlug: 'my-app' })).toBe(false);
		expect(canDeleteAppDependencyData({ hasEditAccess: true, confirmSlug: 'other', workSlug: 'my-app' })).toBe(
			false
		);
		expect(canDeleteAppDependencyData({ hasEditAccess: false, confirmSlug: 'my-app', workSlug: 'my-app' })).toBe(
			false
		);
	});

	it('blocks on every kind except an optional smtp (FR-62)', () => {
		expect(appDependencyBlocksDeploy('postgres', false)).toBe(true);
		expect(appDependencyBlocksDeploy('redis', false)).toBe(true);
		expect(appDependencyBlocksDeploy('objectStorage', false)).toBe(true);
		expect(appDependencyBlocksDeploy('smtp', false)).toBe(false);
		expect(appDependencyBlocksDeploy('smtp', true)).toBe(true);
	});
});

describe('tenant-postgres-ddl.ts — statement order and shape (APW-07 plan.md:701–710)', () => {
	const input = {
		dbName: 'awd_0123456789abcdef',
		roleName: 'awr_fedcba9876543210',
		password: '0123456789abcdef0123456789abcdef',
		roleExists: false,
		databaseExists: false
	};

	it('pins the generated prefixes, the password shape and the limits', () => {
		expect(TENANT_POSTGRES_DATABASE_PREFIX).toBe('awd_');
		expect(TENANT_POSTGRES_ROLE_PREFIX).toBe('awr_');
		expect(TENANT_POSTGRES_PASSWORD_PATTERN).toBe('^[0-9a-f]{32}$');
		expect(TENANT_POSTGRES_ROLE_CONNECTION_LIMIT).toBe(20);
		expect(TENANT_POSTGRES_DATABASE_CONNECTION_LIMIT).toBe(25);
		expect(TENANT_POSTGRES_STATEMENT_TIMEOUT_MS).toBe(60_000);
		expect(TENANT_POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(60_000);
		expect(TENANT_POSTGRES_DEFAULT_PORT).toBe(5432);
		expect([...TENANT_POSTGRES_ROLE_ATTRIBUTES]).toEqual([
			'LOGIN',
			'NOSUPERUSER',
			'NOCREATEDB',
			'NOCREATEROLE',
			'NOREPLICATION',
			'NOBYPASSRLS'
		]);
	});

	it('creates the role first, with every attribute and the 20-connection limit', () => {
		const result = buildTenantPostgresDdl(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.server[0]).toBe(
			'CREATE ROLE "awr_fedcba9876543210" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'0123456789abcdef0123456789abcdef\' CONNECTION LIMIT 20;'
		);
		expect(result.plan.altersRole).toBe(false);
		expect(result.plan.createsDatabase).toBe(true);
	});

	it('emits ALTER ROLE on a re-run and never a second CREATE (T35)', () => {
		const result = buildTenantPostgresDdl({ ...input, roleExists: true, databaseExists: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.altersRole).toBe(true);
		expect(result.plan.createsDatabase).toBe(false);
		expect(result.plan.server[0].startsWith('ALTER ROLE "awr_fedcba9876543210" WITH ')).toBe(true);
		expect(result.plan.server.join('\n')).not.toContain('CREATE ROLE');
		expect(result.plan.server.join('\n')).not.toContain('CREATE DATABASE');
	});

	it('sets both timeouts as 60s role defaults (FR-52, ACC-07-26)', () => {
		const result = buildTenantPostgresDdl(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.server[1]).toBe('ALTER ROLE "awr_fedcba9876543210" SET statement_timeout = \'60s\';');
		expect(result.plan.server[2]).toBe(
			'ALTER ROLE "awr_fedcba9876543210" SET idle_in_transaction_session_timeout = \'60s\';'
		);
	});

	it('creates the database with owner and the 25-connection limit, then closes PUBLIC', () => {
		const result = buildTenantPostgresDdl(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.server[3]).toBe(
			'CREATE DATABASE "awd_0123456789abcdef" OWNER "awr_fedcba9876543210" CONNECTION LIMIT 25;'
		);
		expect(result.plan.server[4]).toBe('REVOKE CONNECT, TEMPORARY ON DATABASE "awd_0123456789abcdef" FROM PUBLIC;');
		expect(result.plan.server[5]).toBe(
			'GRANT CONNECT, TEMPORARY ON DATABASE "awd_0123456789abcdef" TO "awr_fedcba9876543210";'
		);
	});

	it('hands the schema over inside the tenant database, then the extensions', () => {
		const result = buildTenantPostgresDdl({ ...input, extensions: ['pgcrypto'] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.database).toEqual([
			'REVOKE ALL ON SCHEMA public FROM PUBLIC;',
			'ALTER SCHEMA public OWNER TO "awr_fedcba9876543210";',
			'CREATE EXTENSION IF NOT EXISTS "pgcrypto";'
		]);
		expect(result.plan.statements).toEqual([...result.plan.server, ...result.plan.database]);
	});

	it('double-quotes every identifier (T35)', () => {
		const result = buildTenantPostgresDdl(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const statement of result.plan.statements) {
			if (statement.includes('awd_')) expect(statement).toContain('"awd_0123456789abcdef"');
			if (statement.includes('awr_')) expect(statement).toContain('"awr_fedcba9876543210"');
		}
		expect(quoteTenantPostgresIdentifier('a"b')).toBe('"a""b"');
	});

	it('is deterministic — the same input yields byte-identical statements', () => {
		const first = buildTenantPostgresDdl(input);
		const second = buildTenantPostgresDdl(input);
		expect(first.ok && second.ok && first.plan.statements).toEqual(second.ok ? second.plan.statements : null);
	});

	it('refuses a malformed identifier, password, limit or timeout instead of interpolating it', () => {
		expect(buildTenantPostgresDdl({ ...input, dbName: 'awd_"; DROP DATABASE x; --' })).toEqual({
			ok: false,
			refusal: 'identifierInvalid'
		});
		expect(buildTenantPostgresDdl({ ...input, roleName: 'AWR_UPPER' })).toEqual({
			ok: false,
			refusal: 'identifierInvalid'
		});
		expect(buildTenantPostgresDdl({ ...input, password: '0123456789abcdef' })).toEqual({
			ok: false,
			refusal: 'passwordInvalid'
		});
		expect(buildTenantPostgresDdl({ ...input, password: '0123456789ABCDEF0123456789ABCDEF' })).toEqual({
			ok: false,
			refusal: 'passwordInvalid'
		});
		expect(buildTenantPostgresDdl({ ...input, roleConnectionLimit: 0 })).toEqual({
			ok: false,
			refusal: 'connectionLimitInvalid'
		});
		expect(buildTenantPostgresDdl({ ...input, statementTimeoutMs: -1 })).toEqual({
			ok: false,
			refusal: 'timeoutInvalid'
		});
		expect(buildTenantPostgresDdl({ ...input, extensions: ['pg"; DROP'] })).toEqual({
			ok: false,
			refusal: 'identifierInvalid'
		});
	});
});

describe('tenant-postgres-ddl.ts — platform data server refusal (FR-54, T35)', () => {
	const platform = platformDataServerEndpoints({
		platform: { host: 'db.example.com', port: 5432 },
		sharedWorks: { host: 'works-db.example.com', port: 5432 }
	});

	it('normalises host case and the default port', () => {
		expect(TENANT_POSTGRES_DEFAULT_PORT).toBe(5432);
		expect(normaliseDataServerEndpoint('DB.Example.COM', 5432)).toEqual({ host: 'db.example.com', port: 5432 });
		expect(normaliseDataServerEndpoint('db.example.com')).toEqual({ host: 'db.example.com', port: 5432 });
		expect(normaliseDataServerEndpoint('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: 5432 });
		expect(normaliseDataServerEndpoint('')).toBeNull();
	});

	it('parses URLs, host:port pairs, bare hosts and IPv6 literals', () => {
		expect(parseDataServerUrl('postgresql://user:secret@db.example.com:5432/app')).toEqual({
			host: 'db.example.com',
			port: 5432
		});
		expect(parseDataServerUrl('postgres://db.example.com/app')).toEqual({ host: 'db.example.com', port: 5432 });
		expect(parseDataServerUrl('DB.EXAMPLE.COM:5432')).toEqual({ host: 'db.example.com', port: 5432 });
		expect(parseDataServerUrl('db.example.com')).toEqual({ host: 'db.example.com', port: 5432 });
		expect(parseDataServerUrl('postgresql://user@[2001:db8::1]:5433/app')).toEqual({
			host: '2001:db8::1',
			port: 5433
		});
		expect(parseDataServerUrl('')).toBeNull();
	});

	it('refuses a configured platform server whatever the URL shape (ACC-07-27)', () => {
		expect(isPlatformDataServer('postgresql://user@db.example.com:5432/app', platform)).toBe(true);
		expect(isPlatformDataServer('postgresql://user@DB.EXAMPLE.COM/app', platform)).toBe(true);
		expect(isPlatformDataServer('db.example.com', platform)).toBe(true);
		expect(isPlatformDataServer('works-db.example.com:5432', platform)).toBe(true);
	});

	it('accepts a different host or a different port', () => {
		expect(isPlatformDataServer('postgresql://user@tenant-db.example.net:5432/app', platform)).toBe(false);
		expect(isPlatformDataServer('db.example.com:5433', platform)).toBe(false);
		expect(isPlatformDataServer('', platform)).toBe(false);
	});

	it('returns false for an empty platform endpoint list', () => {
		expect(isPlatformDataServer('db.example.com', [])).toBe(false);
	});
});

describe('apps-tier.ts — the launch gate (spec FR-1/FR-2, tasks T1)', () => {
	it('LAUNCH_GATE_ITEM_IDS is LG-01 to LG-25, in order and without duplicates', () => {
		expect(LAUNCH_GATE_ITEM_IDS).toHaveLength(25);
		expectNoDuplicates('LAUNCH_GATE_ITEM_IDS', LAUNCH_GATE_ITEM_IDS);
		expect(LAUNCH_GATE_ITEM_IDS[0]).toBe('LG-01');
		expect(LAUNCH_GATE_ITEM_IDS[24]).toBe('LG-25');
		expect([...LAUNCH_GATE_ITEM_IDS]).toEqual(
			Array.from({ length: 25 }, (_, index) => `LG-${String(index + 1).padStart(2, '0')}`)
		);
	});

	it('LAUNCH_GATE_ITEMS covers exactly the ids and uses only declared kind and phase values', () => {
		expect(LAUNCH_GATE_ITEMS.map((item) => item.id)).toEqual([...LAUNCH_GATE_ITEM_IDS]);
		for (const item of LAUNCH_GATE_ITEMS) {
			expect([...LAUNCH_GATE_KINDS], item.id).toContain(item.kind);
			expect([...LAUNCH_GATE_PHASES], item.id).toContain(item.phase);
			expect(item.title.trim().length, item.id).toBeGreaterThan(0);
		}
	});

	it('pins the spec kind and phase of the boundary items', () => {
		// spec.md:183, 200, 206–207.
		expect(LAUNCH_GATE_ITEMS[0]).toEqual({
			id: 'LG-01',
			title: 'Dedicated capacity',
			kind: 'attested',
			phase: 'P2'
		});
		expect(LAUNCH_GATE_ITEMS[17]).toEqual({
			id: 'LG-18',
			title: 'Tenant quarantine drill',
			kind: 'automated',
			phase: 'P2'
		});
		expect(LAUNCH_GATE_ITEMS[23].phase).toBe('P3');
		expect(LAUNCH_GATE_ITEMS[24].phase).toBe('P3');
	});

	it('splits the phases exactly as FR-2 does', () => {
		expect(launchGateItemsForPhase('P2')).toHaveLength(23);
		expect(launchGateItemsForPhase('P3').map((item) => item.id)).toEqual(['LG-24', 'LG-25']);
	});

	it('pins the three vocabularies of tasks T1', () => {
		expectExactMembers('LAUNCH_GATE_KINDS', LAUNCH_GATE_KINDS, ['automated', 'attested', 'both']);
		expectExactMembers('LAUNCH_GATE_PHASES', LAUNCH_GATE_PHASES, ['P2', 'P3']);
		expectExactMembers('LAUNCH_GATE_OUTCOMES', LAUNCH_GATE_OUTCOMES, ['passed', 'failed', 'inconclusive', 'error']);
	});

	it('APP_TIER probe reason codes are duplicate-free and cover the plan §3.7 table', () => {
		expectNoDuplicates('APPS_TIER_PROBE_REASON_CODES', APPS_TIER_PROBE_REASON_CODES);
		for (const code of [
			'PRIVATE_RANGE_REACHABLE',
			'CONTROL_UNREACHABLE',
			'SANDBOX_KERNEL_NOT_DETECTED',
			'MAIL_PORT_OPEN',
			'CONNECTION_LIMIT_NOT_ENFORCED',
			'STATEMENT_TIMEOUT_NOT_ENFORCED',
			'APEX_NOT_ON_PSL',
			'QUARANTINE_ISOLATION_SLOW',
			'POLICY_DRIFT',
			'BUILD_CAP_NOT_ENFORCED',
			'PHASE_NOT_ENABLED',
			'misconfigured'
		]) {
			expect([...APPS_TIER_PROBE_REASON_CODES], code).toContain(code);
		}
	});
});

describe('apps-tier.ts — tier state (plan §5.4, spec FR-13/FR-16)', () => {
	it('pins the state, scope and eligibility vocabularies', () => {
		expectExactMembers('APPS_TIER_STATES', APPS_TIER_STATES, ['closed', 'open-verified-blueprints', 'open-any']);
		expectExhaustive<AppsTierState>(APPS_TIER_STATES, {
			closed: true,
			'open-verified-blueprints': true,
			'open-any': true
		});
		expectExactMembers('APPS_TIER_SCOPES', APPS_TIER_SCOPES, ['verified-blueprints', 'any']);
		expectExactMembers('APPS_TIER_ELIGIBILITY_REASONS', APPS_TIER_ELIGIBILITY_REASONS, [
			'emailUnverified',
			'planRequired',
			'ownerQuarantined',
			'capReached',
			'tierClosed'
		]);
		expect(APPS_TIER_POLICY_DEFAULT_SCOPE).toBe('verified-blueprints');
		expect([...APPS_TIER_ELIGIBILITY_DISABLED_REASONS]).toEqual(['tierClosed']);
	});

	it('APPS_TIER_CLOSED_REASON_CODES is exactly plan §5.4 and contains the auto-reopenable pair', () => {
		expectExactMembers('APPS_TIER_CLOSED_REASON_CODES', APPS_TIER_CLOSED_REASON_CODES, [
			'CEILING_OFF',
			'CLOSED_BY_OPERATOR',
			'SCOPE_NOT_ALLOWED',
			'NO_RUN',
			'RUN_NOT_GREEN',
			'RUN_STALE',
			'NOT_ATTESTED',
			'ATTESTATION_EXPIRED',
			'CONTROLLER_STALE',
			'CONTROLLER_TOO_OLD'
		]);
		for (const reason of APPS_TIER_AUTO_REOPENABLE_REASON_CODES) {
			expect([...APPS_TIER_CLOSED_REASON_CODES], reason).toContain(reason);
		}
		expect([...APPS_TIER_AUTO_REOPENABLE_REASON_CODES]).toEqual(['RUN_STALE', 'CONTROLLER_STALE']);
	});

	it('pins the T1 numeric constants with their +1 boundaries', () => {
		expect(GATE_MAX_AGE_HOURS).toBe(24);
		expect(GATE_MAX_AGE_HOURS + 1).toBe(25);
		expect(SELF_CHECK_BUDGET_MS).toBe(900_000);
		expect(PROBE_CONNECT_TIMEOUT_MS).toBe(3_000);
		expect(PROBE_ATTEMPTS).toBe(2);
		expect(PROBE_ATTEMPTS + 1).toBe(3);
		expect(SELF_CHECK_INTERVAL_HOURS).toBe(6);
		expect(ATTESTATION_TTL_DAYS).toBe(90);
		expect([...ATTESTATION_NOTICE_DAYS]).toEqual([14, 1]);
		expect(HEARTBEAT_MAX_AGE_MS).toBe(120_000);
		expect(HEARTBEAT_MAX_AGE_MS + 1).toBe(120_001);
		expect(GATE_WATCH_INTERVAL_MIN).toBe(5);
		expect(QUARANTINE_ISOLATE_MS).toBe(15_000);
		expect(QUARANTINE_SCALE_MS).toBe(60_000);
		expect(QUARANTINE_EDGE_MS).toBe(120_000);
		expect(RELEASE_RESTORE_MS).toBe(180_000);
		expect(DETECTOR_QUARANTINE_MS).toBe(60_000);
		expect(IMAGE_ALLOWANCE_MAX_DAYS).toBe(30);
		expect(PULL_CREDENTIAL_MAX_MS).toBe(900_000);
		expect(REMOVED_DATA_RETENTION_DAYS).toBe(30);
	});

	it('pins the app.tier events, notifications and error codes of CONTRACTS', () => {
		expectExactMembers('APPS_TIER_EVENT_NAMES', APPS_TIER_EVENT_NAMES, [
			'app.tier.quarantined',
			'app.tier.released',
			'app.tier.deploy_refused',
			'app.tier.egress_threshold',
			'app.tier.usage_daily'
		]);
		expectExactMembers('APPS_TIER_NOTIFICATION_IDS', APPS_TIER_NOTIFICATION_IDS, [
			'app_tier_usage_80',
			'app_tier_quarantined',
			'app_tier_egress',
			'app_attestation_expiry'
		]);
		expect(APPS_TIER_OPEN_REFUSED_CODE).toBe('apps_tier_open_refused');
	});
});

describe('apps-tier.ts — evaluateAppsTierPolicyState (plan §5.4:677–697)', () => {
	const happyInput: AppsTierPolicyEvaluationInput = {
		ceilingEnabled: true,
		maxScope: 'any',
		lastEvent: { state: 'open-any', automatic: false, reasonCodes: [] },
		latestRun: { status: 'green', finishedAtEpochMs: 10_000, coversScope: 'any' },
		attestationReasons: [],
		controllerRenewedAtEpochMs: 10_000,
		controllerVersion: '1.4.0',
		controllerMinVersion: '1.0.0',
		gateMaxAgeHours: 24,
		now: 10_000
	};

	it('opens when every clause passes', () => {
		expect(evaluateAppsTierPolicyState(happyInput)).toEqual({
			open: true,
			scope: 'any',
			reasons: [],
			autoReopenable: false
		});
	});

	it('closes on the ceiling, a missing event and an operator close, in that order', () => {
		expect(evaluateAppsTierPolicyState({ ...happyInput, ceilingEnabled: false }).reasons).toEqual(['CEILING_OFF']);
		expect(evaluateAppsTierPolicyState({ ...happyInput, lastEvent: null }).reasons).toEqual(['CLOSED_BY_OPERATOR']);
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				lastEvent: { state: 'closed', automatic: false, reasonCodes: ['RUN_STALE'] }
			}).reasons
		).toEqual(['CLOSED_BY_OPERATOR']);
	});

	it('reports an automatic close with the reasons it recorded', () => {
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				lastEvent: { state: 'closed', automatic: true, reasonCodes: ['NOT_ATTESTED'] }
			}).reasons
		).toEqual(['NOT_ATTESTED']);
	});

	it('refuses open-any when the configured scope is narrower', () => {
		expect(evaluateAppsTierPolicyState({ ...happyInput, maxScope: 'verified-blueprints' }).reasons).toEqual([
			'SCOPE_NOT_ALLOWED'
		]);
	});

	it('closes with NO_RUN, RUN_NOT_GREEN or RUN_STALE as the evidence degrades', () => {
		expect(evaluateAppsTierPolicyState({ ...happyInput, latestRun: null }).reasons).toEqual(['NO_RUN']);
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				latestRun: { status: 'red', finishedAtEpochMs: 10_000, coversScope: 'any' }
			}).reasons
		).toEqual(['RUN_NOT_GREEN']);
		// A green run that only covered the narrower scope does not cover `any`.
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				latestRun: { status: 'green', finishedAtEpochMs: 10_000, coversScope: 'verified-blueprints' }
			}).reasons
		).toEqual(['RUN_NOT_GREEN']);
	});

	it('accepts a run exactly 24 h old and refuses one millisecond older', () => {
		const now = Date.parse('2026-09-17T12:00:00.000Z');
		const fresh = {
			...happyInput,
			now,
			controllerRenewedAtEpochMs: now,
			latestRun: {
				status: 'green' as const,
				finishedAtEpochMs: now - GATE_MAX_AGE_HOURS * 3_600_000,
				coversScope: 'any' as const
			}
		};
		expect(evaluateAppsTierPolicyState(fresh).open).toBe(true);
		expect(
			evaluateAppsTierPolicyState({
				...fresh,
				latestRun: { ...fresh.latestRun, finishedAtEpochMs: fresh.latestRun.finishedAtEpochMs - 1 }
			}).reasons
		).toEqual(['RUN_STALE']);
	});

	it('never trusts a configured age above the 24 h maximum', () => {
		const now = Date.parse('2026-09-17T12:00:00.000Z');
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				gateMaxAgeHours: 48,
				now,
				controllerRenewedAtEpochMs: now,
				latestRun: {
					status: 'green',
					finishedAtEpochMs: now - GATE_MAX_AGE_HOURS * 3_600_000 - 1,
					coversScope: 'any'
				}
			}).reasons
		).toEqual(['RUN_STALE']);
	});

	it('appends the attestation reasons it was given', () => {
		expect(
			evaluateAppsTierPolicyState({ ...happyInput, attestationReasons: ['NOT_ATTESTED', 'ATTESTATION_EXPIRED'] })
				.reasons
		).toEqual(['NOT_ATTESTED', 'ATTESTATION_EXPIRED']);
	});

	it('accepts a heartbeat exactly 120 s old and refuses one millisecond older', () => {
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				now: 10_000 + HEARTBEAT_MAX_AGE_MS,
				controllerRenewedAtEpochMs: 10_000
			}).open
		).toBe(true);
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				now: 10_000 + HEARTBEAT_MAX_AGE_MS + 1,
				controllerRenewedAtEpochMs: 10_000
			}).reasons
		).toEqual(['CONTROLLER_STALE']);
		expect(evaluateAppsTierPolicyState({ ...happyInput, controllerRenewedAtEpochMs: null }).reasons).toEqual([
			'CONTROLLER_STALE'
		]);
	});

	it('refuses a controller below the version floor and accepts one exactly at it', () => {
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				controllerVersion: '1.0.0',
				controllerMinVersion: '1.0.0'
			}).open
		).toBe(true);
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				controllerVersion: '0.9.9',
				controllerMinVersion: '1.0.0'
			}).reasons
		).toEqual(['CONTROLLER_TOO_OLD']);
		expect(
			evaluateAppsTierPolicyState({
				...happyInput,
				controllerVersion: '1.0.0-rc.1',
				controllerMinVersion: '1.0.0'
			}).reasons
		).toEqual(['CONTROLLER_TOO_OLD']);
	});

	it('is auto-reopenable only when every reason is stale-run or stale-controller (FR-16)', () => {
		const stale = {
			...happyInput,
			now: 10_000 + GATE_MAX_AGE_HOURS * 3_600_000 + 1,
			controllerRenewedAtEpochMs: 10_000
		};
		const evaluation = evaluateAppsTierPolicyState(stale);
		expect(evaluation.reasons).toEqual(['RUN_STALE', 'CONTROLLER_STALE']);
		expect(evaluation.autoReopenable).toBe(true);
		expect(
			evaluateAppsTierPolicyState({ ...stale, attestationReasons: ['ATTESTATION_EXPIRED'] }).autoReopenable
		).toBe(false);
	});

	it('compares semver numerically, not lexically', () => {
		expect(isSemverLessThan('1.10.0', '1.9.0')).toBe(false);
		expect(isSemverLessThan('1.9.0', '1.10.0')).toBe(true);
		expect(isSemverLessThan('2.0.0', '2.0')).toBe(false);
		expect(isSemverLessThan('v1.2.3', '1.2.4')).toBe(true);
	});
});

describe('apps-tier.ts — the Work desired-state model (plan §3.1:223–294)', () => {
	it('pins the group, version, namespaces and labels', () => {
		expect(APPS_TIER_API_GROUP).toBe('hosting.ever.works');
		expect(APPS_TIER_API_VERSION).toBe('v1alpha1');
		expect(APPS_TIER_CONTROL_NAMESPACE_DEFAULT).toBe('ever-works-apps-control');
	});

	it('APP_TIER_WORK_DESIRED_STATES is exactly plan §3.1:236', () => {
		expectExactMembers('APPS_TIER_WORK_DESIRED_STATES', APPS_TIER_WORK_DESIRED_STATES, [
			'running',
			'paused',
			'quarantined',
			'removed'
		]);
	});

	it('APP_TIER_WORK_PHASES is exactly FR-27 and APP_TIER_DEPLOY_PHASES exactly plan §3.1:264', () => {
		expectExactMembers('APPS_TIER_WORK_PHASES', APPS_TIER_WORK_PHASES, [
			'Pending',
			'Promoting',
			'Provisioning',
			'Ready',
			'Degraded',
			'Paused',
			'Quarantined',
			'Refused',
			'Failed',
			'Removed'
		]);
		expectExhaustive<AppsTierWorkPhase>(APPS_TIER_WORK_PHASES, {
			Pending: true,
			Promoting: true,
			Provisioning: true,
			Ready: true,
			Degraded: true,
			Paused: true,
			Quarantined: true,
			Refused: true,
			Failed: true,
			Removed: true
		});
		expectExactMembers('APPS_TIER_DEPLOY_PHASES', APPS_TIER_DEPLOY_PHASES, [
			'prepare',
			'pre-deploy-jobs',
			'rollout',
			'first-deploy-jobs',
			'in-cluster-smoke',
			'publish',
			'public-smoke',
			'post-deploy-jobs',
			'cron',
			'done'
		]);
	});

	it('pins the job, smoke and dependency status vocabularies', () => {
		expectExactMembers('APPS_TIER_JOB_PHASES', APPS_TIER_JOB_PHASES, ['pre-deploy', 'first-deploy', 'post-deploy']);
		expectExactMembers('APPS_TIER_JOB_STATUSES', APPS_TIER_JOB_STATUSES, [
			'succeeded',
			'failed',
			'timeout',
			'running'
		]);
		expectExactMembers('APPS_TIER_SMOKE_SCOPES', APPS_TIER_SMOKE_SCOPES, ['in-cluster', 'public']);
		expectExactMembers('APPS_TIER_SMOKE_STATUSES', APPS_TIER_SMOKE_STATUSES, ['passed', 'failed', 'skipped']);
		// CONTRACTS §3:371 — `released` is what gates data deletion.
		expectExactMembers('APPS_TIER_DEPENDENCY_PHASES', APPS_TIER_DEPENDENCY_PHASES, [
			'pending',
			'ready',
			'failed',
			'released'
		]);
	});

	it('pins the quarantine categories, sources and signal vocabularies', () => {
		expectExactMembers('APPS_TIER_QUARANTINE_CATEGORIES', APPS_TIER_QUARANTINE_CATEGORIES, [
			'abuse',
			'security',
			'billing',
			'legal',
			'pause-all',
			'drill'
		]);
		// `self-check` is the source LG-21 asserts on (plan §3.7:458).
		expectExactMembers('APPS_TIER_QUARANTINE_SOURCES', APPS_TIER_QUARANTINE_SOURCES, [
			'operator',
			'detector',
			'self-check'
		]);
		expectExactMembers('APPS_TIER_SIGNAL_KINDS', APPS_TIER_SIGNAL_KINDS, [
			'runtime',
			'mining',
			'mail',
			'bandwidth',
			'report'
		]);
		expectExactMembers('APPS_TIER_SIGNAL_SEVERITIES', APPS_TIER_SIGNAL_SEVERITIES, ['low', 'medium', 'high']);
		// Pause all records Security and needs the typed confirmation (FR-44).
		expect(APPS_TIER_PAUSE_ALL_CATEGORY).toBe('security');
		expect(APPS_TIER_PAUSE_ALL_CONFIRMATION).toBe('PAUSE ALL');
		expect(APPS_TIER_BILLING_QUARANTINE_CATEGORY).toBe('billing');
	});

	it('pins the refusal and degraded codes of plan §3.1:273–281', () => {
		expectExactMembers('APPS_TIER_WORK_REFUSAL_CODES', APPS_TIER_WORK_REFUSAL_CODES, [
			'SPEC_LIMIT_EXCEEDED',
			'NAMESPACE_FIELD_FORBIDDEN',
			'QUOTA_PROFILE_UNKNOWN',
			'PLATFORM_CREDENTIAL_IN_ENV',
			'IMAGE_NOT_DIGEST_PINNED',
			'IMAGE_SCAN_BLOCKED',
			'IMAGE_UNSIGNED',
			'IMAGE_OUTSIDE_TENANT_REGISTRY',
			'HOST_NOT_VERIFIED',
			'HOST_CLAIMED',
			'SEALED_PAYLOAD_INVALID',
			'CRON_TOO_FREQUENT',
			'DEPENDENCY_TOKEN_UNKNOWN',
			'ISOLATION_NOT_ENFORCED'
		]);
		expectExactMembers('APPS_TIER_WORK_DEGRADED_REASONS', APPS_TIER_WORK_DEGRADED_REASONS, [
			'IMAGE_RUNS_AS_ROOT',
			'QUOTA_EXCEEDED'
		]);
	});

	it('pins the desired-state limits of FR-26 and plan §3.1', () => {
		expect(APPS_TIER_MAX_COMPONENTS).toBe(8);
		expect(APPS_TIER_MAX_COMPONENTS + 1).toBe(9);
		expect(APPS_TIER_MAX_JOBS).toBe(10);
		expect(APPS_TIER_MAX_JOBS + 1).toBe(11);
		expect(APPS_TIER_MAX_CRON).toBe(10);
		expect(APPS_TIER_MAX_SMOKE).toBe(20);
		expect(APPS_TIER_MAX_SMOKE + 1).toBe(21);
		expect(APPS_TIER_MAX_HOSTS).toBe(20);
		expect(APPS_TIER_MAX_ENV_NAMES).toBe(200);
		expect(APPS_TIER_MAX_ENV_NAMES + 1).toBe(201);
		expect(APPS_TIER_MAX_COMPONENT_VOLUMES).toBe(4);
		expect(APPS_TIER_MAX_COMPONENT_VOLUMES + 1).toBe(5);
		expect(APPS_TIER_MAX_COMPONENT_REPLICAS).toBe(10);
		expect(APPS_TIER_MAX_IMAGES).toBe(8);
		expect(APPS_TIER_MAX_JOB_TIMEOUT_SECONDS).toBe(3_600);
		expect(APPS_TIER_MAX_JOB_TIMEOUT_SECONDS + 1).toBe(3_601);
		// 256 KiB sealed env, 512 KiB whole object (FR-26, plan §3.1:272).
		expect(APPS_TIER_MAX_SEALED_ENV_BYTES).toBe(256 * 1_024);
		expect(APPS_TIER_MAX_WORK_BYTES).toBe(512 * 1_024);
		expect(APPS_TIER_MAX_WORK_BYTES + 1).toBe(524_289);
		expect(APPS_TIER_MIN_CRON_INTERVAL_MS).toBe(5 * 60_000);
	});
});

describe('apps-tier.ts — quota profiles (spec FR-47/FR-48)', () => {
	it('pins Starter and Standard exactly', () => {
		expect(APPS_TIER_QUOTA_PROFILE_NAMES).toEqual(['starter', 'standard']);
		expect(APPS_TIER_QUOTA_PROFILES.starter).toEqual({
			name: 'starter',
			cpuRequest: 1,
			cpuLimit: 2,
			memoryRequestGiB: 2,
			memoryLimitGiB: 4,
			pods: 10,
			volumes: 4,
			volumeTotalGiB: 10,
			bandwidthOutMbps: 20,
			bandwidthInMbps: 50,
			monthlyEgressGiB: 100,
			loadBalancers: 0,
			nodePorts: 0
		});
		expect(APPS_TIER_QUOTA_PROFILES.standard).toEqual({
			name: 'standard',
			cpuRequest: 2,
			cpuLimit: 4,
			memoryRequestGiB: 4,
			memoryLimitGiB: 8,
			pods: 20,
			volumes: 8,
			volumeTotalGiB: 50,
			bandwidthOutMbps: 50,
			bandwidthInMbps: 100,
			monthlyEgressGiB: 500,
			loadBalancers: 0,
			nodePorts: 0
		});
	});

	it('resolves a shipped profile and answers null for an unknown one', () => {
		expect(resolveAppsTierQuotaProfile('starter')?.pods).toBe(10);
		expect(resolveAppsTierQuotaProfile('standard')?.pods).toBe(20);
		expect(resolveAppsTierQuotaProfile('nope')).toBeNull();
	});

	it('pins the hard ceilings of FR-48', () => {
		expect(APPS_TIER_QUOTA_CEILINGS).toEqual({ cpu: 16, memoryGiB: 32, pods: 100, storageGiB: 500 });
	});

	it('keeps a value exactly at the ceiling and clamps ceiling + 1', () => {
		const atCeiling = {
			...APPS_TIER_QUOTA_PROFILES.standard,
			cpuLimit: APPS_TIER_QUOTA_CEILINGS.cpu,
			memoryLimitGiB: APPS_TIER_QUOTA_CEILINGS.memoryGiB,
			pods: APPS_TIER_QUOTA_CEILINGS.pods,
			volumeTotalGiB: APPS_TIER_QUOTA_CEILINGS.storageGiB
		};
		const kept = clampAppsTierQuotaProfile(atCeiling);
		expect(kept.clamped).toEqual([]);
		expect(kept.profile.pods).toBe(APPS_TIER_QUOTA_CEILINGS.pods);

		const over = clampAppsTierQuotaProfile({
			...atCeiling,
			cpuLimit: APPS_TIER_QUOTA_CEILINGS.cpu + 1,
			memoryLimitGiB: APPS_TIER_QUOTA_CEILINGS.memoryGiB + 1,
			pods: APPS_TIER_QUOTA_CEILINGS.pods + 1,
			volumeTotalGiB: APPS_TIER_QUOTA_CEILINGS.storageGiB + 1
		});
		expect(over.profile.cpuLimit).toBe(APPS_TIER_QUOTA_CEILINGS.cpu);
		expect(over.profile.memoryLimitGiB).toBe(APPS_TIER_QUOTA_CEILINGS.memoryGiB);
		expect(over.profile.pods).toBe(APPS_TIER_QUOTA_CEILINGS.pods);
		expect(over.profile.volumeTotalGiB).toBe(APPS_TIER_QUOTA_CEILINGS.storageGiB);
		expect([...over.clamped].sort()).toEqual(['cpuLimit', 'memoryLimitGiB', 'pods', 'volumeTotalGiB']);
	});

	it('never allows a load balancer or a node port (FR-22)', () => {
		expect(APPS_TIER_QUOTA_PROFILES.starter.loadBalancers).toBe(0);
		expect(APPS_TIER_QUOTA_PROFILES.starter.nodePorts).toBe(0);
		expect(APPS_TIER_QUOTA_PROFILES.standard.loadBalancers).toBe(0);
		expect(APPS_TIER_QUOTA_PROFILES.standard.nodePorts).toBe(0);
	});
});

describe('apps-tier.ts — metering and the credit pricebook (plan §5.3:659–673, T50)', () => {
	it('pins VERSION_2, the hosting group and every price key', () => {
		expect(APPS_TIER_PRICEBOOK_VERSION).toBe(2);
		expect(APPS_TIER_PRICE_GROUP).toBe('hosting');
		expect(APPS_TIER_PRICE_KEYS).toEqual({
			cpuCoreHour: 'hosting.cpu_core_hour',
			memoryGiBHour: 'hosting.memory_gib_hour',
			egressGiB: 'hosting.egress_gib',
			storageGiBMonth: 'hosting.storage_gib_month',
			buildMinute: 'hosting.build_minute',
			dependencyStorageGiBHour: 'hosting.dependency_storage_gib_hour',
			dependencyBackupGiBHour: 'hosting.dependency_backup_gib_hour',
			relayMessages: 'relay.messages'
		});
		expectNoDuplicates('APPS_TIER_PRICE_KEYS', Object.values(APPS_TIER_PRICE_KEYS));
		for (const key of Object.values(APPS_TIER_PRICE_KEYS)) {
			if (key.startsWith('hosting.')) expect(key.startsWith(`${APPS_TIER_PRICE_GROUP}.`)).toBe(true);
		}
	});

	it('pins the whole-unit conversions with their +1 boundaries', () => {
		expect(APPS_TIER_PRICE_UNITS.cpuCoreSecondsPerUnit).toBe(3_600);
		expect(APPS_TIER_PRICE_UNITS.cpuCoreSecondsPerUnit + 1).toBe(3_601);
		expect(APPS_TIER_PRICE_UNITS.memoryMiBHoursPerUnit).toBe(1_024);
		expect(APPS_TIER_PRICE_UNITS.egressMiBPerUnit).toBe(1_024);
		expect(APPS_TIER_PRICE_UNITS.storageGiBHoursPerUnit).toBe(720);
		expect(APPS_TIER_PRICE_UNITS.storageGiBHoursPerUnit).toBe(30 * 24);
	});

	it('pins the usage units and the daily-receipt idempotency key', () => {
		expect(APPS_TIER_USAGE_UNITS).toContain('cpuCoreSeconds');
		expect(APPS_TIER_USAGE_UNITS).toContain('dependencyStorageGiBHours');
		expect(APPS_TIER_USAGE_UNITS).toContain('dependencyBackupGiBHours');
		expectNoDuplicates('APPS_TIER_USAGE_UNITS', APPS_TIER_USAGE_UNITS);
		expect(appsTierReceiptIdempotencyKey('work-1', '2026-09-17')).toBe('apps-tier:work-1:2026-09-17');
		// Determinism: the same day debits once.
		expect(appsTierReceiptIdempotencyKey('work-1', '2026-09-17')).toBe(
			appsTierReceiptIdempotencyKey('work-1', '2026-09-17')
		);
		expect(appsTierReceiptIdempotencyKey('work-1', '2026-09-18')).not.toBe(
			appsTierReceiptIdempotencyKey('work-1', '2026-09-17')
		);
	});

	it('pins the egress and monitoring thresholds of FR-36 and CONTRACTS §11', () => {
		expect(APPS_TIER_EGRESS_NOTICE_SHARE).toBe(0.8);
		expect(APPS_TIER_EGRESS_THROTTLE_MBPS).toBe(2);
	});
});
