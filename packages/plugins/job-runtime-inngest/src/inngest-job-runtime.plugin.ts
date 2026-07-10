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
import { InngestDispatcherFactory } from './inngest-dispatcher-factory.js';

/**
 * EW-742 P3.2 follow-up — Inngest `IJobRuntimeProvider` plugin.
 *
 * Per `providers.md` (Inngest section), per-tenant BYO is **SaaS
 * only**; self-host Inngest's signing-key isolation model isn't
 * multi-tenant by design, so this plugin's `bindToTenant` view
 * surfaces the per-tenant eventKey/signingKey but operators must
 * build per-tenant `Inngest` clients themselves.
 *
 * Operators wire real send/function pairs via:
 *   - `useDispatchers(map)` — replace throwing-stub Proxy.
 *   - `useDispatcherFactory(factory)` — surface the registered
 *     Inngest functions through `plugin.functions` for the
 *     operator's `serve({ functions })` mount.
 *   - `dispatchersBuilder` ctor option — per-tenant routing.
 *
 * # No worker host
 *
 * Inngest invokes operator-defined functions over HTTP via the
 * `serve()` handler the operator mounts. There is no separate worker
 * process. `startWorkerHost` therefore stays a no-op even when
 * operator hooks are wired — the operator's HTTP route IS the worker
 * host.
 */

export class InngestDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-inngest-plugin: ${dispatcherName} is not configured. ` +
				'Call plugin.useDispatchers({ ... }) with operator-supplied Inngest dispatchers ' +
				'built via InngestDispatcherFactory (see plugin header for an example), ' +
				'or pass dispatchersBuilder when constructing the plugin for per-tenant routing.'
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

export interface InngestJobRuntimePluginOptions {
	/** Per-tenant dispatcher builder — see plugin header. */
	readonly dispatchersBuilder?: (snapshot: TenantCredentialSnapshot) => JobRuntimeDispatchers;
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

	private readonly stubDispatchers: JobRuntimeDispatchers = new Proxy(
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

	private dispatchersImpl: JobRuntimeDispatchers = this.stubDispatchers;
	private dispatcherFactory: InngestDispatcherFactory | null = null;

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, InngestTenantBindingView>();

	constructor(private readonly opts: InngestJobRuntimePluginOptions = {}) {}

	get dispatchers(): JobRuntimeDispatchers {
		return this.dispatchersImpl;
	}

	/**
	 * Inngest functions registered through the bound factory. Operator
	 * passes these to `serve({ client, functions })` at their HTTP
	 * mount point.
	 */
	get functions(): readonly unknown[] {
		return this.dispatcherFactory?.functions ?? [];
	}

	useDispatchers(map: JobRuntimeDispatchers): this {
		this.dispatchersImpl = Object.freeze({ ...map });
		this.tenantViews.clear();
		return this;
	}

	useDispatcherFactory(factory: InngestDispatcherFactory): this {
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
		// Inngest cron schedules live on individual function defs
		// (`{ cron: '...' }` triggers). Operators wire them via
		// `factory.defineFunction(...)` directly. No-op here so the
		// binding factory's boot path doesn't throw.
	}

	async cancel(_runId: string): Promise<boolean> {
		// Inngest exposes cancellation via REST API
		// (`https://api.inngest.com/v1/runs/{id}/cancel`). The plugin
		// package doesn't ship a REST client — operators that need
		// cancellation can override this method via a thin wrapper
		// provider in their app code.
		return false;
	}

	async getRunStatus(_runId: string): Promise<JobRunStatus> {
		return 'unknown';
	}

	isEnabled(): boolean {
		return Boolean(process.env.INNGEST_EVENT_KEY && process.env.INNGEST_SIGNING_KEY);
	}

	async startWorkerHost(_opts: WorkerHostOptions): Promise<WorkerHostHandle> {
		// Inngest is a serverless dispatch model — the operator's
		// `serve()` HTTP route IS the worker host. No process to start.
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): InngestTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;
		const tenantEventKey = typeof snapshot.credentials.eventKey === 'string' ? snapshot.credentials.eventKey : null;
		const tenantSigningKey =
			typeof snapshot.credentials.signingKey === 'string' ? snapshot.credentials.signingKey : null;

		const dispatchersForView: JobRuntimeDispatchers = this.opts.dispatchersBuilder
			? Object.freeze({ ...this.opts.dispatchersBuilder(snapshot) })
			: base.dispatchersImpl;

		const view: InngestTenantBindingView = Object.freeze({
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
