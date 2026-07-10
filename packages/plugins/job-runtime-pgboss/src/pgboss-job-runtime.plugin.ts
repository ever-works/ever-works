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
import { PgBossDispatcherFactory } from './pgboss-dispatcher-factory.js';
import { PgBossWorkerHostFactory } from './pgboss-worker-host-factory.js';

/**
 * EW-742 P3.2 follow-up — pg-boss `IJobRuntimeProvider` plugin.
 *
 * Per ADR-017 Q2 (schema-per-tenant), `bindToTenant` extracts a
 * per-tenant Postgres schema from `snapshot.credentials.schema` (and
 * optionally a separate `connectionString` if the tenant runs against
 * a dedicated database).
 *
 * Operators wire real publish/work pairs via:
 *   - `useDispatchers(map)` — replace throwing-stub Proxy.
 *   - `useWorkerHostFactory(factory)` — `startWorkerHost()` registers
 *     `boss.work(...)` for every registration.
 *   - `useDispatcherFactory(factory)` — `cancel(runId)` /
 *     `getRunStatus(runId)` delegate to `boss.cancel` / `boss.getJobById`.
 *   - `dispatchersBuilder` ctor option — per-tenant routing for the
 *     schema-per-tenant pattern.
 *
 * See `PgBossDispatcherFactory` and `PgBossWorkerHostFactory` for the
 * pg-boss glue (the plugin package itself does NOT depend on `pg-boss`).
 */

export class PgBossDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-pgboss-plugin: ${dispatcherName} is not configured. ` +
				'Call plugin.useDispatchers({ ... }) with operator-supplied pg-boss dispatchers ' +
				'built via PgBossDispatcherFactory (see plugin header for an example), ' +
				'or pass dispatchersBuilder when constructing the plugin for per-tenant routing.'
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

export interface PgBossJobRuntimePluginOptions {
	/** Per-tenant dispatcher builder — see plugin header. */
	readonly dispatchersBuilder?: (snapshot: TenantCredentialSnapshot) => JobRuntimeDispatchers;
}

const PGBOSS_STATE_TO_RUN_STATUS: Readonly<Record<string, JobRunStatus>> = {
	created: 'queued',
	retry: 'queued',
	active: 'running',
	completed: 'completed',
	expired: 'failed',
	cancelled: 'cancelled',
	failed: 'failed'
};

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

	private readonly stubDispatchers: JobRuntimeDispatchers = new Proxy(
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

	private dispatchersImpl: JobRuntimeDispatchers = this.stubDispatchers;
	private workerHostFactory: PgBossWorkerHostFactory | null = null;
	private dispatcherFactory: PgBossDispatcherFactory | null = null;

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, PgBossTenantBindingView>();

	constructor(private readonly opts: PgBossJobRuntimePluginOptions = {}) {}

	get dispatchers(): JobRuntimeDispatchers {
		return this.dispatchersImpl;
	}

	useDispatchers(map: JobRuntimeDispatchers): this {
		this.dispatchersImpl = Object.freeze({ ...map });
		this.tenantViews.clear();
		return this;
	}

	useWorkerHostFactory(factory: PgBossWorkerHostFactory): this {
		this.workerHostFactory = factory;
		return this;
	}

	useDispatcherFactory(factory: PgBossDispatcherFactory): this {
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

	async registerSchedules(schedules: readonly ScheduleSpec[]): Promise<void> {
		if (!this.dispatcherFactory) return;
		const boss = this.dispatcherFactory.boss;
		if (!boss.schedule) return;
		for (const spec of schedules) {
			await boss.schedule(spec.id, spec.cron, spec.payload);
		}
	}

	async cancel(runId: string): Promise<boolean> {
		if (this.dispatcherFactory) return this.dispatcherFactory.cancel(runId);
		return false;
	}

	async getRunStatus(runId: string): Promise<JobRunStatus> {
		if (!this.dispatcherFactory) return 'unknown';
		const job = await this.dispatcherFactory.getJob(runId);
		if (!job) return 'unknown';
		return PGBOSS_STATE_TO_RUN_STATUS[job.state] ?? 'unknown';
	}

	isEnabled(): boolean {
		return Boolean(process.env.PGBOSS_CONNECTION_STRING);
	}

	async startWorkerHost(opts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.workerHostFactory) return this.workerHostFactory.start(opts);
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): PgBossTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;
		const tenantSchema = typeof snapshot.credentials.schema === 'string' ? snapshot.credentials.schema : null;
		const tenantConnectionString =
			typeof snapshot.credentials.connectionString === 'string' ? snapshot.credentials.connectionString : null;

		const dispatchersForView: JobRuntimeDispatchers = this.opts.dispatchersBuilder
			? Object.freeze({ ...this.opts.dispatchersBuilder(snapshot) })
			: base.dispatchersImpl;

		const view: PgBossTenantBindingView = Object.freeze({
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
			registerSchedules: (schedules: readonly ScheduleSpec[]) => base.registerSchedules(schedules),
			cancel: (runId: string) => base.cancel(runId),
			getRunStatus: (runId: string) => base.getRunStatus(runId),
			isEnabled: () => base.isEnabled(),
			startWorkerHost: (opts: WorkerHostOptions) => base.startWorkerHost(opts),
			onLoad: (context: PluginContext) => base.onLoad(context),
			onUnload: () => base.onUnload(),
			bindToTenant: (other: TenantCredentialSnapshot) => {
				if (other.tenantId === snapshot.tenantId && other.credentialVersion === snapshot.credentialVersion) {
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
