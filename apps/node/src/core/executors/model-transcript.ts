import {
	FLEET_AGENT_TASK_TIMELINE_ARGS_MAX_CHARS,
	FLEET_AGENT_TASK_TIMELINE_MAX_BYTES,
	FLEET_AGENT_TASK_TIMELINE_MAX_STEPS,
	FLEET_AGENT_TASK_TIMELINE_NAME_MAX_CHARS,
	FLEET_AGENT_TASK_TIMELINE_TEXT_MAX_CHARS,
	FLEET_AGENT_TASK_TRANSCRIPT_MAX_BYTES,
	redactSecrets,
	type FleetAgentExecutionProvider,
	type FleetAgentTaskModelStep,
	type FleetAgentTaskModelStepStatus
} from '@ever-works/contracts';
import { scrubModelOutputText } from './model-cli';

/**
 * Run evidence of a fleet model step (self-build slice AP).
 *
 * ## The gap this closes
 *
 * What the owner could see of twenty minutes of autonomous work on his own
 * PC was one 8 KB output tail and a job row. The CLI's JSON stream — every
 * turn, every tool call — lived in the run's scratch directory and was
 * deleted with it. This module turns that stream into two BOUNDED, REDACTED
 * artefacts the node reports with the job result:
 *
 *   - **step records** (`timeline`) — one entry per assistant message and
 *     per tool call: the tool's name, a short argument summary (paths and
 *     commands, never a file body), how it ended and how long it took. The
 *     platform writes these into the run's ordinary `agent_run_logs`
 *     timeline, so the Sessions view shows a fleet run like a cloud one.
 *   - a **transcript** — the stream itself, one JSON document per line,
 *     with every tool OUTPUT, file body and reasoning block replaced by an
 *     `[elided N chars]` marker, capped at
 *     {@link FLEET_AGENT_TASK_TRANSCRIPT_MAX_BYTES} by keeping its head and
 *     its tail. It is the forensic record, and it lives on the job row only
 *     (so the fleet job retention purge removes it with the rest).
 *
 * ## Redaction — names never values, and the values scrubbed anyway
 *
 * Every string either artefact carries is scrubbed BEFORE it is capped (a
 * secret straddling the cap must not survive as a recognisable prefix), by
 * the same two controls the rest of the node's reporting uses:
 *
 *   1. the protected VALUES — those behind the granted env names and the
 *      run's delivered `.env` contents, computed by
 *      `collectModelOutputProtectedValues` exactly as the summary's are. A
 *      `.env` value lives in no environment, so a redactor keyed on names
 *      alone is blind to it (lesson 12) — the caller passes the values;
 *   2. the platform's shared secret-PATTERN scanner (`redactSecrets` from
 *      `@ever-works/contracts`), for a token the model found somewhere this
 *      node never granted.
 *
 * ## Bounded by construction
 *
 * The recorder consumes the stream INCREMENTALLY (it may be fed live, as the
 * CLI writes, or once after it exits) and holds only: the unfinished last
 * line (a line past {@link MODEL_TRANSCRIPT_MAX_LINE_BYTES} is skipped, never
 * buffered), at most {@link FLEET_AGENT_TASK_TIMELINE_MAX_STEPS} steps, and
 * the transcript's head and tail windows. A multi-gigabyte stream costs the
 * node a constant amount of memory.
 */

/** A single stream line past this is skipped rather than buffered. */
export const MODEL_TRANSCRIPT_MAX_LINE_BYTES = 1024 * 1024;

/** Bytes of the transcript's beginning kept verbatim (init + the first turns). */
const TRANSCRIPT_HEAD_BYTES = 16 * 1024;
/** Room reserved for the elision line between head and tail. */
const TRANSCRIPT_MARKER_RESERVE_BYTES = 256;
/** One transcript line is cut at this many characters after elision. */
const TRANSCRIPT_LINE_MAX_CHARS = 4096;
/** A message `text` / final `result` keeps this much in the transcript. */
const TRANSCRIPT_TEXT_KEEP_CHARS = 4096;
/** Any other string longer than this is elided from the transcript. */
const TRANSCRIPT_STRING_ELIDE_OVER_CHARS = 1024;
/** Inside a tool call's arguments, strings longer than this are elided. */
const TRANSCRIPT_ARG_ELIDE_OVER_CHARS = 200;
/** Deepest structure the transcript walk descends into. */
const TRANSCRIPT_MAX_DEPTH = 12;
/** Slack added to a step's measured size for the fields filled in later (status, duration). */
const STEP_SIZE_SLACK_BYTES = 48;
/** Bytes of an oversized line kept to read its `tool_use_id`. */
const OVERSIZED_LINE_SNIFF_BYTES = 8 * 1024;

/**
 * Keys whose string value is CONTENT, never kept in the transcript: file
 * bodies a write / edit tool was handed, a command's captured output, the
 * model's private reasoning.
 */
const TRANSCRIPT_ELIDED_KEYS = new Set([
	'content',
	'old_string',
	'new_string',
	'new_source',
	'file_text',
	'aggregated_output',
	'output',
	'stdout',
	'stderr',
	'thinking',
	'signature',
	'data'
]);

/**
 * Argument keys a step's summary may quote. Everything else is listed by
 * NAME only — `content`, `old_string`, `new_string` and every other key a
 * file body travels in can never reach a summary by construction.
 */
const SUMMARY_ARG_KEYS = [
	'file_path',
	'notebook_path',
	'path',
	'pattern',
	'glob',
	'command',
	'url',
	'query',
	'description',
	'subagent_type',
	'skill'
] as const;

export interface ModelTranscriptEvidence {
	timeline: FleetAgentTaskModelStep[];
	timelineDropped: number;
	transcript: string;
	transcriptSourceBytes: number;
}

export interface ModelTranscriptRecorderOptions {
	provider: FleetAgentExecutionProvider;
	/** Values to scrub, from `collectModelOutputProtectedValues`. */
	protectedValues: readonly string[];
	/**
	 * The run's worktree. Rewritten to `.` in summaries so a step reads
	 * `file_path=./src/a.ts` rather than the machine's absolute layout.
	 */
	workspacePath?: string;
}

export interface ModelTranscriptRecorder {
	/**
	 * Consume the next bytes of the CLI's output stream. `atMs` is when the
	 * caller SAW them, in ms after the model step started — null when the
	 * stream is read after the CLI exited.
	 */
	feed(chunk: Uint8Array | string, atMs: number | null): void;
	/** Flush the unfinished last line and return the evidence. */
	finish(atMs: number | null): ModelTranscriptEvidence;
}

interface PendingCall {
	step: FleetAgentTaskModelStep;
	atMs: number | null;
}

/** Build a recorder for one model run's output stream. */
export function createModelTranscriptRecorder(options: ModelTranscriptRecorderOptions): ModelTranscriptRecorder {
	const values = options.protectedValues;
	const workspace = typeof options.workspacePath === 'string' ? options.workspacePath.trim() : '';
	// The same path as it appears inside a JSON string (`C:\\Users\\…`).
	const workspaceJson = workspace ? JSON.stringify(workspace).slice(1, -1) : '';

	// ── line framing ─────────────────────────────────────────────────────
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let skippingOversizedLine = false;
	/** The first bytes of the oversized line being skipped, for `sniffOversizedLine`. */
	let oversizedHead: Buffer | null = null;
	let oversizedLineBytes = 0;
	let sourceBytes = 0;

	// ── step records ─────────────────────────────────────────────────────
	const steps: FleetAgentTaskModelStep[] = [];
	let stepBytes = 2;
	let dropped = 0;
	const calls = new Map<string, PendingCall>();

	// ── transcript windows ───────────────────────────────────────────────
	const head: string[] = [];
	let headBytes = 0;
	let headClosed = false;
	const tail: string[] = [];
	let tailBytes = 0;
	let elidedLines = 0;
	let elidedBytes = 0;
	let oversizedLines = 0;
	const tailBudget = FLEET_AGENT_TASK_TRANSCRIPT_MAX_BYTES - TRANSCRIPT_HEAD_BYTES - TRANSCRIPT_MARKER_RESERVE_BYTES;

	/**
	 * Scrub BEFORE capping, values first, then the pattern scanner. Applied
	 * to DECODED strings (the transcript walk cleans every string it keeps
	 * before re-serializing), because a value containing a quote or a
	 * backslash is escaped inside a JSON line and would never match there.
	 */
	const clean = (text: string): string => {
		let out = text;
		if (workspace) out = out.split(workspace).join('.');
		if (workspaceJson && workspaceJson !== workspace) out = out.split(workspaceJson).join('.');
		out = scrubModelOutputText(out, values);
		out = redactSecrets(out).cleaned;
		return out.replace(/\u0000/g, '');
	};

	const pushTranscriptLine = (line: string): void => {
		const bytes = Buffer.byteLength(line, 'utf8') + 1;
		if (!headClosed && headBytes + bytes <= TRANSCRIPT_HEAD_BYTES) {
			head.push(line);
			headBytes += bytes;
			return;
		}
		headClosed = true;
		tail.push(line);
		tailBytes += bytes;
		while (tailBytes > tailBudget && tail.length > 0) {
			const evicted = tail.shift()!;
			const evictedBytes = Buffer.byteLength(evicted, 'utf8') + 1;
			tailBytes -= evictedBytes;
			elidedLines += 1;
			elidedBytes += evictedBytes;
		}
	};

	const addStep = (step: FleetAgentTaskModelStep): boolean => {
		const size = Buffer.byteLength(JSON.stringify(step), 'utf8') + STEP_SIZE_SLACK_BYTES;
		if (
			steps.length >= FLEET_AGENT_TASK_TIMELINE_MAX_STEPS ||
			stepBytes + size > FLEET_AGENT_TASK_TIMELINE_MAX_BYTES
		) {
			dropped += 1;
			return false;
		}
		steps.push(step);
		stepBytes += size;
		return true;
	};

	const addMessage = (text: unknown, atMs: number | null): void => {
		if (typeof text !== 'string' || !text.trim()) return;
		const capped = capText(clean(text).trim(), FLEET_AGENT_TASK_TIMELINE_TEXT_MAX_CHARS);
		if (!capped.value) return;
		addStep({
			kind: 'assistant-message',
			atMs,
			text: capped.value,
			...(capped.cut ? { truncated: true } : {})
		});
	};

	const openCall = (callId: string | null, toolName: string, argsSummary: string, atMs: number | null): void => {
		const name = capText(clean(toolName).trim(), FLEET_AGENT_TASK_TIMELINE_NAME_MAX_CHARS).value || 'unknown';
		const summary = capText(clean(argsSummary).trim(), FLEET_AGENT_TASK_TIMELINE_ARGS_MAX_CHARS);
		const id = callId ? capText(callId, FLEET_AGENT_TASK_TIMELINE_NAME_MAX_CHARS).value : '';
		const step: FleetAgentTaskModelStep = {
			kind: 'tool-call',
			atMs,
			toolName: name,
			...(id ? { callId: id } : {}),
			...(summary.value ? { argsSummary: summary.value } : {}),
			status: 'unknown',
			durationMs: null,
			...(summary.cut ? { truncated: true } : {})
		};
		if (!addStep(step)) return;
		if (id && !calls.has(id)) calls.set(id, { step, atMs });
	};

	const closeCall = (callId: string | null, status: FleetAgentTaskModelStepStatus, atMs: number | null): boolean => {
		if (!callId) return false;
		const id = capText(callId, FLEET_AGENT_TASK_TIMELINE_NAME_MAX_CHARS).value;
		const open = calls.get(id);
		if (!open) return false;
		calls.delete(id);
		open.step.status = status;
		open.step.durationMs = open.atMs !== null && atMs !== null ? Math.max(0, atMs - open.atMs) : null;
		return true;
	};

	const onClaudeEvent = (event: Record<string, unknown>, atMs: number | null): void => {
		const message = asRecord(event.message);
		const blocks = message && Array.isArray(message.content) ? message.content : [];
		if (event.type === 'assistant') {
			for (const raw of blocks) {
				const block = asRecord(raw);
				if (!block) continue;
				if (block.type === 'text') addMessage(block.text, atMs);
				else if (block.type === 'tool_use' && typeof block.name === 'string') {
					openCall(stringOrNull(block.id), block.name, summarizeArgs(block.input), atMs);
				}
			}
		} else if (event.type === 'user') {
			for (const raw of blocks) {
				const block = asRecord(raw);
				if (!block || block.type !== 'tool_result') continue;
				closeCall(stringOrNull(block.tool_use_id), block.is_error === true ? 'error' : 'ok', atMs);
			}
		}
	};

	const onCodexEvent = (event: Record<string, unknown>, atMs: number | null): void => {
		const item = asRecord(event.item);
		if (!item) return;
		const id = stringOrNull(item.id);
		const tool = codexTool(item);
		if (event.type === 'item.started') {
			if (tool) openCall(id, tool.name, tool.summary, atMs);
			return;
		}
		if (event.type !== 'item.completed') return;
		if (item.type === 'agent_message') {
			addMessage(item.text, atMs);
			return;
		}
		if (!tool) return;
		const status = codexStatus(item);
		// A completed item the stream never announced (older CLIs emit
		// `item.completed` only) is recorded with no observable duration.
		if (!closeCall(id, status, atMs)) {
			openCall(id, tool.name, tool.summary, atMs);
			closeCall(id, status, null);
		}
	};

	const onLine = (raw: string, atMs: number | null): void => {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			// Not JSON — a warning the CLI printed on stdout. Kept, short.
			pushTranscriptLine(capText(clean(line), 500).value);
			return;
		}
		const record = asRecord(event);
		if (!record) {
			pushTranscriptLine(capText(clean(line), 500).value);
			return;
		}
		try {
			if (options.provider === 'claude-code') onClaudeEvent(record, atMs);
			else if (options.provider === 'codex') onCodexEvent(record, atMs);
		} catch {
			// A shape this parser does not know must cost a step record,
			// never the run.
		}
		const elided = JSON.stringify(elideForTranscript(record, '', 0, false, clean));
		// The walk already cleaned every kept string; this second pass is
		// the pattern scanner over the line as a whole (a token split
		// across two keys, a key that is itself a secret).
		pushTranscriptLine(capText(clean(elided), TRANSCRIPT_LINE_MAX_CHARS).value);
	};

	/**
	 * A line too long to buffer still says WHICH call it answers: a Claude
	 * `tool_result` carries its `tool_use_id` ahead of the body. Read it off
	 * the line's head so the call is closed (status `unknown`: whether it
	 * errored is written after the body), and leave a marker in the
	 * transcript where the line was.
	 */
	const sniffOversizedLine = (headBytes: Buffer | null, bytes: number, atMs: number | null): void => {
		const text = headBytes ? headBytes.toString('utf8') : '';
		const id = /"tool_use_id"\s*:\s*"([^"\\]{1,200})"/.exec(text)?.[1] ?? null;
		if (options.provider === 'claude-code' && id) closeCall(id, 'unknown', atMs);
		pushTranscriptLine(JSON.stringify({ type: 'ever-works.oversized-line', bytes }));
	};

	const takeLine = (bytes: Buffer, atMs: number | null): void => {
		onLine(bytes.toString('utf8'), atMs);
	};

	return {
		feed(chunk, atMs) {
			const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
			sourceBytes += buffer.length;
			let start = 0;
			while (start < buffer.length) {
				const newline = buffer.indexOf(0x0a, start);
				const end = newline === -1 ? buffer.length : newline;
				const piece = buffer.subarray(start, end);
				if (skippingOversizedLine) {
					oversizedLineBytes += piece.length;
					if (newline !== -1) {
						skippingOversizedLine = false;
						sniffOversizedLine(oversizedHead, oversizedLineBytes, atMs);
						oversizedHead = null;
					}
				} else if (pendingBytes + piece.length > MODEL_TRANSCRIPT_MAX_LINE_BYTES) {
					// Never buffered: a line this long is a dumped file or a
					// runaway tool result, and holding it is the memory blow-up
					// the recorder exists to avoid. Only its first bytes are
					// kept, to learn which call it answers.
					const first = pending.length > 0 ? pending[0] : piece;
					const head = Buffer.from(first.subarray(0, OVERSIZED_LINE_SNIFF_BYTES));
					const total = pendingBytes + piece.length;
					pending = [];
					pendingBytes = 0;
					oversizedLines += 1;
					if (newline === -1) {
						skippingOversizedLine = true;
						oversizedHead = head;
						oversizedLineBytes = total;
					} else {
						sniffOversizedLine(head, total, atMs);
					}
				} else if (newline === -1) {
					pending.push(Buffer.from(piece));
					pendingBytes += piece.length;
				} else {
					const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
					pending = [];
					pendingBytes = 0;
					takeLine(line, atMs);
				}
				start = newline === -1 ? buffer.length : newline + 1;
			}
		},
		finish(atMs) {
			if (skippingOversizedLine) {
				sniffOversizedLine(oversizedHead, oversizedLineBytes, atMs);
				skippingOversizedLine = false;
				oversizedHead = null;
			} else if (pendingBytes > 0) {
				takeLine(Buffer.concat(pending), atMs);
			}
			pending = [];
			pendingBytes = 0;
			const lines = [...head];
			if (elidedLines > 0 || oversizedLines > 0) {
				lines.push(
					JSON.stringify({
						type: 'ever-works.transcript-elided',
						lines: elidedLines,
						bytes: elidedBytes,
						...(oversizedLines > 0 ? { oversizedLines } : {})
					})
				);
			}
			lines.push(...tail);
			return {
				timeline: steps.map((step) => ({ ...step })),
				timelineDropped: dropped,
				transcript: lines.join('\n'),
				transcriptSourceBytes: sourceBytes
			};
		}
	};
}

/**
 * A short summary of a tool call's arguments: the quotable keys as
 * `key=value`, every other key by NAME only. Never a value of a key outside
 * {@link SUMMARY_ARG_KEYS}, so a file body cannot reach a summary however
 * the tool names its parameters.
 */
export function summarizeArgs(input: unknown): string {
	const record = asRecord(input);
	if (!record) return '';
	const parts: string[] = [];
	for (const key of SUMMARY_ARG_KEYS) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) parts.push(`${key}=${oneLine(value, 120)}`);
		else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${String(value)}`);
	}
	const quoted = new Set<string>(SUMMARY_ARG_KEYS);
	const others = Object.keys(record).filter((key) => !quoted.has(key));
	if (others.length > 0) parts.push(`+${others.slice(0, 8).join(',')}${others.length > 8 ? ',…' : ''}`);
	return parts.join(' ');
}

/** A codex event item that is a tool call, as a name and an argument summary. */
function codexTool(item: Record<string, unknown>): { name: string; summary: string } | null {
	switch (item.type) {
		case 'command_execution':
			return {
				name: 'shell',
				summary: typeof item.command === 'string' ? `command=${oneLine(item.command, 160)}` : ''
			};
		case 'file_change': {
			const changes = Array.isArray(item.changes) ? item.changes : [];
			const described = changes
				.map((raw) => {
					const change = asRecord(raw);
					if (!change || typeof change.path !== 'string') return null;
					return `${typeof change.kind === 'string' ? change.kind : 'change'} ${change.path}`;
				})
				.filter((entry): entry is string => entry !== null);
			return { name: 'file_change', summary: described.length > 0 ? `changes=${described.join(', ')}` : '' };
		}
		case 'mcp_tool_call': {
			const server = typeof item.server === 'string' ? item.server : 'mcp';
			const tool = typeof item.tool === 'string' ? item.tool : 'tool';
			return { name: `mcp__${server}__${tool}`, summary: summarizeArgs(item.arguments) };
		}
		case 'web_search':
			return {
				name: 'web_search',
				summary: typeof item.query === 'string' ? `query=${oneLine(item.query, 160)}` : ''
			};
		default:
			return null;
	}
}

function codexStatus(item: Record<string, unknown>): FleetAgentTaskModelStepStatus {
	if (item.status === 'failed' || item.status === 'declined') return 'error';
	if (item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0) return 'error';
	return 'ok';
}

/**
 * The transcript form of one stream event: structure kept, CONTENT elided.
 *
 *   - a `tool_result` block's body and a top-level `tool_use_result` are
 *     always elided — they are a tool's OUTPUT, i.e. file contents and
 *     command output;
 *   - keys in {@link TRANSCRIPT_ELIDED_KEYS} are elided when they hold a
 *     string (an ARRAY under `content` is a message's block list and is
 *     walked instead);
 *   - a codex `reasoning` item's text is elided;
 *   - a message `text` / the final `result` keeps its first
 *     {@link TRANSCRIPT_TEXT_KEEP_CHARS} characters;
 *   - any other string longer than {@link TRANSCRIPT_STRING_ELIDE_OVER_CHARS}
 *     (inside a tool's arguments: {@link TRANSCRIPT_ARG_ELIDE_OVER_CHARS}) is
 *     elided.
 */
function elideForTranscript(
	value: unknown,
	key: string,
	depth: number,
	inToolInput: boolean,
	clean: (text: string) => string
): unknown {
	if (typeof value === 'string') {
		if (TRANSCRIPT_ELIDED_KEYS.has(key)) return elisionMarker(value);
		if (key === 'text' || key === 'result') return capText(clean(value), TRANSCRIPT_TEXT_KEEP_CHARS).value;
		const limit = inToolInput ? TRANSCRIPT_ARG_ELIDE_OVER_CHARS : TRANSCRIPT_STRING_ELIDE_OVER_CHARS;
		return value.length > limit ? elisionMarker(value) : clean(value);
	}
	if (value === null || typeof value !== 'object') return value;
	if (depth >= TRANSCRIPT_MAX_DEPTH) return '[elided: nested too deep]';
	if (Array.isArray(value)) {
		return value.map((entry) => elideForTranscript(entry, key, depth + 1, inToolInput, clean));
	}
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [childKey, child] of Object.entries(record)) {
		if (childKey === 'tool_use_result') {
			out[childKey] = '[elided tool output]';
		} else if (record.type === 'tool_result' && childKey === 'content') {
			out[childKey] = elisionMarker(typeof child === 'string' ? child : (JSON.stringify(child) ?? ''));
		} else if (record.type === 'reasoning' && childKey === 'text') {
			out[childKey] = elisionMarker(typeof child === 'string' ? child : '');
		} else {
			out[childKey] = elideForTranscript(
				child,
				childKey,
				depth + 1,
				inToolInput || (childKey === 'input' && record.type === 'tool_use') || childKey === 'arguments',
				clean
			);
		}
	}
	return out;
}

function elisionMarker(value: string): string {
	return `[elided ${value.length} chars]`;
}

function capText(value: string, maxChars: number): { value: string; cut: boolean } {
	const points = Array.from(value);
	if (points.length <= maxChars) return { value, cut: false };
	return {
		value: `${points
			.slice(0, maxChars - 1)
			.join('')
			.trimEnd()}…`,
		cut: true
	};
}

function oneLine(value: string, maxChars: number): string {
	return capText(value.replace(/\s+/g, ' ').trim(), maxChars).value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

// ─── Live observation of the output file ─────────────────────────────

/** How often the node reads the model's output file while the CLI runs. */
export const MODEL_TRANSCRIPT_DEFAULT_POLL_MS = 1000;
/** Bytes read per read call while observing. */
const OBSERVE_CHUNK_BYTES = 256 * 1024;
/** Bytes one poll tick may read before yielding to the next tick. */
const OBSERVE_TICK_BUDGET_BYTES = 4 * 1024 * 1024;

/** Read up to `maxBytes` of a file from byte `start`; null when it does not exist. */
export type ModelOutputChunkReader = (
	path: string,
	start: number,
	maxBytes: number
) => Promise<{ bytes: Uint8Array; size: number } | null>;

export interface ModelOutputObserver {
	/**
	 * Stop polling, read whatever the CLI wrote since the last poll, and say
	 * whether the WHOLE stream reached the recorder. `false` means a read
	 * failed part-way: the recorder's view is incomplete and the caller
	 * should rebuild the evidence from the file instead.
	 */
	stop(): Promise<{ complete: boolean }>;
}

/**
 * Feed the model's output file to `recorder` AS THE CLI WRITES IT, stamping
 * each line with when it was seen. That arrival time is the only clock a
 * tool call's duration can be read from — neither CLI timestamps its events
 * — so it is accurate to the poll interval, which the step record says.
 *
 * Polls rather than watches: `fs.watch` is unreliable for a file another
 * process is appending to on Windows, and a one-second read of the bytes
 * appended since the last one is cheap and bounded
 * ({@link OBSERVE_TICK_BUDGET_BYTES} per tick).
 */
export function observeModelOutput(input: {
	path: string;
	readChunk: ModelOutputChunkReader;
	recorder: ModelTranscriptRecorder;
	startedAt: number;
	now?: () => number;
	pollMs?: number;
}): ModelOutputObserver {
	const now = input.now ?? (() => Date.now());
	const pollMs = Math.max(10, input.pollMs ?? MODEL_TRANSCRIPT_DEFAULT_POLL_MS);
	let offset = 0;
	let failed = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: Promise<void> | null = null;

	const drain = async (budget: number): Promise<void> => {
		let readThisPass = 0;
		while (!failed && readThisPass < budget) {
			let chunk: { bytes: Uint8Array; size: number } | null;
			try {
				chunk = await input.readChunk(input.path, offset, OBSERVE_CHUNK_BYTES);
			} catch {
				failed = true;
				return;
			}
			if (!chunk || chunk.bytes.length === 0) return;
			offset += chunk.bytes.length;
			readThisPass += chunk.bytes.length;
			input.recorder.feed(chunk.bytes, Math.max(0, now() - input.startedAt));
			if (chunk.bytes.length < OBSERVE_CHUNK_BYTES) return;
		}
	};

	const schedule = (): void => {
		if (stopped || failed) return;
		timer = setTimeout(() => {
			timer = null;
			inFlight = drain(OBSERVE_TICK_BUDGET_BYTES).finally(() => {
				inFlight = null;
				schedule();
			});
		}, pollMs);
		(timer as { unref?: () => void }).unref?.();
	};
	schedule();

	return {
		async stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
			if (inFlight) await inFlight;
			await drain(Number.POSITIVE_INFINITY);
			return { complete: !failed };
		}
	};
}
