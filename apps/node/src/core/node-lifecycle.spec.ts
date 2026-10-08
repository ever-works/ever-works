import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import type { Scheduler } from './heartbeat';
import { describeWorkerHealth } from './worker-health';
import { describeUpgradeRequired, WorkerLoop, type JobLeaseCapableClient } from './worker-loop';
import {
	NodeLifecycleTracker,
	nodeLifecycleRecordPath,
	parseNodeLifecycleRecord,
	readNodeLifecycleRecord,
	writeNodeLifecycleRecord,
	type NodeLifecycleRecord
} from './node-lifecycle';
import { clampResourceLimits } from './types';
import { readHeartbeatLifecycle } from './fleet-client';

/**
 * Node lifecycle (self-build slice AR) — the node's half of the daemon
 * version floor.
 *
 * What is pinned:
 *   - a lease answered `upgradeRequired` HOLDS the lane: no further lease
 *     call is made, the state reads `throttled` with the upgrade command as
 *     the reason (so Fleet can show why the machine is idle), and work that
 *     is already running is left alone;
 *   - a heartbeat that says `upgradeRequired: false` LIFTS the hold and
 *     polls at once, with no restart;
 *   - a heartbeat from an older platform (no fields) changes nothing;
 *   - the transition is logged ONCE, with the exact upgrade command, and
 *     recorded beside the config only when the verdict changes.
 */

function controllableScheduler(): Scheduler & { runNext(): void; pending: number } {
	const queue: Array<{ id: number; callback: () => void }> = [];
	let nextId = 1;
	return {
		get pending(): number {
			return queue.length;
		},
		setTimeout(callback: () => void): unknown {
			const id = nextId++;
			queue.push({ id, callback });
			return id;
		},
		clearTimeout(handle: unknown): void {
			const index = queue.findIndex((entry) => entry.id === handle);
			if (index >= 0) queue.splice(index, 1);
		},
		runNext(): void {
			queue.shift()?.callback();
		}
	};
}

/** A client whose `leaseOutcome` answers from a script. */
function scriptedClient(
	answers: Array<{ jobs: FleetJobView[]; upgradeRequired: boolean; minNodeVersion: string | null }>
): JobLeaseCapableClient & { calls: number } {
	let index = 0;
	const client = {
		calls: 0,
		heartbeat: vi.fn(async () => null),
		complete: vi.fn(async () => true),
		lease: vi.fn(async () => {
			throw new Error('a client with leaseOutcome must be asked through it');
		}),
		leaseOutcome: vi.fn(async () => {
			client.calls += 1;
			const answer = answers[Math.min(index, answers.length - 1)];
			index += 1;
			return answer;
		})
	};
	return client as never;
}

const REFUSED = { jobs: [], upgradeRequired: true, minNodeVersion: '0.3.0' };
const EMPTY = { jobs: [], upgradeRequired: false, minNodeVersion: null };

function silentLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		protect: vi.fn(),
		unprotect: vi.fn(),
		redact: (value: string) => value
	};
}

describe('WorkerLoop — the version-floor hold', () => {
	it('holds the lane on a lease refusal: no further lease call, throttled with the upgrade command', async () => {
		const client = scriptedClient([REFUSED, EMPTY]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler, limits: clampResourceLimits({ maxConcurrentJobs: 1 }) });
		const told = vi.fn();
		loop.onUpgradeRequired(told);

		await loop.start();

		expect(client.calls).toBe(1);
		expect(told).toHaveBeenCalledWith(expect.objectContaining({ minNodeVersion: '0.3.0' }));
		expect(loop.getUpgradeHold()?.minNodeVersion).toBe('0.3.0');
		const state = loop.getState();
		expect(state.state).toBe('throttled');
		expect(state.throttleReason).toContain('npm install -g ever-works-node@latest');
		// What the heartbeat reports — the wire vocabulary for "running,
		// not leasing more", captioned with WHY.
		expect(describeWorkerHealth(state)).toEqual({
			workerState: 'throttled',
			workerStateReason: state.throttleReason
		});

		// The next tick does not even ask: the answer is known.
		scheduler.runNext();
		await vi.waitFor(() => expect(loop.getState().state).toBe('throttled'));
		expect(client.calls).toBe(1);
		await loop.stop();
	});

	it('lifts the hold the moment it is told the daemon is admitted again, and polls at once', async () => {
		const client = scriptedClient([REFUSED, EMPTY]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });
		await loop.start();
		expect(client.calls).toBe(1);

		loop.setUpgradeHold(null);

		await vi.waitFor(() => expect(client.calls).toBe(2));
		await vi.waitFor(() => expect(loop.getState().state).toBe('idle'));
		expect(loop.getState().throttleReason ?? null).toBeNull();
		expect(loop.getUpgradeHold()).toBeNull();
		await loop.stop();
	});

	it('a hold set BEFORE start keeps the lane from leasing at all', async () => {
		const client = scriptedClient([EMPTY]);
		const loop = new WorkerLoop({ client, scheduler: controllableScheduler() });
		loop.setUpgradeHold({ minNodeVersion: '0.3.0', reason: describeUpgradeRequired('0.3.0', '0.2.0') });
		await loop.start();
		expect(client.calls).toBe(0);
		expect(loop.getState().state).toBe('throttled');
		await loop.stop();
	});

	it('an older client with only `lease` is still served — it simply cannot hear the refusal', async () => {
		const lease = vi.fn(async () => [] as FleetJobView[]);
		const loop = new WorkerLoop({
			client: { lease, heartbeat: vi.fn(), complete: vi.fn(async () => true) } as never,
			scheduler: controllableScheduler()
		});
		await loop.start();
		expect(lease).toHaveBeenCalledTimes(1);
		expect(loop.getUpgradeHold()).toBeNull();
		await loop.stop();
	});
});

describe('NodeLifecycleTracker', () => {
	const lane = () => ({ setUpgradeHold: vi.fn() });

	it('holds every lane, logs ONCE with the exact command, and lifts on a clearing beat', () => {
		const logger = silentLogger();
		const work = lane();
		const attended = lane();
		const tracker = new NodeLifecycleTracker({
			daemonVersion: '0.2.0',
			logger: logger as never,
			lanes: () => [work, attended]
		});

		tracker.applyHeartbeat({ minNodeVersion: '0.3.0', upgradeRequired: true });
		tracker.applyHeartbeat({ minNodeVersion: '0.3.0', upgradeRequired: true });

		const hold = work.setUpgradeHold.mock.calls[0][0];
		expect(hold).toEqual({ minNodeVersion: '0.3.0', reason: expect.stringContaining('This daemon (0.2.0)') });
		expect(hold.reason).toContain('npm install -g ever-works-node@latest');
		expect(attended.setUpgradeHold).toHaveBeenCalledWith(hold);
		expect(logger.error).toHaveBeenCalledTimes(1);

		tracker.applyHeartbeat({ minNodeVersion: '0.2.0', upgradeRequired: false });
		expect(work.setUpgradeHold).toHaveBeenLastCalledWith(null);
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('leasing resumes'));
	});

	it('a beat from a platform older than the floor changes nothing', () => {
		const work = lane();
		const tracker = new NodeLifecycleTracker({
			daemonVersion: '0.2.0',
			logger: silentLogger() as never,
			lanes: () => [work]
		});
		tracker.applyLeaseRefusal('0.3.0');
		work.setUpgradeHold.mockClear();

		tracker.applyHeartbeat({});
		expect(work.setUpgradeHold).not.toHaveBeenCalled();
		expect(tracker.snapshot().upgradeRequired).toBe(true);
	});

	it('records the verdict only when it CHANGES — not a disk write per beat', async () => {
		const persist = vi.fn(async (_record: NodeLifecycleRecord) => undefined);
		const tracker = new NodeLifecycleTracker({
			daemonVersion: '0.2.0',
			logger: silentLogger() as never,
			lanes: () => [],
			persist,
			now: () => Date.parse('2026-10-08T12:00:00.000Z')
		});
		for (let beat = 0; beat < 5; beat += 1)
			tracker.applyHeartbeat({ minNodeVersion: '0.1.0', upgradeRequired: false });
		tracker.applyHeartbeat({ minNodeVersion: '0.3.0', upgradeRequired: true });
		await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
		expect(persist.mock.calls[1][0]).toEqual({
			version: 1,
			recordedAt: '2026-10-08T12:00:00.000Z',
			daemonVersion: '0.2.0',
			minNodeVersion: '0.3.0',
			upgradeRequired: true
		});
	});

	it('a failed write is logged and retried on the next beat, never thrown', async () => {
		const logger = silentLogger();
		const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
		const tracker = new NodeLifecycleTracker({
			daemonVersion: '0.2.0',
			logger: logger as never,
			lanes: () => [],
			persist
		});
		tracker.applyHeartbeat({ minNodeVersion: '0.1.0', upgradeRequired: false });
		await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk full')));
		tracker.applyHeartbeat({ minNodeVersion: '0.1.0', upgradeRequired: false });
		await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
	});
});

describe('the lifecycle record beside the config', () => {
	it('round-trips through the config filesystem at a path next to the config', async () => {
		const files = new Map<string, string>();
		const fs = {
			readFile: async (path: string) => files.get(path) ?? null,
			writeFile: async (path: string, content: string) => {
				files.set(path, content);
			},
			mkdir: async () => undefined,
			dirname: (path: string) => path.replace(/[\\/][^\\/]*$/, '')
		};
		const record: NodeLifecycleRecord = {
			version: 1,
			recordedAt: '2026-10-08T12:00:00.000Z',
			daemonVersion: '0.2.0',
			minNodeVersion: '0.3.0',
			upgradeRequired: true
		};
		await writeNodeLifecycleRecord(fs, '/etc/ever-works-node/node-config.json', record);
		expect(nodeLifecycleRecordPath('/etc/ever-works-node/node-config.json')).toBe(
			'/etc/ever-works-node/node-config.json.lifecycle.json'
		);
		expect(await readNodeLifecycleRecord(fs, '/etc/ever-works-node/node-config.json')).toEqual(record);
	});

	it('reads a missing, truncated or hand-edited file as "no record"', () => {
		expect(parseNodeLifecycleRecord(null)).toBeNull();
		expect(parseNodeLifecycleRecord('{"version":1,')).toBeNull();
		expect(parseNodeLifecycleRecord('{"version":2,"recordedAt":"2026-10-08T12:00:00.000Z"}')).toBeNull();
		// A garbage floor is dropped, never trusted; a non-boolean verdict is false.
		expect(
			parseNodeLifecycleRecord(
				'{"version":1,"recordedAt":"2026-10-08T12:00:00.000Z","minNodeVersion":"latest","upgradeRequired":"yes"}'
			)
		).toMatchObject({ minNodeVersion: null, upgradeRequired: false });
	});
});

describe('readHeartbeatLifecycle — a malformed answer is ignored, never coerced', () => {
	it('reads a real floor and a real boolean', () => {
		expect(readHeartbeatLifecycle({ minNodeVersion: '0.3.0', upgradeRequired: true })).toEqual({
			minNodeVersion: '0.3.0',
			upgradeRequired: true
		});
	});

	it('drops what it cannot trust — "false" must not idle a machine, garbage must not clear a refusal', () => {
		expect(readHeartbeatLifecycle({ minNodeVersion: 'latest', upgradeRequired: 'false' })).toEqual({});
		expect(readHeartbeatLifecycle({ upgradeRequired: 1 })).toEqual({});
		expect(readHeartbeatLifecycle(null)).toEqual({});
	});
});
