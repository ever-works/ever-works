import { describe, expect, it } from 'vitest';
import { FleetClientError, type HeartbeatResponse } from './fleet-client';
import {
	HeartbeatLoop,
	computeBackoffDelay,
	type HeartbeatCapableClient,
	type HeartbeatState,
	type Scheduler
} from './heartbeat';
import { createLogger, REDACTED, type LogEntry } from './logger';
import { MAX_HEARTBEAT_BACKOFF_MS, type FleetNodeView } from './types';

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const INTERVAL = 60_000;

const nodeView: FleetNodeView = {
	id: NODE_ID,
	name: 'build-box-01',
	kind: 'node',
	status: 'online',
	platform: 'linux/x64',
	version: '0.1.0',
	capabilities: ['os:linux'],
	lastHeartbeatAt: null,
	createdAt: null,
	persisted: true
};

/** Scheduler that captures the pending timer instead of arming a real one. */
function fakeScheduler() {
	let pending: { callback: () => void; ms: number } | null = null;
	let cleared = 0;
	const scheduler: Scheduler = {
		setTimeout: (callback, ms) => {
			pending = { callback, ms };
			return { id: 1 };
		},
		clearTimeout: () => {
			cleared += 1;
			pending = null;
		}
	};
	return {
		scheduler,
		delay: () => pending?.ms ?? null,
		hasPending: () => pending !== null,
		clearedCount: () => cleared
	};
}

/** Client whose next response is scripted per call. */
function scriptedClient(responses: Array<HeartbeatResponse | Error>) {
	const requests: Array<{ nodeId: string; secret: string; capabilities?: string[] }> = [];
	let index = 0;
	const client: HeartbeatCapableClient = {
		heartbeat: async (request) => {
			requests.push(request);
			const next = responses[Math.min(index, responses.length - 1)];
			index += 1;
			if (next instanceof Error) {
				throw next;
			}
			return next;
		}
	};
	return { client, requests, sent: () => index };
}

const ok: HeartbeatResponse = { ok: true, node: nodeView };

function buildLoop(
	responses: Array<HeartbeatResponse | Error>,
	overrides: { capabilities?: string[]; now?: () => number } = {}
) {
	const scheduler = fakeScheduler();
	const scripted = scriptedClient(responses);
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	const states: HeartbeatState[] = [];

	const loop = new HeartbeatLoop({
		client: scripted.client,
		nodeId: NODE_ID,
		secret: SECRET,
		describe: async () => ({
			platform: 'linux/x64',
			version: '0.1.0',
			capabilities: overrides.capabilities ?? ['os:linux']
		}),
		intervalMs: INTERVAL,
		scheduler: scheduler.scheduler,
		logger,
		now: overrides.now ?? (() => 1_700_000_000_000)
	});
	loop.onChange((state) => states.push(state));

	return { loop, scheduler, scripted, entries, logger, states };
}

describe('computeBackoffDelay', () => {
	it('uses the nominal interval while healthy, then doubles per failure', () => {
		expect(computeBackoffDelay(INTERVAL, 0, MAX_HEARTBEAT_BACKOFF_MS)).toBe(INTERVAL);
		expect(computeBackoffDelay(INTERVAL, 1, MAX_HEARTBEAT_BACKOFF_MS)).toBe(2 * INTERVAL);
		expect(computeBackoffDelay(INTERVAL, 2, MAX_HEARTBEAT_BACKOFF_MS)).toBe(4 * INTERVAL);
	});

	it('caps at the ceiling and never overflows on a long outage', () => {
		expect(computeBackoffDelay(INTERVAL, 3, MAX_HEARTBEAT_BACKOFF_MS)).toBe(MAX_HEARTBEAT_BACKOFF_MS);
		expect(computeBackoffDelay(INTERVAL, 5_000, MAX_HEARTBEAT_BACKOFF_MS)).toBe(MAX_HEARTBEAT_BACKOFF_MS);
		expect(Number.isFinite(computeBackoffDelay(INTERVAL, 5_000, MAX_HEARTBEAT_BACKOFF_MS))).toBe(true);
	});
});

describe('HeartbeatLoop', () => {
	it('connects on the first beat and re-arms at the nominal interval', async () => {
		const { loop, scheduler, scripted } = buildLoop([ok]);

		await loop.start();

		const state = loop.getState();
		expect(state.state).toBe('connected');
		expect(state.consecutiveFailures).toBe(0);
		expect(state.lastHeartbeatAt).toBe(1_700_000_000_000);
		expect(state.node).toEqual(nodeView);
		expect(scheduler.delay()).toBe(INTERVAL);
		expect(scripted.requests[0]).toMatchObject({ nodeId: NODE_ID, secret: SECRET, capabilities: ['os:linux'] });
	});

	it('backs off exponentially across consecutive failures', async () => {
		const { loop, scheduler } = buildLoop([new Error('ECONNREFUSED')]);

		await loop.start();
		expect(loop.getState().state).toBe('retrying');
		expect(loop.getState().consecutiveFailures).toBe(1);
		expect(scheduler.delay()).toBe(2 * INTERVAL);

		await loop.tick();
		expect(loop.getState().consecutiveFailures).toBe(2);
		expect(scheduler.delay()).toBe(4 * INTERVAL);

		await loop.tick();
		expect(loop.getState().consecutiveFailures).toBe(3);
		expect(scheduler.delay()).toBe(MAX_HEARTBEAT_BACKOFF_MS);
	});

	it('recovers on the first success: state, failure count and cadence all reset', async () => {
		const { loop, scheduler } = buildLoop([new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), ok]);

		await loop.start();
		await loop.tick();
		expect(loop.getState().consecutiveFailures).toBe(2);
		expect(scheduler.delay()).toBe(4 * INTERVAL);

		await loop.tick();

		expect(loop.getState().state).toBe('connected');
		expect(loop.getState().consecutiveFailures).toBe(0);
		expect(loop.getState().lastError).toBeNull();
		expect(scheduler.delay()).toBe(INTERVAL);
	});

	it('marks a rejected credential unauthorized but keeps retrying so a re-enabled node self-heals', async () => {
		const revoked = new FleetClientError('unauthorized', 'Node credential was rejected', 401);
		const { loop, scheduler } = buildLoop([revoked, revoked, ok]);

		await loop.start();
		expect(loop.getState().state).toBe('unauthorized');
		expect(loop.getState().lastErrorKind).toBe('unauthorized');
		expect(scheduler.hasPending()).toBe(true);

		await loop.tick();
		expect(loop.getState().state).toBe('unauthorized');

		await loop.tick();
		expect(loop.getState().state).toBe('connected');
	});

	it('stops cleanly: timer cancelled, no further beats, state stopped', async () => {
		const { loop, scheduler, scripted } = buildLoop([ok]);

		await loop.start();
		expect(scheduler.hasPending()).toBe(true);
		const sentBeforeStop = scripted.sent();

		loop.stop();

		expect(loop.getState().state).toBe('stopped');
		expect(loop.getState().nextAttemptInMs).toBeNull();
		expect(scheduler.hasPending()).toBe(false);
		expect(scheduler.clearedCount()).toBeGreaterThan(0);

		// A tick after stop must not resurrect the loop.
		await loop.tick();
		expect(scripted.sent()).toBe(sentBeforeStop);
	});

	it('re-detects capabilities on every beat so host changes reach Fleet live', async () => {
		let capabilities = ['os:linux'];
		const scheduler = fakeScheduler();
		const scripted = scriptedClient([ok]);
		const loop = new HeartbeatLoop({
			client: scripted.client,
			nodeId: NODE_ID,
			secret: SECRET,
			describe: async () => ({ capabilities: [...capabilities] }),
			intervalMs: INTERVAL,
			scheduler: scheduler.scheduler
		});

		await loop.start();
		capabilities = ['os:linux', 'docker'];
		await loop.tick();

		expect(scripted.requests[0].capabilities).toEqual(['os:linux']);
		expect(scripted.requests[1].capabilities).toEqual(['os:linux', 'docker']);
	});

	it('notifies subscribers and never leaks the secret into failure logs', async () => {
		const { loop, entries, states } = buildLoop([new Error(`auth failed for secret ${SECRET}`)]);

		await loop.start();

		expect(states.length).toBeGreaterThan(0);
		expect(states[states.length - 1].state).toBe('retrying');

		const text = entries.map((entry) => entry.message).join('\n');
		expect(text).toContain('Heartbeat failed (attempt 1)');
		expect(text).not.toContain(SECRET);
		expect(text).toContain(REDACTED);
		expect(loop.getState().lastError).not.toContain(SECRET);
	});

	/**
	 * Fleet health signals (EW-776) — the node's half of the additive-wire
	 * contract.
	 *
	 * The API validates heartbeats with `whitelist + forbidNonWhitelisted`,
	 * so a field an older platform does not know 400s the whole request.
	 * That makes the OBVIOUS implementation of this feature — just add the
	 * field — one whose failure mode is "every node in a mixed-version
	 * fleet stops beating and sweeps to offline": the exact class of
	 * silent outage the slice was written to end. So the loop drops the
	 * fields and retries once, and only for a literal 400.
	 */
	describe('worker state against an older platform', () => {
		const workerBeat = (responses: Array<HeartbeatResponse | Error>) => {
			const scheduler = fakeScheduler();
			const scripted = scriptedClient(responses);
			const entries: LogEntry[] = [];
			const loop = new HeartbeatLoop({
				client: scripted.client,
				nodeId: NODE_ID,
				secret: SECRET,
				describe: async () => ({
					platform: 'linux/x64',
					capabilities: ['os:linux'],
					workerState: 'quarantined',
					workerStateReason: 'process tree unproven'
				}),
				intervalMs: INTERVAL,
				scheduler: scheduler.scheduler,
				logger: createLogger({ sink: (entry) => entries.push(entry) })
			});
			return { loop, scheduler, scripted, entries };
		};

		const rejected = () => new FleetClientError('invalid-request', 'Request rejected by the API (HTTP 400)', 400);

		it('sends the worker state to a platform that accepts it', async () => {
			const { loop, scripted } = workerBeat([ok]);

			await loop.start();

			expect(scripted.requests[0]).toMatchObject({
				workerState: 'quarantined',
				workerStateReason: 'process tree unproven'
			});
			expect(scripted.sent()).toBe(1);
		});

		it('retries once WITHOUT the fields when the platform 400s them', async () => {
			const { loop, scripted, entries } = workerBeat([rejected(), ok]);

			await loop.start();

			// Two requests, one beat: the first carried the fields, the
			// second did not, and the beat SUCCEEDED.
			expect(scripted.sent()).toBe(2);
			expect(scripted.requests[0]).toHaveProperty('workerState');
			expect(scripted.requests[1]).not.toHaveProperty('workerState');
			expect(scripted.requests[1]).not.toHaveProperty('workerStateReason');
			// Everything else still goes.
			expect(scripted.requests[1]).toMatchObject({ nodeId: NODE_ID, secret: SECRET, platform: 'linux/x64' });
			// And it is a SUCCESS: connected, no failure counted, no backoff.
			expect(loop.getState().state).toBe('connected');
			expect(loop.getState().consecutiveFailures).toBe(0);
			expect(entries.some((entry) => entry.message.includes('predates them'))).toBe(true);
		});

		it('drops the HOUSEKEEPING fields too, not just the worker state (EW-803)', async () => {
			// Every field added to the self-description after an API release
			// has to be in `OPTIONAL_DESCRIPTION_FIELDS`, or a node talking to
			// an older platform 400s forever and sweeps to offline. This
			// pins the housekeeping five, which are the newest additions —
			// and it is the case that would have caught them being forgotten.
			const scheduler = fakeScheduler();
			const scripted = scriptedClient([rejected(), ok]);
			const loop = new HeartbeatLoop({
				client: scripted.client,
				nodeId: NODE_ID,
				secret: SECRET,
				describe: async () => ({
					platform: 'linux/x64',
					capabilities: ['os:linux'],
					// No worker state at all: the housekeeping fields alone
					// must be enough to trigger the fallback, or a node whose
					// worker probe happened to return nothing goes dark.
					minFreeDiskBytes: 2 * 1024 ** 3,
					workspaceCount: 12,
					workspaceBytes: 40 * 1024 ** 3,
					lastReclaimAt: '2026-09-05T09:30:00.000Z',
					lastReclaimFreedBytes: 3 * 1024 ** 3
				}),
				intervalMs: INTERVAL,
				scheduler: scheduler.scheduler
			});

			await loop.start();

			expect(scripted.sent()).toBe(2);
			for (const field of [
				'minFreeDiskBytes',
				'workspaceCount',
				'workspaceBytes',
				'lastReclaimAt',
				'lastReclaimFreedBytes'
			]) {
				expect(scripted.requests[0]).toHaveProperty(field);
				expect(scripted.requests[1]).not.toHaveProperty(field);
			}
			expect(scripted.requests[1]).toMatchObject({ platform: 'linux/x64' });
			expect(loop.getState().state).toBe('connected');
			expect(loop.getState().consecutiveFailures).toBe(0);
		});

		it('treats an explicit NULL floor as a carried field, so it still triggers the fallback', async () => {
			// `minFreeDiskBytes: null` is the one legitimate null on this
			// payload ("the operator switched the floor off"). A truthiness
			// test in `carriesOptionalFields` would miss it, and the beat
			// would 400 in a loop with no retry.
			const scheduler = fakeScheduler();
			const scripted = scriptedClient([rejected(), ok]);
			const loop = new HeartbeatLoop({
				client: scripted.client,
				nodeId: NODE_ID,
				secret: SECRET,
				describe: async () => ({ platform: 'linux/x64', minFreeDiskBytes: null }),
				intervalMs: INTERVAL,
				scheduler: scheduler.scheduler
			});

			await loop.start();

			expect(scripted.sent()).toBe(2);
			expect(scripted.requests[1]).not.toHaveProperty('minFreeDiskBytes');
			expect(loop.getState().state).toBe('connected');
		});

		it('latches, so it costs one extra request per process and not per beat', async () => {
			const { loop, scripted } = workerBeat([rejected(), ok]);

			await loop.start();
			await loop.tick();
			await loop.tick();

			// 2 for the first beat (probe + retry), then 1 each.
			expect(scripted.sent()).toBe(4);
			expect(scripted.requests[2]).not.toHaveProperty('workerState');
			expect(scripted.requests[3]).not.toHaveProperty('workerState');
			expect(loop.getState().state).toBe('connected');
		});

		it('does not retry a 400 on a beat that carried no worker state', async () => {
			// Preserves the old behaviour exactly for a description with
			// nothing droppable: a 400 is a failure, and it backs off.
			const scheduler = fakeScheduler();
			const scripted = scriptedClient([rejected(), ok]);
			const loop = new HeartbeatLoop({
				client: scripted.client,
				nodeId: NODE_ID,
				secret: SECRET,
				describe: async () => ({ platform: 'linux/x64' }),
				intervalMs: INTERVAL,
				scheduler: scheduler.scheduler
			});

			await loop.start();

			expect(scripted.sent()).toBe(1);
			expect(loop.getState().state).toBe('retrying');
			expect(loop.getState().consecutiveFailures).toBe(1);
		});

		it.each([
			['a 401', new FleetClientError('unauthorized', 'Node credential was rejected', 401)],
			['a 403', new FleetClientError('forbidden', 'Refused by the API edge', 403)],
			['a 429', new FleetClientError('rate-limited', 'Rate limited', 429)],
			['a 5xx', new FleetClientError('server', 'API error (HTTP 503)', 503)],
			['a network error', new Error('ECONNREFUSED')]
		])('does not strip or latch on %s', async (_label, error) => {
			// Latching on a blip would silence this node's health reporting
			// until it restarts, for a platform that supports it perfectly.
			const { loop, scripted } = workerBeat([error, ok]);

			await loop.start();
			expect(scripted.sent()).toBe(1);
			expect(loop.getState().state).not.toBe('connected');

			await loop.tick();
			expect(scripted.requests[1]).toHaveProperty('workerState');
		});

		it('keeps beating when even the stripped retry fails', async () => {
			// Both attempts refused: this is a real failure, counted once
			// and backed off like any other.
			const { loop, scripted } = workerBeat([rejected(), rejected()]);

			await loop.start();

			expect(scripted.sent()).toBe(2);
			expect(loop.getState().state).toBe('retrying');
			expect(loop.getState().consecutiveFailures).toBe(1);
		});
	});
});
