/**
 * Ever Works Apps — the managed hosting tier's desired-state model and gate.
 *
 * Owning epic: **APW-10 (Ever Works Apps — isolated hosting tier)**. Implements
 * `docs/specs/features/app-works/APW-10-apps-hosting-tier/spec.md` and its
 * `plan.md` §2.1 (decisions), §2.6 (removal), §3.1–§3.2 (the
 * `hosting.ever.works/v1alpha1` contract), §3.7 (the probe catalogue with its
 * reason codes), §5.3 (metering and the credit pricebook), §5.4 (tier-state
 * evaluation) and §5.5 (`AppsTierPolicy`), plus `tasks.md` T1 (the launch-gate
 * ids, reason codes and numeric constants) and T50 (pricebook `VERSION_2`).
 *
 * This file is the platform side of the Kubernetes contract: the desired state
 * the `ever-works-apps` plugin WRITES and the status it READS. It never
 * declares a workload — the platform writes only `Work` objects and the zone's
 * controller reconciles them with APW-06's renderer (Resolution R-5, D-J).
 *
 * `AppsTierPolicy` itself is APW-06's port in
 * `packages/agent/src/app-runtime/ports.ts` (CONTRACTS §3:353); what this file
 * owns is what the policy MEANS — the tier states, the scope, the closed reason
 * codes, the eligibility reasons and the shapes `isOpen()` / `managedScope()` /
 * `eligibility()` / `podPolicy()` / `ingress()` answer with (plan §5.5:706–723).
 * No consumer outside `packages/agent/src/apps-tier/` may read
 * `EVER_WORKS_APPS_MANAGED_ENABLED`: it is only the ceiling inside the
 * evaluation below.
 */

import type { AppDependencyKind } from './app-dependencies.js';

import type { AppHttpAuthScheme } from './builds.js';

/* ------------------------------------------------------------------------- *
 * The launch gate (spec FR-1/FR-2, plan §3.7, tasks T1)
 * ------------------------------------------------------------------------- */

/** The 25 gate item ids, in the reviewed order of spec FR-2:181–207. */
export const LAUNCH_GATE_ITEM_IDS = [
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
] as const;

/** A launch-gate item id — tasks.md T1:52. */
export type LaunchGateItemId = (typeof LAUNCH_GATE_ITEM_IDS)[number];

/** How an item is satisfied (spec FR-1:176–178). */
export const LAUNCH_GATE_KINDS = ['automated', 'attested', 'both'] as const;

/** A gate item's kind — tasks.md T1:53. */
export type LaunchGateKind = (typeof LAUNCH_GATE_KINDS)[number];

/** Which wave requires an item (Resolution R-24; spec FR-2:209–211). */
export const LAUNCH_GATE_PHASES = ['P2', 'P3'] as const;

/** A gate item's phase — tasks.md T1:53. */
export type LaunchGatePhase = (typeof LAUNCH_GATE_PHASES)[number];

/** The exact outcome vocabulary (spec FR-5:222–223). Only `passed` counts. */
export const LAUNCH_GATE_OUTCOMES = ['passed', 'failed', 'inconclusive', 'error'] as const;

/** A gate item's outcome — spec FR-5. */
export type LaunchGateOutcome = (typeof LAUNCH_GATE_OUTCOMES)[number];

/** One frozen gate item — spec FR-2. The titles are verbatim from the table. */
export interface LaunchGateItem {
	readonly id: LaunchGateItemId;
	readonly title: string;
	readonly kind: LaunchGateKind;
	readonly phase: LaunchGatePhase;
}

/**
 * The frozen gate registry — spec FR-2:181–207 (plan §5.3:644 keeps this list
 * frozen and hashes it into `gateVersion()`).
 *
 * Adding, removing or relaxing an item is a reviewed change to the spec
 * (FR-1:176–178), so `LAUNCH_GATE_ITEM_IDS` and this registry are asserted
 * against each other in the contract test.
 */
export const LAUNCH_GATE_ITEMS: readonly LaunchGateItem[] = [
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

/** The items a phase requires — FR-3:213–215, as a lookup rather than a filter at each call site. */
export function launchGateItemsForPhase(phase: LaunchGatePhase): readonly LaunchGateItem[] {
	return LAUNCH_GATE_ITEMS.filter((item) => item.phase === phase);
}

/* ------------------------------------------------------------------------- *
 * Probe reason codes (plan §3.7:437–464)
 * ------------------------------------------------------------------------- */

/**
 * Every reason code a self-check item can report — plan §3.7's "Failure reason
 * codes" column, verbatim, plus `PHASE_NOT_ENABLED` (a P2-only item in a P1 run
 * reports **inconclusive**, never `passed` and never skipped, plan §3.7:466–473)
 * and `misconfigured` (a probe whose FR-7 minimum targets are absent reports
 * **Error**, plan §3.7:464).
 */
export const APPS_TIER_PROBE_REASON_CODES = [
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
] as const;

/** A probe reason code — plan §3.7. */
export type AppsTierProbeReasonCode = (typeof APPS_TIER_PROBE_REASON_CODES)[number];

/** One item's result inside a `SelfCheck` (plan §3.2:299–301). */
export interface AppsTierSelfCheckResult {
	id: LaunchGateItemId;
	outcome: LaunchGateOutcome;
	reasonCode: AppsTierProbeReasonCode | null;
	durationMs: number;
}

/* ------------------------------------------------------------------------- *
 * Tier state, scope and closed reasons (plan §5.4:677–704)
 * ------------------------------------------------------------------------- */

/** The three tier states (spec FR-13:247–248). It starts **Closed**. */
export const APPS_TIER_STATES = ['closed', 'open-verified-blueprints', 'open-any'] as const;

/** A tier state — spec FR-13. */
export type AppsTierState = (typeof APPS_TIER_STATES)[number];

/** The scope an open tier grants (plan §5.4:684). */
export const APPS_TIER_SCOPES = ['verified-blueprints', 'any'] as const;

/** A tier scope — plan §5.4:684. */
export type AppsTierScope = (typeof APPS_TIER_SCOPES)[number];

/**
 * Why the tier is closed — every `reasons.push(...)` of plan §5.4:682–696 plus
 * the operator close, as one closed union.
 *
 * `NOT_ATTESTED` and `ATTESTATION_EXPIRED` carry the item ids in the reason's
 * payload; the code itself is the same (plan §5.4:692).
 */
export const APPS_TIER_CLOSED_REASON_CODES = [
	/** The operator ceiling `EVER_WORKS_APPS_MANAGED_ENABLED` is off — plan §5.4:682. */
	'CEILING_OFF',
	/** An operator closed the tier — plan §5.4:683. */
	'CLOSED_BY_OPERATOR',
	/** `open-any` was asked for while `EVER_WORKS_APPS_MAX_SCOPE` forbids it — plan §5.4:685. */
	'SCOPE_NOT_ALLOWED',
	/** No finished gate run exists — plan §5.4:689. */
	'NO_RUN',
	/** The newest run is not green for the scope — plan §5.4:690. */
	'RUN_NOT_GREEN',
	/** The newest green run is older than the maximum age — plan §5.4:691. */
	'RUN_STALE',
	/** An attested item has no current attestation — plan §5.4:692. */
	'NOT_ATTESTED',
	/** An attestation expired — plan §5.4:692. */
	'ATTESTATION_EXPIRED',
	/** The controller heartbeat is missing or older than 120 s — plan §5.4:694. */
	'CONTROLLER_STALE',
	/** The controller version is below the platform's minimum — plan §5.4:695. */
	'CONTROLLER_TOO_OLD'
] as const;

/** A closed reason code — plan §5.4. */
export type AppsTierClosedReasonCode = (typeof APPS_TIER_CLOSED_REASON_CODES)[number];

/**
 * The only reasons an automatic close reopens from — FR-16: "It reopens
 * **automatically** only when the only reasons were a stale self-check or a
 * silent controller and both have recovered" (plan §5.4:696).
 */
export const APPS_TIER_AUTO_REOPENABLE_REASON_CODES = ['RUN_STALE', 'CONTROLLER_STALE'] as const;

/** An auto-reopenable reason code — spec FR-16. */
export type AppsTierAutoReopenableReasonCode = (typeof APPS_TIER_AUTO_REOPENABLE_REASON_CODES)[number];

/** An appended `apps_tier_state_events` row (plan §5.4:681, FR-18:259–260). */
export interface AppsTierStateEvent {
	readonly state: AppsTierState;
	/** True for the 5-minute watch's own close/reopen, false for an operator action. */
	readonly automatic: boolean;
	readonly reasonCodes: readonly AppsTierClosedReasonCode[];
}

/** The newest finished gate run the evaluation trusts (plan §5.4:686, 690). */
export interface AppsTierGateRun {
	readonly status: 'green' | 'red' | 'error';
	readonly finishedAtEpochMs: number;
	/** The highest scope this run covered; `any` covers `verified-blueprints` too. */
	readonly coversScope: AppsTierScope;
}

/** What an evaluation needs (plan §5.4:678–695). */
export interface AppsTierPolicyEvaluationInput {
	/** `EVER_WORKS_APPS_MANAGED_ENABLED === 'true'` — the ceiling, read ONLY inside the evaluation (R-5). */
	readonly ceilingEnabled: boolean;
	/** `EVER_WORKS_APPS_MAX_SCOPE`, default {@link APPS_TIER_POLICY_DEFAULT_SCOPE}. */
	readonly maxScope: AppsTierScope;
	/** The latest state event; `null` = none exists, which is closed (fail closed, plan §5.4:681). */
	readonly lastEvent: AppsTierStateEvent | null;
	/** The latest run whose status is green/red/error, or `null`. */
	readonly latestRun: AppsTierGateRun | null;
	/** `NOT_ATTESTED(ids)` / `ATTESTATION_EXPIRED(ids)` for the scope — plan §5.4:692. */
	readonly attestationReasons: readonly AppsTierClosedReasonCode[];
	/** The controller heartbeat (cached ≤ 30 s) — plan §5.4:693. */
	readonly controllerRenewedAtEpochMs: number | null;
	readonly controllerVersion: string;
	/** `EVER_WORKS_APPS_CONTROLLER_MIN_VERSION`. */
	readonly controllerMinVersion: string;
	/** `EVER_WORKS_APPS_GATE_MAX_AGE_HOURS`, default {@link GATE_MAX_AGE_HOURS}. */
	readonly gateMaxAgeHours: number;
	readonly now: number;
}

/** The evaluation's answer (plan §5.4:696). */
export interface AppsTierPolicyEvaluation {
	readonly open: boolean;
	/** The scope when open, and the scope the reasons were computed for when closed. */
	readonly scope: AppsTierScope;
	readonly reasons: readonly AppsTierClosedReasonCode[];
	readonly autoReopenable: boolean;
}

/** The scope an installation serves when `EVER_WORKS_APPS_MAX_SCOPE` is unset — plan §5.4:680. */
export const APPS_TIER_POLICY_DEFAULT_SCOPE: AppsTierScope = 'verified-blueprints';

/**
 * `semverLt` over dotted numeric versions (plan §5.4:695) — a missing part is 0.
 *
 * Semver precedence for the one case the tier actually compares: `1.10.0` is
 * NOT less than `1.9.0` (numeric, not lexical), and a prerelease is LOWER than
 * the release it precedes (`1.0.0-rc.1 < 1.0.0`), which is what stops a
 * release candidate from satisfying `EVER_WORKS_APPS_CONTROLLER_MIN_VERSION`.
 */
export function isSemverLessThan(left: string, right: string): boolean {
	const parse = (version: string): { parts: number[]; prerelease: string | null } => {
		const withoutPrefix = version.replace(/^v/, '');
		const [core, ...rest] = withoutPrefix.split('-');
		return {
			parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
			prerelease: rest.length > 0 ? rest.join('-') : null
		};
	};
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
		const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
		if (difference !== 0) return difference < 0;
	}
	if (a.prerelease === null && b.prerelease === null) return false;
	if (a.prerelease !== null && b.prerelease === null) return true;
	if (a.prerelease === null && b.prerelease !== null) return false;
	return (a.prerelease ?? '') < (b.prerelease ?? '');
}

/**
 * The tier-state evaluation of plan §5.4:677–697, transcribed clause by clause.
 *
 * Fail closed everywhere: a missing state event, a missing run, a stale run, a
 * stale heartbeat or an unreadable ceiling all close the tier rather than
 * leaving it open on absent evidence (D-H: "a stored boolean can disagree with
 * the evidence it claims to rest on").
 *
 * The one clause the plan does not give a code for is "no state event has ever
 * been written"; it is reported as `CLOSED_BY_OPERATOR`, the plan's fail-closed
 * default for a closed tier.
 */
export function evaluateAppsTierPolicyState(input: AppsTierPolicyEvaluationInput): AppsTierPolicyEvaluation {
	const closed = (scope: AppsTierScope, reasons: readonly AppsTierClosedReasonCode[]) => ({
		open: false,
		scope,
		reasons,
		autoReopenable: false
	});

	if (!input.ceilingEnabled) return closed(APPS_TIER_POLICY_DEFAULT_SCOPE, ['CEILING_OFF']);
	if (input.lastEvent === null) return closed(APPS_TIER_POLICY_DEFAULT_SCOPE, ['CLOSED_BY_OPERATOR']);
	if (input.lastEvent.state === 'closed') {
		return closed(
			APPS_TIER_POLICY_DEFAULT_SCOPE,
			input.lastEvent.automatic ? input.lastEvent.reasonCodes : ['CLOSED_BY_OPERATOR']
		);
	}
	const scope: AppsTierScope = input.lastEvent.state === 'open-any' ? 'any' : 'verified-blueprints';
	if (scope === 'any' && input.maxScope !== 'any') return closed(scope, ['SCOPE_NOT_ALLOWED']);

	// The plan caps the operator's configured age at 24 h: `min(env, 24)`.
	const maxAgeMs = Math.min(input.gateMaxAgeHours, GATE_MAX_AGE_HOURS) * 3_600_000;
	const reasons: AppsTierClosedReasonCode[] = [];
	const run = input.latestRun;
	if (run === null) {
		reasons.push('NO_RUN');
	} else if (run.status !== 'green' || (run.coversScope !== 'any' && run.coversScope !== scope)) {
		reasons.push('RUN_NOT_GREEN');
	} else if (input.now - run.finishedAtEpochMs > maxAgeMs) {
		reasons.push('RUN_STALE');
	}
	reasons.push(...input.attestationReasons);
	if (
		input.controllerRenewedAtEpochMs === null ||
		input.now - input.controllerRenewedAtEpochMs > HEARTBEAT_MAX_AGE_MS
	) {
		reasons.push('CONTROLLER_STALE');
	}
	if (isSemverLessThan(input.controllerVersion, input.controllerMinVersion)) reasons.push('CONTROLLER_TOO_OLD');

	if (reasons.length === 0) return { open: true, scope, reasons, autoReopenable: false };
	return {
		open: false,
		scope,
		reasons,
		autoReopenable: reasons.every((reason) =>
			(APPS_TIER_AUTO_REOPENABLE_REASON_CODES as readonly string[]).includes(reason)
		)
	};
}

/* ------------------------------------------------------------------------- *
 * Eligibility (spec FR-35, plan §5.5:717)
 * ------------------------------------------------------------------------- */

/**
 * The owner-eligibility reason codes, **in the order the policy reports them**
 * (plan §5.5:717).
 *
 * `capReached` is a presentation of APW-06's per-owner cap, not a second cap:
 * the limit is `EverWorksAppsQuotaService.getMaxPerUser()` reading
 * `EVER_WORKS_APPS_MAX_PER_USER` (default 3). `tierClosed` is the disabled
 * default's own answer (plan §5.5:722–723).
 */
export const APPS_TIER_ELIGIBILITY_REASONS = [
	'emailUnverified',
	'planRequired',
	'ownerQuarantined',
	'capReached',
	'tierClosed'
] as const;

/** An eligibility reason — spec FR-35 / plan §5.5:717. */
export type AppsTierEligibilityReason = (typeof APPS_TIER_ELIGIBILITY_REASONS)[number];

/** What APW-06's disabled `AppsTierPolicy` default answers — plan §5.5:722–723. */
export const APPS_TIER_ELIGIBILITY_DISABLED_REASONS: readonly AppsTierEligibilityReason[] = ['tierClosed'];

/** The quarantine categories a per-App-Work stop can carry (spec FR-41:356, FR-44:366, plan §3.1:239). */
export const APPS_TIER_QUARANTINE_CATEGORIES = ['abuse', 'security', 'billing', 'legal', 'pause-all', 'drill'] as const;

/** A quarantine category — spec FR-41 + FR-44 + plan §3.1:239. */
export type AppsTierQuarantineCategory = (typeof APPS_TIER_QUARANTINE_CATEGORIES)[number];

/** Who asked for a quarantine (spec FR-39:344–346, LG-21:458, plan §3.1:266). */
export const APPS_TIER_QUARANTINE_SOURCES = ['operator', 'detector', 'self-check'] as const;

/** A quarantine source — spec FR-39 + plan §3.1:266 + LG-21. */
export type AppsTierQuarantineSource = (typeof APPS_TIER_QUARANTINE_SOURCES)[number];

/** The categories a **Billing** stop uses after the 7-day grace period — spec FR-60:425–429. */
export const APPS_TIER_BILLING_QUARANTINE_CATEGORY: AppsTierQuarantineCategory = 'billing';

/** The category **Pause all** records — spec FR-44:366. */
export const APPS_TIER_PAUSE_ALL_CATEGORY: AppsTierQuarantineCategory = 'security';

/** The typed confirmation **Pause all** requires — spec FR-44:366. */
export const APPS_TIER_PAUSE_ALL_CONFIRMATION = 'PAUSE ALL' as const;

/** Abuse-signal kinds (spec FR-37:338, plan §3.2:305). */
export const APPS_TIER_SIGNAL_KINDS = ['runtime', 'mining', 'mail', 'bandwidth', 'report'] as const;

/** An abuse-signal kind — spec FR-37. */
export type AppsTierSignalKind = (typeof APPS_TIER_SIGNAL_KINDS)[number];

/** Abuse-signal severities (spec FR-37:338). */
export const APPS_TIER_SIGNAL_SEVERITIES = ['low', 'medium', 'high'] as const;

/** An abuse-signal severity — spec FR-37. */
export type AppsTierSignalSeverity = (typeof APPS_TIER_SIGNAL_SEVERITIES)[number];

/* ------------------------------------------------------------------------- *
 * The Work resource (plan §3.1:223–294)
 * ------------------------------------------------------------------------- */

/** The API group and version every tier object lives in — CONTRACTS §3:367. */
export const APPS_TIER_API_GROUP = 'hosting.ever.works' as const;

/** The API version — CONTRACTS §3:367. */
export const APPS_TIER_API_VERSION = 'v1alpha1' as const;

/** The default control namespace (plan §3:220–221). */
export const APPS_TIER_CONTROL_NAMESPACE_DEFAULT = 'ever-works-apps-control' as const;

/** `Work.metadata.name` — `w-<workId>` (plan §3.1:228). */
export const APPS_TIER_WORK_NAME_PREFIX = 'w-' as const;

/** Tenant namespaces are `ewa-<first 20 hex of workId>` (plan §3.1:259). */
export const APPS_TIER_TENANT_NAMESPACE_PREFIX = 'ewa-' as const;

/** The `Work` label carrying the owner (plan §3.1:229). */
export const APPS_TIER_WORK_OWNER_LABEL = 'hosting.ever.works/owner' as const;

/** The `Work` label marking a self-check canary — excluded from metering, receipts, lists and caps (FR-10). */
export const APPS_TIER_WORK_CANARY_LABEL = 'hosting.ever.works/canary' as const;

/** The pod-template label the quarantine sequencer adds (plan §2.5:184). */
export const APPS_TIER_QUARANTINED_LABEL = 'hosting.ever.works/quarantined' as const;

/** The namespace label marking a tenant namespace (plan §3.4:353). */
export const APPS_TIER_TENANT_LABEL = 'hosting.ever.works/tenant' as const;

/** The namespace label carrying the Work id (plan §3.4:353). */
export const APPS_TIER_WORK_ID_LABEL = 'hosting.ever.works/work-id' as const;

/** The namespace annotation listing the hosts the edge may route (plan §3.4:353). */
export const APPS_TIER_ALLOWED_HOSTS_ANNOTATION = 'hosting.ever.works/allowed-hosts' as const;

/** The namespace label a removal stamps with the retention deadline (plan §2.6:206). */
export const APPS_TIER_RETAINED_UNTIL_LABEL = 'hosting.ever.works/retained-until' as const;

/** The `Work` annotation the platform's `runAppJob` uses (plan §5.1:621). */
export const APPS_TIER_RUN_JOB_ANNOTATION = 'hosting.ever.works/run-job' as const;

/**
 * `Work.spec.desiredState` (plan §3.1:236).
 *
 * `paused` is the owner's **Pause** (APW06-G04); `removed` is a removal under
 * R-15 and keeps data unless `dataDeletion` is also set. These are the ONLY
 * states a tier workload is stopped through — the platform stop flag, an Agent
 * **Pause** and a workspace **Pause everything** never touch them, and a
 * quarantine never pauses an Agent (Resolution R-20).
 */
export const APPS_TIER_WORK_DESIRED_STATES = ['running', 'paused', 'quarantined', 'removed'] as const;

/** `Work.spec.desiredState` — plan §3.1:236. */
export type AppsTierWorkDesiredState = (typeof APPS_TIER_WORK_DESIRED_STATES)[number];

/** `Work.status.phase` (spec FR-27:298–299, plan §3.1:255) — in the spec's order. */
export const APPS_TIER_WORK_PHASES = [
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
] as const;

/** `Work.status.phase` — spec FR-27. */
export type AppsTierWorkPhase = (typeof APPS_TIER_WORK_PHASES)[number];

/** `Work.status.deployPhase` — the deployment sequencer's position (plan §3.1:264). */
export const APPS_TIER_DEPLOY_PHASES = [
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
] as const;

/** `Work.status.deployPhase` — plan §3.1:264. */
export type AppsTierDeployPhase = (typeof APPS_TIER_DEPLOY_PHASES)[number];

/** `Work.spec.components[].role` (plan §3.1:245). */
export const APPS_TIER_COMPONENT_ROLES = ['web', 'worker'] as const;

/** A component's role — plan §3.1:245. */
export type AppsTierComponentRole = (typeof APPS_TIER_COMPONENT_ROLES)[number];

/** `Work.status.components[]` readiness — plan §3.1:261. */
export interface AppsTierComponentStatus {
	name: string;
	readyReplicas: number;
	replicas: number;
	imageDigest: string;
}

/** A component's declared volume (plan §3.1:245–247). */
export interface AppsTierComponentVolume {
	name: string;
	path: string;
	size: string;
}

/** A probe on a component (plan §3.1:245–247; the shape is APW-03's, validated there). */
export interface AppsTierProbe {
	kind: 'http' | 'tcp';
	path?: string;
	port?: number;
	failureThreshold?: number;
	periodSeconds?: number;
}

/** A component of the desired state (plan §3.1:245–247). */
export interface AppsTierComponent {
	name: string;
	role: AppsTierComponentRole;
	command: string[];
	args: string[];
	port: number;
	/** ≤ {@link APPS_TIER_MAX_COMPONENT_REPLICAS} — plan §3.1:245. */
	replicas: number;
	resources: { cpu: string; memory: string; memoryLimit: string };
	probes: { startup?: AppsTierProbe; readiness?: AppsTierProbe; liveness?: AppsTierProbe };
	/** ≤ {@link APPS_TIER_MAX_COMPONENT_VOLUMES} — plan §3.1:247. */
	volumes: AppsTierComponentVolume[];
	writableRootFilesystem: boolean;
}

/** `Work.spec.jobs[].when` (plan §3.1:248). */
export const APPS_TIER_JOB_PHASES = ['pre-deploy', 'first-deploy', 'post-deploy'] as const;

/** A manifest job's phase — plan §3.1:248. */
export type AppsTierJobPhase = (typeof APPS_TIER_JOB_PHASES)[number];

/** A manifest job (plan §3.1:248). Exactly one of `command` / `http`. */
export interface AppsTierJob {
	name: string;
	when: AppsTierJobPhase;
	component: string;
	command?: string[];
	http?: { method: string; path: string; body?: string; authEnv?: string; authScheme: AppHttpAuthScheme };
	/** ≤ {@link APPS_TIER_MAX_JOB_TIMEOUT_SECONDS} — plan §3.1:248. */
	timeoutSeconds: number;
}

/** `Work.status.jobs[].status` (plan §3.1:262, GAP-25). */
export const APPS_TIER_JOB_STATUSES = ['succeeded', 'failed', 'timeout', 'running'] as const;

/** A reported job status — plan §3.1:262. */
export type AppsTierJobStatus = (typeof APPS_TIER_JOB_STATUSES)[number];

/** A job's reported outcome (plan §3.1:262, GAP-25). */
export interface AppsTierJobStatusView {
	name: string;
	when: AppsTierJobPhase;
	runName: string;
	status: AppsTierJobStatus;
	startedAt: string | null;
	completedAt: string | null;
	exitCode: number | null;
}

/** A schedule (plan §3.1:249). `schedule` must be at least 5 minutes apart. */
export interface AppsTierCron {
	name: string;
	schedule: string;
	http: { method: string; path: string; authEnv: string; authScheme: AppHttpAuthScheme };
}

/** A declared smoke check (plan §3.1:250). */
export interface AppsTierSmoke {
	name: string;
	component: string;
	path: string;
	method: string;
	expect: { status: number[]; bodyContains: string[]; bodyNotContains: string[] };
	latencyMs: number;
	firstDeployOnly: boolean;
}

/** `Work.status.smoke[].scope` (plan §3.1:263, GAP-25). */
export const APPS_TIER_SMOKE_SCOPES = ['in-cluster', 'public'] as const;

/** A smoke check's scope — plan §3.1:263. */
export type AppsTierSmokeScope = (typeof APPS_TIER_SMOKE_SCOPES)[number];

/** `Work.status.smoke[].status` (plan §3.1:263). */
export const APPS_TIER_SMOKE_STATUSES = ['passed', 'failed', 'skipped'] as const;

/** A smoke check's status — plan §3.1:263. */
export type AppsTierSmokeStatus = (typeof APPS_TIER_SMOKE_STATUSES)[number];

/** A smoke check's reported outcome (plan §3.1:263, GAP-25). */
export interface AppsTierSmokeStatusView {
	name: string;
	scope: AppsTierSmokeScope;
	status: AppsTierSmokeStatus;
	httpStatus: number | null;
	latencyMs: number | null;
	failedExpectation: string | null;
	/** ≤ 200 characters — plan §3.1:263. */
	found: string | null;
}

/** A published host (plan §3.1:251). ≤ {@link APPS_TIER_MAX_HOSTS}. */
export interface AppsTierHost {
	host: string;
	kind: 'managed' | 'custom';
	customHostnameRef?: string;
}

/** A digest-pinned image with an optional single-use pull credential (plan §3.1:241–244). */
export interface AppsTierImage {
	component: string;
	source: string;
	/** Sealed to the controller's key; base64 ≤ {@link APPS_TIER_MAX_PULL_CREDENTIAL_BYTES} and ≤ 15 min. */
	pullCredential?: { sealed: string; expiresAt: string };
}

/** A dependency reference resolved inside the zone (plan §3.1:253, CONTRACTS §3:370). */
export interface AppsTierDependencyRef {
	kind: AppDependencyKind;
	/** `dep-<kind>` — plan §4.11:692 of APW-07. */
	ref: string;
}

/** `Work.status.dependencies[].phase` (CONTRACTS §3:371, spec FR-54:403–406). */
export const APPS_TIER_DEPENDENCY_PHASES = ['pending', 'ready', 'failed', 'released'] as const;

/** A managed dependency's reported phase — CONTRACTS §3:371. */
export type AppsTierDependencyPhase = (typeof APPS_TIER_DEPENDENCY_PHASES)[number];

/** One managed dependency's status (plan §3.1:258, CONTRACTS §3:371). */
export interface AppsTierDependencyStatusView {
	kind: AppDependencyKind;
	ref: string;
	phase: AppsTierDependencyPhase;
	lastBackupAt: string | null;
	detail?: Record<string, string | number>;
}

/** The sealed environment (plan §3.1:252). ≤ 256 KiB sealed, ≤ 200 names. */
export interface AppsTierSealedEnv {
	sealed: string;
	names: string[];
}

/** A refusal, with the field it concerns (spec FR-27:298–300). */
export interface AppsTierWorkRefusal {
	code: AppsTierWorkRefusalCode;
	field: string;
}

/** The promotion record of one component (plan §3.1:267). */
export interface AppsTierPromotion {
	component: string;
	digest: string;
	scan: { critical: number; criticalFixable: number; high: number };
	signed: boolean;
	allowanceRef: string | null;
}

/** The quarantine record (plan §3.1:265–266). */
export interface AppsTierQuarantineStatus {
	requestId: string;
	source: AppsTierQuarantineSource;
	networkIsolatedAt: string | null;
	scaledToZeroAt: string | null;
	ingressDisabledAt: string | null;
	replicasBefore: Record<string, number>;
	releasedAt: string | null;
	policiesSuspended: string[];
}

/** The removal record (plan §2.6:203–211, §3.1:257; R-15). */
export interface AppsTierRemovalStatus {
	removedAt: string | null;
	retainedUntil: string | null;
	dataDeletedAt: string | null;
}

/** `Work.spec` — the whole desired state (plan §3.1:230–253). */
export interface AppsTierWorkSpec {
	workId: string;
	ownerUserId: string;
	organizationId: string | null;
	/** The platform deploy generation; monotonically increasing (plan §3.1:234). */
	generation: number;
	quotaProfile: string;
	desiredState: AppsTierWorkDesiredState;
	/** Recorded by the platform, restored by the controller on resume — plan §3.1:237. */
	pausedReplicas: Record<string, number> | null;
	/** Set only after the owner confirmed **Also delete stored data** (R-15) — plan §3.1:238. */
	dataDeletion: { requestedAt: string; requestedByUserId: string } | null;
	quarantine: { requestId: string; category: AppsTierQuarantineCategory; requestedAt: string } | null;
	/** The 100 % egress state; the owner is told at 80 % first (spec FR-36:335–337). */
	egressThrottle: boolean;
	images: AppsTierImage[];
	components: AppsTierComponent[];
	jobs: AppsTierJob[];
	cron: AppsTierCron[];
	smoke: AppsTierSmoke[];
	hosts: AppsTierHost[];
	env: AppsTierSealedEnv;
	dependencies: AppsTierDependencyRef[];
}

/** `Work.status` — everything the platform reads back (plan §3.1:254–269). */
export interface AppsTierWorkStatus {
	phase: AppsTierWorkPhase;
	observedGeneration: number;
	removal: AppsTierRemovalStatus;
	dependencies: AppsTierDependencyStatusView[];
	namespace: string;
	refusal: AppsTierWorkRefusal | null;
	components: AppsTierComponentStatus[];
	jobs: AppsTierJobStatusView[];
	smoke: AppsTierSmokeStatusView[];
	deployPhase: AppsTierDeployPhase | null;
	quarantine: AppsTierQuarantineStatus | null;
	promotion: AppsTierPromotion[];
	policyRevision: string;
	controllerVersion: string;
	conditions: { type: string; status: string; reason: string; message: string }[];
}

/** A `Work` object as the platform writes and reads it (plan §3.1:225–270). */
export interface AppsTierWorkResource {
	apiVersion: typeof APPS_TIER_API_GROUP;
	kind: 'Work';
	metadata: {
		name: string;
		namespace: string;
		labels: Record<string, string>;
	};
	spec: AppsTierWorkSpec;
	status?: AppsTierWorkStatus;
}

/**
 * `Work.status.refusal.code` and the degraded reasons — plan §3.1:273–281.
 *
 * Every code maps to an APW-06 outcome the owner already understands
 * (plan §3.1:283–294), so an owner never sees a bare code.
 */
export const APPS_TIER_WORK_REFUSAL_CODES = [
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
	/** An `ew-dep://` token the zone cannot resolve — CONTRACTS §3:371. */
	'DEPENDENCY_TOKEN_UNKNOWN',
	/** The zone cannot prove the isolation the Work requires — plan §3.1:277–280. */
	'ISOLATION_NOT_ENFORCED'
] as const;

/** A Work refusal code — plan §3.1:273–281. */
export type AppsTierWorkRefusalCode = (typeof APPS_TIER_WORK_REFUSAL_CODES)[number];

/** Degraded reasons — plan §3.1:281. */
export const APPS_TIER_WORK_DEGRADED_REASONS = ['IMAGE_RUNS_AS_ROOT', 'QUOTA_EXCEEDED'] as const;

/** A degraded reason — plan §3.1:281. */
export type AppsTierWorkDegradedReason = (typeof APPS_TIER_WORK_DEGRADED_REASONS)[number];

/* ------------------------------------------------------------------------- *
 * Desired-state limits (spec FR-26:294–297, plan §3.1)
 * ------------------------------------------------------------------------- */

/** Components per Work — spec FR-26. */
export const APPS_TIER_MAX_COMPONENTS = 8 as const;

/** Jobs per Work — spec FR-26. */
export const APPS_TIER_MAX_JOBS = 10 as const;

/** Schedules per Work — spec FR-26. */
export const APPS_TIER_MAX_CRON = 10 as const;

/** Smoke checks per Work — spec FR-26. */
export const APPS_TIER_MAX_SMOKE = 20 as const;

/** Hosts per Work — spec FR-26. */
export const APPS_TIER_MAX_HOSTS = 20 as const;

/** Environment variables per Work — spec FR-26. */
export const APPS_TIER_MAX_ENV_NAMES = 200 as const;

/** Volumes per component — spec FR-26. */
export const APPS_TIER_MAX_COMPONENT_VOLUMES = 4 as const;

/** Replicas per component — plan §3.1:245. */
export const APPS_TIER_MAX_COMPONENT_REPLICAS = 10 as const;

/** Images per Work — plan §3.1:241. */
export const APPS_TIER_MAX_IMAGES = 8 as const;

/** A job's timeout ceiling in seconds — plan §3.1:248. */
export const APPS_TIER_MAX_JOB_TIMEOUT_SECONDS = 3_600 as const;

/** The sealed environment's ceiling — spec FR-26 (256 KiB). */
export const APPS_TIER_MAX_SEALED_ENV_BYTES = 262_144 as const;

/** The whole `Work` object's ceiling — plan §3.1:272 (512 KiB). */
export const APPS_TIER_MAX_WORK_BYTES = 524_288 as const;

/** The shortest interval a schedule may have — plan §3.1:249 (`≥ 5 min`). */
export const APPS_TIER_MIN_CRON_INTERVAL_MS = 300_000 as const;

/** The pull-credential seal's byte ceiling — plan §3.1:244 (8 KiB). */
export const APPS_TIER_MAX_PULL_CREDENTIAL_BYTES = 8_192 as const;

/** A pull credential's maximum lifetime (spec FR-32:319–320). */
export const PULL_CREDENTIAL_MAX_MS = 900_000 as const;

/* ------------------------------------------------------------------------- *
 * Quota profiles (spec FR-47:377–380, FR-48:381–383)
 * ------------------------------------------------------------------------- */

/**
 * One quota profile.
 *
 * Spec FR-47: **Starter** — CPU requests 1 / limits 2, memory requests 2 GiB /
 * limits 4 GiB, 10 pods, 4 volumes totalling 10 GiB, bandwidth 20 Mbit/s out and
 * 50 Mbit/s in, 100 GiB monthly egress; **Standard** — 2 / 4 CPU, 4 / 8 GiB,
 * 20 pods, 8 volumes totalling 50 GiB, 50 / 100 Mbit/s, 500 GiB monthly egress.
 * **Both allow 0 load balancers and 0 node ports** — the two fields are typed as
 * the literal `0` so a profile can never be edited into allowing one (FR-22).
 */
export interface AppsTierQuotaProfile {
	readonly name: string;
	readonly cpuRequest: number;
	readonly cpuLimit: number;
	readonly memoryRequestGiB: number;
	readonly memoryLimitGiB: number;
	readonly pods: number;
	readonly volumes: number;
	readonly volumeTotalGiB: number;
	readonly bandwidthOutMbps: number;
	readonly bandwidthInMbps: number;
	readonly monthlyEgressGiB: number;
	readonly loadBalancers: 0;
	readonly nodePorts: 0;
}

/** The two profiles that ship — `starter` and `standard` (spec FR-47, plan §3.1:235). */
export const APPS_TIER_QUOTA_PROFILES = {
	starter: {
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
	},
	standard: {
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
	}
} as const satisfies Record<string, AppsTierQuotaProfile>;

/** A shipped quota profile's name — spec FR-47. */
export type AppsTierQuotaProfileName = keyof typeof APPS_TIER_QUOTA_PROFILES;

/**
 * The hard ceilings an operator's edited profile must stay inside
 * (spec FR-48:381–383): 16 CPU, 32 GiB memory, 100 pods and 500 GiB storage.
 */
export const APPS_TIER_QUOTA_CEILINGS = {
	cpu: 16,
	memoryGiB: 32,
	pods: 100,
	storageGiB: 500
} as const;

/** The profile names that ship, in declaration order. */
export const APPS_TIER_QUOTA_PROFILE_NAMES = ['starter', 'standard'] as const;

/** Look up a shipped profile by name; `null` for an unknown name (which the zone refuses `QUOTA_PROFILE_UNKNOWN`). */
export function resolveAppsTierQuotaProfile(name: string): AppsTierQuotaProfile | null {
	const profiles: Record<string, AppsTierQuotaProfile> = APPS_TIER_QUOTA_PROFILES;
	return profiles[name] ?? null;
}

/**
 * Clamp an operator-edited profile to the FR-48 ceilings.
 *
 * Returns the clamped profile and the list of fields that were reduced, so the
 * operator surface can say what it did instead of silently changing a number.
 * A profile is never clamped UP, and a non-positive value is refused by the
 * caller before it reaches here — this function only enforces the ceiling.
 */
export function clampAppsTierQuotaProfile(profile: AppsTierQuotaProfile): {
	readonly profile: AppsTierQuotaProfile;
	readonly clamped: readonly string[];
} {
	const clamped: string[] = [];
	const reduce = (current: number, ceiling: number, field: string): number => {
		if (current <= ceiling) return current;
		clamped.push(field);
		return ceiling;
	};
	return {
		profile: {
			...profile,
			cpuRequest: reduce(profile.cpuRequest, APPS_TIER_QUOTA_CEILINGS.cpu, 'cpuRequest'),
			cpuLimit: reduce(profile.cpuLimit, APPS_TIER_QUOTA_CEILINGS.cpu, 'cpuLimit'),
			memoryRequestGiB: reduce(profile.memoryRequestGiB, APPS_TIER_QUOTA_CEILINGS.memoryGiB, 'memoryRequestGiB'),
			memoryLimitGiB: reduce(profile.memoryLimitGiB, APPS_TIER_QUOTA_CEILINGS.memoryGiB, 'memoryLimitGiB'),
			pods: reduce(profile.pods, APPS_TIER_QUOTA_CEILINGS.pods, 'pods'),
			volumeTotalGiB: reduce(profile.volumeTotalGiB, APPS_TIER_QUOTA_CEILINGS.storageGiB, 'volumeTotalGiB')
		},
		clamped
	};
}

/* ------------------------------------------------------------------------- *
 * Caps and windows (tasks T1:57–63; every number is a spec FR)
 * ------------------------------------------------------------------------- */

/** The gate is green only for a run that finished less than this long ago — FR-3:213–215. */
export const GATE_MAX_AGE_HOURS = 24 as const;

/** A whole self-check run's budget; items not finished by then are **Error** — FR-6:224–225. */
export const SELF_CHECK_BUDGET_MS = 900_000 as const;

/** A network probe's connect timeout — FR-6:224. */
export const PROBE_CONNECT_TIMEOUT_MS = 3_000 as const;

/** A network probe's attempt count — FR-6:224. */
export const PROBE_ATTEMPTS = 2 as const;

/** A self-check runs automatically this often — FR-8:230–231. */
export const SELF_CHECK_INTERVAL_HOURS = 6 as const;

/** An attestation's expiry, exactly this many days after it is recorded — FR-11:239–241. */
export const ATTESTATION_TTL_DAYS = 90 as const;

/** The days before expiry an operator is notified — FR-12:242–243. */
export const ATTESTATION_NOTICE_DAYS = [14, 1] as const;

/** A heartbeat older than this closes the gate — FR-3:215, FR-29:309. */
export const HEARTBEAT_MAX_AGE_MS = 120_000 as const;

/** How often the watch job re-evaluates the gate — FR-16:253–254. */
export const GATE_WATCH_INTERVAL_MIN = 5 as const;

/** Quarantine timings the drill asserts — FR-41:356–361, spec LG-18:200. */
export const QUARANTINE_ISOLATE_MS = 15_000 as const;

/** Reaching zero replicas — spec LG-18:200. */
export const QUARANTINE_SCALE_MS = 60_000 as const;

/** The unavailable page being live — spec LG-18:200. */
export const QUARANTINE_EDGE_MS = 120_000 as const;

/** Release restoring everything — spec LG-18:200. */
export const RELEASE_RESTORE_MS = 180_000 as const;

/** A **High** signal quarantines the App Work within this long — FR-39:344–346. */
export const DETECTOR_QUARANTINE_MS = 60_000 as const;

/** An operator's image allowance lasts at most this long — FR-31:316–318. */
export const IMAGE_ALLOWANCE_MAX_DAYS = 30 as const;

/** Removed App Works keep their data this long without an explicit operator action — FR-28:301–306, FR-62. */
export const REMOVED_DATA_RETENTION_DAYS = 30 as const;

/** A self-check run is kept for this long, or the latest 500, whichever is more — FR-9:233–234. */
export const APPS_TIER_SELF_CHECK_RUN_RETENTION_DAYS = 180 as const;

/** The alternative run-retention bound — FR-9:233–234. */
export const APPS_TIER_SELF_CHECK_RUN_RETENTION_COUNT = 500 as const;

/** Zone control-plane audit retention an operator attests to — spec LG-21:203. */
export const APPS_TIER_ZONE_AUDIT_RETENTION_DAYS = 90 as const;

/** A usage report and its import must be no older than this — spec LG-20:202, FR-49. */
export const APPS_TIER_USAGE_FRESHNESS_MS = 7_200_000 as const;

/** The owner is told at this share of their profile's monthly egress — FR-36:335–337. */
export const APPS_TIER_EGRESS_NOTICE_SHARE = 0.8 as const;

/** Over 100 % of the monthly egress, the App Work is throttled to this — FR-36:335–337. */
export const APPS_TIER_EGRESS_THROTTLE_MBPS = 2 as const;

/** Credits at 0 % start this grace period before a **Billing** quarantine — FR-60:425–429. */
export const APPS_TIER_BILLING_GRACE_DAYS = 7 as const;

/** The mining rule's CPU share — FR-38:341–343. */
export const APPS_TIER_MINING_CPU_SHARE = 0.9 as const;

/** The mining rule's sustained window — FR-38:341–343. */
export const APPS_TIER_MINING_CPU_WINDOW_MS = 1_800_000 as const;

/** The mining rule's refused-connection count in that window — FR-38:341–343. */
export const APPS_TIER_MINING_REFUSED_CONNECTIONS = 10 as const;

/** The CPU-only **Medium** window — FR-38:341–343. */
export const APPS_TIER_MINING_MEDIUM_WINDOW_MS = 21_600_000 as const;

/** The mail rule's refused-attempt count per hour — FR-38:343. */
export const APPS_TIER_MAIL_REFUSED_ATTEMPTS_PER_HOUR = 50 as const;

/** A signal's summary ceiling in characters — FR-37:338–340. */
export const APPS_TIER_SIGNAL_SUMMARY_MAX_CHARS = 500 as const;

/** A quarantine or release reason's minimum length — FR-41:356, FR-43:364. */
export const APPS_TIER_QUARANTINE_REASON_MIN_CHARS = 10 as const;

/** An attestation's evidence note lower bound — FR-11:239–241. */
export const APPS_TIER_ATTESTATION_EVIDENCE_MIN_CHARS = 20 as const;

/** An attestation's evidence note upper bound — FR-11:239–241. */
export const APPS_TIER_ATTESTATION_EVIDENCE_MAX_CHARS = 2_000 as const;

/** An attestation's private evidence reference ceiling — FR-11:239–241. */
export const APPS_TIER_ATTESTATION_EVIDENCE_REFERENCE_MAX_CHARS = 500 as const;

/** A gate-run observation's stuck threshold used by the operator board — CONTRACTS §11:736 (6 h). */
export const APPS_TIER_HEARTBEAT_STALE_MS = 21_600_000 as const;

/* ------------------------------------------------------------------------- *
 * The credit pricebook (plan §5.3:659–673, tasks T50:779–793)
 * ------------------------------------------------------------------------- */

/**
 * Hosting prices arrive as `VERSION_2` with an `effectiveFrom` date;
 * `VERSION_1` stays frozen (plan §5.3:661–662). This constant names the version
 * so no epic writes a second literal.
 */
export const APPS_TIER_PRICEBOOK_VERSION = 2 as const;

/** The price group `hosting` joins `CREDIT_PRICE_GROUPS` with — plan §5.3:662–663. */
export const APPS_TIER_PRICE_GROUP = 'hosting' as const;

/**
 * The price keys, each naming its **whole billing unit** (plan §5.3:664–668).
 *
 * `hosting.egress_gib` is billed from the metered MiB — deliberately NOT the
 * metered `egress_mib` unit — and the two dependency keys exist so managed
 * dependency storage is priced like every other unit (XC-20).
 */
export const APPS_TIER_PRICE_KEYS = {
	cpuCoreHour: 'hosting.cpu_core_hour',
	memoryGiBHour: 'hosting.memory_gib_hour',
	egressGiB: 'hosting.egress_gib',
	storageGiBMonth: 'hosting.storage_gib_month',
	buildMinute: 'hosting.build_minute',
	dependencyStorageGiBHour: 'hosting.dependency_storage_gib_hour',
	dependencyBackupGiBHour: 'hosting.dependency_backup_gib_hour',
	relayMessages: 'relay.messages'
} as const;

/** A hosting price key — plan §5.3:665–668. */
export type AppsTierPriceKey = (typeof APPS_TIER_PRICE_KEYS)[keyof typeof APPS_TIER_PRICE_KEYS];

/**
 * The whole-unit conversions (plan §5.3:664–667, T50:783–784). The remainder is
 * carried on `AppsTierUsageWindow` rather than dropped.
 */
export const APPS_TIER_PRICE_UNITS = {
	cpuCoreSecondsPerUnit: 3_600,
	memoryMiBHoursPerUnit: 1_024,
	egressMiBPerUnit: 1_024,
	storageGiBHoursPerUnit: 720
} as const;

/** The usage units a `UsageReport` carries — plan §3.2:302–303, FR-49:387–388. */
export const APPS_TIER_USAGE_UNITS = [
	'cpuCoreSeconds',
	'memoryMiBHours',
	'egressMiB',
	'storageGiBHours',
	'buildMinutes',
	'dependencyStorageGiBHours',
	'dependencyBackupGiBHours'
] as const;

/** A metered usage unit — FR-49 + XC-20. */
export type AppsTierUsageUnit = (typeof APPS_TIER_USAGE_UNITS)[number];

/**
 * The daily receipt's credit-ledger idempotency key — plan §5.3:670–671,
 * T50:786–787. One debit per App Work per day, so a re-run of the receipt job
 * changes nothing.
 */
export function appsTierReceiptIdempotencyKey(workId: string, day: string): string {
	return `apps-tier:${workId}:${day}`;
}

/** The cron of the hourly metering import — plan §5.3 (tasks T28:478, `7 * * * *`). */
export const APPS_TIER_METERING_IMPORT_CRON = '7 * * * *' as const;

/** The cron of the daily receipts job — tasks T28:479, `15 0 * * *`. */
export const APPS_TIER_DAILY_RECEIPTS_CRON = '15 0 * * *' as const;

/* ------------------------------------------------------------------------- *
 * `AppsTierPolicy`'s answers (plan §5.5:706–723)
 * ------------------------------------------------------------------------- */

/** `podPolicy()`'s shape — informational for APW-06 renderer fixtures; the zone enforces. */
export interface AppsTierPodPolicy {
	readonly runtimeClassName: string;
	readonly quotaProfile: string;
}

/** `ingress()`'s shape — plan §5.5:720. */
export interface AppsTierIngressPolicy {
	readonly className: string;
	readonly controllerNamespace: string;
	readonly edgeTlsMode: 'edge';
}

/** The one TLS mode the tier's edge serves — plan §5.5:720. */
export const APPS_TIER_EDGE_TLS_MODE = 'edge' as const;

/** The env var that is ONLY the ceiling inside the evaluation (R-5) — never read by a consumer. */
export const APPS_TIER_MANAGED_ENABLED_ENV_VAR = 'EVER_WORKS_APPS_MANAGED_ENABLED' as const;

/** The env var holding the scope an installation is allowed to open to — plan §5.4:680. */
export const APPS_TIER_MAX_SCOPE_ENV_VAR = 'EVER_WORKS_APPS_MAX_SCOPE' as const;

/** The env var holding the gate run's maximum age in hours — plan §5.4:687. */
export const APPS_TIER_GATE_MAX_AGE_HOURS_ENV_VAR = 'EVER_WORKS_APPS_GATE_MAX_AGE_HOURS' as const;

/** The env var holding the controller version floor — plan §5.4:695. */
export const APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR = 'EVER_WORKS_APPS_CONTROLLER_MIN_VERSION' as const;

/** The env var holding the control-namespace kubeconfig — plan §5.5:718. */
export const APPS_TIER_CONTROL_KUBECONFIG_ENV_VAR = 'EVER_WORKS_APPS_CONTROL_KUBECONFIG' as const;

/** The existing per-owner cap the `capReached` reason reports — plan §5.5:717 (default 3). */
export const APPS_TIER_MAX_PER_USER_ENV_VAR = 'EVER_WORKS_APPS_MAX_PER_USER' as const;

/** The `ConfigMap` carrying the controller's sealing public key — plan §2.3:151, §3.3:332. */
export const APPS_TIER_PUBLIC_KEY_CONFIG_MAP = 'ever-works-apps-controller-public-key' as const;

/** The `ConfigMap` carrying zone info — plan §3.3:332. */
export const APPS_TIER_ZONE_INFO_CONFIG_MAP = 'ever-works-apps-zone-info' as const;

/** The additional authenticated data a sealed payload is bound to — plan §3.3 (per-Work binding). */
export const APPS_TIER_SEAL_AAD_PREFIX = 'hosting.ever.works/v1alpha1' as const;

/** The `Activity` `actionType` every `app.tier.*` row carries (Resolution R-2). */
export const APPS_TIER_ACTIVITY_ACTION_TYPE = 'app_tier' as const;

/** The `app.tier.*` event names APW-10 adds (CONTRACTS §6:528). */
export const APPS_TIER_EVENT_NAMES = [
	'app.tier.quarantined',
	'app.tier.released',
	'app.tier.deploy_refused',
	'app.tier.egress_threshold',
	'app.tier.usage_daily'
] as const;

/** An `app.tier.*` event name — CONTRACTS §6:528. */
export type AppsTierEventName = (typeof APPS_TIER_EVENT_NAMES)[number];

/** The notification ids APW-10 owns — CONTRACTS §6A:642–645. */
export const APPS_TIER_NOTIFICATION_IDS = [
	'app_tier_usage_80',
	'app_tier_quarantined',
	'app_tier_egress',
	'app_attestation_expiry'
] as const;

/** An APW-10 notification id — CONTRACTS §6A. */
export type AppsTierNotificationId = (typeof APPS_TIER_NOTIFICATION_IDS)[number];

/** The stable error code an open refusal answers with — CONTRACTS §12:785. */
export const APPS_TIER_OPEN_REFUSED_CODE = 'apps_tier_open_refused' as const;

/** The stable error code a tenant quota ceiling answers with — CONTRACTS §12:786. */
export const APPS_TIER_QUOTA_CEILING_EXCEEDED_CODE = 'quota_ceiling_exceeded' as const;
