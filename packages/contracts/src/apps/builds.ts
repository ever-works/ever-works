/**
 * Builds — the shared contract for APW-05.
 *
 * Owning epic: **APW-05 (Builds)**. Implements
 * `docs/specs/features/app-works/APW-05-builds/spec.md` and its
 * `plan.md` §3.2 (shared types), §4.1 (`BuildRunRef`), §4.5
 * (`BUILD_SERVICE_DEFAULTS`), §4.9 (failure classifier + excerpt),
 * §4.10 + `verify-plan.schema.json` (`AppVerificationPlan` v1),
 * §5.1 (the deployable verdict), §6.3 of the spec
 * (`APP_BUILD_FAILURE_COPY_EN`), §7.4 (`APP_BUILD_SWEEP_CRON`) and
 * §7.8 (the status → event map).
 *
 * This file is the ONLY declaration of those shapes: `secret-sync.ts`,
 * the failure classifier, the web's failure panel and APW-08's agent
 * hand-off all read them from here, so a rename is a compile error on
 * every side instead of a runtime mismatch nobody watches.
 *
 * Nothing here is persisted, resolved or fetched — it is types,
 * closed unions, spec numbers and the pure decisions the spec states
 * as formulas (the inputs hash, the status → event map, the excerpt
 * rule, the runner-memory fit and the deployable verdict).
 *
 * Boundary note (deliberate): the module imports nothing at all — not
 * even `node:crypto`. `sha256Hex` below is a self-contained SHA-256 so
 * `computeBuildInputsHash` can run unchanged in the API, in the build
 * plugin worker AND in the browser bundle, which is what "the two can
 * never drift" (plan §5.1) requires. Known-answer vectors in
 * `__tests__/builds.spec.ts` pin it.
 */

import type { AppEnvRecipeEntry } from './app-env.js';

/* ------------------------------------------------------------------------- *
 * Closed unions (plan §3.2, lines 417–462)
 * ------------------------------------------------------------------------- */

/**
 * `work_builds.status` (`varchar(16)`, plan §3.1:323).
 *
 * `blocked` is a real stored status and is deliberately NOT an Activity
 * event (plan §7.8:1547) — see {@link APP_BUILD_EVENT_NAMES}.
 */
export const APP_BUILD_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'] as const;

/** `work_builds.status` — plan §3.1:323. */
export type AppBuildStatus = (typeof APP_BUILD_STATUSES)[number];

/** `work_builds.trigger` (`varchar(16)`, plan §3.1:324). */
export const APP_BUILD_TRIGGERS = ['push', 'pull_request', 'manual', 'verification'] as const;

/** `work_builds.trigger` — plan §3.1:324. */
export type AppBuildTrigger = (typeof APP_BUILD_TRIGGERS)[number];

/** The trigger subset that can be deployable at all (plan §5.1:1234). */
export const APP_BUILD_DEPLOYABLE_TRIGGERS = ['push', 'manual'] as const;

/** Triggers whose Builds may be reported deployable — plan §5.1:1234. */
export type AppBuildDeployableTrigger = (typeof APP_BUILD_DEPLOYABLE_TRIGGERS)[number];

/**
 * `work_builds.failureClass` (`varchar(32)`, plan §3.1:338).
 *
 * Fourteen classes, evaluated in the classifier's order (plan §4.9:986–998).
 * Every member has exactly one entry in {@link APP_BUILD_FAILURE_COPY_EN};
 * `egressBlocked` is a Wave-3 (APW-10 builder) class whose copy ships in P1
 * anyway so the list never has a hole (spec §6.3:537–538).
 */
export const APP_BUILD_FAILURE_CLASSES = [
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
] as const;

/** `work_builds.failureClass` — plan §3.2:419–434. */
export type AppBuildFailureClass = (typeof APP_BUILD_FAILURE_CLASSES)[number];

/**
 * `work_builds.blockedReason` (`varchar(40)`, plan §3.1:325).
 *
 * The list is plan §3.2:435–451 (15) **plus** the two members the later
 * sections add and the i18n list already carries (plan §8:1581):
 * `buildServicePortRequired` (plan §4.5:827) and
 * `verificationDependencyUnsupported` (plan §4.10:1056). Two additions,
 * nothing removed — Resolution R-26.
 */
export const APP_BUILD_BLOCKED_REASONS = [
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
	'buildServicePortRequired',
	'verificationDependencyUnsupported'
] as const;

/** `work_builds.blockedReason` — plan §3.2:435–451 + §4.5:827 + §4.10:1056. */
export type AppBuildBlockedReason = (typeof APP_BUILD_BLOCKED_REASONS)[number];

/**
 * `work_builds.notDeployableReason` (`varchar(40)`, plan §3.1:337).
 *
 * The array order IS the verdict order of plan §5.1:1232–1242 — "the first
 * failing clause, in that order, becomes `notDeployableReason`" — and
 * {@link evaluateBuildDeployability} walks it in exactly this order.
 */
export const APP_BUILD_NOT_DEPLOYABLE_REASONS = [
	'notSucceeded',
	'pullRequest',
	'verification',
	'specInvalid',
	'staleInputs',
	'secretCheckFailed',
	'digestUnconfirmed',
	'criticalVulnerability',
	'unsigned'
] as const;

/** `work_builds.notDeployableReason` — plan §3.2:452–462. */
export type AppBuildNotDeployableReason = (typeof APP_BUILD_NOT_DEPLOYABLE_REASONS)[number];

/** `work_builds.cancelReason` (`varchar(16)`, plan §3.1:326). */
export const APP_BUILD_CANCEL_REASONS = ['user', 'superseded'] as const;

/** `work_builds.cancelReason` — plan §3.1:326. */
export type AppBuildCancelReason = (typeof APP_BUILD_CANCEL_REASONS)[number];

/**
 * `work_builds.secretCheck` (`varchar(16)`, plan §3.1:336).
 * `not_needed` covers an App Work with no secret build values (plan §4.11).
 */
export const APP_BUILD_SECRET_CHECK_RESULTS = ['passed', 'failed', 'not_needed'] as const;

/** `work_builds.secretCheck` — plan §3.1:336. */
export type AppBuildSecretCheckResult = (typeof APP_BUILD_SECRET_CHECK_RESULTS)[number];

/** `work_builds.runnerClass` (`varchar(24)`, plan §3.1:334). */
export const APP_BUILD_RUNNER_CLASSES = ['github-public', 'github-private', 'github-larger', 'apps-builder'] as const;

/** `work_builds.runnerClass` — plan §3.1:334. */
export type AppBuildRunnerClass = (typeof APP_BUILD_RUNNER_CLASSES)[number];

/** `work_builds.syncOrigin` (`varchar(24)`, plan §3.1:343; producer APW-04). */
export const APP_BUILD_SYNC_ORIGINS = ['none', 'upstreamSync'] as const;

/** `work_builds.syncOrigin` — plan §3.1:343. */
export type AppBuildSyncOrigin = (typeof APP_BUILD_SYNC_ORIGINS)[number];

/** `work_builds.signatureState` (`varchar(16)`, plan §3.2 P3 / §3.3:553–555). */
export const APP_BUILD_SIGNATURE_STATES = ['signed', 'unsigned', 'foreign'] as const;

/** `work_builds.signatureState` — plan §3.3:553–555. */
export type AppBuildSignatureState = (typeof APP_BUILD_SIGNATURE_STATES)[number];

/** `work_build_preparations.workflowState` (plan §3.1b:398). */
export const APP_BUILD_WORKFLOW_STATES = ['none', 'committed', 'pullRequestOpen', 'editedByHand'] as const;

/** `work_build_preparations.workflowState` — plan §3.1b:398. */
export type AppBuildWorkflowState = (typeof APP_BUILD_WORKFLOW_STATES)[number];

/** What `PrepareRepositoryResult.workflow.state` may be (plan §4.1:626). */
export const APP_BUILD_PREPARE_WORKFLOW_STATES = [
	'unchanged',
	'committed',
	'pullRequestOpened',
	'pullRequestUpdated',
	'editedByHand'
] as const;

/** `PrepareRepositoryResult.workflow.state` — plan §4.1:626. */
export type AppBuildPrepareWorkflowState = (typeof APP_BUILD_PREPARE_WORKFLOW_STATES)[number];

/** `work_build_preparations.webhookState` (plan §3.1b:401, §7.7). */
export const APP_BUILD_WEBHOOK_STATES = ['none', 'installed', 'skipped', 'permissionMissing'] as const;

/** `work_build_preparations.webhookState` — plan §3.1b:401. */
export type AppBuildWebhookState = (typeof APP_BUILD_WEBHOOK_STATES)[number];

/** `build.strategy` (Resolution R-13; plan §3.2:536). */
export const APP_BUILD_STRATEGIES = ['dockerfile', 'image', 'auto', 'none'] as const;

/** `build.strategy` — Resolution R-13 / plan §3.2:536. */
export type AppBuildStrategy = (typeof APP_BUILD_STRATEGIES)[number];

/**
 * `IBuildPlugin.buildKind` (plan §4.1:698, §4.13:1127).
 * `apps-builder` is the Wave-3 in-zone builder, resolvable only while
 * `AppsTierPolicy.isOpen()` and `managedScope() === 'any'`.
 */
export const APP_BUILD_KINDS = ['github-actions', 'apps-builder'] as const;

/** `IBuildPlugin.buildKind` — plan §4.1:698. */
export type AppBuildKind = (typeof APP_BUILD_KINDS)[number];

/**
 * The Activity event names a Build transition publishes (plan §7.8:1540–1547,
 * CONTRACTS §6:516).
 *
 * `blocked` is absent **on purpose**: it is not a CONTRACTS §6 name, so a
 * blocked Build publishes nothing (plan §7.8:1547).
 */
export const APP_BUILD_EVENT_NAMES = [
	'app.build.queued',
	'app.build.started',
	'app.build.succeeded',
	'app.build.failed',
	'app.build.cancelled'
] as const;

/** An Activity event name a Build transition can publish — plan §7.8:1540–1547. */
export type AppBuildEventName = (typeof APP_BUILD_EVENT_NAMES)[number];

/** The `actionType` every `app.build.*` Activity row carries (Resolution R-2). */
export const APP_BUILD_ACTIVITY_ACTION_TYPE = 'app_build' as const;

/* ------------------------------------------------------------------------- *
 * The status → event map (plan §7.8:1538–1547)
 * ------------------------------------------------------------------------- */

/**
 * Explicit status → event map, replacing the older `app.build.<status>`
 * template. `null` means "publish nothing", which is exactly `blocked`.
 */
export const APP_BUILD_STATUS_EVENT_MAP = {
	queued: 'app.build.queued',
	running: 'app.build.started',
	succeeded: 'app.build.succeeded',
	failed: 'app.build.failed',
	cancelled: 'app.build.cancelled',
	blocked: null
} as const satisfies Record<AppBuildStatus, AppBuildEventName | null>;

/**
 * The event a status transition publishes, or `null` for a status that
 * publishes none — plan §7.8:1538–1547.
 *
 * A total map, not a template: adding a status without deciding its event
 * would be a compile error here rather than a silent extra Activity family.
 */
export function appBuildEventNameForStatus(status: AppBuildStatus): AppBuildEventName | null {
	return APP_BUILD_STATUS_EVENT_MAP[status];
}

/* ------------------------------------------------------------------------- *
 * Limits and defaults — every number is plan §3.2:503–541
 * ------------------------------------------------------------------------- */

/** The platform-written workflow path (plan §3.2:503, CONTRACTS §9:615). */
export const APP_BUILD_WORKFLOW_PATH = '.github/workflows/ever-works-build.yml' as const;

/** The pull-request branch workflow changes are offered on (plan §3.2:504, CONTRACTS §9:616). */
export const APP_BUILD_WORKFLOW_BRANCH = 'ever-works/build-workflow' as const;

/** Prefix of every repository Actions secret the platform writes (plan §3.2:505, CONTRACTS §9:617). */
export const APP_BUILD_SECRET_PREFIX = 'EW_' as const;

/** Image name inside the Work Repository's package space (plan §3.2:506, CONTRACTS §9:618). */
export const APP_BUILD_IMAGE_NAME = 'ever-works-app' as const;

/** `inputs=` value in the workflow header; a canonical-input change bumps it (plan §3.2:507, §4.5:796). */
export const APP_BUILD_GENERATOR_VERSION = 1 as const;

/** Maximum build values synced for one Build (plan §3.2:508, §4.7:901). */
export const APP_BUILD_MAX_VALUES = 50 as const;

/** Maximum size of one sealed build value (plan §3.2:509, FR-18). */
export const APP_BUILD_SECRET_MAX_BYTES = 48_000 as const;

/** A secret value shorter than this is skipped by the secret-in-image check (plan §3.2:510, §4.11:1075). */
export const APP_BUILD_SECRET_CHECK_MIN_CHARS = 8 as const;

/** Rebuild dedupe window (FR-41; plan §3.2:511). */
export const APP_BUILD_REBUILD_DEDUPE_MS = 10_000 as const;

/** Rebuilds allowed per App Work per hour (FR-41; plan §3.2:512). */
export const APP_BUILD_REBUILDS_PER_HOUR = 10 as const;

/** Re-prepare within this window after `app.env.changed` (FR-30; plan §3.2:513). */
export const APP_BUILD_ENV_SYNC_SLA_MS = 60_000 as const;

/** Silence after which a non-terminal Build is polled instead of awaited (plan §3.2:514, §7.4). */
export const APP_BUILD_POLL_AFTER_SILENCE_MS = 90_000 as const;

/** Builds one sweep tick looks at (plan §3.2:515, §7.4:1388). */
export const APP_BUILD_SWEEP_BATCH = 200 as const;

/** Window in which a manual dispatch may be adopted by `display_title` (plan §3.2:516, §7.5:1450). */
export const APP_BUILD_ADOPT_WINDOW_MS = 300_000 as const;

/** Grace before a silent Build is failed as `lost` (plan §3.2:517, §7.4:1390). */
export const APP_BUILD_LOST_GRACE_MINUTES = 30 as const;

/** Maximum accepted `ever-works-build-result.json` (plan §3.2:518, §4.8:973). */
export const APP_BUILD_RESULT_MAX_BYTES = 8_192 as const;

/** Logs-tail range read for a failed run (plan §3.2:519, §4.8:979). */
export const APP_BUILD_LOG_TAIL_BYTES = 2_097_152 as const;

/** Excerpt lines kept for the failure panel (plan §3.2:520, §4.9:1000). */
export const APP_BUILD_EXCERPT_MAX_LINES = 20 as const;

/** Characters per excerpt line (plan §3.2:521, §4.9:1000). */
export const APP_BUILD_EXCERPT_MAX_LINE_CHARS = 300 as const;

/** Memory held back from a runner before a declared memory is allowed (plan §3.2:522, §7.2 step 4). */
export const APP_BUILD_RUNNER_HEADROOM_GIB = 2 as const;

/**
 * The runners the platform knows (plan §3.2:523–526).
 *
 * `memoryGiB` is the runner's own total; the usable ceiling is
 * `memoryGiB - APP_BUILD_RUNNER_HEADROOM_GIB` — see
 * {@link appBuildRunnerCapacity}.
 */
export const APP_BUILD_RUNNERS = {
	githubPublic: { label: 'ubuntu-latest', vcpu: 4, memoryGiB: 16, runnerClass: 'github-public' },
	githubPrivate: { label: 'ubuntu-latest', vcpu: 2, memoryGiB: 7, runnerClass: 'github-private' }
} as const;

/** Runner selection key — plan §3.2:523–526. */
export type AppBuildRunnerKey = keyof typeof APP_BUILD_RUNNERS;

/** A known runner's shape — plan §3.2:523–526. */
export type AppBuildRunner = (typeof APP_BUILD_RUNNERS)[AppBuildRunnerKey];

/** Verification window added to the `verify` job only, never to `build` (FR-53; plan §3.2:527, §4.5:805). */
export const APP_BUILD_VERIFY_TIMEOUT_MINUTES = 30 as const;

/** Summed memory ceiling for a verification's components and dependency containers (plan §3.2:528, §4.10:1009). */
export const APP_BUILD_VERIFY_MEMORY_GIB = 12 as const;

/** Base64url form of the verification plan (plan §3.2:529, §4.10:1026). */
export const APP_BUILD_VERIFY_PLAN_MAX_CHARS = 60_000 as const;

/** Days before expiry the owner is warned about a pull token (FR-51; plan §3.2:530). */
export const APP_BUILD_PULL_TOKEN_EXPIRY_WARN_DAYS = 14 as const;

/** Default Builds-list page size (plan §3.2:531, §5:1183). */
export const APP_BUILD_LIST_PAGE_SIZE = 20 as const;

/** Maximum Builds-list page size (plan §3.2:532, §5:1183). */
export const APP_BUILD_LIST_MAX_PAGE_SIZE = 100 as const;

/** The managed (`apps-builder`) plan defaults (plan §3.2:533). */
export const APP_BUILD_MANAGED_DEFAULTS = {
	vcpu: 4,
	memoryGiB: 12,
	diskGiB: 30,
	timeoutMinutes: 60
} as const;

/** Managed plan ceilings (plan §3.2:534, §4.13:1136). */
export const APP_BUILD_MANAGED_MAXIMUMS = { vcpu: 16, memoryGiB: 64, timeoutMinutes: 180 } as const;

/** Managed concurrency caps (plan §3.2:535). */
export const APP_BUILD_MANAGED_CONCURRENCY = { perAppWork: 1, perAccount: 3 } as const;

/** The `checks` matrix job's id (R-9; plan §3.2:537, §4.14). */
export const APP_BUILD_CHECKS_JOB_ID = 'checks' as const;

/**
 * Every check run's name starts with this, so `workflow_run` observation can
 * tell a check job from `build` without a provider call (plan §3.2:538, §4.8:968).
 */
export const APP_BUILD_CHECK_NAME_PREFIX = 'Ever Works check: ' as const;

/** At most this many App spec checks (R-9; plan §3.2:539, §4.14:1144). */
export const APP_BUILD_CHECKS_MAX = 20 as const;

/** `max-parallel` of the checks matrix (R-9; plan §3.2:540). */
export const APP_BUILD_CHECKS_MAX_PARALLEL = 5 as const;

/**
 * The per-verification-run prompted-value secret (plan §3.2:541, §4.10:1019,
 * CONTRACTS §9:619). Reserved: an App spec env name that would map onto it is
 * refused with `buildValueNameReserved` (plan §4.10:1023).
 */
export const APP_BUILD_VERIFY_PROMPTED_SECRET = 'EW_VERIFY__PROMPTED' as const;

/** The build workflow's generated input name carrying the verification plan (plan §4.10:1017). */
export const APP_BUILD_VERIFY_PLAN_INPUT = 'ew_verify_plan' as const;

/** The result artifact's name (CONTRACTS §9:620; plan §4.8:972). */
export const APP_BUILD_RESULT_ARTIFACT_NAME = 'ever-works-build-result' as const;

/** File name inside the result artifact (CONTRACTS §9:620). */
export const APP_BUILD_RESULT_ARTIFACT_FILE = 'ever-works-build-result.json' as const;

/** Artifact retention in days (CONTRACTS §9:620). */
export const APP_BUILD_RESULT_ARTIFACT_RETENTION_DAYS = 7 as const;

/** Branch slugs are trimmed to this length (plan §4.5:809). */
export const APP_BUILD_BRANCH_SLUG_MAX_CHARS = 100 as const;

/** The workflow's disk-reclaim setting key (plan §4.4:779). */
export const APP_BUILD_SETTING_RECLAIM_DISK = 'reclaimDisk' as const;

/** The workflow's attestations setting key — public repositories only (plan §4.4:780). */
export const APP_BUILD_SETTING_ATTESTATIONS = 'attestations' as const;

/** The Work-scope opt-out that re-widens pull-request build values (XC-01; plan §4.7b:942). */
export const APP_BUILD_SETTING_ALLOW_VALUES_ON_PULL_REQUESTS = 'allowBuildValuesOnPullRequests' as const;

/** The Work-scope check on verification prompted values (XC-01; plan §4.7b:948). */
export const APP_BUILD_SETTING_VERIFICATION_PROMPTED_REQUIRES_APPROVAL =
	'verificationPromptedValuesRequireApproval' as const;

/**
 * The one literal a pull-request run receives instead of a stored value
 * (XC-01; plan §4.7b:928). Non-secret by construction and fixed, so a build
 * script can still tell "absent" from "present" (plan §4.7b:937–939).
 */
export const APP_BUILD_RESTRICTED_VALUE_LITERAL = 'ew-restricted' as const;

/** The `workflow_run` delivery event the platform consumes (plan §7.5:1437). */
export const APP_BUILD_WEBHOOK_EVENT = 'workflow_run' as const;

/* ------------------------------------------------------------------------- *
 * The sweep cron (plan §7.4:1399)
 * ------------------------------------------------------------------------- */

/**
 * The `app-build-sweep` schedule, shared by the Trigger.dev task and the
 * in-process `AppBuildSweepCronService` so the two can never drift
 * (plan §7.4:1399–1400).
 */
export const APP_BUILD_SWEEP_CRON = '*/2 * * * *' as const;

/* ------------------------------------------------------------------------- *
 * BUILD_SERVICE_DEFAULTS (plan §4.5:810–832)
 * ------------------------------------------------------------------------- */

/** Build services are reached on the runner's own loopback because the build uses `network: host` (plan §4.5:824). */
export const BUILD_SERVICE_HOST = '127.0.0.1' as const;

/**
 * How a recognised build service's health is awaited (plan §4.5:818–821, 831–833).
 *
 * `waitLoop` is the fallback for an unrecognised image: a 60-second wait loop
 * step on the declared port, with no `sleep` (plan §4.5:832).
 */
export const BUILD_SERVICE_HEALTH_KINDS = { command: 'command', http: 'http', waitLoop: 'waitLoop' } as const;

/**
 * The non-secret, throwaway defaults a build service starts with, keyed by the
 * service kind APW-07's `build.services[]` mapping uses (plan §4.6.2:453–454).
 *
 * The official `postgres` image refuses to start without a password or a trust
 * setting, so a bare `services: [{ name: postgres, image: 'postgres:16' }]`
 * cannot work (plan §4.5:810–812). These defaults are non-secret by
 * construction and are excluded from `EW_SECRET_NAMES` (plan §4.5:829,
 * §4.11:1081–1082).
 *
 * `smtp` carries `imagePrefixes: []` **because the spec names that row by
 * description, not by image prefix** ("the SMTP test image APW-07's `smtp`
 * mapping assumes", plan §4.5:821): APW-07 pins the mapping by service NAME
 * (`smtp` ↔ dependency kind `smtp`, plan §4.6.2:454), so the row is selected by
 * name and no image prefix is invented here.
 */
export const BUILD_SERVICE_DEFAULTS = {
	postgres: {
		imagePrefixes: ['postgres'],
		env: { POSTGRES_USER: 'ever-works-build', POSTGRES_PASSWORD: 'ever-works-build', POSTGRES_DB: 'app' },
		containerPort: 5432,
		health: { kind: 'command', command: 'pg_isready -U <user> -d <db>' }
	},
	redis: {
		imagePrefixes: ['redis'],
		env: {},
		containerPort: 6379,
		health: { kind: 'command', command: 'redis-cli ping' }
	},
	minio: {
		imagePrefixes: ['minio'],
		env: { MINIO_ROOT_USER: 'ever-works-build', MINIO_ROOT_PASSWORD: 'ever-works-build' },
		containerPort: 9000,
		health: { kind: 'http', path: '/minio/health/live' }
	},
	smtp: {
		imagePrefixes: [],
		env: {},
		containerPort: 1025,
		health: { kind: 'waitLoop', seconds: 60 }
	}
} as const;

/** Service kind of a build service — plan §4.6.2:453–454. */
export type BuildServiceKind = keyof typeof BUILD_SERVICE_DEFAULTS;

/** The defaults one build-service kind starts with — plan §4.5:816–821. */
export type BuildServiceDefaults = (typeof BUILD_SERVICE_DEFAULTS)[BuildServiceKind];

/** The recognised build-service kinds, in plan §4.5's table order. */
export const BUILD_SERVICE_KINDS = ['postgres', 'redis', 'minio', 'smtp'] as const;

/**
 * The defaults for an image, matched by the plan's `postgres*` / `redis*` /
 * `minio*` prefix rule (plan §4.5:816–821); `null` when the image is
 * unrecognised, which is what makes `port` mandatory (plan §4.5:825–827).
 */
export function resolveBuildServiceKind(image: string): BuildServiceKind | null {
	for (const kind of BUILD_SERVICE_KINDS) {
		const prefixes: readonly string[] = BUILD_SERVICE_DEFAULTS[kind].imagePrefixes;
		for (const prefix of prefixes) {
			if (image.startsWith(prefix)) return kind;
		}
	}
	return null;
}

/**
 * Merge a declared service `env` over the defaults — "a declared `env` entry
 * replaces only the default of the **same name** (declared wins per variable,
 * every other default still applies)" (plan §4.5:823).
 */
export function resolveBuildServiceEnv(
	kind: BuildServiceKind,
	declared?: readonly { readonly name: string; readonly value: string }[]
): Record<string, string> {
	const merged: Record<string, string> = { ...BUILD_SERVICE_DEFAULTS[kind].env };
	for (const entry of declared ?? []) {
		merged[entry.name] = entry.value;
	}
	return merged;
}

/**
 * The published port of a build service, as the plan's `"<published>:<container
 * port>"` pair (plan §4.5:824–825).
 *
 * Returns `null` when the image is unrecognised **and** no `port` was declared
 * — the case §4.5:825–827 turns into
 * `blocked { reason: 'buildServicePortRequired', detail: { service } }`.
 */
export function resolveBuildServicePort(image: string, declaredPort?: number): string | null {
	const kind = resolveBuildServiceKind(image);
	if (kind === null) {
		return declaredPort === undefined ? null : `${declaredPort}:${declaredPort}`;
	}
	return `${declaredPort ?? BUILD_SERVICE_DEFAULTS[kind].containerPort}:${BUILD_SERVICE_DEFAULTS[kind].containerPort}`;
}

/**
 * Fail-closed variant of {@link resolveBuildServicePort}: a build service whose
 * port cannot be determined blocks the Build instead of being emitted without
 * one (plan §4.5:825–827).
 */
export function evaluateBuildServicePort(service: {
	readonly name: string;
	readonly image: string;
	readonly port?: number;
}):
	| { readonly ok: true; readonly published: string }
	| { readonly ok: false; readonly blockedReason: 'buildServicePortRequired' } {
	const published = resolveBuildServicePort(service.image, service.port);
	return published === null ? { ok: false, blockedReason: 'buildServicePortRequired' } : { ok: true, published };
}

/* ------------------------------------------------------------------------- *
 * Runner fit (plan §7.2 step 4, FR-23)
 * ------------------------------------------------------------------------- */

/**
 * A runner's usable capacity: the declared memory may not exceed the runner's
 * own memory minus {@link APP_BUILD_RUNNER_HEADROOM_GIB} (plan §7.2:1330–1332).
 */
export function appBuildRunnerCapacity(runner: AppBuildRunner): {
	readonly vcpu: number;
	readonly memoryGiB: number;
} {
	return { vcpu: runner.vcpu, memoryGiB: runner.memoryGiB - APP_BUILD_RUNNER_HEADROOM_GIB };
}

/**
 * Does the declared memory fit this runner?
 *
 * An **absent** `build.resources.memory` means "the runner's own maximum" and
 * never blocks a Build — `APW05-G14` / FR-23 (plan §7.2:1331–1332). A declared
 * memory above the ceiling blocks with `runnerTooSmall` (plan §7.2:1330).
 * The comparison is inclusive at the limit: `memoryGiB === capacity` fits.
 */
export function evaluateBuildRunnerFit(
	runner: AppBuildRunner,
	declaredMemoryGiB?: number
):
	| { readonly fits: true }
	| { readonly fits: false; readonly blockedReason: 'runnerTooSmall'; readonly maxMemoryGiB: number } {
	const capacity = appBuildRunnerCapacity(runner);
	if (declaredMemoryGiB === undefined || declaredMemoryGiB <= capacity.memoryGiB) return { fits: true };
	return { fits: false, blockedReason: 'runnerTooSmall', maxMemoryGiB: capacity.memoryGiB };
}

/* ------------------------------------------------------------------------- *
 * Check-run naming (plan §4.14:1150–1151)
 * ------------------------------------------------------------------------- */

/** The exact check-run name for an App spec check (plan §4.14:1151). */
export function appBuildCheckName(name: string): string {
	return `${APP_BUILD_CHECK_NAME_PREFIX}${name}`;
}

/** True for a job name produced by {@link appBuildCheckName} (plan §4.8:968–970). */
export function isAppBuildCheckJobName(jobName: string): boolean {
	return jobName.startsWith(APP_BUILD_CHECK_NAME_PREFIX);
}

/* ------------------------------------------------------------------------- *
 * SHA-256 and the build inputs hash (plan §4.5:799, §4.7:905, §5.1:1244)
 * ------------------------------------------------------------------------- */

/** SHA-256 round constants (FIPS 180-4 §4.2.2). */
const SHA256_ROUND_CONSTANTS: readonly number[] = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2
];

/** SHA-256 initial hash values (FIPS 180-4 §5.3.3). */
const SHA256_INITIAL_HASH: readonly number[] = [
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];

/** 32-bit rotate-right. */
function rotateRight32(value: number, bits: number): number {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** Hex-encode the eight 32-bit hash words, lower case, exactly 8 digits each. */
function toHexWords(words: readonly number[]): string {
	let hex = '';
	for (const word of words) hex += word.toString(16).padStart(8, '0');
	return hex;
}

/**
 * SHA-256 of a UTF-8 string, lower-case hex, as a self-contained implementation.
 *
 * Declared here rather than imported from `node:crypto` so this module stays a
 * zero-import contract file: the API, the build plugin's worker and the browser
 * bundle all compute the SAME digest from the SAME bytes (plan §5.1:1244–1247,
 * "so the two can never drift"). Known-answer vectors for the empty string and
 * `abc` are pinned in `__tests__/builds.spec.ts`.
 */
export function sha256Hex(text: string): string {
	const message = new TextEncoder().encode(text);
	const bitLength = message.length * 8;
	const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(message);
	padded[message.length] = 0x80;
	const high = Math.floor(bitLength / 0x1_0000_0000);
	const low = bitLength >>> 0;
	padded[paddedLength - 8] = (high >>> 24) & 0xff;
	padded[paddedLength - 7] = (high >>> 16) & 0xff;
	padded[paddedLength - 6] = (high >>> 8) & 0xff;
	padded[paddedLength - 5] = high & 0xff;
	padded[paddedLength - 4] = (low >>> 24) & 0xff;
	padded[paddedLength - 3] = (low >>> 16) & 0xff;
	padded[paddedLength - 2] = (low >>> 8) & 0xff;
	padded[paddedLength - 1] = low & 0xff;

	const schedule = new Uint32Array(64);
	const hash = new Uint32Array(SHA256_INITIAL_HASH);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index += 1) {
			const at = offset + index * 4;
			schedule[index] =
				((padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3]) >>> 0;
		}
		for (let index = 16; index < 64; index += 1) {
			const w15 = schedule[index - 15];
			const w2 = schedule[index - 2];
			const sigma0 = (rotateRight32(w15, 7) ^ rotateRight32(w15, 18) ^ (w15 >>> 3)) >>> 0;
			const sigma1 = (rotateRight32(w2, 17) ^ rotateRight32(w2, 19) ^ (w2 >>> 10)) >>> 0;
			schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
		}
		let a = hash[0];
		let b = hash[1];
		let c = hash[2];
		let d = hash[3];
		let e = hash[4];
		let f = hash[5];
		let g = hash[6];
		let h = hash[7];
		for (let index = 0; index < 64; index += 1) {
			const sum1 = (rotateRight32(e, 6) ^ rotateRight32(e, 11) ^ rotateRight32(e, 25)) >>> 0;
			const choose = ((e & f) ^ (~e & g)) >>> 0;
			const temp1 = (h + sum1 + choose + SHA256_ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
			const sum0 = (rotateRight32(a, 2) ^ rotateRight32(a, 13) ^ rotateRight32(a, 22)) >>> 0;
			const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
			const temp2 = (sum0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}
		hash[0] = (hash[0] + a) >>> 0;
		hash[1] = (hash[1] + b) >>> 0;
		hash[2] = (hash[2] + c) >>> 0;
		hash[3] = (hash[3] + d) >>> 0;
		hash[4] = (hash[4] + e) >>> 0;
		hash[5] = (hash[5] + f) >>> 0;
		hash[6] = (hash[6] + g) >>> 0;
		hash[7] = (hash[7] + h) >>> 0;
	}
	return toHexWords([hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]]);
}

/**
 * One synced build value's contribution to the inputs hash.
 *
 * `fingerprint` is APW-07's stored-value `version` (`v<n>`) for stored values
 * and `sha256(value)` only for non-secret or build-service values — **no hash
 * of a stored secret is ever persisted** (plan §4.7:905–906).
 */
export interface AppBuildValueFingerprint {
	/** The env name as synced, e.g. `DATABASE_URL`. */
	readonly name: string;
	/** `v<n>` for a stored value, `sha256(value)` for a non-secret / build-service value. */
	readonly fingerprint: string;
}

/**
 * `buildInputsHash` over the synced build values (plan §4.7:905, §5.1:1244).
 *
 * `secret-sync.ts` (APW-05) and the deployable verdict (APW-05 §5.1) both call
 * THIS function, so the hash a Build recorded and the hash the platform
 * recomputes at finalisation cannot drift.
 *
 * Canonical form (this module's contract — the plan states "sha256 over
 * (name, fingerprint)" without fixing a byte encoding, so it is fixed once,
 * here): entries are sorted by name then fingerprint; each entry renders as
 * `name` + U+0000 + `fingerprint`; entries are joined with U+0001; the result
 * is UTF-8 encoded and hashed. The empty value list therefore hashes to
 * `sha256("")` — the value a preparation that synced zero values records
 * (plan §5.1:1250–1252).
 *
 * Sorting makes the hash independent of the resolver's iteration order, and the
 * two separators cannot occur inside an env name (APW-07's
 * `^[A-Z_][A-Z0-9_]{0,127}$`) or inside any fingerprint this program produces
 * (`v<n>`, `d<n>`, `t<hex>`, `sha256(value)`), which is what makes the encoding
 * injective. A caller that hands in a name or fingerprint containing either
 * separator is a programming error and is refused loudly rather than silently
 * hashed into a collision.
 */
export function computeBuildInputsHash(values: readonly AppBuildValueFingerprint[]): string {
	for (const value of values) {
		if (value.name.includes('\u0000') || value.name.includes('\u0001')) {
			throw new Error('computeBuildInputsHash: an env name may not contain U+0000 or U+0001');
		}
		if (value.fingerprint.includes('\u0000') || value.fingerprint.includes('\u0001')) {
			throw new Error('computeBuildInputsHash: a fingerprint may not contain U+0000 or U+0001');
		}
	}
	const canonical = values
		.map((value) => [value.name, value.fingerprint] as const)
		.sort((left, right) => {
			if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
			if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
			return 0;
		})
		.map(([name, fingerprint]) => `${name}\u0000${fingerprint}`)
		.join('\u0001');
	return sha256Hex(canonical);
}

/* ------------------------------------------------------------------------- *
 * The failure excerpt (plan §4.9:1000–1002)
 * ------------------------------------------------------------------------- */

/**
 * The excerpt a failure panel and the agent hand-off receive: the last
 * {@link APP_BUILD_EXCERPT_MAX_LINES} lines ending at the matched line, each
 * cut to {@link APP_BUILD_EXCERPT_MAX_LINE_CHARS} characters.
 *
 * Callers must pass lines that have ALREADY been through APW-07's `redact` and
 * the platform secret-pattern screen (plan §4.9:1000–1002) — this function
 * shapes the excerpt, it does not sanitise it.
 */
export function buildFailureExcerpt(lines: readonly string[], endAtLine?: number): string[] {
	const end = endAtLine === undefined ? lines.length : Math.min(endAtLine + 1, lines.length);
	const start = Math.max(0, end - APP_BUILD_EXCERPT_MAX_LINES);
	return lines.slice(start, end).map((line) => line.slice(0, APP_BUILD_EXCERPT_MAX_LINE_CHARS));
}

/* ------------------------------------------------------------------------- *
 * The deployable verdict (plan §5.1:1230–1252)
 * ------------------------------------------------------------------------- */

/** Vulnerability counts a Wave-3 Build records (plan §3.3:554). */
export interface AppBuildScanSummary {
	readonly critical: number;
	readonly high: number;
	readonly medium: number;
	readonly low: number;
	readonly fixableCritical: number;
}

/** The verifier fields of the verdict; all but `buildKind` come from the Build row. */
export interface AppBuildDeployabilityInput {
	/** `work_builds.status` — plan §5.1:1233. */
	readonly status: AppBuildStatus;
	/** `work_builds.trigger` — plan §5.1:1234. */
	readonly trigger: AppBuildTrigger;
	/** `work_builds.branch` — plan §5.1:1234. */
	readonly branch: string;
	/** The App Work's tracked branch — plan §5.1:1234. */
	readonly trackedBranch: string;
	/** `specValidAtCommit`; `null` counts as not valid — plan §5.1:1235. */
	readonly specValidAtCommit: boolean | null;
	/** `secretsSyncedAt` in epoch ms; `null` is `staleInputs` — plan §5.1:1236, 1247. */
	readonly secretsSyncedAtEpochMs: number | null;
	/** `startedAt` in epoch ms; the sync must not be later than it — plan §5.1:1236. */
	readonly startedAtEpochMs: number | null;
	/** `buildInputsHash`; `null` is `staleInputs` — plan §5.1:1236, 1247. */
	readonly buildInputsHash: string | null;
	/** `computeBuildInputsHash` over the resolver's current fingerprints — plan §5.1:1244–1247. */
	readonly currentInputsHash: string;
	/** `secretCheck` — plan §5.1:1237. */
	readonly secretCheck: AppBuildSecretCheckResult | null;
	/** `digestConfirmed` — plan §5.1:1238. */
	readonly digestConfirmed: boolean;
	/** The resolved build plugin's kind — plan §5.1:1239. */
	readonly buildKind: AppBuildKind;
	/** `signatureState`; only `signed` passes for the managed builder — plan §5.1:1239. */
	readonly signatureState: AppBuildSignatureState | null;
	/** `scanSummary`; `null` counts as no fixable critical — plan §5.1:1239. */
	readonly scan: AppBuildScanSummary | null;
	/** The tier's policy for blocking fixable criticals — plan §5.1:1239. */
	readonly policy: { readonly blockFixableCritical: boolean };
}

/**
 * The deployable verdict, clause by clause, in the plan's order — "the first
 * failing clause, in that order, becomes `notDeployableReason`"
 * (plan §5.1:1242).
 *
 * Note the deliberate split of clause 2: a `verification` trigger fails with
 * `verification` (FR-54) and every other non-deployable trigger — i.e. a
 * pull-request run — fails with `pullRequest`.
 */
export function evaluateBuildDeployability(
	input: AppBuildDeployabilityInput
):
	| { readonly deployable: true; readonly notDeployableReason: null }
	| { readonly deployable: false; readonly notDeployableReason: AppBuildNotDeployableReason } {
	const notDeployable = (reason: AppBuildNotDeployableReason) =>
		({ deployable: false, notDeployableReason: reason }) as const;

	if (input.status !== 'succeeded') return notDeployable('notSucceeded');
	if (input.trigger === 'verification') return notDeployable('verification');
	if (input.trigger !== 'push' && input.trigger !== 'manual') return notDeployable('pullRequest');
	if (input.branch !== input.trackedBranch) return notDeployable('pullRequest');
	if (input.specValidAtCommit !== true) return notDeployable('specInvalid');
	// A NULL hash or sync stamp is `staleInputs`, and a value rotated while the
	// Build runs (sync AFTER start) is too — plan §5.1:1247–1250.
	if (input.secretsSyncedAtEpochMs === null || input.startedAtEpochMs === null) return notDeployable('staleInputs');
	if (input.secretsSyncedAtEpochMs > input.startedAtEpochMs) return notDeployable('staleInputs');
	if (input.buildInputsHash === null || input.buildInputsHash !== input.currentInputsHash) {
		return notDeployable('staleInputs');
	}
	if (input.secretCheck !== 'passed' && input.secretCheck !== 'not_needed') return notDeployable('secretCheckFailed');
	if (!input.digestConfirmed) return notDeployable('digestUnconfirmed');
	if (input.buildKind === 'apps-builder') {
		if (input.signatureState !== 'signed') return notDeployable('unsigned');
		if (input.policy.blockFixableCritical && (input.scan?.fixableCritical ?? 0) > 0) {
			return notDeployable('criticalVulnerability');
		}
	}
	return { deployable: true, notDeployableReason: null };
}

/* ------------------------------------------------------------------------- *
 * API-facing views (plan §3.2:464–501)
 * ------------------------------------------------------------------------- */

/** `AppBuildSummary` — the Builds list row (plan §3.2:464–485). */
export interface AppBuildSummary {
	id: string;
	number: number;
	status: AppBuildStatus;
	trigger: AppBuildTrigger;
	branch: string;
	commitSha: string;
	pullRequestNumber: number | null;
	blockedReason: AppBuildBlockedReason | null;
	/** Names and numbers only, ≤ 2 KB — never a value (plan §3.1:325). */
	blockedDetail: Record<string, string | number | string[]> | null;
	deployable: boolean;
	notDeployableReason: AppBuildNotDeployableReason | null;
	imageRepository: string | null;
	imageDigest: string | null;
	imageTags: string[];
	failureClass: AppBuildFailureClass | null;
	queuedAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	durationSeconds: number | null;
	logsUrl: string | null;
}

/** `AppBuildDetail.receipt` — the plugin usage receipt, never a raw artifact (plan §5:1191). */
export interface AppBuildReceipt {
	billableMinutes: number | null;
	/** Includes {@link AppBuildReceipt.checksBillableMinutes} (R-9; plan §3.1:347). */
	checksBillableMinutes: number | null;
	payer: 'workspace' | 'platform';
	costKnown: boolean;
}

/** `AppBuildDetail` — the drawer (plan §3.2:486–501). */
export interface AppBuildDetail extends AppBuildSummary {
	runnerClass: AppBuildRunnerClass | null;
	runnerLabel: string | null;
	buildValueNames: string[];
	/** Names and numbers only: `{ step?, total?, command?, names?, memory?, max? }` (plan §3.1:339). */
	failureDetail: Record<string, unknown> | null;
	failureExcerpt: string[];
	verificationResult: AppBuildVerificationResult | null;
	receipt: AppBuildReceipt | null;
	triggeredBy: { userId: string; name: string } | null;
	canEdit: boolean;
}

/**
 * `AppBuildEventPayload` — the shared readonly payload of every
 * `app.build.*` event (plan §7.8:1516–1531).
 *
 * Names and ids only: never a value, an excerpt, a logs-URL token or
 * `blockedDetail` (plan §7.8:1534).
 */
export interface AppBuildEventPayload {
	readonly workId: string;
	/** The App Work owner. */
	readonly userId: string;
	readonly buildId: string;
	readonly number: number;
	readonly status: AppBuildStatus;
	readonly trigger: AppBuildTrigger;
	readonly branch: string;
	readonly commitSha: string;
	readonly pullRequestNumber: number | null;
	/** Final only on `app.build.succeeded`; `false` on every other event (plan §7.8:1535–1536). */
	readonly deployable: boolean;
	/** Final only on `app.build.succeeded`; `null` on every other event (plan §7.8:1535–1536). */
	readonly notDeployableReason: AppBuildNotDeployableReason | null;
	readonly imageDigest: string | null;
	readonly failureClass: AppBuildFailureClass | null;
	readonly cancelReason: AppBuildCancelReason | null;
}

/** One run of the build workflow as the provider reports it (plan §4.1:685–696). */
export interface BuildRunRef {
	readonly providerRunId: string;
	readonly runAttempt: number;
	readonly event: string;
	readonly status: string;
	readonly headSha: string;
	readonly headBranch: string;
	readonly headRepositoryFullName: string;
	readonly pullRequestNumber?: number;
	readonly displayTitle: string;
	readonly createdAt: string;
}

/** Where a run was found — the two intake paths share one accept rule set (plan §7.5:1445–1452). */
export const APP_BUILD_RUN_SOURCES = ['event', 'poll'] as const;

/** Run intake source — plan §7.5:1445. */
export type AppBuildRunSource = (typeof APP_BUILD_RUN_SOURCES)[number];

/** `listRecentRuns`'s `per_page` ceiling (plan §4.1:715, §7.4a). */
export const APP_BUILD_RUN_DISCOVERY_PER_PAGE = 20 as const;

/** App Works one discovery pass covers (plan §7.4a:1414). */
export const APP_BUILD_RUN_DISCOVERY_BATCH = 100 as const;

/* ------------------------------------------------------------------------- *
 * The failure hand-off to agents (plan §5:1220–1228, FR-39, ACC-05-19)
 * ------------------------------------------------------------------------- */

/** One failure class's English copy, with ICU-style `{param}` placeholders. */
export interface AppBuildFailureCopyEntry {
	readonly title: string;
	readonly suggestion: string;
}

/**
 * The English title and suggestion per class — spec §6.3:520–535, verbatim.
 *
 * The single source: `apps/web/messages/en.json`'s
 * `dashboard.workDetail.builds.failure.<class>.{title,suggestion}` leaves must
 * equal these strings (a parity test fails when they drift, plan §5:1217–1218),
 * and `AppBuildFailureCopy.forAgent` renders them into
 * {@link AppBuildFailureHandoff}.
 *
 * Typed as a total `Record`, so adding a class to
 * {@link APP_BUILD_FAILURE_CLASSES} without copy for it is a compile error as
 * well as a test failure.
 */
export const APP_BUILD_FAILURE_COPY_EN = {
	outOfMemory: {
		title: 'Ran out of memory',
		suggestion:
			"Raise build.resources.memory (now {memory}) or lower the build's heap size. On this runner a build can use at most {max}."
	},
	diskFull: {
		title: 'Ran out of disk space',
		suggestion:
			'Turn on "Reclaim runner disk" in build settings, or shrink the build context with a .dockerignore file.'
	},
	dockerfileError: {
		title: 'The Dockerfile failed at step {step} of {total}',
		suggestion: 'The failing step was: {command}. Fix it in {dockerfile} and push, or ask an agent to fix it.'
	},
	dependencyDownloadFailed: {
		title: "Couldn't download dependencies",
		suggestion:
			"A package or base image registry didn't answer. Rebuild in a few minutes; if it keeps failing, pin the versions you depend on."
	},
	registryPushDenied: {
		title: "Couldn't push the image",
		suggestion:
			'Allow workflows in this repository to write packages (Settings ▸ Actions ▸ General ▸ Workflow permissions), then rebuild.'
	},
	missingBuildValue: {
		title: 'A build value is missing: {names}',
		suggestion: 'Set it in Settings ▸ Environment, then rebuild.'
	},
	secretInImage: {
		title: 'A secret would have been published inside the image: {name}',
		suggestion:
			'Use this value only in an earlier build stage, or pass it as a build secret mount. Nothing was pushed.'
	},
	timeout: {
		title: 'Took longer than {minutes} minutes',
		suggestion: 'Raise build.resources.timeoutMinutes (maximum 180) or speed the build up with caching.'
	},
	workflowInvalid: {
		title: 'The workflow file is invalid',
		suggestion: "GitHub can't run the build workflow. Review the open pull request from Ever Works to restore it."
	},
	digestMismatch: {
		title: 'The pushed image could not be confirmed',
		suggestion:
			'The registry reported a different image than the build did. Rebuild; nothing unconfirmed will be deployed.'
	},
	verificationFailed: {
		title: "The app didn't pass its smoke tests",
		suggestion: '{failed} of {total} smoke tests failed. See the results below.'
	},
	egressBlocked: {
		title: 'Network access was blocked',
		suggestion:
			"The build tried to reach {hosts}, which aren't on the builder's allowed list. Get what you need from your source repository or an allowed registry, then rebuild."
	},
	lost: {
		title: 'Lost track of this build',
		suggestion: 'GitHub stopped answering about this build. Check it on GitHub.'
	},
	unknown: {
		title: 'Something else went wrong',
		suggestion: 'Open the logs on GitHub, or ask an agent to look.'
	}
} as const satisfies Record<AppBuildFailureClass, AppBuildFailureCopyEntry>;

/** The action a blocked Build offers — spec §6.4:547–573, i18n leaves plan §8:1582. */
export const APP_BUILD_BLOCKED_ACTIONS = [
	'reviewPullRequest',
	'turnOnActions',
	'setValue',
	'useLargerRunner',
	'openRepositorySettings',
	'reconnectGithub',
	'rebuild',
	'openEnvironment'
] as const;

/** A blocked Build's action — plan §8:1582. */
export type AppBuildBlockedAction = (typeof APP_BUILD_BLOCKED_ACTIONS)[number];

/**
 * Every blocked reason's action, or `null` where the notice has no action
 * (spec §6.4:547–573, "Every blocked reason has its own copy and its own
 * action").
 *
 * A total `Record`: a new reason without a decided action is a compile error.
 */
export const APP_BUILD_BLOCKED_REASON_ACTIONS = {
	workflowPending: 'reviewPullRequest',
	workflowEditedByHand: 'reviewPullRequest',
	workflowWriteFailed: 'rebuild',
	actionsDisabled: 'turnOnActions',
	missingBuildValues: 'setValue',
	runnerTooSmall: 'useLargerRunner',
	tooManyBuildValues: 'openEnvironment',
	buildValueTooLarge: 'openEnvironment',
	buildServicePortRequired: 'openEnvironment',
	verificationDependencyUnsupported: null,
	strategyNotSupported: null,
	specInvalid: null,
	repositoryUnavailable: null,
	managedConcurrencyLimit: null,
	buildValueNameReserved: 'openEnvironment',
	secretLimitReached: 'openRepositorySettings',
	gitConnectionMissing: 'reconnectGithub'
} as const satisfies Record<AppBuildBlockedReason, AppBuildBlockedAction | null>;

/**
 * The payload APW-08's delivery follow-up hands to a Task's agent
 * (plan §5:1220–1222, `APW05-G12`).
 *
 * `excerpt` is already redacted by APW-07's redactor (≤ 20 lines × ≤ 300
 * characters) and `untrusted` is the literal `true`: no consumer ever fetches
 * or re-redacts build logs itself (FR-38).
 */
export interface AppBuildFailureHandoff {
	readonly class: AppBuildFailureClass;
	readonly title: string;
	readonly suggestion: string;
	readonly excerpt: string[];
	readonly logsUrl: string | null;
	readonly untrusted: true;
}

/* ------------------------------------------------------------------------- *
 * AppVerificationPlan v1 (plan §4.10:1036–1065, verify-plan.schema.json)
 * ------------------------------------------------------------------------- */

/** Plan schema version — `version: { const: 1 }` (verify-plan.schema.json:10). */
export const APP_VERIFICATION_PLAN_VERSION = 1 as const;

/** `components` entries allowed — verify-plan.schema.json:14. */
export const APP_BUILD_VERIFY_PLAN_MAX_COMPONENTS = 10 as const;

/** `dependencies` entries allowed — verify-plan.schema.json:19. */
export const APP_BUILD_VERIFY_PLAN_MAX_DEPENDENCIES = 3 as const;

/** `jobs` entries allowed — plan §4.10:1047, verify-plan.schema.json:24. */
export const APP_BUILD_VERIFY_PLAN_MAX_JOBS = 10 as const;

/**
 * `smoke` entries allowed in the PLAN — plan §4.10:1048 and
 * verify-plan.schema.json:30 (both say 20).
 *
 * `plan.md:341` sizes the stored `verificationResult` column at "smoke[] ≤ 50";
 * that is the storage note for the column, not the plan input, so the two are
 * declared separately rather than one being guessed from the other — see
 * {@link APP_BUILD_VERIFICATION_RESULT_MAX_SMOKE}.
 */
export const APP_BUILD_VERIFY_PLAN_MAX_SMOKE = 20 as const;

/** `env` entries allowed — verify-plan.schema.json:34. */
export const APP_BUILD_VERIFY_PLAN_MAX_ENV_ENTRIES = 100 as const;

/** Stored `verificationResult.smoke[]` cap — plan §3.1:341. */
export const APP_BUILD_VERIFICATION_RESULT_MAX_SMOKE = 50 as const;

/** The two job phases a verification plan's `jobs[]` may use — plan §4.10:1047. */
export const APP_VERIFICATION_JOB_PHASES = ['pre-deploy', 'first-deploy'] as const;

/** A verification plan job's phase — plan §4.10:1047. */
export type AppVerificationJobPhase = (typeof APP_VERIFICATION_JOB_PHASES)[number];

/** The scenario a manifest job runs in — plan §3.1:248 (`post-deploy` is manifest-only). */
export const APP_MANIFEST_JOB_PHASES = ['pre-deploy', 'first-deploy', 'post-deploy'] as const;

/** A manifest job's phase — plan §3.1:248. */
export type AppManifestJobPhase = (typeof APP_MANIFEST_JOB_PHASES)[number];

/** Probe kinds a component declares — verify-plan.schema.json:93. */
export const APP_VERIFICATION_PROBE_KINDS = ['http', 'tcp'] as const;

/** A verification component's probe kind — verify-plan.schema.json:93. */
export type AppVerificationProbeKind = (typeof APP_VERIFICATION_PROBE_KINDS)[number];

/** `http.authScheme` allowed values — plan §3.1:249 (CONTRACTS C2). */
export const APP_HTTP_AUTH_SCHEMES = ['bearer', 'raw'] as const;

/** `http.authScheme` — plan §3.1:249. */
export type AppHttpAuthScheme = (typeof APP_HTTP_AUTH_SCHEMES)[number];

/** HTTP methods a plan job or smoke entry may use — verify-plan.schema.json:151, 171. */
export const APP_VERIFICATION_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

/** An HTTP method a plan job or smoke entry may use — verify-plan.schema.json:151, 171. */
export type AppVerificationHttpMethod = (typeof APP_VERIFICATION_HTTP_METHODS)[number];

/** When a smoke entry runs — verify-plan.schema.json:174. */
export const APP_VERIFICATION_SMOKE_WHENS = ['after-deploy', 'after-jobs'] as const;

/** When a smoke entry runs — verify-plan.schema.json:174. */
export type AppVerificationSmokeWhen = (typeof APP_VERIFICATION_SMOKE_WHENS)[number];

/** A component's role — verify-plan.schema.json:106. */
export const APP_VERIFICATION_COMPONENT_ROLES = ['web', 'worker'] as const;

/** A component's role — verify-plan.schema.json:106. */
export type AppVerificationComponentRole = (typeof APP_VERIFICATION_COMPONENT_ROLES)[number];

/** A readiness probe — verify-plan.schema.json:88–99. */
export interface AppVerificationProbe {
	kind: AppVerificationProbeKind;
	path?: string;
	port?: number;
	failureThreshold?: number;
	periodSeconds?: number;
}

/** A component the verification starts — plan §4.10:1045, verify-plan.schema.json:100–122. */
export interface AppVerificationComponent {
	name: string;
	role: AppVerificationComponentRole;
	port: number;
	command?: string[];
	args?: string[];
	/** From the App spec's `resources.memoryLimit` — plan §4.10:1045. */
	memoryMiB?: number;
	writableRootFilesystem?: boolean;
	/** `liveness` is in the schema (verify-plan.schema.json:118) though plan §4.10:1045 lists startup/readiness. */
	probes?: {
		startup?: AppVerificationProbe;
		readiness?: AppVerificationProbe;
		liveness?: AppVerificationProbe;
	};
}

/**
 * A dependency the verification starts — plan §4.10:1046,
 * verify-plan.schema.json:123–136.
 *
 * `postgres` · `redis` · `objectStorage` only: an `smtp` dependency is
 * **not** started in the runner and a plan needing it is refused before
 * dispatch with `verificationDependencyUnsupported` (plan §4.10:1054–1056).
 */
export interface AppVerificationDependency {
	kind: AppVerificationDependencyKind;
	version?: string;
	buckets?: string[];
}

/** The dependency kinds a verification plan may declare — verify-plan.schema.json:128. */
export const APP_VERIFICATION_DEPENDENCY_KINDS = ['postgres', 'redis', 'objectStorage'] as const;

/** A verification plan dependency kind — verify-plan.schema.json:128. */
export type AppVerificationDependencyKind = (typeof APP_VERIFICATION_DEPENDENCY_KINDS)[number];

/** The fixed container names the recipe templates reference — plan §4.10:1052. */
export const APP_VERIFICATION_DEPENDENCY_CONTAINERS = {
	postgres: 'ew-dep-postgres',
	redis: 'ew-dep-redis',
	objectStorage: 'ew-dep-object-storage'
} as const;

/** A job's HTTP trigger — plan §4.10:1047, verify-plan.schema.json:146–158. */
export interface AppVerificationJobHttp {
	method: AppVerificationHttpMethod;
	path: string;
	body?: string;
	authEnv?: string;
	authScheme?: AppHttpAuthScheme;
	expectStatus?: number[];
}

/**
 * A job the verification runs — plan §4.10:1047, verify-plan.schema.json:137–163.
 *
 * Exactly one of `command` / `http` is present (`oneOf`,
 * verify-plan.schema.json:162).
 */
export interface AppVerificationJob {
	when: AppVerificationJobPhase;
	name: string;
	component?: string;
	command?: string[];
	http?: AppVerificationJobHttp;
	timeoutSeconds?: number;
	retries?: number;
}

/** A smoke entry's expectations — verify-plan.schema.json:175–192. */
export interface AppVerificationSmokeExpect {
	status?: number[];
	bodyContains?: string[];
	bodyNotContains?: string[];
	maxLatencyMs?: number;
}

/** A smoke entry the verification runs — plan §4.10:1048, verify-plan.schema.json:164–194. */
export interface AppVerificationSmoke {
	name: string;
	method: AppVerificationHttpMethod;
	path: string;
	component?: string;
	body?: string;
	when?: AppVerificationSmokeWhen;
	expect?: AppVerificationSmokeExpect;
}

/** A build service inside a verification plan — verify-plan.schema.json:49–63. */
export interface AppVerificationBuildService {
	name: string;
	image: string;
	port?: number;
	env?: { name: string; value: string }[];
}

/** A build argument inside a verification plan — verify-plan.schema.json:77–87. */
export interface AppVerificationBuildArg {
	name: string;
	value?: string;
	fromEnv?: string;
}

/** The App spec's `build` block, when the runner must build instead of reusing a digest — plan §4.10:1049. */
export interface AppVerificationBuildBlock {
	strategy: 'dockerfile' | 'image';
	dockerfile?: string;
	context?: string;
	target?: string;
	image?: string;
	args?: AppVerificationBuildArg[];
	services?: AppVerificationBuildService[];
}

/**
 * The value-free verification plan APW-04 hands to
 * `AppBuildsService.startVerification` (plan §4.10:1036–1057,
 * `verify-plan.schema.json`).
 *
 * It travels base64url-encoded in the workflow_dispatch input
 * {@link APP_BUILD_VERIFY_PLAN_INPUT} (≤ {@link APP_BUILD_VERIFY_PLAN_MAX_CHARS}
 * characters) and is validated with `ajv` before dispatch. It **never carries a
 * resolved value**: `generate` entries describe what to generate and `prompted`
 * entries name the entry only (plan §4.10:1015–1017).
 */
export interface AppVerificationPlan {
	version: typeof APP_VERIFICATION_PLAN_VERSION;
	components: AppVerificationComponent[];
	dependencies: AppVerificationDependency[];
	jobs: AppVerificationJob[];
	smoke: AppVerificationSmoke[];
	/** APW-07's runner recipe entries, unchanged — plan §4.10:1050. */
	env: AppEnvRecipeEntry[];
	build?: AppVerificationBuildBlock;
}

/** One verification job's recorded outcome — plan §4.10:1010, §4.1:679. */
export interface AppBuildVerificationJobResult {
	name: string;
	exitCode: number | null;
	durationMs: number;
}

/** One smoke entry's recorded outcome — plan §4.10:1010, §4.1:680. */
export interface AppBuildVerificationSmokeResult {
	name: string;
	expected: string;
	observed: string;
	passed: boolean;
	durationMs: number;
}

/**
 * `work_builds.verificationResult` — the verification outcome APW-04 polls
 * (`AppBuildDetail.verificationResult`, §5:1062–1065) and the shape carried by
 * `BuildSnapshot.verification` (plan §4.1:677–681).
 */
export interface AppBuildVerificationResult {
	componentsReady: boolean;
	jobs: AppBuildVerificationJobResult[];
	smoke: AppBuildVerificationSmokeResult[];
}
