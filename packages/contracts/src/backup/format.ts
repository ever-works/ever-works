/**
 * Workspace backup (AW-22) — the published archive format.
 *
 * A workspace backup is a single dated `.zip` holding every domain Ever Works
 * stores on a workspace's behalf, written as newline-delimited JSON next to a
 * manifest that says exactly what is inside, what was trimmed and why, and
 * which parts can be restored. This module is the ONE place that enumerates
 * the domains, their restorability classes, the trim windows and the version
 * constant, so the writer, the manifest, the API, the web report and the
 * published field reference all read the same source and cannot drift.
 *
 * Types and frozen data only — no TypeORM, no NestJS, no Node built-ins —
 * because `apps/web` imports this module directly.
 *
 * This is deliberately NOT the existing account export
 * (`packages/agent/src/account-transfer/account-export.service.ts`). That
 * path answers "give me a small, hand-editable JSON of these opt-in
 * sections", still ships unchanged, and is the right tool for moving a
 * couple of Works between environments. The archive described here answers
 * "give me everything, with evidence of what everything means".
 */

/**
 * The format version written into every manifest, as `major.minor`.
 *
 * Adding a domain or a field is a MINOR bump and never breaks an older
 * reader: a reader skips descriptors it does not recognise and reports them
 * as "not supported by this version". Removing or repurposing either is a
 * MAJOR bump. A build reads any archive at or below its own version and
 * refuses to RESTORE a higher one while still describing it.
 */
export const BACKUP_FORMAT_VERSION = '1.0';

/**
 * The sentinel field every Ever Works manifest carries, and the first of the
 * two fields a check refuses on when they are both absent (the other being
 * `producedAt`). Named explicitly so the refusal can tell the reader what it
 * looked for rather than showing a parse error.
 */
export const BACKUP_FORMAT_SENTINEL = 'everworks-workspace-backup';

/** The two field names a manifest check looks for before anything else. */
export const BACKUP_MANIFEST_SENTINEL_FIELDS: readonly string[] = ['everworksBackupFormat', 'producedAt'];

/**
 * The fifteen domains of the archive. Every one is present in every
 * manifest with a status, so a reader can always tell "you have none of
 * these" from "we did not export these".
 */
export type BackupDomainKey =
	| 'account'
	| 'organizations'
	| 'agents'
	| 'missions'
	| 'tasks'
	| 'works'
	| 'knowledge'
	| 'schedules'
	| 'runs'
	| 'decisions'
	| 'communication'
	| 'connections'
	| 'fleet'
	| 'billing'
	| 'activity';

/**
 * How one domain came out.
 *
 * - `complete` — everything the workspace holds is in the archive.
 * - `trimmed` — complete within the history window that was applied.
 * - `partial` — some record types landed and at least one did not.
 * - `failed` — the domain could not be written; the archive still finished.
 * - `empty` — the workspace holds nothing in this domain.
 */
export type BackupDomainStatus = 'complete' | 'trimmed' | 'partial' | 'failed' | 'empty';

/**
 * What a restore can do with a domain.
 *
 * - `restorable` — recreated in the target workspace.
 * - `record-only` — exported as evidence and never written back. Runs,
 *   decisions, money and the activity history describe a past that did not
 *   happen in the target workspace; writing them would fabricate one.
 * - `partly-restorable` — some record types are recreated and some are a
 *   record only (Communication: addresses and preferences yes, message
 *   history no; Fleet: preferences yes, the machine inventory no).
 */
export type BackupRestorability = 'restorable' | 'record-only' | 'partly-restorable';

/** Why an uploaded file's bytes are described but not included. */
export type BackupOmissionReason = 'size_limit' | 'file_missing' | 'unreadable';

/**
 * A bounded history window. `defaultDays` applies to an ordinary backup;
 * `fullHistoryDays` applies when the owner ticks "Include full history".
 * Lifting the window never adds a domain that would otherwise be excluded,
 * and never changes the per-file or archive size limits.
 */
export interface BackupTrimWindow {
	/** The timestamp column the cutoff is measured against. */
	readonly field: string;
	readonly defaultDays: number;
	readonly fullHistoryDays: number;
}

/**
 * The trim policies, one per history-shaped record type.
 *
 * Trimming is per record type rather than per domain because the domains are
 * not uniform: "Runs and receipts" holds run rows that are never trimmed, run
 * logs trimmed at 90 days and terminal transcripts trimmed at 30. Each
 * collector names the policy each of its files uses, and every applied trim
 * is recorded in the manifest with its cutoff and the number of rows omitted.
 *
 * Everything not covered by a policy is exported in full regardless of age.
 */
export const BACKUP_TRIM_POLICIES = Object.freeze({
	activity: Object.freeze({ field: 'createdAt', defaultDays: 365, fullHistoryDays: 1095 }),
	runLogs: Object.freeze({ field: 'createdAt', defaultDays: 90, fullHistoryDays: 1095 }),
	terminalTranscripts: Object.freeze({ field: 'createdAt', defaultDays: 30, fullHistoryDays: 365 }),
	notifications: Object.freeze({ field: 'createdAt', defaultDays: 180, fullHistoryDays: 1095 }),
	// `occurredAt`, not `createdAt`: `PluginUsageEvent` names its
	// `@CreateDateColumn` `occurredAt` and has no `createdAt` at all. The trim
	// resolver fails OPEN on an unknown column, so the wrong name here did not
	// error — it silently exported every plugin usage event for the lifetime
	// of the workspace, from the archive's single largest history table, while
	// the docs page published a 180-day window.
	pluginUsageEvents: Object.freeze({ field: 'occurredAt', defaultDays: 180, fullHistoryDays: 1095 }),
	deliveryLogs: Object.freeze({ field: 'createdAt', defaultDays: 30, fullHistoryDays: 365 }),
	// `firedAt`, for the same reason: `InboundTriggerFire`'s creation
	// timestamp is `firedAt` and it has no `createdAt`, so the declared
	// 90-day window was never applied to `data/schedules/trigger-fires.jsonl`
	// and the `schedules` domain reported `complete` where the docs promise a
	// trim.
	triggerFires: Object.freeze({ field: 'firedAt', defaultDays: 90, fullHistoryDays: 1095 }),
	retrievalTrail: Object.freeze({ field: 'createdAt', defaultDays: 30, fullHistoryDays: 365 }),
	fleetJobs: Object.freeze({ field: 'createdAt', defaultDays: 30, fullHistoryDays: 365 })
}) as Readonly<Record<string, BackupTrimWindow>>;

/** The trim policy names, as a value so a reader can enumerate them. */
export type BackupTrimPolicyKey = keyof typeof BACKUP_TRIM_POLICIES;

/** The ceiling "Include full history" lifts every window to, in days. */
export const BACKUP_FULL_HISTORY_CEILING_DAYS = 1095;

/**
 * One domain's fixed description: what it is called, whether a restore can
 * write it, which directory it occupies inside `data/`, and the collector
 * that produces it.
 */
export interface BackupDomainDescriptor {
	readonly key: BackupDomainKey;
	readonly restorability: BackupRestorability;
	/**
	 * The id the agent-side collector registry must register under. Equal to
	 * the key today; carried separately so the registry has a contract-side
	 * anchor and a domain can never be listed with nothing to produce it.
	 */
	readonly collectorId: string;
	/** Directory under `data/` holding this domain's `*.jsonl` files. */
	readonly dataDir: string;
	/**
	 * The domain-wide trim policy, when every record type in the domain
	 * shares one. Domains whose record types trim differently leave this
	 * unset and name a policy per file instead.
	 */
	readonly trim?: BackupTrimWindow;
}

/**
 * The fifteen domains, in manifest order. The ONLY enumeration of them.
 *
 * Adding a domain here without a collector fails the agent-side registry
 * spec, and adding one without a translated label fails the web card's spec
 * — which is the point: a domain that exists in the format but produces
 * nothing is exactly the silent gap this epic exists to remove.
 */
export const BACKUP_DOMAINS: readonly BackupDomainDescriptor[] = Object.freeze([
	Object.freeze({
		key: 'account' as const,
		restorability: 'restorable' as const,
		collectorId: 'account',
		dataDir: 'account'
	}),
	Object.freeze({
		key: 'organizations' as const,
		restorability: 'restorable' as const,
		collectorId: 'organizations',
		dataDir: 'organizations'
	}),
	Object.freeze({
		key: 'agents' as const,
		restorability: 'restorable' as const,
		collectorId: 'agents',
		dataDir: 'agents'
	}),
	Object.freeze({
		key: 'missions' as const,
		restorability: 'restorable' as const,
		collectorId: 'missions',
		dataDir: 'missions'
	}),
	Object.freeze({
		key: 'tasks' as const,
		restorability: 'restorable' as const,
		collectorId: 'tasks',
		dataDir: 'tasks'
	}),
	Object.freeze({
		key: 'works' as const,
		restorability: 'restorable' as const,
		collectorId: 'works',
		dataDir: 'works'
	}),
	Object.freeze({
		key: 'knowledge' as const,
		restorability: 'restorable' as const,
		collectorId: 'knowledge',
		dataDir: 'knowledge'
	}),
	Object.freeze({
		key: 'schedules' as const,
		restorability: 'restorable' as const,
		collectorId: 'schedules',
		dataDir: 'schedules'
	}),
	Object.freeze({
		key: 'runs' as const,
		restorability: 'record-only' as const,
		collectorId: 'runs',
		dataDir: 'runs'
	}),
	Object.freeze({
		key: 'decisions' as const,
		restorability: 'record-only' as const,
		collectorId: 'decisions',
		dataDir: 'decisions'
	}),
	Object.freeze({
		key: 'communication' as const,
		restorability: 'partly-restorable' as const,
		collectorId: 'communication',
		dataDir: 'communication'
	}),
	Object.freeze({
		key: 'connections' as const,
		restorability: 'restorable' as const,
		collectorId: 'connections',
		dataDir: 'connections'
	}),
	Object.freeze({
		key: 'fleet' as const,
		restorability: 'partly-restorable' as const,
		collectorId: 'fleet',
		dataDir: 'fleet'
	}),
	Object.freeze({
		key: 'billing' as const,
		restorability: 'record-only' as const,
		collectorId: 'billing',
		dataDir: 'billing'
	}),
	Object.freeze({
		key: 'activity' as const,
		restorability: 'record-only' as const,
		collectorId: 'activity',
		dataDir: 'activity',
		trim: BACKUP_TRIM_POLICIES.activity
	})
]);

/** Every domain key, in manifest order. */
export const BACKUP_DOMAIN_KEYS: readonly BackupDomainKey[] = Object.freeze(BACKUP_DOMAINS.map((domain) => domain.key));

/** How many domains a manifest must describe. Stored on the record too, so an old row stays legible. */
export const BACKUP_DOMAIN_COUNT = BACKUP_DOMAINS.length;

/** Look one domain descriptor up by key. */
export function getBackupDomain(key: BackupDomainKey): BackupDomainDescriptor | undefined {
	return BACKUP_DOMAINS.find((domain) => domain.key === key);
}

/**
 * The nine categories that never appear in an archive, in any form, at any
 * option setting. The manifest carries this list verbatim so the archive
 * states its own omissions rather than being quietly incomplete, and the
 * coverage drawer renders the same list from the same source.
 */
export type BackupExclusionCode =
	| 'auth_tokens'
	| 'sessions'
	| 'api_key_material'
	| 'stored_credentials'
	| 'node_enrolment_secrets'
	| 'payment_identifiers'
	| 'platform_admin_flag'
	| 'vector_embeddings'
	| 'internal_caches';

export interface BackupExclusion {
	readonly code: BackupExclusionCode;
	/**
	 * Plain-English summary written into `manifest.json` and `README.md`.
	 * English only: it is a file inside the archive, not interface copy. The
	 * card and the coverage drawer render their own translated strings keyed
	 * off `code`.
	 */
	readonly summary: string;
}

export const BACKUP_EXCLUSIONS: readonly BackupExclusion[] = Object.freeze([
	Object.freeze({
		code: 'auth_tokens' as const,
		summary: 'Password hashes, password-reset tokens, magic-link tokens and email-verification tokens.'
	}),
	Object.freeze({
		code: 'sessions' as const,
		summary: 'Sessions, refresh tokens, and third-party auth provider access and refresh tokens.'
	}),
	Object.freeze({
		code: 'api_key_material' as const,
		summary: 'API key material. Keys appear as name, prefix, created date and active flag only.'
	}),
	Object.freeze({
		code: 'stored_credentials' as const,
		summary:
			'Every stored credential, in plaintext or ciphertext — plugin secrets, connection headers, deployment secrets, webhook and trigger signing secrets, and encrypted runtime credentials. Only the names of the fields that were set are exported.'
	}),
	Object.freeze({
		code: 'node_enrolment_secrets' as const,
		summary: 'Node enrolment and heartbeat secrets.'
	}),
	Object.freeze({
		code: 'payment_identifiers' as const,
		summary: 'Payment-provider customer, subscription, payment-method and meter identifiers.'
	}),
	Object.freeze({
		code: 'platform_admin_flag' as const,
		summary: 'The platform-administrator flag.'
	}),
	Object.freeze({
		code: 'vector_embeddings' as const,
		summary: 'Vector embeddings and their coordinates, because they are derived and regenerate on demand.'
	}),
	Object.freeze({
		code: 'internal_caches' as const,
		summary: 'Internal caches and the delivery outbox.'
	})
]);

/** One `*.jsonl` file inside a domain directory, as the manifest describes it. */
export interface BackupFileReport {
	/** Archive-relative path, e.g. `data/runs/run-logs.jsonl`. */
	readonly name: string;
	readonly records: number;
	readonly sha256: string;
}

/** A trim that was actually applied, with the cutoff it used. */
export interface BackupTrimReport {
	readonly field: string;
	/** ISO-8601 instant; rows older than this were left out. */
	readonly cutoff: string;
	readonly omittedRecords: number;
}

/** One of the fifteen rows of the coverage table. */
export interface BackupDomainReport {
	readonly key: BackupDomainKey;
	readonly status: BackupDomainStatus;
	readonly restorability: BackupRestorability;
	readonly records: number;
	readonly files: readonly BackupFileReport[];
	readonly trims?: readonly BackupTrimReport[];
	/** Present only when `status` is `failed` or `partial`. */
	readonly error?: { readonly code: string };
}

/** An uploaded file that is described by its metadata row but has no bytes in the archive. */
export interface BackupOmission {
	readonly id: string;
	readonly name: string;
	readonly sizeBytes: number;
	readonly reason: BackupOmissionReason;
}

/** Who produced the archive, and for which workspace. */
export interface BackupWorkspaceIdentity {
	readonly id: string;
	readonly slug: string;
	readonly displayName: string;
	readonly kind: 'organization' | 'personal';
}

export interface BackupAccountIdentity {
	readonly id: string;
	readonly displayName: string;
	readonly email: string;
}

/**
 * `manifest.json`. An archive found on a disk years later identifies itself
 * from this alone: which workspace, which account, which build, what it
 * holds, what was trimmed, what was left out and what a restore could do
 * with it.
 */
export interface BackupManifest {
	/** Always {@link BACKUP_FORMAT_SENTINEL}. The first thing a check looks for. */
	readonly everworksBackupFormat: string;
	readonly formatVersion: string;
	/** ISO-8601 instant. The second thing a check looks for. */
	readonly producedAt: string;
	readonly producedBy: { readonly build: string; readonly instance?: string };
	readonly workspace: BackupWorkspaceIdentity;
	readonly account: BackupAccountIdentity;
	readonly options: { readonly includeFullHistory: boolean };
	/** Always all fifteen, in {@link BACKUP_DOMAINS} order. */
	readonly domains: readonly BackupDomainReport[];
	readonly files: {
		readonly included: number;
		readonly bytes: number;
		readonly omitted: readonly BackupOmission[];
	};
	readonly exclusions: readonly BackupExclusion[];
	readonly totals: { readonly records: number; readonly bytes: number };
}

/**
 * The manifest as it is kept on the backup record after the archive itself
 * has expired, so history stays legible for the ninety days the record
 * outlives its bytes. Same content minus the per-file omission list, which
 * is the only unbounded part.
 */
export type BackupManifestSummary = Omit<BackupManifest, 'files'> & {
	readonly files: { readonly included: number; readonly bytes: number; readonly omitted: number };
};

/** What a restore would do with one domain of a checked archive. */
export type BackupCheckOutcome = 'restored' | 'record-only' | 'not-present';

export interface BackupCheckDomainRow {
	readonly key: BackupDomainKey;
	readonly outcome: BackupCheckOutcome;
	readonly records: number;
	readonly status?: BackupDomainStatus;
	/** Set when the archive names a domain this build does not recognise. */
	readonly unsupported?: boolean;
}

/** Something a restore cannot do for the owner, listed before anything is written. */
export interface BackupCheckFollowUp {
	readonly kind: 'credentials' | 'nodes' | 'schedules';
	readonly count: number;
}

/**
 * The report a manifest check produces. Nothing is written to produce it, and
 * the full archive is never uploaded — only the manifest is read.
 */
export interface BackupCheckReport {
	readonly formatVersion: string;
	readonly producedAt: string;
	readonly workspace: BackupWorkspaceIdentity;
	/** `false` when the archive was made by a newer build: described, never applied. */
	readonly restorable: boolean;
	readonly formatComparison: 'older' | 'same' | 'newer';
	readonly domains: readonly BackupCheckDomainRow[];
	readonly followUps: readonly BackupCheckFollowUp[];
	readonly totals: {
		readonly restoredDomains: number;
		readonly restoredRecords: number;
		readonly recordOnlyDomains: number;
		readonly recordOnlyRecords: number;
		readonly notPresentDomains: number;
	};
}

/**
 * The defaults every limit in the format ships with.
 *
 * A deployment may change all of them; the interface reads the values in
 * force from the API rather than repeating these numbers, so a operator who
 * shortens retention does not leave the card telling people fourteen days.
 */
export const BACKUP_DEFAULT_LIMITS = Object.freeze({
	/** Ready archives kept for this long before their bytes are deleted. */
	retentionDays: 14,
	/** The record outlives its bytes by this long, so history stays legible. */
	recordRetentionDays: 90,
	/** Ready outcomes allowed per rolling 24 hours. Failures do not count. */
	dailyAllowance: 3,
	/** Rows the history list shows before "Show all". */
	historyPageSize: 20,
	/** Hard ceiling on a single history page. */
	historyPageLimit: 50,
	/** Bytes of one uploaded file that may be carried (200 MiB). */
	maxFileBytes: 200 * 1024 * 1024,
	/** Bytes of uploaded files in total (2 GiB). */
	maxAttachmentBytes: 2 * 1024 * 1024 * 1024,
	/** Bytes the finished archive may not exceed with a streaming backend (5 GiB). */
	maxArchiveBytes: 5 * 1024 * 1024 * 1024,
	/**
	 * The ceiling when the active storage backend cannot accept a stream and
	 * the archive has to be handed over as one buffer (512 MiB). A backend
	 * without streaming is a smaller limit, never a wrong result.
	 */
	maxBufferedArchiveBytes: 512 * 1024 * 1024,
	/** A manifest larger than this is refused by the check without being read (8 MiB). */
	maxManifestBytes: 8 * 1024 * 1024,
	/** Minutes a download link stays valid before the client re-mints it. */
	downloadLinkTtlMinutes: 15,
	/** Minutes without a heartbeat before a running backup is called stalled. */
	stallMinutes: 10,
	/** Minutes a queued backup may wait before it is called stalled. */
	queuedStallMinutes: 15,
	/** Minutes a backup may run before it is stopped. */
	timeoutMinutes: 60,
	/** Retries a single domain gets before it is marked failed and the archive finishes without it. */
	domainRetries: 2,
	/** Retries a storage write gets before the backup fails as `storage_unavailable`. */
	storageRetries: 3
});

/** The archive filename, `everworks-backup-<slug>-<YYYY-MM-DD>-<shortId>.zip`. */
export function buildBackupArchiveFilename(slug: string, isoDate: string, shortId: string): string {
	const safeSlug = slug.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
	return `everworks-backup-${safeSlug}-${isoDate.slice(0, 10)}-${shortId}.zip`;
}

/**
 * Compare a manifest's `major.minor` against this build's.
 *
 * `newer` is the only answer that blocks a restore; `older` and `same` are
 * both read, so an archive taken before a domain existed still restores
 * everything it does contain.
 */
export function compareBackupFormatVersion(
	candidate: string,
	current: string = BACKUP_FORMAT_VERSION
): 'older' | 'same' | 'newer' | 'unparseable' {
	const parse = (value: string): [number, number] | null => {
		const match = /^(\d+)\.(\d+)$/.exec(value.trim());
		return match ? [Number(match[1]), Number(match[2])] : null;
	};
	const a = parse(candidate);
	const b = parse(current);
	if (!a || !b) return 'unparseable';
	if (a[0] !== b[0]) return a[0] > b[0] ? 'newer' : 'older';
	if (a[1] !== b[1]) return a[1] > b[1] ? 'newer' : 'older';
	return 'same';
}
