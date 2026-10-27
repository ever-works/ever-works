import { randomBytes } from 'crypto';
import {
	capFleetLogText,
	clampFleetLogsLines,
	FLEET_LINK_FRAME_KINDS,
	FLEET_LOGS_FOLLOW_BYTES_PER_SEC,
	FLEET_LOGS_MAX_FRAME_BYTES,
	FLEET_LOGS_MESSAGES,
	FLEET_LOGS_PENDING_MAX_BYTES,
	makeFleetLinkError,
	parseFleetLogsOpenParams,
	redactSecrets,
	type FleetLinkError,
	type FleetLogLine,
	type FleetLogsNoticeKind
} from '@ever-works/contracts';
import type { NodeChannelContext, NodeChannelHandler, NodeChannelOpenResult } from '../registry';
import { LogReadError, type LogTimers, type RawLogLine } from './log-io';
import type { LogFollowHandle, LogReader } from './log-reader';

/**
 * Logs on computers (FL-08) — one open `logs` channel (plan §6, T-07).
 *
 * The channel opens with `{ source, sources?, lines }` (CONTRACTS §3.3); the
 * readers are built and validated before it is accepted, so a refusal
 * (`invalid`, `not_found`, `unsupported_on_node`, `kill_switch`) is a
 * `channel.refused`. Nothing streams until the reader asks:
 *
 *  - `logs.read { lines }` — the last `lines` lines, then `logs.initial-done`;
 *  - `logs.follow { on: true, lines }` — the same batch, `logs.initial-done
 *    { following: true }`, then live lines; `{ on: false }` stops the readers
 *    and keeps the channel;
 *  - `logs.pause` / `logs.resume` — hold live lines here (≤
 *    {@link FLEET_LOGS_PENDING_MAX_BYTES}, the oldest dropped and counted),
 *    then send them;
 *  - `logs.earlier { lines, src? }` (P2) — an older page of lines marked
 *    `earlier: true`, then `logs.earlier-done { count, hasMore }`.
 *
 * Every line passes the platform's secret scan (`redactSecrets`) HERE,
 * before it is framed — the raw line never leaves the machine (FR-22). Lines
 * go out as NDJSON in `DATA` frames of at most {@link FLEET_LOGS_MAX_FRAME_BYTES},
 * against the link's `ACK` credit, at no more than
 * {@link FLEET_LOGS_FOLLOW_BYTES_PER_SEC} (a token bucket). Live lines that
 * cannot go (no credit, paused, the link down) wait up to
 * {@link FLEET_LOGS_PENDING_MAX_BYTES}; beyond it the OLDEST are dropped and a
 * `logs.notice { kind: 'dropped', count }` precedes the next live frame
 * (U9). The batch is never dropped.
 *
 * Several sources (a merged view, P2) are tailed together: the batch is
 * merged by time and cut to `lines`; each line carries its source's index.
 *
 * The kill switch (`link.pause`) stops every follow within the poll that
 * delivers it: a `kill-switch` notice, then the channel closes `kill_switch`
 * (R-24). A channel close kills every reader's child within 3 s. The channel
 * survives a link drop (`resumeKey`): readers keep reading into the bounded
 * queue and the queue drains when the link is back (U8).
 */

export interface LogChannelDeps {
	timers: LogTimers;
	/** Build (and validate) the readers for these ids, in order. Throws `LogReadError` to refuse. */
	openReaders(sources: readonly string[]): Promise<LogReader[]>;
}

type QueueItem =
	| { kind: 'data'; text: string; bytes: number; live: boolean }
	| { kind: 'json'; message: Record<string, unknown> };

const utf8 = new TextEncoder();

function refused(error: FleetLinkError): NodeChannelOpenResult {
	return { ok: false, error };
}

function asLinkError(error: unknown, fallback: string): FleetLinkError {
	if (error instanceof LogReadError) return makeFleetLinkError(error.code, error.hint);
	return makeFleetLinkError('operation_failed', fallback);
}

/** One line as it leaves the machine: scanned, cut, framed (bounded under one frame). */
export function encodeLogLine(
	line: RawLogLine,
	src: number,
	earlier = false
): { text: string; bytes: number; redactions: number } {
	const scan = redactSecrets(line.text);
	const wire: FleetLogLine = {
		ts: line.ts,
		level: line.level,
		text: capFleetLogText(scan.cleaned),
		src,
		redactions: scan.redactions
	};
	if (earlier) wire.earlier = true;
	let text = `${JSON.stringify(wire)}\n`;
	let bytes = Buffer.byteLength(text, 'utf8');
	if (bytes > FLEET_LOGS_MAX_FRAME_BYTES - 64) {
		// Escapes can grow a line past one frame: cut harder.
		wire.text = `${scan.cleaned.slice(0, 4096)}…`;
		text = `${JSON.stringify(wire)}\n`;
		bytes = Buffer.byteLength(text, 'utf8');
	}
	return { text, bytes, redactions: scan.redactions };
}

export class LogChannel {
	readonly handler: NodeChannelHandler;
	private readonly queue: QueueItem[] = [];
	private liveBytes = 0;
	private droppedUnreported = 0;
	private tokens = FLEET_LOGS_FOLLOW_BYTES_PER_SEC;
	private lastRefill: number;
	private retryTimer: unknown = null;
	private flushTimer: unknown = null;
	private flushing = false;
	private paused = false;
	private batchStarted = false;
	private closed = false;
	private readonly follows: Array<LogFollowHandle | null>;
	private readonly okSources = new Set<number>();
	private readonly unsubscribeControl: () => void;
	/** Totals since the channel opened (the node's own counters; the platform audits from `logs.initial-done`). */
	bytesSent = 0;
	linesSent = 0;
	redactions = 0;

	constructor(
		private readonly context: NodeChannelContext,
		private readonly readers: readonly LogReader[],
		private readonly defaultLines: number,
		private readonly deps: LogChannelDeps
	) {
		this.lastRefill = deps.timers.now();
		this.follows = readers.map(() => null);
		this.handler = {
			onJson: (message) => this.onJson(message),
			onDrain: () => this.flush(),
			onResume: () => this.flush(),
			onClose: () => this.dispose(),
			resumeKey: `logs-${randomBytes(9).toString('base64url')}`
		};
		this.unsubscribeControl = context.control.onChange((state) => {
			if (state.paused) this.stopForKillSwitch();
		});
	}

	// ─── Inbound ───────────────────────────────────────────────────────────

	private onJson(message: Record<string, unknown>): void {
		if (this.closed) return;
		switch (message.type) {
			case FLEET_LOGS_MESSAGES.read:
				void this.batch(clampFleetLogsLines(message.lines ?? this.defaultLines), false);
				return;
			case FLEET_LOGS_MESSAGES.follow:
				if (message.on === false) {
					this.stopFollowing();
					return;
				}
				if (!this.batchStarted) void this.batch(clampFleetLogsLines(message.lines ?? this.defaultLines), true);
				else this.startFollowing();
				return;
			case FLEET_LOGS_MESSAGES.pause:
				this.paused = true;
				return;
			case FLEET_LOGS_MESSAGES.resume:
				this.paused = false;
				this.flush();
				return;
			case FLEET_LOGS_MESSAGES.earlier:
				void this.earlier(
					clampFleetLogsLines(message.lines ?? this.defaultLines),
					typeof message.src === 'number' && Number.isInteger(message.src) ? message.src : 0
				);
				return;
			default:
				return; // a type this node does not know: ignored, never an error
		}
	}

	// ─── The batch ─────────────────────────────────────────────────────────

	private async batch(lines: number, follow: boolean): Promise<void> {
		this.batchStarted = true;
		const results = await Promise.all(
			this.readers.map(async (reader, src) => {
				try {
					return { src, batch: await reader.tail(lines), error: null };
				} catch (error) {
					return { src, batch: null, error: asLinkError(error, 'the log could not be read') };
				}
			})
		);
		if (this.closed) return;
		const merged: Array<{ src: number; line: RawLogLine; order: number }> = [];
		let scanLimited = false;
		let firstError: FleetLinkError | null = null;
		for (const result of results) {
			if (!result.batch) {
				firstError ??= result.error;
				if (this.readers.length > 1 && result.error) {
					this.enqueueJson({
						type: FLEET_LOGS_MESSAGES.notice,
						kind: 'error',
						hint: result.error.hint,
						src: result.src
					});
				}
				continue;
			}
			this.okSources.add(result.src);
			if (result.batch.notice) {
				this.enqueueJson({
					type: FLEET_LOGS_MESSAGES.notice,
					kind: result.batch.notice.kind,
					...(result.batch.notice.hint ? { hint: result.batch.notice.hint } : {}),
					src: result.src
				});
			}
			scanLimited ||= result.batch.scanLimited === true;
			for (const line of result.batch.lines) merged.push({ src: result.src, line, order: merged.length });
		}
		if (this.readers.length > 1) {
			// By time; a line without a stamp keeps its place among its source's lines.
			merged.sort((a, b) => {
				if (a.line.ts && b.line.ts && a.line.ts !== b.line.ts) return a.line.ts < b.line.ts ? -1 : 1;
				return a.order - b.order;
			});
		}
		const kept = merged.slice(-lines);
		let count = 0;
		let redactions = 0;
		let bytes = 0;
		for (const { src, line } of kept) {
			const encoded = encodeLogLine(line, src);
			this.queue.push({ kind: 'data', text: encoded.text, bytes: encoded.bytes, live: false });
			count += 1;
			redactions += encoded.redactions;
			bytes += encoded.bytes;
		}
		this.redactions += redactions;
		const allFailed = this.okSources.size === 0;
		const following = follow && !allFailed;
		this.enqueueJson({
			type: FLEET_LOGS_MESSAGES.initialDone,
			count,
			redactions,
			bytes,
			scanLimited,
			following,
			...(allFailed && firstError ? { error: { code: firstError.code, hint: firstError.hint } } : {})
		});
		if (following) this.startFollowing();
		this.flush();
	}

	private async earlier(lines: number, src: number): Promise<void> {
		const reader = this.readers[src];
		if (!reader || !reader.supportsEarlier || !reader.earlier) {
			this.enqueueJson({
				type: FLEET_LOGS_MESSAGES.earlierDone,
				count: 0,
				hasMore: false,
				src,
				unsupported: true
			});
			this.flush();
			return;
		}
		let page: { lines: RawLogLine[]; hasMore: boolean };
		try {
			page = await reader.earlier(lines);
		} catch (error) {
			this.enqueueJson({
				type: FLEET_LOGS_MESSAGES.notice,
				kind: 'error',
				hint: asLinkError(error, 'older lines could not be read').hint,
				src
			});
			this.enqueueJson({ type: FLEET_LOGS_MESSAGES.earlierDone, count: 0, hasMore: false, src });
			this.flush();
			return;
		}
		if (this.closed) return;
		let redactions = 0;
		// Ahead of any live line still waiting: the page answers the request now.
		const items: QueueItem[] = page.lines.map((line) => {
			const encoded = encodeLogLine(line, src, true);
			redactions += encoded.redactions;
			return { kind: 'data', text: encoded.text, bytes: encoded.bytes, live: false };
		});
		items.push({
			kind: 'json',
			message: { type: FLEET_LOGS_MESSAGES.earlierDone, count: page.lines.length, hasMore: page.hasMore, src }
		});
		this.queue.unshift(...items);
		this.redactions += redactions;
		this.flush();
	}

	// ─── Following ─────────────────────────────────────────────────────────

	private startFollowing(): void {
		if (this.closed) return;
		this.readers.forEach((reader, src) => {
			if (this.follows[src] || !this.okSources.has(src)) return;
			this.follows[src] = reader.follow({
				line: (line) => this.enqueueLive(line, src),
				notice: (kind, hint) => this.notice(kind, hint, src),
				ended: () => {
					this.follows[src] = null;
					this.okSources.delete(src);
				}
			});
		});
	}

	private stopFollowing(): void {
		this.follows.forEach((handle, src) => {
			handle?.stop();
			this.follows[src] = null;
		});
	}

	private notice(kind: FleetLogsNoticeKind, hint: string | undefined, src: number): void {
		this.enqueueJson({ type: FLEET_LOGS_MESSAGES.notice, kind, ...(hint ? { hint } : {}), src });
		this.scheduleFlush();
	}

	private enqueueLive(line: RawLogLine, src: number): void {
		if (this.closed) return;
		const encoded = encodeLogLine(line, src);
		this.queue.push({ kind: 'data', text: encoded.text, bytes: encoded.bytes, live: true });
		this.liveBytes += encoded.bytes;
		this.redactions += encoded.redactions;
		while (this.liveBytes > FLEET_LOGS_PENDING_MAX_BYTES && this.dropOldestLive()) {
			// keep dropping until the held bytes fit again
		}
		this.scheduleFlush();
	}

	private dropOldestLive(): boolean {
		const index = this.queue.findIndex((item) => item.kind === 'data' && item.live);
		if (index < 0) return false;
		const [dropped] = this.queue.splice(index, 1);
		if (dropped && dropped.kind === 'data') this.liveBytes -= dropped.bytes;
		this.droppedUnreported += 1;
		return true;
	}

	private enqueueJson(message: Record<string, unknown>): void {
		this.queue.push({ kind: 'json', message });
	}

	// ─── Sending ───────────────────────────────────────────────────────────

	/** Coalesce bursts of live lines into one flush per tick. */
	private scheduleFlush(): void {
		if (this.flushTimer !== null || this.closed) return;
		this.flushTimer = this.deps.timers.setTimer(() => {
			this.flushTimer = null;
			this.flush();
		}, 0);
	}

	private refill(): void {
		const now = this.deps.timers.now();
		const elapsed = Math.max(0, now - this.lastRefill);
		this.lastRefill = now;
		this.tokens = Math.min(
			FLEET_LOGS_FOLLOW_BYTES_PER_SEC,
			this.tokens + (elapsed * FLEET_LOGS_FOLLOW_BYTES_PER_SEC) / 1000
		);
	}

	private retryIn(ms: number): void {
		if (this.retryTimer !== null || this.closed) return;
		this.retryTimer = this.deps.timers.setTimer(
			() => {
				this.retryTimer = null;
				this.flush();
			},
			Math.max(1, ms)
		);
	}

	private reportDropped(): boolean {
		if (this.droppedUnreported === 0) return true;
		const sent = this.context.sendJson({
			type: FLEET_LOGS_MESSAGES.notice,
			kind: 'dropped',
			count: this.droppedUnreported
		});
		if (sent) this.droppedUnreported = 0;
		return sent;
	}

	/** Send what may go now; stops at the first thing that must wait (credit, pace, pause, link). */
	flush(): void {
		if (this.closed || this.flushing) return;
		this.flushing = true;
		try {
			while (this.queue.length > 0) {
				const head = this.queue[0]!;
				if (head.kind === 'json') {
					if (!this.context.sendJson(head.message)) return; // the link is down: resume flushes again
					this.queue.shift();
					continue;
				}
				if (head.live && this.paused) return;
				if (head.live && !this.reportDropped()) return;
				let size = 0;
				let count = 0;
				let live = 0;
				while (count < this.queue.length) {
					const item = this.queue[count]!;
					if (item.kind !== 'data' || (item.live && this.paused)) break;
					if (count > 0 && size + item.bytes > FLEET_LOGS_MAX_FRAME_BYTES) break;
					size += item.bytes;
					if (item.live) live += item.bytes;
					count += 1;
				}
				this.refill();
				if (this.tokens < size) {
					this.retryIn(Math.ceil(((size - this.tokens) * 1000) / FLEET_LOGS_FOLLOW_BYTES_PER_SEC));
					return;
				}
				const items = this.queue.slice(0, count) as Array<Extract<QueueItem, { kind: 'data' }>>;
				const payload = utf8.encode(items.map((item) => item.text).join(''));
				if (!this.context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, payload)) return; // credit: `onDrain` flushes again
				this.tokens -= size;
				this.queue.splice(0, count);
				this.liveBytes -= live;
				this.bytesSent += size;
				this.linesSent += count;
			}
			if (!this.paused) this.reportDropped();
		} finally {
			this.flushing = false;
		}
	}

	// ─── Ending ────────────────────────────────────────────────────────────

	private stopForKillSwitch(): void {
		if (this.closed) return;
		this.stopFollowing();
		this.context.sendJson({
			type: FLEET_LOGS_MESSAGES.notice,
			kind: 'kill-switch',
			hint: 'Following stopped — all computers are stopped'
		});
		this.context.close('kill_switch', 'all computers are stopped');
		this.dispose();
	}

	private dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopFollowing();
		if (this.retryTimer !== null) this.deps.timers.clearTimer(this.retryTimer);
		if (this.flushTimer !== null) this.deps.timers.clearTimer(this.flushTimer);
		this.retryTimer = null;
		this.flushTimer = null;
		this.queue.length = 0;
		this.unsubscribeControl();
	}
}

/**
 * The `logs` family's `open` (FL-02 registry contract): parse, refuse under
 * the kill switch, build the readers (each validates its source on THIS
 * machine), then accept.
 */
export async function openLogChannel(
	context: NodeChannelContext,
	deps: LogChannelDeps
): Promise<NodeChannelOpenResult> {
	const params = parseFleetLogsOpenParams(context.params);
	if (!params) return refused(makeFleetLinkError('invalid', 'source', { field: 'source' }));
	if (context.control.paused) {
		return refused(
			makeFleetLinkError('kill_switch', 'all computers are stopped — clear it under Settings → Fleet')
		);
	}
	let readers: LogReader[];
	try {
		readers = await deps.openReaders(params.sources);
	} catch (error) {
		return refused(asLinkError(error, 'the log could not be opened'));
	}
	if (readers.length === 0) return refused(makeFleetLinkError('not_found', 'no such log on this computer'));
	const channel = new LogChannel(context, readers, params.lines, deps);
	return { ok: true, handler: channel.handler };
}
