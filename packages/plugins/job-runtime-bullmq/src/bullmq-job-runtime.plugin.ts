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
 * EW-742 P3.2 follow-up — BullMQ `IJobRuntimeProvider` plugin.
 *
 * # What this plugin ships TODAY
 *
 *   - Full `IPlugin` + `IJobRuntimeProvider` contract surface so the
 *     binding factory in `packages/agent/src/tasks/job-runtime.providers.ts`
 *     can register it alongside the Trigger.dev provider.
 *   - **Real `bindToTenant` implementation** with per-`(tenantId,
 *     credentialVersion)` memoisation. The resolved snapshot is
 *     exposed off-spec as `view.tenantSnapshot` so the T22 stamper
 *     can stamp `(providerId, credentialVersion)` onto run records.
 *   - `bindToTenant` extracts the per-tenant **Redis key prefix**
 *     from `snapshot.credentials.queuePrefix` (and the optional
 *     `redisUrl` if the tenant uses a dedicated Redis) and exposes
 *     them on the view so future dispatcher impls can route to a
 *     per-tenant queue namespace.
 *
 * # What this plugin DOES NOT ship (gated on operator demand)
 *
 *   - **Per-task queue + worker pairs**. Every `dispatchXxx` method
 *     throws `BullMqDispatcherNotConfiguredError`. Wiring real queues
 *     requires defining each `*_DISPATCHER` payload as a BullMQ Queue
 *     + Worker pair against the operator's own Redis — that's a
 *     per-deployment design decision (queue concurrency, retry
 *     policy, dead-letter strategy) that we deliberately defer to
 *     operator-owned PRs.
 *   - **`startWorkerHost`**. BullMQ is a pull-model runtime; the
 *     operator stands up their own worker process(es). The method
 *     returns a no-op handle so callers that generically "start the
 *     worker host if the provider supports it" don't branch.
 *
 * # Operator setup
 *
 *   1. Set `EVER_WORKS_JOB_RUNTIME=bullmq` in the API env.
 *   2. Configure `BULLMQ_REDIS_URL` and `BULLMQ_QUEUE_PREFIX` (the
 *      instance default — used when no tenant overlay applies).
 *   3. For per-tenant BYO: provision tenant credentials with
 *      `{ queuePrefix: 'tenant-acme', redisUrl?: '...' }` and store
 *      via the `SECRET_STORE_RESOLVER` binding.
 *   4. Implement the per-payload-type Queue + Worker pairs in your
 *      own worker process(es).
 */

export class BullMqDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-bullmq-plugin: ${dispatcherName} is not configured. ` +
				'Subclass BullMqJobRuntimePlugin (or wrap it with a delegating provider) and ' +
				'override the dispatchers field with operator-defined BullMQ Queue + Worker pairs ' +
				'per `docs/specs/features/tenant-job-runtime-overlay/providers.md`.'
		);
		this.name = 'BullMqDispatcherNotConfiguredError';
	}
}

export interface BullMqTenantBindingView extends IJobRuntimeProvider {
	readonly tenantSnapshot: TenantCredentialSnapshot;
	/**
	 * Per-tenant Redis key prefix (per ADR-017 — Redis prefix
	 * isolation per tenant worker). Future dispatchers should use
	 * this as the `prefix` option on every `new Queue(...)`.
	 */
	readonly tenantQueuePrefix: string | null;
	/**
	 * Per-tenant Redis connection URL (optional — defaults to the
	 * shared instance Redis when omitted).
	 */
	readonly tenantRedisUrl: string | null;
}

export class BullMqJobRuntimePlugin implements IJobRuntimeProvider {
	readonly id = 'job-runtime-bullmq';
	readonly name = 'BullMQ Job Runtime';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'job-runtime';
	readonly capabilities: readonly string[] = [
		'job-runtime-enqueue',
		'job-runtime-cancel',
		'job-runtime-status',
		'job-runtime-schedule',
		'job-runtime-bind-tenant'
	];
	readonly runtimeId: JobRuntimeId = 'bullmq';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			redisUrl: {
				type: 'string',
				title: 'Redis URL',
				description: 'BullMQ Redis connection string, e.g. `redis://default:pw@redis:6379`.',
				'x-secret': true,
				'x-envVar': 'BULLMQ_REDIS_URL'
			},
			queuePrefix: {
				type: 'string',
				title: 'Queue prefix',
				description: 'Instance-default Redis key prefix. Per-tenant overrides come via the credential bag.',
				'x-envVar': 'BULLMQ_QUEUE_PREFIX'
			}
		}
	};

	readonly dispatchers: JobRuntimeDispatchers = new Proxy(
		{},
		{
			get(_target, prop: string): unknown {
				if (typeof prop === 'string' && prop.startsWith('dispatch')) {
					return () => {
						throw new BullMqDispatcherNotConfiguredError(prop);
					};
				}
				return undefined;
			}
		}
	);

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, BullMqTenantBindingView>();

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.tenantViews.clear();
	}

	async registerSchedules(_schedules: readonly ScheduleSpec[]): Promise<void> {
		// Stub — BullMQ has its own repeat-job DSL; operator wires it.
	}

	async cancel(_runId: string): Promise<boolean> {
		return false;
	}

	async getRunStatus(_runId: string): Promise<JobRunStatus> {
		return 'unknown';
	}

	isEnabled(): boolean {
		return Boolean(process.env.BULLMQ_REDIS_URL);
	}

	async startWorkerHost(_opts: WorkerHostOptions): Promise<WorkerHostHandle> {
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): BullMqTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;
		const tenantQueuePrefix =
			typeof snapshot.credentials.queuePrefix === 'string'
				? snapshot.credentials.queuePrefix
				: null;
		const tenantRedisUrl =
			typeof snapshot.credentials.redisUrl === 'string'
				? snapshot.credentials.redisUrl
				: null;

		const view: BullMqTenantBindingView = Object.freeze({
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
			tenantQueuePrefix,
			tenantRedisUrl
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
