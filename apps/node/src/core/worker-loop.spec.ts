import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetJobView } from '@ever-works/contracts';
import { nextBackoffMs, WorkerLoop, type JobLeaseCapableClient } from './worker-loop';
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
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
		await expect.poll(() => scheduler.nextDueAt()).toBe(startedAt + 30_000);
		expect(terminateProcessTree).not.toHaveBeenCalled();
		scheduler.advanceTo(startedAt + 29_999);
		expect(terminateProcessTree).not.toHaveBeenCalled();

		scheduler.advanceTo(startedAt + 30_000);
		await vi.waitFor(() => expect(terminateProcessTree).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(loop.getState().failed).toBe(1));
		expect(client.heartbeat).toHaveBeenCalledTimes(2);
		expect(client.complete).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ success: true }));
		expect(loop.getState().completed).toBe(0);
		await loop.stop();
	});

	it('counts one accepted success when a terminal heartbeat response races its completion response', async () => {
		const client = scriptedClient([[job()], []]);
		const successResponse = deferred<boolean>();
		const heartbeatResponse = deferred<boolean>();
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
		heartbeatResponse.resolve(false);
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
