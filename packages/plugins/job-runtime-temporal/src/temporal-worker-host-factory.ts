import type { WorkerHostHandle, WorkerHostOptions } from '@ever-works/plugin';
import type { TemporalWorker, TemporalWorkerSpec } from './temporal-types.js';

/**
 * EW-742 P3.2 follow-up — operator-facing factory that registers
 * Temporal worker specs and starts every worker on `start(...)`.
 *
 * # Why a build callback instead of a `Worker` instance
 *
 * `@temporalio/worker.Worker.create(...)` is async and pulls in the
 * native `@temporalio/core-bridge` runtime. We don't want this plugin
 * package to depend on `@temporalio/worker` (heavy native deps), so
 * the operator passes a `build()` callback that constructs the worker
 * just-in-time during `start()`.
 *
 * # Usage
 *
 * ```ts
 * import { Worker, NativeConnection } from '@temporalio/worker';
 * import * as activities from './activities';
 * import { TemporalWorkerHostFactory } from '@ever-works/job-runtime-temporal-plugin';
 *
 * const wh = new TemporalWorkerHostFactory();
 * wh.register({
 *   taskQueue: 'ew',
 *   build: () => Worker.create({
 *     connection: await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS! }),
 *     namespace: process.env.TEMPORAL_NAMESPACE!,
 *     taskQueue: 'ew',
 *     workflowsPath: require.resolve('./workflows'),
 *     activities
 *   })
 * });
 * const plugin = new TemporalJobRuntimePlugin().useWorkerHostFactory(wh);
 * const handle = await plugin.startWorkerHost({});
 * process.on('SIGTERM', () => handle.stop());
 * ```
 */
export class TemporalWorkerHostFactory {
	private readonly specs: TemporalWorkerSpec[] = [];
	private workers: TemporalWorker[] = [];
	private runPromises: Promise<void>[] = [];
	private started = false;

	register(spec: TemporalWorkerSpec): this {
		if (this.started) {
			throw new Error(
				`TemporalWorkerHostFactory: cannot register taskQueue '${spec.taskQueue}' after start() — register all workers before plugin.startWorkerHost runs.`
			);
		}
		this.specs.push(spec);
		return this;
	}

	async start(hostOpts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.started) {
			throw new Error('TemporalWorkerHostFactory: start() called twice — already running.');
		}
		this.started = true;

		const workers: TemporalWorker[] = [];
		for (const spec of this.specs) {
			workers.push(await spec.build());
		}
		this.workers = workers;
		// Temporal's Worker.run() returns a Promise that resolves on
		// shutdown. Capture them so stop() can await graceful drain.
		this.runPromises = workers.map((w) => w.run());

		if (hostOpts.signal) {
			const signal = hostOpts.signal;
			const onAbort = () => {
				void this.stopAll();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}

		return { stop: () => this.stopAll() };
	}

	private async stopAll(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		const workers = this.workers;
		const runs = this.runPromises;
		this.workers = [];
		this.runPromises = [];
		// `shutdown()` is sync in older worker versions; await unconditionally.
		await Promise.allSettled(workers.map((w) => Promise.resolve(w.shutdown())));
		// Then wait for `.run()` promises to settle (graceful drain).
		await Promise.allSettled(runs);
	}

	get registrationCount(): number {
		return this.specs.length;
	}
}
