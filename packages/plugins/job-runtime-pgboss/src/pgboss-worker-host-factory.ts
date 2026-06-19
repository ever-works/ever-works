import type { PgBossFactoryOptions, PgBossInstance, PgBossJobView } from './pgboss-types.js';
import type { WorkerHostHandle, WorkerHostOptions } from '@ever-works/plugin';

export interface PgBossWorkerRegistration {
	readonly queueName: string;
	readonly handler: (job: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>;
	readonly workOptions?: Readonly<Record<string, unknown>>;
}

/**
 * EW-742 P3.2 follow-up — operator-facing factory that registers
 * pg-boss workers and aggregates their lifecycle behind one
 * `WorkerHostHandle`.
 *
 * # Lifecycle nuance
 *
 * pg-boss workers are bound to the pg-boss instance, not separate
 * processes. `register(...)` queues registrations; `start()` calls
 * `boss.work(...)` for each one. `stop()` calls `boss.stop()` which
 * is the canonical way to drain pg-boss workers.
 *
 * The pg-boss `boss` instance is shared with `PgBossDispatcherFactory`
 * — the operator hands the same instance to both factories. Stopping
 * the worker host therefore stops outbound dispatch too. Operators
 * who need to keep dispatching while gracefully draining workers
 * should hold separate pg-boss instances per role (one
 * connectionString, two PgBoss objects).
 *
 * # Usage
 *
 * ```ts
 * const workerHost = new PgBossWorkerHostFactory({ boss });
 * workerHost.register('kb-embed-document', { batchSize: 1, teamSize: 4 }, async (job) => {
 *   // operator handler
 * });
 * const plugin = new PgBossJobRuntimePlugin().useWorkerHostFactory(workerHost);
 * const handle = await plugin.startWorkerHost({ concurrency: 8 });
 * process.on('SIGTERM', () => handle.stop());
 * ```
 */
export class PgBossWorkerHostFactory {
	private readonly registrations: PgBossWorkerRegistration[] = [];
	private subscriptionIds: string[] = [];
	private started = false;

	constructor(private readonly opts: PgBossFactoryOptions) {}

	get boss(): PgBossInstance {
		return this.opts.boss;
	}

	/**
	 * Register a worker. Throws if `start()` already ran. The
	 * `workOptions` arg is passed through to `boss.work(name, opts, h)`.
	 */
	register(
		queueName: string,
		workOptions: Readonly<Record<string, unknown>>,
		handler: (job: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>
	): this {
		if (this.started) {
			throw new Error(
				`PgBossWorkerHostFactory: cannot register '${queueName}' after start() — register all workers before plugin.startWorkerHost runs.`
			);
		}
		this.registrations.push({ queueName, handler, workOptions });
		return this;
	}

	/**
	 * Start every registered worker by calling `boss.work(name, opts, h)`
	 * sequentially. Returns a handle whose `stop()` calls `boss.stop()`
	 * — pg-boss's canonical graceful-drain.
	 */
	async start(hostOpts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.started) {
			throw new Error('PgBossWorkerHostFactory: start() called twice — already running.');
		}
		this.started = true;

		const defaults = this.opts.defaultWorkOptions ?? {};
		const ids: string[] = [];
		for (const reg of this.registrations) {
			const merged: Record<string, unknown> = { ...defaults, ...(reg.workOptions ?? {}) };
			if (hostOpts.concurrency !== undefined && merged['teamSize'] === undefined) {
				merged['teamSize'] = hostOpts.concurrency;
			}
			const id = await this.opts.boss.work(reg.queueName, merged, reg.handler);
			ids.push(id);
		}
		this.subscriptionIds = ids;

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
		const ids = this.subscriptionIds;
		this.subscriptionIds = [];
		await this.opts.boss.stop({ graceful: true }).catch(() => {
			// Operator may have already stopped pg-boss; swallow.
		});
		// Subscription ids are returned for operator observability only;
		// pg-boss.stop() drains them all.
		void ids;
	}

	get registrationCount(): number {
		return this.registrations.length;
	}
}
