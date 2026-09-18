/**
 * Ever Works Apps — the `apps-tier` capability's plugin-facing types
 * (APW-10 plan §5.1:546–598, tasks T2:73–81).
 *
 * Owning epic: **APW-10 (Ever Works Apps — isolated hosting tier)**. Spec:
 * `docs/specs/features/app-works/APW-10-apps-hosting-tier/spec.md`; plan §2.1
 * (the tier's own decisions), §2.5 (quarantine: `setDesiredState`), §2.6
 * (removal: `removeWork` / `releaseDependencies`), §3.1–§3.2 (the
 * `hosting.ever.works/v1alpha1` objects this module projects), §3.3 (the
 * platform credential `reviewCredentialScope` reviews, LG-12), §3.6 (the zone
 * configuration objects `zoneInfo` reads), §5.1 (the interface these types
 * serve), §5.2 (the plugin that implements it) and §5.3 (metering).
 *
 * ## What is declared here, and what is imported instead (Resolution R-1)
 *
 * `apps-tier.interface.ts` is the interface; **this** module is everything it
 * names. The wire-level model of the Kubernetes contract — the desired state the
 * plugin WRITES and the status it READS — is declared in
 * `packages/contracts/src/apps/apps-tier.ts` (APW-10 T1, landed) because the
 * API, the agent, the web and the zone controller all read it. A second
 * declaration here would be exactly the drift R-1 exists to prevent, so those
 * names are imported and re-exported, and this module adds only what is
 * genuinely plugin-facing.
 *
 * | Plan §5.1 names                     | The landed declaration this module reads instead                                                     |
 * | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
 * | `:551` `AppsTierWorkDesiredState`   | `AppsTierWorkSpec` (`packages/contracts/src/apps/apps-tier.ts:766`) — see the note below             |
 * | `:552` `AppsTierWorkStatus`         | re-exported from `apps-tier.ts:792`                                                                  |
 * | `:562–569` the dependency shapes    | `AppsTierDependencyRef` (`apps-tier.ts:704`) and `AppsTierDependencyStatusView` (`apps-tier.ts:717`) |
 * | `:577` `AppsTierSelfCheckStatus`    | declared here; its `results[]` entries are T1's `AppsTierSelfCheckResult` (`apps-tier.ts:208`)       |
 * | `:584` `AppsTierAbuseSignalReport`  | declared here; its `kind`/`severity` are T1's closed sets (`apps-tier.ts:464`, `:470`)               |
 * | `:589` `AppsTierLogRequest`         | APW-06's `AppLogRequest` (`app-deployment.types.ts:577`), aliased — plan §5.2:621 returns "the same redacted `AppLogTail` APW-06 defines" |
 * | `:590–591` the two P3 build shapes  | declared here from plan §3.2:307–309; their `scanSummary` / `signatureState` are APW-05's (`packages/contracts/src/apps/builds.ts:820`, `:173`) |
 *
 * **`applyWork`'s parameter, named twice.** Plan §5.1:551 writes
 * `applyWork(input: AppsTierWorkDesiredState)`. That identifier has since been
 * taken by T1 for something else: `AppsTierWorkDesiredState`
 * (`packages/contracts/src/apps/apps-tier.ts:527–530`) is the **four-value union
 * of `Work.spec.desiredState`** (`running` / `paused` / `quarantined` /
 * `removed`), while `applyWork` takes the whole desired-state object — T1's
 * `AppsTierWorkSpec`. The two cannot share a name: one is a field of the other.
 * The whole-object type wins the parameter, and T1's union is re-exported
 * unchanged, so `setDesiredState`'s two-value argument can be read beside it.
 * Nothing is renamed or removed — this is one identifier resolved in favour of
 * the file that declares the object.
 *
 * ## Additive only (CONTRACTS R-26)
 *
 * `apps-tier` is appended to `PLUGIN_CAPABILITIES` and no category is added: a
 * plugin that answers for the tier declares the existing `deployment` category
 * (plan §5.2:602), so `PLUGIN_CATEGORIES` is untouched and every existing
 * manifest, contract and plugin compiles and behaves exactly as before.
 */

import type { AppBuildScanSummary, AppBuildSignatureState } from '@ever-works/contracts';
import type {
	AppsTierDependencyRef,
	AppsTierDependencyStatusView,
	AppsTierQuarantineCategory,
	AppsTierSelfCheckResult,
	AppsTierSignalKind,
	AppsTierSignalSeverity,
	AppsTierWorkDesiredState,
	AppsTierWorkSpec,
	AppsTierWorkStatus
} from '@ever-works/contracts';
import type { AppLogRequest, AppLogTail } from './app-deployment.types.js';
import type { AppBuildBlock } from './build.interface.js';

export type {
	AppsTierDependencyRef,
	AppsTierDependencyStatusView,
	AppsTierQuarantineCategory,
	AppsTierSelfCheckResult,
	AppsTierSignalKind,
	AppsTierSignalSeverity,
	AppsTierWorkDesiredState,
	AppsTierWorkSpec,
	AppsTierWorkStatus
};

/* ------------------------------------------------------------------------- *
 * Zone configuration (plan §3.6:427, plan §5.1:550)
 * ------------------------------------------------------------------------- */

/**
 * What the zone says about itself — the `ever-works-apps-zone-info` ConfigMap,
 * projected (plan §3.6:427).
 *
 * `zoneInfo()` is the **one** call that tells the platform what the tier is
 * without dialling anything: `checkAppCluster` answers from it instead of
 * opening a connection (plan §5.2:622, "never dials"), `podPolicy()` reads
 * `sandboxRuntimeClass` (plan §5.5:717) and `ingress()` reads the edge class
 * (plan §5.5:718).
 *
 * §5.1:550's trailing comment names three of the five fields its caller most
 * often reads; the object itself is §3.6's ConfigMap, which carries all five. A
 * zone that publishes the ConfigMap always has every one of them, so none is
 * optional — an absent `appsDomain` is a zone the platform must refuse to serve,
 * not one to serve with a hole in it.
 *
 * No value here is a secret and none may be logged as one: the addresses are the
 * user-apps domain and the zone's own registry and ingress class (plan §3.6
 * "values private" refers to the sibling Secret objects, not this ConfigMap).
 */
export interface AppsTierZoneInfo {
	/** The user-apps apex every managed host sits under — LG-15 checks it is not a platform domain. */
	readonly appsDomain: string;
	/** The runtime class every tenant pod is forced onto — LG-04's signature and T4's pod overlay. */
	readonly sandboxRuntimeClass: string;
	/** `<zone registry>` — the only registry tenant images may come from (LG-13, plan §3.4:403). */
	readonly registryHost: string;
	/** The tier's own ingress class — `ingress()` answers it, never APW-06's (plan §5.5:718). */
	readonly edgeIngressClass: string;
	/** The controller version floor — below it, `evaluate()` closes the tier with `CONTROLLER_TOO_OLD`. */
	readonly minPlatformVersion: string;
}

/* ------------------------------------------------------------------------- *
 * Quarantine and removal (plan §2.5–§2.6, §3.1:239, §5.1:553–555)
 * ------------------------------------------------------------------------- */

/**
 * What `setDesiredState(workId, 'quarantined', q)` writes onto
 * `Work.spec.quarantine` (plan §3.1:239).
 *
 * `category` is T1's closed set (`abuse` / `security` / `billing` / `legal` /
 * `pause-all` / `drill`) — the **owner-safe** classification the quarantine
 * service shows, never the operator's free-text reason (spec FR-41; the reason
 * stays in `apps_tier_quarantines` and is never projected onto the `Work`).
 * `requestId` is what the controller echoes back in `status.quarantine.requestId`
 * so the platform can mirror the zone's own timestamps (plan §2.5:188).
 *
 * The type is not optional anywhere it is used: §5.1:553 makes `q` optional
 * **only** because a release call carries no quarantine at all — a transition
 * *into* `quarantined` without this object would write a `Work` the controller
 * cannot sequence.
 */
export interface AppsTierQuarantineRequest {
	readonly requestId: string;
	readonly category: AppsTierQuarantineCategory;
	readonly requestedAt: string;
}

/* ------------------------------------------------------------------------- *
 * Controller heartbeat (plan §5.1:581, LG-23)
 * ------------------------------------------------------------------------- */

/**
 * `getHeartbeat()`'s answer — the controller Lease, read through the platform's
 * narrow role (plan §3.3:337–340, LG-23:460).
 *
 * `renewedAt` is a **`Date`**, not an ISO string, exactly as §5.1:581 writes it:
 * the `Lease` carries a timestamp and `evaluate()` compares it against
 * `HEARTBEAT_MAX_AGE_MS` (120 s), so the plugin converts once and no caller has
 * to guess a format.
 *
 * Both members are nullable and **both nulls are a finding, never a pass**: a
 * missing `renewedAt` is `CONTROLLER_STALE` and a missing `controllerVersion` is
 * compared against `minPlatformVersion`, so a zone that answers nothing keeps
 * the tier closed (fail closed, plan §5.4:693–695). One call answers both:
 * LG-23 is one gate item with one reason code per half.
 */
export interface AppsTierHeartbeat {
	readonly renewedAt: Date | null;
	readonly controllerVersion: string | null;
}

/* ------------------------------------------------------------------------- *
 * Self-check (plan §3.2:299–301, §5.1:578–579)
 * ------------------------------------------------------------------------- */

/** `SelfCheck.status.phase` (plan §3.2:299). */
export const APPS_TIER_SELF_CHECK_PHASES = ['Running', 'Completed', 'Failed'] as const;

/** A `SelfCheck`'s phase — plan §3.2:299. */
export type AppsTierSelfCheckPhase = (typeof APPS_TIER_SELF_CHECK_PHASES)[number];

/**
 * `getSelfCheck(runId)`'s answer — one run, as the zone reports it
 * (plan §3.2:299–301).
 *
 * `null` from the interface means **"no such run"**, never "I could not tell" —
 * the latter is a throw. That distinction is what lets the self-check service
 * mark a run `error` at its 15-minute budget instead of trusting a run that
 * never existed (plan §5.1:579, tasks T16).
 *
 * `results[]` is T1's `AppsTierSelfCheckResult` verbatim (item id, outcome,
 * reason code, duration) because it is the same row the platform merges into
 * `apps_tier_gate_runs`; the two halves of a run — zone-side and platform-side —
 * must be indistinguishable once merged. `startedAt`/`finishedAt` are ISO strings
 * and `finishedAt` is `null` while the phase is `Running`.
 *
 * `policyRevision` and `controllerVersion` travel with the run because a green
 * run is only evidence **for the revision it was taken on** (spec FR-4): the
 * platform stores both beside the run and re-reads the heartbeat at evaluation
 * time.
 *
 * `items` is deliberately NOT on the status: the requested item list belongs to
 * `SelfCheck.spec` and the platform wrote it, so re-reading it from the zone
 * would be the platform checking its own request.
 */
export interface AppsTierSelfCheckStatus {
	readonly phase: AppsTierSelfCheckPhase;
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
	readonly results: readonly AppsTierSelfCheckResult[];
	readonly policyRevision: string;
	readonly controllerVersion: string;
}

/* ------------------------------------------------------------------------- *
 * The platform credential (plan §3.3, LG-12, §5.1:580)
 * ------------------------------------------------------------------------- */

/** One rule of a `SelfSubjectRulesReview` (plan §3.3:342–347). */
export interface AppsTierAccessRule {
	readonly apiGroups: readonly string[];
	readonly resources: readonly string[];
	readonly verbs: readonly string[];
	/** Present on a rule that is limited to named objects; absent means every name. */
	readonly resourceNames?: readonly string[];
}

/**
 * One entry of the forbidden-check list — a `SelfSubjectAccessReview` the
 * credential must FAIL (plan §3.3:343–345).
 *
 * `allowed: true` is a finding: the check names something the platform Role does
 * **not** grant (a secret, a node, a foreign namespace, an `escalate`), so a
 * credential that may do it is broader than §3.3 allows.
 */
export interface AppsTierForbiddenPermissionCheck {
	readonly verb: string;
	readonly resource: string;
	readonly allowed: boolean;
}

/**
 * `reviewCredentialScope()`'s answer — LG-12, the tier's own credential review
 * (plan §3.3:342–345, §3.7:449).
 *
 * DECLARED HERE because no other file does: plan §5.1:580 names
 * `AppsTierAccessReview` and §3.7 gives LG-12 its two probes and its single
 * reason code, but no field list exists anywhere in the plan. This is the
 * narrowest shape those two probes can answer with, so the check and its caller
 * agree on the same four members:
 *
 *  1. `ok` — the verdict. `false` fails LG-12.
 *  2. `namespace` — the control namespace the rules review ran in. A rules review
 *     is namespace-scoped, so the answer is meaningless without it.
 *  3. `rules` — the `SelfSubjectRulesReview`, verbatim and secret-free. It is
 *     what a human reads when the verdict is "too broad", and it is what proves
 *     "no ClusterRole binding" rather than asserting it.
 *  4. `forbiddenChecks` — one row per check of the fixed list, each carrying
 *     whether it was `allowed`. The list itself is zone configuration, not a
 *     constant here: §3.7 does not publish its 24 rows and a platform-side copy
 *     would be a second, silently drilling declaration of the zone's policy.
 *
 * `reasonCode` is LG-12's one code, `CREDENTIAL_TOO_BROAD`, or `null` when the
 * verdict is `true` — the same "one code per item" shape the probe catalogue
 * uses for every other item.
 */
export interface AppsTierAccessReview {
	readonly ok: boolean;
	readonly namespace: string;
	readonly rules: readonly AppsTierAccessRule[];
	readonly forbiddenChecks: readonly AppsTierForbiddenPermissionCheck[];
	readonly reasonCode: 'CREDENTIAL_TOO_BROAD' | null;
}

/* ------------------------------------------------------------------------- *
 * Metering and signals (plan §3.2:302–306, §5.1:582–585, §5.3)
 * ------------------------------------------------------------------------- */

/**
 * One unacknowledged `UsageReport`, projected (plan §3.2:302–304).
 *
 * `name` is the object's own `metadata.name`, `ur-<workId>-<windowStart epoch>`
 * — the handle `acknowledgeUsageReports(names)` takes, so a caller never has to
 * rebuild the pattern.
 *
 * The five metered quantities of §3.2 are followed by the two dependency units
 * XC-20 adds: `dependencyStorageGiBHours` and `dependencyBackupGiBHours` are
 * billed through `hosting.dependency_storage_gib_hour` and
 * `hosting.dependency_backup_gib_hour` (plan §5.3:665–666), and they can only be
 * billed if they arrive on the report. T1's `APPS_TIER_USAGE_UNITS`
 * (`apps-tier.ts:1178`) names all seven, and this interface carries exactly
 * those seven — one field per unit, so a unit the pricebook names cannot be
 * silently un-metered.
 *
 * `acknowledgedAt` is `null` until the platform acknowledges; `listUsageReports`
 * answers only unacknowledged reports (plan §5.1:582), so the field is a
 * confirmation of the zone's own bookkeeping rather than a filter the caller
 * applies. Whole numbers only: billing units are integers and any remainder is
 * carried on the next window (plan §5.3:664–665).
 */
export interface AppsTierUsageReport {
	readonly name: string;
	readonly workId: string;
	readonly windowStart: string;
	readonly windowEnd: string;
	readonly cpuCoreSeconds: number;
	readonly memoryMiBHours: number;
	readonly egressMiB: number;
	readonly storageGiBHours: number;
	readonly buildMinutes: number;
	readonly dependencyStorageGiBHours: number;
	readonly dependencyBackupGiBHours: number;
	readonly acknowledgedAt: string | null;
}

/**
 * One `AbuseSignal`, projected (plan §3.2:305–306).
 *
 * `kind` and `severity` are T1's closed sets rather than §3.2's inline lists:
 * T1's `APPS_TIER_SIGNAL_KINDS` (`apps-tier.ts:464`) is the same four kinds plus
 * `report` — the owner's own report, which the platform raises and no sensor
 * rule emits — and its severity set is identical. Reaching for the landed union
 * is what keeps a signal the operator board shows and the importer stores the
 * same shape.
 *
 * `summary` is capped at `APPS_TIER_SIGNAL_SUMMARY_MAX_CHARS` (500) by the zone
 * and by the platform's importer (spec FR-37); it summarises, so it must never
 * quote an environment value or a credential.
 *
 * `name` is opaque here: §3.2 fixes a naming pattern for `UsageReport` only, so
 * the platform acknowledges signals by whatever name the zone gave them.
 *
 * `test` marks the LG-19 sensor trigger's benign signal. It is a real row and a
 * real acknowledgement — never a real quarantine (tasks T29: "`test: true` never
 * quarantines a non-canary Work"), which is why `autoQuarantined` is reported
 * beside it rather than inferred from it.
 */
export interface AppsTierAbuseSignalReport {
	readonly name: string;
	readonly workId: string;
	readonly kind: AppsTierSignalKind;
	readonly severity: AppsTierSignalSeverity;
	readonly observedAt: string;
	readonly summary: string;
	readonly ruleId: string;
	readonly test: boolean;
	readonly acknowledgedAt: string | null;
	readonly autoQuarantined: boolean;
}

/* ------------------------------------------------------------------------- *
 * Owner logs (plan §5.1:589, §5.2:621, APW-06 FR-48)
 * ------------------------------------------------------------------------- */

/**
 * What `getAppLogs(workId, opts)` is asked for.
 *
 * Aliased to APW-06's `AppLogRequest` (`app-deployment.types.ts:577`) instead of
 * restated, because plan §5.2:621 says the manager returns "the same redacted
 * `AppLogTail` APW-06 defines": one Work, one log request, two targets. The
 * `workId` is the method's first parameter rather than a field here, so the
 * plugin cannot be handed a request for one Work while the facade resolved
 * another. `secretValues` is in-memory redaction material for the zone's own
 * scrubber — it is never logged, never stored, and never a field of the page
 * that comes back.
 */
export type AppsTierLogRequest = AppLogRequest;

/**
 * The reason a log pull could not be served **right now** (plan §5.2:621).
 *
 * A temporary zone refusal — the pod is between restarts, the node is busy, the
 * tenant namespace is momentarily absent — answers this instead of throwing, so
 * `GET /api/works/:id/app-logs/:requestId` reports a retryable state rather than
 * a failed route (tasks T26).
 */
export const APPS_TIER_LOG_UNAVAILABLE_CODE = 'logs_unavailable_on_tier' as const;

/** The one code a refused log pull carries — plan §5.2:621. */
export type AppsTierLogUnavailableCode = typeof APPS_TIER_LOG_UNAVAILABLE_CODE;

/**
 * `getAppLogs`'s answer — a page of redacted log lines, or the reason there are
 * none (plan §5.1:589, §5.2:621).
 *
 * `status` has two values, not APW-06's three: APW-06's route is asynchronous
 * (`pending` is a state the *route* caches, `app-runtime` plan §9.1), while this
 * member is the synchronous zone pull behind it — the page is either there or it
 * is refused. `tail` is APW-06's own `AppLogTail`, already redacted by the
 * plugin, and `code` is non-null **only** with `status: 'unavailable'`; a `ready`
 * page never carries a code, because there is nothing to explain.
 */
export interface AppsTierLogPage {
	readonly status: 'ready' | 'unavailable';
	readonly tail: AppLogTail | null;
	readonly code: AppsTierLogUnavailableCode | null;
}

/* ------------------------------------------------------------------------- *
 * P3 — sandboxed in-zone builds (plan §3.2:307–309, §5.1:590–591)
 * ------------------------------------------------------------------------- */

/**
 * What `submitBuild(input)` asks the zone to build (plan §3.2:307–308, P3).
 *
 * One `AppBuild` object, addressed by `buildId` — the id APW-05's build service
 * already owns, so the zone's status can be correlated to the Build row without
 * a second identifier.
 *
 * `args` is APW-05's own `AppBuildBlock['args']` (`build.interface.ts:133`),
 * derived rather than restated: `submitBuild` is called with a build the build
 * capability already normalised, and a second copy of the argument shape would
 * let the two drift on the one field a Docker build is most sensitive to.
 * `dockerfile` / `context` / `target` are optional here for the same reason they
 * are optional there — strategies `image` and `none` have none.
 *
 * `sealedSourceToken` is the repository credential, sealed to the controller's
 * key id (plan §2.3): the zone unseals it, uses it to clone, and never returns
 * it. It must never appear in a log, an error message or a status field.
 *
 * `caps` is typed with the one limit the plan's own acceptance text attests —
 * LG-25's whole-run cap, which T33's 60-second fixture turns into a recorded
 * cap-exceeded build. §3.2 leaves `caps` untyped, so only that field is declared
 * here; a later task extends it additively rather than this one inventing
 * resource limits no task asserts.
 */
export interface AppsTierBuildRequest {
	readonly workId: string;
	readonly buildId: string;
	readonly sourceRepo: string;
	readonly commitSha: string;
	readonly dockerfile?: string;
	readonly context?: string;
	readonly target?: string;
	readonly args: AppBuildBlock['args'];
	readonly sealedSourceToken: string;
	readonly caps: { readonly timeoutSeconds: number };
}

/**
 * `getBuild(buildId)`'s answer (plan §3.2:307–309, P3).
 *
 * The three fields §3.2 names are typed with the declarations APW-05 already
 * reads, so a zone status and a Build row agree without a mapping table:
 * `scanSummary` is `AppBuildScanSummary` (`builds.ts:820`), `signatureState` is
 * `AppBuildSignatureState` (`builds.ts:173`) and `blockedEgressHosts` is the
 * list of hosts the build's sandbox refused — LG-24's `BUILD_EGRESS_OPEN` is
 * raised when a host that should have been refused was reachable, so the list is
 * the probe's own evidence rather than a secondary assertion.
 *
 * `phase` stays a `string`, exactly as plan §3.2 leaves it: the phase vocabulary
 * belongs to the zone's `AppBuild` reconciler (T33), and a closed union declared
 * here would make this contract narrower than the status it reports. APW-05's
 * own deployability rule never reads it — it reads `signatureState`, `scan` and
 * `status` from the Build row (`builds.ts:829–859`).
 *
 * A `null` from the interface means "no such build", never "I could not tell".
 */
export interface AppsTierBuildStatus {
	readonly phase: string;
	readonly imageDigest: string | null;
	readonly scanSummary: AppBuildScanSummary | null;
	readonly signatureState: AppBuildSignatureState | null;
	readonly blockedEgressHosts: readonly string[];
	readonly startedAt: string | null;
	readonly finishedAt: string | null;
}
