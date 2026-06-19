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

/**
 * EW-742 P3.2 follow-up — Temporal `IJobRuntimeProvider` plugin.
 *
 * # What this plugin ships TODAY
 *
 *   - Full `IPlugin` + `IJobRuntimeProvider` contract surface so the
 *     binding factory in `packages/agent/src/tasks/job-runtime.providers.ts`
 *     can register it alongside the Trigger.dev provider.
 *   - **Real `bindToTenant` implementation** with per-`(tenantId,
 *     credentialVersion)` memoisation, matching the pattern of
 *     {@link TriggerJobRuntimeProvider.bindToTenant} (#1426). The
 *     resolved snapshot is exposed off-spec as `view.tenantSnapshot`
 *     so the T22 stamper can stamp `(providerId, credentialVersion)`
 *     onto run records.
 *   - `bindToTenant` extracts the per-tenant Temporal **namespace**
 *     from `snapshot.credentials.namespace` (per ADR-017 Q1 —
 *     namespace-per-tenant) and exposes it on the view as
 *     `tenantNamespace` so a future dispatcher impl can route to it.
 *
 * # What this plugin DOES NOT ship (gated on operator demand)
 *
 *   - **Per-task workflow dispatchers**. Every `dispatchXxx` method
 *     throws a typed `TemporalDispatcherNotConfiguredError` with a
 *     clear operator-facing message. Wiring real workflows requires
 *     defining each `*_DISPATCHER` payload as a Temporal Workflow
 *     under the operator's own Temporal Cluster — that's a per-
 *     deployment design decision (workflow versioning, signal/query
 *     shape, activity decomposition) that we deliberately defer to
 *     operator-owned PRs.
 *   - **`startWorkerHost`**. Temporal is a pull-model runtime; the
 *     operator stands up their own worker process(es) against their
 *     cluster + namespace. The method returns a no-op handle so
 *     callers that generically "start the worker host if the
 *     provider supports it" don't branch.
 *
 * # Operator setup
 *
 *   1. Set `EVER_WORKS_JOB_RUNTIME=temporal` in the API env.
 *   2. Configure `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` (the
 *      instance default — used when no tenant overlay applies), and
 *      mTLS via `TEMPORAL_TLS_CERT` + `TEMPORAL_TLS_KEY`.
 *   3. For per-tenant BYO: provision tenant credentials with
 *      `{ namespace: 'tenant-acme', address?, tlsCert?, tlsKey? }`
 *      and store via the `SECRET_STORE_RESOLVER` binding (Vault,
 *      K8s, Infisical, Doppler, AWS-SM, GCP-SM, Azure-KV — all
 *      shipped as plugins).
 *   4. Implement the per-payload-type Workflows in your own worker
 *      process and either subclass this plugin to override the
 *      stub dispatchers, or wrap it with a delegating provider that
 *      ships your dispatchers.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/providers.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/providers.md) (Temporal section, ADR-017 Q1).
 */

export class TemporalDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-temporal-plugin: ${dispatcherName} is not configured. ` +
				'Subclass TemporalJobRuntimePlugin (or wrap it with a delegating provider) and ' +
				'override the dispatchers field with operator-defined Temporal workflow handlers ' +
				'per `docs/specs/features/tenant-job-runtime-overlay/providers.md`.'
		);
		this.name = 'TemporalDispatcherNotConfiguredError';
	}
}

/**
 * View extension on top of the standard {@link IJobRuntimeProvider}
 * shape for Temporal-specific binding fields.
 */
export interface TemporalTenantBindingView extends IJobRuntimeProvider {
	readonly tenantSnapshot: TenantCredentialSnapshot;
	/**
	 * Per-tenant Temporal namespace (per ADR-017 Q1
	 * namespace-per-tenant). When the operator's per-payload-type
	 * dispatchers are wired they should call `namespaces.connect()`
	 * (or equivalent) against this namespace for every dispatch.
	 */
	readonly tenantNamespace: string | null;
}

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

	/**
	 * Stub dispatchers — every method throws
	 * {@link TemporalDispatcherNotConfiguredError}. Operators override
	 * by subclassing or wrapping (see class JSDoc "Operator setup").
	 */
	readonly dispatchers: JobRuntimeDispatchers = new Proxy(
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

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, TemporalTenantBindingView>();

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.tenantViews.clear();
	}

	async registerSchedules(_schedules: readonly ScheduleSpec[]): Promise<void> {
		// Stub — Temporal Schedules require workflow definitions which
		// only the operator can supply. No-op so the binding factory
		// can call this at boot without throwing.
	}

	async cancel(_runId: string): Promise<boolean> {
		// Stub — operator-overridden via subclass / wrapper. Return
		// `false` so callers don't assume cancellation succeeded.
		return false;
	}

	async getRunStatus(_runId: string): Promise<JobRunStatus> {
		return 'unknown';
	}

	isEnabled(): boolean {
		// Temporal is enabled when an operator has wired the address +
		// namespace env vars. We don't actually attempt a connection
		// here — `isEnabled()` is called at boot; a failed connection
		// surfaces at first-dispatch time.
		const address = process.env.TEMPORAL_ADDRESS;
		const namespace = process.env.TEMPORAL_NAMESPACE;
		return Boolean(address && namespace);
	}

	async startWorkerHost(_opts: WorkerHostOptions): Promise<WorkerHostHandle> {
		// Pull-model runtime — operator runs their own worker
		// process(es). No-op handle so generic callers don't branch.
		return { stop: async () => undefined };
	}

	/**
	 * EW-742 P3.2 — per-tenant binding for Temporal namespace-per-
	 * tenant routing (ADR-017 Q1). Returns a frozen view with the
	 * snapshot + tenant namespace exposed.
	 *
	 * Memoised on `(tenantId, credentialVersion)` per the
	 * `IJobRuntimeProvider.bindToTenant` idempotency clause. On a
	 * `credentialVersion` bump the older entry is evicted in place so
	 * the cache stays bounded by tenant count.
	 */
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

		const view: TemporalTenantBindingView = Object.freeze({
			id: base.id,
			name: base.name,
			version: base.version,
			category: base.category,
			capabilities: base.capabilities,
			settingsSchema: base.settingsSchema,
			runtimeId: base.runtimeId,
			get dispatchers(): JobRuntimeDispatchers {
				return base.dispatchers;
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

		// Evict any older entry for this tenant (cache stays bounded
		// by tenant count, not version count).
		for (const key of this.tenantViews.keys()) {
			if (key.startsWith(`${snapshot.tenantId}:`)) {
				this.tenantViews.delete(key);
			}
		}
		this.tenantViews.set(cacheKey, view);
		return view;
	}
}
