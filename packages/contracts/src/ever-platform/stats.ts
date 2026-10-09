/**
 * Anonymous usage statistics (`ever.stats.v1`) — the shared vocabulary of the
 * Works statistics module, its `stats-sink` capability and the settings page.
 *
 * The contract itself (the schema, its fixtures and the wire constants) is the
 * published `@ever-co/connect-contracts` package, pinned to one exact version;
 * nothing of it is copied into this repository. This file only carries the
 * names, limits and shapes the code is written against: the header names and
 * limits below are read from that package's `CONSTANTS`, and the literal ids
 * are type-checked against its types.
 *
 * Nothing in a report can identify a person or an organization: every string is
 * fixed by a constant, an enumeration or a bounded pattern, and every map key
 * comes from one of the closed lists below (an unknown value is counted under
 * `other`, never as its own key).
 */
import { CONSTANTS, type paths, type StatsReportV1 } from '@ever-co/connect-contracts';

/** The schema id, the value of the report's `schema` field. */
export const EVER_STATS_V1_SCHEMA_ID = 'ever.stats.v1' as const satisfies StatsReportV1['schema'];

/** Where a report is sent, relative to the statistics base URL. */
export const EVER_STATS_REPORTS_PATH = '/v1/stats/reports' as const satisfies keyof paths;

/** The default base URL when neither `EVER_STATS_API_URL` nor `EVER_PLATFORM_API_URL` is set. */
export const EVER_PLATFORM_DEFAULT_API_URL = 'https://api.ever.co' as const;

/** Request headers of `POST /v1/stats/reports`: the public key and the signature over the exact body. */
export const EVER_STATS_KEY_HEADER = CONSTANTS.stats_headers.key;
export const EVER_STATS_SIGNATURE_HEADER = CONSTANTS.stats_headers.signature;
/** Optional: base64url of the first 8 bytes of SHA-256 over the 32 public key bytes. */
export const EVER_STATS_KEY_ID_HEADER = CONSTANTS.stats_headers.key_id;
/** The signature header value is this prefix followed by the base64url (no padding) signature. */
export const EVER_STATS_SIGNATURE_PREFIX = CONSTANTS.stats_signature_prefix;

/** The largest body Ever Platform accepts (16 KiB); a larger report is never sent. */
export const EVER_STATS_MAX_BODY_BYTES: number = CONSTANTS.stats.max_bytes;

/**
 * The published schema this module is built against: the package and the file
 * in it, and the file's SHA-256 (the value of the platform's `ETag`). A drift
 * test fails when the installed package's file no longer hashes to this value,
 * so a version bump that changes the schema is a deliberate change here.
 */
export const EVER_STATS_V1_SOURCE = {
	package: '@ever-co/connect-contracts',
	path: 'schemas/ever.stats.v1.json',
	sha256: '0cd746f7dec75117a6b812b7a832f9ceca4c97a6ecf65d22d6967a6475efc6e5'
} as const;

/**
 * Whether an `http:` statistics base URL is acceptable for `hostname`: only a
 * host that cannot be a public internet name — loopback, private /
 * unique-local literals, `*.localhost`, or a single-label name such as a
 * compose service (`mock-platform`). Every other host must be `https:`.
 * Link-local addresses (`169.254.0.0/16`, `fe80::/10`) are refused: no
 * statistics receiver lives there, and that range holds cloud metadata
 * services.
 */
export function isPrivateStatsHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host === '::1') return true;
	if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
	const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const a = Number(ipv4[1]);
		const b = Number(ipv4[2]);
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
	}
	// A single-label name resolves only through a local resolver (compose or
	// cluster service names); it can never be a public internet host.
	return host.length > 0 && !host.includes('.') && !host.includes(':');
}

/**
 * Validate and normalise a statistics base URL (no trailing slash), or `null`
 * when it is refused: not `https:` (except a private host over `http:`), or
 * carrying credentials, a query or a fragment.
 */
export function normaliseStatsBaseUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.username || url.password || url.search || url.hash) return null;
	if (url.protocol === 'http:') {
		if (!isPrivateStatsHost(url.hostname)) return null;
	} else if (url.protocol !== 'https:') {
		return null;
	}
	return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export const EVER_STATS_PRODUCTS = ['gauzy', 'teams', 'works', 'rec', 'traduora'] as const satisfies ReadonlyArray<
	StatsReportV1['product']
>;
export type EverStatsProduct = (typeof EVER_STATS_PRODUCTS)[number];

export const EVER_STATS_CHANNELS = ['stable', 'rc', 'beta', 'dev', 'custom'] as const satisfies ReadonlyArray<
	StatsReportV1['channel']
>;
export type EverStatsChannel = (typeof EVER_STATS_CHANNELS)[number];

export type EverStatsInstanceKind = StatsReportV1['instance_kind'];

/** `counts.works_by_kind` keys, in the schema's order. */
export const WORKS_STATS_WORK_KIND_KEYS = [
	'website',
	'landing_page',
	'blog',
	'directory',
	'awesome_repo',
	'repo',
	'company',
	'campaign',
	'default',
	'app',
	'other'
] as const;
export type WorksStatsWorkKindKey = (typeof WORKS_STATS_WORK_KIND_KEYS)[number];

/** `aggregates.deployments_by_provider` keys, in the schema's order. */
export const WORKS_STATS_DEPLOYMENT_PROVIDER_KEYS = [
	'ever_works',
	'vercel',
	'k8s',
	'your_cluster',
	'ever_works_apps',
	'other'
] as const;
export type WorksStatsDeploymentProviderKey = (typeof WORKS_STATS_DEPLOYMENT_PROVIDER_KEYS)[number];

/** `features` keys of a Works report, in the schema's order. */
export const WORKS_STATS_FEATURE_KEYS = [
	'app_works_enabled',
	'app_launcher_enabled',
	'dynamic_plugins',
	'deploy_ever_works_enabled',
	'subscriptions_enabled',
	'mcp_enabled'
] as const;
export type WorksStatsFeatureKey = (typeof WORKS_STATS_FEATURE_KEYS)[number];

/** Installation-wide totals at build time. */
export interface WorksStatsCounts {
	users: number;
	tenants: number;
	organizations: number;
	works: number;
	agents: number;
	missions: number;
	teams: number;
	fleet_nodes: number;
	plugins_enabled: number;
	works_by_kind: Record<WorksStatsWorkKindKey, number>;
}

export type WorksStatsFeatures = Record<WorksStatsFeatureKey, boolean>;

/** Totals over the report's period (one UTC month). */
export interface WorksStatsAggregates {
	deployments: number;
	deployments_by_provider: Record<WorksStatsDeploymentProviderKey, number>;
	runs: number;
	credits_consumed: number;
}

/** The envelope of every `ever.stats.v1` report. */
export interface EverStatsV1Report<
	C = Record<string, unknown>,
	F = Record<string, boolean>,
	A = Record<string, unknown>
> {
	schema: typeof EVER_STATS_V1_SCHEMA_ID;
	report_id: string;
	instance_id: string;
	/** UTC date `YYYY-MM-DD`; no time of day. */
	sent_at: string;
	module_version: string;
	product: EverStatsProduct;
	instance_kind: EverStatsInstanceKind;
	serves: EverStatsProduct[];
	version: string;
	channel: EverStatsChannel;
	install_source: string;
	country: string;
	/** UTC month `YYYY-MM`. */
	period: string;
	final: boolean;
	counts: C;
	features: F;
	aggregates: A;
}

export type WorksStatsV1Report = EverStatsV1Report<WorksStatsCounts, WorksStatsFeatures, WorksStatsAggregates>;

/**
 * A report ready to leave the instance: the exact bytes that were signed and
 * the headers carrying the public key and the signature. Only this object
 * crosses into a `stats-sink` provider, so nothing is ever re-serialised after
 * signing.
 */
export interface SignedStatsReport {
	readonly body: Uint8Array;
	readonly headers: Readonly<Record<string, string>>;
	readonly reportId: string;
	readonly period: string;
	readonly final: boolean;
}

/** What happened to one send. */
export type StatsSendStatus = 'sent' | 'rejected' | 'failed';

/** Closed reasons a send did not end as `sent`. */
export const STATS_SEND_ERROR_CODES = [
	'schema_violation',
	'key_mismatch',
	'too_large',
	'signature_invalid',
	'validation_failed',
	'unsupported_media_type',
	'rate_limited',
	'server_error',
	'http_error',
	'network',
	'timeout',
	'invalid_url',
	'redirect',
	'sink_unavailable',
	'build_failed',
	'key_unreadable'
] as const;
export type StatsSendErrorCode = (typeof STATS_SEND_ERROR_CODES)[number];

/** One refused field, as the ingest reports it: a JSON pointer and a closed code, never a value. */
export interface StatsSendFieldError {
	path: string;
	code: string | null;
}

export interface StatsSendResult {
	status: StatsSendStatus;
	/** The HTTP status, or `null` when no answer arrived. */
	httpStatus: number | null;
	errorCode: StatsSendErrorCode | null;
	/** `202 {"superseded":true}`: an earlier report for the same period and day was replaced. */
	superseded?: boolean;
	errors?: StatsSendFieldError[];
	/** A `Retry-After` the receiver asked for (seconds), on a `failed` send. */
	retryAfterS?: number;
}

// ---------------------------------------------------------------------------
// The operator API (`/api/instance-stats/*`) — shared with the settings page.
// ---------------------------------------------------------------------------

/**
 * Why statistics are (not) being sent: `on`, switched off by the operator in
 * Settings (`ui`), the statistics key cannot be read (`key_unreadable`: the
 * encryption key it was stored with is missing or changed), the sender plugin
 * is not available (`sink_unavailable`), or the instance is operated by Ever
 * Cloud (`cloud-managed`, reported while on). `env` (not switched on by
 * `EVER_STATS_ENABLED`, the default) never reaches the API — the module is not
 * loaded, so its routes answer 404 — and is listed so the page can name that
 * state.
 */
export type InstanceStatsReason = 'on' | 'env' | 'ui' | 'cloud-managed' | 'key_unreadable' | 'sink_unavailable';

/** Who holds the switch: Ever Cloud for a cloud installation, the instance operator otherwise. */
export type InstanceStatsManagedBy = 'cloud' | 'operator';

/**
 * What any signed-in person may read: whether statistics are on and who
 * manages them — nothing from any report.
 */
export interface InstanceStatsPublicStatus {
	enabled: boolean;
	managedBy: InstanceStatsManagedBy;
}

/** One stored send, as the operator sees it. `payload` is the exact body that was posted. */
export interface InstanceStatsReportView {
	reportId: string;
	period: string;
	final: boolean;
	status: StatsSendStatus;
	httpStatus: number | null;
	errorCode: StatsSendErrorCode | null;
	errors: StatsSendFieldError[];
	/** ISO timestamp of the attempt. */
	attemptedAt: string;
	bytes: number;
	payload: string;
}

export interface InstanceStatsOperatorStatus extends InstanceStatsPublicStatus {
	operator: true;
	reason: InstanceStatsReason;
	/** The operator switch in Settings (stored on the instance row). */
	uiEnabled: boolean;
	installSource: string;
	country: string;
	statsApiUrl: string;
	instanceId: string;
	resetCount: number;
	/** ISO timestamp of the next scheduled send, or `null` while switched off. */
	nextSendAt: string | null;
	sinkAvailable: boolean;
	/**
	 * Whether the statistics private key is stored wrapped with
	 * `PLUGIN_SECRET_ENCRYPTION_KEY`; `false` = stored unencrypted, set the key.
	 */
	keyStoredEncrypted: boolean;
	lastReport: Omit<InstanceStatsReportView, 'payload'> | null;
	/** ISO timestamp from which *Send now* is allowed again, or `null`. */
	sendNowAvailableAt: string | null;
}

export type InstanceStatsStatus = InstanceStatsPublicStatus | InstanceStatsOperatorStatus;

export function isInstanceStatsOperatorStatus(status: InstanceStatsStatus): status is InstanceStatsOperatorStatus {
	return (status as Partial<InstanceStatsOperatorStatus>).operator === true;
}
