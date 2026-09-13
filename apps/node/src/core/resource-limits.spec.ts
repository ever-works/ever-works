import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import type { Scheduler } from './heartbeat';
import {
	ADMIT,
	admitByResourceLimits,
	formatBytes,
	hasAdmissionCeilings,
	hasDiskFloor,
	judgeDiskFloor,
	type ResourceSample
} from './resource-limits';
import {
	clampResourceLimits,
	DEFAULT_MIN_FREE_DISK_BYTES,
	DEFAULT_RESOURCE_LIMITS,
	effectiveMinFreeDiskBytes,
	MAX_MIN_FREE_DISK_BYTES,
	MIN_MIN_FREE_DISK_BYTES
} from './types';
import { WorkerLoop, type JobLeaseCapableClient } from './worker-loop';
import { assertWorkspaceDiskHeadroom } from './workspaces/fleet-task-workspace';

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

/**
 * Disk floor (self-build program note §6, OPS-12). `diskFreeBytes` was
 * heart-beated, stored and rendered — and consulted by nothing. A node
 * with 200 MB free kept leasing and failed deep inside git or pnpm.
 */
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

describe('clampResourceLimits — disk floor', () => {
	it('leaves the key absent when the operator never set it, so the default floor applies', () => {
		const limits = clampResourceLimits({ maxConcurrentJobs: 2 });
		expect('minFreeDiskBytes' in limits).toBe(false);
		expect(effectiveMinFreeDiskBytes(limits)).toBe(DEFAULT_MIN_FREE_DISK_BYTES);
		expect(hasDiskFloor(limits)).toBe(true);
		// The three-key default shape is unchanged — desktop-node and the
		// capability-selection spec assert on it exhaustively.
		expect(clampResourceLimits(undefined)).toEqual(DEFAULT_RESOURCE_LIMITS);
	});

	it('keeps an explicit null — the operator switched the floor off', () => {
		const limits = clampResourceLimits({ minFreeDiskBytes: null });
		expect(limits.minFreeDiskBytes).toBeNull();
		expect(effectiveMinFreeDiskBytes(limits)).toBeNull();
		expect(hasDiskFloor(limits)).toBe(false);
	});

	it('clamps a number into the supported range', () => {
		expect(clampResourceLimits({ minFreeDiskBytes: 1 }).minFreeDiskBytes).toBe(MIN_MIN_FREE_DISK_BYTES);
		expect(clampResourceLimits({ minFreeDiskBytes: 2 ** 50 }).minFreeDiskBytes).toBe(MAX_MIN_FREE_DISK_BYTES);
		expect(clampResourceLimits({ minFreeDiskBytes: 4 * GIB }).minFreeDiskBytes).toBe(4 * GIB);
	});

	it('drops nonsense so the DEFAULT floor applies — never "off"', () => {
		const limits = clampResourceLimits({ minFreeDiskBytes: Number.NaN });
		expect('minFreeDiskBytes' in limits).toBe(false);
		expect(effectiveMinFreeDiskBytes(limits)).toBe(DEFAULT_MIN_FREE_DISK_BYTES);
	});
});

describe('admitByResourceLimits — disk floor', () => {
	const noCeilings = { maxCpuPercent: null, maxMemoryMb: null };

	it('refuses below the floor, naming the reading and the floor', () => {
		const decision = admitByResourceLimits(
			{ ...noCeilings, minFreeDiskBytes: 2 * GIB },
			sample({ diskFreeBytes: 38 * MIB })
		);
		expect(decision.admit).toBe(false);
		expect(decision.dimension).toBe('disk');
		expect(decision.reason).toContain('38 MiB');
		expect(decision.reason).toContain('2.0 GiB');
	});

	it('admits at or above the floor', () => {
		expect(
			admitByResourceLimits({ ...noCeilings, minFreeDiskBytes: 2 * GIB }, sample({ diskFreeBytes: 2 * GIB }))
		).toEqual(ADMIT);
		expect(
			admitByResourceLimits({ ...noCeilings, minFreeDiskBytes: 2 * GIB }, sample({ diskFreeBytes: 500 * GIB }))
		).toEqual(ADMIT);
	});

	it('applies the default floor when the key is absent', () => {
		const decision = admitByResourceLimits(noCeilings, sample({ diskFreeBytes: 100 * MIB }));
		expect(decision.admit).toBe(false);
		expect(decision.reason).toContain(formatBytes(DEFAULT_MIN_FREE_DISK_BYTES));
	});

	it('admits when the disk was never sampled — a dimension nobody asked about cannot refuse', () => {
		// `checkResourceAdmission` only sets `diskFreeBytes` when a floor is
		// in force AND a probe is wired, so an ABSENT field means "not
		// measured on this poll" and must stay silent.
		expect(admitByResourceLimits({ ...noCeilings, minFreeDiskBytes: 2 * GIB }, sample())).toEqual(ADMIT);
		expect(judgeDiskFloor({ minFreeDiskBytes: 2 * GIB }, sample())).toBeNull();
	});

	it('REFUSES a reading that was taken and came back unreadable (review AO-11)', () => {
		// This assertion is the reverse of the one it replaces, and the
		// reversal is the fix. The old contract — "null admits, an
		// unreadable volume must not idle the node" — did not compose with
		// `assertWorkspaceDiskHeadroom`, which REFUSES the identical null
		// from the identical probe because it is the last gate before a
		// model's whole budget lands on the volume. While this gate
		// admitted, a host whose `statfs` cannot answer (a persistent
		// condition per `createDiskProbe`) leased every job it was offered
		// and then declined it at provision time; the deferral reports
		// nothing, so the claim lapsed over the full lease TTL and burned
		// one of the job's attempts, until the platform failed it with a
		// message that never mentioned disk. Refusing here throttles the
		// node instead, with a reason an operator can read.
		for (const free of [null, Number.NaN]) {
			const decision = admitByResourceLimits(
				{ ...noCeilings, minFreeDiskBytes: 2 * GIB },
				sample({ diskFreeBytes: free })
			);
			expect(decision.admit).toBe(false);
			expect(decision.dimension).toBe('disk');
			expect(decision.reason).toContain('could not be measured');
		}
		// Still silent when the operator switched the floor off.
		expect(
			admitByResourceLimits({ ...noCeilings, minFreeDiskBytes: null }, sample({ diskFreeBytes: null }))
		).toEqual(ADMIT);
	});

	it('judgeDiskFloor answers about DISK alone, whatever CPU and memory did (review AO-7)', () => {
		// `admitByResourceLimits` reports only the first refusing dimension,
		// so the worker loop's refuse/resume latch cannot be driven from it:
		// a CPU refusal would read as "the disk recovered".
		const limits = { maxCpuPercent: 50, maxMemoryMb: null, minFreeDiskBytes: 2 * GIB };
		const bothOver = sample({ cpuPercent: 90, diskFreeBytes: 190 * MIB });
		expect(admitByResourceLimits(limits, bothOver).dimension).toBe('cpu');
		expect(judgeDiskFloor(limits, bothOver)?.reason).toContain('below the 2.0 GiB floor');
		expect(judgeDiskFloor(limits, sample({ cpuPercent: 90, diskFreeBytes: 10 * GIB }))).toBeNull();
	});

	it('never blocks when the floor is switched off', () => {
		expect(admitByResourceLimits({ ...noCeilings, minFreeDiskBytes: null }, sample({ diskFreeBytes: 0 }))).toEqual(
			ADMIT
		);
	});

	it('reports the first dimension hit, CPU and memory before disk', () => {
		const decision = admitByResourceLimits(
			{ maxCpuPercent: 50, maxMemoryMb: null, minFreeDiskBytes: 2 * GIB },
			sample({ cpuPercent: 90, diskFreeBytes: 0 })
		);
		expect(decision.dimension).toBe('cpu');
	});

	it('formats bytes in binary units and LABELS them binary (review AO-14)', () => {
		// It divided by 1024 and printed "MB"/"KB", so one refusal line read
		// `524 MB free ... below the 2.0 GiB floor` — two unit systems in one
		// sentence, only one of them named correctly. The Fleet drawer is
		// deliberately decimal (it agrees with Explorer/Finder); the two only
		// reconcile if each says which it is.
		expect(formatBytes(38 * MIB)).toBe('38 MiB');
		expect(formatBytes(2 * GIB)).toBe('2.0 GiB');
		expect(formatBytes(1_536)).toBe('2 KiB');
		expect(formatBytes(-1)).toBe('unknown');
	});
});

describe('WorkerLoop honours the disk floor', () => {
	it('refuses to lease below the floor, says why, and resumes once space is freed', async () => {
		const client = recordingClient([[], []]);
		const scheduler = controllableScheduler();
		let free = 100 * MIB;
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 2 }),
			diskProbe: { freeBytes: () => free },
			workspacePath: process.cwd()
		});

		await loop.start();

		expect(client.leaseRequests).toHaveLength(0);
		expect(loop.getState().state).toBe('throttled');
		expect(loop.getState().throttleReason).toContain('floor');

		free = 10 * GIB;
		scheduler.runNext();
		await vi.waitFor(() => expect(client.leaseRequests.length).toBe(1));
		expect(loop.getState().throttleReason).toBeNull();

		await loop.stop();
	});

	it('takes the reading on the workspace root, not on the service cwd', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const probed: string[] = [];
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 1 }),
			diskProbe: {
				freeBytes: (path) => {
					probed.push(path);
					return 10 * GIB;
				}
			},
			workspacePath: process.cwd()
		});

		await loop.start();
		expect(probed).toEqual([process.cwd()]);
		expect(client.leaseRequests).toHaveLength(1);
		await loop.stop();
	});

	it('refuses to lease when the disk probe throws or answers null (review AO-11)', async () => {
		// Composition, not preference. The provisioner's
		// `assertWorkspaceDiskHeadroom` refuses this same unreadable reading;
		// if the lease gate admitted it, the node would take every job and
		// then defer it, silently spending one attempt per lapsed lease until
		// the platform failed the job for "attempt budget exhausted" — a
		// message that never mentions disk. Throttling here says why.
		for (const freeBytes of [
			() => {
				throw new Error('statfs unsupported');
			},
			() => null
		]) {
			const client = recordingClient([[]]);
			const scheduler = controllableScheduler();
			const loop = new WorkerLoop({
				client,
				scheduler,
				limits: clampResourceLimits({ maxConcurrentJobs: 1 }),
				diskProbe: { freeBytes },
				workspacePath: process.cwd()
			});

			await loop.start();
			expect(client.leaseRequests).toHaveLength(0);
			expect(loop.getState().state).toBe('throttled');
			expect(loop.getState().throttleReason).toContain('could not be measured');
			await loop.stop();
		}
	});

	it('the two disk gates agree on an unreadable volume, so nothing loops (review AO-11)', async () => {
		// The composition itself, asserted in one place: ONE probe, both
		// gates. Neither test on its own could see the defect — the lease
		// side only checked that admission succeeded, the provision side only
		// that the provisioner threw.
		const probe = { freeBytes: () => null };
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 1 }),
			diskProbe: probe,
			workspacePath: process.cwd()
		});
		await loop.start();
		// The lease never happens, so the provisioner is never reached...
		expect(client.leaseRequests).toHaveLength(0);
		await loop.stop();
		// ...and had it been reached, it would have refused the same reading.
		await expect(assertWorkspaceDiskHeadroom(probe, 2 * GIB, process.cwd())).rejects.toMatchObject({
			code: 'disk-low'
		});
	});

	it('does not claim the volume recovered when CPU refuses first (review AO-7)', async () => {
		// `admitByResourceLimits` returns only the FIRST refusing dimension.
		// Driving the latch from it logged "Workspace volume is back above
		// the disk floor — leasing resumes" the moment CPU also went over,
		// about a machine still at 190 MB and still leasing nothing; when CPU
		// dropped the warning re-fired, so a permanently full disk produced
		// an alternating refuse/resume log.
		const lines: string[] = [];
		const logger = {
			info: (message: string) => lines.push(`info ${message}`),
			warn: (message: string) => lines.push(`warn ${message}`),
			error: (message: string) => lines.push(`error ${message}`),
			debug: () => undefined,
			protect: () => undefined,
			redact: (value: string) => value
		};
		const client = recordingClient([[], []]);
		const scheduler = controllableScheduler();
		let cpuPercent = 40;
		const loop = new WorkerLoop({
			client,
			scheduler,
			logger: logger as never,
			limits: clampResourceLimits({ maxConcurrentJobs: 1, maxCpuPercent: 80 }),
			resourceProbe: { sample: () => sample({ cpuPercent }) },
			diskProbe: { freeBytes: () => 190 * MIB },
			workspacePath: process.cwd()
		});

		await loop.start();
		expect(lines.filter((line) => line.startsWith('warn Refusing to lease work'))).toHaveLength(1);

		// Same poll cadence, now with CPU over the ceiling as well.
		cpuPercent = 85;
		scheduler.runNext();
		await vi.waitFor(() => expect(loop.getState().throttleReason).toContain('CPU'));
		expect(lines.some((line) => line.includes('back above the disk floor'))).toBe(false);
		await loop.stop();
	});

	it('takes no reading at all when the floor is switched off', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const probe = { freeBytes: vi.fn(() => 0) };
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 1, minFreeDiskBytes: null }),
			diskProbe: probe,
			workspacePath: process.cwd()
		});

		await loop.start();
		expect(probe.freeBytes).not.toHaveBeenCalled();
		expect(client.leaseRequests).toHaveLength(1);
		await loop.stop();
	});

	it('still skips the host sampler when no CPU/memory ceiling is set, even while sampling the disk', async () => {
		const client = recordingClient([[]]);
		const scheduler = controllableScheduler();
		const hostProbe = { sample: vi.fn(() => sample()) };
		const diskProbe = { freeBytes: vi.fn(() => 10 * GIB) };
		const loop = new WorkerLoop({
			client,
			scheduler,
			limits: clampResourceLimits({ maxConcurrentJobs: 2 }),
			resourceProbe: hostProbe,
			diskProbe,
			workspacePath: process.cwd()
		});

		await loop.start();
		expect(hostProbe.sample).not.toHaveBeenCalled();
		expect(diskProbe.freeBytes).toHaveBeenCalledOnce();
		await loop.stop();
	});
});
