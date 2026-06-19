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
 * EW-742 P3.2 follow-up — Inngest `IJobRuntimeProvider` plugin.
 *
 * Per [`providers.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/providers.md)
 * (Inngest section), per-tenant BYO is **SaaS only**; self-host is
 * blocked at the `available-providers` admin gate because self-host
 * Inngest's signing-key isolation model isn't multi-tenant by design.
 *
 * `bindToTenant` extracts the per-tenant signing keys from
 * `snapshot.credentials.eventKey` + `snapshot.credentials.signingKey`
 * and exposes them on the view so a future dispatcher can route to
 * the right Inngest project. Stub dispatchers throw until an operator
 * wires per-payload-type Inngest functions.
 */

export class InngestDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-inngest-plugin: ${dispatcherName} is not configured. ` +
				'Subclass InngestJobRuntimePlugin (or wrap it with a delegating provider) and ' +
				'override the dispatchers field with operator-defined Inngest functions ' +
				'per `docs/specs/features/tenant-job-runtime-overlay/providers.md`.'
		);
		this.name = 'InngestDispatcherNotConfiguredError';
	}
}

export interface InngestTenantBindingView extends IJobRuntimeProvider {
	readonly tenantSnapshot: TenantCredentialSnapshot;
	/** Per-tenant Inngest event key (for `inngest.send()`). */
	readonly tenantEventKey: string | null;
	/** Per-tenant Inngest signing key (for inbound webhook verification). */
	readonly tenantSigningKey: string | null;
}

export class InngestJobRuntimePlugin implements IJobRuntimeProvider {
	readonly id = 'job-runtime-inngest';
	readonly name = 'Inngest Job Runtime';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'job-runtime';
	readonly capabilities: readonly string[] = [
		'job-runtime-enqueue',
		'job-runtime-cancel',
		'job-runtime-status',
		'job-runtime-schedule',
		'job-runtime-bind-tenant'
	];
	readonly runtimeId: JobRuntimeId = 'inngest';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			eventKey: {
				type: 'string',
				title: 'Inngest Event Key',
				description: 'Used by `inngest.send()` to publish events.',
				'x-secret': true,
				'x-envVar': 'INNGEST_EVENT_KEY'
			},
			signingKey: {
				type: 'string',
				title: 'Inngest Signing Key',
				description: 'Used to verify inbound webhook requests from Inngest.',
				'x-secret': true,
				'x-envVar': 'INNGEST_SIGNING_KEY'
			}
		}
	};

	readonly dispatchers: JobRuntimeDispatchers = new Proxy(
		{},
		{
			get(_target, prop: string): unknown {
				if (typeof prop === 'string' && prop.startsWith('dispatch')) {
					return () => {
						throw new InngestDispatcherNotConfiguredError(prop);
					};
				}
				return undefined;
			}
		}
	);

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, InngestTenantBindingView>();

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.tenantViews.clear();
	}

	async registerSchedules(_schedules: readonly ScheduleSpec[]): Promise<void> {}
	async cancel(_runId: string): Promise<boolean> {
		return false;
	}
	async getRunStatus(_runId: string): Promise<JobRunStatus> {
		return 'unknown';
	}

	isEnabled(): boolean {
		return Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY);
	}

	async startWorkerHost(_opts: WorkerHostOptions): Promise<WorkerHostHandle> {
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): InngestTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;
		const tenantEventKey =
			typeof snapshot.credentials.eventKey === 'string'
				? snapshot.credentials.eventKey
				: null;
		const tenantSigningKey =
			typeof snapshot.credentials.signingKey === 'string'
				? snapshot.credentials.signingKey
				: null;

		const view: InngestTenantBindingView = Object.freeze({
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
			tenantEventKey,
			tenantSigningKey
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
