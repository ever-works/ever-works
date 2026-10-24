import { describe, expect, it, vi } from 'vitest';
import {
	FLEET_LOGS_FOLLOW_BYTES_PER_SEC,
	FLEET_LOGS_MAX_FRAME_BYTES,
	FLEET_LOGS_PENDING_MAX_BYTES,
	parseFleetLogLines,
	type FleetConsents
} from '@ever-works/contracts';
import type { NodeChannelContext, NodeLinkControlState } from '../registry';
import { encodeLogLine, LogChannel, openLogChannel } from './log-channel';
import { LogReadError, type LogTimers, type RawLogLine } from './log-io';
import type { LogFollowSink, LogReader } from './log-reader';

/**
 * Logs on computers (FL-08, T-07) — one `logs` channel: the batch on request,
 * the scan before framing, the 1 MiB/s bucket, the 1 MiB hold with oldest-drop
 * counting, pause / resume, the kill switch and the open refusals.
 */

const MANAGE: FleetConsents = { work: false, attend: false, manage: true, usageScan: false };
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';

function clock(): LogTimers & { advance(ms: number): void; pending(): number } {
	let now = 1_000_000;
	let timers: Array<{ at: number; callback: () => void; id: number }> = [];
	let next = 1;
	return {
		now: () => now,
		setTimer: (callback, ms) => {
			const id = next++;
			timers.push({ at: now + ms, callback, id });
			return id;
		},
		clearTimer: (handle) => {
			timers = timers.filter((timer) => timer.id !== handle);
		},
		advance(ms) {
			const until = now + ms;
			for (;;) {
				const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				timers = timers.filter((timer) => timer !== due);
				now = Math.max(now, due.at);
				due.callback();
			}
			now = until;
		},
		pending: () => timers.length
	};
}

function harness(params: Record<string, unknown> = { source: 'system:journal' }) {
	const json: Array<Record<string, unknown>> = [];
	const frames: string[] = [];
	const state = { credit: true, link: true };
	const listeners = new Set<(s: { paused: boolean; drain: null }) => void>();
	const control: NodeLinkControlState & { pause(): void } = {
		paused: false,
		drain: null,
		onChange: (listener) => {
			listeners.add(listener as never);
			return () => listeners.delete(listener as never);
		},
		pause() {
			(this as { paused: boolean }).paused = true;
			for (const listener of listeners) listener({ paused: true, drain: null });
		}
	};
	const close = vi.fn();
	const context: NodeChannelContext = {
		channel: 7,
		family: 'logs',
		params,
		consents: MANAGE,
		control,
		nodeVersion: '1.0.0',
		nodeName: 'build-01',
		sendJson: (message) => {
			if (!state.link) return false;
			json.push(message);
			return true;
		},
		sendBinary: (_kind, payload) => {
			if (!state.link || !state.credit) return false;
			frames.push(new TextDecoder().decode(payload));
			return true;
		},
		sendControl: () => true,
		close,
		operations: { start: () => 'op', progress: () => undefined, done: () => undefined }
	};
	return { context, control, json, frames, state, close, lines: () => frames.flatMap((frame) => parseFleetLogLines(frame)) };
}

function reader(batch: RawLogLine[], extra: Partial<LogReader> = {}): LogReader & { sink: LogFollowSink | null; stopped: number } {
	const self = {
		supportsEarlier: false,
		sink: null as LogFollowSink | null,
		stopped: 0,
		tail: async () => ({ lines: batch }),
		follow(sink: LogFollowSink) {
			self.sink = sink;
			return { stop: () => (self.stopped += 1) };
		},
		...extra
	};
	return self;
}

const line = (text: string, ts: string | null = null): RawLogLine => ({ ts, level: 'info', text });

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('encodeLogLine', () => {
	it('scans before framing and counts the redaction', () => {
		const encoded = encodeLogLine(line(`token ${SECRET} leaked`), 0);
		expect(encoded.text).not.toContain(SECRET);
		expect(encoded.text).toContain('[redacted secret]');
		expect(encoded.redactions).toBe(1);
		expect(encoded.bytes).toBeLessThan(FLEET_LOGS_MAX_FRAME_BYTES);
	});
});

describe('LogChannel', () => {
	it('streams nothing until asked, then the batch and initial-done (logs.read: no follow)', async () => {
		const h = harness();
		const timers = clock();
		const source = reader([line('one'), line(`two ${SECRET}`)]);
		const channel = new LogChannel(h.context, [source], 500, { timers, openReaders: async () => [source] });
		expect(h.frames).toHaveLength(0);
		channel.handler.onJson?.({ type: 'logs.read', lines: 500 });
		await settle();
		expect(h.lines().map((l) => l.text)).toEqual(['one', 'two [redacted secret]']);
		expect(h.json.at(-1)).toMatchObject({ type: 'logs.initial-done', count: 2, redactions: 1, following: false });
		expect(source.sink).toBeNull();
	});

	it('follows after the batch and sends live lines', async () => {
		const h = harness();
		const timers = clock();
		const source = reader([line('old')]);
		const channel = new LogChannel(h.context, [source], 500, { timers, openReaders: async () => [source] });
		channel.handler.onJson?.({ type: 'logs.follow', on: true, lines: 500 });
		await settle();
		expect(h.json.at(-1)).toMatchObject({ type: 'logs.initial-done', following: true });
		source.sink?.line(line('new'));
		timers.advance(1);
		expect(h.lines().map((l) => l.text)).toEqual(['old', 'new']);
		channel.handler.onJson?.({ type: 'logs.follow', on: false });
		expect(source.stopped).toBe(1);
	});

	it('paces live lines at 1 MiB/s', async () => {
		const h = harness();
		const timers = clock();
		const source = reader([]);
		const channel = new LogChannel(h.context, [source], 500, { timers, openReaders: async () => [source] });
		channel.handler.onJson?.({ type: 'logs.follow', on: true });
		await settle();
		const text = 'x'.repeat(8 * 1024);
		// ~1.6 MiB arriving at once: the first MiB goes, the rest waits for the bucket.
		for (let i = 0; i < 200; i += 1) {
			source.sink?.line(line(text));
			if (i % 10 === 0) timers.advance(0);
		}
		timers.advance(0);
		const sentFirst = h.frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0);
		expect(sentFirst).toBeLessThanOrEqual(FLEET_LOGS_FOLLOW_BYTES_PER_SEC);
		timers.advance(1_000);
		const sentLater = h.frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0);
		expect(sentLater).toBeGreaterThan(sentFirst);
		expect(h.frames.every((frame) => Buffer.byteLength(frame) <= FLEET_LOGS_MAX_FRAME_BYTES)).toBe(true);
	});

	it('holds at most 1 MiB without credit, drops the oldest and says how many before the next live frame', async () => {
		const h = harness();
		const timers = clock();
		const source = reader([]);
		const channel = new LogChannel(h.context, [source], 500, { timers, openReaders: async () => [source] });
		channel.handler.onJson?.({ type: 'logs.follow', on: true });
		await settle();
		h.state.credit = false;
		const text = 'y'.repeat(16 * 1024 - 100);
		const total = Math.ceil((FLEET_LOGS_PENDING_MAX_BYTES * 1.5) / (16 * 1024));
		for (let i = 0; i < total; i += 1) source.sink?.line(line(`${i} ${text}`));
		timers.advance(0);
		expect(h.frames).toHaveLength(0);
		h.state.credit = true;
		channel.handler.onDrain?.();
		const dropped = h.json.find((message) => message.type === 'logs.notice' && message.kind === 'dropped');
		expect(dropped?.count).toBeGreaterThan(0);
		const first = h.lines()[0];
		expect(first?.text.startsWith(`${dropped?.count} `)).toBe(true);
	});

	it('holds live lines while paused and sends them on resume', async () => {
		const h = harness();
		const timers = clock();
		const source = reader([]);
		const channel = new LogChannel(h.context, [source], 500, { timers, openReaders: async () => [source] });
		channel.handler.onJson?.({ type: 'logs.follow', on: true });
		await settle();
		channel.handler.onJson?.({ type: 'logs.pause' });
		source.sink?.line(line('while paused'));
		timers.advance(10);
		expect(h.lines()).toHaveLength(0);
		channel.handler.onJson?.({ type: 'logs.resume' });
		expect(h.lines().map((l) => l.text)).toEqual(['while paused']);
	});

	it('stops following and closes kill_switch when the link is paused', async () => {
		const h = harness();
		const timers = clock();
		const source = reader([]);
		const channel = new LogChannel(h.context, [source], 500, { timers, openReaders: async () => [source] });
		channel.handler.onJson?.({ type: 'logs.follow', on: true });
		await settle();
		h.control.pause();
		expect(source.stopped).toBe(1);
		expect(h.json.at(-1)).toMatchObject({ type: 'logs.notice', kind: 'kill-switch' });
		expect(h.close).toHaveBeenCalledWith('kill_switch', expect.any(String));
	});

	it('answers an initial-done with the error when the batch cannot be read', async () => {
		const h = harness();
		const timers = clock();
		const failing = reader([], {
			tail: async () => {
				throw new LogReadError('operation_failed', 'journalctl exited 1: "Failed to add match"');
			}
		});
		const channel = new LogChannel(h.context, [failing], 500, { timers, openReaders: async () => [failing] });
		channel.handler.onJson?.({ type: 'logs.follow', on: true });
		await settle();
		expect(h.json.at(-1)).toMatchObject({
			type: 'logs.initial-done',
			count: 0,
			following: false,
			error: { code: 'operation_failed' }
		});
		expect(failing.sink).toBeNull();
	});

	it('merges a set of sources by time, tagging each line with its source', async () => {
		const h = harness({ source: 'container:api', sources: ['container:db'] });
		const timers = clock();
		const api = reader([line('api 1', '2026-10-21T09:41:02.000Z'), line('api 2', '2026-10-21T09:41:04.000Z')]);
		const db = reader([line('db 1', '2026-10-21T09:41:03.000Z')]);
		const channel = new LogChannel(h.context, [api, db], 500, { timers, openReaders: async () => [api, db] });
		channel.handler.onJson?.({ type: 'logs.read' });
		await settle();
		expect(h.lines().map((l) => [l.text, l.src])).toEqual([
			['api 1', 0],
			['db 1', 1],
			['api 2', 0]
		]);
	});

	it('answers an older page marked earlier, ahead of waiting live lines', async () => {
		const h = harness();
		const timers = clock();
		const source = reader([line('now')], {
			supportsEarlier: true,
			earlier: async () => ({ lines: [line('before')], hasMore: false })
		});
		const channel = new LogChannel(h.context, [source], 500, { timers, openReaders: async () => [source] });
		channel.handler.onJson?.({ type: 'logs.read' });
		await settle();
		channel.handler.onJson?.({ type: 'logs.earlier', lines: 500 });
		await settle();
		const earlier = h.lines().filter((l) => l.earlier === true);
		expect(earlier.map((l) => l.text)).toEqual(['before']);
		expect(h.json.at(-1)).toMatchObject({ type: 'logs.earlier-done', count: 1, hasMore: false });
	});
});

describe('openLogChannel', () => {
	it('refuses a malformed source, the kill switch and a reader refusal', async () => {
		const timers = clock();
		const ok = { timers, openReaders: async () => [reader([])] };
		expect(await openLogChannel(harness({ source: 'nope' }).context, ok)).toMatchObject({
			ok: false,
			error: { code: 'invalid' }
		});
		const paused = harness();
		(paused.control as { paused: boolean }).paused = true;
		expect(await openLogChannel(paused.context, ok)).toMatchObject({ ok: false, error: { code: 'kill_switch' } });
		const outside = {
			timers,
			openReaders: async () => {
				throw new LogReadError('invalid', "Only files under this computer's shared folders and standard log directories can be read");
			}
		};
		expect(await openLogChannel(harness({ source: 'file:/etc/shadow' }).context, outside)).toMatchObject({
			ok: false,
			error: { code: 'invalid' }
		});
		expect(await openLogChannel(harness().context, ok)).toMatchObject({ ok: true });
	});
});
