import type {
	IJobRuntimeProvider,
	JobRunStatus,
	JobRuntimeDispatchers,
	JobRuntimeId,
	JsonSchema,
	PluginCategory,
	PluginContext,
	ScheduleSpec,
	TenantCredentialSnapshot,
	WorkerHostHandle,
	WorkerHostOptions
} from '@ever-works/plugin';
import { TemporalDispatcherFactory } from './temporal-dispatcher-factory.js';
import { TemporalWorkerHostFactory } from './temporal-worker-host-factory.js';

/**
 * EW-742 P3.2 follow-up — Temporal `IJobRuntimeProvider` plugin.
 *
 * # Operator-side wiring
 *
 *   - `useDispatchers(map)` — replace throwing stub Proxy with a real
 *     `JobRuntimeDispatchers` map (typically built via
 *     `TemporalDispatcherFactory`).
 *   - `useDispatcherFactory(factory)` — `cancel(runId)` and
 *     `getRunStatus(runId)` delegate to it (cancel + describe).
 *   - `useWorkerHostFactory(factory)` — `startWorkerHost()` actually
 *     calls `Worker.run()` on every operator-supplied Worker spec.
 *   - `dispatchersBuilder` ctor option — per-tenant routing for
 *     namespace-per-tenant (ADR-017 Q1).
 *
 * # bindToTenant
 *
 * Extracts the per-tenant Temporal namespace from
 * `snapshot.credentials.namespace`. Memoised on `(tenantId,
 * credentialVersion)` per the `IJobRuntimeProvider.bindToTenant`
 * idempotency clause.
 */

export class TemporalDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-temporal-plugin: ${dispatcherName} is not configured. ` +
				'Call plugin.useDispatchers({ ... }) with operator-supplied Temporal dispatchers ' +
				'built via TemporalDispatcherFactory (see plugin header for an example), ' +
				'or pass dispatchersBuilder when constructing the plugin for per-tenant routing.'
		);
		this.name = 'TemporalDispatcherNotConfiguredError';
	}
}

export interface TemporalTenantBindingView extends IJobRuntimeProvider {
	readonly tenantSnapshot: TenantCredentialSnapshot;
	/**
	 * Per-tenant Temporal namespace (per ADR-017 Q1
	 * namespace-per-tenant). The operator's per-tenant `WorkflowClient`
	 * is configured against this namespace.
	 */
	readonly tenantNamespace: string | null;
}

export interface TemporalJobRuntimePluginOptions {
	/** Per-tenant dispatcher builder — see plugin header. */
	readonly dispatchersBuilder?: (snapshot: TenantCredentialSnapshot) => JobRuntimeDispatchers;
}

const TEMPORAL_STATUS_TO_RUN_STATUS: Readonly<Record<string, JobRunStatus>> = {
	RUNNING: 'running',
	COMPLETED: 'completed',
	FAILED: 'failed',
	CANCELED: 'cancelled',
	TERMINATED: 'cancelled',
	TIMED_OUT: 'failed',
	CONTINUED_AS_NEW: 'running'
};

export class TemporalJobRuntimePlugin implements IJobRuntimeProvider {
	readonly id = 'job-runtime-temporal';
	readonly name = 'Temporal Job Runtime';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'job-runtime';
	readonly capabilities: readonly string[] = [
		'job-runtime-enqueue',
		'job-runtime-cancel',
		'job-runtime-status',
		'job-runtime-schedule',
		'job-runtime-bind-tenant'
	];
	readonly runtimeId: JobRuntimeId = 'temporal';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			address: {
				type: 'string',
				title: 'Temporal Address',
				description: 'gRPC endpoint, e.g. `temporal.tenant-acme.svc:7233`.',
				'x-envVar': 'TEMPORAL_ADDRESS'
			},
			namespace: {
				type: 'string',
				title: 'Temporal Namespace',
				description: 'Instance-default namespace. Per-tenant overrides come via the credential bag.',
				'x-envVar': 'TEMPORAL_NAMESPACE'
			},
			tlsCert: {
				type: 'string',
				title: 'TLS Client Cert (PEM)',
				'x-secret': true,
				'x-envVar': 'TEMPORAL_TLS_CERT'
			},
			tlsKey: {
				type: 'string',
				title: 'TLS Client Key (PEM)',
				'x-secret': true,
				'x-envVar': 'TEMPORAL_TLS_KEY'
			}
		}
	};

	private readonly stubDispatchers: JobRuntimeDispatchers = new Proxy(
		{},
		{
			get(_target, prop: string): unknown {
				if (typeof prop === 'string' && prop.startsWith('dispatch')) {
					return () => {
						throw new TemporalDispatcherNotConfiguredError(prop);
					};
				}
				return undefined;
			}
		}
	);

	private dispatchersImpl: JobRuntimeDispatchers = this.stubDispatchers;
	private workerHostFactory: TemporalWorkerHostFactory | null = null;
	private dispatcherFactory: TemporalDispatcherFactory | null = null;

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, TemporalTenantBindingView>();

	constructor(private readonly opts: TemporalJobRuntimePluginOptions = {}) {}

	get dispatchers(): JobRuntimeDispatchers {
		return this.dispatchersImpl;
	}

	useDispatchers(map: JobRuntimeDispatchers): this {
		this.dispatchersImpl = Object.freeze({ ...map });
		this.tenantViews.clear();
		return this;
	}

	useWorkerHostFactory(factory: TemporalWorkerHostFactory): this {
		this.workerHostFactory = factory;
		return this;
	}

	useDispatcherFactory(factory: TemporalDispatcherFactory): this {
		this.dispatcherFactory = factory;
		return this;
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.tenantViews.clear();
	}

	async registerSchedules(_schedules: readonly ScheduleSpec[]): Promise<void> {
		// Temporal Schedules require workflow definitions which only
		// the operator can supply. Operators that need scheduled
		// workflows wire `client.schedule.create(...)` themselves and
		// call it from their bootstrap. Left as no-op here so the
		// binding factory can call it at boot without throwing.
	}

	async cancel(runId: string): Promise<boolean> {
		if (this.dispatcherFactory) return this.dispatcherFactory.cancel(runId);
		return false;
	}

	async getRunStatus(runId: string): Promise<JobRunStatus> {
		if (!this.dispatcherFactory) return 'unknown';
		const status = await this.dispatcherFactory.describe(runId);
		if (!status) return 'unknown';
		return TEMPORAL_STATUS_TO_RUN_STATUS[status] ?? 'unknown';
	}

	isEnabled(): boolean {
		const address = process.env.TEMPORAL_ADDRESS;
		const namespace = process.env.TEMPORAL_NAMESPACE;
		return Boolean(address && namespace);
	}

	async startWorkerHost(opts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.workerHostFactory) return this.workerHostFactory.start(opts);
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): TemporalTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;
		const tenantNamespace =
			typeof snapshot.credentials.namespace === 'string'
				? snapshot.credentials.namespace
				: null;

		const dispatchersForView: JobRuntimeDispatchers = this.opts.dispatchersBuilder
			? Object.freeze({ ...this.opts.dispatchersBuilder(snapshot) })
			: base.dispatchersImpl;

		const view: TemporalTenantBindingView = Object.freeze({
			id: base.id,
			name: base.name,
			version: base.version,
			category: base.category,
			capabilities: base.capabilities,
			settingsSchema: base.settingsSchema,
			runtimeId: base.runtimeId,
			get dispatchers(): JobRuntimeDispatchers {
				return dispatchersForView;
			},
			registerSchedules: (schedules: readonly ScheduleSpec[]) =>
				base.registerSchedules(schedules),
			cancel: (runId: string) => base.cancel(runId),
			getRunStatus: (runId: string) => base.getRunStatus(runId),
			isEnabled: () => base.isEnabled(),
			startWorkerHost: (opts: WorkerHostOptions) => base.startWorkerHost(opts),
			onLoad: (context: PluginContext) => base.onLoad(context),
			onUnload: () => base.onUnload(),
			bindToTenant: (other: TenantCredentialSnapshot) => {
				if (
					other.tenantId === snapshot.tenantId &&
					other.credentialVersion === snapshot.credentialVersion
				) {
					return view;
				}
				return base.bindToTenant(other);
			},
			tenantSnapshot: snapshot,
			tenantNamespace
		});

		for (const key of this.tenantViews.keys()) {
			if (key.startsWith(`${snapshot.tenantId}:`)) {
				this.tenantViews.delete(key);
			}
		}
		this.tenantViews.set(cacheKey, view);
		return view;
	}
}
