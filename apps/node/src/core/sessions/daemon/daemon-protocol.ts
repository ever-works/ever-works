import {
	FLEET_LINK_FRAME_KINDS,
	isFleetDaemonSessionId,
	isFleetSessionAttachRole,
	isFleetSessionEndedReason,
	isFleetSessionKind,
	isFleetSessionStartableProvider,
	isFleetSessionStarter,
	FLEET_SESSION_CWD_MAX_LENGTH,
	FLEET_SESSION_REPLAY_LINES,
	FLEET_SESSION_SCROLLBACK_LINES,
	FLEET_SESSION_TITLE_MAX_LENGTH,
	clampFleetSessionSize,
	type FleetLinkErrorCode,
	type FleetSessionAttachRole,
	type FleetSessionEndedReason,
	type FleetSessionKind,
	type FleetSessionProvider,
	type FleetSessionStarter
} from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04) — the wire between the node and its session
 * daemon (CONTRACTS R-26: a same-user local socket with a token; not a
 * network listener).
 *
 * ## Framing
 *
 * Every message is one frame `[kind u8][len u32 BE][payload]` — the
 * CONTRACTS §3.2 frame kinds WITHOUT the link's channel prefix, so the node
 * bridges a daemon frame onto its link by prepending the channel number and
 * nothing else. `JSON` (10) carries control messages; `DATA` (1), `RESIZE`
 * (2), `EXIT` (3) and `CLOSE` (11) carry a terminal.
 *
 * ## Connections
 *
 * The first frame on every connection is a `hello` with the token, read
 * BEFORE anything else and refused (connection closed) when it is not
 * exactly a valid hello with the right token. The hello names the role:
 *
 *  - `control` — request/reply ops (`{ id, op, … }` → `{ id, ok, result }`
 *    or `{ id, ok: false, error: { code, hint } }`), plus the `watch`
 *    stream of session events once asked for;
 *  - `attach` — one session's terminal: the daemon answers `attached`,
 *    replays the screen as `DATA`, then streams live output; the node sends
 *    `DATA` (input, drivers only) and `RESIZE` (drivers only).
 */

export const DAEMON_PROTOCOL_VERSION = 1;

/** The frame kinds the local wire uses (a subset of CONTRACTS §3.2). */
export const DAEMON_FRAME = {
	DATA: FLEET_LINK_FRAME_KINDS.DATA,
	RESIZE: FLEET_LINK_FRAME_KINDS.RESIZE,
	EXIT: FLEET_LINK_FRAME_KINDS.EXIT,
	JSON: FLEET_LINK_FRAME_KINDS.JSON,
	CLOSE: FLEET_LINK_FRAME_KINDS.CLOSE
} as const;

export type DaemonFrameKind = (typeof DAEMON_FRAME)[keyof typeof DAEMON_FRAME];

const FRAME_KINDS: ReadonlySet<number> = new Set(Object.values(DAEMON_FRAME));

/** `[kind u8][len u32]`. */
export const DAEMON_FRAME_HEADER_BYTES = 5;

/** Largest frame payload on the local wire. */
export const DAEMON_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** Largest frame accepted before the hello authenticated the connection. */
export const DAEMON_MAX_HELLO_BYTES = 4096;

/** A connection that has not sent a valid hello within this long is closed. */
export const DAEMON_HELLO_TIMEOUT_MS = 5_000;

export interface DaemonFrame {
	kind: DaemonFrameKind;
	payload: Uint8Array;
}

export function encodeDaemonFrame(kind: DaemonFrameKind, payload: Uint8Array): Buffer {
	if (payload.byteLength > DAEMON_MAX_PAYLOAD_BYTES) throw new Error('daemon frame over 16 MiB');
	const frame = Buffer.allocUnsafe(DAEMON_FRAME_HEADER_BYTES + payload.byteLength);
	frame.writeUInt8(kind, 0);
	frame.writeUInt32BE(payload.byteLength, 1);
	frame.set(payload, DAEMON_FRAME_HEADER_BYTES);
	return frame;
}

export function encodeDaemonJson(message: unknown): Buffer {
	return encodeDaemonFrame(DAEMON_FRAME.JSON, Buffer.from(JSON.stringify(message), 'utf8'));
}

export function encodeDaemonResize(cols: number, rows: number): Buffer {
	const payload = Buffer.allocUnsafe(4);
	payload.writeUInt16BE(cols, 0);
	payload.writeUInt16BE(rows, 2);
	return encodeDaemonFrame(DAEMON_FRAME.RESIZE, payload);
}

export function encodeDaemonExit(code: number | null): Buffer {
	const payload = Buffer.allocUnsafe(4);
	// `-2147483648` (i32 min) stands for "no exit code" — the process was lost.
	payload.writeInt32BE(code === null ? -2147483648 : code | 0, 0);
	return encodeDaemonFrame(DAEMON_FRAME.EXIT, payload);
}

export function decodeDaemonResize(payload: Uint8Array): { cols: number; rows: number } | null {
	if (payload.byteLength !== 4) return null;
	const view = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
	return clampFleetSessionSize(view.readUInt16BE(0), view.readUInt16BE(2));
}

export function decodeDaemonExit(payload: Uint8Array): number | null {
	if (payload.byteLength !== 4) return null;
	const code = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).readInt32BE(0);
	return code === -2147483648 ? null : code;
}

/** Parse a JSON payload; null for anything that is not a JSON object. `__proto__` keys are dropped. */
export function decodeDaemonJson(payload: Uint8Array): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(
			Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8'),
			(key, inner) => (key === '__proto__' ? undefined : inner)
		);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Incremental frame reader for a byte stream. `push` returns the frames
 * completed so far, or `null` once the stream broke the protocol (an unknown
 * kind, or a frame over the current cap) — the connection is then closed;
 * nothing is ever thrown.
 */
export class DaemonFrameReader {
	private buffer: Buffer = Buffer.alloc(0);
	private broken = false;

	constructor(private maxPayload: number = DAEMON_MAX_PAYLOAD_BYTES) {}

	/** Raise (or lower) the cap — the hello is read under a small one. */
	setMaxPayload(bytes: number): void {
		this.maxPayload = bytes;
	}

	push(chunk: Uint8Array): DaemonFrame[] | null {
		if (this.broken) return null;
		this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
		const frames: DaemonFrame[] = [];
		while (this.buffer.length >= DAEMON_FRAME_HEADER_BYTES) {
			const kind = this.buffer.readUInt8(0);
			const length = this.buffer.readUInt32BE(1);
			if (!FRAME_KINDS.has(kind) || length > this.maxPayload) {
				this.broken = true;
				this.buffer = Buffer.alloc(0);
				return null;
			}
			if (this.buffer.length < DAEMON_FRAME_HEADER_BYTES + length) break;
			const payload = this.buffer.subarray(DAEMON_FRAME_HEADER_BYTES, DAEMON_FRAME_HEADER_BYTES + length);
			frames.push({ kind: kind as DaemonFrameKind, payload: Buffer.from(payload) });
			this.buffer = this.buffer.subarray(DAEMON_FRAME_HEADER_BYTES + length);
		}
		return frames;
	}
}

// ─── Hello ──────────────────────────────────────────────────────────────────

export type DaemonConnectionRole = 'control' | 'attach';

export interface DaemonHello {
	op: 'hello';
	token: string;
	role: DaemonConnectionRole;
	/** The node's version (the daemon asks an older node to upgrade nothing; it is logged). */
	nodeVersion?: string;
	/** `attach` only: which session, as what. */
	attach?: { id: string; mode: FleetSessionAttachRole; cols?: number; rows?: number };
}

export function parseDaemonHello(value: Record<string, unknown> | null): DaemonHello | null {
	if (!value || value.op !== 'hello') return null;
	if (typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 256) return null;
	if (value.role !== 'control' && value.role !== 'attach') return null;
	const hello: DaemonHello = { op: 'hello', token: value.token, role: value.role };
	if (typeof value.nodeVersion === 'string' && value.nodeVersion.length <= 40) hello.nodeVersion = value.nodeVersion;
	if (value.role === 'attach') {
		const attach = value.attach as Record<string, unknown> | undefined;
		if (!attach || typeof attach !== 'object') return null;
		if (!isFleetDaemonSessionId(attach.id) || !isFleetSessionAttachRole(attach.mode)) return null;
		hello.attach = { id: attach.id, mode: attach.mode };
		if (typeof attach.cols === 'number') hello.attach.cols = attach.cols;
		if (typeof attach.rows === 'number') hello.attach.rows = attach.rows;
	}
	return hello;
}

// ─── Control ops ────────────────────────────────────────────────────────────

export const DAEMON_CONTROL_OPS = [
	'health',
	'list',
	'start',
	'resize',
	'rename',
	'end',
	'input',
	'screen',
	'block-input',
	'warn',
	'ack-ended',
	'watch',
	'shutdown-when-idle'
] as const;

export type DaemonControlOp = (typeof DAEMON_CONTROL_OPS)[number];

export interface DaemonError {
	code: FleetLinkErrorCode;
	hint: string;
}

export type DaemonReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: DaemonError };

/** The command the node composed for a session — the daemon runs it, it never composes one. */
export interface DaemonStartRequest {
	id: string;
	kind: FleetSessionKind;
	provider: FleetSessionProvider;
	/** argv[0] and its arguments. Never run through a shell by the daemon. */
	command: string[];
	cwd: string;
	/** The complete child environment (the node composed and scrubbed it). */
	env: Record<string, string>;
	cols: number;
	rows: number;
	title: string;
	startedBy: FleetSessionStarter;
}

const MAX_ARGV = 256;
const MAX_ARG_LENGTH = 32 * 1024;
const MAX_ENV_ENTRIES = 4096;

export function parseDaemonStartRequest(value: Record<string, unknown>): DaemonStartRequest | DaemonError {
	const invalid = (hint: string): DaemonError => ({ code: 'invalid', hint });
	if (!isFleetDaemonSessionId(value.sessionId)) return invalid('sessionId');
	if (!isFleetSessionKind(value.kind)) return invalid('kind');
	if (!isFleetSessionStartableProvider(value.provider)) return invalid('provider');
	if (
		!Array.isArray(value.command) ||
		value.command.length === 0 ||
		value.command.length > MAX_ARGV ||
		!value.command.every((arg) => typeof arg === 'string' && arg.length <= MAX_ARG_LENGTH && !arg.includes('\0')) ||
		(value.command[0] as string).length === 0
	)
		return invalid('command');
	if (typeof value.cwd !== 'string' || value.cwd.length === 0 || value.cwd.length > FLEET_SESSION_CWD_MAX_LENGTH)
		return invalid('cwd');
	if (typeof value.env !== 'object' || value.env === null || Array.isArray(value.env)) return invalid('env');
	const env: Record<string, string> = {};
	let count = 0;
	for (const [key, raw] of Object.entries(value.env as Record<string, unknown>)) {
		if (
			typeof raw !== 'string' ||
			key.length === 0 ||
			key.includes('=') ||
			key.includes('\0') ||
			raw.includes('\0')
		)
			continue;
		env[key] = raw;
		count += 1;
		if (count > MAX_ENV_ENTRIES) return invalid('env');
	}
	if (
		typeof value.title !== 'string' ||
		value.title.trim().length === 0 ||
		value.title.length > FLEET_SESSION_TITLE_MAX_LENGTH
	)
		return invalid('title');
	if (!isFleetSessionStarter(value.startedBy)) return invalid('startedBy');
	const size = clampFleetSessionSize(value.cols, value.rows);
	return {
		id: value.sessionId,
		kind: value.kind,
		provider: value.provider,
		command: value.command as string[],
		cwd: value.cwd,
		env,
		cols: size.cols,
		rows: size.rows,
		title: value.title.trim(),
		startedBy: value.startedBy
	};
}

export function parseEndReason(value: unknown): FleetSessionEndedReason {
	return isFleetSessionEndedReason(value) ? value : 'user';
}

/** Lines a `screen` op may ask for. */
export function clampScreenLines(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 40;
	return Math.min(FLEET_SESSION_REPLAY_LINES, Math.max(1, Math.floor(value)));
}

/** One session as the daemon lists it. */
export interface DaemonSessionInfo {
	id: string;
	kind: FleetSessionKind;
	provider: FleetSessionProvider;
	cwd: string;
	title: string;
	startedAt: string;
	startedBy: FleetSessionStarter;
	alive: boolean;
	exitCode: number | null;
	/** Ended by something (`user`, `drain`, …) rather than on its own; null while alive or for a plain exit. */
	endReason: FleetSessionEndedReason | null;
	/** Found in the store after a daemon restart: the process is gone, the screen is the last one persisted. */
	lost: boolean;
	cols: number;
	rows: number;
	viewers: number;
	drivers: number;
}

export interface DaemonHealth {
	ok: true;
	daemonVersion: string;
	protocol: number;
	pty: 'available' | 'missing';
	ptyReason?: string;
	sessions: number;
	uptimeSec: number;
	storage: 'ok' | 'failing';
}

/** A `watch` stream event. */
export type DaemonWatchEvent =
	| { event: 'started'; id: string; at: string }
	| { event: 'exited'; id: string; exitCode: number | null; reason: FleetSessionEndedReason | null; at: string }
	| { event: 'title'; id: string; title: string; at: string }
	| { event: 'activity'; id: string; at: string };

/** The scrollback the grid keeps (spec FR-4). Re-exported so the daemon reads one constant. */
export const DAEMON_SCROLLBACK_LINES = FLEET_SESSION_SCROLLBACK_LINES;
