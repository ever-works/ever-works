import { describe, expect, it, vi } from 'vitest';
import {
	FLEET_LINK_CLOSE_CODES,
	FLEET_LINK_FRAME_HEADER_BYTES,
	FLEET_LINK_MAX_FRAME_BYTES,
	FLEET_NO_CONSENTS,
	type FleetConsents
} from '@ever-works/contracts';
import { FleetClientError } from '../fleet-client';
import type { Logger } from '../logger';
import { createNodeLink, type NodeLinkOptions } from './link-client';
import { fakeSocketFactory, flush, manualClock, readyMessage } from './link-test-kit';
import type { NodeModule } from './modules/registry';
import { composeNodeLinkModules } from './modules';

const NODE = '7d1f0c2a-3b4e-4f5a-8c6d-9e0f1a2b3c4d';
const WORK_MANAGE: FleetConsents = { ...FLEET_NO_CONSENTS, work: true, manage: true };

function testLogger(): Logger & { lines: string[] } {
	const lines: string[] = [];
	const log = (level: string) => (message: string) => lines.push(`${level}: ${message}`);
	return {
		lines,
		info: log('info'),
		warn: log('warn'),
		error: log('error'),
		debug: log('debug'),
		protect: vi.fn(),
		unprotect: vi.fn(),
		redact: (value: string) => value
	} as unknown as Logger & { lines: string[] };
}

function setup(overrides: Partial<NodeLinkOptions> = {}, extraModules: NodeModule[] = []) {
	const clock = manualClock();
	const sockets = fakeSocketFactory();
	const logger = testLogger();
	let minted = 0;
	const mintToken = vi.fn(async () => {
		minted += 1;
		return { token: `link-token-${minted}`, wsPath: '/ws/fleet/link', expiresInSec: 300 };
	});
	const options: NodeLinkOptions = {
		apiUrl: 'https://api.ever.works',
		nodeId: NODE,
		nodeName: 'build-01',
		nodeVersion: '0.3.0',
		consents: WORK_MANAGE,
		capabilities: () => ['os:linux', 'terminal', 'managed'],
		mintToken,
		factory: sockets.factory,
		logger,
		scheduler: clock.scheduler,
		now: clock.now,
		random: () => 0.5,
		modules: composeNodeLinkModules({
			extra: extraModules,
			setTimer: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
			clearTimer: (handle) => clock.scheduler.clearTimeout(handle)
		}),
		...overrides
	};
	const link = createNodeLink(options);
	return { link, clock, sockets, logger, mintToken };
}

async function connect(h: ReturnType<typeof setup>, generation = 1) {
	h.link.start();
	await flush();
	const socket = h.sockets.last();
	socket.open();
	socket.receiveControl(readyMessage(generation));
	return socket;
}

describe('createNodeLink — opening', () => {
	it('never opens without a work, attend or manage consent, and says why (FR-1, FR-2)', async () => {
		const h = setup({ consents: { ...FLEET_NO_CONSENTS, usageScan: true } });
		h.link.start();
		await flush();
		expect(h.mintToken).not.toHaveBeenCalled();
		expect(h.sockets.sockets).toHaveLength(0);
		expect(h.link.getState().phase).toBe('not-open');
		expect(h.logger.lines.join('\n')).toMatch(/only reports health/);
	});

	it('never mints a token or opens a socket to a plain-http origin (FR-6, ACC-FL02-04)', async () => {
		const h = setup({ apiUrl: 'http://api.example.com' });
		h.link.start();
		await flush();
		expect(h.mintToken).not.toHaveBeenCalled();
		expect(h.sockets.sockets).toHaveLength(0);
		expect(h.link.getState().phase).toBe('insecure');
	});

	it('sends the hello first with the tags, the consents, the token and the version (FR-4)', async () => {
		const h = setup();
		h.link.start();
		await flush();
		const socket = h.sockets.last();
		expect(socket.url).toBe('wss://api.ever.works/ws/fleet/link');
		expect(socket.sent).toHaveLength(0);
		socket.open();
		expect(socket.controls()).toEqual([
			{
				type: 'link.hello',
				nodeId: NODE,
				linkVersion: 1,
				capabilities: ['os:linux', 'terminal', 'managed'],
				consents: WORK_MANAGE,
				token: 'link-token-1',
				nodeVersion: '0.3.0'
			}
		]);
		expect(h.logger.protect).toHaveBeenCalledWith('link-token-1');
		expect(h.link.getState().phase).toBe('connecting');
		socket.receiveControl(readyMessage(7));
		expect(h.link.getState()).toMatchObject({ phase: 'connected', linkGeneration: 7 });
		// Single use: once the attempt ended the token leaves the redactor too.
		expect(h.logger.unprotect).toHaveBeenCalledWith('link-token-1');
	});

	it('is idempotent to start twice', async () => {
		const h = setup();
		h.link.start();
		h.link.start();
		await flush();
		expect(h.mintToken).toHaveBeenCalledTimes(1);
	});
});

describe('createNodeLink — keeping it alive', () => {
	it('pings every 15 s and answers the platform’s ping (FR-7)', async () => {
		const h = setup();
		const socket = await connect(h);
		h.clock.advance(14_999);
		expect(socket.controls().filter((m) => m.type === 'link.ping')).toHaveLength(0);
		socket.receiveControl({ type: 'link.pong', t: 1 });
		h.clock.advance(1);
		expect(socket.controls().filter((m) => m.type === 'link.ping')).toHaveLength(1);
		socket.receiveControl({ type: 'link.ping', t: 42 });
		expect(socket.controls().at(-1)).toEqual({ type: 'link.pong', t: 42 });
	});

	it('closes after 45 s with no frame and reconnects presenting the lost generation (FR-7, FR-9)', async () => {
		const h = setup();
		const socket = await connect(h, 7);
		h.clock.advance(45_000);
		expect(socket.closedWith).toEqual({ code: FLEET_LINK_CLOSE_CODES.silence, reason: 'silence' });
		expect(h.link.getState().phase).toBe('reconnecting');
		// 1 s backoff (random 0.5 = no jitter), then a fresh token and a hello carrying generation 7.
		h.clock.advance(1_000);
		await flush();
		expect(h.mintToken).toHaveBeenCalledTimes(2);
		const next = h.sockets.last();
		next.open();
		expect(next.controls()[0]).toMatchObject({
			type: 'link.hello',
			token: 'link-token-2',
			resume: { linkGeneration: 7, channels: [] }
		});
	});

	it('backs off 1 s → 30 s and resets only after a ready (FR-8)', async () => {
		const h = setup();
		h.link.start();
		await flush();
		const waits: number[] = [];
		for (let attempt = 0; attempt < 7; attempt += 1) {
			const socket = h.sockets.last();
			socket.open(); // opened, then refused: not an acceptance
			socket.drop(FLEET_LINK_CLOSE_CODES.auth);
			waits.push(h.link.getState().nextAttemptInMs!);
			h.clock.advance(waits.at(-1)!);
			await flush();
		}
		expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
		const socket = h.sockets.last();
		socket.open();
		socket.receiveControl(readyMessage(2));
		socket.drop(1006);
		expect(h.link.getState().nextAttemptInMs).toBe(1_000);
	});

	it('treats a socket that opens but never answers ready as a failed attempt', async () => {
		const h = setup();
		h.link.start();
		await flush();
		const socket = h.sockets.last();
		socket.open();
		h.clock.advance(10_000);
		expect(socket.closedWith?.code).toBe(FLEET_LINK_CLOSE_CODES.protocol);
		expect(h.link.getState().phase).toBe('reconnecting');
	});
});

describe('createNodeLink — refusals', () => {
	it('says once that the platform does not accept links and retries every 5 minutes (FR-10, U2)', async () => {
		const h = setup();
		h.mintToken.mockRejectedValue(
			new FleetClientError('invalid-request', 'Request rejected by the API (HTTP 404)', 404)
		);
		h.link.start();
		await flush();
		expect(h.link.getState()).toMatchObject({ phase: 'refused', nextAttemptInMs: 5 * 60_000 });
		h.clock.advance(5 * 60_000);
		await flush();
		expect(h.mintToken).toHaveBeenCalledTimes(2);
		const refusals = h.logger.lines.filter((line) => line.includes('does not accept node links yet'));
		expect(refusals).toHaveLength(1);
		expect(h.sockets.sockets).toHaveLength(0);
	});

	it('waits 5 minutes after the platform closes with "links not accepted" (4003)', async () => {
		const h = setup();
		const socket = await connect(h);
		socket.drop(FLEET_LINK_CLOSE_CODES.disabled);
		expect(h.link.getState()).toMatchObject({ phase: 'refused', nextAttemptInMs: 5 * 60_000 });
	});

	it('waits at least the 60 s block after a hello storm refusal (4008, U9)', async () => {
		const h = setup();
		h.link.start();
		await flush();
		h.sockets.last().open();
		h.sockets.last().drop(FLEET_LINK_CLOSE_CODES.rateLimited);
		expect(h.link.getState().nextAttemptInMs).toBe(60_000);
	});

	it('stops for good when the platform refuses the consents (4012)', async () => {
		const h = setup();
		const socket = await connect(h);
		socket.drop(FLEET_LINK_CLOSE_CODES.noConsent);
		expect(h.link.getState().phase).toBe('not-open');
		expect(h.clock.pending()).toEqual([]);
	});

	it('backs off on a network failure to mint, without reporting the token', async () => {
		const h = setup();
		h.mintToken.mockRejectedValueOnce(new FleetClientError('network', 'Could not reach the API'));
		h.link.start();
		await flush();
		expect(h.link.getState()).toMatchObject({ phase: 'connecting', nextAttemptInMs: 1_000 });
	});
});

describe('createNodeLink — channels, pause, operations', () => {
	it('opens the machine channel the platform asks for and answers a verb on it', async () => {
		const h = setup({}, [
			{ id: 'health', machineVerbs: { 'health.now': { stateChanging: false, run: () => ({ cpuPercent: 3 }) } } }
		]);
		const socket = await connect(h);
		socket.receiveControl({ type: 'channel.open', channel: 3, family: 'machine', params: {}, requestId: 'open-3' });
		await flush();
		expect(socket.controls().at(-1)).toEqual({
			type: 'channel.ready',
			channel: 3,
			requestId: 'open-3',
			resumeKey: 'machine'
		});
		socket.receiveJson(3, { requestId: 'q1', type: 'health.now', params: {} });
		await flush();
		expect(socket.jsonOn(3)).toEqual([{ requestId: 'q1', result: { cpuPercent: 3 } }]);
		expect(h.link.getState().openChannels).toBe(1);
		expect(h.link.getState().bytesIn).toBeGreaterThan(0);
		expect(h.link.getState().bytesOut).toBeGreaterThan(0);
	});

	it('pauses on link.pause and lifts it on link.resume without reconnecting (FR-26)', async () => {
		const h = setup();
		const socket = await connect(h);
		socket.receiveControl({ type: 'link.pause', reason: 'kill_switch' });
		expect(h.link.control.paused).toBe(true);
		expect(h.link.getState().paused).toBe(true);
		socket.receiveControl({ type: 'channel.open', channel: 4, family: 'machine', params: {}, requestId: 'open-4' });
		await flush();
		expect(socket.controls().at(-1)).toMatchObject({ type: 'channel.refused', error: { code: 'kill_switch' } });
		socket.receiveControl({ type: 'link.resume' });
		expect(h.link.control.paused).toBe(false);
		expect(h.sockets.sockets).toHaveLength(1);
	});

	it('lifts a pause from an earlier link when a new link is ready — the resume it was not there to hear', async () => {
		// The kill switch went on (this link paused), the link dropped, the
		// switch was cleared while it was away: the platform only resumes the
		// links it holds, and re-sends link.pause after ready while it is still on.
		const h = setup();
		const socket = await connect(h, 1);
		socket.receiveControl({ type: 'link.pause', reason: 'kill_switch' });
		expect(h.link.control.paused).toBe(true);
		socket.drop(1006);
		h.clock.advance(1_000);
		await flush();
		const next = h.sockets.last();
		next.open();
		next.receiveControl(readyMessage(2));
		expect(h.link.control.paused).toBe(false);
		next.receiveControl({ type: 'channel.open', channel: 1, family: 'machine', params: {}, requestId: 'o1' });
		await flush();
		expect(next.controls().at(-1)).toMatchObject({ type: 'channel.ready', channel: 1 });
		// A pause the platform repeats after ready still holds.
		next.receiveControl({ type: 'link.pause', reason: 'kill_switch' });
		expect(h.link.control.paused).toBe(true);
	});

	it('records a drain for the session module (FR-27)', async () => {
		const h = setup();
		const socket = await connect(h);
		const seen = vi.fn();
		h.link.control.onChange(seen);
		socket.receiveControl({ type: 'link.drain', graceSec: 60 });
		expect(h.link.control.drain).toEqual({ graceSec: 60, receivedAt: h.clock.now() });
		expect(seen).toHaveBeenCalled();
	});

	it('closes only the channel an oversized frame was aimed at; the link stays up (U5)', async () => {
		const h = setup();
		const socket = await connect(h);
		socket.receiveControl({ type: 'channel.open', channel: 3, family: 'machine', params: {}, requestId: 'open-3' });
		await flush();
		const oversized = new Uint8Array(FLEET_LINK_MAX_FRAME_BYTES + 1);
		new DataView(oversized.buffer).setUint32(0, 3, false);
		new DataView(oversized.buffer).setUint8(4, 1);
		new DataView(oversized.buffer).setUint32(5, oversized.byteLength - FLEET_LINK_FRAME_HEADER_BYTES, false);
		socket.receiveRaw(oversized);
		expect(socket.controls().at(-1)).toEqual({
			type: 'channel.close',
			channel: 3,
			reason: 'invalid',
			hint: 'frame over 16 MiB'
		});
		expect(h.link.getState().phase).toBe('connected');
	});

	it('resumes the channels the platform resumed and closes the rest (FR-9, ACC-FL02-05)', async () => {
		const closed = vi.fn();
		const resumed = vi.fn();
		const h = setup({}, [
			{
				id: 'sessions',
				families: [
					{
						family: 'session',
						consent: 'manage',
						open: (context) => ({
							ok: true,
							handler: {
								resumeKey: `s-${context.channel}`,
								onResume: () => resumed(context.channel),
								onClose: (reason) => closed(context.channel, reason)
							}
						})
					}
				]
			}
		]);
		const socket = await connect(h, 7);
		for (const channel of [4, 5]) {
			socket.receiveControl({
				type: 'channel.open',
				channel,
				family: 'session',
				params: {},
				requestId: `o${channel}`
			});
		}
		await flush();
		socket.drop(1006);
		h.clock.advance(1_000);
		await flush();
		const next = h.sockets.last();
		next.open();
		expect(next.controls()[0]).toMatchObject({
			resume: {
				linkGeneration: 7,
				channels: [
					{ channel: 4, family: 'session', resumeKey: 's-4' },
					{ channel: 5, family: 'session', resumeKey: 's-5' }
				]
			}
		});
		next.receiveControl(readyMessage(8, { resumed: [4], closed: [5] }));
		expect(resumed).toHaveBeenCalledWith(4);
		expect(closed).toHaveBeenCalledWith(5, 'resume_failed');
		expect(h.link.getState().linkGeneration).toBe(8);
	});

	it('delivers an operation result that finished while the link was down after the next ready', async () => {
		let finish!: (value: unknown) => void;
		const h = setup({}, [
			{
				id: 'docker',
				machineVerbs: {
					'docker.image.pull': {
						stateChanging: true,
						run: () => new Promise((resolve) => (finish = resolve))
					}
				}
			}
		]);
		const socket = await connect(h, 1);
		socket.receiveControl({ type: 'channel.open', channel: 3, family: 'machine', params: {}, requestId: 'o3' });
		await flush();
		socket.receiveJson(3, { requestId: 'q1', type: 'docker.image.pull' });
		await flush();
		h.clock.advance(2_000);
		const operationId = socket.jsonOn(3)[0].operationId as string;
		expect(operationId).toMatch(/^op-/);
		socket.drop(1006);
		finish({ ok: true });
		await flush();
		h.clock.advance(1_000);
		await flush();
		const next = h.sockets.last();
		next.open();
		next.receiveControl(readyMessage(2, { resumed: [3] }));
		expect(next.controls().filter((m) => m.type === 'operation.done')).toEqual([
			{ type: 'operation.done', operationId, result: { ok: true } }
		]);
	});

	it('fails an operation whose result is too large for any link, instead of keeping it forever', async () => {
		let finish!: (value: unknown) => void;
		const h = setup({}, [
			{
				id: 'docker',
				machineVerbs: {
					'docker.image.list': {
						stateChanging: false,
						run: () => new Promise((resolve) => (finish = resolve))
					}
				}
			}
		]);
		const socket = await connect(h);
		socket.receiveControl({ type: 'channel.open', channel: 3, family: 'machine', params: {}, requestId: 'o3' });
		await flush();
		socket.receiveJson(3, { requestId: 'q1', type: 'docker.image.list' });
		await flush();
		h.clock.advance(2_000);
		const operationId = socket.jsonOn(3)[0].operationId as string;
		finish({ blob: 'x'.repeat(2 * 1024 * 1024) });
		await flush();
		const done = socket.controls().filter((m) => m.type === 'operation.done');
		expect(done).toEqual([
			{
				type: 'operation.done',
				operationId,
				error: { code: 'operation_failed', hint: 'the result was too large to send back (over 1 MiB)' }
			}
		]);
		// Nothing is held for the next link.
		socket.drop(1006);
		h.clock.advance(1_000);
		await flush();
		const next = h.sockets.last();
		next.open();
		next.receiveControl(readyMessage(2));
		expect(next.controls().filter((m) => m.type === 'operation.done')).toEqual([]);
	});

	it('cancels an operation the platform cancels', async () => {
		const aborted = vi.fn();
		const h = setup({}, [
			{
				id: 'docker',
				machineVerbs: {
					'docker.image.pull': {
						stateChanging: true,
						run: (context) =>
							new Promise((_, reject) =>
								context.signal.addEventListener('abort', () => {
									aborted();
									reject(new Error('aborted'));
								})
							)
					}
				}
			}
		]);
		const socket = await connect(h);
		socket.receiveControl({ type: 'channel.open', channel: 3, family: 'machine', params: {}, requestId: 'o3' });
		await flush();
		socket.receiveJson(3, { requestId: 'q1', type: 'docker.image.pull' });
		await flush();
		h.clock.advance(2_000);
		const operationId = socket.jsonOn(3)[0].operationId as string;
		socket.receiveControl({ type: 'operation.cancel', operationId });
		await flush();
		expect(aborted).toHaveBeenCalled();
		expect(socket.controls().at(-1)).toEqual({
			type: 'operation.done',
			operationId,
			error: { code: 'operation_failed', hint: 'cancelled' }
		});
	});

	it('ignores everything but link.ready before the link is ready', async () => {
		const h = setup();
		h.link.start();
		await flush();
		const socket = h.sockets.last();
		socket.open();
		socket.receiveControl({ type: 'channel.open', channel: 3, family: 'machine', params: {}, requestId: 'o3' });
		await flush();
		expect(socket.controls().map((m) => m.type)).toEqual(['link.hello']);
	});

	it('closes cleanly: channels end normal, nothing reconnects', async () => {
		const h = setup();
		const socket = await connect(h);
		h.link.close();
		expect(socket.closedWith?.code).toBe(1000);
		expect(h.link.getState().phase).toBe('closed');
		expect(h.clock.pending()).toEqual([]);
	});
});
