/**
 * App dependencies — the shared contract for APW-07's dependency model and
 * the in-zone `ew-dep://` substitution APW-10 performs.
 *
 * Owning epic: **APW-07 (App env & dependencies)**. Implements
 * `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * and its `plan.md` §2.3 (provisioning), §3.2 (`work_app_dependencies`),
 * §3.3 (shared types), §4.7 (`IAppDependencyProvider`), §4.9–§4.11
 * (providers, the relay, the managed tier) and §4.12 (deletion).
 *
 * `APP_DEPENDENCY_OUTPUTS` is the **normative** output list: APW-03's App
 * spec schema §11 must equal it (FR-40), and it is what `from:
 * deps.<kind>.<output>` may reference. The DDL builder the managed tier's
 * zone controller runs lives next door in `tenant-postgres-ddl.ts`.
 *
 * Nothing here carries a value: outputs are stored encrypted on one row
 * (`outputsEncrypted`, plan §3.2:216) and are **never** returned by an
 * endpoint, a log, Activity or telemetry (FR-5). The managed tier goes
 * further — the platform never sees a managed dependency's outputs at all
 * (plan §4.11:689–693, §4.11:734).
 */

/* ------------------------------------------------------------------------- *
 * Kinds, targets and providers (plan §3.3:296, §4.7:469–479)
 * ------------------------------------------------------------------------- */

/** The four dependency kinds (FR-35, plan §3.3:296). */
export const APP_DEPENDENCY_KINDS = ['postgres', 'redis', 'objectStorage', 'smtp'] as const;

/** A dependency kind — plan §3.3:296. */
export type AppDependencyKind = (typeof APP_DEPENDENCY_KINDS)[number];

/**
 * The deploy targets a dependency provider can serve (plan §4.7:470).
 *
 * The chosen deploy target itself (`none` / `your-cluster` /
 * `ever-works-apps`) is declared once by APW-01 in `app-source.ts` — `none`
 * provisions nothing (FR-35) and is deliberately not repeated here.
 */
export const APP_DEPENDENCY_TARGETS = ['your-cluster', 'ever-works-apps'] as const;

/** A dependency target — plan §4.7:470. */
export type AppDependencyTarget = (typeof APP_DEPENDENCY_TARGETS)[number];

/**
 * `work_app_dependencies.status` (`varchar(16)`, plan §3.2:210) — eight members
 * plus the pre-provisioning state plan §4.9a:641 adds.
 *
 * `awaiting_config` sits after `pending` because that is where the state machine
 * reaches it: `reconcile` inserts such a row instead of dispatching, `PUT
 * …/:kind` with valid config moves it to `pending`, and no deadline runs
 * meanwhile (plan §4.9a:641-644, spec.md:433). Without it a provider whose
 * settings only the owner can supply would reach `failed deadlineExceeded` inside
 * the 30-second SMTP deadline before the owner could type anything.
 */
export const APP_DEPENDENCY_STATUSES = [
	'pending',
	'awaiting_config',
	'provisioning',
	'ready',
	'degraded',
	'failed',
	'kept',
	'deleting',
	'deleted'
] as const;

/** A dependency row's status — plan §3.2:210. */
export type AppDependencyStatus = (typeof APP_DEPENDENCY_STATUSES)[number];

/** The statuses the partial unique index excludes — plan §3.2:225. */
export const APP_DEPENDENCY_INACTIVE_STATUSES = ['kept', 'deleted'] as const;

/** `work_app_dependencies.backupPolicy` (`varchar(16)`, plan §3.2:220, §4.7:478). */
export const APP_DEPENDENCY_BACKUP_POLICIES = ['none', 'operator', 'provider', 'managed'] as const;

/** A dependency's backup policy — plan §3.2:220. */
export type AppDependencyBackupPolicy = (typeof APP_DEPENDENCY_BACKUP_POLICIES)[number];

/**
 * `work_app_dependencies.backupState` (`varchar(16)`, plan §3.2:221) — the seven
 * card states of FR-48.
 */
export const APP_DEPENDENCY_BACKUP_STATES = [
	'none',
	'not_configured',
	'healthy',
	'overdue',
	'failing',
	'external',
	'unknown'
] as const;

/** A dependency's backup state — FR-48 / plan §3.2:221. */
export type AppDependencyBackupState = (typeof APP_DEPENDENCY_BACKUP_STATES)[number];

/* ------------------------------------------------------------------------- *
 * Reasons and API error codes (plan §5:798-805, §8:911-913; APW07-G23)
 * ------------------------------------------------------------------------- */

/**
 * Every reason a dependency row or an API response can carry, verbatim from
 * plan §8:913 and in the plan's order — then APW07-G28's two additions.
 *
 * The union is wide on purpose: a **status reason** is why a card reads
 * *Failed* or *Degraded* (FR-43's "definite failure ... fails at once with its
 * reason"), while an **API error code** is what a write answers with. They share
 * one vocabulary because they share one copy subtree —
 * `dashboard.workDetail.appDependencies.reasons.*` — which is what lets a card
 * and a toast render the same sentence for the same cause.
 *
 * `targetNone` and `targetNotChecked` are APW07-G28: APW-06's
 * `AppRuntimeTargetPort` answers `unavailable` in its OWN snake_case vocabulary
 * (plan §4.8:550-556, APW-06 plan §9.9:1564-1567), and two of its four members
 * had no card member here. Appended rather than inserted so the plan's
 * twenty-four stay first and in the plan's order; the plan line itself is not
 * edited (the gap note records it).
 */
export const APP_DEPENDENCY_REASONS = [
	'noDefaultStorageClass',
	'clusterUnreachable',
	'smtpConnectFailed',
	'smtpTlsFailed',
	'smtpAuthRefused',
	'bucketUnreadable',
	'volumeNotReady',
	'extensionUnavailable',
	'platformServerRefused',
	'deadlineExceeded',
	'namespaceNotOwned',
	'namespaceBaselineMissing',
	'clusterPermissionMissing',
	'operatorNamespaceUnknown',
	'volumeExpansionUnsupported',
	'sizeShrinkRefused',
	'relayIneligible',
	'relaySuspended',
	'providerNotSupported',
	'dependencyNotDeclared',
	'confirmationMismatch',
	'deleteInProgress',
	'notGenerated',
	'notAppWork',
	// APW07-G28 — the last two of APW-06's four `unavailable` codes, in the
	// port's own order (`target_none`, `target_not_checked`, then the two that
	// already had a member: `namespace_owned_elsewhere` → `namespaceNotOwned`,
	// `cluster_unreachable` → `clusterUnreachable`).
	'targetNone',
	'targetNotChecked'
] as const;

/** A dependency reason or API error code — plan §8:913. */
export type AppDependencyReason = (typeof APP_DEPENDENCY_REASONS)[number];

/**
 * The eighteen reasons a **card** shows after a failed or degraded attempt — plan
 * §4.9:570-583 (no storage class, unreachable cluster, the ext-provider test
 * reasons, a volume that never became ready, missing extensions, a refused
 * platform data server, and the deadline), §4.9a's relay states and the namespace
 * checks of §4.9's permission list. `targetNone` and `targetNotChecked` are
 * APW07-G28's two: a target that was never chosen, and one whose cluster check
 * has not passed — both are preconditions APW-06's port reports as `unavailable`
 * rather than failing them itself.
 *
 * A definite failure fails at once with one of these; only a transient one is
 * retried (FR-43).
 */
export const APP_DEPENDENCY_STATUS_REASONS = [
	'noDefaultStorageClass',
	'clusterUnreachable',
	'smtpConnectFailed',
	'smtpTlsFailed',
	'smtpAuthRefused',
	'bucketUnreadable',
	'volumeNotReady',
	'extensionUnavailable',
	'platformServerRefused',
	'deadlineExceeded',
	'namespaceNotOwned',
	'namespaceBaselineMissing',
	'clusterPermissionMissing',
	'operatorNamespaceUnknown',
	'relayIneligible',
	'relaySuspended',
	// APW07-G28: the port's `target_none` / `target_not_checked`.
	'targetNone',
	'targetNotChecked'
] as const;

/** A reason a dependency card shows — plan §4.9-§4.9a. */
export type AppDependencyStatusReason = (typeof APP_DEPENDENCY_STATUS_REASONS)[number];

/**
 * The eight codes the dependency **routes** answer with — plan §5:798-802.
 *
 * `sizeShrinkRefused` (422) and `volumeExpansionUnsupported` (422) are
 * APW07-G22's two additions to `PUT …/:kind`; `notAppWork` is the 404 a non-`app`
 * Work gets on every route.
 */
export const APP_DEPENDENCY_ERROR_CODES = [
	'volumeExpansionUnsupported',
	'sizeShrinkRefused',
	'providerNotSupported',
	'dependencyNotDeclared',
	'confirmationMismatch',
	'deleteInProgress',
	'notGenerated',
	'notAppWork'
] as const;

/** A dependency API error code — plan §5:798-802. */
export type AppDependencyErrorCode = (typeof APP_DEPENDENCY_ERROR_CODES)[number];

/**
 * One `dashboard.workDetail.appDependencies.reasons.<leaf>` leaf per reason, with
 * camelCase, `.`-free leaves — plan §8:913.
 *
 * A total `Record` over the union, so a reason added without a leaf fails to
 * compile; T2's spec pins every leaf against `apps/web/messages/en.json`, so a
 * reason added without **copy** fails the suite (APW07-G23).
 */
export const APP_DEPENDENCY_REASON_MESSAGE_LEAVES = {
	noDefaultStorageClass: 'noDefaultStorageClass',
	clusterUnreachable: 'clusterUnreachable',
	smtpConnectFailed: 'smtpConnectFailed',
	smtpTlsFailed: 'smtpTlsFailed',
	smtpAuthRefused: 'smtpAuthRefused',
	bucketUnreadable: 'bucketUnreadable',
	volumeNotReady: 'volumeNotReady',
	extensionUnavailable: 'extensionUnavailable',
	platformServerRefused: 'platformServerRefused',
	deadlineExceeded: 'deadlineExceeded',
	namespaceNotOwned: 'namespaceNotOwned',
	namespaceBaselineMissing: 'namespaceBaselineMissing',
	clusterPermissionMissing: 'clusterPermissionMissing',
	operatorNamespaceUnknown: 'operatorNamespaceUnknown',
	volumeExpansionUnsupported: 'volumeExpansionUnsupported',
	sizeShrinkRefused: 'sizeShrinkRefused',
	relayIneligible: 'relayIneligible',
	relaySuspended: 'relaySuspended',
	providerNotSupported: 'providerNotSupported',
	dependencyNotDeclared: 'dependencyNotDeclared',
	confirmationMismatch: 'confirmationMismatch',
	deleteInProgress: 'deleteInProgress',
	notGenerated: 'notGenerated',
	notAppWork: 'notAppWork',
	// APW07-G28 — no new copy subtree: the two port preconditions get one leaf
	// each, exactly like every other reason, and T2's spec pins them against
	// `apps/web/messages/en.json`.
	targetNone: 'targetNone',
	targetNotChecked: 'targetNotChecked'
} as const satisfies Record<AppDependencyReason, string>;

/** The i18n subtree every dependency reason's copy lives under — plan §8:913. */
export const APP_DEPENDENCY_REASON_MESSAGE_KEY_PREFIX = 'dashboard.workDetail.appDependencies.reasons' as const;

/**
 * One `dashboard.workDetail.appDependencies.status.<leaf>` leaf per status —
 * plan §8:911.
 *
 * Only nine entries: `notInSpec` is in that plan line too, but it is the copy of
 * the `inSpec: false` chip ("No longer used by the App spec — data kept", spec
 * §6.3:526) and not a member of {@link APP_DEPENDENCY_STATUSES}. `awaiting_config`
 * keeps the camelCase leaf `awaitingConfig` the plan names.
 */
export const APP_DEPENDENCY_STATUS_MESSAGE_LEAVES = {
	pending: 'pending',
	awaiting_config: 'awaitingConfig',
	provisioning: 'provisioning',
	ready: 'ready',
	degraded: 'degraded',
	failed: 'failed',
	kept: 'kept',
	deleting: 'deleting',
	deleted: 'deleted'
} as const satisfies Record<AppDependencyStatus, string>;

/** The i18n subtree every dependency status's copy lives under — plan §8:911. */
export const APP_DEPENDENCY_STATUS_MESSAGE_KEY_PREFIX = 'dashboard.workDetail.appDependencies.status' as const;

/** One `dashboard.workDetail.appDependencies.backup.<leaf>` leaf per backup state — plan §8:912. */
export const APP_DEPENDENCY_BACKUP_STATE_MESSAGE_LEAVES = {
	none: 'none',
	not_configured: 'notConfigured',
	healthy: 'healthy',
	overdue: 'overdue',
	failing: 'failing',
	external: 'external',
	unknown: 'unknown'
} as const satisfies Record<AppDependencyBackupState, string>;

/** The i18n subtree every backup state's copy lives under — plan §8:912. */
export const APP_DEPENDENCY_BACKUP_STATE_MESSAGE_KEY_PREFIX = 'dashboard.workDetail.appDependencies.backup' as const;

/** The ONE message key of a dependency reason (plan §5:802-805). */
export function appDependencyReasonMessageKey(reason: AppDependencyReason): string {
	return `${APP_DEPENDENCY_REASON_MESSAGE_KEY_PREFIX}.${APP_DEPENDENCY_REASON_MESSAGE_LEAVES[reason]}`;
}

/** The ONE message key of a dependency status (plan §8:911). */
export function appDependencyStatusMessageKey(status: AppDependencyStatus): string {
	return `${APP_DEPENDENCY_STATUS_MESSAGE_KEY_PREFIX}.${APP_DEPENDENCY_STATUS_MESSAGE_LEAVES[status]}`;
}

/** The ONE message key of a backup state (plan §8:912). */
export function appDependencyBackupStateMessageKey(state: AppDependencyBackupState): string {
	return `${APP_DEPENDENCY_BACKUP_STATE_MESSAGE_KEY_PREFIX}.${APP_DEPENDENCY_BACKUP_STATE_MESSAGE_LEAVES[state]}`;
}

/**
 * Is this string one of the twenty-six reasons? A `varchar(48)` column and a
 * provider's own `reason: string` both arrive as plain strings, so the closed
 * union needs one place to cross back into it — and a caller that fails this
 * check has an unmapped reason, which is exactly what APW07-G23 exists to catch.
 *
 * APW07-G28 is why the check is strict rather than forgiving: a reason that is
 * not a member reads back as `null`, so a card shows *Failed* with **no** reason
 * at all. The service therefore maps the port's vocabulary at the write, never
 * storing a discriminant this function would reject.
 */
export function isAppDependencyReason(value: string): value is AppDependencyReason {
	return (APP_DEPENDENCY_REASONS as readonly string[]).includes(value);
}

/**
 * The provider ids that ship (CONTRACTS §3:369).
 *
 * P1 — the `k8s` plugin: `k8s-inline-postgres`, `k8s-inline-redis`,
 * `k8s-inline-minio`; `app-dependencies-external`: `smtp-external`,
 * `s3-external`, `platform-smtp-relay`. P2 — `apps-tier-dependencies`:
 * `managed-postgres`, `managed-redis`, `managed-object-storage`,
 * `managed-smtp` (the last added by GAP-22 so a `smtp: { required: true }`
 * App Work can reach `ready` on the tier).
 */
export const APP_DEPENDENCY_PROVIDER_IDS = [
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
] as const;

/** A dependency provider id — CONTRACTS §3:369. */
export type AppDependencyProviderId = (typeof APP_DEPENDENCY_PROVIDER_IDS)[number];

/* ------------------------------------------------------------------------- *
 * Outputs (FR-40; plan §3.3:296–303)
 * ------------------------------------------------------------------------- */

/**
 * The output names per kind that `from: deps.<kind>.<output>` may reference,
 * `true` meaning the output is secret (FR-40, plan §3.3:297–303).
 *
 * `url`, `directUrl`, `password`, `accessKeyId` and `secretAccessKey` are the
 * secret ones (FR-40). `directUrl` is emitted only when
 * `postgres.directUrl: true`; `bucket.<name>` once per declared bucket; values
 * are always strings, `port` decimal and `secure` `"true"`/`"false"`
 * (plan §3.3:328–329).
 */
export const APP_DEPENDENCY_OUTPUTS = {
	postgres: { url: true, directUrl: true, host: false, port: false, database: false, user: false, password: true },
	redis: { url: true, host: false, port: false, password: true },
	objectStorage: { endpoint: false, region: false, accessKeyId: true, secretAccessKey: true, 'bucket.*': false },
	smtp: { host: false, port: false, user: false, password: true, from: false, secure: false }
} as const;

/** The secret flag map of one dependency kind — FR-40. */
export type AppDependencyOutputFlags = (typeof APP_DEPENDENCY_OUTPUTS)[AppDependencyKind];

/** The declared output names of a kind, as a list. `bucket.*` stays a pattern. */
export const APP_DEPENDENCY_OUTPUT_NAMES: Record<AppDependencyKind, readonly string[]> = {
	postgres: ['url', 'directUrl', 'host', 'port', 'database', 'user', 'password'],
	redis: ['url', 'host', 'port', 'password'],
	objectStorage: ['endpoint', 'region', 'accessKeyId', 'secretAccessKey', 'bucket.*'],
	smtp: ['host', 'port', 'user', 'password', 'from', 'secure']
};

/** The per-bucket output pattern of `objectStorage` — FR-40 / plan §3.3:301. */
export const APP_DEPENDENCY_BUCKET_OUTPUT_PATTERN = 'bucket.*' as const;

/** Prefix of a concrete bucket output name — FR-40. */
export const APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX = 'bucket.' as const;

/**
 * The output names of a kind, or `null` for an unknown kind.
 *
 * A dependency reference the App spec cannot resolve is reported by name and
 * blocks the Build or Deploy (FR-23, FR-26) — it is never silently dropped.
 */
export function appDependencyOutputNames(kind: AppDependencyKind): readonly string[] {
	return APP_DEPENDENCY_OUTPUT_NAMES[kind];
}

/** Is an output secret? Unknown names are treated as secret (fail closed). */
export function isAppDependencyOutputSecret(kind: AppDependencyKind, output: string): boolean {
	const flags: Record<string, boolean> = APP_DEPENDENCY_OUTPUTS[kind];
	return flags[output] ?? true;
}

/* ------------------------------------------------------------------------- *
 * The in-zone token (CONTRACTS §3:370–371, plan §4.11:694–696)
 * ------------------------------------------------------------------------- */

/** The scheme of a sealed in-zone dependency reference — plan §4.11:695. */
export const APP_DEPENDENCY_TOKEN_SCHEME = 'ew-dep://' as const;

/**
 * The in-zone reference token APW-07 seals in place of a real output:
 * `ew-dep://<kind>/<output>` (plan §4.11:694–696).
 *
 * The zone controller substitutes every token inside the sealed env **after**
 * unsealing and **before** the tenant Secret is written, and refuses an unknown
 * token with `DEPENDENCY_TOKEN_UNKNOWN` — no placeholder ever reaches a
 * rendered env Secret or an app (CONTRACTS §3:371, APW-10 plan §3.1:276–277).
 */
export function appDependencyToken(kind: AppDependencyKind, output: string): string {
	return `${APP_DEPENDENCY_TOKEN_SCHEME}${kind}/${output}`;
}

/** A parsed in-zone dependency reference. */
export interface AppDependencyTokenRef {
	kind: AppDependencyKind;
	output: string;
}

/**
 * Parse an `ew-dep://<kind>/<output>` token, or `null` when it is not one.
 *
 * `null` for an unknown KIND is the `DEPENDENCY_TOKEN_UNKNOWN` case: the zone
 * refuses the Work rather than shipping the placeholder (APW-10 plan §3.1:276).
 * The output name is returned as written; whether it exists is the caller's
 * lookup, because `bucket.<name>` is open-ended (FR-40).
 */
export function parseAppDependencyToken(text: string): AppDependencyTokenRef | null {
	if (!text.startsWith(APP_DEPENDENCY_TOKEN_SCHEME)) return null;
	const rest = text.slice(APP_DEPENDENCY_TOKEN_SCHEME.length);
	const separator = rest.indexOf('/');
	if (separator <= 0 || separator === rest.length - 1) return null;
	const kind = rest.slice(0, separator);
	const output = rest.slice(separator + 1);
	if (!(APP_DEPENDENCY_KINDS as readonly string[]).includes(kind)) return null;
	if (output.includes('/')) return null;
	return { kind: kind as AppDependencyKind, output };
}

/** The refusal code APW-10's zone returns for an unresolvable token — APW-10 plan §3.1:276. */
export const APP_DEPENDENCY_TOKEN_UNKNOWN_CODE = 'DEPENDENCY_TOKEN_UNKNOWN' as const;

/* ------------------------------------------------------------------------- *
 * Limits (plan §3.3:304–325; every number is spec FR-37/FR-41/FR-43/FR-48/FR-50)
 * ------------------------------------------------------------------------- */

/**
 * Readiness deadlines per kind (FR-41, plan §3.3:304–309):
 * Postgres and object storage 10 minutes, Redis 5 minutes, mail 30 seconds.
 */
export const APP_DEPENDENCY_READY_DEADLINE_MS = {
	postgres: 600_000,
	redis: 300_000,
	objectStorage: 600_000,
	smtp: 30_000
} as const;

/** An external provider's connection test budget (FR-41, plan §4.10:658–661). */
export const APP_DEPENDENCY_EXTERNAL_TEST_MS = 30_000 as const;

/** Default volumes on Your cluster (FR-37, plan §3.3:311). `smtp` has no volume. */
export const APP_DEPENDENCY_DEFAULT_SIZE_GIB = { postgres: 10, objectStorage: 20, redis: 1 } as const;

/** A dependency kind that has a default volume size — FR-37. */
export type AppDependencySizedKind = keyof typeof APP_DEPENDENCY_DEFAULT_SIZE_GIB;

/** Transient attempts before a card reads **Failed** (FR-43, plan §3.3:312). */
export const APP_DEPENDENCY_TRANSIENT_ATTEMPTS = 3 as const;

/**
 * Delay between transient attempts: 3 attempts over 15 minutes means a 5-minute
 * gap (FR-43, plan §2.3:165 "re-dispatch after 5 min", plan §3.3:313).
 */
export const APP_DEPENDENCY_RETRY_DELAY_MS = 300_000 as const;

/** Open a Dependencies card whose status is older than this (FR-42, plan §3.3:314). */
export const APP_DEPENDENCY_REFRESH_AFTER_MS = 900_000 as const;

/**
 * The card's **Overdue** line: a last completed backup older than 26 hours
 * (FR-48, plan §3.3:315).
 *
 * This is the CARD threshold. `APP_DEPENDENCY_MANAGED.backupMaxAgeMs` is the
 * zone's own 24-hour schedule target, not this line (plan §4.11:721–725).
 */
export const APP_DEPENDENCY_BACKUP_OVERDUE_MS = 26 * 3_600_000;

/** Relay messages per App Work per day (FR-39/FR-61, plan §3.3:316). */
export const APP_DEPENDENCY_RELAY_DAILY_LIMIT = 200 as const;

/**
 * The managed tier's dependency semantics (FR-52, FR-53, FR-50; plan §3.3:317–325).
 *
 * `backupMaxAgeMs` is the **zone's** schedule target — the zone must write
 * `lastBackupAt` at least once every 24 hours, so a 25-hour-old timestamp only
 * reads `overdue` once the zone has actually missed its schedule; the card line
 * is the 26-hour {@link APP_DEPENDENCY_BACKUP_OVERDUE_MS}
 * (plan §4.11:721–725).
 */
export const APP_DEPENDENCY_MANAGED = {
	pgRoleConnectionLimit: 20,
	pgDatabaseConnectionLimit: 25,
	pgStatementTimeoutMs: 60_000,
	pgIdleInTransactionTimeoutMs: 60_000,
	bucketQuotaGiB: 10,
	redisMaxMemoryMiB: 256,
	backupMaxAgeMs: 86_400_000
} as const;

/** The tenant data server's default port, used by the DDL input and by refusal checks. */
export const APP_DEPENDENCY_POSTGRES_DEFAULT_PORT = 5432 as const;

/** The bucket-name prefix inside a zone — plan §4.11:719. */
export const APP_DEPENDENCY_ZONE_BUCKET_PREFIX = 'aw-' as const;

/** The zone's object-storage bucket name shape (`aw-<hex12>-<name>`) — plan §4.11:719. */
export const APP_DEPENDENCY_ZONE_BUCKET_NAME_SHAPE = 'aw-<hex12>-<name>' as const;

/** The zone's Redis memory ceiling in MiB — plan §4.11:718. */
export const APP_DEPENDENCY_ZONE_REDIS_MAX_MEMORY_MIB = 256 as const;

/* ------------------------------------------------------------------------- *
 * Provider results (plan §4.7:499–513)
 * ------------------------------------------------------------------------- */

/** What a provider is allowed to report about its support for a kind + target. */
export type AppDependencySupport = { supported: true; providerId: string } | { supported: false; reason: string };

/** A provider's outcome for one provisioning attempt (plan §4.7:500–509). */
export type AppDependencyProvisionOutcome =
	| {
			state: 'ready';
			outputs: Record<string, string>;
			actualVersion?: string;
			resourceRefs: AppDependencyResourceRefs;
			warnings?: string[];
	  }
	| { state: 'pending'; retryAfterMs: number; detail?: Record<string, string | number> }
	| { state: 'failed'; reason: string; transient: boolean; detail?: Record<string, string | number | string[]> };

/** The non-secret record of what a provider created — plan §3.2:218. */
export interface AppDependencyResourceRefs {
	namespace?: string;
	objects: { kind: string; name: string }[];
	databases?: string[];
	buckets?: string[];
}

/** A provider's answer to "is this dependency backed up?" (plan §4.7:510–513). */
export interface AppDependencyBackupStatus {
	readonly state: AppDependencyBackupState;
	readonly lastBackupAt?: string;
}

/** What a provider is asked to do about data on release — plan §4.7:526–528, §4.12. */
export interface AppDependencyDeprovisionOptions {
	/** True only after the owner ticked **Also delete stored data** and typed the slug (R-15). */
	deleteData: boolean;
	/** Stop kept in-cluster workloads (scale to 0) while keeping PVC, Secret and policies. */
	stopWorkloads?: boolean;
}

/** A provider's release outcome — plan §4.7:528. */
export type AppDependencyDeprovisionOutcome = {
	state: 'released' | 'deleted' | 'pending';
	remaining?: AppDependencyResourceRefs;
};

/* ------------------------------------------------------------------------- *
 * The Dependencies card (plan §5:787-796, §4.9a:645)
 * ------------------------------------------------------------------------- */

/** Who serves a dependency — plan §5:793. */
export interface AppDependencyProviderRef {
	pluginId: string;
	providerId: string;
	label: string;
}

/**
 * One field of a provider's prompt schema — plan §5:793, §4.7:474.
 *
 * `secret` marks an `x-secret` field: it is write-only, so `set` says whether a
 * value is already stored and the value itself is never returned (FR-5).
 */
export interface AppDependencyPromptField {
	key: string;
	label: string;
	secret: boolean;
	required: boolean;
	set: boolean;
}

/** A provider the card may offer for this kind and target — plan §5:793. */
export interface AppDependencyAvailableProvider {
	providerId: string;
	label: string;
	promptFields: AppDependencyPromptField[];
}

/** A dependency's backup block — plan §5:794, FR-48. */
export interface AppDependencyBackupView {
	policy: AppDependencyBackupPolicy;
	state: AppDependencyBackupState;
	lastBackupAt: string | null;
	checkedAt: string | null;
}

/** One output the provider produces, by name — **never** its value (plan §5:794, FR-5). */
export interface AppDependencyOutputRef {
	name: string;
	secret: boolean;
}

/**
 * `statusDetail`: names and numbers only, ≤ 2 KB, as `simple-json` (plan §3.2:211).
 *
 * The `string[]` member is there because a definite failure may name the
 * extensions that are missing (plan §4.9:583) — it is still names, not values.
 */
export type AppDependencyStatusDetail = Record<string, string | number | string[]>;

/**
 * One Dependencies card — what `GET /api/works/:id/app-dependencies` returns per
 * dependency (plan §5:792-796), plus §4.9a's `awaitingConfig`.
 *
 * **No output or config value is ever on this shape** (plan §5:795, FR-5):
 * `outputs` names what exists and whether it is secret, `keptResources` lists what
 * was left behind after a release (FR-45/FR-56), and the prompted `config` of an
 * external provider is write-only — it is never echoed back, which is why the
 * card renders `promptFields[].set` instead of a stored secret.
 *
 * `awaitingConfig` is deliberately redundant with `status === 'awaiting_config'`:
 * the card decides whether to render **Configure** from the boolean (plan
 * §4.9a:645), and the two are pinned to agree by T2's spec.
 */
export interface AppDependencyView {
	kind: AppDependencyKind;
	/** Does the App spec declare this kind? (FR-35) */
	declared: boolean;
	/** The provider serving it. A row always carries one — both columns are NOT NULL (plan §3.2:209). */
	provider: AppDependencyProviderRef;
	/** Every provider this App Work's target could offer, with its prompt schema (APW07-G16). */
	availableProviders: AppDependencyAvailableProvider[];
	status: AppDependencyStatus;
	/** Why the card is `failed` / `degraded` / `awaiting_config`; `null` when there is nothing to say. */
	statusReason: AppDependencyReason | null;
	statusDetail: AppDependencyStatusDetail | null;
	/** True exactly when `status === 'awaiting_config'` (plan §4.9a:645). */
	awaitingConfig: boolean;
	/** The provider's reported version, e.g. `16` for Postgres. */
	actualVersion: string | null;
	sizeGiB: number | null;
	backup: AppDependencyBackupView;
	/** False once the kind left the App spec — the "No longer used" card (FR-45). */
	inSpec: boolean;
	/** What a release kept, by name — the delete-data dialog lists it (FR-46, plan §4.12). */
	keptResources: AppDependencyResourceRefs | null;
	outputs: AppDependencyOutputRef[];
	lastProvisionedAt: string | null;
	lastCheckedAt: string | null;
}

/* ------------------------------------------------------------------------- *
 * Relay (FR-39/FR-61, plan §4.10:672–683)
 * ------------------------------------------------------------------------- */

/**
 * The mail relay's per-account and per-organization daily ceilings that sit on
 * top of {@link APP_DEPENDENCY_RELAY_DAILY_LIMIT} (XC-21, plan §4.10:679–680).
 */
export const APP_DEPENDENCY_RELAY_LIMITS = {
	perAccountPerDay: 1_000,
	perOrganizationPerDay: 5_000,
	suspendBounceRate: 0.05
} as const;

/**
 * The operator env vars APW-07 reads (Resolution R-30, plan §4.10:667–681,
 * CONTRACTS §7A:669). Collected in one record so no epic writes a second
 * literal of the same name.
 */
export const APP_DEPENDENCY_ENV_VARS = {
	/** R-30 kill switch for dependency provisioning and the mail relay. */
	depsEnabled: 'EVER_WORKS_APP_DEPS_ENABLED',
	/** R-30 kill switch for the relay alone. */
	mailRelayEnabled: 'EVER_WORKS_APP_MAIL_RELAY_ENABLED',
	/** Comma-separated CIDRs that get past the public-endpoint guard (APW07-G09). */
	privateAllowlist: 'EVER_WORKS_APP_DEPENDENCY_PRIVATE_ALLOWLIST',
	relayDailyLimitPerAccount: 'EVER_WORKS_APP_RELAY_DAILY_LIMIT_PER_ACCOUNT',
	relayDailyLimitPerOrganization: 'EVER_WORKS_APP_RELAY_DAILY_LIMIT_PER_ORGANIZATION',
	relaySuspendBounceRate: 'EVER_WORKS_APP_RELAY_SUSPEND_BOUNCE_RATE',
	/** Per-App-Work daily relay cap override — CONTRACTS §7A:669. */
	mailMaxPerDay: 'EVER_WORKS_APP_MAIL_MAX_PER_DAY'
} as const;

/* ------------------------------------------------------------------------- *
 * Pure decisions
 * ------------------------------------------------------------------------- */

/**
 * Is a dependency's backup overdue on its card?
 *
 * FR-48's rule: **Overdue** when the last completed backup is older than 26
 * hours. A missing timestamp is not `overdue` — it is the caller's
 * `not_configured` / `unknown` state, because "we never had one" and "we lost
 * the last one" are different messages (FR-48, plan §4.11:721–725).
 *
 * The comparison is strictly greater than the threshold, so a timestamp exactly
 * 26 hours old is still **Last completed**.
 */
export function isAppDependencyBackupOverdue(lastBackupAt: string | null | undefined, now: number): boolean {
	if (!lastBackupAt) return false;
	const last = Date.parse(lastBackupAt);
	if (Number.isNaN(last)) return false;
	return now - last > APP_DEPENDENCY_BACKUP_OVERDUE_MS;
}

/**
 * The ready deadline for a kind, in ms — FR-41's table, as a lookup a caller
 * cannot get wrong by passing the wrong field.
 */
export function appDependencyReadyDeadlineMs(kind: AppDependencyKind): number {
	return APP_DEPENDENCY_READY_DEADLINE_MS[kind];
}

/**
 * The default volume size of a kind, or `null` for a kind that has none
 * (FR-37 sizes Postgres, object storage and Redis; `smtp` is a relay endpoint
 * with no storage of its own).
 */
export function appDependencyDefaultSizeGiB(kind: AppDependencyKind): number | null {
	return kind in APP_DEPENDENCY_DEFAULT_SIZE_GIB
		? APP_DEPENDENCY_DEFAULT_SIZE_GIB[kind as AppDependencySizedKind]
		: null;
}

/**
 * Is a size change allowed?
 *
 * "A dependency's size can be chosen per App Work before it is first provisioned,
 * increased later when its storage supports it, and **never decreased**"
 * (FR-63, plan §3.3:310). Equal is allowed — re-saving the same size is not a
 * shrink.
 */
export function isAppDependencySizeChangeAllowed(
	previousGiB: number | null,
	nextGiB: number
): { readonly allowed: true } | { readonly allowed: false; readonly refusal: 'dependencySizeShrink' } {
	if (previousGiB !== null && nextGiB < previousGiB) return { allowed: false, refusal: 'dependencySizeShrink' };
	return { allowed: true };
}

/**
 * May a dependency's data be deleted?
 *
 * FR-46: deleting a dependency's data needs edit access, the typed App Work
 * slug and a dialog listing every volume, database and bucket that will be
 * destroyed. It cannot be undone — so an unconfirmed request is always refused,
 * never defaulted to "yes".
 */
export function canDeleteAppDependencyData(input: {
	readonly hasEditAccess: boolean;
	readonly confirmSlug: string | null;
	readonly workSlug: string;
}): boolean {
	return input.hasEditAccess && input.confirmSlug !== null && input.confirmSlug === input.workSlug;
}

/**
 * Does this dependency kind block a Build or Deploy while it is not `ready`?
 *
 * FR-62: an App spec that marks `smtp` **not** required and has no mail provider
 * leaves the entries that would read from it unset with a warning instead of
 * blocking; when it **is** required, they block, naming the missing entry.
 */
export function appDependencyBlocksDeploy(kind: AppDependencyKind, required: boolean): boolean {
	return kind === 'smtp' ? required : true;
}
