import type {
	IJobRuntimeProvider,
	TenantCredentialSnapshot,
	WorkerHostHandle,
	WorkerHostOptions
} from '@ever-works/plugin';
import type { PgBossFactoryOptions, PgBossInstance, PgBossJobView } from './pgboss-types.js';
import type { PgBossJobRuntimePlugin } from './pgboss-job-runtime.plugin.js';

/**
 * EW-742 P4 T29/T30/T32 — tenant-aware pg-boss worker host.
 *
 * Sibling of {@link import('./pgboss-worker-host-factory.js').PgBossWorkerHostFactory}
 * that routes each in-flight job to the tenant's overlay binding before
 * invoking the operator-supplied handler.
 *
 * # Why a separate factory
 *
 * pg-boss has no native tenantId carrier on its `Job` object — the T31
 * `mapEnqueueOptions` translator stamps tenantId (plus concurrencyKey /
 * tags / machineHint) onto a reserved `_ew` namespace on the payload
 * (`job.data._ew.tenantId`). The base {@link PgBossWorkerHostFactory}
 * hands `PgBossJobView` to the handler verbatim — fine for instance-
 * default workers that don't need tenant isolation. This variant adds
 * three responsibilities the base MUST NOT take on (ADR-017 §4 —
 * tenant routing is a separate concern from worker hosting):
 *
 *   1. Extract `tenantId` from `job.data._ew.tenantId` (the T31 stamping
 *      namespace).
 *   2. Resolve the tenant credential snapshot — either via the operator-
 *      supplied {@link TenantAwarePgBossWorkerHostFactoryOptions.resolveSnapshot}
 *      callback (which typically reads `tenant_job_runtime_config` +
 *      secrets) or via a synthetic empty-credentials snapshot suitable
 *      for inherit-mode tenants and unit tests.
 *   3. Call `plugin.bindToTenant(snapshot)` and pass the returned
 *      `IJobRuntimeProvider` view to the handler as `binding`. Per FR-5
 *      of the tenant-overlay spec, jobs without a tenantId fall back to
 *      the platform-default binding (the plugin singleton itself).
 *
 * # Batched workers
 *
 * pg-boss can hand the worker either a single job (`batchSize` defaults
 * to 1) or an array (when the operator configures `batchSize > 1`). To
 * keep the tenant-routing surface area minimal, this factory accepts a
 * single-job handler and iterates per job when pg-boss hands an array —
 * each entry routes through `bindToTenant` independently so a batch can
 * contain mixed tenants. Operators who need true batched handlers
 * (single call, single response array) should use the base
 * {@link PgBossWorkerHostFactory} directly and do tenant routing
 * themselves.
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
export interface TenantAwarePgBossWorkerHostFactoryOptions extends PgBossFactoryOptions {
	readonly plugin: PgBossJobRuntimePlugin;
	/**
	 * Optional resolver that turns a tenantId into a full
	 * {@link TenantCredentialSnapshot}. Falls back to a synthetic
	 * `{ tenantId, providerId: 'pgboss', credentialVersion: 1, credentials: {} }`
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
export type PgBossTenantAwareHandler = (job: PgBossJobView, binding: IJobRuntimeProvider) => Promise<unknown>;

interface InternalRegistration {
	readonly queueName: string;
	readonly handler: PgBossTenantAwareHandler;
	readonly workOptions: Readonly<Record<string, unknown>>;
}

/**
 * Reads the per-job tenantId from `data._ew.tenantId` — the namespace
 * T31 `mapEnqueueOptions` stamps onto the payload before publish (pg-boss
 * has no native `opts.tenantId` carrier, unlike BullMQ).
 */
function extractTenantId(job: PgBossJobView): string | undefined {
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
		providerId: 'pgboss',
		credentialVersion: 1,
		credentials: {}
	};
}

export class TenantAwarePgBossWorkerHostFactory {
	private readonly registrations: InternalRegistration[] = [];
	private subscriptionIds: string[] = [];
	private started = false;
	private readonly plugin: PgBossJobRuntimePlugin;
	private readonly resolveSnapshot:
		| ((tenantId: string) => TenantCredentialSnapshot | Promise<TenantCredentialSnapshot>)
		| undefined;

	constructor(private readonly opts: TenantAwarePgBossWorkerHostFactoryOptions) {
		this.plugin = opts.plugin;
		this.resolveSnapshot = opts.resolveSnapshot;
	}

	get boss(): PgBossInstance {
		return this.opts.boss;
	}

	/**
	 * Register a tenant-aware worker. Mirrors {@link PgBossWorkerHostFactory.register}
	 * — throws if `start()` has already been called.
	 */
	register(
		queueName: string,
		workOptions: Readonly<Record<string, unknown>>,
		handler: PgBossTenantAwareHandler
	): this {
		if (this.started) {
			throw new Error(
				`TenantAwarePgBossWorkerHostFactory: cannot register '${queueName}' after start() — register all workers before plugin.startWorkerHost runs.`
			);
		}
		this.registrations.push({ queueName, workOptions, handler });
		return this;
	}

	/**
	 * Start every registered worker by calling `boss.work(name, opts, h)`
	 * sequentially. Returns a handle whose `stop()` calls `boss.stop()`
	 * — pg-boss's canonical graceful-drain.
	 */
	async start(hostOpts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.started) {
			throw new Error('TenantAwarePgBossWorkerHostFactory: start() called twice — already running.');
		}
		this.started = true;

		const defaults = this.opts.defaultWorkOptions ?? {};
		const ids: string[] = [];
		for (const reg of this.registrations) {
			const merged: Record<string, unknown> = { ...defaults, ...(reg.workOptions ?? {}) };
			if (hostOpts.concurrency !== undefined && merged['teamSize'] === undefined) {
				merged['teamSize'] = hostOpts.concurrency;
			}
			const processor = async (
				jobOrJobs: PgBossJobView | readonly PgBossJobView[]
			): Promise<unknown> => {
				if (Array.isArray(jobOrJobs)) {
					const results: unknown[] = [];
					for (const j of jobOrJobs) {
						const binding = await this.resolveBinding(j);
						results.push(await reg.handler(j, binding));
					}
					return results;
				}
				const job = jobOrJobs as PgBossJobView;
				const binding = await this.resolveBinding(job);
				return reg.handler(job, binding);
			};
			const id = await this.opts.boss.work(reg.queueName, merged, processor);
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

	/**
	 * Visible for tests / metrics — the per-job routing path. Returns
	 * the plugin itself for tenant-less jobs (FR-5 fallback), otherwise
	 * the per-tenant view from `plugin.bindToTenant`.
	 */
	private async resolveBinding(job: PgBossJobView): Promise<IJobRuntimeProvider> {
		const tenantId = extractTenantId(job);
		if (!tenantId) {
			return this.plugin;
		}
		const snapshot = this.resolveSnapshot
			? await this.resolveSnapshot(tenantId)
			: syntheticSnapshot(tenantId);
		const bound = this.plugin.bindToTenant(snapshot);
		return bound ?? this.plugin;
	}

	private async stopAll(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		const ids = this.subscriptionIds;
		this.subscriptionIds = [];
		await this.opts.boss.stop({ graceful: true }).catch(() => {
			// Operator may have already stopped pg-boss; swallow.
		});
		void ids;
	}

	/** Number of registrations — useful for tests/metrics. */
	get registrationCount(): number {
		return this.registrations.length;
	}
}
