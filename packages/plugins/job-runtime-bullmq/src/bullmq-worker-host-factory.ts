import type {
	BullMqDeps,
	BullMqFactoryOptions,
	BullMqJobView,
	BullMqWorkerAdapter
} from './bullmq-types.js';
import type { WorkerHostHandle, WorkerHostOptions } from '@ever-works/plugin';

export interface BullMqWorkerRegistration {
	readonly queueName: string;
	readonly handler: (job: BullMqJobView) => Promise<unknown>;
	/** Per-worker concurrency override (falls back to `WorkerHostOptions.concurrency`). */
	readonly concurrency?: number;
	/** Optional pass-through to `Worker` opts. */
	readonly workerOpts?: Readonly<Record<string, unknown>>;
}

/**
 * EW-742 P3.2 follow-up — operator-facing factory that spins up one
 * BullMQ `Worker` per registered queue and exposes a single
 * `WorkerHostHandle` whose `stop()` closes them all.
 *
 * # Usage (operator-side worker app)
 *
 * ```ts
 * import { Worker, Queue } from 'bullmq';
 * import IORedis from 'ioredis';
 * import {
 *   BullMqJobRuntimePlugin,
 *   BullMqWorkerHostFactory
 * } from '@ever-works/job-runtime-bullmq-plugin';
 *
 * const connection = new IORedis(process.env.BULLMQ_REDIS_URL!, { maxRetriesPerRequest: null });
 * const workerHost = new BullMqWorkerHostFactory({ Queue, Worker }, { connection });
 *
 * workerHost.register('kb-embed-document', async (job) => {
 *   // operator-defined handler — receives the same payload the
 *   // dispatcher enqueued.
 * });
 *
 * const plugin = new BullMqJobRuntimePlugin().useWorkerHostFactory(workerHost);
 * // ...later, somewhere that already calls plugin.startWorkerHost(...):
 * const handle = await plugin.startWorkerHost({ concurrency: 8 });
 * process.on('SIGTERM', () => handle.stop());
 * ```
 *
 * # Why register-then-start
 *
 * BullMQ workers start polling as soon as they're constructed. Holding
 * the registrations and only constructing on `start()` lets the plugin
 * decide the default concurrency (via `WorkerHostOptions`) once, and
 * lets the operator graceful-shutdown by calling the returned handle's
 * `stop()` instead of tracking N workers themselves.
 */
export class BullMqWorkerHostFactory {
	private readonly registrations: BullMqWorkerRegistration[] = [];
	private workers: BullMqWorkerAdapter[] = [];
	private started = false;

	constructor(
		private readonly deps: BullMqDeps,
		private readonly opts: BullMqFactoryOptions
	) {}

	/**
	 * Register a worker for a queue. Throws if `start()` has already
	 * been called — operators must register everything before the
	 * plugin's `startWorkerHost` fires.
	 */
	register(
		queueName: string,
		handler: (job: BullMqJobView) => Promise<unknown>,
		opts?: { concurrency?: number; workerOpts?: Readonly<Record<string, unknown>> }
	): this {
		if (this.started) {
			throw new Error(
				`BullMqWorkerHostFactory: cannot register '${queueName}' after start() — register all workers before plugin.startWorkerHost runs.`
			);
		}
		const reg: BullMqWorkerRegistration = {
			queueName,
			handler,
			...(opts?.concurrency !== undefined && { concurrency: opts.concurrency }),
			...(opts?.workerOpts !== undefined && { workerOpts: opts.workerOpts })
		};
		this.registrations.push(reg);
		return this;
	}

	/**
	 * Start every registered worker. Returns a `WorkerHostHandle` whose
	 * `stop()` closes every worker (and is idempotent). The shared
	 * connection itself is NOT closed — the operator owns it.
	 */
	async start(hostOpts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.started) {
			throw new Error('BullMqWorkerHostFactory: start() called twice — already running.');
		}
		this.started = true;

		const defaultConcurrency = hostOpts.concurrency;
		const workers = this.registrations.map((reg) => {
			const concurrency = reg.concurrency ?? defaultConcurrency;
			const workerOpts: Record<string, unknown> = {
				connection: this.opts.connection,
				...(reg.workerOpts ?? {})
			};
			if (this.opts.prefix !== undefined) workerOpts['prefix'] = this.opts.prefix;
			if (concurrency !== undefined) workerOpts['concurrency'] = concurrency;
			return new this.deps.Worker(reg.queueName, reg.handler, workerOpts);
		});
		this.workers = workers;

		if (hostOpts.signal) {
			const signal = hostOpts.signal;
			const onAbort = () => {
				void this.stopAll();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}

		const handle: WorkerHostHandle = {
			stop: () => this.stopAll()
		};
		return handle;
	}

	private async stopAll(): Promise<void> {
		const workers = this.workers;
		this.workers = [];
		this.started = false;
		await Promise.allSettled(workers.map((w) => w.close()));
	}

	/** Number of registrations — useful for tests/metrics. */
	get registrationCount(): number {
		return this.registrations.length;
	}
}
