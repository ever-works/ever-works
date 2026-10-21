/**
 * Fleet — logs on computers (FL-08, CONTRACTS §1.2 `logs` tag, §3.3 `logs`
 * family, §7 `node.logs.*`, §10 log rows, R-18, R-39).
 *
 * A computer's logs are READ where they already are — the system journal or
 * event logs, the standard log directories, files under the node's allowed
 * roots, Docker containers, running services — and never stored on the
 * platform. Every line passes the platform's secret scan ON THE MACHINE
 * before it leaves it.
 *
 * ## Where things travel
 *
 *  - **Listing** — `logs.sources` is a `machine` verb (one request/reply on
 *    the link's shared `machine` channel, CONTRACTS §3.3 rev 4): the answer is
 *    a {@link FleetLogSourceList}.
 *  - **Reading** — one `logs` channel per open source (or merged set, P2).
 *    The channel opens with {@link FleetLogsOpenParams}; nothing streams until
 *    the reader asks: `logs.read { lines }` (one batch, then
 *    `logs.initial-done`) or `logs.follow { on: true, lines }` (the batch,
 *    `logs.initial-done`, then live lines). Lines arrive as `DATA` frames of
 *    NDJSON {@link FleetLogLine}s (≤ {@link FLEET_LOGS_MAX_FRAME_BYTES} each),
 *    paced by `ACK` credit and {@link FLEET_LOGS_FOLLOW_BYTES_PER_SEC}.
 *    Node → reader JSON: `logs.initial-done`, `logs.earlier-done` (P2),
 *    `logs.notice` (dropped, gone, group membership, stopped, error).
 *
 * Source ids are self-describing (`system:journal`, `file:/var/log/syslog`,
 * `container:acme-api`, `service:nginx.service`): the node re-validates every
 * one it is asked to open — against its own roots, its own platform and a
 * strict name pattern — and never trusts that the platform did.
 */

// ─── Tags and verbs ─────────────────────────────────────────────────────────

/** Capability tag: this node reads its logs for the dashboard (CONTRACTS §1.2, `--manage`). */
export const FLEET_LOGS_CAPABILITY = 'logs';

/** `machine` verb: list the log sources this machine can read (CONTRACTS §3.3 rev 4). */
export const FLEET_LOGS_SOURCES_VERB = 'logs.sources';

/** JSON `type`s on a `logs` channel (CONTRACTS §3.3). */
export const FLEET_LOGS_MESSAGES = {
	/** reader → node: one batch of the last `lines`, then `logs.initial-done`; no follow. */
	read: 'logs.read',
	/** reader → node: `{ on: true, lines? }` the batch then live lines; `{ on: false }` stops following. */
	follow: 'logs.follow',
	/** reader → node: hold live lines on the machine (≤ 1 MiB, oldest dropped and counted). */
	pause: 'logs.pause',
	/** reader → node: send what was held, then follow again. */
	resume: 'logs.resume',
	/** reader → node (P2): `{ before, lines? }` one older batch, then `logs.earlier-done`. */
	earlier: 'logs.earlier',
	/** node → reader: the batch is complete. */
	initialDone: 'logs.initial-done',
	/** node → reader (P2): the older batch is complete. */
	earlierDone: 'logs.earlier-done',
	/** node → reader: something the viewer says in prose (dropped lines, a source gone, …). */
	notice: 'logs.notice'
} as const;

export type FleetLogsMessageType = (typeof FLEET_LOGS_MESSAGES)[keyof typeof FLEET_LOGS_MESSAGES];

// ─── Limits (CONTRACTS §10) ─────────────────────────────────────────────────

/** Lines a source shows on open, and the most one read may ask for. */
export const FLEET_LOGS_INITIAL_LINES = 500;

/** Live lines are delivered at no more than this many bytes a second. */
export const FLEET_LOGS_FOLLOW_BYTES_PER_SEC = 1024 * 1024;

/** Live bytes a node holds for one channel (paused or out of credit) before it drops the oldest. */
export const FLEET_LOGS_PENDING_MAX_BYTES = 1024 * 1024;

/** Lines one viewer holds; older lines go first (FR-21). */
export const FLEET_LOGS_VIEWER_MAX_LINES = 5000;

/** Sources in one merged view (P2, FR-35). */
export const FLEET_LOGS_MAX_MERGED_SOURCES = 12;

/** Log files listed per root, most recently written first (FR-5). */
export const FLEET_LOGS_MAX_FILES_PER_ROOT = 200;

/** Log channels one person may hold open on one computer (U11). */
export const FLEET_LOGS_MAX_CHANNELS_PER_VIEWER = 8;

/** Largest `DATA` frame payload on a `logs` channel. */
export const FLEET_LOGS_MAX_FRAME_BYTES = 64 * 1024;

/** A longer line is cut to this many characters (and says so with a trailing `…`). */
export const FLEET_LOGS_MAX_LINE_CHARS = 16 * 1024;

/** A file's last lines are found by scanning back at most this many bytes. */
export const FLEET_LOGS_FILE_SCAN_MAX_BYTES = 8 * 1024 * 1024;

/** The tab re-lists sources this often while it is visible (FR-11). */
export const FLEET_LOGS_SOURCES_REFRESH_MS = 30_000;

/** A child reading the first batch is given this long, then `operation_failed`. */
export const FLEET_LOGS_READ_TIMEOUT_MS = 10_000;

/** The platform abandons a one-shot read after this long (spec §5.8: 30 s). */
export const FLEET_LOGS_READ_ABANDON_MS = 30_000;

/** A closed channel's reader is killed within this long (plan §6). */
export const FLEET_LOGS_STOP_GRACE_MS = 3_000;

/** Longest source id (a file source carries its path). */
export const FLEET_LOG_SOURCE_ID_MAX_LENGTH = 400;

/** Longest filter a one-shot read applies. */
export const FLEET_LOGS_FILTER_MAX_LENGTH = 200;

/** Most sources one listing carries (the machine reply stays well inside its JSON bound). */
export const FLEET_LOGS_MAX_LISTED_SOURCES = 1500;

/** Rates (CONTRACTS §10.1 style, per user): source lists and one-shot reads a minute. */
export const FLEET_LOGS_SOURCES_RATE_LIMIT = 60;
export const FLEET_LOGS_READ_RATE_LIMIT = 30;

// ─── Sources ────────────────────────────────────────────────────────────────

export const FLEET_LOG_SOURCE_KINDS = ['system', 'file', 'container', 'service'] as const;

export type FleetLogSourceKind = (typeof FLEET_LOG_SOURCE_KINDS)[number];

export function isFleetLogSourceKind(value: unknown): value is FleetLogSourceKind {
	return typeof value === 'string' && (FLEET_LOG_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * The system logs, per operating system (FR-2 … FR-4): Linux `journal` +
 * `kernel`; macOS `unified`; Windows `event-system`, `event-application`,
 * `event-security` (administrator only).
 */
export const FLEET_LOG_SYSTEM_SOURCES = [
	'journal',
	'kernel',
	'unified',
	'event-system',
	'event-application',
	'event-security'
] as const;

export type FleetLogSystemSource = (typeof FLEET_LOG_SYSTEM_SOURCES)[number];

export function isFleetLogSystemSource(value: unknown): value is FleetLogSystemSource {
	return typeof value === 'string' && (FLEET_LOG_SYSTEM_SOURCES as readonly string[]).includes(value);
}

/** The system sources each platform offers (`process.platform`). */
export function fleetLogSystemSourcesFor(platform: string): readonly FleetLogSystemSource[] {
	switch (platform) {
		case 'linux':
			return ['journal', 'kernel'];
		case 'darwin':
			return ['unified'];
		case 'win32':
			return ['event-system', 'event-application', 'event-security'];
		default:
			return [];
	}
}

/** Why a listed source cannot be opened (or opens only in part). */
export const FLEET_LOG_UNREADABLE_REASONS = ['root-only', 'needs-admin', 'group-membership', 'gone'] as const;

export type FleetLogUnreadableReason = (typeof FLEET_LOG_UNREADABLE_REASONS)[number];

export interface FleetLogSource {
	/** Self-describing and stable per node (see {@link fleetLogSourceId}). */
	id: string;
	kind: FleetLogSourceKind;
	/** "System journal", "/var/log/syslog", "acme-api", "nginx.service". */
	label: string;
	/** Tree group under its kind: the root a file sits under; empty for the others. */
	group: string;
	/** False: listed but cannot be opened (`root-only`, `needs-admin`, `gone`). */
	readable: boolean;
	/**
	 * Why it cannot be opened — or, with `readable: true` and
	 * `group-membership`, why it opens with only this user's entries (U5).
	 */
	unreadableReason?: FleetLogUnreadableReason;
	/** The exact command or sentence for the reason; never run for the person (FR-10). */
	hint?: string;
	/** A container's or service's state, as its manager names it (`running`, `exited (1)`, `failed`). */
	state?: string;
	/** A failed service (listed first, FR-9). */
	failed?: boolean;
	/** ISO instant a file was last written. */
	lastWrittenAt?: string;
	sizeBytes?: number;
	/** The source can page back (`logs.earlier`, P2): journal, event logs, files — not containers. */
	supportsEarlier: boolean;
}

export interface FleetLogSourceList {
	/** `process.platform` of the machine. */
	platform: string;
	sources: FleetLogSource[];
	/** The roots files were listed under, as the machine names them (R-18). */
	roots: string[];
	/** True when the listing hit {@link FLEET_LOGS_MAX_LISTED_SOURCES}. */
	truncated: boolean;
	/** ISO instant of the listing on the machine's clock. */
	listedAt: string;
}

/** `system:journal` · `file:/var/log/syslog` · `container:acme-api` · `service:nginx.service`. */
export function fleetLogSourceId(kind: FleetLogSourceKind, key: string): string {
	return `${kind}:${key}`;
}

/** Systemd units, launchd labels, Windows service names (spaces allowed, never a leading `-`). */
const SERVICE_KEY_PATTERN = /^[A-Za-z0-9@_][A-Za-z0-9@._:+ -]{0,199}$/;

/** Docker container names and ids. */
const CONTAINER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isFleetLogServiceKey(value: unknown): value is string {
	return typeof value === 'string' && SERVICE_KEY_PATTERN.test(value) && value.trim() === value;
}

export function isFleetLogContainerKey(value: unknown): value is string {
	return typeof value === 'string' && CONTAINER_KEY_PATTERN.test(value);
}

/** An absolute path a file source may name: POSIX `/…` or a Windows drive path, no NUL, bounded. */
function isAbsoluteLogPath(value: string): boolean {
	if (value.length === 0 || value.includes('\0')) return false;
	if (value.startsWith('/')) return true;
	return /^[A-Za-z]:[\\/]/.test(value);
}

export interface FleetLogSourceRef {
	kind: FleetLogSourceKind;
	/** The system source name, the path, the container or the service. */
	key: string;
}

/**
 * Read a source id. Null for anything that is not one: an unknown kind, an
 * unknown system source, a relative path, a container or service name
 * outside its pattern, an id over {@link FLEET_LOG_SOURCE_ID_MAX_LENGTH}.
 * Shape only — the machine still decides whether it can open it.
 */
export function parseFleetLogSourceId(value: unknown): FleetLogSourceRef | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > FLEET_LOG_SOURCE_ID_MAX_LENGTH) return null;
	const colon = value.indexOf(':');
	if (colon <= 0) return null;
	const kind = value.slice(0, colon);
	const key = value.slice(colon + 1);
	if (!isFleetLogSourceKind(kind) || key.length === 0) return null;
	switch (kind) {
		case 'system':
			return isFleetLogSystemSource(key) ? { kind, key } : null;
		case 'file':
			return isAbsoluteLogPath(key) ? { kind, key } : null;
		case 'container':
			return isFleetLogContainerKey(key) ? { kind, key } : null;
		case 'service':
			return isFleetLogServiceKey(key) ? { kind, key } : null;
		default:
			return null;
	}
}

export function isFleetLogSourceId(value: unknown): value is string {
	return parseFleetLogSourceId(value) !== null;
}

// ─── Lines ──────────────────────────────────────────────────────────────────

export const FLEET_LOG_LEVELS = ['error', 'warning', 'info'] as const;

export type FleetLogLevel = (typeof FLEET_LOG_LEVELS)[number];

export function isFleetLogLevel(value: unknown): value is FleetLogLevel {
	return value === 'error' || value === 'warning' || value === 'info';
}

/** One line as it travels (NDJSON in `DATA` frames). */
export interface FleetLogLine {
	/** ISO instant the source stamped it, or null when it carries none (a plain file line). */
	ts: string | null;
	level: FleetLogLevel;
	/** Already scanned on the machine: a secret reads `[redacted secret]`. */
	text: string;
	/** Index into the opened sources (0 for a single source; P2 merged views). */
	src: number;
	/** How many spans of this line the scan replaced. */
	redactions: number;
	/** P2: the line belongs to an older page (`logs.earlier`), to be prepended, not appended. */
	earlier?: true;
}

/** Read one line off the wire; null for anything malformed. The text is bounded, the level checked. */
export function sanitizeFleetLogLine(value: unknown): FleetLogLine | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.text !== 'string') return null;
	const ts = typeof record.ts === 'string' && record.ts.length <= 64 && !Number.isNaN(Date.parse(record.ts)) ? record.ts : null;
	const src = typeof record.src === 'number' && Number.isInteger(record.src) && record.src >= 0 && record.src < FLEET_LOGS_MAX_MERGED_SOURCES ? record.src : 0;
	const redactions =
		typeof record.redactions === 'number' && Number.isInteger(record.redactions) && record.redactions >= 0
			? Math.min(record.redactions, 10_000)
			: 0;
	const line: FleetLogLine = {
		ts,
		level: isFleetLogLevel(record.level) ? record.level : 'info',
		text: capFleetLogText(record.text),
		src,
		redactions
	};
	if (record.earlier === true) line.earlier = true;
	return line;
}

/** Cut a line to {@link FLEET_LOGS_MAX_LINE_CHARS}, marking the cut. */
export function capFleetLogText(text: string): string {
	return text.length > FLEET_LOGS_MAX_LINE_CHARS ? `${text.slice(0, FLEET_LOGS_MAX_LINE_CHARS - 1)}…` : text;
}

/** Lines → one NDJSON payload (each line one JSON object, `\n`-terminated). */
export function encodeFleetLogLines(lines: readonly FleetLogLine[]): string {
	let out = '';
	for (const line of lines) out += `${JSON.stringify(line)}\n`;
	return out;
}

/** One NDJSON payload → lines; malformed records are skipped, never thrown. */
export function parseFleetLogLines(payload: string): FleetLogLine[] {
	const out: FleetLogLine[] = [];
	for (const raw of payload.split('\n')) {
		if (raw.length === 0) continue;
		try {
			const line = sanitizeFleetLogLine(JSON.parse(raw));
			if (line) out.push(line);
		} catch {
			// a torn or foreign record: skipped
		}
	}
	return out;
}

// ─── Level classification (FR-18) ───────────────────────────────────────────

const LEVEL_NAMES: Readonly<Record<string, FleetLogLevel>> = {
	emerg: 'error',
	emergency: 'error',
	alert: 'error',
	crit: 'error',
	critical: 'error',
	fatal: 'error',
	panic: 'error',
	severe: 'error',
	fault: 'error',
	err: 'error',
	error: 'error',
	eror: 'error',
	warn: 'warning',
	warning: 'warning',
	notice: 'info',
	info: 'info',
	information: 'info',
	informational: 'info',
	default: 'info',
	debug: 'info',
	trace: 'info',
	verbose: 'info'
};

/** A level a source names (`Error`, `warn`, `Fault`, `NOTICE`) → ours, or null. */
export function fleetLogLevelFromName(name: unknown): FleetLogLevel | null {
	if (typeof name !== 'string') return null;
	return LEVEL_NAMES[name.trim().toLowerCase()] ?? null;
}

/** A syslog / journal `PRIORITY` (0 emerg … 7 debug) → ours; null when it is not one. */
export function fleetLogLevelFromSyslogPriority(value: unknown): FleetLogLevel | null {
	const n = typeof value === 'string' && /^[0-7]$/.test(value) ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 7) return null;
	if (n <= 3) return 'error';
	return n === 4 ? 'warning' : 'info';
}

/** A Windows event `Level` (1 critical, 2 error, 3 warning, 4 information, 5 verbose, 0 always) → ours. */
export function fleetLogLevelFromWindowsEventLevel(value: unknown): FleetLogLevel | null {
	const n = typeof value === 'string' && /^[0-5]$/.test(value) ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 5) return null;
	if (n === 1 || n === 2) return 'error';
	return n === 3 ? 'warning' : 'info';
}

/** Phrases that NAME errors without being one: "0 errors", "errors: 0", "no warnings", "failed=0". */
const NEGATED =
	/\b(?:no|zero|0)\s+(?:errors?|failures?|warnings?|exceptions?)\b|\b(?:errors?|failures?|failed|warnings?|exceptions?)\s*[:=]\s*0\b/gi;

/** `level=warn`, `"level":"error"`, `severity: ERROR`, `lvl=info`. */
const STRUCTURED_LEVEL = /\b(?:level|lvl|severity|loglevel)["']?\s*[:=]\s*["']?([A-Za-z]+)/i;

/** `[ERROR]`, `<warn>`, `(Fatal)`. */
const BRACKETED_LEVEL = /[[<(]\s*(emerg|alert|crit|critical|fatal|panic|error|err|warn|warning|notice|info|debug|trace)\s*[\]>)]/i;

/** An upper-case level word standing alone: ` ERROR `, `WARN:`. */
const SHOUTED_LEVEL = /(?:^|[\s|])(FATAL|PANIC|CRITICAL|CRIT|ERROR|ERR|WARNING|WARN)(?=$|[\s:|\]])/;

const ERROR_WORDS = /\b(?:error|errors|fatal|failed|failure|exception|panic|traceback|segfault|segmentation fault|critical|denied|refused|timed out|unreachable)\b/i;

const WARNING_WORDS = /\b(?:warn|warning|warnings|deprecated|deprecation|retrying|retry)\b/i;

/**
 * The one truth table for a line's level, shared by the machine (tagging) and
 * the browser (colouring): the source's own level when it has one (`explicit`:
 * a name, or what {@link fleetLogLevelFromSyslogPriority} /
 * {@link fleetLogLevelFromWindowsEventLevel} answered), else the line's text —
 * a structured `level=` field, a bracketed or shouted level word, then error
 * and warning words, with negations ("0 errors", "errors: 0") never counted.
 */
export function classifyLogLevel(explicit: string | null | undefined, text: string): FleetLogLevel {
	const named = fleetLogLevelFromName(explicit);
	if (named) return named;
	if (typeof text !== 'string' || text.length === 0) return 'info';
	const sample = text.length > 2048 ? text.slice(0, 2048) : text;
	const structured = STRUCTURED_LEVEL.exec(sample);
	const structuredLevel = structured ? fleetLogLevelFromName(structured[1]) : null;
	if (structuredLevel) return structuredLevel;
	const bracketed = BRACKETED_LEVEL.exec(sample);
	const bracketedLevel = bracketed ? fleetLogLevelFromName(bracketed[1]) : null;
	if (bracketedLevel) return bracketedLevel;
	const shouted = SHOUTED_LEVEL.exec(sample);
	const shoutedLevel = shouted ? fleetLogLevelFromName(shouted[1]) : null;
	if (shoutedLevel) return shoutedLevel;
	const plain = sample.replace(NEGATED, ' ');
	if (ERROR_WORDS.test(plain)) return 'error';
	if (WARNING_WORDS.test(plain)) return 'warning';
	return 'info';
}

/**
 * A leading timestamp on a plain line (`2026-10-21T09:41:02Z …`,
 * `2026-10-21 09:41:02,123 …`), as an ISO instant; null when the line starts
 * with none. A zone-less stamp is read as UTC (the machine's zone is unknown
 * here) — good enough for ordering, never shown as authoritative.
 */
export function leadingFleetLogTimestamp(text: string): string | null {
	const match = /^\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?/.exec(text);
	if (!match) return null;
	const fraction = match[3] ? `.${match[3].slice(0, 3).padEnd(3, '0')}` : '';
	let zone = match[4] ?? 'Z';
	if (zone !== 'Z' && !zone.includes(':')) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
	const parsed = Date.parse(`${match[1]}T${match[2]}${fraction}${zone}`);
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

// ─── Channel messages ───────────────────────────────────────────────────────

/** What a `logs` channel opens with (CONTRACTS §3.3: `{ source, path?, unit?, container?, lines, sources?[] }`). */
export interface FleetLogsOpenParams {
	/** The source id (`system:journal`, `file:/var/log/syslog`, …). */
	source: string;
	/** P2: up to {@link FLEET_LOGS_MAX_MERGED_SOURCES} source ids merged by time; `source` is the first. */
	sources?: string[];
	/** Lines of the first batch, 1–500 (default 500). */
	lines?: number;
	/** The reader means to follow (informational: the node starts following on `logs.follow`). */
	follow?: boolean;
	/** CONTRACTS §3.3 aliases: a path, unit or container named on its own. */
	path?: string;
	unit?: string;
	container?: string;
}

/** A line count a reader asked for, clamped to 1–500 (default 500). */
export function clampFleetLogsLines(value: unknown): number {
	const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isFinite(n)) return FLEET_LOGS_INITIAL_LINES;
	return Math.min(Math.max(Math.trunc(n), 1), FLEET_LOGS_INITIAL_LINES);
}

/**
 * Read a channel's open params: the source ids it names (deduplicated, at most
 * {@link FLEET_LOGS_MAX_MERGED_SOURCES}, `source` first) and the line count.
 * The CONTRACTS §3.3 aliases (`path`, `unit`, `container`) are read when
 * `source` is absent. Null when no valid source is named or any named one is
 * malformed — a merged view never opens with a silently missing member.
 */
export function parseFleetLogsOpenParams(
	params: Readonly<Record<string, unknown>> | null | undefined
): { sources: string[]; lines: number; follow: boolean } | null {
	if (!params || typeof params !== 'object') return null;
	const named: unknown[] = [];
	if (params.source !== undefined) named.push(params.source);
	else if (typeof params.path === 'string') named.push(fleetLogSourceId('file', params.path));
	else if (typeof params.unit === 'string') named.push(fleetLogSourceId('service', params.unit));
	else if (typeof params.container === 'string') named.push(fleetLogSourceId('container', params.container));
	if (Array.isArray(params.sources)) named.push(...params.sources);
	const sources: string[] = [];
	for (const id of named) {
		if (!isFleetLogSourceId(id)) return null;
		if (!sources.includes(id)) sources.push(id);
	}
	if (sources.length === 0 || sources.length > FLEET_LOGS_MAX_MERGED_SOURCES) return null;
	return { sources, lines: clampFleetLogsLines(params.lines), follow: params.follow === true };
}

/** node → reader: the first (or a re-read) batch is complete. */
export interface FleetLogsInitialDone {
	type: 'logs.initial-done';
	/** Lines sent in the batch. */
	count: number;
	/** Spans the scan replaced across the batch. */
	redactions: number;
	/** Payload bytes of the batch. */
	bytes: number;
	/** Fewer lines than asked because a file's last {@link FLEET_LOGS_FILE_SCAN_MAX_BYTES} held no more. */
	scanLimited: boolean;
	/** True when live lines follow. */
	following: boolean;
	/** The batch could not be read: why, as the CONTRACTS §8 envelope's `error`. */
	error?: { code: string; hint: string };
}

/** node → reader (P2): an older batch is complete. */
export interface FleetLogsEarlierDone {
	type: 'logs.earlier-done';
	count: number;
	hasMore: boolean;
	/** The merged-view index of the source the page is from (P2). */
	src?: number;
	/** The source cannot page back (container logs are bounded by the log driver, FR-37). */
	unsupported?: boolean;
}

export const FLEET_LOGS_NOTICE_KINDS = [
	/** Live lines were dropped: the log is faster than the link (U9). `count` lines. */
	'dropped',
	/** The source went away (a container removed, a file deleted) — following stopped (U10). */
	'gone',
	/** A container stopped; its log ended. */
	'stopped',
	/** Only this user's entries are readable; `hint` is the command that widens it (U5). */
	'group-membership',
	/** Following could not continue (the reader exited); `hint` says why. */
	'error',
	/** Following stopped because the kill switch is on (U3). */
	'kill-switch'
] as const;

export type FleetLogsNoticeKind = (typeof FLEET_LOGS_NOTICE_KINDS)[number];

export interface FleetLogsNotice {
	type: 'logs.notice';
	kind: FleetLogsNoticeKind;
	count?: number;
	hint?: string;
	/** The merged-view index of the source it is about (P2). */
	src?: number;
}

export function isFleetLogsNoticeKind(value: unknown): value is FleetLogsNoticeKind {
	return typeof value === 'string' && (FLEET_LOGS_NOTICE_KINDS as readonly string[]).includes(value);
}

/** Read a node JSON message on a `logs` channel: an initial-done, an earlier-done, a notice, or null. */
export function parseFleetLogsChannelMessage(
	message: Record<string, unknown> | null | undefined
): FleetLogsInitialDone | FleetLogsEarlierDone | FleetLogsNotice | null {
	if (!message || typeof message !== 'object') return null;
	const count = (value: unknown): number =>
		typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
	switch (message.type) {
		case FLEET_LOGS_MESSAGES.initialDone: {
			const done: FleetLogsInitialDone = {
				type: 'logs.initial-done',
				count: count(message.count),
				redactions: count(message.redactions),
				bytes: count(message.bytes),
				scanLimited: message.scanLimited === true,
				following: message.following === true
			};
			const error = message.error as { code?: unknown; hint?: unknown } | undefined;
			if (error && typeof error.code === 'string') {
				done.error = { code: error.code, hint: typeof error.hint === 'string' ? error.hint.slice(0, 500) : '' };
			}
			return done;
		}
		case FLEET_LOGS_MESSAGES.earlierDone: {
			const done: FleetLogsEarlierDone = {
				type: 'logs.earlier-done',
				count: count(message.count),
				hasMore: message.hasMore === true
			};
			if (typeof message.src === 'number') done.src = count(message.src);
			if (message.unsupported === true) done.unsupported = true;
			return done;
		}
		case FLEET_LOGS_MESSAGES.notice: {
			if (!isFleetLogsNoticeKind(message.kind)) return null;
			const notice: FleetLogsNotice = { type: 'logs.notice', kind: message.kind };
			if (typeof message.count === 'number') notice.count = count(message.count);
			if (typeof message.hint === 'string') notice.hint = message.hint.slice(0, 500);
			if (typeof message.src === 'number') notice.src = count(message.src);
			return notice;
		}
		default:
			return null;
	}
}

// ─── REST shapes (CONTRACTS §11.2) ──────────────────────────────────────────

/** `GET /api/fleet/nodes/:id/logs/sources`. */
export type FleetLogSourcesResponse = FleetLogSourceList & { nodeId: string };

/** `POST /api/fleet/nodes/:id/logs/attach-token` body. */
export interface FleetLogsAttachRequest {
	source: string;
	/** P2: a merged view. */
	sources?: string[];
	lines?: number;
	follow?: boolean;
}

/** `POST /api/fleet/nodes/:id/logs/attach-token` answer (the BFF turns `wsPath` into `wsUrl`). */
export interface FleetLogsAttachGrant {
	token: string;
	/** `/ws/fleet/logs/<nodeId>` on the API origin. */
	wsPath: string;
	expiresInSec: number;
	sources: string[];
	lines: number;
	follow: boolean;
}

/** `POST /api/fleet/nodes/:id/logs/read` body — one batch, never a follow. */
export interface FleetLogsReadRequest {
	source: string;
	lines?: number;
	/** Case-insensitive substring applied to the batch (the lines kept are the ones that match). */
	filter?: string;
}

/** `POST /api/fleet/nodes/:id/logs/read` answer. */
export interface FleetLogsReadResult {
	nodeId: string;
	source: string;
	lines: FleetLogLine[];
	/** Lines the machine sent, before the filter. */
	count: number;
	/** Lines kept after the filter. */
	matched: number;
	/** Fewer lines than asked because the machine's scan limit was reached. */
	truncated: boolean;
	redactions: number;
	filter: string | null;
}

/** Case-insensitive substring filter (FR-17), the browser's and the one-shot read's. */
export function fleetLogLineMatches(line: Pick<FleetLogLine, 'text'>, filter: string | null | undefined): boolean {
	if (!filter) return true;
	return line.text.toLowerCase().includes(filter.toLowerCase());
}
