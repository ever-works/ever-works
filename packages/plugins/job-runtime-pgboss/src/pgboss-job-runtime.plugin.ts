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
 * EW-742 P3.2 follow-up — pg-boss `IJobRuntimeProvider` plugin.
 *
 * Per ADR-017 Q2 (schema-per-tenant), `bindToTenant` extracts a
 * per-tenant Postgres schema from `snapshot.credentials.schema` (and
 * optionally a separate `connectionString` if the tenant runs against
 * a dedicated database). Stub dispatchers throw until an operator
 * wires per-payload-type publish/work handlers. See the class JSDoc on
 * {@link TemporalJobRuntimePlugin} for the rationale that applies
 * identically here.
 */

export class PgBossDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-pgboss-plugin: ${dispatcherName} is not configured. ` +
				'Subclass PgBossJobRuntimePlugin (or wrap it with a delegating provider) and ' +
				'override the dispatchers field with operator-defined pg-boss publish/work handlers ' +
				'per `docs/specs/features/tenant-job-runtime-overlay/providers.md`.'
		);
		this.name = 'PgBossDispatcherNotConfiguredError';
	}
}

export interface PgBossTenantBindingView extends IJobRuntimeProvider {
	readonly tenantSnapshot: TenantCredentialSnapshot;
	/**
	 * Per-tenant Postgres schema (ADR-017 Q2). Future dispatchers
	 * should configure `new PgBoss({ schema: tenantSchema })`.
	 */
	readonly tenantSchema: string | null;
	/**
	 * Optional per-tenant Postgres connection string. When `null` the
	 * tenant shares the instance Postgres connection.
	 */
	readonly tenantConnectionString: string | null;
}

export class PgBossJobRuntimePlugin implements IJobRuntimeProvider {
	readonly id = 'job-runtime-pgboss';
	readonly name = 'pg-boss Job Runtime';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'job-runtime';
	readonly capabilities: readonly string[] = [
		'job-runtime-enqueue',
		'job-runtime-cancel',
		'job-runtime-status',
		'job-runtime-schedule',
		'job-runtime-bind-tenant'
	];
	readonly runtimeId: JobRuntimeId = 'pgboss';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			connectionString: {
				type: 'string',
				title: 'Postgres connection string',
				description: 'pg-boss connection string, e.g. `postgres://user:pw@host:5432/db`.',
				'x-secret': true,
				'x-envVar': 'PGBOSS_CONNECTION_STRING'
			},
			schema: {
				type: 'string',
				title: 'pg-boss schema',
				description: 'Instance-default Postgres schema. Per-tenant overrides come via the credential bag.',
				'x-envVar': 'PGBOSS_SCHEMA'
			}
		}
	};

	readonly dispatchers: JobRuntimeDispatchers = new Proxy(
		{},
		{
			get(_target, prop: string): unknown {
				if (typeof prop === 'string' && prop.startsWith('dispatch')) {
					return () => {
						throw new PgBossDispatcherNotConfiguredError(prop);
					};
				}
				return undefined;
			}
		}
	);

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, PgBossTenantBindingView>();

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
		return Boolean(process.env.PGBOSS_CONNECTION_STRING);
	}

	async startWorkerHost(_opts: WorkerHostOptions): Promise<WorkerHostHandle> {
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): PgBossTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;
		const tenantSchema =
			typeof snapshot.credentials.schema === 'string' ? snapshot.credentials.schema : null;
		const tenantConnectionString =
			typeof snapshot.credentials.connectionString === 'string'
				? snapshot.credentials.connectionString
				: null;

		const view: PgBossTenantBindingView = Object.freeze({
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
			tenantSchema,
			tenantConnectionString
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
