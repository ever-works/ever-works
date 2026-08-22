import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { FleetJobView } from '@ever-works/contracts';
import { nextBackoffMs, WorkerLoop, type JobLeaseCapableClient } from './worker-loop';
import type { Scheduler } from './heartbeat';
import { runAgentTaskJob } from './executors/agent-task';

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
	pending: number;
} {
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
			const entry = queue.shift();
			entry?.callback();
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

/** A client that hands out a fixed script of lease results. */
function scriptedClient(script: Array<FleetJobView[] | Error>): JobLeaseCapableClient & {
	complete: ReturnType<typeof vi.fn>;
	heartbeat: ReturnType<typeof vi.fn>;
	leaseCalls: number;
} {
	let index = 0;
	const complete = vi.fn(async () => true);
	const heartbeat = vi.fn(async () => true);
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
		client.heartbeat.mockResolvedValue(false);
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
