/**
 * Usage & cost on the fleet (FL-20, CONTRACTS R-13, R-30, R-34, §1.1, §1.2,
 * §4.2, §4.10, §12) — the shared vocabulary of the node's opt-in transcript
 * scan and of every surface that shows what the fleet's model work would
 * cost.
 *
 * The MACHINE counts, the PLATFORM attributes and prices:
 *
 *  - a node started with `--usage-scan` reads the Claude Code and Codex
 *    records on that computer and reports COUNTS only — model, token counts
 *    by class, request count, the hour, the CLI's own session id and a folder
 *    bucket (a known checkout or allowed root; any other folder is an opaque
 *    `other:<hash>`). Never a prompt, an output, a tool result or a file;
 *  - each report is the result of one durable `usage-scan` job leased by the
 *    node's management lane (R-34);
 *  - the platform attributes rows to a Session by the provider session id
 *    (then to a Task run by `AgentRun.fleetCliSession`), prices them at LIST
 *    price from a versioned table (`MODEL_LIST_PRICES`, R-30) and keeps what
 *    matched nothing as **other** on that computer.
 *
 * ## Idempotency (why rows are CUMULATIVE)
 *
 * A row is the node's running total for ONE bucket — provider × provider
 * session × model × hour × folder bucket — not the increment since the last
 * scan. The platform takes the per-field MAXIMUM of what it holds and what a
 * report says, so a re-sent report (a lost acknowledgement, a node that lost
 * its state and re-read everything) never double counts, and a deleted record
 * file never subtracts (spec FR-4, U4, U5).
 *
 * Every row carries the node's `rev` order implicitly: the report's
 * `watermark` is the highest bucket revision it carries, and the next job's
 * payload hands back the newest ACKNOWLEDGED watermark as `since`, so a node
 * re-sends exactly what the platform has not stored yet.
 */

// ─── Providers, capability, cadence ─────────────────────────────────────────

/** The two CLIs whose records the scan reads (spec §8: no other CLI in this epic). */
export type FleetUsageProvider = 'claude-code' | 'codex';

export const FLEET_USAGE_PROVIDERS: readonly FleetUsageProvider[] = ['claude-code', 'codex'];

export function isFleetUsageProvider(value: unknown): value is FleetUsageProvider {
	return typeof value === 'string' && (FLEET_USAGE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Capability tag (CONTRACTS §1.2) a node advertises only when it was started
 * with `--usage-scan` AND a supported CLI record folder exists on it. Required
 * by every `usage-scan` job, so the platform never asks a machine whose owner
 * did not opt in.
 */
export const FLEET_USAGE_SCAN_CAPABILITY = 'usage-scan';

/** How often the platform asks each opted-in, online computer for a scan (CONTRACTS §10). */
export const FLEET_USAGE_SCAN_INTERVAL_MS = 15 * 60 * 1000;

/** The dispatcher's cron expression — every 15 minutes. */
export const FLEET_USAGE_SCAN_CRON = '*/15 * * * *';

/**
 * Most rows one report carries. Bounded by the job result cap
 * (`FLEET_JOB_MAX_RESULT_BYTES`, 256 KiB): a row is ~330 bytes on the wire,
 * so 500 rows stay well under it. A larger backlog drains over several scans
 * (`truncated`, `backlogPct`; spec U11). The plan's 2 000 would not fit the
 * existing result cap — lane log decision.
 */
export const FLEET_USAGE_REPORT_MAX_ROWS = 500;

/** The node also trims a report to this many serialized bytes (a belt under the row cap). */
export const FLEET_USAGE_REPORT_MAX_BYTES = 192 * 1024;

/** The periods the Usage tab, the tool and the CLI accept (spec FR-12). */
export const FLEET_USAGE_PERIODS = [1, 7, 30, 90] as const;

export type FleetUsagePeriodDays = (typeof FLEET_USAGE_PERIODS)[number];

export function isFleetUsagePeriodDays(value: unknown): value is FleetUsagePeriodDays {
	return typeof value === 'number' && (FLEET_USAGE_PERIODS as readonly number[]).includes(value);
}

/** The default period of the tab, the tool and the CLI. */
export const FLEET_USAGE_DEFAULT_PERIOD: FleetUsagePeriodDays = 7;

// ─── The sentences every surface carries (spec FR-9, S1) ────────────────────

/**
 * The payer sentence (spec FR-9) — VERBATIM on the session card tooltip, the
 * Run receipt, the Usage tab and every tool's `note`. One constant so no
 * surface can drift from it.
 */
export const FLEET_USAGE_PAYER_NOTE =
	"List price — what this would cost on a pay-as-you-go key. The machine's own sign-in paid for it; Ever Works charged nothing.";

/** What the scan reads and what it never reads (spec S1) — the node's `status` prints it. */
export const FLEET_USAGE_PRIVACY_SENTENCE =
	'token counts, models and session ids from Claude Code and Codex records; never prompts, output or file contents';

/** The opt-in command for a computer (spec U1); `{name}` is the computer's name. */
export function fleetUsageOptInHint(nodeName: string): string {
	return `Usage scan is off — run \`ever-works-node start --usage-scan\` on ${nodeName}`;
}

// ─── The node's report (the `usage-scan` job result) ───────────────────────

/** Token counts by class. Non-negative integers. */
export interface FleetUsageTokens {
	/** Uncached input tokens. */
	in: number;
	out: number;
	cacheRead: number;
	cacheWrite: number;
}

export const FLEET_USAGE_ZERO_TOKENS: Readonly<FleetUsageTokens> = Object.freeze({
	in: 0,
	out: 0,
	cacheRead: 0,
	cacheWrite: 0
});

/** Folder buckets that are not a known checkout or root: `other:` + 8 hex characters of a hash. */
export const FLEET_USAGE_OTHER_FOLDER_PREFIX = 'other:';

/**
 * One bucket's CUMULATIVE counts (see the module comment): provider ×
 * provider session × model × hour × folder bucket.
 */
export interface FleetUsageRow {
	provider: FleetUsageProvider;
	/** The CLI's own session id; null when the record carried none. */
	providerSessionId: string | null;
	/** The model id as the CLI recorded it. */
	model: string;
	/** The hour the records fall in (ISO, minutes and seconds zero), by the RECORD's timestamp (U12). */
	bucketStart: string;
	/** A known checkout or allowed root path, `other:<hash8>`, or null when the record named no folder. */
	folderBucket: string | null;
	tokens: FleetUsageTokens;
	requests: number;
	/** Earliest and latest record time in the bucket (ISO). */
	firstAt: string;
	lastAt: string;
}

/** What one scan counted — for the node's own metrics and the platform's log line. */
export interface FleetUsageScanStats {
	files: number;
	recordsScanned: number;
	deduplicated: number;
	/** Lines that were not JSON or not a usage record. */
	skippedLines: number;
	/** Lines longer than the reader's cap, skipped without being parsed. */
	oversizeLines: number;
	durationMs: number;
}

export interface FleetUsageReport {
	/** The highest bucket revision in `rows` (or the payload's `since` when nothing changed). */
	watermark: number;
	rows: FleetUsageRow[];
	/** More changed buckets are waiting than this report could carry. */
	truncated: boolean;
	/**
	 * Percent of the record bytes on the machine NOT yet read (0 = caught up).
	 * The tab shows `100 - backlogPct` as "catching up · N % scanned" (U11).
	 */
	backlogPct: number;
	stats?: FleetUsageScanStats;
}

/** The `usage-scan` job payload: the newest watermark the platform has stored, or null. */
export interface FleetUsageScanPayload {
	since: number | null;
}

/** Longest model id kept (a CLI's id is ~30 characters; anything longer is not a model id). */
export const FLEET_USAGE_MAX_MODEL_CHARS = 120;
/** Longest provider session id kept (CONTRACTS §4.2 `providerSessionId` is varchar(128)). */
export const FLEET_USAGE_MAX_SESSION_ID_CHARS = 128;
/** Longest folder bucket kept. */
export const FLEET_USAGE_MAX_FOLDER_CHARS = 1024;
/** No real bucket holds this many tokens of one class; a larger number is refused, not clamped. */
export const FLEET_USAGE_MAX_TOKENS = 1_000_000_000_000;

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OTHER_FOLDER_PATTERN = /^other:[0-9a-f]{8}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isFleetUsageModelId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= FLEET_USAGE_MAX_MODEL_CHARS &&
		MODEL_ID_PATTERN.test(value)
	);
}

export function isFleetUsageProviderSessionId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= FLEET_USAGE_MAX_SESSION_ID_CHARS &&
		SESSION_ID_PATTERN.test(value)
	);
}

/** An opaque `other:<hash8>` bucket, or an absolute POSIX / Windows path with no control characters. */
export function isFleetUsageFolderBucket(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > FLEET_USAGE_MAX_FOLDER_CHARS) return false;
	if (value.startsWith(FLEET_USAGE_OTHER_FOLDER_PREFIX)) return OTHER_FOLDER_PATTERN.test(value);
	if (CONTROL_CHARS.test(value)) return false;
	return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/** True for an `other:<hash8>` bucket ("other folders"). */
export function isFleetUsageOtherFolder(value: string | null | undefined): boolean {
	return typeof value === 'string' && OTHER_FOLDER_PATTERN.test(value);
}

function count(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > FLEET_USAGE_MAX_TOKENS) return null;
	return Math.floor(value);
}

function isoAt(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 40) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The start of the hour `ms` falls in (UTC). */
export function fleetUsageHourStart(ms: number): number {
	return Math.floor(ms / 3_600_000) * 3_600_000;
}

/** Read token counts off the wire; null when any class is not a non-negative count. */
export function normalizeFleetUsageTokens(raw: unknown): FleetUsageTokens | null {
	if (!raw || typeof raw !== 'object') return null;
	const source = raw as Record<string, unknown>;
	const tokens = {
		in: count(source.in ?? 0),
		out: count(source.out ?? 0),
		cacheRead: count(source.cacheRead ?? 0),
		cacheWrite: count(source.cacheWrite ?? 0)
	};
	if (tokens.in === null || tokens.out === null || tokens.cacheRead === null || tokens.cacheWrite === null) {
		return null;
	}
	return tokens as FleetUsageTokens;
}

/**
 * Read one row off the wire — field by field, every string checked against
 * its allow-list shape, nothing else kept. A row that fails any check is
 * dropped (the caller counts it), never repaired.
 */
export function normalizeFleetUsageRow(raw: unknown): FleetUsageRow | null {
	if (!raw || typeof raw !== 'object') return null;
	const source = raw as Record<string, unknown>;
	const provider = source.provider;
	const model = source.model;
	if (!isFleetUsageProvider(provider)) return null;
	if (!isFleetUsageModelId(model)) return null;
	const rawSession = source.providerSessionId;
	let providerSessionId: string | null = null;
	if (rawSession !== null && rawSession !== undefined) {
		if (!isFleetUsageProviderSessionId(rawSession)) return null;
		providerSessionId = rawSession;
	}
	const rawFolder = source.folderBucket;
	let folderBucket: string | null = null;
	if (rawFolder !== null && rawFolder !== undefined) {
		if (!isFleetUsageFolderBucket(rawFolder)) return null;
		folderBucket = rawFolder;
	}
	const bucketIso = isoAt(source.bucketStart);
	if (!bucketIso) return null;
	const bucketMs = Date.parse(bucketIso);
	if (fleetUsageHourStart(bucketMs) !== bucketMs) return null;
	const tokens = normalizeFleetUsageTokens(source.tokens);
	if (!tokens) return null;
	const requests = count(source.requests);
	if (requests === null) return null;
	const firstAt = isoAt(source.firstAt) ?? bucketIso;
	const lastAt = isoAt(source.lastAt) ?? firstAt;
	return {
		provider,
		providerSessionId,
		model,
		bucketStart: bucketIso,
		folderBucket,
		tokens,
		requests,
		firstAt,
		lastAt
	};
}

/** The result of normalizing a report: what is kept, and how many rows were refused. */
export interface FleetUsageReportReading {
	report: FleetUsageReport;
	droppedRows: number;
}

/**
 * Read a `usage-scan` job result. Null when it is not a report at all, or when
 * it carries more than {@link FLEET_USAGE_REPORT_MAX_ROWS} rows (the job
 * completion refuses it as `invalid`, plan §5).
 */
export function normalizeFleetUsageReport(raw: unknown): FleetUsageReportReading | null {
	if (!raw || typeof raw !== 'object') return null;
	const source = raw as Record<string, unknown>;
	if (!Array.isArray(source.rows) || source.rows.length > FLEET_USAGE_REPORT_MAX_ROWS) return null;
	const watermark = count(source.watermark);
	if (watermark === null) return null;
	const rows: FleetUsageRow[] = [];
	let droppedRows = 0;
	for (const candidate of source.rows) {
		const row = normalizeFleetUsageRow(candidate);
		if (row) rows.push(row);
		else droppedRows += 1;
	}
	const backlog = typeof source.backlogPct === 'number' && Number.isFinite(source.backlogPct) ? source.backlogPct : 0;
	const report: FleetUsageReport = {
		watermark,
		rows,
		truncated: source.truncated === true,
		backlogPct: Math.min(100, Math.max(0, Math.round(backlog)))
	};
	const stats = normalizeStats(source.stats);
	if (stats) report.stats = stats;
	return { report, droppedRows };
}

function normalizeStats(raw: unknown): FleetUsageScanStats | null {
	if (!raw || typeof raw !== 'object') return null;
	const source = raw as Record<string, unknown>;
	return {
		files: count(source.files) ?? 0,
		recordsScanned: count(source.recordsScanned) ?? 0,
		deduplicated: count(source.deduplicated) ?? 0,
		skippedLines: count(source.skippedLines) ?? 0,
		oversizeLines: count(source.oversizeLines) ?? 0,
		durationMs: count(source.durationMs) ?? 0
	};
}

/** Read a `usage-scan` payload; anything unusable is `{ since: null }` (the node resumes from its own state). */
export function normalizeFleetUsageScanPayload(raw: unknown): FleetUsageScanPayload {
	if (!raw || typeof raw !== 'object') return { since: null };
	const since = count((raw as Record<string, unknown>).since);
	return { since };
}

/** Field-wise maximum (the platform's merge rule — never double counts, never subtracts). */
export function maxFleetUsageTokens(a: FleetUsageTokens, b: FleetUsageTokens): FleetUsageTokens {
	return {
		in: Math.max(a.in, b.in),
		out: Math.max(a.out, b.out),
		cacheRead: Math.max(a.cacheRead, b.cacheRead),
		cacheWrite: Math.max(a.cacheWrite, b.cacheWrite)
	};
}

export function addFleetUsageTokens(a: FleetUsageTokens, b: FleetUsageTokens): FleetUsageTokens {
	return {
		in: a.in + b.in,
		out: a.out + b.out,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite
	};
}

export function totalFleetUsageTokens(tokens: FleetUsageTokens): number {
	return tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite;
}

// ─── What a Session carries (CONTRACTS §4.2 `tokens`, `costCents`) ──────────

/** One model's totals on a Session. */
export interface FleetSessionModelUsage extends FleetUsageTokens {
	requests: number;
	/** List-price cost of this model's tokens in cents, or null when the model is not in the price list. */
	costCents: number | null;
}

/**
 * `fleet_sessions.tokens` — the Session's usage, derived from its samples on
 * every report (never edited by hand). `costCents` beside it on the row is the
 * sum of the priced models, rounded; null when nothing could be priced.
 */
export interface FleetSessionUsage {
	byModel: Record<string, FleetSessionModelUsage>;
	/** The price-list version the figures used (FR-7). The newest one when samples span versions. */
	priceListVersion: number | null;
	/** Models with no list price — counted in tokens only, excluded from `costCents` (FR-8). */
	unknownModels: string[];
	requests: number;
	firstAt: string | null;
	lastAt: string | null;
	updatedAt: string;
}

/** Read `fleet_sessions.tokens`; null when the column holds nothing usable. */
export function parseFleetSessionUsage(raw: unknown): FleetSessionUsage | null {
	if (!raw || typeof raw !== 'object') return null;
	const source = raw as Record<string, unknown>;
	if (!source.byModel || typeof source.byModel !== 'object') return null;
	const byModel: Record<string, FleetSessionModelUsage> = {};
	for (const [model, value] of Object.entries(source.byModel as Record<string, unknown>)) {
		if (!isFleetUsageModelId(model)) continue;
		const tokens = normalizeFleetUsageTokens(value);
		if (!tokens) continue;
		const entry = value as Record<string, unknown>;
		byModel[model] = {
			...tokens,
			requests: count(entry.requests) ?? 0,
			costCents: typeof entry.costCents === 'number' && Number.isFinite(entry.costCents) ? entry.costCents : null
		};
	}
	const unknownModels = Array.isArray(source.unknownModels)
		? source.unknownModels.filter((model): model is string => isFleetUsageModelId(model))
		: [];
	return {
		byModel,
		priceListVersion: count(source.priceListVersion),
		unknownModels,
		requests: count(source.requests) ?? 0,
		firstAt: isoAt(source.firstAt),
		lastAt: isoAt(source.lastAt),
		updatedAt: isoAt(source.updatedAt) ?? new Date(0).toISOString()
	};
}

// ─── The Usage view (the tab, the tool, the CLI — one object) ──────────────

/** A computer's scan, as every surface states it (spec S1, U1, U2, U3, U11). */
export type FleetUsageScanStateKind =
	/** Opted in; the numbers are live. */
	| 'on'
	/** The machine's owner has not switched the scan on (U1). */
	| 'off'
	/** The node is too old to scan (U3). */
	| 'unsupported';

export interface FleetUsageScanState {
	state: FleetUsageScanStateKind;
	online: boolean;
	/** The newest completed `usage-scan` job, or null when none ran yet. */
	lastScanAt: string | null;
	/** That job's `backlogPct` (0 = caught up), or null. */
	backlogPct: number | null;
	/** The opt-in or update hint, when `state` is not `on`. */
	hint: string | null;
}

export interface FleetUsageTotals {
	/** Cents at list price over the PRICED models only; null when nothing was priced. */
	costCents: number | null;
	tokens: FleetUsageTokens;
	requests: number;
	topModel: string | null;
}

export interface FleetUsageModelLine {
	model: string;
	provider: FleetUsageProvider;
	tokens: FleetUsageTokens;
	requests: number;
	/** Null = tokens only (not in the price list). */
	costCents: number | null;
}

export interface FleetUsageNodeLine {
	nodeId: string;
	name: string;
	scan: FleetUsageScanState;
	/** Null when the scan is off (no numbers, U1) or nothing was priced. */
	costCents: number | null;
	tokens: FleetUsageTokens;
	requests: number;
}

export interface FleetUsageCheckoutLine {
	nodeId: string;
	nodeName: string;
	/** The checkout or root path; null = "other folders" on that computer. */
	path: string | null;
	/** The `FleetCheckout` this path is, when it is one (opens it, FL-14). */
	checkoutId: string | null;
	costCents: number | null;
	tokens: FleetUsageTokens;
}

export interface FleetUsageAgentLine {
	agentId: string;
	name: string | null;
	sessions: number;
	costCents: number | null;
}

export interface FleetUsageSessionsBreakdown {
	agents: FleetUsageAgentLine[];
	/** Sessions people started from Ever Works on these computers. */
	owner: { sessions: number; costCents: number | null };
	/**
	 * Sessions not started from Ever Works (spec S3). Null when the viewer may
	 * not see them (the machine owner only by default — spec §8b).
	 */
	other: { sessions: number; costCents: number | null } | null;
}

export interface FleetUsageView {
	days: FleetUsagePeriodDays;
	/** The period's start and end (ISO). */
	from: string;
	to: string;
	/** Set when the view is scoped to one computer (`?node=`). */
	nodeId: string | null;
	/** Set when the view is filtered by model (`?model=`). */
	model: string | null;
	/**
	 * Set when the view is filtered to one Agent's work (`?agent=`, P2 — the
	 * Agent page's Budgets tab: its fleet cost per computer). Absent from a P1 platform.
	 */
	agentId?: string | null;
	totals: FleetUsageTotals;
	byModel: FleetUsageModelLine[];
	byNode: FleetUsageNodeLine[];
	busiestCheckouts: FleetUsageCheckoutLine[];
	sessions: FleetUsageSessionsBreakdown;
	/** Requests on models with no list price — excluded from every dollar figure (FR-8, S5). */
	unknownModels: { models: string[]; requests: number };
	/**
	 * What the totals leave out for THIS viewer (FR-17, U10): computers outside
	 * their `view` audience, and whether "other" sessions are hidden.
	 */
	excluded: { nodes: number; otherHidden: boolean };
	/** The newest computer's backlog while any opted-in computer is still catching up (U11). */
	catchingUp: { nodeId: string; nodeName: string; scannedPct: number } | null;
	priceList: { version: number; effectiveFrom: string; versionsUsed: number[] };
	/** {@link FLEET_USAGE_PAYER_NOTE}, verbatim (FR-9, FR-19). */
	note: string;
}

/** `GET /api/fleet/usage/prices` — the price list in effect (read-only). */
export interface FleetUsagePricesView {
	version: number;
	effectiveFrom: string;
	/** Per million tokens, in US dollars. */
	entries: { model: string; provider: FleetUsageProvider; perMillionUsd: FleetUsageTokens }[];
	history: { version: number; effectiveFrom: string }[];
	note: string;
}

/**
 * The Run receipt's fleet line (spec FR-11, §5.4): the model work a Run did
 * on one computer, at list price — "Model work on build-01 · $0.42 at list
 * price (v1) · 61 k in · 9 k out · 212 k cache". Absent on a Run with no
 * scanned usage (or with `FLEET_USAGE_SCAN_ENABLED` off).
 */
export interface RunReceiptFleetUsage {
	nodeId: string;
	nodeName: string;
	/** List-price cents over the priced models; null = tokens only. */
	costCents: number | null;
	tokens: FleetUsageTokens;
	requests: number;
	/** The newest price-list version the figure used; null when nothing was priced. */
	priceListVersion: number | null;
	/** Models with no list price (tokens only, excluded from `costCents`). */
	unknownModels: string[];
	/** {@link FLEET_USAGE_PAYER_NOTE}, verbatim. */
	note: string;
}

/** Most Task ids one `GET /api/fleet/usage/tasks` call takes (a computer's Agent-session schedules). */
export const FLEET_USAGE_TASK_COSTS_MAX_IDS = 50;

/**
 * What one recurring Task's Agent sessions cost (spec FR-16, P2) — the FL-13
 * schedule row's "last run $0.42 · 30 d $6.10", at list price.
 */
export interface FleetUsageTaskCost {
	taskId: string;
	/** The Task's newest Run and its scanned model work; null when it never ran. */
	lastRun: { runId: string; at: string; costCents: number | null } | null;
	/** The Task's Runs of the last 30 days at list price (priced models only); null when nothing priced. */
	last30DaysCents: number | null;
	/** How many of the Task's Runs started in the last 30 days. */
	runs30Days: number;
}

/** `GET /api/fleet/usage/tasks?ids=…` — the caller's own Runs only. */
export interface FleetUsageTaskCostsView {
	tasks: FleetUsageTaskCost[];
	/** {@link FLEET_USAGE_PAYER_NOTE}, verbatim. */
	note: string;
}

/** `POST /api/fleet/usage/rescan` answer. */
export interface FleetUsageRescanResult {
	jobId: string;
}

/**
 * The digest's fleet line (FL-20 P3): the person's own computers' model work
 * over a digest window, at list price.
 */
export interface FleetUsageDigestLine {
	/** List-price cents over the priced models; null = tokens only. */
	costCents: number | null;
	tokens: FleetUsageTokens;
	requests: number;
	/** Requests on models with no list price (tokens only). */
	unknownRequests: number;
	/** Computers that reported work in the window. */
	computers: number;
	/** {@link FLEET_USAGE_PAYER_NOTE}, verbatim. */
	note: string;
}

const CSV_HEADER = [
	'section',
	'name',
	'computer',
	'requests',
	'input_tokens',
	'output_tokens',
	'cache_read_tokens',
	'cache_write_tokens',
	'list_price_usd'
] as const;

/** One CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
function csvCell(value: string | number | null): string {
	if (value === null) return '';
	let text = String(value);
	if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvDollars(cents: number | null): string | null {
	return cents === null || !Number.isFinite(cents) ? null : (cents / 100).toFixed(2);
}

/**
 * The Usage object as one CSV (FL-20 P3, "export"): one row per model, per
 * computer, per busiest checkout and per Agent, then a `total` row and the
 * payer sentence as the last row. Dollars are list price (`list_price_usd`
 * empty = tokens only, never 0 for an unknown model — FR-8). The same text the
 * tab downloads and `ever-works fleet usage --csv` prints.
 */
export function fleetUsageCsv(view: FleetUsageView): string {
	const rows: Array<Array<string | number | null>> = [[...CSV_HEADER]];
	const tokenCells = (tokens: FleetUsageTokens) => [tokens.in, tokens.out, tokens.cacheRead, tokens.cacheWrite];
	for (const line of view.byModel) {
		rows.push(['model', line.model, null, line.requests, ...tokenCells(line.tokens), csvDollars(line.costCents)]);
	}
	for (const line of view.byNode) {
		rows.push([
			'computer',
			line.name,
			line.name,
			line.requests,
			...tokenCells(line.tokens),
			line.scan.state === 'on' ? csvDollars(line.costCents) : null
		]);
	}
	for (const line of view.busiestCheckouts) {
		rows.push([
			'checkout',
			line.path ?? 'other folders',
			line.nodeName,
			null,
			...tokenCells(line.tokens),
			csvDollars(line.costCents)
		]);
	}
	for (const agent of view.sessions.agents) {
		rows.push(['agent', agent.name ?? agent.agentId, null, null, null, null, null, null, csvDollars(agent.costCents)]);
	}
	rows.push(['total', `last ${view.days} day(s)`, null, view.totals.requests, ...tokenCells(view.totals.tokens), csvDollars(view.totals.costCents)]);
	rows.push(['note', view.note, null, null, null, null, null, null, null]);
	return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** `fleet-usage-30d-2026-10-27.csv` (plus the computer or model filter when set). */
export function fleetUsageCsvFilename(view: FleetUsageView): string {
	const day = view.to.slice(0, 10);
	const scope = [view.nodeId ? `node-${view.nodeId.slice(0, 8)}` : null, view.model ? view.model.replace(/[^A-Za-z0-9.-]/g, '_') : null]
		.filter(Boolean)
		.join('-');
	return `fleet-usage-${view.days}d${scope ? `-${scope}` : ''}-${day}.csv`;
}

/** Format cents as `$0.42` (two decimals; `<$0.01` for a positive amount under a cent). */
export function formatFleetUsageCents(cents: number | null): string | null {
	if (cents === null || !Number.isFinite(cents)) return null;
	if (cents > 0 && cents < 1) return '<$0.01';
	return `$${(cents / 100).toFixed(2)}`;
}

/** Compact token count: `912`, `61 k`, `18.4 M` (thin non-breaking spaces are the UI's job). */
export function formatFleetUsageTokens(value: number): string {
	if (!Number.isFinite(value) || value < 1000) return String(Math.max(0, Math.round(value || 0)));
	if (value < 1_000_000) return `${Math.round(value / 1000)} k`;
	if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')} M`;
	return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, '')} B`;
}
