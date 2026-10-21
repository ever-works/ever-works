/**
 * Fleet — Commands on computers (FL-12, CONTRACTS §3.3, §4.4, §7, §8, §10,
 * §10.1, §11.2, R-11, R-24).
 *
 * A **Command** is one command line sent to one or more computers. Each
 * computer runs it once — in the machine owner's login shell, as that user,
 * from their home folder (or a folder they allowed), with NO stdin — and
 * reports its output, its exit code and how it ended. One computer's
 * execution is a **Command run**.
 *
 * Commands are IMMEDIATE (CONTRACTS R-11): delivered over the node link, never
 * queued, never retried. A computer that is offline, or whose link is down,
 * fails its run `unreachable` on the spot. A Command WITH a cadence is a
 * Schedule (FL-13); this epic only reserves its columns.
 *
 * ## Link (CONTRACTS §3.3, `command` family, consent `manage`)
 *
 * One channel per run, opened by the platform with
 * `{ commandId, nodeId, runId }`:
 *
 * ```
 *  platform                                         node
 *  channel.open { family: 'command', params } ────►  refuses without --manage
 *  { requestId, type: 'command.run', params } ────►  spawns the login shell, no stdin
 *                                  ◄──────────────── { requestId, result: { pid, startedAt, shell } }
 *                                  ◄──────────────── DATA … (stdout + stderr as emitted, ≤ 64 KiB each)
 *                                  ◄──────────────── JSON command.truncated { runId, bytes }   (at the 10 MiB cap)
 *                                  ◄──────────────── JSON command.timeout { runId, timeoutSec } (the timeout fired)
 *                                  ◄──────────────── JSON command.output { runId, head, tail, … } (on finish)
 *                                  ◄──────────────── EXIT [code], then channel.close
 *  { requestId, type: 'command.cancel' } ─────────►  ends the process tree, EXIT 130
 * ```
 *
 * Everything here is a wire or storage shape; every union carries a
 * `readonly` list and an `isX` guard, and every node→platform message has a
 * parser that answers `null` — never throws — for anything it does not
 * recognise (the node is a different release of the code).
 */

import type { FleetLinkError } from './fleet-link.types.js';

// ─── Limits (CONTRACTS §10, §10.1) ──────────────────────────────────────────

/** Default timeout of one Command, seconds. */
export const FLEET_COMMAND_DEFAULT_TIMEOUT_SEC = 600;

/** Shortest timeout a Command may ask for, seconds. */
export const FLEET_COMMAND_MIN_TIMEOUT_SEC = 1;

/** Longest timeout a Command may ask for, seconds (an hour). */
export const FLEET_COMMAND_MAX_TIMEOUT_SEC = 3600;

/** The timeout menu the hub offers: 1 · 5 · 10 · 30 · 60 minutes. */
export const FLEET_COMMAND_TIMEOUT_CHOICES_SEC: readonly number[] = [60, 300, 600, 1800, 3600];

/** Output one run may produce on the machine before the node stops keeping it. */
export const FLEET_COMMAND_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** The platform stores the first and the last this-many bytes of each run. */
export const FLEET_COMMAND_STORED_EDGE_BYTES = 64 * 1024;

/** Largest `DATA` frame the node sends for a command. */
export const FLEET_COMMAND_DATA_CHUNK_BYTES = 64 * 1024;

/** One-off Commands the hub keeps as Recent. */
export const FLEET_COMMAND_RECENT = 8;

/** Longest command line, in UTF-8 bytes (CONTRACTS §10 rev 5). */
export const FLEET_COMMAND_MAX_LENGTH = 8 * 1024;

/** Most computers one Command may target (CONTRACTS §10 rev 5). */
export const FLEET_COMMAND_MAX_NODES = 50;

/** Commands one owner may have running at once (CONTRACTS §10 rev 5). */
export const FLEET_COMMAND_MAX_CONCURRENT_PER_OWNER = 8;

/** Command runs one person may start per minute (CONTRACTS §10.1). */
export const FLEET_COMMAND_RUNS_PER_MINUTE = 10;

/** Runs whose full output the node keeps (the rest are deleted oldest first). */
export const FLEET_COMMAND_KEPT_RUNS_ON_NODE = 30;

/** Longest folder path a Command may name. */
export const FLEET_COMMAND_CWD_MAX_LENGTH = 1024;

/**
 * A run whose link dropped is held this long for the link to return with its
 * exit (spec U2); after it the run ends `failed` with reason `link-lost`.
 */
export const FLEET_COMMAND_LINK_LOST_GRACE_MS = 120_000;

/** After the polite stop (SIGTERM / taskkill), how long until the tree is killed outright. */
export const FLEET_COMMAND_KILL_GRACE_MS = 10_000;

/** Exit code a timed-out command reports (the `timeout(1)` convention). */
export const FLEET_COMMAND_TIMEOUT_EXIT_CODE = 124;

/** Exit code a cancelled command reports (128 + SIGINT). */
export const FLEET_COMMAND_CANCEL_EXIT_CODE = 130;

/** Exit code a command the kill switch or a drain stopped reports (128 + SIGKILL). */
export const FLEET_COMMAND_STOPPED_EXIT_CODE = 137;

/** The sentence every confirmation of a Command carries, verbatim (spec FR-11). */
export const FLEET_COMMAND_SANDBOX_SENTENCE = 'These are real machines, not a sandbox.';

// ─── States (CONTRACTS §4.4) ────────────────────────────────────────────────

/** A Command's own state (one-off Commands). */
export const FLEET_COMMAND_STATES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;

export type FleetCommandState = (typeof FLEET_COMMAND_STATES)[number];

export function isFleetCommandState(value: unknown): value is FleetCommandState {
	return typeof value === 'string' && (FLEET_COMMAND_STATES as readonly string[]).includes(value);
}

/** One computer's run. The two `skipped-*` statuses belong to Schedules (FL-13). */
export const FLEET_COMMAND_RUN_STATUSES = [
	'running',
	'done',
	'failed',
	'timeout',
	'skipped-overlap',
	'skipped-offline'
] as const;

export type FleetCommandRunStatus = (typeof FLEET_COMMAND_RUN_STATUSES)[number];

export function isFleetCommandRunStatus(value: unknown): value is FleetCommandRunStatus {
	return typeof value === 'string' && (FLEET_COMMAND_RUN_STATUSES as readonly string[]).includes(value);
}

/** Statuses a one-off run moves through (spec FR-4). */
export const FLEET_COMMAND_ONE_OFF_RUN_STATUSES: readonly FleetCommandRunStatus[] = [
	'running',
	'done',
	'failed',
	'timeout'
];

/** True while the run's process may still be running. */
export function isFleetCommandRunLive(status: FleetCommandRunStatus): boolean {
	return status === 'running';
}

/** Why a `failed` run failed when it ran (a refusal before it ran carries `errorCode` instead). */
export const FLEET_COMMAND_FAILED_REASONS = [
	'link-lost',
	'node-restart',
	'kill-switch',
	'drain',
	'shell-failed',
	'cancelled-by-user'
] as const;

export type FleetCommandFailedReason = (typeof FLEET_COMMAND_FAILED_REASONS)[number];

export function isFleetCommandFailedReason(value: unknown): value is FleetCommandFailedReason {
	return typeof value === 'string' && (FLEET_COMMAND_FAILED_REASONS as readonly string[]).includes(value);
}

/** Who asked for a Command (CONTRACTS §4.4; the Agent's id is in the audit row). */
export const FLEET_COMMAND_REQUESTERS = ['user', 'agent'] as const;

export type FleetCommandRequester = (typeof FLEET_COMMAND_REQUESTERS)[number];

export function isFleetCommandRequester(value: unknown): value is FleetCommandRequester {
	return value === 'user' || value === 'agent';
}

/**
 * How the node ended a run on its own, reported in `command.output.reason`:
 * one of the failure reasons it knows, or `timeout`.
 */
export const FLEET_COMMAND_NODE_END_REASONS = [
	'timeout',
	'kill-switch',
	'drain',
	'shell-failed',
	'cancelled-by-user'
] as const;

export type FleetCommandNodeEndReason = (typeof FLEET_COMMAND_NODE_END_REASONS)[number];

export function isFleetCommandNodeEndReason(value: unknown): value is FleetCommandNodeEndReason {
	return typeof value === 'string' && (FLEET_COMMAND_NODE_END_REASONS as readonly string[]).includes(value);
}

// ─── Views (what every surface reads) ───────────────────────────────────────

/** One computer's run, as the hub card, the CLI `--json` and the tools read it. */
export interface FleetCommandRunView {
	id: string;
	commandId: string;
	nodeId: string;
	/** The computer's name now, or null when it was removed (history outlives the computer). */
	nodeName: string | null;
	status: FleetCommandRunStatus;
	failedReason: FleetCommandFailedReason | null;
	exitCode: number | null;
	/**
	 * A refusal before the command ran on this computer (`unreachable`,
	 * `consent_missing`, `permission_denied`, `unsupported_on_node`,
	 * `kill_switch`, …) with its CONTRACTS §8 hint, or a failure to start
	 * (`operation_failed`); null when it ran.
	 */
	error: FleetLinkError | null;
	startedAt: string;
	endedAt: string | null;
	/** endedAt − startedAt, or the time so far while running. */
	durationMs: number | null;
	/** The first 64 KiB (all of it when it fit in 128 KiB), redacted. */
	outputHead: string;
	/** The last 64 KiB when the output was larger than 128 KiB, else ''. Redacted. */
	outputTail: string;
	/** Bytes between the head and the tail are not stored. */
	truncated: boolean;
	/** The node stopped keeping output at 10 MiB (spec U6). */
	capped: boolean;
	/** Bytes the command printed, as far as the platform knows. */
	outputBytes: number;
	/** True when the machine still holds the full output (P2 "Open full output"). */
	hasFullOutput: boolean;
	/**
	 * Running, but the platform holds no link to the computer right now (spec
	 * U2: "the command may still be running there"); false otherwise.
	 */
	linkDown: boolean;
	/**
	 * Schedules on computers (FL-13) — the fire a schedule's run belongs to
	 * (ISO), null for a Run now and for one-off Commands. Absent on a
	 * platform older than schedules.
	 */
	scheduledFor?: string | null;
}

export interface FleetCommandSummary {
	total: number;
	running: number;
	succeeded: number;
	/** Refused, failed and timed out. */
	failed: number;
	timedOut: number;
	/** The longest run so far, ms. */
	longestMs: number;
}

/** One Command with its runs. */
export interface FleetCommandView {
	id: string;
	userId: string;
	/** The command line as stored — redacted when it tripped the secret scanner (FR-13). */
	command: string;
	/** True when the stored command line was redacted. */
	commandRedacted: boolean;
	cwd: string | null;
	timeoutSec: number;
	requestedBy: FleetCommandRequester;
	state: FleetCommandState;
	nodeIds: string[];
	createdAt: string;
	updatedAt: string;
	runs: FleetCommandRunView[];
	summary: FleetCommandSummary;
}

/** `POST /api/fleet/commands` (CONTRACTS §2.2 class `confirm`). */
export interface FleetCommandRunRequest {
	command: string;
	nodeIds: string[];
	/** Default: the machine owner's home folder. `~` and `~/…` expand on the machine. */
	cwd?: string;
	/** Default 600, clamp 1–3600. */
	timeoutSec?: number;
	/** CONTRACTS §2.2: without it the call answers `confirmation_required` with the summary. */
	confirm?: boolean;
	/** Schedules (FL-13). Refused on a one-off Command. */
	cadence?: unknown;
}

/** One computer in a confirmation summary (the dialog's line per machine). */
export interface FleetCommandTargetSummary {
	nodeId: string;
	nodeName: string;
	/** `Linux` · `macOS` · `Windows` · null when unknown. */
	os: string | null;
	/** `PowerShell` on Windows, else `the login shell`. */
	shell: string;
	/** Always the machine owner (Commands never run as anyone else). */
	user: 'machine-owner';
	/** The folder as asked, or `~`. */
	folder: string;
	/** False when this computer will refuse; `error` says why. */
	runnable: boolean;
	error: FleetLinkError | null;
}

/** `details` of a `confirmation_required` answer to a Command. */
export interface FleetCommandConfirmationDetails {
	class: 'confirm';
	command: string;
	timeoutSec: number;
	sentence: typeof FLEET_COMMAND_SANDBOX_SENTENCE;
	/** One line per computer, in the order asked. */
	summary: FleetCommandTargetSummary[];
	runnable: number;
}

/** `GET /api/fleet/commands`. */
export interface FleetCommandListResponse {
	commands: FleetCommandView[];
}

/**
 * `GET /api/fleet/nodes/:id/commands/last` (P2, spec §5.3): the latest run of
 * the person's own Commands on one computer — "Last command: `uptime` · ✓ ·
 * 3 min ago" on its Overview — or `{ last: null }`.
 */
export interface FleetCommandLastRunResponse {
	last: { commandId: string; command: string; run: FleetCommandRunView } | null;
}

/**
 * The run summary every surface prints: "All done · 0.9 s", "1 of 2 failed ·
 * 1.2 s", "2 running". Counts only; the words are the surface's own.
 */
export function summarizeFleetCommandRuns(
	runs: readonly { status: FleetCommandRunStatus; durationMs?: number | null }[]
): FleetCommandSummary {
	const summary: FleetCommandSummary = {
		total: runs.length,
		running: 0,
		succeeded: 0,
		failed: 0,
		timedOut: 0,
		longestMs: 0
	};
	for (const run of runs) {
		if (run.status === 'running') summary.running += 1;
		else if (run.status === 'done') summary.succeeded += 1;
		else {
			summary.failed += 1;
			if (run.status === 'timeout') summary.timedOut += 1;
		}
		if (typeof run.durationMs === 'number' && run.durationMs > summary.longestMs) summary.longestMs = run.durationMs;
	}
	return summary;
}

/** The Command's own state from its runs (spec FR-4): running until every run ended. */
export function fleetCommandStateFor(
	runs: readonly { status: FleetCommandRunStatus }[],
	cancelled = false
): FleetCommandState {
	if (runs.length === 0) return 'queued';
	if (runs.some((run) => run.status === 'running')) return 'running';
	if (cancelled) return 'cancelled';
	return runs.every((run) => run.status === 'done') ? 'done' : 'failed';
}

/** The exit code the CLI answers with (spec FR-19): 0 · 1 any failed · 124 any timed out. */
export function fleetCommandCliExitCode(runs: readonly { status: FleetCommandRunStatus }[]): 0 | 1 | 124 {
	if (runs.some((run) => run.status === 'timeout')) return 124;
	if (runs.some((run) => run.status !== 'done')) return 1;
	return 0;
}

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** UTF-8 length of a string without allocating a buffer per call site. */
export function fleetCommandUtf8Length(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}

/** Clamp a requested timeout to 1–3600 s; anything that is not a finite number is the default. */
export function clampFleetCommandTimeout(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return FLEET_COMMAND_DEFAULT_TIMEOUT_SEC;
	return Math.min(FLEET_COMMAND_MAX_TIMEOUT_SEC, Math.max(FLEET_COMMAND_MIN_TIMEOUT_SEC, Math.floor(value)));
}

/** A command line the platform and the node accept: 1 … 8 KiB of UTF-8, no NUL. */
export function isFleetCommandLine(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (value.trim().length === 0 || value.includes('\0')) return false;
	return fleetCommandUtf8Length(value) <= FLEET_COMMAND_MAX_LENGTH;
}

/** A folder the platform forwards: 1 … 1 024 characters, no NUL, no line break. */
export function isFleetCommandCwd(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		value.length <= FLEET_COMMAND_CWD_MAX_LENGTH &&
		!/[\0\r\n]/.test(value)
	);
}

// ─── Head and tail (CONTRACTS §10: 64 KiB each) ─────────────────────────────

/** What a finished run's head and tail are, as text. */
export interface FleetCommandEdges {
	head: string;
	tail: string;
	truncated: boolean;
	bytes: number;
}

const decoder = (): { decode(bytes: Uint8Array): string } => {
	const Decoder = (globalThis as { TextDecoder?: new (label?: string) => { decode(bytes: Uint8Array): string } })
		.TextDecoder;
	if (!Decoder) {
		return {
			decode: (bytes) => {
				let out = '';
				for (const byte of bytes) out += String.fromCharCode(byte);
				return out;
			}
		};
	}
	return new Decoder('utf-8');
};

/**
 * Keeps the first and the last `edgeBytes` of a byte stream, in constant
 * memory, however much flows through it — the node while a command runs
 * (what it sends in `command.output`), the platform while it shows a card
 * live. The head is filled first; every byte after it goes through a ring
 * that holds the most recent `edgeBytes`.
 */
export class FleetCommandEdgeBuffer {
	private readonly head: Uint8Array;
	private headLength = 0;
	private readonly ring: Uint8Array;
	private ringStart = 0;
	private ringLength = 0;
	private total = 0;

	constructor(private readonly edgeBytes: number = FLEET_COMMAND_STORED_EDGE_BYTES) {
		const size = Math.max(1, Math.floor(edgeBytes));
		this.edgeBytes = size;
		this.head = new Uint8Array(size);
		this.ring = new Uint8Array(size);
	}

	/** Bytes pushed so far. */
	get bytes(): number {
		return this.total;
	}

	/** True when bytes between the head and the tail were not kept. */
	get truncated(): boolean {
		return this.total > this.headLength + this.ringLength;
	}

	push(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;
		this.total += chunk.byteLength;
		let rest = chunk;
		if (this.headLength < this.edgeBytes) {
			const take = Math.min(this.edgeBytes - this.headLength, rest.byteLength);
			this.head.set(rest.subarray(0, take), this.headLength);
			this.headLength += take;
			rest = rest.subarray(take);
		}
		if (rest.byteLength === 0) return;
		const size = this.edgeBytes;
		if (rest.byteLength >= size) {
			this.ring.set(rest.subarray(rest.byteLength - size));
			this.ringStart = 0;
			this.ringLength = size;
			return;
		}
		const write = (this.ringStart + this.ringLength) % size;
		const first = Math.min(rest.byteLength, size - write);
		this.ring.set(rest.subarray(0, first), write);
		if (first < rest.byteLength) this.ring.set(rest.subarray(first), 0);
		const length = this.ringLength + rest.byteLength;
		if (length > size) {
			this.ringStart = (this.ringStart + (length - size)) % size;
			this.ringLength = size;
		} else {
			this.ringLength = length;
		}
	}

	/** The tail bytes, oldest first. */
	tailBytes(): Uint8Array {
		const size = this.edgeBytes;
		const out = new Uint8Array(this.ringLength);
		const first = Math.min(this.ringLength, size - this.ringStart);
		out.set(this.ring.subarray(this.ringStart, this.ringStart + first), 0);
		if (first < this.ringLength) out.set(this.ring.subarray(0, this.ringLength - first), first);
		return out;
	}

	/**
	 * The edges as text. When nothing was dropped the whole output is the
	 * head (decoded in one piece, so no character is split at the seam) and
	 * the tail is empty.
	 */
	snapshot(): FleetCommandEdges {
		const text = decoder();
		const tail = this.tailBytes();
		if (!this.truncated) {
			const all = new Uint8Array(this.headLength + tail.byteLength);
			all.set(this.head.subarray(0, this.headLength), 0);
			all.set(tail, this.headLength);
			return { head: text.decode(all), tail: '', truncated: false, bytes: this.total };
		}
		return {
			head: text.decode(this.head.subarray(0, this.headLength)),
			tail: text.decode(tail),
			truncated: true,
			bytes: this.total
		};
	}
}

/** Bound a head or tail that arrived over the wire to what the platform stores (characters ≈ bytes). */
export function boundFleetCommandEdge(value: unknown): string {
	if (typeof value !== 'string') return '';
	// A UTF-8 byte is at least one UTF-16 unit, so this never cuts a stored edge short.
	return value.length > FLEET_COMMAND_STORED_EDGE_BYTES * 2 ? value.slice(0, FLEET_COMMAND_STORED_EDGE_BYTES * 2) : value;
}

// ─── Link messages (CONTRACTS §3.3 `command` family) ────────────────────────

/**
 * Requests the platform sends on a `command` channel. `command.read { runId }`
 * (P2, "Open full output") streams the run's kept output from the machine's
 * store on a channel of its own: the reply carries `{ bytes }`, then `DATA`
 * chunks of at most 64 KiB, then `END` and the close.
 */
export const FLEET_COMMAND_LINK_VERBS = ['command.run', 'command.cancel', 'command.read'] as const;

export type FleetCommandLinkVerb = (typeof FLEET_COMMAND_LINK_VERBS)[number];

export function isFleetCommandLinkVerb(value: unknown): value is FleetCommandLinkVerb {
	return typeof value === 'string' && (FLEET_COMMAND_LINK_VERBS as readonly string[]).includes(value);
}

/** A run id / command id on the wire: a platform uuid. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFleetCommandId(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** What a `command` channel opens with. */
export interface FleetCommandChannelParams {
	commandId: string;
	nodeId: string;
	runId: string;
}

export function parseFleetCommandChannelParams(value: unknown): FleetCommandChannelParams | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetCommandId(record.commandId) || !isFleetCommandId(record.runId)) return null;
	if (typeof record.nodeId !== 'string' || record.nodeId.length === 0 || record.nodeId.length > 64) return null;
	return { commandId: record.commandId, nodeId: record.nodeId, runId: record.runId };
}

/** `command.run` params. */
export interface FleetCommandRunParams {
	runId: string;
	command: string;
	/** Absent = the machine owner's home folder. */
	cwd?: string;
	timeoutSec: number;
}

export function parseFleetCommandRunParams(value: unknown): FleetCommandRunParams | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetCommandId(record.runId) || !isFleetCommandLine(record.command)) return null;
	if (typeof record.timeoutSec !== 'number' || !Number.isFinite(record.timeoutSec)) return null;
	if (record.timeoutSec > FLEET_COMMAND_MAX_TIMEOUT_SEC || record.timeoutSec < FLEET_COMMAND_MIN_TIMEOUT_SEC) return null;
	const params: FleetCommandRunParams = {
		runId: record.runId,
		command: record.command,
		timeoutSec: Math.floor(record.timeoutSec)
	};
	if (record.cwd !== undefined && record.cwd !== null) {
		if (!isFleetCommandCwd(record.cwd)) return null;
		params.cwd = record.cwd.trim();
	}
	return params;
}

/** The node's reply to `command.run`: the process started. */
export interface FleetCommandRunStarted {
	pid: number | null;
	/** ISO instant on the machine's clock. */
	startedAt: string;
	/** The shell as the machine resolved it (`/bin/zsh -l`, `pwsh`, …) — a path, never the command. */
	shell: string;
}

/** Node → platform on the channel: the 10 MiB cap was reached; the command keeps running (spec U6). */
export interface FleetCommandTruncatedMessage {
	type: 'command.truncated';
	runId: string;
	bytes: number;
}

/** Node → platform on the channel: the timeout fired; the tree is being ended (spec U1). */
export interface FleetCommandTimeoutMessage {
	type: 'command.timeout';
	runId: string;
	timeoutSec: number;
}

/**
 * Node → platform on the channel, once, just before `EXIT`: the run's head
 * and tail as the machine kept them (authoritative — the platform's own live
 * copy may have missed bytes while the link was down), how much it printed,
 * and, when the node ended it itself, why.
 */
export interface FleetCommandOutputMessage {
	type: 'command.output';
	runId: string;
	head: string;
	tail: string;
	truncated: boolean;
	capped: boolean;
	bytes: number;
	exitCode: number | null;
	reason?: FleetCommandNodeEndReason;
	/** The first line of the error when the shell could not start (spec U7). Never the command. */
	detail?: string;
	/** True when the machine kept the full output (for "Open full output"). */
	kept: boolean;
}

export type FleetCommandNodeMessage =
	| FleetCommandTruncatedMessage
	| FleetCommandTimeoutMessage
	| FleetCommandOutputMessage;

const boundCount = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;

/** One node→platform message on a `command` channel, or null for anything else. */
export function parseFleetCommandNodeMessage(value: unknown): FleetCommandNodeMessage | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isFleetCommandId(record.runId)) return null;
	switch (record.type) {
		case 'command.truncated':
			return { type: 'command.truncated', runId: record.runId, bytes: boundCount(record.bytes) };
		case 'command.timeout':
			return { type: 'command.timeout', runId: record.runId, timeoutSec: boundCount(record.timeoutSec) };
		case 'command.output': {
			const message: FleetCommandOutputMessage = {
				type: 'command.output',
				runId: record.runId,
				head: boundFleetCommandEdge(record.head),
				tail: boundFleetCommandEdge(record.tail),
				truncated: record.truncated === true,
				capped: record.capped === true,
				bytes: boundCount(record.bytes),
				exitCode:
					typeof record.exitCode === 'number' && Number.isInteger(record.exitCode) ? record.exitCode : null,
				kept: record.kept === true
			};
			if (isFleetCommandNodeEndReason(record.reason)) message.reason = record.reason;
			if (typeof record.detail === 'string' && record.detail.trim().length > 0) {
				message.detail = record.detail.trim().split(/\r?\n/, 1)[0].slice(0, 300);
			}
			return message;
		}
		default:
			return null;
	}
}

/** The status and failure reason a node's own end maps to. */
export function fleetCommandRunEndFor(
	exitCode: number | null,
	reason: FleetCommandNodeEndReason | undefined
): { status: FleetCommandRunStatus; failedReason: FleetCommandFailedReason | null } {
	if (reason === 'timeout') return { status: 'timeout', failedReason: null };
	if (reason) return { status: 'failed', failedReason: reason };
	if (exitCode === 0) return { status: 'done', failedReason: null };
	return { status: 'failed', failedReason: null };
}
