import { describe, expect, it, vi } from 'vitest';
import {
	FLEET_NODE_MAX_CONCURRENT_JOBS,
	FLEET_NODE_MAX_CPU_PERCENT,
	FLEET_NODE_MAX_MEMORY_MB,
	FLEET_NODE_MIN_CONCURRENT_JOBS,
	FLEET_NODE_MIN_CPU_PERCENT,
	FLEET_NODE_MIN_MEMORY_MB,
	type FleetJobView
} from '@ever-works/contracts';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import { describeSelf } from './capabilities';
import type { FetchLike } from './fleet-client';
import { readLimitCeiling } from './fleet-client';
import type { Scheduler } from './heartbeat';
import { createLogger, type LogEntry } from './logger';
import { NodeLifecycleTracker } from './node-lifecycle';
import { createNodeRuntime } from './runtime';
import {
	applyNodeLimitCeiling,
	clampResourceLimits,
	MAX_CONCURRENT_JOBS,
	MAX_CPU_PERCENT,
	MAX_MEMORY_MB,
	MIN_CONCURRENT_JOBS,
	MIN_CPU_PERCENT,
	MIN_MEMORY_MB,
	type NodeConfig
} from './types';
import { WorkerLoop } from './worker-loop';

/**
 * Remote node limits (self-build slice AS) — the node's half.
 *
 * What is pinned:
 *   - the node enforces `min(its own limits, the owner's ceiling)` per
 *     dimension: a ceiling can only LOWER what a machine does, and lifting
 *     it (all null) hands the machine straight back to its own flags;
 *   - the clamp takes effect at the next lease (the `max` it asks for);
 *   - the heartbeat reports the EFFECTIVE limits, so Fleet shows what the
 *     machine really does rather than what was asked of it;
 *   - a malformed ceiling on the wire is ignored whole, never half-applied.
 */

const NONE = { maxConcurrentJobs: null, maxCpuPercent: null, maxMemoryMb: null };

describe('the node clamps into the SAME bounds the platform validates against', () => {
	it('uses the shared contract bounds', () => {
		expect([MIN_CONCURRENT_JOBS, MAX_CONCURRENT_JOBS]).toEqual([
			FLEET_NODE_MIN_CONCURRENT_JOBS,
			FLEET_NODE_MAX_CONCURRENT_JOBS
		]);
		expect([MIN_CPU_PERCENT, MAX_CPU_PERCENT]).toEqual([FLEET_NODE_MIN_CPU_PERCENT, FLEET_NODE_MAX_CPU_PERCENT]);
		expect([MIN_MEMORY_MB, MAX_MEMORY_MB]).toEqual([FLEET_NODE_MIN_MEMORY_MB, FLEET_NODE_MAX_MEMORY_MB]);
	});
});

describe('applyNodeLimitCeiling', () => {
	const local = clampResourceLimits({ maxConcurrentJobs: 4, maxCpuPercent: 70, maxMemoryMb: null });

	it('takes the LOWER of the local flag and the ceiling, per dimension', () => {
		expect(applyNodeLimitCeiling(local, { maxConcurrentJobs: 2, maxCpuPercent: 90, maxMemoryMb: 8192 })).toEqual({
			maxConcurrentJobs: 2, // the ceiling is lower
			maxCpuPercent: 70, // the local flag is lower
			maxMemoryMb: 8192 // no local ceiling: the platform's applies
		});
	});

	it('can never RAISE what the machine does — its own flags stay the upper bound', () => {
		expect(applyNodeLimitCeiling(local, { maxConcurrentJobs: 16, maxCpuPercent: 100, maxMemoryMb: null })).toEqual(
			local
		);
	});

	it('an all-null (or absent) ceiling hands the machine back to its own flags', () => {
		expect(applyNodeLimitCeiling(local, NONE)).toEqual(local);
		expect(applyNodeLimitCeiling(local, null)).toEqual(local);
	});

	it('clamps a nonsense ceiling into the node’s own bounds, like a flag', () => {
		expect(applyNodeLimitCeiling(local, { maxConcurrentJobs: 0, maxCpuPercent: 1, maxMemoryMb: 10 })).toEqual({
			maxConcurrentJobs: 1,
			maxCpuPercent: 5,
			maxMemoryMb: 256
		});
	});

	it('passes the disk floor through untouched', () => {
		const withFloor = clampResourceLimits({ maxConcurrentJobs: 2, minFreeDiskBytes: null });
		expect(applyNodeLimitCeiling(withFloor, { ...NONE, maxConcurrentJobs: 1 }).minFreeDiskBytes).toBeNull();
	});
});

function controllableScheduler(): Scheduler & { runNext(): void } {
	const queue: Array<{ id: number; callback: () => void }> = [];
	let nextId = 1;
	return {
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

describe('WorkerLoop.applyLimitCeiling', () => {
	it('lowers the lease batch from the next poll, and lifting it restores the local flag', async () => {
		const requests: Array<{ max?: number }> = [];
		const client = {
			heartbeat: vi.fn(),
			complete: vi.fn(async () => true),
			lease: vi.fn(async (request: { max?: number }) => {
				requests.push(request);
				return [] as FleetJobView[];
			})
		};
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client: client as never,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 4 })
		});

		await loop.start();
		expect(requests[0].max).toBe(4);

		expect(loop.applyLimitCeiling({ ...NONE, maxConcurrentJobs: 2 })).toBe(true);
		expect(loop.maxConcurrency).toBe(2);
		expect(loop.localResourceLimits.maxConcurrentJobs).toBe(4);
		scheduler.runNext();
		await vi.waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[1].max).toBe(2);

		// The same ceiling again is not a change.
		expect(loop.applyLimitCeiling({ ...NONE, maxConcurrentJobs: 2 })).toBe(false);

		expect(loop.applyLimitCeiling(NONE)).toBe(true);
		scheduler.runNext();
		await vi.waitFor(() => expect(requests).toHaveLength(3));
		expect(requests[2].max).toBe(4);
		await loop.stop();
	});
});

describe('what the heartbeat carries', () => {
	const environment: CapabilityEnvironment = {
		platform: 'linux',
		arch: 'x64',
		nodeVersion: 'v26.0.0',
		hasDisplay: false
	};
	const runner: CommandRunner = { run: async () => ({ code: 127, stdout: '', stderr: '' }) };

	it('reports the effective set, with an explicit null for "no ceiling in force"', async () => {
		const description = await describeSelf(runner, environment, '0.2.0', null, {
			limits: () => ({ maxConcurrentJobs: 2, maxCpuPercent: 70, maxMemoryMb: null })
		});
		expect(description).toMatchObject({ maxConcurrentJobs: 2, maxCpuPercent: 70, maxMemoryMb: null });
		expect(description).toHaveProperty('maxMemoryMb', null);
	});

	it('reports nothing at all on a node without a worker', async () => {
		const description = await describeSelf(runner, environment, '0.2.0', null, {});
		expect(description).not.toHaveProperty('maxConcurrentJobs');
		expect(description).not.toHaveProperty('maxCpuPercent');
	});

	it('reads a ceiling only when it is whole and well-formed', () => {
		expect(
			readLimitCeiling({ limitCeiling: { maxConcurrentJobs: 2, maxCpuPercent: null, maxMemoryMb: null } })
		).toEqual({ maxConcurrentJobs: 2, maxCpuPercent: null, maxMemoryMb: null });
		expect(readLimitCeiling({ limitCeiling: { maxConcurrentJobs: 2 } })).toBeNull();
		expect(
			readLimitCeiling({ limitCeiling: { maxConcurrentJobs: '2', maxCpuPercent: null, maxMemoryMb: null } })
		).toBeNull();
		expect(readLimitCeiling({ limitCeiling: [] })).toBeNull();
		expect(readLimitCeiling({})).toBeNull();
	});
});

describe('NodeLifecycleTracker — the ceiling', () => {
	it('hands a ceiling over once per CHANGE and records it for status/doctor', async () => {
		const onLimitCeiling = vi.fn();
		const persist = vi.fn(async () => undefined);
		const tracker = new NodeLifecycleTracker({
			daemonVersion: '0.2.0',
			logger: createLogger({ sink: () => undefined }),
			lanes: () => [],
			onLimitCeiling,
			persist
		});
		const ceiling = { maxConcurrentJobs: 2, maxCpuPercent: null, maxMemoryMb: null };
		tracker.applyHeartbeat({ limitCeiling: ceiling });
		tracker.applyHeartbeat({ limitCeiling: { ...ceiling } });
		tracker.applyHeartbeat({});
		expect(onLimitCeiling).toHaveBeenCalledTimes(1);
		expect(onLimitCeiling).toHaveBeenCalledWith(ceiling);

		tracker.applyHeartbeat({ limitCeiling: NONE });
		expect(onLimitCeiling).toHaveBeenCalledTimes(2);
		expect(onLimitCeiling).toHaveBeenLastCalledWith(NONE);
		expect(tracker.snapshot().limitCeiling).toEqual(NONE);
		await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
	});
});

describe('createNodeRuntime — a ceiling on the beat clamps the work lane, and the next beat says so', () => {
	const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
	const NODE_ID = '11111111-2222-4333-8444-555555555555';
	const config: NodeConfig = {
		apiUrl: 'https://api.ever.works',
		nodeId: NODE_ID,
		secret: SECRET,
		kind: 'node',
		capabilities: [],
		limits: clampResourceLimits({ maxConcurrentJobs: 4 }),
		heartbeatIntervalMs: 60_000,
		enrolledAt: '2026-07-25T10:00:00.000Z'
	};

	it('applies min(local, ceiling) and reports the effective set on the following beat', async () => {
		const beats: Array<Record<string, unknown>> = [];
		const entries: LogEntry[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/heartbeat')) {
				beats.push(JSON.parse(init.body) as Record<string, unknown>);
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							ok: true,
							node: { id: NODE_ID },
							limitCeiling: { maxConcurrentJobs: 2, maxCpuPercent: 80, maxMemoryMb: null }
						})
				};
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
		};
		const runtime = createNodeRuntime(
			config,
			{
				fetchFn,
				runner: { run: async () => ({ code: 127, stdout: '', stderr: '' }) },
				environment: { platform: 'linux', arch: 'x64', nodeVersion: 'v26.0.0', hasDisplay: false },
				logger: createLogger({ sink: (entry) => entries.push(entry) }),
				version: '0.2.0'
			},
			{ workerEnabled: true, limits: config.limits }
		);

		await runtime.loop.start();
		expect(runtime.worker?.maxConcurrency).toBe(2);
		expect(runtime.worker?.resourceLimits.maxCpuPercent).toBe(80);
		expect(entries.some((entry) => entry.message.includes('Platform limit ceiling applied'))).toBe(true);
		// The first beat reported the limits it had BEFORE hearing the ceiling…
		expect(beats[0]).toMatchObject({ maxConcurrentJobs: 4, maxCpuPercent: null, maxMemoryMb: null });

		// …and the next one reports what it enforces now.
		await runtime.loop.tick();
		expect(beats[1]).toMatchObject({ maxConcurrentJobs: 2, maxCpuPercent: 80, maxMemoryMb: null });
		runtime.loop.stop();
	});
});
