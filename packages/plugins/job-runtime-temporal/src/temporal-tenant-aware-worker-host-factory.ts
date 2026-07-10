import type {
	IJobRuntimeProvider,
	TenantCredentialSnapshot,
	WorkerHostHandle,
	WorkerHostOptions
} from '@ever-works/plugin';
import type { TemporalWorker } from './temporal-types.js';
import type { TemporalJobRuntimePlugin } from './temporal-job-runtime.plugin.js';

/**
 * EW-742 P4 T27/T30/T32 — Temporal tenant-aware worker host factory.
 *
 * # Why this factory exists separately from `TemporalWorkerHostFactory`
 *
 * Temporal Activities receive their inputs as positional args, NOT a
 * `job` object — there's no "BullMQ-style job.opts" to read tenantId
 * off the running Activity. Per `providers.md` § Temporal + ADR-017 Q1,
 * the tenant routing model is **one Worker per (tenant, taskQueue)**,
 * each Worker bound to the right NAMESPACE via its `NativeConnection`
 * at construction time.
 *
 * So this factory is a **registry mapper**, not a per-job router:
 *
 *   - The operator registers one `TenantWorkerBuilder` per tenant
 *     (each carries its own `build(binding)` callback).
 *   - On `start()` the factory iterates the registry, resolves the
 *     tenant's `TenantCredentialSnapshot`, threads it through
 *     `plugin.bindToTenant(snapshot)` to get the namespace-bound view,
 *     and hands that binding to the operator's `build()` callback so
 *     the resulting `Worker.create()` call can configure its
 *     `NativeConnection` against the tenant's namespace.
 *   - The shutdown path mirrors `TemporalWorkerHostFactory.stopAll`:
 *     call `shutdown()` on every Worker AND await the `run()` promises
 *     so graceful drain completes before the operator's bootstrap
 *     returns.
 *
 * # Why an operator-supplied `build()` callback
 *
 * Same reason as `TemporalWorkerHostFactory`: `@temporalio/worker`
 * carries native deps (`@temporalio/core-bridge`) that this plugin
 * package intentionally does not depend on. The operator constructs
 * the Worker just-in-time inside `build(binding)` so the heavy native
 * import stays on the operator side.
 */
export interface TenantWorkerBuilder {
	readonly tenantId: string;
	readonly taskQueue: string;
	/**
	 * Operator-supplied build callback. Receives the tenant binding
	 * (result of `plugin.bindToTenant(snapshot)`) so the operator's
	 * `Worker.create()` call can configure its `NativeConnection`
	 * against the tenant's namespace per ADR-017 Q1.
	 */
	build(binding: IJobRuntimeProvider): Promise<TemporalWorker>;
}

export interface TenantAwareTemporalWorkerHostFactoryOptions {
	readonly plugin: TemporalJobRuntimePlugin;
	/**
	 * Resolve the per-tenant credential snapshot. When omitted, a
	 * synthetic snapshot is generated (`providerId: 'temporal'`,
	 * `credentialVersion: 0`, empty `credentials`) so smoke-tests /
	 * dev wiring still pass through `plugin.bindToTenant`. Production
	 * operators are expected to supply this from their secrets store.
	 */
	readonly resolveSnapshot?: (tenantId: string) => TenantCredentialSnapshot | Promise<TenantCredentialSnapshot>;
}

export class TenantAwareTemporalWorkerHostFactory {
	private readonly specs: TenantWorkerBuilder[] = [];
	private workers: TemporalWorker[] = [];
	private runPromises: Promise<void>[] = [];
	private started = false;

	constructor(private readonly opts: TenantAwareTemporalWorkerHostFactoryOptions) {}

	/** Register one Worker spec for a given tenant. Throws after start(). */
	register(spec: TenantWorkerBuilder): this {
		if (this.started) {
			throw new Error(
				`TenantAwareTemporalWorkerHostFactory: cannot register tenant '${spec.tenantId}' ` +
					`(taskQueue '${spec.taskQueue}') after start() — register all tenant workers ` +
					`before plugin.startWorkerHost runs.`
			);
		}
		this.specs.push(spec);
		return this;
	}

	/**
	 * Materialise one Worker per registered tenant via `spec.build(binding)`,
	 * then run them all. Returned handle's `stop()` shuts down every
	 * Worker AND awaits the `run()` promises (graceful drain).
	 */
	async start(hostOpts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.started) {
			throw new Error('TenantAwareTemporalWorkerHostFactory: start() called twice — already running.');
		}
		this.started = true;

		const workers: TemporalWorker[] = [];
		for (const spec of this.specs) {
			const snapshot = await this.resolveSnapshot(spec.tenantId);
			const binding = this.opts.plugin.bindToTenant(snapshot);
			workers.push(await spec.build(binding));
		}
		this.workers = workers;
		// Temporal's `Worker.run()` returns a Promise that resolves on
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

	get registrationCount(): number {
		return this.specs.length;
	}

	private async resolveSnapshot(tenantId: string): Promise<TenantCredentialSnapshot> {
		if (this.opts.resolveSnapshot) {
			return this.opts.resolveSnapshot(tenantId);
		}
		return {
			tenantId,
			providerId: 'temporal',
			credentialVersion: 0,
			credentials: {}
		};
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
}
