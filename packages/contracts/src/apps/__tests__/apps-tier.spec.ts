/**
 * APW-10 T1 — the launch gate's ids, outcomes, reason codes and numeric
 * constants, pinned so that no member can be added, removed, renamed or
 * reordered without this file being edited in the same change.
 *
 * Owning epic: **APW-10 (Ever Works Apps — isolated hosting tier)**, task
 * `tasks.md` T1:51–71. The contract under test is
 * `packages/contracts/src/apps/apps-tier.ts`. The shared-surface spec
 * `builds.spec.ts` spot-checks part of the same module from APW-05's side; both
 * are pins and both must stay green — this file is the epic's own, complete
 * reading of T1 and is deliberately stricter (exact member lists in order, plus
 * the compile-time union maps).
 *
 * Traceability, one line per group:
 *
 * | Group                                         | Authority                                                    |
 * | --------------------------------------------- | ------------------------------------------------------------ |
 * | the 25 ids and the item registry              | spec FR-1/FR-2:176–207, ACC-10-01                            |
 * | kind, phase and outcome                       | tasks T1:52–54, spec FR-5:222–223                            |
 * | the self-check budget, timeouts and cadence    | spec FR-6:224, FR-8:230–231, ACC-10-02, ACC-10-07            |
 * | the probe reason codes                        | plan §3.7:437–464, plan §5.4:677–697                         |
 * | tier states, scopes and closed reasons        | plan §5.4:677–704, spec FR-13, FR-16                         |
 * | Work states/phases, quarantine, signals       | plan §3.1:236–266, plan §4:520, spec FR-27, FR-41, FR-44     |
 * | eligibility reasons                           | spec FR-35:332–334, plan §5.5:717                            |
 * | the numeric constants                         | tasks T1:57–63                                               |
 *
 * The `Record<Union, true>` maps passed to `expectExhaustive` are the
 * compile-time half of the pin: every union here is derived from its `as const`
 * array, so a member added to the module without a line in the map is a type
 * error under the package's `type-check:tests` config (which includes
 * `**` + `/*.spec.ts`), while a member added to an array is caught at run time
 * by `expectExactMembers`. Neither half alone is enough: the run-time half
 * cannot see a union whose array was not touched, and the compile half cannot
 * see a reordering.
 */

import { describe, expect, it } from 'vitest';

import {
	APPS_TIER_AUTO_REOPENABLE_REASON_CODES,
	APPS_TIER_BILLING_QUARANTINE_CATEGORY,
	APPS_TIER_CLOSED_REASON_CODES,
	APPS_TIER_ELIGIBILITY_DISABLED_REASONS,
	APPS_TIER_ELIGIBILITY_REASONS,
	APPS_TIER_PAUSE_ALL_CATEGORY,
	APPS_TIER_PAUSE_ALL_CONFIRMATION,
	APPS_TIER_POLICY_DEFAULT_SCOPE,
	APPS_TIER_PROBE_REASON_CODES,
	APPS_TIER_QUARANTINE_CATEGORIES,
	APPS_TIER_QUARANTINE_SOURCES,
	APPS_TIER_SCOPES,
	APPS_TIER_SIGNAL_KINDS,
	APPS_TIER_SIGNAL_SEVERITIES,
	APPS_TIER_STATES,
	APPS_TIER_WORK_DESIRED_STATES,
	APPS_TIER_WORK_PHASES,
	ATTESTATION_NOTICE_DAYS,
	ATTESTATION_TTL_DAYS,
	DETECTOR_QUARANTINE_MS,
	evaluateAppsTierPolicyState,
	GATE_MAX_AGE_HOURS,
	GATE_WATCH_INTERVAL_MIN,
	HEARTBEAT_MAX_AGE_MS,
	IMAGE_ALLOWANCE_MAX_DAYS,
	LAUNCH_GATE_ITEM_IDS,
	LAUNCH_GATE_ITEMS,
	LAUNCH_GATE_KINDS,
	LAUNCH_GATE_OUTCOMES,
	LAUNCH_GATE_PHASES,
	launchGateItemsForPhase,
	PROBE_ATTEMPTS,
	PROBE_CONNECT_TIMEOUT_MS,
	PULL_CREDENTIAL_MAX_MS,
	QUARANTINE_EDGE_MS,
	QUARANTINE_ISOLATE_MS,
	QUARANTINE_SCALE_MS,
	RELEASE_RESTORE_MS,
	REMOVED_DATA_RETENTION_DAYS,
	SELF_CHECK_BUDGET_MS,
	SELF_CHECK_INTERVAL_HOURS
} from '../apps-tier.js';

import type {
	AppsTierClosedReasonCode,
	AppsTierEligibilityReason,
	AppsTierPolicyEvaluationInput,
	AppsTierProbeReasonCode,
	AppsTierQuarantineCategory,
	AppsTierQuarantineSource,
	AppsTierScope,
	AppsTierSignalKind,
	AppsTierSignalSeverity,
	AppsTierState,
	AppsTierWorkDesiredState,
	AppsTierWorkPhase,
	LaunchGateItemId,
	LaunchGateKind,
	LaunchGateOutcome,
	LaunchGatePhase
} from '../apps-tier.js';

/* ------------------------------------------------------------------------- *
 * Helpers — the same two the shared-surface spec uses, so a reader who knows
 * one file knows the other.
 * ------------------------------------------------------------------------- */

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
 * total `Record<Union, true>`, so a member added to the union without a line
 * here is a compile error under `pnpm type-check:tests`, and a member added to
 * the array is a run-time mismatch here.
 */
function expectExhaustive<T extends string>(members: readonly T[], exhaustive: Record<T, true>): void {
	expect(Object.keys(exhaustive).sort()).toEqual([...members].sort());
}

/* ------------------------------------------------------------------------- *
 * The 25 gate items (spec FR-2:181–207, ACC-10-01)
 * ------------------------------------------------------------------------- */

/** The reviewed order of the spec's table, transcribed one id per row. */
const EXPECTED_GATE_IDS: readonly string[] = [
	'LG-01',
	'LG-02',
	'LG-03',
	'LG-04',
	'LG-05',
	'LG-06',
	'LG-07',
	'LG-08',
	'LG-09',
	'LG-10',
	'LG-11',
	'LG-12',
	'LG-13',
	'LG-14',
	'LG-15',
	'LG-16',
	'LG-17',
	'LG-18',
	'LG-19',
	'LG-20',
	'LG-21',
	'LG-22',
	'LG-23',
	'LG-24',
	'LG-25'
];

/**
 * The frozen registry, title by title from spec FR-2's "Item" column and kind
 * and phase from its "Kind" (lower-cased) and "Phase" columns. A reordering, a
 * retitle or a kind/phase change is a reviewed change to the spec (FR-1:176–178)
 * and must redden this test in the same change.
 */
const EXPECTED_GATE_ITEMS: readonly {
	readonly id: string;
	readonly title: string;
	readonly kind: string;
	readonly phase: string;
}[] = [
	{ id: 'LG-01', title: 'Dedicated capacity', kind: 'attested', phase: 'P2' },
	{ id: 'LG-02', title: 'Network segmentation', kind: 'both', phase: 'P2' },
	{ id: 'LG-03', title: 'Separate egress identity', kind: 'both', phase: 'P2' },
	{ id: 'LG-04', title: 'Sandboxed runtime, enforced', kind: 'automated', phase: 'P2' },
	{ id: 'LG-05', title: 'Restricted pod security by default', kind: 'automated', phase: 'P2' },
	{ id: 'LG-06', title: 'Default-deny networking', kind: 'automated', phase: 'P2' },
	{ id: 'LG-07', title: 'Egress deny list', kind: 'automated', phase: 'P2' },
	{ id: 'LG-08', title: 'Mail and mining ports blocked', kind: 'automated', phase: 'P2' },
	{ id: 'LG-09', title: 'Quotas and limits', kind: 'automated', phase: 'P2' },
	{ id: 'LG-10', title: 'One namespace per App Work', kind: 'automated', phase: 'P2' },
	{ id: 'LG-11', title: 'No platform credentials in tenants', kind: 'automated', phase: 'P2' },
	{ id: 'LG-12', title: 'Platform credential is narrow', kind: 'automated', phase: 'P2' },
	{ id: 'LG-13', title: 'Image supply chain', kind: 'automated', phase: 'P2' },
	{ id: 'LG-14', title: 'Tenant-only data servers', kind: 'both', phase: 'P2' },
	{ id: 'LG-15', title: 'User-apps domain', kind: 'both', phase: 'P2' },
	{ id: 'LG-16', title: 'Separate edge', kind: 'both', phase: 'P2' },
	{ id: 'LG-17', title: 'Custom hostnames', kind: 'automated', phase: 'P2' },
	{ id: 'LG-18', title: 'Tenant quarantine drill', kind: 'automated', phase: 'P2' },
	{ id: 'LG-19', title: 'Abuse controls', kind: 'both', phase: 'P2' },
	{ id: 'LG-20', title: 'Metering flowing', kind: 'automated', phase: 'P2' },
	{ id: 'LG-21', title: 'Audit trail', kind: 'both', phase: 'P2' },
	{ id: 'LG-22', title: 'Policies from Git, no drift', kind: 'automated', phase: 'P2' },
	{ id: 'LG-23', title: 'Controller healthy', kind: 'automated', phase: 'P2' },
	{ id: 'LG-24', title: 'Sandboxed in-zone builds', kind: 'both', phase: 'P3' },
	{ id: 'LG-25', title: 'Build limits', kind: 'automated', phase: 'P3' }
];

describe('apps-tier.ts — the 25 launch-gate ids (spec FR-1/FR-2, ACC-10-01)', () => {
	it('LAUNCH_GATE_ITEM_IDS is LG-01 … LG-25, in the spec table’s order', () => {
		expectExactMembers('LAUNCH_GATE_ITEM_IDS', LAUNCH_GATE_ITEM_IDS, EXPECTED_GATE_IDS);
		expect(LAUNCH_GATE_ITEM_IDS).toHaveLength(25);
		expect(LAUNCH_GATE_ITEM_IDS[0]).toBe('LG-01');
		expect(LAUNCH_GATE_ITEM_IDS[24]).toBe('LG-25');
	});

	it('every gate item id is a member of the declared union (compile-level pin)', () => {
		// A 26th id in the array is a missing key here — a compile error, not a
		// green test that merely forgot to look.
		expectExhaustive<LaunchGateItemId>(LAUNCH_GATE_ITEM_IDS, {
			'LG-01': true,
			'LG-02': true,
			'LG-03': true,
			'LG-04': true,
			'LG-05': true,
			'LG-06': true,
			'LG-07': true,
			'LG-08': true,
			'LG-09': true,
			'LG-10': true,
			'LG-11': true,
			'LG-12': true,
			'LG-13': true,
			'LG-14': true,
			'LG-15': true,
			'LG-16': true,
			'LG-17': true,
			'LG-18': true,
			'LG-19': true,
			'LG-20': true,
			'LG-21': true,
			'LG-22': true,
			'LG-23': true,
			'LG-24': true,
			'LG-25': true
		});
	});

	it('LAUNCH_GATE_ITEMS is the frozen registry, in the same order', () => {
		expect(LAUNCH_GATE_ITEMS).toHaveLength(25);
		expect(LAUNCH_GATE_ITEMS.map((item) => item.id)).toEqual([...EXPECTED_GATE_IDS]);
		expect([...LAUNCH_GATE_ITEMS]).toEqual(EXPECTED_GATE_ITEMS);
	});

	it('splits the phases exactly as FR-3 does', () => {
		// FR-3:213–215 — P2 requires 23 items, P3 the two in-zone build items
		// (Resolution R-24). A third P3 item, or a P2 item moved to P3, is a
		// change to which wave may open.
		expect(launchGateItemsForPhase('P2')).toHaveLength(23);
		expect(launchGateItemsForPhase('P3').map((item) => item.id)).toEqual(['LG-24', 'LG-25']);
		expect(launchGateItemsForPhase('P2').map((item) => item.id)).toEqual([...EXPECTED_GATE_IDS].slice(0, 23));
	});
});

/* ------------------------------------------------------------------------- *
 * Kind, phase, outcome (tasks T1:52–54)
 * ------------------------------------------------------------------------- */

describe('apps-tier.ts — the kind, phase and outcome vocabularies (tasks T1:52–54)', () => {
	it('pins LAUNCH_GATE_KINDS (spec FR-1:176–178)', () => {
		expectExactMembers('LAUNCH_GATE_KINDS', LAUNCH_GATE_KINDS, ['automated', 'attested', 'both']);
		expectExhaustive<LaunchGateKind>(LAUNCH_GATE_KINDS, { automated: true, attested: true, both: true });
	});

	it('pins LAUNCH_GATE_PHASES (Resolution R-24)', () => {
		expectExactMembers('LAUNCH_GATE_PHASES', LAUNCH_GATE_PHASES, ['P2', 'P3']);
		expectExhaustive<LaunchGatePhase>(LAUNCH_GATE_PHASES, { P2: true, P3: true });
	});

	it('pins LAUNCH_GATE_OUTCOMES — only `passed` counts (spec FR-5:222–223)', () => {
		expectExactMembers('LAUNCH_GATE_OUTCOMES', LAUNCH_GATE_OUTCOMES, ['passed', 'failed', 'inconclusive', 'error']);
		expectExhaustive<LaunchGateOutcome>(LAUNCH_GATE_OUTCOMES, {
			passed: true,
			failed: true,
			inconclusive: true,
			error: true
		});
	});
});

/* ------------------------------------------------------------------------- *
 * Reason codes (plan §3.7 and §5.4)
 * ------------------------------------------------------------------------- */

/**
 * Plan §3.7's "Failure reason codes" column, probe by probe, in the module's
 * order, plus `PHASE_NOT_ENABLED` (a P2-only item in a P1 run is **inconclusive**,
 * never `passed` and never skipped — plan §3.7:466–473) and `misconfigured`
 * (a probe missing its FR-7 minimum targets reports **Error** — plan §3.7:464).
 */
const EXPECTED_PROBE_REASON_CODES: readonly string[] = [
	'PHASE_NOT_ENABLED',
	'misconfigured',
	'PRIVATE_RANGE_REACHABLE',
	'PLATFORM_ENDPOINT_REACHABLE',
	'CONTROL_UNREACHABLE',
	'EGRESS_IDENTITY_SHARED',
	'SANDBOX_KERNEL_NOT_DETECTED',
	'UNSANDBOXED_POD_ADMITTED',
	'PRIVILEGED_POD_ADMITTED',
	'CROSS_TENANT_REACHABLE',
	'DIRECT_POD_INGRESS_REACHABLE',
	'METADATA_REACHABLE',
	'CONTROL_PLANE_REACHABLE',
	'MAIL_PORT_OPEN',
	'MINING_PORT_OPEN',
	'QUOTA_MISMATCH',
	'LOADBALANCER_ADMITTED',
	'OVER_QUOTA_ADMITTED',
	'NAMESPACE_SHARED',
	'NAMESPACE_FIELD_ACCEPTED',
	'SA_TOKEN_PRESENT',
	'PLANTED_CREDENTIAL_ADMITTED',
	'CREDENTIAL_TOO_BROAD',
	'UNSIGNED_IMAGE_ADMITTED',
	'FOREIGN_IMAGE_ADMITTED',
	'VULNERABLE_IMAGE_PROMOTED',
	'CROSS_TENANT_DB_REACHABLE',
	'CONNECTION_LIMIT_NOT_ENFORCED',
	'STATEMENT_TIMEOUT_NOT_ENFORCED',
	'APEX_UNDER_PLATFORM_DOMAIN',
	'APEX_NOT_ON_PSL',
	'PSL_UNREACHABLE',
	'CANARY_TLS_INVALID',
	'CANARY_UNREACHABLE',
	'CUSTOM_HOSTNAME_NOT_ACTIVE',
	'UNREGISTERED_HOST_ADMITTED',
	'QUARANTINE_ISOLATION_SLOW',
	'QUARANTINE_SCALE_SLOW',
	'QUARANTINE_EDGE_SLOW',
	'QUARANTINE_NOT_ISOLATING',
	'RELEASE_SLOW',
	'MARKER_LOST',
	'BANDWIDTH_LIMIT_MISSING',
	'SENSOR_SILENT',
	'SIGNAL_NOT_IMPORTED',
	'USAGE_REPORT_STALE',
	'USAGE_IMPORT_STALE',
	'AUDIT_ROWS_MISSING',
	'POLICY_DRIFT',
	'POLICY_MANIFEST_MISSING',
	'HEARTBEAT_STALE',
	'CONTROLLER_TOO_OLD',
	'BUILD_UNSANDBOXED',
	'BUILD_EGRESS_OPEN',
	'BUILD_PUSH_CROSS_TENANT',
	'BUILD_CAP_NOT_ENFORCED'
];

describe('apps-tier.ts — every reason code of plan §3.7 and §5.4 (tasks T1:54–55)', () => {
	it('APPS_TIER_PROBE_REASON_CODES is exactly the plan §3.7 catalogue, in order', () => {
		expectExactMembers('APPS_TIER_PROBE_REASON_CODES', APPS_TIER_PROBE_REASON_CODES, EXPECTED_PROBE_REASON_CODES);
		expect(APPS_TIER_PROBE_REASON_CODES).toHaveLength(56);
		// The two codes the §3.7 table does not carry in its own column.
		expect([...APPS_TIER_PROBE_REASON_CODES], 'PHASE_NOT_ENABLED (plan §3.7:466–473)').toContain(
			'PHASE_NOT_ENABLED'
		);
		expect([...APPS_TIER_PROBE_REASON_CODES], 'misconfigured (plan §3.7:464)').toContain('misconfigured');
	});

	it('every probe reason code is a member of the declared union (compile-level pin)', () => {
		const exhaustive: Record<AppsTierProbeReasonCode, true> = {
			PHASE_NOT_ENABLED: true,
			misconfigured: true,
			PRIVATE_RANGE_REACHABLE: true,
			PLATFORM_ENDPOINT_REACHABLE: true,
			CONTROL_UNREACHABLE: true,
			EGRESS_IDENTITY_SHARED: true,
			SANDBOX_KERNEL_NOT_DETECTED: true,
			UNSANDBOXED_POD_ADMITTED: true,
			PRIVILEGED_POD_ADMITTED: true,
			CROSS_TENANT_REACHABLE: true,
			DIRECT_POD_INGRESS_REACHABLE: true,
			METADATA_REACHABLE: true,
			CONTROL_PLANE_REACHABLE: true,
			MAIL_PORT_OPEN: true,
			MINING_PORT_OPEN: true,
			QUOTA_MISMATCH: true,
			LOADBALANCER_ADMITTED: true,
			OVER_QUOTA_ADMITTED: true,
			NAMESPACE_SHARED: true,
			NAMESPACE_FIELD_ACCEPTED: true,
			SA_TOKEN_PRESENT: true,
			PLANTED_CREDENTIAL_ADMITTED: true,
			CREDENTIAL_TOO_BROAD: true,
			UNSIGNED_IMAGE_ADMITTED: true,
			FOREIGN_IMAGE_ADMITTED: true,
			VULNERABLE_IMAGE_PROMOTED: true,
			CROSS_TENANT_DB_REACHABLE: true,
			CONNECTION_LIMIT_NOT_ENFORCED: true,
			STATEMENT_TIMEOUT_NOT_ENFORCED: true,
			APEX_UNDER_PLATFORM_DOMAIN: true,
			APEX_NOT_ON_PSL: true,
			PSL_UNREACHABLE: true,
			CANARY_TLS_INVALID: true,
			CANARY_UNREACHABLE: true,
			CUSTOM_HOSTNAME_NOT_ACTIVE: true,
			UNREGISTERED_HOST_ADMITTED: true,
			QUARANTINE_ISOLATION_SLOW: true,
			QUARANTINE_SCALE_SLOW: true,
			QUARANTINE_EDGE_SLOW: true,
			QUARANTINE_NOT_ISOLATING: true,
			RELEASE_SLOW: true,
			MARKER_LOST: true,
			BANDWIDTH_LIMIT_MISSING: true,
			SENSOR_SILENT: true,
			SIGNAL_NOT_IMPORTED: true,
			USAGE_REPORT_STALE: true,
			USAGE_IMPORT_STALE: true,
			AUDIT_ROWS_MISSING: true,
			POLICY_DRIFT: true,
			POLICY_MANIFEST_MISSING: true,
			HEARTBEAT_STALE: true,
			CONTROLLER_TOO_OLD: true,
			BUILD_UNSANDBOXED: true,
			BUILD_EGRESS_OPEN: true,
			BUILD_PUSH_CROSS_TENANT: true,
			BUILD_CAP_NOT_ENFORCED: true
		};
		expectExhaustive<AppsTierProbeReasonCode>(APPS_TIER_PROBE_REASON_CODES, exhaustive);
	});

	it('APPS_TIER_CLOSED_REASON_CODES is exactly plan §5.4, and the auto-reopenable pair is a subset', () => {
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
		expectExhaustive<AppsTierClosedReasonCode>(APPS_TIER_CLOSED_REASON_CODES, {
			CEILING_OFF: true,
			CLOSED_BY_OPERATOR: true,
			SCOPE_NOT_ALLOWED: true,
			NO_RUN: true,
			RUN_NOT_GREEN: true,
			RUN_STALE: true,
			NOT_ATTESTED: true,
			ATTESTATION_EXPIRED: true,
			CONTROLLER_STALE: true,
			CONTROLLER_TOO_OLD: true
		});
		// FR-16: an automatic close reopens from a stale self-check or a silent
		// controller, and from nothing else.
		expectExactMembers('APPS_TIER_AUTO_REOPENABLE_REASON_CODES', APPS_TIER_AUTO_REOPENABLE_REASON_CODES, [
			'RUN_STALE',
			'CONTROLLER_STALE'
		]);
		for (const reason of APPS_TIER_AUTO_REOPENABLE_REASON_CODES) {
			expect([...APPS_TIER_CLOSED_REASON_CODES], `${reason} must be a closed reason`).toContain(reason);
		}
	});
});

/* ------------------------------------------------------------------------- *
 * Tier state, scope, Work states and the quarantine and signal vocabularies
 * ------------------------------------------------------------------------- */

describe('apps-tier.ts — tier state, scope and the Work vocabularies (tasks T1:55–57)', () => {
	it('pins the three tier states and the two scopes (spec FR-13, plan §5.4)', () => {
		expectExactMembers('APPS_TIER_STATES', APPS_TIER_STATES, ['closed', 'open-verified-blueprints', 'open-any']);
		expectExhaustive<AppsTierState>(APPS_TIER_STATES, {
			closed: true,
			'open-verified-blueprints': true,
			'open-any': true
		});
		expectExactMembers('APPS_TIER_SCOPES', APPS_TIER_SCOPES, ['verified-blueprints', 'any']);
		expectExhaustive<AppsTierScope>(APPS_TIER_SCOPES, { 'verified-blueprints': true, any: true });
		// plan §5.4:680 — the scope an installation serves when the env var is unset.
		expect(APPS_TIER_POLICY_DEFAULT_SCOPE).toBe('verified-blueprints');
	});

	it('pins Work.spec.desiredState, including `removed` (Resolution R-15, plan §3.1:236)', () => {
		expectExactMembers('APPS_TIER_WORK_DESIRED_STATES', APPS_TIER_WORK_DESIRED_STATES, [
			'running',
			'paused',
			'quarantined',
			'removed'
		]);
		expectExhaustive<AppsTierWorkDesiredState>(APPS_TIER_WORK_DESIRED_STATES, {
			running: true,
			paused: true,
			quarantined: true,
			removed: true
		});
	});

	it('pins Work.status.phase, including `Removed` (spec FR-27:298–299)', () => {
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
	});

	it('pins the quarantine categories and sources (spec FR-41:356, FR-44:366, plan §3.1:239)', () => {
		expectExactMembers('APPS_TIER_QUARANTINE_CATEGORIES', APPS_TIER_QUARANTINE_CATEGORIES, [
			'abuse',
			'security',
			'billing',
			'legal',
			'pause-all',
			'drill'
		]);
		expectExhaustive<AppsTierQuarantineCategory>(APPS_TIER_QUARANTINE_CATEGORIES, {
			abuse: true,
			security: true,
			billing: true,
			legal: true,
			'pause-all': true,
			drill: true
		});
		// `self-check` is the source LG-21 asserts on (plan §3.7:458).
		expectExactMembers('APPS_TIER_QUARANTINE_SOURCES', APPS_TIER_QUARANTINE_SOURCES, [
			'operator',
			'detector',
			'self-check'
		]);
		expectExhaustive<AppsTierQuarantineSource>(APPS_TIER_QUARANTINE_SOURCES, {
			operator: true,
			detector: true,
			'self-check': true
		});
		// FR-44 — Pause all records Security and requires the typed confirmation.
		expect(APPS_TIER_PAUSE_ALL_CATEGORY).toBe('security');
		expect(APPS_TIER_PAUSE_ALL_CONFIRMATION).toBe('PAUSE ALL');
		// FR-60:425–429 — the Billing stop after the grace period.
		expect(APPS_TIER_BILLING_QUARANTINE_CATEGORY).toBe('billing');
	});

	it('pins the signal kinds and severities (spec FR-37:338–340)', () => {
		expectExactMembers('APPS_TIER_SIGNAL_KINDS', APPS_TIER_SIGNAL_KINDS, [
			'runtime',
			'mining',
			'mail',
			'bandwidth',
			'report'
		]);
		expectExhaustive<AppsTierSignalKind>(APPS_TIER_SIGNAL_KINDS, {
			runtime: true,
			mining: true,
			mail: true,
			bandwidth: true,
			report: true
		});
		expectExactMembers('APPS_TIER_SIGNAL_SEVERITIES', APPS_TIER_SIGNAL_SEVERITIES, ['low', 'medium', 'high']);
		expectExhaustive<AppsTierSignalSeverity>(APPS_TIER_SIGNAL_SEVERITIES, {
			low: true,
			medium: true,
			high: true
		});
	});

	it('pins the eligibility reasons in the order plan §5.5:717 reports them (spec FR-35)', () => {
		expectExactMembers('APPS_TIER_ELIGIBILITY_REASONS', APPS_TIER_ELIGIBILITY_REASONS, [
			'emailUnverified',
			'planRequired',
			'ownerQuarantined',
			'capReached',
			'tierClosed'
		]);
		expectExhaustive<AppsTierEligibilityReason>(APPS_TIER_ELIGIBILITY_REASONS, {
			emailUnverified: true,
			planRequired: true,
			ownerQuarantined: true,
			capReached: true,
			tierClosed: true
		});
		// plan §5.5:722–723 — what APW-06's disabled default answers with.
		expect([...APPS_TIER_ELIGIBILITY_DISABLED_REASONS]).toEqual(['tierClosed']);
	});
});

/* ------------------------------------------------------------------------- *
 * The numeric constants (tasks T1:57–63)
 * ------------------------------------------------------------------------- */

/** Gate evaluation and self-check. */
function gateInput(now: number, overrides: Partial<AppsTierPolicyEvaluationInput> = {}): AppsTierPolicyEvaluationInput {
	return {
		ceilingEnabled: true,
		maxScope: 'any',
		lastEvent: { state: 'open-any', automatic: false, reasonCodes: [] },
		latestRun: { status: 'green', finishedAtEpochMs: 0, coversScope: 'any' },
		attestationReasons: [],
		// Fresh unless a test overrides it, so the heartbeat never decides a
		// max-age assertion by accident.
		controllerRenewedAtEpochMs: now,
		controllerVersion: '1.4.0',
		controllerMinVersion: '1.0.0',
		// Deliberately higher than the plan's cap: the evaluation must apply the
		// constant, not the operator's setting.
		gateMaxAgeHours: 48,
		now,
		...overrides
	};
}

describe('apps-tier.ts — the T1 numeric constants (tasks T1:57–63)', () => {
	it('pins every constant to the plan’s literal', () => {
		expect(GATE_MAX_AGE_HOURS).toBe(24); // FR-3:213–215
		expect(SELF_CHECK_BUDGET_MS).toBe(900_000); // FR-6:224–225, 15 min
		expect(PROBE_CONNECT_TIMEOUT_MS).toBe(3_000); // FR-6:224
		expect(PROBE_ATTEMPTS).toBe(2); // FR-6:224
		expect(SELF_CHECK_INTERVAL_HOURS).toBe(6); // FR-8:230–231, ACC-10-07
		expect(ATTESTATION_TTL_DAYS).toBe(90); // FR-11:239–241
		expect([...ATTESTATION_NOTICE_DAYS]).toEqual([14, 1]); // FR-12:242–243
		expect(HEARTBEAT_MAX_AGE_MS).toBe(120_000); // FR-3:215, FR-29:309
		expect(GATE_WATCH_INTERVAL_MIN).toBe(5); // FR-16:253–254
		expect(QUARANTINE_ISOLATE_MS).toBe(15_000); // LG-18:200
		expect(QUARANTINE_SCALE_MS).toBe(60_000); // LG-18:200
		expect(QUARANTINE_EDGE_MS).toBe(120_000); // LG-18:200
		expect(RELEASE_RESTORE_MS).toBe(180_000); // LG-18:200
		expect(DETECTOR_QUARANTINE_MS).toBe(60_000); // FR-39:344–346
		expect(IMAGE_ALLOWANCE_MAX_DAYS).toBe(30); // FR-31:316–318
		expect(PULL_CREDENTIAL_MAX_MS).toBe(900_000); // FR-32:319–320, 15 min
		expect(REMOVED_DATA_RETENTION_DAYS).toBe(30); // FR-28:301–306
		// The two numbers that must stay ordered for the gate to be reachable:
		// a run may take longer than one probe's connect timeout, and the
		// self-check period is not shorter than the age a green run keeps.
		expect(SELF_CHECK_BUDGET_MS).toBeGreaterThan(PROBE_CONNECT_TIMEOUT_MS * PROBE_ATTEMPTS);
		expect(SELF_CHECK_INTERVAL_HOURS).toBeLessThan(GATE_MAX_AGE_HOURS);
	});

	it('applies GATE_MAX_AGE_HOURS as the cap on the operator’s setting (plan §5.4:687)', () => {
		// The literal `min(env, 24)` boundary, NOT the constant, so a changed
		// constant moves the code and reddens this assertion rather than
		// rescaling the boundary with it.
		const capMs = 24 * 3_600_000;
		expect(evaluateAppsTierPolicyState(gateInput(capMs)).reasons).toEqual([]);
		expect(evaluateAppsTierPolicyState(gateInput(capMs + 1)).reasons).toEqual(['RUN_STALE']);
	});

	it('applies HEARTBEAT_MAX_AGE_MS to the controller heartbeat (plan §5.4:694)', () => {
		expect(evaluateAppsTierPolicyState(gateInput(120_000, { controllerRenewedAtEpochMs: 0 })).reasons).toEqual([]);
		expect(evaluateAppsTierPolicyState(gateInput(120_001, { controllerRenewedAtEpochMs: 0 })).reasons).toEqual([
			'CONTROLLER_STALE'
		]);
	});
});
