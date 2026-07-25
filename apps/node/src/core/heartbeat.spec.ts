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
});
