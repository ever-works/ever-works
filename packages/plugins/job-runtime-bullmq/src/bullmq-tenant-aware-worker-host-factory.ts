import type { BullMqDeps, BullMqFactoryOptions, BullMqJobView, BullMqWorkerAdapter } from './bullmq-types.js';
import type {
	IJobRuntimeProvider,
	TenantCredentialSnapshot,
	WorkerHostHandle,
	WorkerHostOptions
} from '@ever-works/plugin';
import type { BullMqJobRuntimePlugin } from './bullmq-job-runtime.plugin.js';

/**
 * EW-742 P4 T28/T30/T32 — tenant-aware BullMQ worker host.
 *
 * Sibling of {@link import('./bullmq-worker-host-factory.js').BullMqWorkerHostFactory}
 * that routes each in-flight job to the tenant's overlay binding before
 * invoking the operator-supplied handler.
 *
 * # Why a separate factory
 *
 * The base {@link BullMqWorkerHostFactory} hands `BullMqJobView` to the
 * handler verbatim — fine for instance-default workers that don't need
 * tenant isolation. This variant adds three responsibilities the base
 * MUST NOT take on (separation per ADR-017 §4 — tenant routing is a
 * separate concern from worker hosting):
 *
 *   1. Extract `tenantId` from the BullMQ job (`opts.tenantId` per T31
 *      mapEnqueueOptions; `data._ew.tenantId` as the pg-boss-style
 *      fallback for operators who chose to stamp it on the payload).
 *   2. Resolve the tenant credential snapshot — either via the operator-
 *      supplied {@link TenantAwareBullMqWorkerHostFactoryOptions.resolveSnapshot}
 *      callback (which typically reads `tenant_job_runtime_config` +
 *      secrets) or via a synthetic empty-credentials snapshot suitable
 *      for inherit-mode tenants and unit tests.
 *   3. Call `plugin.bindToTenant(snapshot)` and pass the returned
 *      `IJobRuntimeProvider` view to the handler as `binding`. Per FR-5
 *      of the tenant-overlay spec, jobs without a tenantId fall back to
 *      the platform-default binding (the plugin singleton itself).
 *
 * # Memoisation
 *
 * The factory does NOT cache snapshots or bindings itself — both layers
 * already memoise:
 *   - `plugin.bindToTenant` memoises views by `(tenantId, credentialVersion)`.
 *   - The operator's `resolveSnapshot` is expected to memoise too (the
 *     real impl reads from a secrets-store cache with TTL invalidation).
 *
 * Concurrent jobs for the same tenant therefore share the same binding
 * without this factory adding another cache layer.
 */
export interface TenantAwareBullMqWorkerHostFactoryOptions extends BullMqFactoryOptions {
	readonly deps: BullMqDeps;
	readonly plugin: BullMqJobRuntimePlugin;
	/**
	 * Optional resolver that turns a tenantId into a full
	 * {@link TenantCredentialSnapshot}. Falls back to a synthetic
	 * `{ tenantId, providerId: 'bullmq', credentialVersion: 1, credentials: {} }`
	 * when omitted — sufficient for unit tests + inherit-mode tenants
	 * where no real credential bag is stored.
	 */
	readonly resolveSnapshot?: (tenantId: string) => TenantCredentialSnapshot | Promise<TenantCredentialSnapshot>;
}

/**
 * Handler signature for tenant-aware workers — the second arg is the
 * `IJobRuntimeProvider` view bound to the job's tenant (or the plugin
 * itself for tenant-less jobs per FR-5).
 */
export type TenantAwareHandler = (job: BullMqJobView, binding: IJobRuntimeProvider) => Promise<unknown>;

interface InternalRegistration {
	readonly queueName: string;
	readonly handler: TenantAwareHandler;
	readonly concurrency?: number;
	readonly workerOpts?: Readonly<Record<string, unknown>>;
}

/**
 * Reads the per-job tenantId, preferring the BullMQ-native carrier
 * (`opts.tenantId` written by T31 `mapEnqueueOptions`) and falling back
 * to `data._ew.tenantId` for operators who stamp it on the payload
 * (pg-boss pattern — `bullmq-types.ts#BullMqJobView` doesn't type
 * `opts`, so we widen the cast).
 */
function extractTenantId(job: BullMqJobView): string | undefined {
	const opts = (job as unknown as { opts?: { tenantId?: unknown } }).opts;
	if (opts && typeof opts.tenantId === 'string' && opts.tenantId.length > 0) {
		return opts.tenantId;
	}
	const data = job.data;
	if (data && typeof data === 'object') {
		const ew = (data as { _ew?: { tenantId?: unknown } })._ew;
		if (ew && typeof ew.tenantId === 'string' && ew.tenantId.length > 0) {
			return ew.tenantId;
		}
	}
	return undefined;
}

function syntheticSnapshot(tenantId: string): TenantCredentialSnapshot {
	return {
		tenantId,
		providerId: 'bullmq',
		credentialVersion: 1,
		credentials: {}
	};
}

export class TenantAwareBullMqWorkerHostFactory {
	private readonly registrations: InternalRegistration[] = [];
	private workers: BullMqWorkerAdapter[] = [];
	private started = false;
	private readonly deps: BullMqDeps;
	private readonly plugin: BullMqJobRuntimePlugin;
	private readonly resolveSnapshot:
		| ((tenantId: string) => TenantCredentialSnapshot | Promise<TenantCredentialSnapshot>)
		| undefined;

	constructor(private readonly opts: TenantAwareBullMqWorkerHostFactoryOptions) {
		this.deps = opts.deps;
		this.plugin = opts.plugin;
		this.resolveSnapshot = opts.resolveSnapshot;
	}

	/**
	 * Register a tenant-aware worker. Mirrors {@link BullMqWorkerHostFactory.register}
	 * — throws if `start()` has already been called.
	 */
	register(
		queueName: string,
		handler: TenantAwareHandler,
		opts?: { concurrency?: number; workerOpts?: Readonly<Record<string, unknown>> }
	): this {
		if (this.started) {
			throw new Error(
				`TenantAwareBullMqWorkerHostFactory: cannot register '${queueName}' after start() — register all workers before plugin.startWorkerHost runs.`
			);
		}
		const reg: InternalRegistration = {
			queueName,
			handler,
			...(opts?.concurrency !== undefined && { concurrency: opts.concurrency }),
			...(opts?.workerOpts !== undefined && { workerOpts: opts.workerOpts })
		};
		this.registrations.push(reg);
		return this;
	}

	/**
	 * Start every registered worker. Returns a handle whose `stop()`
	 * closes every worker (idempotent). The shared connection is NOT
	 * closed — the operator owns it.
	 */
	async start(hostOpts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.started) {
			throw new Error('TenantAwareBullMqWorkerHostFactory: start() called twice — already running.');
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

			const processor = async (job: BullMqJobView): Promise<unknown> => {
				const binding = await this.resolveBinding(job);
				return reg.handler(job, binding);
			};
			return new this.deps.Worker(reg.queueName, processor, workerOpts);
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

	/**
	 * Visible for tests / metrics — the per-job routing path. Returns
	 * the plugin itself for tenant-less jobs (FR-5 fallback), otherwise
	 * the per-tenant view from `plugin.bindToTenant`.
	 */
	private async resolveBinding(job: BullMqJobView): Promise<IJobRuntimeProvider> {
		const tenantId = extractTenantId(job);
		if (!tenantId) {
			return this.plugin;
		}
		const snapshot = this.resolveSnapshot ? await this.resolveSnapshot(tenantId) : syntheticSnapshot(tenantId);
		const bound = this.plugin.bindToTenant(snapshot);
		return bound ?? this.plugin;
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
