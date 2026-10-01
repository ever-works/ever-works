/**
 * App Works — the App runtime contract: deploy targets, the phase machine, the
 * Deployment and app-state vocabularies, the closed precondition and failure
 * code sets, and every number plan §5.3 fixes.
 *
 * Owning epic: **APW-06 (App runtime on Kubernetes)**. Implements
 * `docs/specs/features/app-works/APW-06-app-runtime/spec.md` and its `plan.md`
 * §3 (`AppDeployPhase`, `AppDeployResult.outcome` / `.cancelReason`), §3.1
 * (`AppRuntimeState`, `AppFailureCode`), §5.1 (precondition codes), §5.3
 * (phases and numbers), §5.4 + §11 (failure codes), §7.1/§7.2 (the stored state
 * vocabularies) and §9.3/§10.3 (the health streak rules and the i18n subtrees).
 * Task T1 of the epic's task list.
 *
 * Why one module: the API, the web, the agent worker, the `k8s` plugin and the
 * managed tier all name the same phases, states and deadlines, and the failure
 * this file prevents is two of them declaring "the same" union or number
 * slightly differently. Where a value already exists in this folder it is
 * imported and re-exported rather than restated — see {@link APP_DEPLOY_TARGETS},
 * whose array is `app-source.ts`'s and is NOT written a second time.
 *
 * Additive only (CONTRACTS R-26, the owner's top-priority rule): a closed union
 * here gains members and a limit is raised deliberately; a member is never
 * renamed, removed or reused for another situation. Where two spec sections
 * describe the same set at different granularity both readings get their own
 * exported union rather than one being dropped — see
 * {@link APP_DEPLOYMENT_STATES} (the stored values) against
 * {@link APP_DEPLOYMENT_DISPLAY_STATES} (the ten user-facing ones, spec §6.7).
 *
 * Nothing here is persisted, fetched or dialled: closed unions, constants, the
 * total companion maps that turn "a member was added without its companion"
 * into a test failure, and one pure formula.
 */

import { APP_DEPLOY_TARGET_CHOICES } from './app-source.js';

/* ------------------------------------------------------------------------- *
 * Deploy target and purpose
 * ------------------------------------------------------------------------- */

/**
 * The three deploy targets, and the ONLY array of them in this package
 * (CONTRACTS.md:335, R-12 at CONTRACTS.md:55): `none` is "None — don't deploy
 * yet" and is the default, and there is **no** separate "not yet" value.
 *
 * Deliberately a re-export of `app-source.ts`'s {@link APP_DEPLOY_TARGET_CHOICES}
 * rather than a second literal, which is what that constant's own comment asks
 * for — two arrays with the same three strings would drift the first time one
 * is extended.
 */
export const APP_DEPLOY_TARGETS = APP_DEPLOY_TARGET_CHOICES;

/** Union derived from {@link APP_DEPLOY_TARGETS} — `none` · `your-cluster` · `ever-works-apps` (R-12). */
export type AppDeployTarget = (typeof APP_DEPLOY_TARGETS)[number];

/**
 * What a render input is for (plan §3:211, resolution R-10): `deploy` is the
 * live App Work's own namespace, `verification` is APW-04's per-attempt
 * namespace (§4.12) that is never the live one and never recorded in
 * `work_app_runtime_states.namespace`.
 */
export const APP_DEPLOY_PURPOSES = ['deploy', 'verification'] as const;

/** Union derived from {@link APP_DEPLOY_PURPOSES}. */
export type AppDeployPurpose = (typeof APP_DEPLOY_PURPOSES)[number];

/* ------------------------------------------------------------------------- *
 * The phase machine (plan §3:188-199, plan §5.5)
 * ------------------------------------------------------------------------- */

/**
 * `AppDeployPhase` — the eleven phases of plan §3:188-199, in the order §5.5
 * runs them, with `rollback` reached only on the failure path and `done` last.
 *
 * Eleven members on purpose: the i18n `phases.*` subtree is "11" (plan §10.3:1624,
 * §3:1807). APW-10's desired-state field lists the same names minus `rollback`
 * (APW-10 `plan.md:264`), which is that row's own vocabulary, not a reduction of
 * this union — R-26 keeps the union whole.
 */
export const APP_DEPLOY_PHASES = [
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
] as const;

/** Union derived from {@link APP_DEPLOY_PHASES} — `AppDeployPhase` (plan §3:188-199). */
export type AppDeployPhase = (typeof APP_DEPLOY_PHASES)[number];

/**
 * `AppDeployResult.outcome` — the six outcomes `deployApp` resolves to
 * (plan §3:255), which plan §5.6:810 maps onto the stored Deployment state.
 */
export const APP_DEPLOY_OUTCOMES = [
	'succeeded',
	'succeeded-with-warnings',
	'failed',
	'rolled-back',
	'cancelled',
	'rollback-failed'
] as const;

/** Union derived from {@link APP_DEPLOY_OUTCOMES}. */
export type AppDeployOutcome = (typeof APP_DEPLOY_OUTCOMES)[number];

/**
 * Why a Deployment was cancelled (plan §3:257, mandatory when the outcome is
 * `cancelled`, or `rolled-back` because of a cancel).
 *
 * The same three values are what `appRender.cancelledBy` stores (plan §7.1:1022).
 */
export const APP_CANCEL_REASONS = ['user', 'quarantined', 'app_work_deleting'] as const;

/** Union derived from {@link APP_CANCEL_REASONS}. */
export type AppCancelReason = (typeof APP_CANCEL_REASONS)[number];

/* ------------------------------------------------------------------------- *
 * Deployment states (plan §7.1:1013-1025, spec §6.7:705)
 * ------------------------------------------------------------------------- */

/**
 * `work_deployments.state` — the STORED values, including the four APW-06 adds.
 *
 * The seven pre-existing values are the entity's (`INITIALIZING` is the column
 * default, `work-deployment.entity.ts:65`; `READY`/`ERROR`/`CANCELED`/`TIMEOUT`
 * are `isTerminal()`'s four, `work-deployment.entity.ts:108`; `QUEUED` and
 * `BUILDING` are the named verifier states, `deploy-ready-poller.service.ts:41-50`)
 * and the four new ones are plan §7.1:1024 — `DEPLOYING`, `VERIFYING`,
 * `ROLLED_BACK`, `SUPERSEDED`.
 *
 * This is deliberately NOT reduced to the ten user-facing states of spec §6.7:
 * the labels are many-to-one onto these values (`Live` and `Live with warnings`
 * are both `READY`; `Cancelled` and `Cancelled — quarantined` are both
 * `CANCELED`), so both vocabularies are exported and neither is derived from the
 * other by discarding a member.
 */
export const APP_DEPLOYMENT_STATES = [
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
] as const;

/** Union derived from {@link APP_DEPLOYMENT_STATES} — `work_deployments.state`. */
export type AppDeploymentState = (typeof APP_DEPLOYMENT_STATES)[number];

/**
 * The states `WorkDeployment.isTerminal()` reports true for
 * (`work-deployment.entity.ts:108` for the first four, plan §7.1:1024-1025 for
 * the two APW-06 adds).
 */
export const APP_DEPLOYMENT_TERMINAL_STATES = [
	'READY',
	'ERROR',
	'CANCELED',
	'TIMEOUT',
	'ROLLED_BACK',
	'SUPERSEDED'
] as const;

/** Union derived from {@link APP_DEPLOYMENT_TERMINAL_STATES}. */
export type AppDeploymentTerminalState = (typeof APP_DEPLOYMENT_TERMINAL_STATES)[number];

/**
 * The ten Deployment states a member reads, in spec §6.7:705's table order.
 *
 * Named by the state, not by the label — the leaf this file's owner contributes
 * to `dashboard.workDetail.deploy.app.states` is the camelCase of each entry
 * (plan §10.3:1623-1624, "states.* (10 Deployment + 7 app states …)"), so the
 * English labels stay the web's to write.
 *
 * The mapping onto the stored values is the part that cannot be guessed:
 * `checking` is `VERIFYING`; `live-with-warnings` is `READY` carrying
 * `appRender.warnings`; `cancelled-quarantined` is `CANCELED` with
 * `cancelReason: 'quarantined'`; and `skipped` is `SUPERSEDED` ("the replaced
 * record reads **Skipped**", FR-30 spec.md:391, plan §3:876).
 */
export const APP_DEPLOYMENT_DISPLAY_STATES = [
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
] as const;

/** Union derived from {@link APP_DEPLOYMENT_DISPLAY_STATES} — spec §6.7:705. */
export type AppDeploymentDisplayState = (typeof APP_DEPLOYMENT_DISPLAY_STATES)[number];

/* ------------------------------------------------------------------------- *
 * App runtime state and health (plan §3.1:367-369, §7.2:1052)
 * ------------------------------------------------------------------------- */

/**
 * `AppRuntimeState` — the shared app state FR-46 reports
 * (spec.md:472-474), mapped from `health` + `paused` + `removedAt` +
 * `deletionRequestedAt` (plan §3.1:367-369).
 *
 * Seven members, matching spec §6.7:706's seven app states one for one; the
 * label of `unreachable` is "Can't reach your cluster" and of `deleting` is
 * "Deleting…", so the i18n leaves stay the camelCase of these values.
 * `Deploying` and `Live with warnings` are NOT here — they are the current
 * Deployment's states and are shown beside the app state, never instead of it
 * (plan §3.1:368-369).
 */
export const APP_RUNTIME_STATES = [
	'not-deployed',
	'live',
	'degraded',
	'down',
	'unreachable',
	'paused',
	'deleting'
] as const;

/** Union derived from {@link APP_RUNTIME_STATES} — `AppRuntimeState` (plan §3.1:367). */
export type AppRuntimeState = (typeof APP_RUNTIME_STATES)[number];

/**
 * `work_app_runtime_states.health` — five values, `unknown` being the column
 * default (plan §7.2:1052 and its explicit-defaults paragraph at §7:1009-1010).
 *
 * The verdict rules the poller applies are FR-47 (spec.md:476-481) and
 * plan §9.3:1276-1279: `down` when the primary web component has 0 ready
 * replicas; `degraded` when a web component is below desired replicas or the
 * public check fails; `unreachable` on a credential or connection error; else
 * `healthy`.
 */
export const APP_RUNTIME_HEALTH = ['unknown', 'healthy', 'degraded', 'down', 'unreachable'] as const;

/** Union derived from {@link APP_RUNTIME_HEALTH}. */
export type AppRuntimeHealth = (typeof APP_RUNTIME_HEALTH)[number];

/* ------------------------------------------------------------------------- *
 * Preconditions (plan §5.1:661-680, plus plan §11:1644 and the G21 resolution)
 * ------------------------------------------------------------------------- */

/**
 * The closed set of deploy precondition codes, in plan §5.1's table order.
 *
 * Every row of §5.1 is here, including the three the task list calls out by
 * name — `managed_ineligible`, `managed_sandbox_unavailable` (both R-24) and
 * `app_work_deleting` — and two the table does not carry but the plan names
 * elsewhere as preconditions, appended rather than folded into another row:
 *
 *  - `namespace_foreign` — "Precondition failure `namespace_foreign`; never
 *    adopted" (plan §11:1644), the refusal `app-runtime-target.resolver`
 *    returns for a namespace another Work owns (plan §12.2:1694). APW-07's port
 *    spells the same situation `namespace_owned_elsewhere` (plan §9.6:1424).
 *  - `verification_namespace_forbidden` — "a verification **refuses** with
 *    `verification_namespace_forbidden`" when the credential cannot create a
 *    namespace (plan §10.3's resolutions, `plan.md:1784-1786`).
 *
 * Append-only: a code is never renamed, removed or reused for another situation
 * (CONTRACTS §12), because it is a persisted `appRender.preconditions[]` code
 * and an i18n leaf name.
 */
export const APP_PRECONDITION_CODES = [
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
] as const;

/** Union derived from {@link APP_PRECONDITION_CODES} — `AppPrecondition.code`. */
export type AppPreconditionCode = (typeof APP_PRECONDITION_CODES)[number];

/**
 * One unmet precondition, in the shape plan §3.1:375 and §5.1:674 write down —
 * `{ code, names?, message, fixUrl? }` — and the element type of §4.9's
 * `APP_DEPLOY_PRECONDITIONS` / `APP_TARGET_REFUSED` error bodies
 * (`unmet: AppPrecondition[]`, plan:151 and plan:1213).
 *
 * **Why this is declared here rather than "unchanged" as the plan said.** The
 * plan's prose called the type unchanged, so it read as though the substrate
 * already carried it; it did not — nothing under `packages/**` declared it, and
 * the two modules that needed the shape each declared a structurally
 * compatible interface locally instead
 * (`packages/plugins/k8s/src/app/app-manifest.renderer.ts` and
 * `app-jobs.renderer.ts` both say "`AppPrecondition`-shaped" beside their own
 * `AppRenderRefusal`). Declaring it is purely additive: nothing is renamed,
 * moved or removed, those local interfaces stay exactly as they are, and they
 * remain assignable to this one — which is all "`AppPrecondition`-shaped" ever
 * claimed. `AppRenderRefusal`'s three codes are a subset of
 * {@link APP_PRECONDITION_CODES}, asserted in `app-runtime.spec.ts`.
 *
 * `names` is plural because one precondition can be about several things at
 * once: three unset env values are one `env_required_unset` naming three
 * entries, not three rows a caller has to merge. `fixUrl` is present only when
 * there is somewhere to send the person. Both are optional, so a producer that
 * has neither still returns the shape.
 *
 * **Open question, recorded rather than guessed.** §5.1's table writes
 * `managed_ineligible` as "`managed_ineligible` (+ reasons)" and never says
 * where those reasons live. The four fields the plan states explicitly are the
 * four declared here; if that code's producer (APW-10's tier policy) needs a
 * fifth field, it is added as another **optional** member, never by making one
 * of these required.
 */
export interface AppPrecondition {
	code: AppPreconditionCode;
	names?: string[];
	message: string;
	fixUrl?: string;
}

/**
 * Every app state each precondition code can be reported in — the companion
 * that makes adding a code to {@link APP_PRECONDITION_CODES} without deciding
 * where it is reported a **test failure** rather than a silent hole.
 *
 * Most codes are reportable in every state, and that is not laziness: FR-24
 * (spec.md:362-367) checks preconditions "on request and again when work
 * starts", and §5.6 step 1 re-runs §5.1 for a Deployment whose request was
 * already accepted, so an invalid spec or a missing env value blocks a
 * Deployment whether the app is live, degraded or never deployed.
 *
 * The two narrow entries are §5.1's own "runtime state" rows read literally:
 * `paused` is the state `paused` (FR-49 refuses a Deployment of a paused App
 * Work, spec.md:491) and `app_work_deleting` is the state `deleting`
 * (`deletionRequestedAt` set, plan §9.7).
 */
export const APP_PRECONDITION_STATES = {
	spec_invalid: APP_RUNTIME_STATES,
	license_blocks_target: APP_RUNTIME_STATES,
	license_attestation_missing: APP_RUNTIME_STATES,
	env_required_unset: APP_RUNTIME_STATES,
	dependency_not_ready: APP_RUNTIME_STATES,
	no_green_build: APP_RUNTIME_STATES,
	no_green_build_for_head: APP_RUNTIME_STATES,
	build_image_missing: APP_RUNTIME_STATES,
	nothing_to_deploy: APP_RUNTIME_STATES,
	image_not_pinned: APP_RUNTIME_STATES,
	image_not_found: APP_RUNTIME_STATES,
	image_private_unsupported: APP_RUNTIME_STATES,
	image_unresolvable: APP_RUNTIME_STATES,
	primary_domain_missing: APP_RUNTIME_STATES,
	target_none: APP_RUNTIME_STATES,
	target_not_checked: APP_RUNTIME_STATES,
	cluster_changed_unconfirmed: APP_RUNTIME_STATES,
	managed_disabled: APP_RUNTIME_STATES,
	managed_scope_unverified_blueprint: APP_RUNTIME_STATES,
	quota_exceeded: APP_RUNTIME_STATES,
	managed_ineligible: APP_RUNTIME_STATES,
	managed_sandbox_unavailable: APP_RUNTIME_STATES,
	app_work_deleting: ['deleting'],
	paused: ['paused'],
	deploy_in_progress: APP_RUNTIME_STATES,
	cron_auth_env_unset: APP_RUNTIME_STATES,
	job_auth_env_unset: APP_RUNTIME_STATES,
	volume_replicas: APP_RUNTIME_STATES,
	volume_shrink: APP_RUNTIME_STATES,
	privileged_port: APP_RUNTIME_STATES,
	cron_too_frequent: APP_RUNTIME_STATES,
	managed_root_forbidden: APP_RUNTIME_STATES,
	image_user_unverifiable: APP_RUNTIME_STATES,
	worker_not_isolated: APP_RUNTIME_STATES,
	env_source_unavailable: APP_RUNTIME_STATES,
	pull_credential_unavailable: APP_RUNTIME_STATES,
	namespace_foreign: APP_RUNTIME_STATES,
	verification_namespace_forbidden: APP_RUNTIME_STATES
} as const satisfies Record<AppPreconditionCode, readonly AppRuntimeState[]>;

/**
 * One `dashboard.workDetail.deploy.app.preconditions.<leaf>` leaf per code —
 * plan §10.3:1624 ("`preconditions.*` (one per §5.1 code)") with camelCase,
 * `.`-free leaves (plan §10.3:1620).
 *
 * Only the leaf is fixed here. The English sentence for each code is the
 * leaf-by-leaf table APW06-G25 adds (plan §3:1806-1808), which is the web
 * task's deliverable and is deliberately not copied into this package.
 */
export const APP_PRECONDITION_MESSAGE_LEAVES = {
	spec_invalid: 'specInvalid',
	license_blocks_target: 'licenseBlocksTarget',
	license_attestation_missing: 'licenseAttestationMissing',
	env_required_unset: 'envRequiredUnset',
	dependency_not_ready: 'dependencyNotReady',
	no_green_build: 'noGreenBuild',
	no_green_build_for_head: 'noGreenBuildForHead',
	build_image_missing: 'buildImageMissing',
	nothing_to_deploy: 'nothingToDeploy',
	image_not_pinned: 'imageNotPinned',
	image_not_found: 'imageNotFound',
	image_private_unsupported: 'imagePrivateUnsupported',
	image_unresolvable: 'imageUnresolvable',
	primary_domain_missing: 'primaryDomainMissing',
	target_none: 'targetNone',
	target_not_checked: 'targetNotChecked',
	cluster_changed_unconfirmed: 'clusterChangedUnconfirmed',
	managed_disabled: 'managedDisabled',
	managed_scope_unverified_blueprint: 'managedScopeUnverifiedBlueprint',
	quota_exceeded: 'quotaExceeded',
	managed_ineligible: 'managedIneligible',
	managed_sandbox_unavailable: 'managedSandboxUnavailable',
	app_work_deleting: 'appWorkDeleting',
	paused: 'paused',
	deploy_in_progress: 'deployInProgress',
	cron_auth_env_unset: 'cronAuthEnvUnset',
	job_auth_env_unset: 'jobAuthEnvUnset',
	volume_replicas: 'volumeReplicas',
	volume_shrink: 'volumeShrink',
	privileged_port: 'privilegedPort',
	cron_too_frequent: 'cronTooFrequent',
	managed_root_forbidden: 'managedRootForbidden',
	image_user_unverifiable: 'imageUserUnverifiable',
	worker_not_isolated: 'workerNotIsolated',
	env_source_unavailable: 'envSourceUnavailable',
	pull_credential_unavailable: 'pullCredentialUnavailable',
	namespace_foreign: 'namespaceForeign',
	verification_namespace_forbidden: 'verificationNamespaceForbidden'
} as const satisfies Record<AppPreconditionCode, string>;

/* ------------------------------------------------------------------------- *
 * Failure codes (plan §3.1:370-374, §5.4, §11)
 * ------------------------------------------------------------------------- */

/**
 * `AppFailureCode` — the eighteen members plan §3.1:370-374 collects from
 * §5.4, §11 and §10.3, in that order. T1's `APP_FAILURE_CODES` "pins exactly
 * this list" (tasks.md:47, plan §3.1:374).
 *
 * Sources, member by member: §5.4's classifier produces `crash_loop`,
 * `oom_killed`, `image_pull` (from `ImagePullBackOff` / `ErrImagePull`),
 * `create_container_config` (from `CreateContainerConfigError` /
 * `CreateContainerError`) and `rollout_timeout` (plan §5.4:763-766); §11's
 * table produces `worker_failed`, `cluster_unreachable` and
 * `isolation_not_enforced`; §4.4's managed root check produces
 * `managed_root_forbidden` and `image_user_unverifiable`; a phase deadline
 * produces `deadline_exceeded`; and §5.8's registry answers produce
 * `image_not_found`, `image_private_unsupported` and `image_unresolvable`
 * (plan §5.8:865).
 */
export const APP_FAILURE_CODES = [
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
] as const;

/** Union derived from {@link APP_FAILURE_CODES} — `AppFailureCode` (plan §3.1:370). */
export type AppFailureCode = (typeof APP_FAILURE_CODES)[number];

/**
 * One `dashboard.workDetail.deploy.app.failures.<leaf>` entry per failure code,
 * and `null` where no leaf is named yet.
 *
 * plan §10.3:1625-1627 lists fourteen `failures.*` leaves. Thirteen of them are
 * the camelCase of a failure code — with one deliberate exception:
 * `imageRunsAsRoot` is the leaf for `managed_root_forbidden`, whose code takes
 * its name from the security-context rule (§5.1, §4.4) while its copy names the
 * user-visible cause. The fourteenth, `imageNotPinned`, belongs to the warning
 * /precondition vocabulary rather than to a failure code, so it is recorded in
 * {@link APP_FAILURE_LEAVES_WITHOUT_FAILURE_CODE} instead of being dropped.
 *
 * The five `null`s are NOT "no copy is needed": APW06-G25 requires copy for
 * every §5.4 failure code (plan §3:1806-1808) while §10.3's leaf list names
 * none for them. The gap is named in
 * {@link APP_FAILURE_CODES_WITHOUT_MESSAGE_LEAF} rather than filled in with a
 * leaf name this epic invented — an i18n key nobody wrote is worse than a
 * visible hole.
 */
export const APP_FAILURE_MESSAGE_LEAVES = {
	crash_loop: 'crashLoop',
	oom_killed: 'oomKilled',
	image_pull: 'imagePull',
	create_container_config: null,
	rollout_timeout: 'rolloutTimeout',
	job_failed: 'jobFailed',
	smoke_failed: 'smokeFailed',
	publish_failed: 'publishFailed',
	rollback_failed: 'rollbackFailed',
	cluster_unreachable: null,
	worker_failed: null,
	isolation_not_enforced: null,
	managed_root_forbidden: 'imageRunsAsRoot',
	image_user_unverifiable: 'imageUserUnverifiable',
	deadline_exceeded: null,
	image_not_found: 'imageNotFound',
	image_private_unsupported: 'imagePrivateUnsupported',
	image_unresolvable: 'imageUnresolvable'
} as const satisfies Record<AppFailureCode, string | null>;

/**
 * The failure codes plan §10.3 names no `failures.*` leaf for — a named gap,
 * never a silent hole (the `APP_REPOSITORY_STAGES_WITHOUT_SPEC_LIMIT` idiom of
 * `apps-limits.ts:113`).
 *
 * `create_container_config` is the one §5.4 itself produces while APW06-G25's
 * copy table (plan §10.3) has no row for it; the other four are §11 outcomes
 * which may never reach a member-facing notice. When the i18n table lands, one
 * leaf per member here is what closes the gap — this constant is the checklist.
 */
export const APP_FAILURE_CODES_WITHOUT_MESSAGE_LEAF: readonly AppFailureCode[] = [
	'create_container_config',
	'cluster_unreachable',
	'worker_failed',
	'isolation_not_enforced',
	'deadline_exceeded'
];

/**
 * The `failures.*` leaves of plan §10.3 that belong to a warning or a
 * precondition rather than to a failure code — kept so the leaf list stays
 * whole (R-26) while {@link APP_FAILURE_MESSAGE_LEAVES} stays a total map over
 * the failure codes.
 *
 * `imageNotPinned` is the warning plan §5.8:864 records on a tag-resolved
 * image and the precondition plan §5.1 refuses a managed Deployment with.
 */
export const APP_FAILURE_LEAVES_WITHOUT_FAILURE_CODE = ['imageNotPinned'] as const;

/* ------------------------------------------------------------------------- *
 * Numbers — every constant of plan §5.3 (plan.md:698-752)
 * ------------------------------------------------------------------------- */

/**
 * A Deployment request answers within 2 s and never waits for the cluster —
 * FR-23 (spec.md:360-361), plan §2.2:159. plan §5.3:701.
 */
export const APP_DEPLOY_REQUEST_BUDGET_MS = 2_000;

/**
 * Phase 1 — prepare namespace, policies, secrets and volumes — has a 120 s
 * deadline, and its failure leaves the running app untouched — FR-26 step 1
 * (spec.md:374). plan §5.3:702.
 */
export const APP_PREPARE_TIMEOUT_S = 120;

/**
 * A job's timeout when the App spec declares none: 600 s, inside the spec's
 * 10–3600 s range — FR-26 step 2 (spec.md:375). The range itself is the
 * schema's (`APP_JOB_TIMEOUT_*` in APW-03); this is the default. plan §5.3:703.
 */
export const APP_JOB_TIMEOUT_DEFAULT_S = 600;

/**
 * The `+ 120` of the component deadline formula — FR-26 step 3 (spec.md:376),
 * plan §5.3:704, and the formula restated at plan §5.3:754-756. Used by
 * {@link appComponentDeadlineSeconds}.
 */
export const APP_ROLLOUT_EXTRA_S = 120;

/** The floor of the component deadline: 300 s — FR-26 step 3 (spec.md:376), plan §5.3:705. */
export const APP_ROLLOUT_MIN_S = 300;

/**
 * The ceiling of the component deadline: 2400 s — FR-26 step 3 (spec.md:376),
 * plan §5.3:706. A rollout that reaches it fails as `rollout_timeout`
 * (plan §5.4:766).
 */
export const APP_ROLLOUT_MAX_S = 2_400;

/**
 * How often the rollout predicate is re-read: every 5 s. plan §5.3:707 — the
 * one number in §5.3 no other section restates in prose; §11:1641's 60 s is
 * the budget for a cluster that has stopped answering, not the poll interval.
 */
export const APP_ROLLOUT_POLL_S = 5;

/**
 * A container that has restarted this many times since the Deployment started
 * fails the rollout early with `crash_loop` — FR-27 (spec.md:384), plan §5.4:763.
 * plan §5.3:708.
 */
export const APP_ROLLOUT_RESTARTS_FAIL = 3;

/**
 * How long `ImagePullBackOff` / `ErrImagePull` /
 * `CreateContainerConfigError` / `CreateContainerError` may persist before the
 * rollout fails early — FR-27 (spec.md:385), plan §5.4:764-765. plan §5.3:709.
 */
export const APP_ROLLOUT_STUCK_POD_S = 180;

/**
 * A worker without probes is ready when every replica has run this many seconds
 * without restarting — FR-28 (spec.md:387), plan §5.4:762. plan §5.3:710.
 */
export const APP_WORKER_STABLE_S = 30;

/**
 * The in-cluster smoke window — FR-26 step 5 (spec.md:378): a failure here
 * rolls back, or on a first Deployment fails unpublished. plan §5.3:711.
 */
export const APP_SMOKE_IN_CLUSTER_WINDOW_S = 120;

/**
 * How long the public smoke waits between attempts — tasks.md:413 ("windows
 * 600 s / 180 s, retry every 10 s"), plan §5.3:712. Not restated by an FR; the
 * two windows around it are FR-26 step 7.
 */
export const APP_SMOKE_RETRY_S = 10;

/**
 * The public-smoke and self-address window on the FIRST publish — FR-26 step 7
 * (spec.md:380), plan §5.3:713. Its failure is a warning and never a rollback
 * (FR-37, spec.md:417-422).
 */
export const APP_SMOKE_PUBLIC_FIRST_WINDOW_S = 600;

/** The public-smoke window on every later publish — FR-26 step 7 (spec.md:380), plan §5.3:714. */
export const APP_SMOKE_PUBLIC_WINDOW_S = 180;

/**
 * How much of a response body is searched for `bodyContains` / `bodyNotContains`:
 * the first 1 MiB, as 1 048 576 bytes — FR-36 (spec.md:414), plan §5.3:715.
 */
export const APP_SMOKE_BODY_BYTES = 1_048_576;

/**
 * How many characters of the unexpected string a failure message may quote —
 * FR-37 (spec.md:422, "never response bodies beyond 200 characters") and the
 * runner's `found` truncation (plan §4.8:541). plan §5.3:716.
 */
export const APP_SMOKE_FOUND_CHARS = 200;

/**
 * The publish-domains deadline — FR-26 step 6 (spec.md:379), the same 60 s the
 * `ingress-reconcile` op is bounded by (plan §8.2:1103). plan §5.3:717.
 */
export const APP_PUBLISH_TIMEOUT_S = 60;

/**
 * The whole Deployment's hard limit: 2 hours — FR-29 (spec.md:388-389),
 * Trigger.dev's `maxDuration: 7200` (plan §5.6:838). plan §5.3:718.
 */
export const APP_DEPLOY_MAX_DURATION_S = 7_200;

/**
 * How many env Secrets are kept: the current one plus the two previous — the
 * GC rule of plan §4.7:524-525 ("not referenced by the current or 2 previous
 * ReplicaSets"). plan §5.3:719.
 */
export const APP_ENV_SECRETS_KEPT = 3;

/**
 * Manual rollback is offered on any Live Deployment among the last 20 to the
 * same target — FR-34 (spec.md:401). plan §5.3:720.
 */
export const APP_ROLLBACK_CANDIDATES = 20;

/**
 * How many finished Jobs are kept per job name — plan §4.8:531 ("The last 3
 * Jobs per job name are kept"). plan §5.3:721.
 */
export const APP_JOB_RUNS_KEPT = 3;

/**
 * `ttlSecondsAfterFinished` on every rendered `Job` — plan §4.8:530. plan §5.3:722.
 */
export const APP_JOB_TTL_S = 86_400;

/**
 * The `/tmp` `emptyDir` `sizeLimit` for a read-only component: 256 MiB
 * (spec.md:315, "a private temporary directory of at most 256 MiB"; the §4.4
 * table's `sizeLimit: 256Mi`, plan §4.4:486). plan §5.3:723.
 */
export const APP_TMP_SIZE_MI = 256;

/**
 * Pause scales every component to 0 and suspends scheduled calls within this
 * many seconds — FR-49 (spec.md:489). plan §5.3:724.
 */
export const APP_PAUSE_TIMEOUT_S = 120;

/**
 * Remove-from-cluster deletes its objects within this many seconds — FR-50
 * (spec.md:494-495); the verification destroy waits the same (plan §4.12:644).
 * plan §5.3:725.
 */
export const APP_REMOVE_TIMEOUT_S = 300;

/**
 * Live App Works are polled every 60 s — FR-47 (spec.md:476) — which is also
 * the `app-health-poll` schedule (`cron: '* * * * *'`, plan §9.2:1233).
 * plan §5.3:726.
 */
export const APP_HEALTH_POLL_S = 60;

/**
 * How many runtime states one sweep tick reads: `LIMIT 500` — plan §9.3:1275.
 * plan §5.3:727.
 */
export const APP_HEALTH_BATCH = 500;

/**
 * How long one Work's poll may take: 20 s — plan §9.3:1275. plan §5.3:728.
 */
export const APP_HEALTH_POLL_TIMEOUT_S = 20;

/**
 * How many clusters are polled at once: 5 — plan §9.3:1275 ("5 concurrent per
 * cluster"). plan §5.3:729.
 */
export const APP_HEALTH_CLUSTER_CONCURRENCY = 5;

/**
 * Failing polls before the one "down" notification — FR-47 (spec.md:478),
 * ACC-06-32 (spec.md:771). plan §5.3:730.
 */
export const APP_HEALTH_FAILS_TO_NOTIFY = 5;

/**
 * Passing polls before the recovery notification, which is sent only when a
 * failure notification was — FR-47 (spec.md:479). plan §5.3:731.
 */
export const APP_HEALTH_PASSES_TO_RECOVER = 3;

/**
 * Polls that cannot reach the cluster before the app reads "Can't reach your
 * cluster" and one notification is sent — FR-47 (spec.md:480), S21
 * (spec.md:175), ACC-06-33 (spec.md:772). plan §5.3:732.
 */
export const APP_HEALTH_UNREACHABLE_POLLS = 10;

/**
 * At most one health notification per App Work per 6 hours — FR-47
 * (spec.md:479), ACC-06-32. plan §5.3:733.
 */
export const APP_HEALTH_NOTIFY_DEDUPE_H = 6;

/**
 * A status snapshot older than 180 s is rendered as "Last checked <n> minutes
 * ago" — FR-46 (spec.md:474), ACC-06-31 (spec.md:770). plan §5.3:734.
 */
export const APP_STATUS_STALE_S = 180;

/**
 * Status **Refresh** is allowed once per 15 s — FR-46 (spec.md:475), ACC-06-31.
 * plan §5.3:735.
 */
export const APP_STATUS_REFRESH_MIN_S = 15;

/**
 * A certificate still not valid 30 minutes after publishing produces one
 * notification — FR-43 (spec.md:451). plan §5.3:736.
 */
export const APP_CERT_NOTIFY_AFTER_MIN = 30;

/**
 * Logs show the last 200 lines by default — FR-48 (spec.md:482). plan §5.3:737.
 */
export const APP_LOG_LINES_DEFAULT = 200;

/** Logs may show up to 500 lines on request — FR-48 (spec.md:482). plan §5.3:738. */
export const APP_LOG_LINES_MAX = 500;

/** At most 256 KiB per container, written as bytes — FR-48 (spec.md:483). plan §5.3:739. */
export const APP_LOG_BYTES_MAX = 262_144;

/**
 * A fetched log tail is kept 5 minutes — FR-48 (spec.md:484), the 300 s cache
 * of plan §9.1:1159 (and the 404 after 300 s at §9.1:1200), ACC-06-55
 * (spec.md:794). plan §5.3:740.
 */
export const APP_LOG_CACHE_S = 300;

/**
 * Secret env values of this many characters or more are replaced by their name
 * in logs — FR-48 (spec.md:483). plan §5.3:741.
 */
export const APP_LOG_REDACT_MIN_CHARS = 8;

/**
 * **Check connection** reports within 30 s — FR-6 (spec.md:278), S3
 * (spec.md:106). plan §5.3:742.
 */
export const APP_CLUSTER_CHECK_TIMEOUT_S = 30;

/**
 * The single dial a check or an image-identity resolution makes: 10 s
 * (`/version` in plan §6.3:980, DNS resolution in §6.1:903, the registry HEAD
 * in §5.8:862). plan §5.3:743.
 */
export const APP_CLUSTER_DIAL_TIMEOUT_S = 10;

/**
 * The isolation probe's connect timeout: 3 s, after which the destination is
 * treated as unreachable and isolation as enforced — plan §4.10:569 and its
 * rewrite at §4.10:585-589. plan §5.3:744.
 */
export const APP_ISOLATION_PROBE_TIMEOUT_S = 3;

/**
 * An `ingress-reconcile` op re-applies only the `Ingress` within 60 s —
 * plan §8.2:1103. plan §5.3:745.
 */
export const APP_DOMAIN_RECONCILE_S = 60;

/**
 * `EVER_WORKS_APPS_MAX_PER_USER`'s default: 3 managed App Works per user —
 * plan §8.3:1115, enforced by `ever-works-apps-quota.service.ts` (§9.5:1335-1341).
 * plan §5.3:746.
 */
export const APP_MANAGED_MAX_PER_USER_DEFAULT = 3;

/**
 * On Ever Works Apps a schedule that can fire more often than every 5 minutes
 * is refused with `cron_too_frequent` — plan §4.9:551-552, the "managed
 * 5-minute rule" of §12.1:1666, carried into the render input as
 * `policy.cronMinIntervalMinutes` (§3:241). plan §5.3:747.
 */
export const APP_MANAGED_CRON_MIN_INTERVAL_MIN = 5;

/**
 * A managed subdomain label shorter than 3 characters is refused — plan
 * §8.3:1130. plan §5.3:748.
 */
export const APP_SUBDOMAIN_LABEL_MIN = 3;

/**
 * At most 3 previews per App Work run at once — FR-53 (spec.md:509). plan §5.3:749.
 */
export const APP_PREVIEWS_MAX = 3;

/**
 * A preview is removed within 10 minutes of its pull request closing — FR-53
 * (spec.md:509). plan §5.3:750.
 */
export const APP_PREVIEW_CLOSE_REMOVE_MIN = 10;

/** A preview is removed after 72 hours without a new push — FR-53 (spec.md:510). plan §5.3:751. */
export const APP_PREVIEW_IDLE_H = 72;

/**
 * When a deploy lock is stale and therefore reclaimable: the Deployment's own
 * maximum duration plus 60 s = 7 260 s — plan §7.2:1039 ("stale after 7 260 s
 * (max duration + 60) → reclaimable") and §11:1640.
 *
 * Derived from {@link APP_DEPLOY_MAX_DURATION_S} rather than written as a
 * second literal, so raising the 2-hour cap cannot leave the lock behind it.
 * Stated in plan prose rather than in §5.3's list, and exported here because it
 * is the same contract every reader of the lock needs.
 */
export const APP_DEPLOY_LOCK_STALE_S = APP_DEPLOY_MAX_DURATION_S + 60;

/* ------------------------------------------------------------------------- *
 * The component deadline formula (plan §5.3:754-756)
 * ------------------------------------------------------------------------- */

/** One probe's tolerance: `period × failureThreshold`, seconds (plan §5.3:754-756). */
export interface AppComponentDeadlineProbe {
	/** `startup.periodSeconds` / `readiness.periodSeconds` as rendered. */
	readonly periodSeconds: number;
	/** `startup.failureThreshold` / `readiness.failureThreshold` as rendered. */
	readonly failureThreshold: number;
}

/** The two probe tolerances a component's deadline is computed from. */
export interface AppComponentDeadlineInput {
	readonly startup: AppComponentDeadlineProbe;
	readonly readiness: AppComponentDeadlineProbe;
}

/**
 * One probe tolerance as a finite, non-negative number of seconds.
 *
 * Fails closed: a missing, negative, `NaN` or infinite field contributes 0, so
 * the result can never be `NaN` — a `NaN` deadline that no rollout can satisfy
 * is an unbounded wait, which is the one outcome this formula must not have.
 */
function probeToleranceSeconds(probe: AppComponentDeadlineProbe): number {
	const period = Number.isFinite(probe.periodSeconds) ? Math.max(0, probe.periodSeconds) : 0;
	const threshold = Number.isFinite(probe.failureThreshold) ? Math.max(0, probe.failureThreshold) : 0;
	const tolerance = period * threshold;
	return Number.isFinite(tolerance) ? tolerance : 0;
}

/**
 * The component deadline of plan §5.3:754-756:
 * `clamp(startup.period × startup.failureThreshold + readiness.period ×
 * readiness.failureThreshold + 120, 300, 2400)` seconds.
 *
 * The plan's worked example is the web default with the renderer's startup
 * default — `10 × 60 + 10 × 3 + 120 = 750` — and the clamp is what makes the
 * result always a legal deadline: a tiny tolerance cannot produce a deadline
 * below {@link APP_ROLLOUT_MIN_S}, and an enormous one cannot exceed
 * {@link APP_ROLLOUT_MAX_S}. An unmeasurable field contributes 0 and therefore
 * yields the floor, never an unbounded wait.
 */
export function appComponentDeadlineSeconds(input: AppComponentDeadlineInput): number {
	const total = probeToleranceSeconds(input.startup) + probeToleranceSeconds(input.readiness) + APP_ROLLOUT_EXTRA_S;
	return Math.min(APP_ROLLOUT_MAX_S, Math.max(APP_ROLLOUT_MIN_S, total));
}
