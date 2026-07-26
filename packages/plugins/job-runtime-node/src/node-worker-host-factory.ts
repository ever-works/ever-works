import type { WorkerHostHandle, WorkerHostOptions } from '@ever-works/plugin';
import type { FleetJobKind, FleetJobView } from '@ever-works/contracts';
import { FLEET_JOB_MAX_LEASE_BATCH } from '@ever-works/contracts';
import type { FleetJobHandler, FleetLeaseTransport } from './node-types.js';
import { nextBackoffMs, WORKER_IDLE_POLL_MS } from './node-backoff.js';

/**
 * Pull-model worker host for the `node` runtime: lease → execute →
 * report, forever, until stopped.
 *
 * Where pg-boss's host calls `boss.work(...)` and BullMQ's constructs a
 * `Worker`, this one polls the platform's lease endpoint through an
 * injected {@link FleetLeaseTransport}. That indirection is the point —
 * the same loop runs in three places (the all-in-one desktop app's
 * in-process host, a headless `apps/node` install, and tests) with only
 * the transport swapped.
 *
 * ## Guarantees
 *
 * - **Nothing runs without a handler.** A leased job whose kind has no
 *   registered executor is completed as a FAILURE immediately, with a
 *   message naming the kind. Silently dropping it would leave the job
 *   to expire and retry on the same incapable node forever.
 * - **The lease is kept alive while work runs.** Each in-flight job gets
 *   a heartbeat timer at a third of the lease TTL, so a long build never
 *   loses its claim to the reclaim sweep.
 * - **Graceful shutdown waits for in-flight work.** `stop()` stops
 *   leasing immediately, then awaits the jobs already running so their
 *   results are reported rather than abandoned to a lease expiry.
 * - **Backoff is exponential with a ceiling**, so an API outage produces
 *   a slow retry, not a hot loop against a dead endpoint.
 */
export class NodeWorkerHostFactory {
	private readonly handlers = new Map<FleetJobKind, FleetJobHandler>();
	private readonly inFlight = new Set<Promise<void>>();
	private started = false;
	private stopping = false;
	private loop: Promise<void> | null = null;
	/** True while control is inside the poll loop — see `stopAll` re-entrancy. */
	private insideLoop = false;

	constructor(
		private readonly opts: {
			readonly transport: FleetLeaseTransport;
			/** Claim duration requested per lease; the server clamps it. */
			readonly leaseTtlSec?: number;
			/** Idle poll interval when the fleet has nothing queued. */
			readonly idlePollMs?: number;
			/** Injected for tests; defaults to a real timer. */
			readonly sleep?: (ms: number) => Promise<void>;
			readonly onError?: (error: unknown) => void;
		}
	) {}

	/** Register the executor for one job kind. Last registration wins. */
	register(kind: FleetJobKind, handler: FleetJobHandler): this {
		if (this.started) {
			throw new Error(
				`NodeWorkerHostFactory: cannot register '${kind}' after start() — register all executors before startWorkerHost runs.`
			);
		}
		this.handlers.set(kind, handler);
		return this;
	}

	get registrationCount(): number {
		return this.handlers.size;
	}

	async start(hostOpts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.started) {
			throw new Error('NodeWorkerHostFactory: start() called twice — already running.');
		}
		this.started = true;
		this.stopping = false;

		const concurrency = Math.min(Math.max(hostOpts.concurrency ?? 1, 1), FLEET_JOB_MAX_LEASE_BATCH);
		const idleMs = hostOpts.pollIntervalMs ?? this.opts.idlePollMs ?? WORKER_IDLE_POLL_MS;

		this.insideLoop = true;
		this.loop = this.run(concurrency, idleMs).finally(() => {
			this.insideLoop = false;
		});

		if (hostOpts.signal) {
			const signal = hostOpts.signal;
			const onAbort = () => void this.stopAll();
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}

		return { stop: () => this.stopAll() };
	}

	/**
	 * Idempotent graceful stop: stop leasing, then drain. Calling it a
	 * second time while the first drain is still running must not start
	 * a concurrent teardown.
	 *
	 * Re-entrancy: `stopping` is set SYNCHRONOUSLY and the loop promise is
	 * only awaited from outside the loop. A stop requested from inside the
	 * loop's own await chain (an injected `sleep` that decides to shut
	 * down, a handler that stops its own host) would otherwise deadlock —
	 * loop awaits sleep awaits stop awaits loop.
	 */
	async stopAll(): Promise<void> {
		if (!this.started) return;
		this.stopping = true;
		const loop = this.loop;
		this.loop = null;
		if (loop && !this.insideLoop) await loop.catch(() => undefined);
		await Promise.allSettled([...this.inFlight]);
		this.started = false;
	}

	private async run(concurrency: number, idleMs: number): Promise<void> {
		const sleep = this.opts.sleep ?? defaultSleep;
		let consecutiveFailures = 0;

		while (!this.stopping) {
			// Unconditional macrotask yield. The delay policy is the injected
			// `sleep`, but a sleep that resolves on the microtask queue alone
			// would let this loop starve timers and I/O — including the very
			// callbacks that would have stopped it. One tick per iteration is
			// free in production and makes that class of hang impossible.
			await macrotaskTick();
			if (this.stopping) break;

			const capacity = concurrency - this.inFlight.size;
			if (capacity <= 0) {
				await this.guarded(sleep(idleMs));
				continue;
			}

			let jobs: FleetJobView[] = [];
			try {
				const request: { max: number; leaseTtlSec?: number } = { max: capacity };
				if (this.opts.leaseTtlSec !== undefined) request.leaseTtlSec = this.opts.leaseTtlSec;
				jobs = await this.opts.transport.lease(request);
				consecutiveFailures = 0;
			} catch (error) {
				consecutiveFailures += 1;
				this.opts.onError?.(error);
				await this.guarded(sleep(nextBackoffMs(consecutiveFailures)));
				continue;
			}

			if (jobs.length === 0) {
				await this.guarded(sleep(idleMs));
				continue;
			}

			for (const job of jobs) {
				const task = this.execute(job).finally(() => {
					this.inFlight.delete(task);
				});
				this.inFlight.add(task);
			}
		}
	}

	/**
	 * Run one job to a reported verdict. Never throws: an executor that
	 * blows up is reported as a job failure, because a job whose node
	 * silently swallowed the error is indistinguishable from a hung one.
	 */
	/**
	 * Await an injected delay without letting it take the loop down: a
	 * `sleep` that rejects is a caller bug, not a reason to stop polling.
	 */
	private async guarded(delay: Promise<void>): Promise<void> {
		await delay.catch(() => undefined);
	}

	private async execute(job: FleetJobView): Promise<void> {
		const handler = this.handlers.get(job.kind);
		if (!handler) {
			await this.report(job.id, {
				success: false,
				error: `No executor registered for fleet job kind '${job.kind}' on this node`
			});
			return;
		}

		const keepAlive = this.startKeepAlive(job.id);
		try {
			const result = await handler(job);
			await this.report(job.id, {
				success: true,
				result: (result as Record<string, unknown> | undefined) ?? null
			});
		} catch (error) {
			await this.report(job.id, {
				success: false,
				error: error instanceof Error ? error.message : String(error)
			});
		} finally {
			clearInterval(keepAlive);
		}
	}

	/** Keep the claim alive at a third of the lease TTL. */
	private startKeepAlive(jobId: string): ReturnType<typeof setInterval> {
		const ttlSec = this.opts.leaseTtlSec ?? 300;
		const everyMs = Math.max(Math.floor((ttlSec * 1000) / 3), 5_000);
		const timer = setInterval(() => {
			void this.opts.transport
				.heartbeat(jobId, this.opts.leaseTtlSec)
				.catch((error: unknown) => this.opts.onError?.(error));
		}, everyMs);
		// Never hold the process open just to renew a lease.
		(timer as unknown as { unref?: () => void }).unref?.();
		return timer;
	}

	private async report(
		jobId: string,
		outcome: { success: boolean; result?: Record<string, unknown> | null; error?: string | null }
	): Promise<void> {
		try {
			await this.opts.transport.complete(jobId, outcome);
		} catch (error) {
			// The lease will expire and the job will be reclaimed — the
			// protocol survives an unreportable result by construction.
			this.opts.onError?.(error);
		}
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		(timer as unknown as { unref?: () => void }).unref?.();
	});
}

/** One real macrotask boundary — never resolves on the microtask queue. */
function macrotaskTick(): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, 0);
		(timer as unknown as { unref?: () => void }).unref?.();
	});
}
