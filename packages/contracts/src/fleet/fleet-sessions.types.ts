/**
 * Fleet — sessions on computers (FL-04, CONTRACTS §1.1, §3.3, §4.2, §5, §10).
 *
 * A **Session** is a persistent interactive process on a Node — an agent CLI
 * or a shell — that keeps running when nobody is watching. The process
 * belongs to the node's **session daemon** (a separate long-lived process
 * the node starts and supervises), so it outlives the node process, the link
 * and every browser tab. The platform keeps one `FleetSession` row per
 * session (`fleet_sessions`); the daemon's own record is its backing process
 * (CONTRACTS R-1).
 *
 * Two kinds, two isolation models (README D14, CONTRACTS R-5):
 *
 *  - an **owner session** runs as the person, in their own login, with their
 *    own CLI configuration — the node refuses one without `--manage`;
 *  - an **Agent session** runs under the isolation Task runs already enforce
 *    and owns exactly one Run — the node refuses one without `--work`.
 *
 * Everything here is a wire or storage shape; every union carries a
 * `readonly` list and an `isX` guard (the house pattern), and every
 * node→platform message has a parser that answers `null` — never throws —
 * for anything it does not recognise, because the node is a different
 * release of the code than the platform reading it.
 */

import type { FleetLinkConsentRequirement } from './fleet-link.types.js';

// ─── Kinds, providers, states (CONTRACTS §4.2, §5.1) ────────────────────────

export const FLEET_SESSION_KINDS = ['owner', 'agent'] as const;

/** `owner` — a person on their own machine; `agent` — an Agent driving a CLI, with one Run. */
export type FleetSessionKind = (typeof FLEET_SESSION_KINDS)[number];

export function isFleetSessionKind(value: unknown): value is FleetSessionKind {
	return typeof value === 'string' && (FLEET_SESSION_KINDS as readonly string[]).includes(value);
}

/** The providers a session can be started with today (spec FR-14). */
export const FLEET_SESSION_STARTABLE_PROVIDERS = ['shell', 'claude-code', 'codex'] as const;

export type FleetSessionStartableProvider = (typeof FLEET_SESSION_STARTABLE_PROVIDERS)[number];

/**
 * `claude-code · codex · shell · other:<id>` (CONTRACTS §4.2). `other:<id>`
 * is reserved for a CLI a later epic adds; nothing starts one yet.
 */
export type FleetSessionProvider = FleetSessionStartableProvider | `other:${string}`;

const OTHER_PROVIDER_PATTERN = /^other:[a-z0-9][a-z0-9-]{0,47}$/;

export function isFleetSessionProvider(value: unknown): value is FleetSessionProvider {
	return (
		typeof value === 'string' &&
		((FLEET_SESSION_STARTABLE_PROVIDERS as readonly string[]).includes(value) || OTHER_PROVIDER_PATTERN.test(value))
	);
}

export function isFleetSessionStartableProvider(value: unknown): value is FleetSessionStartableProvider {
	return typeof value === 'string' && (FLEET_SESSION_STARTABLE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The capability tag a node must advertise for each agent provider (the
 * existing `claude-code` / `codex` tags, backed by a resolved CLI path). A
 * shell needs nothing beyond the `sessions` tag itself.
 */
export const FLEET_SESSION_PROVIDER_CAPABILITY: Readonly<Record<FleetSessionStartableProvider, string | null>> = {
	shell: null,
	'claude-code': 'claude-code',
	codex: 'codex'
};

/** True for the providers that are agent CLIs (they take a first message). */
export function isFleetSessionAgentProvider(provider: FleetSessionProvider): boolean {
	return provider !== 'shell';
}

/** The tag a node advertises while its session daemon runs and answers health (CONTRACTS §1.2). */
export const FLEET_SESSIONS_CAPABILITY = 'sessions';

export const FLEET_SESSION_STATES = ['starting', 'working', 'needs_you', 'done', 'idle', 'ended'] as const;

/**
 * CONTRACTS §5.1. `ended` is terminal and carries `endedReason`. FL-04 moves
 * `starting → working` on the daemon's `started` evidence, `idle → working`
 * on output activity, and `* → ended` on exit, end, loss or restart; the
 * `needs_you`, `done` and `idle` derivations from hooks and silence are
 * FL-05's.
 */
export type FleetSessionState = (typeof FLEET_SESSION_STATES)[number];

export function isFleetSessionState(value: unknown): value is FleetSessionState {
	return typeof value === 'string' && (FLEET_SESSION_STATES as readonly string[]).includes(value);
}

/** Every state but `ended`: the process is (believed to be) alive. */
export const FLEET_SESSION_LIVE_STATES: readonly FleetSessionState[] = FLEET_SESSION_STATES.filter(
	(state) => state !== 'ended'
);

export function isFleetSessionLive(state: FleetSessionState): boolean {
	return state !== 'ended';
}

export const FLEET_SESSION_OUTCOMES = ['success', 'failure', 'cancelled', 'interrupted', 'unconfirmed'] as const;

/** Set once, on leaving `working`/`needs_you` for `done`/`ended` (CONTRACTS §4.2). */
export type FleetSessionOutcome = (typeof FLEET_SESSION_OUTCOMES)[number];

export function isFleetSessionOutcome(value: unknown): value is FleetSessionOutcome {
	return typeof value === 'string' && (FLEET_SESSION_OUTCOMES as readonly string[]).includes(value);
}

export const FLEET_SESSION_ENDED_REASONS = [
	'user',
	'agent',
	'exit',
	'node-restart',
	'timeout',
	'kill-switch',
	'drain'
] as const;

export type FleetSessionEndedReason = (typeof FLEET_SESSION_ENDED_REASONS)[number];

export function isFleetSessionEndedReason(value: unknown): value is FleetSessionEndedReason {
	return typeof value === 'string' && (FLEET_SESSION_ENDED_REASONS as readonly string[]).includes(value);
}

export const FLEET_SESSION_RECORDING_STATES = ['off', 'recording', 'stored'] as const;

/** CONTRACTS R-9; FL-04 P3 writes it. */
export type FleetSessionRecordingState = (typeof FLEET_SESSION_RECORDING_STATES)[number];

export function isFleetSessionRecordingState(value: unknown): value is FleetSessionRecordingState {
	return typeof value === 'string' && (FLEET_SESSION_RECORDING_STATES as readonly string[]).includes(value);
}

export const FLEET_SESSION_ATTACH_ROLES = ['viewer', 'driver'] as const;

/** A viewer watches (never sends input); a driver types and sizes the terminal (CONTRACTS §3.3). */
export type FleetSessionAttachRole = (typeof FLEET_SESSION_ATTACH_ROLES)[number];

export function isFleetSessionAttachRole(value: unknown): value is FleetSessionAttachRole {
	return typeof value === 'string' && (FLEET_SESSION_ATTACH_ROLES as readonly string[]).includes(value);
}

/** The consent the node requires for a session of this kind (CONTRACTS R-5). */
export function fleetSessionConsentFor(
	kind: FleetSessionKind
): Extract<FleetLinkConsentRequirement, 'work' | 'manage'> {
	return kind === 'agent' ? 'work' : 'manage';
}

/**
 * The outcome a process exit proves on its own (CONTRACTS §5.1): `success`
 * on exit 0, `failure` on any other code, `unconfirmed` when the daemon lost
 * the process without an exit code. Hook evidence (FL-05) may already have
 * set an outcome; the platform keeps the first one written.
 */
export function fleetSessionOutcomeForExit(exitCode: number | null | undefined): FleetSessionOutcome {
	if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return 'unconfirmed';
	return exitCode === 0 ? 'success' : 'failure';
}

// ─── Limits (CONTRACTS §10, §10.1) ──────────────────────────────────────────

/** Owner sessions per Node; the ninth is refused `limit_exceeded`. */
export const FLEET_SESSION_MAX_OWNER_PER_NODE = 8;

/** Live viewers (watchers and drivers) per session; the sixth is refused `limit_exceeded`. */
export const FLEET_SESSION_MAX_VIEWERS = 5;

/** Lines of scrollback the daemon's headless grid keeps per session. */
export const FLEET_SESSION_SCROLLBACK_LINES = 10_000;

/** Lines replayed (the current screen plus scrollback) to every new attach. */
export const FLEET_SESSION_REPLAY_LINES = 2_000;

/** Drain-all warns owner sessions this long before ending them (CONTRACTS R-24). */
export const FLEET_SESSION_DRAIN_WARNING_SEC = 60;

/** Ending a session: terminate, then kill after this long (spec FR-18). */
export const FLEET_SESSION_END_GRACE_MS = 5_000;

/** A viewer whose output cannot be delivered for this long is dropped (spec FR-7). */
export const FLEET_SESSION_SLOW_VIEWER_MS = 5_000;

/** Output a viewer may have queued before it is dropped as slow, in bytes. */
export const FLEET_SESSION_SLOW_VIEWER_BYTES = 1024 * 1024;

/** The daemon persists a session's last screen at most this long after it changed (spec FR-8). */
export const FLEET_SESSION_SCREEN_PERSIST_MS = 30_000;

/** The daemon exits on its own after this long with no session and no node connected (spec FR-2). */
export const FLEET_SESSION_DAEMON_IDLE_EXIT_MS = 5 * 60_000;

/** A session still `starting` this long after it was asked for is ended `unconfirmed` (the sweeper). */
export const FLEET_SESSION_STARTING_TIMEOUT_MS = 60_000;

/** Output activity is reported to the platform at most this often per session. */
export const FLEET_SESSION_ACTIVITY_REPORT_MS = 30_000;

/** Session starts per user per minute (CONTRACTS §10.1). */
export const FLEET_SESSION_STARTS_PER_MINUTE = 10;

/** Session attaches per user per minute (CONTRACTS §10.1). */
export const FLEET_SESSION_ATTACHES_PER_MINUTE = 30;

/** A title is 1–200 characters. */
export const FLEET_SESSION_TITLE_MAX_LENGTH = 200;

/** A working folder is at most this long. */
export const FLEET_SESSION_CWD_MAX_LENGTH = 1024;

/** An agent provider's first message is at most this long (spec FR-48). */
export const FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH = 4_000;

/** An Agent session's first message is at least this long (spec FR-48). */
export const FLEET_SESSION_FIRST_MESSAGE_MIN_LENGTH = 3;

/** The start dialog offers the folders of the Node's last this-many sessions (spec FR-15). */
export const FLEET_SESSION_RECENT_FOLDERS = 10;

/**
 * The last screen kept when a session ends, in characters: the last
 * {@link FLEET_SESSION_REPLAY_LINES} lines, bounded so one row (and one
 * channel-0 message, capped at 1 MiB) stays small. Cut from the START — the
 * end of a terminal is what a person reads.
 */
export const FLEET_SESSION_LAST_SCREEN_MAX_CHARS = 256 * 1024;

/** Terminal size bounds a driver may ask for. */
export const FLEET_SESSION_MIN_COLS = 20;
export const FLEET_SESSION_MAX_COLS = 500;
export const FLEET_SESSION_MIN_ROWS = 5;
export const FLEET_SESSION_MAX_ROWS = 200;
export const FLEET_SESSION_DEFAULT_COLS = 120;
export const FLEET_SESSION_DEFAULT_ROWS = 32;

/** Clamp a requested terminal size into the bounds, defaulting what is missing. */
export function clampFleetSessionSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
	const pick = (value: unknown, min: number, max: number, fallback: number): number => {
		if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
		return Math.min(max, Math.max(min, Math.round(value)));
	};
	return {
		cols: pick(cols, FLEET_SESSION_MIN_COLS, FLEET_SESSION_MAX_COLS, FLEET_SESSION_DEFAULT_COLS),
		rows: pick(rows, FLEET_SESSION_MIN_ROWS, FLEET_SESSION_MAX_ROWS, FLEET_SESSION_DEFAULT_ROWS)
	};
}

/** Keep the END of a screen within {@link FLEET_SESSION_LAST_SCREEN_MAX_CHARS}. */
export function boundFleetSessionScreen(screen: string): string {
	if (screen.length <= FLEET_SESSION_LAST_SCREEN_MAX_CHARS) return screen;
	const cut = screen.slice(screen.length - FLEET_SESSION_LAST_SCREEN_MAX_CHARS);
	const firstBreak = cut.indexOf('\n');
	return firstBreak >= 0 && firstBreak < 4096 ? cut.slice(firstBreak + 1) : cut;
}

// ─── Ids ────────────────────────────────────────────────────────────────────

/**
 * The daemon's id for a session: `[A-Za-z0-9_-]`, 1–64. The platform names
 * it at start (its own row id), so a node can never be asked to address a
 * path-shaped or oversized id.
 */
const DAEMON_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isFleetDaemonSessionId(value: unknown): value is string {
	return typeof value === 'string' && DAEMON_SESSION_ID_PATTERN.test(value);
}

// ─── The platform's view (REST, tools, CLI `--json`) ────────────────────────

/** Why the session daemon or a session carries a warning (spec U15). */
export type FleetSessionWarning = 'metadata-not-persisted';

/** One session as every surface reads it. */
export interface FleetSessionView {
	id: string;
	nodeId: string;
	/** The person who started it, or the Agent's owner. */
	userId: string;
	/** The Node's Organization binding when the session started. */
	organizationId: string | null;
	kind: FleetSessionKind;
	provider: FleetSessionProvider;
	agentId: string | null;
	agentRunId: string | null;
	checkoutId: string | null;
	cwd: string;
	title: string;
	state: FleetSessionState;
	outcome: FleetSessionOutcome | null;
	endedReason: FleetSessionEndedReason | null;
	/** The process exit code, when the daemon saw one. */
	exitCode: number | null;
	recordingState: FleetSessionRecordingState;
	restartOfSessionId: string | null;
	/** The first message, redacted — a preview, never the raw text. */
	firstMessage: string | null;
	/** `user:<id>` or `agent:<id>` — who started it (CONTRACTS §2.3 `requestedBy` shape). */
	startedBy: string;
	lastActivityAt: string | null;
	startedAt: string | null;
	endedAt: string | null;
	createdAt: string;
	updatedAt: string;
	/** The last 2 000 lines the daemon kept when the session ended (detail only). */
	lastScreen?: string | null;
}

/** `POST /api/fleet/nodes/:id/sessions` (CONTRACTS §11.2). */
export interface FleetSessionStartRequest {
	kind: FleetSessionKind;
	provider: FleetSessionStartableProvider;
	cwd: string;
	title?: string;
	firstMessage?: string;
	agentId?: string;
	checkoutId?: string;
	newWorktreeOf?: string;
	/** The tools' restart path (`fleet_sessions_start` with `restartOf`). */
	restartOf?: string;
	cols?: number;
	rows?: number;
}

/** `POST /api/fleet/sessions/:id/attach-token` (CONTRACTS §3.4). */
export interface FleetSessionAttachTokenResponse {
	token: string;
	role: FleetSessionAttachRole;
	expiresInSec: number;
	/** The viewer socket path, `/ws/fleet/session/<id>`. */
	wsPath: string;
}

/** The viewer socket path for one session (CONTRACTS §3.4). */
export function fleetSessionViewerPath(sessionId: string): string {
	return `/ws/fleet/session/${encodeURIComponent(sessionId)}`;
}

// ─── The session daemon's health (heartbeat `daemon`, CONTRACTS §1.1) ──────

export const FLEET_SESSION_DAEMON_STATES = ['running', 'stopped', 'failed'] as const;

export type FleetSessionDaemonState = (typeof FLEET_SESSION_DAEMON_STATES)[number];

export function isFleetSessionDaemonState(value: unknown): value is FleetSessionDaemonState {
	return typeof value === 'string' && (FLEET_SESSION_DAEMON_STATES as readonly string[]).includes(value);
}

/** Whether the daemon can persist its metadata (spec U15). */
export type FleetSessionDaemonStorage = 'ok' | 'failing';

/**
 * What a node reports about its session daemon in every heartbeat (and in
 * `session.list`): `running` while it answers health, `stopped` when it is
 * not running and nothing has gone wrong (no consent that needs it, or it
 * exited idle), `failed` with the node's own diagnosis in `reason` ("could
 * not bind the local socket", "terminal support is missing").
 */
export interface FleetSessionDaemonReport {
	state: FleetSessionDaemonState;
	/** One line a person reads; never a path to a secret, never a token. */
	reason?: string;
	/** Sessions the daemon holds (live and ended-not-yet-acknowledged). */
	sessions: number;
	/** `failing` when the daemon could not persist a session's metadata (disk full). */
	storage?: FleetSessionDaemonStorage;
	/** FL-05's hook counters (`badTokenLastMinute`, `spooled`, …), carried through untouched. */
	hooks?: Record<string, number>;
}

/** Bound on the daemon report's `reason`. */
export const FLEET_SESSION_DAEMON_REASON_MAX_LENGTH = 300;

/**
 * Read a daemon report off the wire or a stored column: `null` when it is not
 * one. Strings are bounded, counts clamped, unknown keys dropped.
 */
export function normalizeFleetSessionDaemonReport(value: unknown): FleetSessionDaemonReport | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetSessionDaemonState(record.state)) return null;
	const sessions =
		typeof record.sessions === 'number' && Number.isFinite(record.sessions)
			? Math.min(10_000, Math.max(0, Math.floor(record.sessions)))
			: 0;
	const report: FleetSessionDaemonReport = { state: record.state, sessions };
	if (typeof record.reason === 'string' && record.reason.trim().length > 0) {
		report.reason = record.reason.trim().slice(0, FLEET_SESSION_DAEMON_REASON_MAX_LENGTH);
	}
	if (record.storage === 'ok' || record.storage === 'failing') report.storage = record.storage;
	if (typeof record.hooks === 'object' && record.hooks !== null && !Array.isArray(record.hooks)) {
		const hooks: Record<string, number> = {};
		let count = 0;
		for (const [key, raw] of Object.entries(record.hooks as Record<string, unknown>)) {
			if (count >= 16) break;
			if (!/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key)) continue;
			if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
			hooks[key] = Math.max(0, Math.floor(raw));
			count += 1;
		}
		if (count > 0) report.hooks = hooks;
	}
	return report;
}

// ─── The `session` link family (CONTRACTS §3.3) ─────────────────────────────

/**
 * `channel.open { family: 'session', params }`. One channel per attached
 * viewer (it carries `DATA` / `RESIZE` / `EXIT` frames both ways), and one
 * short-lived channel per control request (start, end, rename, restart,
 * screen). `kind` lets the node check the consent before it opens
 * (CONTRACTS R-5); the node checks it again against its own record of the
 * session, so a wrong `kind` can never widen what a channel may do.
 */
export interface FleetSessionChannelParams {
	sessionId: string;
	mode: FleetSessionAttachRole;
	kind?: FleetSessionKind;
}

export function parseFleetSessionChannelParams(value: unknown): FleetSessionChannelParams | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetDaemonSessionId(record.sessionId) || !isFleetSessionAttachRole(record.mode)) return null;
	const params: FleetSessionChannelParams = { sessionId: record.sessionId, mode: record.mode };
	if (record.kind !== undefined) {
		if (!isFleetSessionKind(record.kind)) return null;
		params.kind = record.kind;
	}
	return params;
}

/** The request verbs a platform sends on a `session` channel (`{ requestId, type, params }`). */
export const FLEET_SESSION_LINK_VERBS = [
	'session.start',
	'session.attach',
	'session.input',
	'session.resize',
	'session.end',
	'session.rename',
	'session.restart',
	'session.screen',
	// FL-05 answers prompts through the same channel; FL-04 refuses it until then.
	'session.answer'
] as const;

export type FleetSessionLinkVerb = (typeof FLEET_SESSION_LINK_VERBS)[number];

export function isFleetSessionLinkVerb(value: unknown): value is FleetSessionLinkVerb {
	return typeof value === 'string' && (FLEET_SESSION_LINK_VERBS as readonly string[]).includes(value);
}

/** Who a session was started by, as the daemon records it (no names, ids only). */
export type FleetSessionStarter = `user:${string}` | `agent:${string}`;

const STARTER_PATTERN = /^(user|agent):[A-Za-z0-9_-]{1,64}$/;

export function isFleetSessionStarter(value: unknown): value is FleetSessionStarter {
	return typeof value === 'string' && STARTER_PATTERN.test(value);
}

/** `session.start` params. The node composes argv and environment itself; the platform never sends a command line. */
export interface FleetSessionStartParams {
	kind: FleetSessionKind;
	provider: FleetSessionStartableProvider;
	cwd: string;
	title: string;
	firstMessage?: string;
	cols: number;
	rows: number;
	startedBy: FleetSessionStarter;
}

export function parseFleetSessionStartParams(value: unknown): FleetSessionStartParams | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetSessionKind(record.kind) || !isFleetSessionStartableProvider(record.provider)) return null;
	if (typeof record.cwd !== 'string' || record.cwd.length === 0 || record.cwd.length > FLEET_SESSION_CWD_MAX_LENGTH)
		return null;
	if (record.cwd.includes('\0')) return null;
	if (
		typeof record.title !== 'string' ||
		record.title.trim().length === 0 ||
		record.title.length > FLEET_SESSION_TITLE_MAX_LENGTH
	)
		return null;
	if (!isFleetSessionStarter(record.startedBy)) return null;
	const size = clampFleetSessionSize(record.cols, record.rows);
	const params: FleetSessionStartParams = {
		kind: record.kind,
		provider: record.provider,
		cwd: record.cwd,
		title: record.title.trim(),
		cols: size.cols,
		rows: size.rows,
		startedBy: record.startedBy
	};
	if (record.firstMessage !== undefined && record.firstMessage !== null) {
		if (
			typeof record.firstMessage !== 'string' ||
			record.firstMessage.length > FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH ||
			record.firstMessage.includes('\0')
		)
			return null;
		if (record.firstMessage.trim().length > 0) params.firstMessage = record.firstMessage;
	}
	return params;
}

/** `session.start` / `session.restart` result. */
export interface FleetSessionStartResult {
	daemonSessionId: string;
	pid?: number | null;
}

/** `session.attach` result: the replay follows as `DATA` frames, then live output. */
export interface FleetSessionAttachResult {
	alive: boolean;
	cols: number;
	rows: number;
	exitCode: number | null;
}

/** `session.screen` result: plain text, no escape sequences (for tools and FL-05's rules). */
export interface FleetSessionScreenResult {
	text: string;
	title: string;
	cols: number;
	rows: number;
	alive: boolean;
}

/** Notices on an attached session channel (JSON, node → platform → viewer). */
export type FleetSessionNotice =
	/** The fleet kill switch blocked input; the process keeps running. */
	| { type: 'session.notice'; notice: 'paused'; reason?: string }
	/** Input works again. */
	| { type: 'session.notice'; notice: 'resumed' }
	/** Drain-all: the session ends in `seconds`. */
	| { type: 'session.notice'; notice: 'drain'; seconds: number }
	/** The viewer could not keep up and is being dropped. */
	| { type: 'session.notice'; notice: 'slow-viewer' }
	/** The terminal was resized by the newest driver. */
	| { type: 'session.notice'; notice: 'size'; cols: number; rows: number }
	/**
	 * The stream restarts with a fresh replay (the link came back and the node
	 * re-attached): clear the terminal before writing what follows.
	 */
	| { type: 'session.notice'; notice: 'replay' };

export const FLEET_SESSION_NOTICE_KINDS = ['paused', 'resumed', 'drain', 'slow-viewer', 'size', 'replay'] as const;

export function parseFleetSessionNotice(value: unknown): FleetSessionNotice | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== 'session.notice') return null;
	switch (record.notice) {
		case 'paused':
			return typeof record.reason === 'string'
				? { type: 'session.notice', notice: 'paused', reason: record.reason.slice(0, 300) }
				: { type: 'session.notice', notice: 'paused' };
		case 'resumed':
			return { type: 'session.notice', notice: 'resumed' };
		case 'slow-viewer':
			return { type: 'session.notice', notice: 'slow-viewer' };
		case 'replay':
			return { type: 'session.notice', notice: 'replay' };
		case 'drain':
			return typeof record.seconds === 'number' && Number.isFinite(record.seconds) && record.seconds >= 0
				? { type: 'session.notice', notice: 'drain', seconds: Math.floor(record.seconds) }
				: null;
		case 'size': {
			if (typeof record.cols !== 'number' || typeof record.rows !== 'number') return null;
			const size = clampFleetSessionSize(record.cols, record.rows);
			return { type: 'session.notice', notice: 'size', cols: size.cols, rows: size.rows };
		}
		default:
			return null;
	}
}

// ─── Channel 0, node → platform (CONTRACTS §3.2–3.3) ────────────────────────

export const FLEET_SESSION_EVENTS = ['started', 'exited', 'title', 'activity', 'lost'] as const;

/**
 * `started` — the process is running; `exited` — it ended with `exitCode`
 * (and `reason` when something ended it); `title` — renamed; `activity` —
 * output since the last report (throttled to one per
 * {@link FLEET_SESSION_ACTIVITY_REPORT_MS}); `lost` — the node found the
 * session in its store but no daemon holds it any more (the machine
 * rebooted, or the daemon died).
 */
export type FleetSessionEventKind = (typeof FLEET_SESSION_EVENTS)[number];

export interface FleetSessionEventMessage {
	type: 'session.event';
	sessionId: string;
	event: FleetSessionEventKind;
	exitCode?: number | null;
	title?: string;
	/** The last screen (plain text, bounded) on `exited` and `lost`. */
	screen?: string;
	/** Why it ended, when something ended it (`user`, `drain`, `kill-switch`, …). */
	reason?: FleetSessionEndedReason;
	/** The node's clock; the platform stamps its own times and only orders by this. */
	at?: string;
}

/** One session in `session.list`. */
export interface FleetSessionListEntry {
	sessionId: string;
	kind: FleetSessionKind;
	provider: FleetSessionProvider;
	cwd: string;
	title: string;
	startedAt: string;
	alive: boolean;
	exitCode: number | null;
	cols: number;
	rows: number;
	viewers: number;
	drivers: number;
}

/** Sent once after every `link.ready`: everything the daemon holds, and its health. */
export interface FleetSessionListMessage {
	type: 'session.list';
	sessions: FleetSessionListEntry[];
	daemon: FleetSessionDaemonReport;
}

/** Most sessions one `session.list` carries (owner 8 + agent sessions + ended ones, with headroom). */
export const FLEET_SESSION_LIST_MAX = 256;

/** Channel 0, platform → node: the platform holds these ended sessions' screens; the daemon may forget them. */
export interface FleetSessionAckMessage {
	type: 'session.ack';
	sessionIds: string[];
}

export function parseFleetSessionEvent(value: unknown): FleetSessionEventMessage | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== 'session.event' || !isFleetDaemonSessionId(record.sessionId)) return null;
	if (typeof record.event !== 'string' || !(FLEET_SESSION_EVENTS as readonly string[]).includes(record.event))
		return null;
	const message: FleetSessionEventMessage = {
		type: 'session.event',
		sessionId: record.sessionId,
		event: record.event as FleetSessionEventKind
	};
	if (record.exitCode === null) message.exitCode = null;
	else if (typeof record.exitCode === 'number' && Number.isInteger(record.exitCode))
		message.exitCode = record.exitCode;
	if (typeof record.title === 'string' && record.title.trim().length > 0) {
		message.title = record.title.trim().slice(0, FLEET_SESSION_TITLE_MAX_LENGTH);
	}
	if (typeof record.screen === 'string') message.screen = boundFleetSessionScreen(record.screen);
	if (isFleetSessionEndedReason(record.reason)) message.reason = record.reason;
	if (typeof record.at === 'string' && record.at.length <= 40) message.at = record.at;
	if (message.event === 'title' && message.title === undefined) return null;
	return message;
}

function parseListEntry(value: unknown): FleetSessionListEntry | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetDaemonSessionId(record.sessionId)) return null;
	if (!isFleetSessionKind(record.kind) || !isFleetSessionProvider(record.provider)) return null;
	if (typeof record.cwd !== 'string' || record.cwd.length > FLEET_SESSION_CWD_MAX_LENGTH) return null;
	if (typeof record.title !== 'string') return null;
	if (typeof record.startedAt !== 'string' || record.startedAt.length > 40) return null;
	if (typeof record.alive !== 'boolean') return null;
	const size = clampFleetSessionSize(record.cols, record.rows);
	const count = (raw: unknown): number =>
		typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1000, Math.max(0, Math.floor(raw))) : 0;
	return {
		sessionId: record.sessionId,
		kind: record.kind,
		provider: record.provider,
		cwd: record.cwd,
		title: record.title.slice(0, FLEET_SESSION_TITLE_MAX_LENGTH),
		startedAt: record.startedAt,
		alive: record.alive,
		exitCode: typeof record.exitCode === 'number' && Number.isInteger(record.exitCode) ? record.exitCode : null,
		cols: size.cols,
		rows: size.rows,
		viewers: count(record.viewers),
		drivers: count(record.drivers)
	};
}

export function parseFleetSessionList(value: unknown): FleetSessionListMessage | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== 'session.list' || !Array.isArray(record.sessions)) return null;
	const daemon = normalizeFleetSessionDaemonReport(record.daemon);
	if (!daemon) return null;
	const sessions: FleetSessionListEntry[] = [];
	for (const raw of record.sessions.slice(0, FLEET_SESSION_LIST_MAX)) {
		const entry = parseListEntry(raw);
		if (entry) sessions.push(entry);
	}
	return { type: 'session.list', sessions, daemon };
}

export function parseFleetSessionAck(value: unknown): FleetSessionAckMessage | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.type !== 'session.ack' || !Array.isArray(record.sessionIds)) return null;
	const sessionIds = record.sessionIds.filter(isFleetDaemonSessionId).slice(0, FLEET_SESSION_LIST_MAX);
	return { type: 'session.ack', sessionIds };
}
