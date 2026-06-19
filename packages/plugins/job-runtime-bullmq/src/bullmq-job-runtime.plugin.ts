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
import { BullMqDispatcherFactory } from './bullmq-dispatcher-factory.js';
import { BullMqWorkerHostFactory } from './bullmq-worker-host-factory.js';

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
 *   - **Operator-pluggable real dispatchers** via `useDispatchers(map)`
 *     and operator-pluggable real worker host via
 *     `useWorkerHostFactory(factory)`. See `BullMqDispatcherFactory`
 *     and `BullMqWorkerHostFactory` for the Queue/Worker glue. Until
 *     the operator wires them, every `dispatchXxx` throws
 *     `BullMqDispatcherNotConfiguredError` and `startWorkerHost`
 *     returns a no-op handle.
 *   - **Per-tenant dispatcher routing** via the `dispatchersBuilder`
 *     hook: pass a `(snapshot) => JobRuntimeDispatchers` callback and
 *     `bindToTenant` views serve dispatchers built for that tenant's
 *     prefix.
 *
 * # Operator setup
 *
 *   1. Set `EVER_WORKS_JOB_RUNTIME=bullmq` in the API env.
 *   2. Configure `BULLMQ_REDIS_URL` and `BULLMQ_QUEUE_PREFIX` (the
 *      instance default — used when no tenant overlay applies).
 *   3. For per-tenant BYO: provision tenant credentials with
 *      `{ queuePrefix: 'tenant-acme', redisUrl?: '...' }` and store
 *      via the `SECRET_STORE_RESOLVER` binding.
 *   4. In the operator's worker process: build a `BullMqDispatcherFactory`
 *      + `BullMqWorkerHostFactory` against `bullmq` (operator pins the
 *      version), register one worker per dispatcher symbol, and pass
 *      both to the plugin via `useDispatchers` / `useWorkerHostFactory`.
 */

export class BullMqDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-bullmq-plugin: ${dispatcherName} is not configured. ` +
				'Call plugin.useDispatchers({ ... }) with operator-supplied BullMQ dispatchers ' +
				'built via BullMqDispatcherFactory (see plugin header for an example), ' +
				'or pass dispatchersBuilder when constructing the plugin for per-tenant routing.'
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

export interface BullMqJobRuntimePluginOptions {
	/**
	 * Optional per-tenant dispatcher builder. When set,
	 * `bindToTenant(snapshot)` returns a view whose `dispatchers` are
	 * built via this callback (typically against a tenant-prefixed
	 * `BullMqDispatcherFactory`). When unset, all tenant views share
	 * the base dispatchers — fine for inherit-mode where the operator
	 * uses one shared Redis namespace per platform.
	 */
	readonly dispatchersBuilder?: (snapshot: TenantCredentialSnapshot) => JobRuntimeDispatchers;
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

	private readonly stubDispatchers: JobRuntimeDispatchers = new Proxy(
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

	private dispatchersImpl: JobRuntimeDispatchers = this.stubDispatchers;
	private workerHostFactory: BullMqWorkerHostFactory | null = null;
	private dispatcherFactory: BullMqDispatcherFactory | null = null;

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, BullMqTenantBindingView>();

	constructor(private readonly opts: BullMqJobRuntimePluginOptions = {}) {}

	get dispatchers(): JobRuntimeDispatchers {
		return this.dispatchersImpl;
	}

	/**
	 * Operator entry point — replace the throwing stub dispatchers with
	 * a real map built (typically) via `BullMqDispatcherFactory`.
	 * Returns `this` for chaining.
	 */
	useDispatchers(map: JobRuntimeDispatchers): this {
		this.dispatchersImpl = Object.freeze({ ...map });
		this.tenantViews.clear();
		return this;
	}

	/**
	 * Operator entry point — bind a `BullMqWorkerHostFactory` so the
	 * plugin's `startWorkerHost` actually starts BullMQ workers. The
	 * factory must have had every worker registered via
	 * `factory.register(queueName, handler)` BEFORE
	 * `plugin.startWorkerHost` is called.
	 */
	useWorkerHostFactory(factory: BullMqWorkerHostFactory): this {
		this.workerHostFactory = factory;
		return this;
	}

	/**
	 * Optional — let the plugin own a `BullMqDispatcherFactory` so
	 * `cancel(runId)` can delegate to it. Operators that build their
	 * own dispatchers without a shared factory can skip this; cancel
	 * will then return `false` for every runId.
	 */
	useDispatcherFactory(factory: BullMqDispatcherFactory): this {
		this.dispatcherFactory = factory;
		return this;
	}

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
		this.tenantViews.clear();
		if (this.dispatcherFactory) {
			await this.dispatcherFactory.close();
			this.dispatcherFactory = null;
		}
	}

	async registerSchedules(_schedules: readonly ScheduleSpec[]): Promise<void> {
		// Stub — BullMQ has its own repeat-job DSL; operator wires it.
	}

	async cancel(runId: string): Promise<boolean> {
		if (this.dispatcherFactory) {
			return this.dispatcherFactory.cancel(runId);
		}
		return false;
	}

	async getRunStatus(_runId: string): Promise<JobRunStatus> {
		return 'unknown';
	}

	isEnabled(): boolean {
		return Boolean(process.env.BULLMQ_REDIS_URL);
	}

	async startWorkerHost(opts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.workerHostFactory) {
			return this.workerHostFactory.start(opts);
		}
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

		const dispatchersForView: JobRuntimeDispatchers = this.opts.dispatchersBuilder
			? Object.freeze({ ...this.opts.dispatchersBuilder(snapshot) })
			: base.dispatchersImpl;

		const view: BullMqTenantBindingView = Object.freeze({
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
