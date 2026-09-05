import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetJobView } from '@ever-works/contracts';
import { FLEET_JOB_LEASE_LAPSED_WHILE_SUSPENDED_REASON, FLEET_JOB_STALE_LEASE_REASON } from '@ever-works/contracts';
import { execFileWithVerifiedCancellation } from '@ever-works/local-workspace-plugin';
import {
	isSuspendGap,
	LEASE_TERMINATION_SAFETY_MS,
	nextBackoffMs,
	PUBLISH_FENCE_MARGIN_MS,
	SUSPEND_GAP_THRESHOLD_MS,
	WorkerLoop,
	type JobLeaseCapableClient,
	type JobLeaseHandle
} from './worker-loop';
import type { Scheduler } from './heartbeat';
import { runAgentTaskJob } from './executors/agent-task';
import { terminateNodeProcessTree } from './executors/acceptance-checks';

/**
 * The node worker host.
 *
 * The behaviours pinned here are the ones that decide whether it is safe
 * to run a stranger's commands on somebody's laptop: an unknown job kind
 * is REFUSED rather than dropped, an outage backs off instead of hot
 * looping, and Ctrl-C mid-build reports the verdict rather than
 * abandoning the work to a lease expiry.
 *
 * The scheduler is injected so the whole state machine runs in zero wall
 * time and the delay SEQUENCE is directly observable.
 */

/** Records requested delays and fires callbacks on demand. */
function controllableScheduler(): Scheduler & {
	delays: number[];
	runNext(): void;
	/** Fire the oldest pending timer that was armed with exactly `ms`; false when there is none. */
	runDelay(ms: number): boolean;
	pending: number;
} {
	const queue: Array<{ id: number; ms: number; callback: () => void }> = [];
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
			queue.push({ id, ms, callback });
			return id;
		},
		clearTimeout(handle: unknown): void {
			const index = queue.findIndex((entry) => entry.id === handle);
			if (index >= 0) queue.splice(index, 1);
		},
		runNext(): void {
			const entry = queue.shift();
			entry?.callback();
		},
		runDelay(ms: number): boolean {
			const index = queue.findIndex((entry) => entry.ms === ms);
			if (index < 0) return false;
			const [entry] = queue.splice(index, 1);
			entry!.callback();
			return true;
		}
	};
}

/** A deterministic wall clock plus deadline-ordered timer queue. */
function clockScheduler(startMs: number): Scheduler & {
	now(): number;
	nextDueAt(): number | null;
	advanceTo(epochMs: number): void;
} {
	const queue: Array<{ id: number; dueAt: number; callback: () => void }> = [];
	let current = startMs;
	let nextId = 1;
	return {
		now: () => current,
		nextDueAt: () =>
			queue.reduce<number | null>(
				(next, entry) => (next === null ? entry.dueAt : Math.min(next, entry.dueAt)),
				null
			),
		setTimeout(callback: () => void, ms: number): unknown {
			const id = nextId++;
			queue.push({ id, dueAt: current + ms, callback });
			return id;
		},
		clearTimeout(handle: unknown): void {
			const index = queue.findIndex((entry) => entry.id === handle);
			if (index >= 0) queue.splice(index, 1);
		},
		advanceTo(epochMs: number): void {
			if (epochMs < current) throw new Error('clock cannot run backwards');
			for (;;) {
				const next = queue
					.filter((entry) => entry.dueAt <= epochMs)
					.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
				if (!next) break;
				queue.splice(queue.indexOf(next), 1);
				current = next.dueAt;
				next.callback();
			}
			current = epochMs;
		}
	};
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, resolve, reject };
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

/** A client that hands out a fixed script of lease results. */
function scriptedClient(script: Array<FleetJobView[] | Error>): JobLeaseCapableClient & {
	complete: ReturnType<typeof vi.fn>;
	heartbeat: ReturnType<typeof vi.fn>;
	leaseCalls: number;
} {
	let index = 0;
	const complete = vi.fn(async () => true);
	const heartbeat = vi.fn(async () =>
		job({ status: 'running', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() })
	);
	const client = {
		complete,
		heartbeat,
		get leaseCalls(): number {
			return index;
		},
		lease: async () => {
			const next = script[Math.min(index, script.length - 1)];
			index += 1;
			if (next instanceof Error) throw next;
			return next;
		}
	};
	return client as never;
}

describe('nextBackoffMs', () => {
	it('doubles from the base delay and stops at the ceiling', () => {
		expect(nextBackoffMs(1)).toBe(1_000);
		expect(nextBackoffMs(2)).toBe(2_000);
		expect(nextBackoffMs(3)).toBe(4_000);
		expect(nextBackoffMs(50)).toBe(60_000);
	});

	it('collapses nonsense input to the base delay rather than throwing', () => {
		expect(nextBackoffMs(0)).toBe(1_000);
		expect(nextBackoffMs(-5)).toBe(1_000);
		expect(nextBackoffMs(Number.NaN)).toBe(1_000);
	});
});

describe('WorkerLoop', () => {
	it('leases, executes and reports the executor result', async () => {
		const client = scriptedClient([[job()], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });
		loop.register('acceptance-checks', async () => ({ gateStatus: 'green' }));

		await loop.start();
		// Wait on the COUNTER, not on the call: the tally is written after
		// the report resolves, so asserting on the call alone races it.
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));

		expect(client.complete).toHaveBeenCalledWith('job-1', {
			success: true,
			result: { gateStatus: 'green' }
		});
		await loop.stop();
	});

	it('reports a FAILURE for a kind it cannot run, naming the kind', async () => {
		const client = scriptedClient([[job({ kind: 'future-kind' as never })], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });
		// Deliberately no executor registered.

		await loop.start();
		await vi.waitFor(() => expect(client.complete).toHaveBeenCalled());

		expect(client.complete).toHaveBeenCalledWith(
			'job-1',
			expect.objectContaining({
				success: false,
				error: expect.stringContaining('future-kind')
			})
		);
		await loop.stop();
	});

	it('reports an executor throw as a job failure instead of swallowing it', async () => {
		const client = scriptedClient([[job()], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });
		loop.register('acceptance-checks', async () => {
			throw new Error('workspace missing');
		});

		await loop.start();
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));

		expect(client.complete).toHaveBeenCalledWith('job-1', {
			success: false,
			error: 'workspace missing'
		});
		await loop.stop();
	});

	it('aborts a production agent-task command after lease loss and never reports or counts success', async () => {
		const workspacePath = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
		const leasedJob = job({
			kind: 'agent-task',
			payload: {
				taskId: 'task-lease-loss',
				workspacePath,
				steps: [{ id: 'blocking', command: 'blocking', timeoutSec: 0.05 }]
			}
		});
		const client = scriptedClient([[leasedJob], []]);
		client.heartbeat.mockResolvedValue(null);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler, leaseTtlSec: 30 });
		let spawned = false;
		const terminateProcessTree = vi.fn(async (child: ChildProcess) => {
			child.kill('SIGKILL');
		});
		const spawnFn = (() => {
			spawned = true;
			const handlers = new Map<string, (arg?: unknown) => void>();
			return {
				pid: 4343,
				stdout: { on: () => undefined, destroy: () => undefined },
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => handlers.set(event, handler),
				kill: () => {
					queueMicrotask(() => {
						handlers.get('exit')?.(null);
						handlers.get('close')?.(null);
					});
				}
			};
		}) as never;
		loop.register('agent-task', (leased, signal) =>
			runAgentTaskJob(leased, { directoryExists: () => true, spawnFn, terminateProcessTree }, signal)
		);

		await loop.start();
		await vi.waitFor(() => expect(spawned).toBe(true));
		scheduler.runNext();
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));

		expect(client.heartbeat).toHaveBeenCalledWith('job-1', 30);
		expect(terminateProcessTree).toHaveBeenCalledOnce();
		expect(client.complete).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ success: true }));
		expect(loop.getState().completed).toBe(0);
		expect(loop.cancelJob('job-1')).toBe(false);
		await loop.stop();
	});

	it('aborts at the last confirmed lease deadline after repeated heartbeat transport failures', async () => {
		const startedAt = Date.parse('2026-08-22T21:00:00.000Z');
		const scheduler = clockScheduler(startedAt);
		const workspacePath = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
		const leasedJob = job({
			kind: 'agent-task',
			leaseExpiresAt: new Date(startedAt + 30_000).toISOString(),
			payload: {
				taskId: 'task-heartbeat-deadline',
				workspacePath,
				steps: [{ id: 'blocking', command: 'blocking' }]
			}
		});
		const client = scriptedClient([[leasedJob], []]);
		client.heartbeat.mockRejectedValue(new Error('transport offline'));
		let spawned = false;
		const terminateProcessTree = vi.fn(async (child: ChildProcess) => {
			child.kill('SIGKILL');
		});
		const spawnFn = (() => {
			spawned = true;
			const handlers = new Map<string, (arg?: unknown) => void>();
			return {
				pid: 4545,
				stdout: { on: () => undefined, destroy: () => undefined },
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => handlers.set(event, handler),
				kill: () => {
					queueMicrotask(() => {
						handlers.get('exit')?.(null);
						handlers.get('close')?.(null);
					});
				}
			};
		}) as never;
		const loop = new WorkerLoop({
			client,
			scheduler,
			leaseTtlSec: 30,
			idlePollMs: 60_000,
			now: scheduler.now
		} as never);
		loop.register('agent-task', (leased, signal) =>
			runAgentTaskJob(leased, { directoryExists: () => true, spawnFn, terminateProcessTree }, signal)
		);

		await loop.start();
		await vi.waitFor(() => expect(spawned).toBe(true));
		scheduler.advanceTo(startedAt + 10_000);
		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1));
		await expect.poll(() => scheduler.nextDueAt()).toBe(startedAt + 20_000);
		expect(terminateProcessTree).not.toHaveBeenCalled();
		scheduler.advanceTo(startedAt + 20_000);
		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(2));
		await expect.poll(() => scheduler.nextDueAt()).toBe(startedAt + 22_000);
		expect(terminateProcessTree).not.toHaveBeenCalled();
		scheduler.advanceTo(startedAt + 21_999);
		expect(terminateProcessTree).not.toHaveBeenCalled();

		scheduler.advanceTo(startedAt + 22_000);
		await vi.waitFor(() => expect(terminateProcessTree).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(client.heartbeat).toHaveBeenCalledTimes(2);
		expect(client.complete).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ success: true }));
		expect(loop.getState().completed).toBe(0);
		await loop.stop();
	});

	it('uses the exact renewed server lease expiry and retains it across later transport failures', async () => {
		const startedAt = Date.parse('2026-08-22T22:00:00.000Z');
		const scheduler = clockScheduler(startedAt);
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 30_000).toISOString() });
		const client = scriptedClient([[leasedJob], []]);
		client.heartbeat
			.mockResolvedValueOnce(
				job({ status: 'running', leaseExpiresAt: new Date(startedAt + 55_000).toISOString() })
			)
			.mockRejectedValue(new Error('transport offline'));
		const executor = deferred<Record<string, unknown>>();
		const loop = new WorkerLoop({
			client,
			scheduler,
			leaseTtlSec: 30,
			idlePollMs: 60_000,
			now: scheduler.now
		});
		loop.register('acceptance-checks', () => executor.promise);

		await loop.start();
		scheduler.advanceTo(startedAt + 10_000);
		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1));
		await expect.poll(() => scheduler.nextDueAt()).toBe(startedAt + 20_000);
		for (const elapsed of [20_000, 30_000, 40_000]) {
			scheduler.advanceTo(startedAt + elapsed);
			await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(elapsed / 10_000));
			await expect
				.poll(() => scheduler.nextDueAt())
				.toBe(startedAt + (elapsed === 40_000 ? 47_000 : elapsed + 10_000));
		}
		expect(loop.getState().failed).toBe(0);
		scheduler.advanceTo(startedAt + 46_999);
		expect(loop.getState().failed).toBe(0);
		scheduler.advanceTo(startedAt + 47_000);
		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(loop.getState().completed).toBe(0);
		await loop.stop();
	});

	it('hands the executor a lease deadline that tracks renewals rather than the value the job arrived with', async () => {
		const startedAt = Date.parse('2026-09-04T12:00:00.000Z');
		const scheduler = clockScheduler(startedAt);
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 30_000).toISOString() });
		const client = scriptedClient([[leasedJob], []]);
		// The platform grants exactly the TTL the node asked for, which is
		// what `clampLeaseTtlSec` on both ends guarantees.
		client.heartbeat.mockResolvedValue(
			job({ status: 'running', leaseExpiresAt: new Date(startedAt + 40_000).toISOString() })
		);
		const executor = deferred<Record<string, unknown>>();
		let lease: JobLeaseHandle | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			leaseTtlSec: 30,
			idlePollMs: 60_000,
			now: scheduler.now,
			monotonicNow: scheduler.now
		});
		loop.register('acceptance-checks', (_job, _signal, handle) => {
			lease = handle;
			return executor.promise;
		});

		await loop.start();
		await vi.waitFor(() => expect(lease).toBeDefined());
		// Straight off the wire before any renewal…
		expect(lease?.deadlineAt()).toBe(startedAt + 30_000);
		expect(lease?.publishMarginMs).toBe(10_000);

		scheduler.advanceTo(startedAt + 10_000);
		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1));
		// …and the renewal moves it. A publish fence wired to the value the
		// job was LEASED with would refuse every long run: a 1200s model step
		// outlives four renewals of a 300s lease before finalize is reached.
		await vi.waitFor(() => expect(lease?.deadlineAt()).toBe(startedAt + 40_000));

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));
		await loop.stop();
	});

	it('caps the lease against a monotonic budget so a wall clock stepped backwards cannot extend it', async () => {
		const startedAt = Date.parse('2026-09-04T15:00:00.000Z');
		const scheduler = controllableScheduler();
		// Two clocks that disagree: the wall clock is what a w32time resync
		// steps after a wake-up, the monotonic one is what it cannot touch.
		let wall = startedAt;
		let monotonic = 0;
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 30_000).toISOString() });
		const client = scriptedClient([[leasedJob], []]);
		const executor = deferred<Record<string, unknown>>();
		let lease: JobLeaseHandle | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			leaseTtlSec: 30,
			idlePollMs: 60_000,
			now: () => wall,
			monotonicNow: () => monotonic
		});
		loop.register('acceptance-checks', (_job, _signal, handle) => {
			lease = handle;
			return executor.promise;
		});

		await loop.start();
		await vi.waitFor(() => expect(lease).toBeDefined());
		expect(lease?.deadlineAt()).toBe(startedAt + 30_000);

		// Twenty real seconds pass, and the wake-up resync then steps the wall
		// clock a minute BACKWARDS. Read on the wall clock alone the claim has
		// grown from 30s to 70s — the fence would wave through a publish the
		// platform reclaimed 50 seconds ago.
		monotonic += 20_000;
		wall = startedAt + 20_000 - 60_000;
		expect(lease?.deadlineAt()).toBe(wall + 10_000);

		// And it still expires on time in monotonic terms.
		monotonic += 10_000;
		expect(lease?.deadlineAt()).toBe(wall);

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));
		await loop.stop();
	});

	it('stops a job whose claim lapsed while the machine slept, instead of re-arming at zero delay', async () => {
		const startedAt = Date.parse('2026-09-04T16:00:00.000Z');
		const scheduler = controllableScheduler();
		let wall = startedAt;
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 30_000).toISOString() });
		const client = scriptedClient([[leasedJob], []]);
		const executor = deferred<Record<string, unknown>>();
		let jobSignal: AbortSignal | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			leaseTtlSec: 30,
			idlePollMs: 60_000,
			now: () => wall,
			monotonicNow: () => wall
		});
		loop.register('acceptance-checks', (_job, signal) => {
			jobSignal = signal;
			return executor.promise;
		});

		await loop.start();
		await vi.waitFor(() => expect(jobSignal).toBeDefined());
		// The keep-alive armed at a third of the TTL, as always.
		expect(scheduler.delays).toContain(10_000);

		// The lid closes for an hour. `Date.now()` jumps across the suspend;
		// the timer that was going to abort this job at +22s does not, because
		// its base clock does not advance through S3/S4 — it is still counting
		// down AWAKE seconds. So the wall clock has to be the authority.
		wall = startedAt + 3_600_000;
		const armedBeforeWake = scheduler.delays.length;
		scheduler.runNext();

		expect(client.heartbeat).not.toHaveBeenCalled();
		expect(jobSignal?.aborted).toBe(true);
		// And nothing re-armed. The old path computed `min(everyMs, remaining)`
		// with `remaining` collapsed to 0 and beat a dead endpoint as fast as
		// fetch could reject, for the whole rest of the run.
		expect(scheduler.delays.slice(armedBeforeWake)).toEqual([]);

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		await loop.stop();
	});

	it('collapses the claim when a publish-time confirmation is refused', async () => {
		const startedAt = Date.parse('2026-09-04T17:00:00.000Z');
		const scheduler = controllableScheduler();
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 300_000).toISOString() });
		const client = scriptedClient([[leasedJob], []]);
		client.heartbeat.mockResolvedValue(null);
		let confirmed: number | undefined;
		let jobSignal: AbortSignal | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			idlePollMs: 60_000,
			now: () => startedAt,
			monotonicNow: () => startedAt
		});
		loop.register('acceptance-checks', async (_job, signal, handle) => {
			jobSignal = signal;
			confirmed = await handle?.confirmDeadline();
			return { ok: true };
		});

		await loop.start();
		await vi.waitFor(() => expect(confirmed).toBeDefined());

		// The deadline on the wire said five more minutes. The platform says
		// the claim is not ours, which is what a drained or reassigned node
		// hears while its own deadline still looks healthy — so the claim
		// collapses to NOW and nothing may be published against it.
		expect(confirmed).toBe(startedAt);
		expect(jobSignal?.aborted).toBe(true);
		expect(client.complete).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ success: true }));
		await loop.stop();
	});

	it('keeps the last confirmed claim when a publish-time confirmation cannot reach the platform', async () => {
		const startedAt = Date.parse('2026-09-04T18:00:00.000Z');
		const scheduler = controllableScheduler();
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 300_000).toISOString() });
		const client = scriptedClient([[leasedJob], []]);
		client.heartbeat.mockRejectedValue(new Error('transport offline'));
		let confirmed: number | undefined;
		let jobSignal: AbortSignal | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			idlePollMs: 60_000,
			now: () => startedAt,
			monotonicNow: () => startedAt
		});
		loop.register('acceptance-checks', async (_job, signal, handle) => {
			jobSignal = signal;
			confirmed = await handle?.confirmDeadline();
			return { ok: true };
		});

		await loop.start();
		await vi.waitFor(() => expect(confirmed).toBeDefined());

		// A partition proves nothing about ownership, so the run keeps the
		// last deadline the platform actually confirmed and lets the local
		// fence decide. Aborting here instead would throw away every run that
		// happened to finalize during a ninety-second Wi-Fi drop.
		expect(confirmed).toBe(startedAt + 300_000);
		expect(jobSignal?.aborted).toBe(false);
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));
		await loop.stop();
	});

	it('reports nothing at all when an executor hands its job back unsettled', async () => {
		const client = scriptedClient([[job()], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });
		loop.register('acceptance-checks', async (_job, _signal, handle) => {
			handle?.defer('publish withheld: the lease on this work expired 12s ago');
			return { gateStatus: 'green' };
		});

		await loop.start();
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));

		// Neither `success: true` (which writes `done` and strands the
		// agent's commit on this machine) nor `success: false` (which writes
		// `failed` and never retries). The claim lapses and the platform
		// re-offers the job inside its attempt budget.
		expect(client.complete).not.toHaveBeenCalled();
		expect(loop.getState().completed).toBe(0);
		expect(loop.getState().lastError).toContain('publish withheld');
		await loop.stop();
	});

	it('clamps the publish margin against the lease so a floor-length TTL can still publish at all', () => {
		const client = scriptedClient([[]]);
		// Default 300s lease: the full push budget fits comfortably.
		expect(new WorkerLoop({ client }).publishFenceMargin).toBe(PUBLISH_FENCE_MARGIN_MS);
		// 30s floor: a flat 60s margin would refuse every push forever, which
		// trades a rare double-write for a permanent outage.
		expect(new WorkerLoop({ client, leaseTtlSec: 30 }).publishFenceMargin).toBe(10_000);
		// An operator on a slow uplink can buy a bigger push budget, still
		// bounded by a third of the lease…
		expect(new WorkerLoop({ client, publishFenceMarginMs: 90_000 }).publishFenceMargin).toBe(90_000);
		expect(new WorkerLoop({ client, publishFenceMarginMs: 300_000 }).publishFenceMargin).toBe(100_000);
		// …and cannot ask for less than the termination budget, below which
		// the abort itself would land after the platform may reclaim.
		expect(new WorkerLoop({ client, leaseTtlSec: 30, publishFenceMarginMs: 1_000 }).publishFenceMargin).toBe(
			LEASE_TERMINATION_SAFETY_MS
		);
	});

	it('counts one accepted success when a terminal heartbeat response races its completion response', async () => {
		const client = scriptedClient([[job()], []]);
		const successResponse = deferred<boolean>();
		const heartbeatResponse = deferred<FleetJobView | null>();
		client.complete.mockImplementationOnce(() => successResponse.promise).mockResolvedValue(true);
		client.heartbeat.mockImplementationOnce(() => heartbeatResponse.promise);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler, leaseTtlSec: 30 });
		loop.register('acceptance-checks', async () => ({ gateStatus: 'green' }));

		await loop.start();
		await vi.waitFor(() => expect(client.complete).toHaveBeenCalledTimes(1));
		scheduler.runNext();
		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1));

		// The server processed success, while a later heartbeat's terminal
		// response reached the client first. Accepted terminal state wins.
		heartbeatResponse.resolve(null);
		successResponse.resolve(true);
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));

		expect(client.complete).toHaveBeenCalledTimes(1);
		expect(client.complete).toHaveBeenCalledWith('job-1', {
			success: true,
			result: { gateStatus: 'green' }
		});
		expect(loop.getState().failed).toBe(0);
		await loop.stop();
	});

	it('quarantines the worker and leases nothing else when process-tree termination cannot be proven', async () => {
		const ownedRoot = mkdtempSync(join(tmpdir(), 'ew-worker-unsafe-'));
		const readyPath = join(ownedRoot, 'ready.txt');
		const scriptPath = join(ownedRoot, 'blocking.cjs');
		let capturedChild: ChildProcess | undefined;
		let loop: WorkerLoop | undefined;
		try {
			writeFileSync(
				scriptPath,
				`require('node:fs').writeFileSync(${JSON.stringify(readyPath)},'ready');setInterval(()=>{},1000);`
			);
			const leasedJob = job({
				kind: 'agent-task',
				payload: {
					taskId: 'task-quarantine',
					workspacePath: ownedRoot,
					steps: [{ id: 'blocking', command: `"${process.execPath}" "${scriptPath}"` }]
				}
			});
			const client = scriptedClient([[leasedJob], []]);
			const scheduler = controllableScheduler();
			loop = new WorkerLoop({ client, scheduler, leaseTtlSec: 30 });
			loop.register('agent-task', (leased, signal) =>
				runAgentTaskJob(
					leased,
					{
						directoryExists: () => true,
						terminateProcessTree: async (child) => {
							capturedChild = child;
							throw Object.assign(new Error('tree kill permission denied'), { code: 'EPERM' });
						}
					},
					signal
				)
			);

			await loop.start();
			await expect.poll(() => existsSync(readyPath), { timeout: 2_500 }).toBe(true);
			expect(loop.cancelJob('job-1', 'operator cancellation')).toBe(true);
			await vi.waitFor(() => expect(loop?.getState().state).toBe('unsafe'));
			await vi.waitFor(() => expect(client.complete).toHaveBeenCalledTimes(1));
			expect(client.complete).toHaveBeenCalledWith(
				'job-1',
				expect.objectContaining({ success: false, error: expect.stringMatching(/could not be terminated/i) })
			);
			expect(capturedChild?.pid).toBeTypeOf('number');
			expect(() => process.kill(capturedChild!.pid!, 0)).not.toThrow();

			const leaseCallsAtQuarantine = client.leaseCalls;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				scheduler.runNext();
				await Promise.resolve();
			}
			expect(client.leaseCalls).toBe(leaseCallsAtQuarantine);
		} finally {
			if (capturedChild) {
				await terminateNodeProcessTree(capturedChild).catch(() => capturedChild?.kill('SIGKILL'));
			}
			if (loop) await loop.stop();
			await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
		}
	}, 10_000);

	it('starts quarantined after restart and does not lease until an operator explicitly clears persisted state', async () => {
		const client = scriptedClient([[job()]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client,
			scheduler,
			startUnsafe: { since: '2026-08-22T23:00:00.000Z', reason: 'unverified child process tree' }
		} as never);

		await loop.start();
		expect(loop.getState()).toMatchObject({
			state: 'unsafe',
			lastError: 'unverified child process tree'
		});
		expect(client.leaseCalls).toBe(0);
		await loop.stop();
	});

	it('remains fail-closed across reconstruction when config quarantine persistence rejects', async () => {
		let activeSession: string | null = null;
		const safetyGate = () => ({
			acquire: vi.fn(async () => {
				if (activeSession) {
					return {
						kind: 'blocked' as const,
						state: {
							since: '2026-08-22T23:45:00.000Z',
							reason: 'Previous worker session did not release its safety marker'
						}
					};
				}
				activeSession = 'session-first';
				return { kind: 'acquired' as const, sessionId: activeSession };
			}),
			release: vi.fn(async (sessionId: string) => {
				if (sessionId !== activeSession) throw new Error('session does not own marker');
				activeSession = null;
			}),
			inspect: vi.fn(async () => null),
			clear: vi.fn(async () => {
				activeSession = null;
			})
		});
		const firstClient = scriptedClient([[job()], []]);
		const persistUnsafe = vi.fn(async () => {
			throw new Error('config write rejected');
		});
		const first = new WorkerLoop({
			client: firstClient,
			scheduler: controllableScheduler(),
			safetyGate: safetyGate(),
			onUnsafe: persistUnsafe
		});
		first.register('acceptance-checks', async () => {
			const error = new Error('tree still alive');
			error.name = 'ProcessTreeTerminationError';
			throw error;
		});

		await first.start();
		await vi.waitFor(() => expect(first.getState().state).toBe('unsafe'));
		await vi.waitFor(() => expect(persistUnsafe).toHaveBeenCalledOnce());
		await first.stop();
		expect(activeSession).toBe('session-first');

		const reconstructedClient = scriptedClient([[job({ id: 'must-not-lease' })]]);
		const reconstructed = new WorkerLoop({
			client: reconstructedClient,
			scheduler: controllableScheduler(),
			safetyGate: safetyGate()
		});
		await reconstructed.start();

		expect(reconstructed.getState()).toMatchObject({
			state: 'unsafe',
			lastError: expect.stringMatching(/previous worker session/i)
		});
		expect(reconstructedClient.leaseCalls).toBe(0);
		await reconstructed.stop();
	});

	it('persists quarantine and rejects work returned by an already-outstanding lease request', async () => {
		const secondLease = deferred<FleetJobView[]>();
		let leaseCalls = 0;
		const complete = vi.fn(async () => true);
		const client: JobLeaseCapableClient = {
			heartbeat: vi.fn(async () =>
				job({ status: 'running', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() })
			),
			complete,
			lease: vi.fn(async () => {
				leaseCalls += 1;
				return leaseCalls === 1 ? [job({ id: 'job-original' })] : secondLease.promise;
			})
		};
		const scheduler = controllableScheduler();
		const persistUnsafe = vi.fn(async () => undefined);
		const original = deferred<Record<string, unknown>>();
		const executed: string[] = [];
		const loop = new WorkerLoop({
			client,
			scheduler,
			concurrency: 2,
			onUnsafe: persistUnsafe
		} as never);
		loop.register('acceptance-checks', async (leased) => {
			executed.push(leased.id);
			if (leased.id === 'job-original') return original.promise;
			return { shouldNotRun: true };
		});

		await loop.start();
		for (let index = 0; index < 4 && leaseCalls < 2; index += 1) scheduler.runNext();
		await vi.waitFor(() => expect(leaseCalls).toBe(2));
		const termination = new Error('tree still alive');
		termination.name = 'ProcessTreeTerminationError';
		original.reject(termination);
		await vi.waitFor(() => expect(loop.getState().state).toBe('unsafe'));
		await vi.waitFor(() => expect(persistUnsafe).toHaveBeenCalledOnce());

		secondLease.resolve([job({ id: 'job-pending' })]);
		await vi.waitFor(() =>
			expect(complete).toHaveBeenCalledWith(
				'job-pending',
				expect.objectContaining({ success: false, error: expect.stringMatching(/quarantined/i) })
			)
		);
		expect(executed).toEqual(['job-original']);
		const callsAtQuarantine = leaseCalls;
		for (let index = 0; index < 3; index += 1) scheduler.runNext();
		expect(leaseCalls).toBe(callsAtQuarantine);
		await loop.stop();
	});

	it('quarantines through the production agent-task path when Git helper termination is unproven', async () => {
		const leased = job({
			kind: 'agent-task',
			payload: {
				taskId: 'task-git-unsafe',
				workspace: {
					repositoryId: 'ever/repo',
					repoUrl: 'https://github.com/ever/repo.git',
					baseRef: 'develop',
					branch: 'task/git-unsafe-12345678'
				},
				steps: [{ id: 'run', command: 'never-started' }]
			}
		});
		const client = scriptedClient([[leased], []]);
		const persistUnsafe = vi.fn(async () => undefined);
		const loop = new WorkerLoop({ client, scheduler: controllableScheduler(), onUnsafe: persistUnsafe });
		loop.register('agent-task', (jobView, signal) =>
			runAgentTaskJob(
				jobView,
				{
					provisionWorkspace: async () => {
						const error = new Error('Git process tree could not be proven stopped');
						error.name = 'ProcessTreeTerminationError';
						throw error;
					}
				},
				signal
			)
		);

		await loop.start();
		await vi.waitFor(() => expect(loop.getState().state).toBe('unsafe'));
		expect(persistUnsafe).toHaveBeenCalledOnce();
		expect(client.complete).toHaveBeenCalledWith(
			leased.id,
			expect.objectContaining({ success: false, error: expect.stringMatching(/could not be proven stopped/i) })
		);
		await loop.stop();
	});

	it('quarantines through the production agent-task path when output overflow cannot prove helper-tree death', async () => {
		const ownedRoot = mkdtempSync(join(tmpdir(), 'ew-worker-overflow-'));
		const readyPath = join(ownedRoot, 'ready.txt');
		const scriptPath = join(ownedRoot, 'overflow.cjs');
		let capturedChild: ChildProcess | undefined;
		let terminationCalls = 0;
		let loop: WorkerLoop | undefined;
		try {
			writeFileSync(
				scriptPath,
				`require('node:fs').writeFileSync(${JSON.stringify(readyPath)},'ready');` +
					`process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000);`
			);
			const leased = job({
				kind: 'agent-task',
				payload: {
					taskId: 'task-git-overflow-unsafe',
					workspace: {
						repositoryId: 'ever/repo',
						repoUrl: 'https://github.com/ever/repo.git',
						baseRef: 'develop',
						branch: 'task/git-overflow-unsafe-12345678'
					},
					steps: [{ id: 'run', command: 'never-started' }]
				}
			});
			const client = scriptedClient([[leased], []]);
			const persistUnsafe = vi.fn(async () => undefined);
			loop = new WorkerLoop({ client, scheduler: controllableScheduler(), onUnsafe: persistUnsafe });
			loop.register('agent-task', (jobView, signal) =>
				runAgentTaskJob(
					jobView,
					{
						provisionWorkspace: async () => {
							await execFileWithVerifiedCancellation(process.execPath, [scriptPath], {
								signal,
								maxBuffer: 64,
								terminationTimeoutMs: 50,
								terminateProcessTree: async (child) => {
									capturedChild = child;
									terminationCalls += 1;
									if (terminationCalls === 1) {
										loop?.cancelJob(leased.id, 'operator abort during overflow');
										throw new Error('whole-tree verifier rejected');
									}
									child.kill('SIGKILL');
								}
							});
							throw new Error('unreachable after overflow');
						}
					},
					signal
				)
			);

			await loop.start();
			await expect.poll(() => existsSync(readyPath), { timeout: 2_500 }).toBe(true);
			await vi.waitFor(() => expect(loop?.getState().state).toBe('unsafe'));
			expect(persistUnsafe).toHaveBeenCalledOnce();
			expect(terminationCalls).toBe(1);
			expect(client.complete).toHaveBeenCalledWith(
				leased.id,
				expect.objectContaining({
					success: false,
					error: expect.stringMatching(
						/output exceeded.*operator abort during overflow.*could not be proven/i
					)
				})
			);
		} finally {
			if (capturedChild) {
				await terminateNodeProcessTree(capturedChild).catch(() => capturedChild?.kill('SIGKILL'));
			}
			if (loop) await loop.stop();
			await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
		}
	}, 10_000);

	it('survives an unreportable result — the lease expiry is the safety net', async () => {
		const client = scriptedClient([[job()], []]);
		client.complete.mockRejectedValue(new Error('network down'));
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });
		loop.register('acceptance-checks', async () => ({ ok: true }));

		await loop.start();
		await vi.waitFor(() => expect(client.complete).toHaveBeenCalled());
		// The loop is still alive and still scheduling polls.
		expect(loop.getState().state).not.toBe('stopped');
		await loop.stop();
	});

	it('backs off exponentially instead of hot-looping against a dead endpoint', async () => {
		const client = scriptedClient([new Error('API down')]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });

		await loop.start();
		// First failure scheduled the first backoff.
		expect(scheduler.delays.at(-1)).toBe(1_000);
		expect(loop.getState().state).toBe('retrying');

		scheduler.runNext();
		await vi.waitFor(() => expect(scheduler.delays.at(-1)).toBe(2_000));
		scheduler.runNext();
		await vi.waitFor(() => expect(scheduler.delays.at(-1)).toBe(4_000));

		expect(loop.getState().consecutiveFailures).toBe(3);
		await loop.stop();
	});

	it('marks a rejected credential as `unauthorized` so an operator can see it', async () => {
		const unauthorized = Object.assign(new Error('rejected'), { kind: 'unauthorized' });
		const client = scriptedClient([unauthorized]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });

		await loop.start();
		expect(loop.getState().state).toBe('unauthorized');
		// Still retrying, so a re-enabled node recovers without a restart.
		expect(scheduler.pending).toBeGreaterThan(0);
		await loop.stop();
	});

	it('sleeps the idle interval when the fleet has nothing queued', async () => {
		const client = scriptedClient([[]]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler, idlePollMs: 7_777 });

		await loop.start();
		expect(scheduler.delays.at(-1)).toBe(7_777);
		expect(loop.getState().state).toBe('idle');
		await loop.stop();
	});

	it('never leases beyond its concurrency cap', async () => {
		let requestedMax = -1;
		const client = {
			lease: vi.fn(async (request: { max?: number }) => {
				requestedMax = request.max ?? -1;
				return [];
			}),
			heartbeat: vi.fn(async () => true),
			complete: vi.fn(async () => true)
		} as unknown as JobLeaseCapableClient;
		const loop = new WorkerLoop({ client, scheduler: controllableScheduler(), concurrency: 3 });

		await loop.start();
		expect(requestedMax).toBe(3);
		await loop.stop();
	});

	it('waits for an in-flight job on shutdown so its verdict is reported', async () => {
		const client = scriptedClient([[job()], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });

		let releaseJob: () => void = () => undefined;
		const jobRunning = new Promise<void>((resolve) => {
			releaseJob = resolve;
		});
		let started = false;
		loop.register('acceptance-checks', async () => {
			started = true;
			await jobRunning;
			return { gateStatus: 'green' };
		});

		await loop.start();
		await vi.waitFor(() => expect(started).toBe(true));

		// Ctrl-C arrives mid-build.
		const stopping = loop.stop();
		// The job has NOT been abandoned — no verdict has been reported yet.
		expect(client.complete).not.toHaveBeenCalled();

		releaseJob();
		await stopping;

		// The drain waited, and the verdict reached the platform.
		expect(client.complete).toHaveBeenCalledWith('job-1', {
			success: true,
			result: { gateStatus: 'green' }
		});
		expect(loop.getState().state).toBe('stopped');
	});

	it('stops leasing the moment shutdown starts', async () => {
		const client = scriptedClient([[], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });

		await loop.start();
		const callsAtStop = client.leaseCalls;
		await loop.stop();

		// Any timer that was pending is cancelled — firing it must not
		// resurrect polling after a stop.
		scheduler.runNext();
		expect(client.leaseCalls).toBe(callsAtStop);
	});

	it('drains a scheduled lease poll before releasing its marker and refuses a job returned after stop', async () => {
		const secondLease = deferred<FleetJobView[]>();
		let leaseCalls = 0;
		const release = vi.fn(async () => undefined);
		const complete = vi.fn(async () => true);
		const client: JobLeaseCapableClient = {
			heartbeat: vi.fn(async () =>
				job({ status: 'running', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString() })
			),
			complete,
			lease: vi.fn(async () => {
				leaseCalls += 1;
				return leaseCalls === 1 ? [] : secondLease.promise;
			})
		};
		const scheduler = controllableScheduler();
		const executor = vi.fn(async () => ({ shouldNotRun: true }));
		const loop = new WorkerLoop({
			client,
			scheduler,
			safetyGate: {
				acquire: vi.fn(async () => ({ kind: 'acquired' as const, sessionId: 'session-stop-race' })),
				release,
				inspect: vi.fn(async () => null),
				clear: vi.fn(async () => undefined)
			}
		});
		loop.register('acceptance-checks', executor);

		await loop.start();
		scheduler.runNext();
		await vi.waitFor(() => expect(leaseCalls).toBe(2));
		const stopping = loop.stop();
		await Promise.resolve();
		await Promise.resolve();
		const releasesBeforePollSettled = release.mock.calls.length;

		secondLease.resolve([job({ id: 'job-returned-after-stop' })]);
		await stopping;
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

		expect(releasesBeforePollSettled).toBe(0);
		expect(executor).not.toHaveBeenCalled();
		expect(complete).toHaveBeenCalledWith(
			'job-returned-after-stop',
			expect.objectContaining({ success: false, error: expect.stringMatching(/stopped before execution/i) })
		);
		expect(release).toHaveBeenCalledOnce();
		expect(complete.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
	});

	it('retains the safety marker and returns from stop when an aborted lease poll never settles', async () => {
		let leaseCalls = 0;
		let observedSignal: AbortSignal | undefined;
		const release = vi.fn(async () => undefined);
		const client: JobLeaseCapableClient = {
			heartbeat: vi.fn(async () => null),
			complete: vi.fn(async () => true),
			lease: vi.fn(async (_request, signal) => {
				leaseCalls += 1;
				if (leaseCalls === 1) return [];
				observedSignal = signal;
				return new Promise<FleetJobView[]>(() => undefined);
			})
		};
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client,
			scheduler,
			leasePollDrainTimeoutMs: 25,
			safetyGate: {
				acquire: vi.fn(async () => ({ kind: 'acquired' as const, sessionId: 'session-hung-poll' })),
				release,
				inspect: vi.fn(async () => null),
				clear: vi.fn(async () => undefined)
			}
		});

		await loop.start();
		scheduler.runNext();
		await vi.waitFor(() => expect(leaseCalls).toBe(2));
		const stopping = loop.stop();
		await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
		scheduler.runNext();
		await stopping;

		expect(loop.getState()).toMatchObject({
			state: 'unsafe',
			lastError: expect.stringMatching(/lease poll.*did not settle/i)
		});
		expect(release).not.toHaveBeenCalled();
	});

	it('awaits a rejected scheduled lease poll before releasing its marker', async () => {
		const secondLease = deferred<FleetJobView[]>();
		let leaseCalls = 0;
		const release = vi.fn(async () => undefined);
		const client: JobLeaseCapableClient = {
			heartbeat: vi.fn(async () => null),
			complete: vi.fn(async () => true),
			lease: vi.fn(async () => {
				leaseCalls += 1;
				return leaseCalls === 1 ? [] : secondLease.promise;
			})
		};
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({
			client,
			scheduler,
			safetyGate: {
				acquire: vi.fn(async () => ({ kind: 'acquired' as const, sessionId: 'session-rejected-poll' })),
				release,
				inspect: vi.fn(async () => null),
				clear: vi.fn(async () => undefined)
			}
		});

		await loop.start();
		scheduler.runNext();
		await vi.waitFor(() => expect(leaseCalls).toBe(2));
		const stopping = loop.stop();
		await Promise.resolve();
		expect(release).not.toHaveBeenCalled();

		secondLease.reject(new Error('lease transport closed after abort'));
		await stopping;
		expect(release).toHaveBeenCalledOnce();
		expect(loop.getState().state).toBe('stopped');
	});

	it('is idempotent on stop', async () => {
		const client = scriptedClient([[]]);
		const loop = new WorkerLoop({ client, scheduler: controllableScheduler() });
		await loop.start();
		await Promise.all([loop.stop(), loop.stop()]);
		expect(loop.getState().state).toBe('stopped');
	});

	it('exposes the registered kinds so a node can report what it can run', () => {
		const client = scriptedClient([[]]);
		const loop = new WorkerLoop({ client, scheduler: controllableScheduler() });
		loop.register('acceptance-checks', async () => undefined);
		expect(loop.registeredKinds).toEqual(['acceptance-checks']);
	});
});

describe('isSuspendGap', () => {
	it('reads a wall clock that ran far ahead of the monotonic clock as a suspend', () => {
		// CLOCK_MONOTONIC on Linux/macOS stops through S3/S4: the machine
		// slept an hour and the monotonic clock saw only the awake seconds.
		expect(isSuspendGap({ armedForMs: 5_000, wallElapsedMs: 3_600_000, monotonicElapsedMs: 5_000 })).toBe(true);
	});

	it('reads a timer that fired far later than armed as a suspend even when both clocks advanced', () => {
		// Windows QPC advances across a suspend, so the difference says
		// nothing; the lateness against the armed delay still does.
		expect(isSuspendGap({ armedForMs: 5_000, wallElapsedMs: 3_600_000, monotonicElapsedMs: 3_600_000 })).toBe(true);
	});

	it('does not read ordinary jitter or a gap under the threshold as a suspend', () => {
		expect(isSuspendGap({ armedForMs: 5_000, wallElapsedMs: 5_040, monotonicElapsedMs: 5_040 })).toBe(false);
		expect(isSuspendGap({ armedForMs: 5_000, wallElapsedMs: 20_000, monotonicElapsedMs: 5_000 })).toBe(false);
		expect(
			isSuspendGap({
				armedForMs: 5_000,
				wallElapsedMs: 5_000 + SUSPEND_GAP_THRESHOLD_MS,
				monotonicElapsedMs: 5_000
			})
		).toBe(false);
	});

	it('degrades to "no resume noticed" on a broken wall clock, and still uses lateness when only the monotonic one is broken', () => {
		expect(isSuspendGap({ armedForMs: 5_000, wallElapsedMs: Number.NaN, monotonicElapsedMs: 0 })).toBe(false);
		expect(isSuspendGap({ armedForMs: 5_000, wallElapsedMs: 3_600_000, monotonicElapsedMs: Number.NaN })).toBe(
			true
		);
	});
});

describe('WorkerLoop — suspend-safe leases', () => {
	const staleLease = () =>
		Object.assign(new Error('Request rejected by the API (HTTP 409)'), { kind: 'stale-lease', status: 409 });

	/**
	 * A running job with a deferred executor, two injectable clocks and the
	 * controllable scheduler. After `start()` the queue holds the keep-alive
	 * beat, the keep-alive deadline and the loop's own zero-delay re-arm (a
	 * full batch was leased); the loop timer is the one that fires first on a
	 * real wake-up, because the beat is still counting down AWAKE seconds.
	 */
	async function runningJob(options: { leaseMs: number; leaseTtlSec?: number; leaseGeneration?: number }) {
		const startedAt = Date.parse('2026-09-05T08:00:00.000Z');
		const scheduler = controllableScheduler();
		const clocks = { wall: startedAt, monotonic: 0 };
		const leasedJob = job({
			leaseExpiresAt: new Date(startedAt + options.leaseMs).toISOString(),
			...(options.leaseGeneration !== undefined ? { leaseGeneration: options.leaseGeneration } : {})
		});
		const client = scriptedClient([[leasedJob], []]);
		const executor = deferred<Record<string, unknown>>();
		let jobSignal: AbortSignal | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			...(options.leaseTtlSec !== undefined ? { leaseTtlSec: options.leaseTtlSec } : {}),
			idlePollMs: 60_000,
			now: () => clocks.wall,
			monotonicNow: () => clocks.monotonic
		});
		loop.register('acceptance-checks', (_job, signal) => {
			jobSignal = signal;
			return executor.promise;
		});
		await loop.start();
		await vi.waitFor(() => expect(jobSignal).toBeDefined());
		return { startedAt, scheduler, clocks, client, executor, loop, signal: () => jobSignal! };
	}

	it('aborts a job whose lease lapsed while the machine slept the moment the loop timer fires on resume', async () => {
		const { startedAt, scheduler, clocks, client, executor, loop, signal } = await runningJob({
			leaseMs: 30_000,
			leaseTtlSec: 30,
			leaseGeneration: 3
		});
		expect(client.heartbeat).not.toHaveBeenCalled();

		// The lid closes for an hour. The wall clock jumps; the monotonic one
		// saw five awake seconds. The keep-alive beat (armed for +10s) has
		// not fired — it is still counting awake milliseconds — so without
		// the loop-level detector the model would keep running for most of a
		// keep-alive interval after wake.
		clocks.wall = startedAt + 3_600_000;
		clocks.monotonic = 5_000;
		expect(scheduler.runDelay(0)).toBe(true);

		expect(signal().aborted).toBe(true);
		expect((signal().reason as Error).message).toBe(FLEET_JOB_LEASE_LAPSED_WHILE_SUSPENDED_REASON);
		// Nothing was asked of the platform: the deadline had passed on this
		// node's own clock, and the claim is treated as gone.
		expect(client.heartbeat).not.toHaveBeenCalled();

		executor.resolve({ pushed: 'nothing, the abort landed first' });
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(client.complete).toHaveBeenCalledTimes(1);
		expect(client.complete).toHaveBeenCalledWith(
			'job-1',
			{ success: false, error: FLEET_JOB_LEASE_LAPSED_WHILE_SUSPENDED_REASON },
			3
		);
		expect(loop.getState().completed).toBe(0);
		expect(loop.getState().lastError).toBe(FLEET_JOB_LEASE_LAPSED_WHILE_SUSPENDED_REASON);
		await loop.stop();
	});

	it('does not read a short gap as a suspend', async () => {
		const { startedAt, scheduler, clocks, client, executor, loop, signal } = await runningJob({
			leaseMs: 300_000,
			leaseGeneration: 3
		});

		// Twenty wall seconds against five awake ones: a busy scheduler, a
		// GC pause, a brief lid-close — under the threshold, not a resume.
		clocks.wall = startedAt + 20_000;
		clocks.monotonic = 5_000;
		expect(scheduler.runDelay(0)).toBe(true);

		expect(signal().aborted).toBe(false);
		expect(client.heartbeat).not.toHaveBeenCalled();

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));
		expect(client.complete).toHaveBeenCalledWith('job-1', { success: true, result: { ok: true } }, 3);
		expect(loop.getState().failed).toBe(0);
		await loop.stop();
	});

	it('re-confirms the claim with one immediate heartbeat when the machine resumes inside the lease', async () => {
		const { startedAt, scheduler, clocks, client, executor, loop, signal } = await runningJob({
			leaseMs: 300_000,
			leaseGeneration: 3
		});
		client.heartbeat.mockResolvedValue(
			job({
				status: 'running',
				leaseExpiresAt: new Date(startedAt + 120_000 + 300_000).toISOString(),
				leaseGeneration: 3
			})
		);

		// Two minutes asleep, three minutes of claim left on paper. The local
		// deadline saw nothing; the platform may still have moved on. Ask.
		clocks.wall = startedAt + 120_000;
		clocks.monotonic = 5_000;
		expect(scheduler.runDelay(0)).toBe(true);

		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1));
		expect(client.heartbeat).toHaveBeenCalledWith('job-1', 300, 3);
		expect(signal().aborted).toBe(false);

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));
		expect(loop.getState().failed).toBe(0);
		await loop.stop();
	});

	it('aborts without reporting when the resume-time re-confirmation is answered stale-lease', async () => {
		const { startedAt, scheduler, clocks, client, executor, loop, signal } = await runningJob({
			leaseMs: 300_000,
			leaseGeneration: 3
		});
		client.heartbeat.mockRejectedValue(staleLease());

		clocks.wall = startedAt + 120_000;
		clocks.monotonic = 5_000;
		expect(scheduler.runDelay(0)).toBe(true);

		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(signal().aborted).toBe(true));
		expect((signal().reason as Error).message).toBe(FLEET_JOB_STALE_LEASE_REASON);

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		// The platform holds a newer claim; a failure report would only be
		// refused again. Nothing is sent.
		expect(client.complete).not.toHaveBeenCalled();
		expect(loop.getState().completed).toBe(0);
		expect(loop.getState().lastError).toBe(FLEET_JOB_STALE_LEASE_REASON);
		await loop.stop();
	});

	it('aborts at once when a scheduled heartbeat is answered stale-lease, and sends no report', async () => {
		const client = scriptedClient([[job({ leaseGeneration: 2 })], []]);
		client.heartbeat.mockRejectedValue(staleLease());
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler, leaseTtlSec: 30 });
		const executor = deferred<Record<string, unknown>>();
		let jobSignal: AbortSignal | undefined;
		loop.register('acceptance-checks', (_job, signal) => {
			jobSignal = signal;
			return executor.promise;
		});

		await loop.start();
		await vi.waitFor(() => expect(jobSignal).toBeDefined());
		scheduler.runNext();
		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledWith('job-1', 30, 2));
		await vi.waitFor(() => expect(jobSignal?.aborted).toBe(true));
		expect((jobSignal?.reason as Error).message).toBe(FLEET_JOB_STALE_LEASE_REASON);

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(client.complete).not.toHaveBeenCalled();
		expect(loop.getState().completed).toBe(0);
		await loop.stop();
	});

	it('collapses the claim and aborts when the publish-time confirmation is answered stale-lease', async () => {
		const startedAt = Date.parse('2026-09-05T09:00:00.000Z');
		const scheduler = controllableScheduler();
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 300_000).toISOString(), leaseGeneration: 4 });
		const client = scriptedClient([[leasedJob], []]);
		client.heartbeat.mockRejectedValue(staleLease());
		let confirmed: number | undefined;
		let jobSignal: AbortSignal | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			idlePollMs: 60_000,
			now: () => startedAt,
			monotonicNow: () => startedAt
		});
		loop.register('acceptance-checks', async (_job, signal, handle) => {
			jobSignal = signal;
			confirmed = await handle?.confirmDeadline();
			return { ok: true };
		});

		await loop.start();
		await vi.waitFor(() => expect(confirmed).toBeDefined());

		// Five minutes on paper; the platform says the claim was re-issued.
		// The fence must be told NOW, so nothing is pushed against it.
		expect(client.heartbeat).toHaveBeenCalledWith('job-1', 300, 4);
		expect(confirmed).toBe(startedAt);
		expect(jobSignal?.aborted).toBe(true);
		expect((jobSignal?.reason as Error).message).toBe(FLEET_JOB_STALE_LEASE_REASON);
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(client.complete).not.toHaveBeenCalled();
		await loop.stop();
	});

	it('does not follow a stale-lease refusal of its success report with a failure report', async () => {
		const client = scriptedClient([[job({ leaseGeneration: 5 })], []]);
		client.complete.mockRejectedValue(staleLease());
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler });
		loop.register('acceptance-checks', async () => ({ gateStatus: 'green' }));

		await loop.start();
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));

		expect(client.complete).toHaveBeenCalledTimes(1);
		expect(client.complete).toHaveBeenCalledWith('job-1', { success: true, result: { gateStatus: 'green' } }, 5);
		expect(loop.getState().completed).toBe(0);
		expect(loop.getState().lastError).toContain(FLEET_JOB_STALE_LEASE_REASON);
		await loop.stop();
	});

	it('calls heartbeat and complete with their original arity when the lease carried no generation', async () => {
		const client = scriptedClient([[job()], []]);
		const scheduler = controllableScheduler();
		const loop = new WorkerLoop({ client, scheduler, leaseTtlSec: 30 });
		const executor = deferred<Record<string, unknown>>();
		loop.register('acceptance-checks', () => executor.promise);

		await loop.start();
		scheduler.runNext();
		await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledTimes(1));
		expect(client.heartbeat.mock.calls[0]).toEqual(['job-1', 30]);

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));
		expect(client.complete.mock.calls[0]).toEqual(['job-1', { success: true, result: { ok: true } }]);
		await loop.stop();
	});

	it('kills a production agent-task command on resume when the lease lapsed during the suspend', async () => {
		const startedAt = Date.parse('2026-09-05T10:00:00.000Z');
		const scheduler = controllableScheduler();
		const clocks = { wall: startedAt, monotonic: 0 };
		const workspacePath = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
		const leasedJob = job({
			kind: 'agent-task',
			leaseExpiresAt: new Date(startedAt + 30_000).toISOString(),
			leaseGeneration: 3,
			payload: {
				taskId: 'task-suspend',
				workspacePath,
				steps: [{ id: 'blocking', command: 'blocking' }]
			}
		});
		const client = scriptedClient([[leasedJob], []]);
		const loop = new WorkerLoop({
			client,
			scheduler,
			leaseTtlSec: 30,
			idlePollMs: 60_000,
			now: () => clocks.wall,
			monotonicNow: () => clocks.monotonic
		});
		let spawned = false;
		const terminateProcessTree = vi.fn(async (child: ChildProcess) => {
			child.kill('SIGKILL');
		});
		const spawnFn = (() => {
			spawned = true;
			const handlers = new Map<string, (arg?: unknown) => void>();
			return {
				pid: 4747,
				stdout: { on: () => undefined, destroy: () => undefined },
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => handlers.set(event, handler),
				kill: () => {
					queueMicrotask(() => {
						handlers.get('exit')?.(null);
						handlers.get('close')?.(null);
					});
				}
			};
		}) as never;
		loop.register('agent-task', (leased, signal) =>
			runAgentTaskJob(leased, { directoryExists: () => true, spawnFn, terminateProcessTree }, signal)
		);

		await loop.start();
		await vi.waitFor(() => expect(spawned).toBe(true));

		clocks.wall = startedAt + 3_600_000;
		clocks.monotonic = 5_000;
		expect(scheduler.runDelay(0)).toBe(true);

		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(terminateProcessTree).toHaveBeenCalledOnce();
		expect(client.heartbeat).not.toHaveBeenCalled();
		expect(client.complete).toHaveBeenCalledTimes(1);
		expect(client.complete).toHaveBeenCalledWith(
			'job-1',
			expect.objectContaining({
				success: false,
				error: expect.stringContaining(FLEET_JOB_LEASE_LAPSED_WHILE_SUSPENDED_REASON)
			}),
			3
		);
		expect(loop.getState().completed).toBe(0);
		expect(loop.cancelJob('job-1')).toBe(false);
		await loop.stop();
	});

	it('notices a suspend that lands while a lease request is in flight, once that request settles', async () => {
		// The loop timer is not pending while `lease()` is out, so the
		// detector in `scheduleNext` cannot see a suspend that starts here.
		// The poll reads its own span instead: the request settles after
		// wake, the gap is an hour, and the lapsed job is stopped at once
		// rather than when its keep-alive beat happens to fire.
		const startedAt = Date.parse('2026-09-05T12:00:00.000Z');
		const scheduler = controllableScheduler();
		const clocks = { wall: startedAt, monotonic: 0 };
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 30_000).toISOString(), leaseGeneration: 3 });
		const secondLease = deferred<FleetJobView[]>();
		let leaseCalls = 0;
		const complete = vi.fn(async () => true);
		const heartbeat = vi.fn(async () => job({ status: 'running' }));
		const client: JobLeaseCapableClient = {
			complete,
			heartbeat,
			lease: async () => {
				leaseCalls += 1;
				return leaseCalls === 1 ? [leasedJob] : secondLease.promise;
			}
		};
		const executor = deferred<Record<string, unknown>>();
		let jobSignal: AbortSignal | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			concurrency: 2,
			leaseTtlSec: 30,
			idlePollMs: 60_000,
			now: () => clocks.wall,
			monotonicNow: () => clocks.monotonic
		});
		loop.register('acceptance-checks', (_job, signal) => {
			jobSignal = signal;
			return executor.promise;
		});

		await loop.start();
		await vi.waitFor(() => expect(jobSignal).toBeDefined());
		// Headroom for a second job, so the immediate re-poll actually asks
		// the platform — and is still waiting on the answer when the lid
		// closes. Nothing has moved on either clock yet: not a resume.
		expect(scheduler.runDelay(0)).toBe(true);
		await vi.waitFor(() => expect(leaseCalls).toBe(2));
		expect(jobSignal!.aborted).toBe(false);

		clocks.wall = startedAt + 3_600_000;
		clocks.monotonic = 5_000;
		secondLease.resolve([]);

		await vi.waitFor(() => expect(jobSignal!.aborted).toBe(true));
		expect((jobSignal!.reason as Error).message).toBe(FLEET_JOB_LEASE_LAPSED_WHILE_SUSPENDED_REASON);
		expect(heartbeat).not.toHaveBeenCalled();

		executor.resolve({});
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(complete).toHaveBeenCalledWith(
			'job-1',
			{ success: false, error: FLEET_JOB_LEASE_LAPSED_WHILE_SUSPENDED_REASON },
			3
		);
		await loop.stop();
	});

	it('keeps a same-job re-lease alive while the lapsed run it replaces is still tearing down', async () => {
		// Reclaim runs inline on the node's OWN lease poll, so the first poll
		// after a resume hands the job this node slept through straight back
		// to it under the next generation — while the lapsed run is still
		// killing its model process. With headroom for two jobs the same id
		// is then in flight twice, and nothing the OLD run does on its way
		// out (its refused report, its keep-alive noticing it lost the claim)
		// may abort or silence the NEW claim.
		const startedAt = Date.parse('2026-09-05T11:00:00.000Z');
		const scheduler = controllableScheduler();
		const clocks = { wall: startedAt, monotonic: 0 };
		const first = job({ leaseExpiresAt: new Date(startedAt + 30_000).toISOString(), leaseGeneration: 1 });
		const second = job({
			leaseExpiresAt: new Date(startedAt + 3_600_000 + 30_000).toISOString(),
			leaseGeneration: 2
		});
		const client = scriptedClient([[first], [second], []]);
		client.complete.mockImplementation(async (_jobId: string, _outcome: unknown, generation?: number) => {
			if (generation === 1) throw staleLease();
			return true;
		});
		const runs: Array<{ signal: AbortSignal; executor: ReturnType<typeof deferred<Record<string, unknown>>> }> = [];
		const loop = new WorkerLoop({
			client,
			scheduler,
			concurrency: 2,
			leaseTtlSec: 30,
			idlePollMs: 60_000,
			now: () => clocks.wall,
			monotonicNow: () => clocks.monotonic
		});
		loop.register('acceptance-checks', (_job, signal) => {
			const executor = deferred<Record<string, unknown>>();
			runs.push({ signal, executor });
			return executor.promise;
		});

		await loop.start();
		await vi.waitFor(() => expect(runs).toHaveLength(1));

		// Resume after an hour: the loop timer aborts the lapsed run and the
		// poll it triggers re-leases the same job under generation 2.
		clocks.wall = startedAt + 3_600_000;
		clocks.monotonic = 5_000;
		expect(scheduler.runDelay(0)).toBe(true);
		expect(runs[0]!.signal.aborted).toBe(true);
		await vi.waitFor(() => expect(client.leaseCalls).toBe(2));

		// The old run's executor finally notices the abort and returns; its
		// claim is void, so its report is not sent (the platform would only
		// answer stale-lease) — and above all the fresh claim is untouched.
		runs[0]!.executor.resolve({});
		await vi.waitFor(() => expect(runs).toHaveLength(2));
		expect(runs[1]!.signal.aborted).toBe(false);
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(client.complete).not.toHaveBeenCalledWith('job-1', expect.anything(), 1);
		expect(runs[1]!.signal.aborted).toBe(false);
		expect(loop.getState().activeJobIds).toEqual(['job-1']);

		runs[1]!.executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().completed).toBe(1));
		expect(client.complete).toHaveBeenCalledTimes(1);
		expect(client.complete).toHaveBeenCalledWith('job-1', { success: true, result: { ok: true } }, 2);
		expect(loop.getState().activeJobIds).toEqual([]);
		await loop.stop();
	});

	it('collapses the local publish deadline the moment a run is aborted, even with minutes left on paper', async () => {
		// A run voided by a same-node re-lease, or cancelled by an operator, is
		// aborted straight through its controller — not through a refused
		// beat, so nothing in the keep-alive has told the deadline anything.
		// `confirmDeadline` deliberately stops re-asking the platform once the
		// signal is aborted, so the fence must be told NOW rather than handed
		// the five healthy minutes the wire still shows.
		const startedAt = Date.parse('2026-09-05T13:00:00.000Z');
		const scheduler = controllableScheduler();
		const leasedJob = job({ leaseExpiresAt: new Date(startedAt + 300_000).toISOString(), leaseGeneration: 2 });
		const client = scriptedClient([[leasedJob], []]);
		const executor = deferred<Record<string, unknown>>();
		let lease: JobLeaseHandle | undefined;
		const loop = new WorkerLoop({
			client,
			scheduler,
			idlePollMs: 60_000,
			now: () => startedAt,
			monotonicNow: () => 0
		});
		loop.register('acceptance-checks', (_job, _signal, handle) => {
			lease = handle;
			return executor.promise;
		});

		await loop.start();
		await vi.waitFor(() => expect(lease).toBeDefined());
		expect(lease!.deadlineAt()).toBe(startedAt + 300_000);

		expect(loop.cancelJob('job-1', 'operator cancellation')).toBe(true);
		expect(lease!.deadlineAt()).toBe(startedAt);
		await expect(lease!.confirmDeadline()).resolves.toBe(startedAt);
		expect(client.heartbeat).not.toHaveBeenCalled();

		executor.resolve({ ok: true });
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(client.complete).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ success: true }), 2);
		await loop.stop();
	});
});
