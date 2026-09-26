import { describe, expect, it } from 'vitest';

import { APP_DEPLOY_TARGET_CHOICES } from '../app-source.js';

import * as appsBarrel from '../index.js';
import * as packageRoot from '../../index.js';

import * as runtime from '../app-runtime.js';

import {
	APP_CANCEL_REASONS,
	APP_DEPLOY_LOCK_STALE_S,
	APP_DEPLOY_MAX_DURATION_S,
	APP_DEPLOY_OUTCOMES,
	APP_DEPLOY_PHASES,
	APP_DEPLOY_PURPOSES,
	APP_DEPLOY_TARGETS,
	APP_DEPLOYMENT_DISPLAY_STATES,
	APP_DEPLOYMENT_STATES,
	APP_DEPLOYMENT_TERMINAL_STATES,
	APP_FAILURE_CODES,
	APP_FAILURE_CODES_WITHOUT_MESSAGE_LEAF,
	APP_FAILURE_LEAVES_WITHOUT_FAILURE_CODE,
	APP_FAILURE_MESSAGE_LEAVES,
	APP_PRECONDITION_CODES,
	APP_PRECONDITION_MESSAGE_LEAVES,
	APP_PRECONDITION_STATES,
	APP_RUNTIME_HEALTH,
	APP_RUNTIME_STATES,
	appComponentDeadlineSeconds,
	type AppDeployPhase,
	type AppDeployTarget,
	type AppDeploymentState,
	type AppFailureCode,
	type AppPrecondition,
	type AppPreconditionCode,
	type AppRuntimeHealth,
	type AppRuntimeState
} from '../app-runtime.js';

/**
 * Every closed union this module exports, with the exact members it must carry.
 *
 * These are PINS, not restatements: `APP_DEPLOY_TARGETS` is R-12's three values
 * and nothing else, the phase list is plan §3:188-199's eleven, and a member
 * added without deciding it here — or dropped — fails. That is the whole point
 * of T1 ("pins every numeric value and every union", tasks.md:50-51).
 */
const UNIONS: Array<[name: string, actual: readonly string[], expected: readonly string[]]> = [
	[
		'APP_DEPLOY_TARGETS',
		APP_DEPLOY_TARGETS,
		['none', 'your-cluster', 'ever-works-apps'] // R-12, CONTRACTS.md:55
	],
	['APP_DEPLOY_PURPOSES', APP_DEPLOY_PURPOSES, ['deploy', 'verification']], // plan §3:211
	[
		'APP_DEPLOY_PHASES',
		APP_DEPLOY_PHASES,
		[
			'prepare',
			'pre-deploy-jobs',
			'rollout',
			'first-deploy-jobs',
			'in-cluster-smoke',
			'publish',
			'public-smoke',
			'post-deploy-jobs',
			'cron',
			'rollback',
			'done'
		] // plan §3:188-199 — eleven, per plan §10.3:1624
	],
	[
		'APP_DEPLOY_OUTCOMES',
		APP_DEPLOY_OUTCOMES,
		['succeeded', 'succeeded-with-warnings', 'failed', 'rolled-back', 'cancelled', 'rollback-failed'] // plan §3:255
	],
	['APP_CANCEL_REASONS', APP_CANCEL_REASONS, ['user', 'quarantined', 'app_work_deleting']], // plan §3:257
	[
		'APP_DEPLOYMENT_STATES',
		APP_DEPLOYMENT_STATES,
		[
			'INITIALIZING',
			'QUEUED',
			'BUILDING',
			'DEPLOYING',
			'VERIFYING',
			'READY',
			'ERROR',
			'CANCELED',
			'TIMEOUT',
			'ROLLED_BACK',
			'SUPERSEDED'
		] // work-deployment.entity.ts:65,108 + plan §7.1:1024
	],
	[
		'APP_DEPLOYMENT_TERMINAL_STATES',
		APP_DEPLOYMENT_TERMINAL_STATES,
		['READY', 'ERROR', 'CANCELED', 'TIMEOUT', 'ROLLED_BACK', 'SUPERSEDED'] // entity:108 + plan §7.1:1024-1025
	],
	[
		'APP_DEPLOYMENT_DISPLAY_STATES',
		APP_DEPLOYMENT_DISPLAY_STATES,
		[
			'queued',
			'deploying',
			'checking',
			'live',
			'live-with-warnings',
			'failed',
			'rolled-back',
			'cancelled',
			'cancelled-quarantined',
			'skipped'
		] // spec §6.7:705 — ten
	],
	[
		'APP_RUNTIME_STATES',
		APP_RUNTIME_STATES,
		['not-deployed', 'live', 'degraded', 'down', 'unreachable', 'paused', 'deleting'] // plan §3.1:367, spec §6.7:706
	],
	['APP_RUNTIME_HEALTH', APP_RUNTIME_HEALTH, ['unknown', 'healthy', 'degraded', 'down', 'unreachable']], // plan §7.2:1052
	[
		'APP_PRECONDITION_CODES',
		APP_PRECONDITION_CODES,
		[
			'spec_invalid',
			'license_blocks_target',
			'license_attestation_missing',
			'env_required_unset',
			'dependency_not_ready',
			'no_green_build',
			'no_green_build_for_head',
			'build_image_missing',
			'nothing_to_deploy',
			'image_not_pinned',
			'image_not_found',
			'image_private_unsupported',
			'image_unresolvable',
			'primary_domain_missing',
			'target_none',
			'target_not_checked',
			'cluster_changed_unconfirmed',
			'managed_disabled',
			'managed_scope_unverified_blueprint',
			'quota_exceeded',
			'managed_ineligible',
			'managed_sandbox_unavailable',
			'app_work_deleting',
			'paused',
			'deploy_in_progress',
			'cron_auth_env_unset',
			'job_auth_env_unset',
			'volume_replicas',
			'volume_shrink',
			'privileged_port',
			'cron_too_frequent',
			'managed_root_forbidden',
			'image_user_unverifiable',
			'worker_not_isolated',
			'env_source_unavailable',
			'pull_credential_unavailable',
			'namespace_foreign',
			'verification_namespace_forbidden'
		] // plan §5.1:661-680 + §11:1644 + plan.md:1784
	],
	[
		'APP_FAILURE_CODES',
		APP_FAILURE_CODES,
		[
			'crash_loop',
			'oom_killed',
			'image_pull',
			'create_container_config',
			'rollout_timeout',
			'job_failed',
			'smoke_failed',
			'publish_failed',
			'rollback_failed',
			'cluster_unreachable',
			'worker_failed',
			'isolation_not_enforced',
			'managed_root_forbidden',
			'image_user_unverifiable',
			'deadline_exceeded',
			'image_not_found',
			'image_private_unsupported',
			'image_unresolvable'
		] // plan §3.1:370-374 — "pins exactly this list"
	],
	[
		'APP_FAILURE_CODES_WITHOUT_MESSAGE_LEAF',
		APP_FAILURE_CODES_WITHOUT_MESSAGE_LEAF,
		[
			'create_container_config',
			'cluster_unreachable',
			'worker_failed',
			'isolation_not_enforced',
			'deadline_exceeded'
		]
	],
	['APP_FAILURE_LEAVES_WITHOUT_FAILURE_CODE', APP_FAILURE_LEAVES_WITHOUT_FAILURE_CODE, ['imageNotPinned']]
];

/** The fourteen `failures.*` leaves of plan §10.3:1625-1627, in that order. */
const PLAN_10_3_FAILURE_LEAVES: readonly string[] = [
	'crashLoop',
	'oomKilled',
	'imagePull',
	'imageRunsAsRoot',
	'imageUserUnverifiable',
	'rolloutTimeout',
	'jobFailed',
	'smokeFailed',
	'publishFailed',
	'rollbackFailed',
	'imageNotPinned',
	'imageNotFound',
	'imagePrivateUnsupported',
	'imageUnresolvable'
];

/**
 * Every numeric constant of plan §5.3 (plan.md:698-752, 51 of them) plus the
 * lock-stale derivation of plan §7.2:1039, each with the line its value comes
 * from. The spec line is in the test NAME, so a failure names its own source.
 */
const NUMBERS: Array<{ name: string; value: number; source: string; actual: number }> = [
	{
		name: 'APP_DEPLOY_REQUEST_BUDGET_MS',
		value: 2_000,
		source: 'FR-23 spec.md:361',
		actual: runtime.APP_DEPLOY_REQUEST_BUDGET_MS
	},
	{
		name: 'APP_PREPARE_TIMEOUT_S',
		value: 120,
		source: 'FR-26 step 1 spec.md:374',
		actual: runtime.APP_PREPARE_TIMEOUT_S
	},
	{
		name: 'APP_JOB_TIMEOUT_DEFAULT_S',
		value: 600,
		source: 'FR-26 step 2 spec.md:375',
		actual: runtime.APP_JOB_TIMEOUT_DEFAULT_S
	},
	{
		name: 'APP_ROLLOUT_EXTRA_S',
		value: 120,
		source: 'FR-26 step 3 spec.md:376',
		actual: runtime.APP_ROLLOUT_EXTRA_S
	},
	{ name: 'APP_ROLLOUT_MIN_S', value: 300, source: 'FR-26 step 3 spec.md:376', actual: runtime.APP_ROLLOUT_MIN_S },
	{ name: 'APP_ROLLOUT_MAX_S', value: 2_400, source: 'FR-26 step 3 spec.md:376', actual: runtime.APP_ROLLOUT_MAX_S },
	{ name: 'APP_ROLLOUT_POLL_S', value: 5, source: 'plan.md:707 (§5.3 only)', actual: runtime.APP_ROLLOUT_POLL_S },
	{
		name: 'APP_ROLLOUT_RESTARTS_FAIL',
		value: 3,
		source: 'FR-27 spec.md:384',
		actual: runtime.APP_ROLLOUT_RESTARTS_FAIL
	},
	{
		name: 'APP_ROLLOUT_STUCK_POD_S',
		value: 180,
		source: 'FR-27 spec.md:385',
		actual: runtime.APP_ROLLOUT_STUCK_POD_S
	},
	{ name: 'APP_WORKER_STABLE_S', value: 30, source: 'FR-28 spec.md:387', actual: runtime.APP_WORKER_STABLE_S },
	{
		name: 'APP_SMOKE_IN_CLUSTER_WINDOW_S',
		value: 120,
		source: 'FR-26 step 5 spec.md:378',
		actual: runtime.APP_SMOKE_IN_CLUSTER_WINDOW_S
	},
	{ name: 'APP_SMOKE_RETRY_S', value: 10, source: 'tasks.md:413', actual: runtime.APP_SMOKE_RETRY_S },
	{
		name: 'APP_SMOKE_PUBLIC_FIRST_WINDOW_S',
		value: 600,
		source: 'FR-26 step 7 spec.md:380',
		actual: runtime.APP_SMOKE_PUBLIC_FIRST_WINDOW_S
	},
	{
		name: 'APP_SMOKE_PUBLIC_WINDOW_S',
		value: 180,
		source: 'FR-26 step 7 spec.md:380',
		actual: runtime.APP_SMOKE_PUBLIC_WINDOW_S
	},
	{
		name: 'APP_SMOKE_BODY_BYTES',
		value: 1_048_576,
		source: 'FR-36 spec.md:414',
		actual: runtime.APP_SMOKE_BODY_BYTES
	},
	{ name: 'APP_SMOKE_FOUND_CHARS', value: 200, source: 'FR-37 spec.md:422', actual: runtime.APP_SMOKE_FOUND_CHARS },
	{
		name: 'APP_PUBLISH_TIMEOUT_S',
		value: 60,
		source: 'FR-26 step 6 spec.md:379',
		actual: runtime.APP_PUBLISH_TIMEOUT_S
	},
	{
		name: 'APP_DEPLOY_MAX_DURATION_S',
		value: 7_200,
		source: 'FR-29 spec.md:388',
		actual: runtime.APP_DEPLOY_MAX_DURATION_S
	},
	{ name: 'APP_ENV_SECRETS_KEPT', value: 3, source: 'plan.md:524 (§4.7)', actual: runtime.APP_ENV_SECRETS_KEPT },
	{
		name: 'APP_ROLLBACK_CANDIDATES',
		value: 20,
		source: 'FR-34 spec.md:401',
		actual: runtime.APP_ROLLBACK_CANDIDATES
	},
	{ name: 'APP_JOB_RUNS_KEPT', value: 3, source: 'plan.md:531 (§4.8)', actual: runtime.APP_JOB_RUNS_KEPT },
	{ name: 'APP_JOB_TTL_S', value: 86_400, source: 'plan.md:530 (§4.8)', actual: runtime.APP_JOB_TTL_S },
	{ name: 'APP_TMP_SIZE_MI', value: 256, source: 'spec.md:315 + plan.md:486', actual: runtime.APP_TMP_SIZE_MI },
	{ name: 'APP_PAUSE_TIMEOUT_S', value: 120, source: 'FR-49 spec.md:489', actual: runtime.APP_PAUSE_TIMEOUT_S },
	{ name: 'APP_REMOVE_TIMEOUT_S', value: 300, source: 'FR-50 spec.md:495', actual: runtime.APP_REMOVE_TIMEOUT_S },
	{ name: 'APP_HEALTH_POLL_S', value: 60, source: 'FR-47 spec.md:476', actual: runtime.APP_HEALTH_POLL_S },
	{ name: 'APP_HEALTH_BATCH', value: 500, source: 'plan.md:1275 (§9.3)', actual: runtime.APP_HEALTH_BATCH },
	{
		name: 'APP_HEALTH_POLL_TIMEOUT_S',
		value: 20,
		source: 'plan.md:1275 (§9.3)',
		actual: runtime.APP_HEALTH_POLL_TIMEOUT_S
	},
	{
		name: 'APP_HEALTH_CLUSTER_CONCURRENCY',
		value: 5,
		source: 'plan.md:1275 (§9.3)',
		actual: runtime.APP_HEALTH_CLUSTER_CONCURRENCY
	},
	{
		name: 'APP_HEALTH_FAILS_TO_NOTIFY',
		value: 5,
		source: 'FR-47 spec.md:478',
		actual: runtime.APP_HEALTH_FAILS_TO_NOTIFY
	},
	{
		name: 'APP_HEALTH_PASSES_TO_RECOVER',
		value: 3,
		source: 'FR-47 spec.md:479',
		actual: runtime.APP_HEALTH_PASSES_TO_RECOVER
	},
	{
		name: 'APP_HEALTH_UNREACHABLE_POLLS',
		value: 10,
		source: 'FR-47 spec.md:480',
		actual: runtime.APP_HEALTH_UNREACHABLE_POLLS
	},
	{
		name: 'APP_HEALTH_NOTIFY_DEDUPE_H',
		value: 6,
		source: 'FR-47 spec.md:479',
		actual: runtime.APP_HEALTH_NOTIFY_DEDUPE_H
	},
	{ name: 'APP_STATUS_STALE_S', value: 180, source: 'FR-46 spec.md:474', actual: runtime.APP_STATUS_STALE_S },
	{
		name: 'APP_STATUS_REFRESH_MIN_S',
		value: 15,
		source: 'FR-46 spec.md:475',
		actual: runtime.APP_STATUS_REFRESH_MIN_S
	},
	{
		name: 'APP_CERT_NOTIFY_AFTER_MIN',
		value: 30,
		source: 'FR-43 spec.md:451',
		actual: runtime.APP_CERT_NOTIFY_AFTER_MIN
	},
	{ name: 'APP_LOG_LINES_DEFAULT', value: 200, source: 'FR-48 spec.md:482', actual: runtime.APP_LOG_LINES_DEFAULT },
	{ name: 'APP_LOG_LINES_MAX', value: 500, source: 'FR-48 spec.md:482', actual: runtime.APP_LOG_LINES_MAX },
	{ name: 'APP_LOG_BYTES_MAX', value: 262_144, source: 'FR-48 spec.md:483', actual: runtime.APP_LOG_BYTES_MAX },
	{ name: 'APP_LOG_CACHE_S', value: 300, source: 'FR-48 spec.md:484', actual: runtime.APP_LOG_CACHE_S },
	{
		name: 'APP_LOG_REDACT_MIN_CHARS',
		value: 8,
		source: 'FR-48 spec.md:483',
		actual: runtime.APP_LOG_REDACT_MIN_CHARS
	},
	{
		name: 'APP_CLUSTER_CHECK_TIMEOUT_S',
		value: 30,
		source: 'FR-6 spec.md:278',
		actual: runtime.APP_CLUSTER_CHECK_TIMEOUT_S
	},
	{
		name: 'APP_CLUSTER_DIAL_TIMEOUT_S',
		value: 10,
		source: 'plan.md:980 (§6.3)',
		actual: runtime.APP_CLUSTER_DIAL_TIMEOUT_S
	},
	{
		name: 'APP_ISOLATION_PROBE_TIMEOUT_S',
		value: 3,
		source: 'plan.md:569 (§4.10)',
		actual: runtime.APP_ISOLATION_PROBE_TIMEOUT_S
	},
	{
		name: 'APP_DOMAIN_RECONCILE_S',
		value: 60,
		source: 'plan.md:1103 (§8.2)',
		actual: runtime.APP_DOMAIN_RECONCILE_S
	},
	{
		name: 'APP_MANAGED_MAX_PER_USER_DEFAULT',
		value: 3,
		source: 'plan.md:1115 (§8.3)',
		actual: runtime.APP_MANAGED_MAX_PER_USER_DEFAULT
	},
	{
		name: 'APP_MANAGED_CRON_MIN_INTERVAL_MIN',
		value: 5,
		source: 'plan.md:552 (§4.9)',
		actual: runtime.APP_MANAGED_CRON_MIN_INTERVAL_MIN
	},
	{
		name: 'APP_SUBDOMAIN_LABEL_MIN',
		value: 3,
		source: 'plan.md:1130 (§8.3)',
		actual: runtime.APP_SUBDOMAIN_LABEL_MIN
	},
	{ name: 'APP_PREVIEWS_MAX', value: 3, source: 'FR-53 spec.md:509', actual: runtime.APP_PREVIEWS_MAX },
	{
		name: 'APP_PREVIEW_CLOSE_REMOVE_MIN',
		value: 10,
		source: 'FR-53 spec.md:509',
		actual: runtime.APP_PREVIEW_CLOSE_REMOVE_MIN
	},
	{ name: 'APP_PREVIEW_IDLE_H', value: 72, source: 'FR-53 spec.md:510', actual: runtime.APP_PREVIEW_IDLE_H },
	{ name: 'APP_DEPLOY_LOCK_STALE_S', value: 7_260, source: 'plan.md:1039 (§7.2)', actual: APP_DEPLOY_LOCK_STALE_S }
];

/** The camelCase, `.`-free i18n leaf rule of plan §10.3:1620. */
function camelCaseLeaf(code: string): string {
	const [head, ...tail] = code.split('_');
	return `${head}${tail.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('')}`;
}

/** Every `failures.*` leaf the map actually names, in {@link APP_FAILURE_CODES} order. */
function mappedFailureLeaves(): string[] {
	return APP_FAILURE_CODES.flatMap((code) => {
		const leaf: string | null = APP_FAILURE_MESSAGE_LEAVES[code];
		return leaf === null ? [] : [leaf];
	});
}

describe('app-runtime — closed unions', () => {
	it.each(UNIONS)('%s has no duplicate members and no empty or padded one', (_name, actual) => {
		expect(actual.length).toBeGreaterThan(0);
		expect(new Set(actual).size).toBe(actual.length);
		for (const member of actual) {
			expect(typeof member).toBe('string');
			expect(member.trim()).toBe(member);
			expect(member.length).toBeGreaterThan(0);
		}
	});

	it.each(UNIONS)('%s carries exactly the members its source lists', (_name, actual, expected) => {
		expect(actual).toEqual(expected);
	});

	it('exports no array this spec does not pin', () => {
		// Totality in the other direction: a NEW closed union added to the module
		// without a row above is a failure, not a silently unpinned union.
		const exportedArrays = Object.entries(runtime)
			.filter(([, value]) => Array.isArray(value))
			.map(([name]) => name)
			.sort();
		expect(exportedArrays).toEqual(UNIONS.map(([name]) => name).sort());
	});

	it('keeps code unions in snake_case, because each member is also an i18n leaf source', () => {
		for (const code of [...APP_PRECONDITION_CODES, ...APP_FAILURE_CODES]) {
			expect(code, code).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});

	it('keeps the two deployment-state vocabularies from being confused with each other', () => {
		// The stored values are upper case and the ten user-facing ones lower case:
		// an overlap would mean one of the two readings was folded into the other.
		const stored = new Set<string>(APP_DEPLOYMENT_STATES);
		const overlap = APP_DEPLOYMENT_DISPLAY_STATES.filter((state) => stored.has(state));
		expect(overlap).toEqual([]);
	});

	it('names the ten user-facing Deployment states exactly once each', () => {
		// spec §6.7:705 lists ten; plan §10.3:1623-1624 counts "10 Deployment + 7 app".
		expect(APP_DEPLOYMENT_DISPLAY_STATES).toHaveLength(10);
		expect(APP_RUNTIME_STATES).toHaveLength(7);
		expect(APP_DEPLOY_PHASES).toHaveLength(11);
	});
});

describe('app-runtime — the deploy target (R-12)', () => {
	it('is exactly the three values of R-12 (CONTRACTS.md:55) with no fourth', () => {
		expect(APP_DEPLOY_TARGETS).toHaveLength(3);
		expect([...APP_DEPLOY_TARGETS]).toEqual(['none', 'your-cluster', 'ever-works-apps']);
	});

	it('has no separate "not yet" or deferred state (R-12)', () => {
		for (const forbidden of ['not-yet', 'notYet', 'deferred', 'later', 'none-yet']) {
			expect(APP_DEPLOY_TARGETS as readonly string[]).not.toContain(forbidden);
		}
	});

	it('reuses the array app-source.ts already declares instead of writing a second one', () => {
		// Identity, not equality: a second literal with the same strings would pass
		// an equality check and still be the drift this contract forbids.
		expect(APP_DEPLOY_TARGETS).toBe(APP_DEPLOY_TARGET_CHOICES);
	});
});

describe('app-runtime — numbers (plan §5.3, plan.md:698-752)', () => {
	it.each(NUMBERS)('$name = $value ($source)', ({ name, value, actual }) => {
		expect(actual, name).toBe(value);
	});

	it('pins every numeric export, so a new number cannot arrive unpinned', () => {
		const numericExports = Object.entries(runtime)
			.filter(([, value]) => typeof value === 'number')
			.map(([name]) => name)
			.sort();
		expect(numericExports).toEqual(NUMBERS.map(({ name }) => name).sort());
	});

	it('derives the stale deploy lock from the Deployment maximum, not from a second literal (plan §7.2:1039)', () => {
		expect(APP_DEPLOY_LOCK_STALE_S).toBe(APP_DEPLOY_MAX_DURATION_S + 60);
	});

	it('keeps the §5.3 list whole — 51 constants, no fewer', () => {
		const fromSection53 = NUMBERS.filter(({ name }) => name !== 'APP_DEPLOY_LOCK_STALE_S');
		expect(fromSection53).toHaveLength(51);
	});

	it('orders every window and ceiling the way FR-26 states it', () => {
		expect(runtime.APP_ROLLOUT_MIN_S).toBeLessThan(runtime.APP_ROLLOUT_MAX_S);
		expect(runtime.APP_SMOKE_PUBLIC_WINDOW_S).toBeLessThan(runtime.APP_SMOKE_PUBLIC_FIRST_WINDOW_S);
		expect(runtime.APP_ROLLOUT_MAX_S).toBeLessThan(runtime.APP_DEPLOY_MAX_DURATION_S);
		expect(runtime.APP_LOG_LINES_DEFAULT).toBeLessThan(runtime.APP_LOG_LINES_MAX);
		expect(runtime.APP_JOB_TTL_S).toBeGreaterThan(runtime.APP_DEPLOY_MAX_DURATION_S);
	});
});

describe('app-runtime — failure codes have their copy entry (plan §10.3:1625-1627, APW06-G25)', () => {
	it('has one APP_FAILURE_MESSAGE_LEAVES entry per failure code, and no entry for a non-code', () => {
		expect(Object.keys(APP_FAILURE_MESSAGE_LEAVES).sort()).toEqual([...APP_FAILURE_CODES].sort());
	});

	it('has exactly the named gap as its null entries', () => {
		const nulls = APP_FAILURE_CODES.filter((code) => APP_FAILURE_MESSAGE_LEAVES[code] === null);
		expect(nulls).toEqual([...APP_FAILURE_CODES_WITHOUT_MESSAGE_LEAF]);
	});

	it('gives every non-null leaf a `.`-free camelCase shape and never repeats one', () => {
		const leaves = mappedFailureLeaves();
		expect(new Set(leaves).size).toBe(leaves.length);
		for (const leaf of leaves) {
			expect(leaf, leaf).toMatch(/^[a-z][A-Za-z0-9]*$/);
		}
	});

	it('reproduces the fourteen failures.* leaves of plan §10.3 exactly', () => {
		// The mapped leaves plus the one that belongs to a warning must be the
		// plan's fourteen, in any order — a dropped or invented leaf fails here.
		expect([...mappedFailureLeaves(), ...APP_FAILURE_LEAVES_WITHOUT_FAILURE_CODE].sort()).toEqual(
			[...PLAN_10_3_FAILURE_LEAVES].sort()
		);
	});

	it('names the one leaf that is NOT the camelCase of its code, on purpose', () => {
		// plan §10.3:1626 spells the root-image leaf `imageRunsAsRoot` while the
		// code is `managed_root_forbidden`; the other twelve follow camelCase.
		expect(APP_FAILURE_MESSAGE_LEAVES.managed_root_forbidden).toBe('imageRunsAsRoot');
		for (const code of APP_FAILURE_CODES) {
			const leaf = APP_FAILURE_MESSAGE_LEAVES[code];
			if (leaf === null || code === 'managed_root_forbidden') continue;
			expect(leaf, code).toBe(camelCaseLeaf(code));
		}
	});
});

describe('app-runtime — precondition codes are reachable and copy-backed (plan §5.1, §10.3:1624)', () => {
	it('has one APP_PRECONDITION_MESSAGE_LEAVES entry per code, and no entry for a non-code', () => {
		expect(Object.keys(APP_PRECONDITION_MESSAGE_LEAVES).sort()).toEqual([...APP_PRECONDITION_CODES].sort());
	});

	it('names every precondition leaf the camelCase of its code (plan §10.3:1620)', () => {
		for (const code of APP_PRECONDITION_CODES) {
			expect(APP_PRECONDITION_MESSAGE_LEAVES[code], code).toBe(camelCaseLeaf(code));
			expect(APP_PRECONDITION_MESSAGE_LEAVES[code], code).not.toContain('.');
		}
	});

	it('has one APP_PRECONDITION_STATES entry per code, and no entry for a non-code', () => {
		expect(Object.keys(APP_PRECONDITION_STATES).sort()).toEqual([...APP_PRECONDITION_CODES].sort());
	});

	it('reaches every code from at least one NAMED app state', () => {
		const known = new Set<string>(APP_RUNTIME_STATES);
		for (const code of APP_PRECONDITION_CODES) {
			const states = APP_PRECONDITION_STATES[code] as readonly string[];
			expect(states.length, code).toBeGreaterThan(0);
			for (const state of states) {
				expect(known.has(state), `${code} → ${state}`).toBe(true);
			}
		}
	});

	it('narrows exactly the two codes §5.1 sources from a runtime state', () => {
		// §5.1:675 "runtime state `deletionRequestedAt` set" and :676 "runtime state".
		expect(APP_PRECONDITION_STATES.app_work_deleting).toEqual(['deleting']);
		expect(APP_PRECONDITION_STATES.paused).toEqual(['paused']);
		const narrowed = APP_PRECONDITION_CODES.filter((code) => APP_PRECONDITION_STATES[code].length !== 7);
		expect(narrowed).toEqual(['app_work_deleting', 'paused']);
	});

	it('carries the three codes T1 names explicitly (tasks.md:45-47)', () => {
		const codes: readonly string[] = APP_PRECONDITION_CODES;
		expect(codes).toContain('managed_ineligible');
		expect(codes).toContain('managed_sandbox_unavailable');
		expect(codes).toContain('app_work_deleting');
	});

	it('carries the precondition failure §11 names outside the §5.1 table', () => {
		// plan §11:1644 "Precondition failure `namespace_foreign`; never adopted".
		const codes: readonly string[] = APP_PRECONDITION_CODES;
		expect(codes).toContain('namespace_foreign');
		expect(APP_PRECONDITION_MESSAGE_LEAVES.namespace_foreign).toBe('namespaceForeign');
	});

	it('shares exactly the five codes that are BOTH a precondition and a failure, and no sixth', () => {
		// Not a leak: §5.1:670 lists `image_not_found` / `image_private_unsupported` /
		// `image_unresolvable` as request-time preconditions while §3.1:373 lists them
		// as the failure codes §5.8:865 ends the Deployment with, and §5.1:679's
		// `managed_root_forbidden` / `image_user_unverifiable` are §3.1:372's two
		// managed-only failure codes. The same refusal is reported through both
		// vocabularies, so the overlap is pinned rather than denied — a sixth shared
		// code, or a lost one, fails here.
		const failures = new Set<string>(APP_FAILURE_CODES);
		expect(APP_PRECONDITION_CODES.filter((code) => failures.has(code))).toEqual([
			'image_not_found',
			'image_private_unsupported',
			'image_unresolvable',
			'managed_root_forbidden',
			'image_user_unverifiable'
		]);
	});
});

describe('app-runtime — the component deadline formula (plan §5.3:754-756)', () => {
	it('gives the plan worked example: 10×60 + 10×3 + 120 = 750 s', () => {
		expect(
			appComponentDeadlineSeconds({
				startup: { periodSeconds: 10, failureThreshold: 60 },
				readiness: { periodSeconds: 10, failureThreshold: 3 }
			})
		).toBe(750);
	});

	it('clamps up to the 300 s floor and down to the 2400 s ceiling', () => {
		expect(
			appComponentDeadlineSeconds({
				startup: { periodSeconds: 1, failureThreshold: 1 },
				readiness: { periodSeconds: 0, failureThreshold: 0 }
			})
		).toBe(runtime.APP_ROLLOUT_MIN_S);
		expect(
			appComponentDeadlineSeconds({
				startup: { periodSeconds: 600, failureThreshold: 600 },
				readiness: { periodSeconds: 600, failureThreshold: 600 }
			})
		).toBe(runtime.APP_ROLLOUT_MAX_S);
	});

	it('keeps the boundaries inclusive: exactly 300 and exactly 2400 stay untouched', () => {
		expect(
			appComponentDeadlineSeconds({
				startup: { periodSeconds: 180, failureThreshold: 1 },
				readiness: { periodSeconds: 0, failureThreshold: 0 }
			})
		).toBe(300);
		expect(
			appComponentDeadlineSeconds({
				startup: { periodSeconds: 2_280, failureThreshold: 1 },
				readiness: { periodSeconds: 0, failureThreshold: 0 }
			})
		).toBe(2_400);
	});

	it('fails closed on an unmeasurable tolerance: the floor, never NaN and never an unbounded wait', () => {
		for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			const deadline = appComponentDeadlineSeconds({
				startup: { periodSeconds: broken, failureThreshold: 60 },
				readiness: { periodSeconds: broken, failureThreshold: broken }
			});
			expect(Number.isFinite(deadline), String(broken)).toBe(true);
			expect(deadline, String(broken)).toBe(runtime.APP_ROLLOUT_MIN_S);
		}
	});
});

describe('app-runtime — reachable from the package root (tasks.md:48-53)', () => {
	it('re-exports the module through the apps barrel', () => {
		expect(appsBarrel.APP_PREPARE_TIMEOUT_S).toBe(runtime.APP_PREPARE_TIMEOUT_S);
		expect(appsBarrel.APP_DEPLOY_TARGETS).toBe(runtime.APP_DEPLOY_TARGETS);
	});

	it('resolves the T1 Done-when import, APP_ROLLOUT_MAX_S from the package root', () => {
		// `import { APP_ROLLOUT_MAX_S } from '@ever-works/contracts'` (tasks.md:52-53):
		// src/index.ts re-exports ./apps/index.js, and both hops are plain `export *`
		// so the runtime value — not only the type — arrives at the root.
		expect(packageRoot.APP_ROLLOUT_MAX_S).toBe(2_400);
		expect(packageRoot.APP_FAILURE_CODES).toBe(runtime.APP_FAILURE_CODES);
	});
});

describe('app-runtime — the derived unions reject what they do not list', () => {
	it('is enforced by the type checker, not only at run time', () => {
		// Each line below is a COMPILE error that `@ts-expect-error` asserts must
		// exist: if a union ever grew one of these members, `pnpm type-check:tests`
		// would fail on an unused directive instead of the pin going quiet.
		// @ts-expect-error R-12 has no "not yet" target (CONTRACTS.md:55)
		const target: AppDeployTarget = 'not-yet';
		// @ts-expect-error a Deployment display state is not an app state (plan §3.1:368)
		const state: AppRuntimeState = 'deploying';
		// @ts-expect-error `public-smoke` is the phase, and there is no `public-smoke-check`
		const phase: AppDeployPhase = 'public-smoke-check';
		// @ts-expect-error `image_not_pinned` is a precondition, not a failure code (plan §5.1:669)
		const failure: AppFailureCode = 'image_not_pinned';
		// @ts-expect-error `live` is an app state, not a health value (plan §7.2:1052)
		const health: AppRuntimeHealth = 'live';
		// @ts-expect-error `stale` is a status flag, not a precondition code
		const precondition: AppPreconditionCode = 'stale';
		// @ts-expect-error the stored deployment state is upper case (`ready`, not `READY`)
		const deployment: AppDeploymentState = 'ready';

		expect([target, state, phase, failure, health, precondition, deployment]).toHaveLength(7);
	});
});

describe('app-runtime — AppPrecondition (plan §3.1:375, §5.1:674)', () => {
	it('requires only `code` and `message`, so a producer with no names and no fix still fits', () => {
		const bare: AppPrecondition = { code: 'paused', message: 'This app is paused.' };
		const full: AppPrecondition = {
			code: 'env_required_unset',
			names: ['DATABASE_URL', 'SMTP_HOST'],
			message: 'Two required values are unset.',
			fixUrl: '/works/w1/app/settings#env'
		};
		// @ts-expect-error `message` is required — a precondition with no sentence is not reportable
		const noMessage: AppPrecondition = { code: 'paused' };
		// @ts-expect-error `code` is a §5.1 code; `stale` is a status flag (plan §7.2)
		const badCode: AppPrecondition = { code: 'stale', message: 'x' };

		expect(Object.keys(bare)).toEqual(['code', 'message']);
		expect(full.names).toHaveLength(2);
		expect(full.fixUrl).toBeDefined();
		expect([noMessage, badCode]).toHaveLength(2);
	});

	it('accepts every §5.1 code, so no row of that table is a compile error', () => {
		// One `AppPrecondition` per code, built the way a producer would build
		// it: the message leaf is the code's own English leaf (plan §10.3). The
		// assignment is the assertion — a code missing from the union fails
		// `type-check:tests`, not merely this loop.
		const all: AppPrecondition[] = APP_PRECONDITION_CODES.map((code) => ({
			code,
			message: APP_PRECONDITION_MESSAGE_LEAVES[code]
		}));

		expect(all).toHaveLength(APP_PRECONDITION_CODES.length);
		expect(all.every((precondition) => typeof precondition.message === 'string')).toBe(true);
	});

	it('is satisfied by the render refusals the k8s plugin already returns', () => {
		// `AppRenderRefusal` says "`AppPrecondition`-shaped" in both renderers.
		// These are its three codes; each must be a precondition code, or that
		// comment is a lie and a caller cannot hand them to `unmet`.
		const renderRefusalCodes = ['volume_replicas', 'volume_shrink', 'privileged_port'] as const;

		for (const code of renderRefusalCodes) {
			const shaped: AppPrecondition = { code, message: 'Refused by the renderer.' };
			expect(APP_PRECONDITION_CODES).toContain(shaped.code);
		}
	});
});
