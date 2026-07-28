import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import type { Scheduler } from './heartbeat';
import { ADMIT, admitByResourceLimits, hasAdmissionCeilings, type ResourceSample } from './resource-limits';
import { clampResourceLimits, DEFAULT_RESOURCE_LIMITS } from './types';
import { WorkerLoop, type JobLeaseCapableClient } from './worker-loop';

/**
 * Resource limits (A16) and pause/resume (A18).
 *
 * The point of these tests is that the ceilings are HONOURED, not merely
 * stored: a node whose owner said "one job, and not while I'm compiling"
 * must actually refuse to lease a second job, and must actually stop
 * leasing when the machine is busy. Storing the number and then leasing
 * anyway would be worse than not offering the setting at all.
 */

/** Records requested delays and fires callbacks on demand. */
function controllableScheduler(): Scheduler & { delays: number[]; runNext(): void; pending: number } {
	const queue: Array<{ id: number; callback: () => void }> = [];
	const delays: number[] = [];
	let nextId = 1;

	return {
		delays,
		get pending(): number {
			return queue.length;
		},
		setTimeout(callback: () => void, ms: number): unknown {
			delays.push(ms);
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

function job(overrides: Partial<FleetJobView> = {}): FleetJobView {
	return {
		id: 'job-1',
		kind: 'acceptance-checks',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [],
		payload: { workspacePath: '/w', checks: [] },
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null,
		...overrides
	};
}

/** Client that records every lease request so we can assert on `max`. */
function recordingClient(batches: FleetJobView[][]): JobLeaseCapableClient & {
	leaseRequests: Array<{ max?: number }>;
	complete: ReturnType<typeof vi.fn>;
} {
	let index = 0;
	const leaseRequests: Array<{ max?: number }> = [];
	const complete = vi.fn(async () => true);
	const client = {
		leaseRequests,
		complete,
		heartbeat: vi.fn(async () => true),
		lease: async (request: { max?: number }) => {
			leaseRequests.push(request);
			const next = batches[Math.min(index, batches.length - 1)] ?? [];
			index += 1;
			return next;
		}
	};
	return client as never;
}

function sample(overrides: Partial<ResourceSample> = {}): ResourceSample {
	return { cpuPercent: 10, usedMemoryMb: 2_000, totalMemoryMb: 16_000, ...overrides };
}

describe('clampResourceLimits', () => {
	it('defaults to one job and no CPU/memory ceiling', () => {
		expect(clampResourceLimits(undefined)).toEqual(DEFAULT_RESOURCE_LIMITS);
		expect(clampResourceLimits(null)).toEqual(DEFAULT_RESOURCE_LIMITS);
	});

	it('clamps concurrency into the supported range instead of throwing', () => {
		expect(clampResourceLimits({ maxConcurrentJobs: 0 }).maxConcurrentJobs).toBe(1);
		expect(clampResourceLimits({ maxConcurrentJobs: 999 }).maxConcurrentJobs).toBe(16);
		expect(clampResourceLimits({ maxConcurrentJobs: 4.6 }).maxConcurrentJobs).toBe(5);
	});

	it('treats a nonsense ceiling as "no ceiling" rather than a hard block', () => {
		expect(clampResourceLimits({ maxCpuPercent: Number.NaN }).maxCpuPercent).toBeNull();
		expect(clampResourceLimits({ maxMemoryMb: Number.POSITIVE_INFINITY }).maxMemoryMb).toBeNull();
	});

	it('clamps a CPU ceiling below the floor up, not down to zero', () => {
		// A 1% ceiling would idle the node forever; the floor is the safety.
		expect(clampResourceLimits({ maxCpuPercent: 1 }).maxCpuPercent).toBe(5);
	});
});

describe('admitByResourceLimits', () => {
	it('admits when no ceiling is configured', () => {
		expect(admitByResourceLimits({ maxCpuPercent: null, maxMemoryMb: null }, sample({ cpuPercent: 99 }))).toEqual(
			ADMIT
		);
	});

	it('refuses when CPU is at or above the ceiling, naming the reason', () => {
		const decision = admitByResourceLimits({ maxCpuPercent: 80, maxMemoryMb: null }, sample({ cpuPercent: 92 }));
		expect(decision.admit).toBe(false);
		expect(decision.reason).toContain('CPU');
		expect(decision.reason).toContain('80%');
	});

	it('refuses when memory in use is at or above the ceiling', () => {
		const decision = admitByResourceLimits(
			{ maxCpuPercent: null, maxMemoryMb: 4_096 },
			sample({ usedMemoryMb: 4_096 })
		);
		expect(decision.admit).toBe(false);
		expect(decision.reason).toContain('memory');
	});

	it('admits when the sample is missing — an unreadable probe must not idle the node', () => {
		expect(admitByResourceLimits({ maxCpuPercent: 10, maxMemoryMb: 512 }, null)).toEqual(ADMIT);
	});

	it('knows when probing is worth the cost', () => {
		expect(hasAdmissionCeilings({ maxCpuPercent: null, maxMemoryMb: null })).toBe(false);
		expect(hasAdmissionCeilings({ maxCpuPercent: 50, maxMemoryMb: null })).toBe(true);
	});
});

describe('WorkerLoop honours the operator resource limits', () => {
	it('never leases more than maxConcurrentJobs at a time', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 3 })
		});

		await loop.start();

		expect(loop.maxConcurrency).toBe(3);
		expect(client.leaseRequests[0]?.max).toBe(3);
		await loop.stop();
	});

	it('stops asking for work while jobs occupy the whole concurrency budget', async () => {
		// One slot, one job that never finishes until we let it.
		let release: () => void = () => undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const client = recordingClient([[job()], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 1 })
		});
		loop.register('acceptance-checks', async () => {
			await blocked;
		});

		await loop.start();
		await vi.waitFor(() => expect(loop.getState().activeJobIds).toHaveLength(1));

		const callsWhileBusy = client.leaseRequests.length;
		// Fire the follow-up poll: with the single slot occupied it must not
		// reach the API at all.
		scheduler.runNext();
		expect(client.leaseRequests.length).toBe(callsWhileBusy);

		release();
		await loop.stop();
	});

	it('refuses to lease while the host is above the CPU ceiling, then resumes when it drops', async () => {
		const client = recordingClient([[], []]);
		const scheduler = controllableScheduler();
		let cpu = 95;
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 2, maxCpuPercent: 80 }),
			resourceProbe: { sample: () => sample({ cpuPercent: cpu }) }
		});

		await loop.start();

		// Over the ceiling: visible as `throttled`, and NO lease call made.
		expect(client.leaseRequests).toHaveLength(0);
		expect(loop.getState().state).toBe('throttled');
		expect(loop.getState().throttleReason).toContain('CPU');

		// Machine calms down — the very next poll leases normally.
		cpu = 12;
		scheduler.runNext();
		await vi.waitFor(() => expect(client.leaseRequests.length).toBe(1));
		expect(loop.getState().throttleReason).toBeNull();

		await loop.stop();
	});

	it('refuses to lease while the host is above the memory ceiling', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 2, maxMemoryMb: 4_096 }),
			resourceProbe: { sample: () => sample({ usedMemoryMb: 8_000 }) }
		});

		await loop.start();

		expect(client.leaseRequests).toHaveLength(0);
		expect(loop.getState().throttleReason).toContain('memory');
		await loop.stop();
	});

	it('leases anyway when the probe throws — a broken sampler must not strand the node', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 1, maxCpuPercent: 50 }),
			resourceProbe: {
				sample: () => {
					throw new Error('/proc unreadable');
				}
			}
		});

		await loop.start();

		expect(client.leaseRequests).toHaveLength(1);
		expect(loop.getState().state).not.toBe('throttled');
		await loop.stop();
	});

	it('skips sampling entirely when no CPU/memory ceiling is set', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const probe = { sample: vi.fn(() => sample()) };
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 2 }),
			resourceProbe: probe
		});

		await loop.start();

		expect(probe.sample).not.toHaveBeenCalled();
		expect(client.leaseRequests).toHaveLength(1);
		await loop.stop();
	});

	it('still honours the legacy `concurrency` option when no limits are supplied', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler, concurrency: 4 });

		await loop.start();

		expect(loop.maxConcurrency).toBe(4);
		await loop.stop();
	});
});

describe('WorkerLoop pause/resume', () => {
	it('stops leasing while paused and starts again on resume', async () => {
		const client = recordingClient([[], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });

		await loop.start();
		expect(client.leaseRequests).toHaveLength(1);

		loop.pause();
		expect(loop.isPaused()).toBe(true);
		expect(loop.getState().state).toBe('paused');
		expect(loop.getState().paused).toBe(true);

		// The contract is "no LEASE while paused", not "no timer". The loop
		// deliberately keeps re-arming: that is what lets `resume()` take
		// effect without restarting the process, and what keeps the state
		// moving from `draining` to `paused` as the last in-flight job
		// finishes. Draining a machine should not make it go quiet in Fleet.
		//
		// So the assertion is on the thing that actually matters — the tick
		// runs and still declines to lease.
		const leasesWhilePaused = client.leaseRequests.length;
		scheduler.runNext();
		await vi.waitFor(() => expect(loop.getState().paused).toBe(true));
		expect(client.leaseRequests).toHaveLength(leasesWhilePaused);

		loop.resume();
		await vi.waitFor(() => expect(client.leaseRequests.length).toBe(2));
		expect(loop.getState().paused).toBe(false);

		await loop.stop();
	});

	it('starts paused when asked, without ever hitting the API', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler, startPaused: true });

		await loop.start();

		expect(client.leaseRequests).toHaveLength(0);
		expect(loop.getState().paused).toBe(true);
		await loop.stop();
	});

	it('lets an in-flight job finish and REPORT after a pause', async () => {
		let release: () => void = () => undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const client = recordingClient([[job()], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });
		loop.register('acceptance-checks', async () => {
			await blocked;
			return { ok: true };
		});

		await loop.start();
		await vi.waitFor(() => expect(loop.getState().activeJobIds).toHaveLength(1));

		loop.pause();
		release();

		// Pausing must not turn finished work into a lease expiry.
		await vi.waitFor(() =>
			expect(client.complete).toHaveBeenCalledWith('job-1', expect.objectContaining({ success: true }))
		);
		await loop.stop();
	});

	it('is idempotent — a second pause or resume is a no-op', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });

		await loop.start();
		loop.pause();
		loop.pause();
		expect(loop.isPaused()).toBe(true);

		loop.resume();
		const after = client.leaseRequests.length;
		loop.resume();
		expect(client.leaseRequests.length).toBe(after);

		await loop.stop();
	});
});
