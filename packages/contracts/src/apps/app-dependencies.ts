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

/** `work_app_dependencies.status` (`varchar(16)`, plan §3.2:210). */
export const APP_DEPENDENCY_STATUSES = [
	'pending',
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
