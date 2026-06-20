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
import type { TriggerClient } from './trigger-types.js';

/**
 * EW-686 P2 — Trigger.dev `IJobRuntimeProvider` plugin (canonical
 * pluggable form).
 *
 * Peer of `BullMqJobRuntimePlugin`, `PgBossJobRuntimePlugin`,
 * `TemporalJobRuntimePlugin`, `InngestJobRuntimePlugin`. The existing
 * `TriggerJobRuntimeProvider` shim at `packages/tasks/src/trigger/`
 * stays as the operator's reference implementation (NestJS-bound,
 * directly wired into `TriggerModule`); this package is what the
 * standard plugin pipeline discovers via the `everworks.plugin`
 * manifest block in `package.json`.
 *
 * Per `providers.md` § Trigger.dev, per-tenant BYO requires per-tenant
 * Trigger.dev **projects** (the SDK is project-scoped). This plugin's
 * `bindToTenant` view surfaces the per-tenant `projectAccessToken` but
 * operators must build per-tenant `TriggerClient` instances themselves
 * and route via `dispatchersBuilder` — same per-tenant-client model as
 * the Inngest plugin.
 *
 * Operators wire real dispatchers via:
 *   - `useDispatchers(map)` — replace throwing-stub Proxy.
 *   - `useDispatcherFactory(factory)` — keep a reference to the bound
 *     `TriggerDispatcherFactory` for the operator's own access (does
 *     not auto-register dispatchers; use `useDispatchers` for that).
 *   - `dispatchersBuilder` ctor option — per-tenant routing.
 *
 * # No worker host
 *
 * Trigger.dev is push-model — Trigger.dev's cloud invokes the
 * operator's deployed task package on its own machines. There is no
 * separate worker process the API needs to start. `startWorkerHost`
 * therefore stays a no-op even when operator hooks are wired (mirrors
 * Inngest).
 */

export class TriggerDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-trigger-plugin: ${dispatcherName} is not configured. ` +
				'Call plugin.useDispatchers({ ... }) with operator-supplied Trigger.dev dispatchers ' +
				'built via TriggerDispatcherFactory (see plugin header for an example), ' +
				'or pass dispatchersBuilder when constructing the plugin for per-tenant routing.'
		);
		this.name = 'TriggerDispatcherNotConfiguredError';
	}
}

export interface TriggerTenantBindingView extends IJobRuntimeProvider {
	readonly tenantSnapshot: TenantCredentialSnapshot;
	/** Per-tenant Trigger.dev project access token (for the operator-built per-tenant client). */
	readonly tenantProjectAccessToken: string | null;
}

export interface TriggerJobRuntimePluginOptions {
	/** Per-tenant dispatcher builder — see plugin header. */
	readonly dispatchersBuilder?: (snapshot: TenantCredentialSnapshot) => JobRuntimeDispatchers;
	/**
	 * Optional default Trigger.dev client used by the plugin's own
	 * `cancel` / `getRunStatus` (so callers don't need to reach into
	 * the per-task dispatchers for these contract methods). Operators
	 * that want real cancel / status calls inject the same `{ tasks,
	 * runs }` they handed to `TriggerDispatcherFactory`.
	 *
	 * When omitted, the plugin falls back to safe defaults (`cancel`
	 * returns `false`, `getRunStatus` returns `'unknown'`) — same
	 * shape as the Inngest plugin which has no SDK-side equivalents.
	 */
	readonly client?: TriggerClient;
}

export class TriggerJobRuntimePlugin implements IJobRuntimeProvider {
	readonly id = 'job-runtime-trigger';
	readonly name = 'Trigger.dev Job Runtime';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'job-runtime';
	readonly capabilities: readonly string[] = [
		'job-runtime-enqueue',
		'job-runtime-cancel',
		'job-runtime-status',
		'job-runtime-schedule',
		'job-runtime-bind-tenant'
	];
	readonly runtimeId: JobRuntimeId = 'trigger';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			projectRef: {
				type: 'string',
				title: 'Trigger.dev Project Ref',
				description: 'Trigger.dev project reference (e.g. proj_abc123).',
				'x-envVar': 'TRIGGER_PROJECT_REF'
			},
			secretKey: {
				type: 'string',
				title: 'Trigger.dev Secret Key',
				description: 'Server-side prod secret (tr_prod_*). Used by the SDK to authenticate tasks.trigger calls.',
				'x-secret': true,
				'x-envVar': 'TRIGGER_SECRET_KEY'
			},
			apiUrl: {
				type: 'string',
				title: 'Trigger.dev API URL',
				description: 'Override for self-hosted Trigger.dev (default https://api.trigger.dev).',
				'x-envVar': 'TRIGGER_API_URL'
			}
		}
	};

	private readonly stubDispatchers: JobRuntimeDispatchers = new Proxy(
		{},
		{
			get(_target, prop: string): unknown {
				if (typeof prop === 'string' && prop.startsWith('dispatch')) {
					return () => {
						throw new TriggerDispatcherNotConfiguredError(prop);
					};
				}
				return undefined;
			}
		}
	);

	private dispatchersImpl: JobRuntimeDispatchers = this.stubDispatchers;
	private dispatcherFactory: unknown | null = null;

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, TriggerTenantBindingView>();

	constructor(private readonly opts: TriggerJobRuntimePluginOptions = {}) {}

	get dispatchers(): JobRuntimeDispatchers {
		return this.dispatchersImpl;
	}

	/**
	 * Reference to the bound `TriggerDispatcherFactory` (if any). Held
	 * loose-typed (`unknown`) so this plugin file doesn't have to
	 * import the factory class and create a circular module graph;
	 * operators that need the typed reference import the factory
	 * directly.
	 */
	get factory(): unknown | null {
		return this.dispatcherFactory;
	}

	useDispatchers(map: JobRuntimeDispatchers): this {
		this.dispatchersImpl = Object.freeze({ ...map });
		this.tenantViews.clear();
		return this;
	}

	useDispatcherFactory(factory: unknown): this {
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
		// Trigger.dev tasks self-register their cron at deploy time via
		// `schedules.task()` SDK calls in the operator's task files —
		// the `pnpm deploy:trigger` pipeline wires the cron up against
		// Trigger.dev's Schedules service. Platform-level ScheduleSpec
		// is therefore unused; no-op so the binding factory's boot path
		// doesn't throw.
	}

	async cancel(runId: string): Promise<boolean> {
		if (!this.opts.client) {
			// Mirror Inngest: without an SDK client wired the plugin
			// can't reach Trigger.dev; operators that need cancel
			// either inject the client via the `client` opt or call
			// `factory.cancel(runId)` directly through their own
			// wrapper.
			return false;
		}
		try {
			await this.opts.client.runs.cancel(runId);
			return true;
		} catch {
			return false;
		}
	}

	async getRunStatus(runId: string): Promise<JobRunStatus> {
		if (!this.opts.client) {
			return 'unknown';
		}
		try {
			const run = await this.opts.client.runs.retrieve(runId);
			return mapTriggerStatus(run.status);
		} catch {
			return 'unknown';
		}
	}

	isEnabled(): boolean {
		return Boolean(process.env.TRIGGER_SECRET_KEY);
	}

	async startWorkerHost(_opts: WorkerHostOptions): Promise<WorkerHostHandle> {
		// Trigger.dev is push-model — Trigger.dev's cloud invokes the
		// deployed task package directly. No process to start.
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): TriggerTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;
		const tenantProjectAccessToken =
			typeof snapshot.credentials.projectAccessToken === 'string'
				? snapshot.credentials.projectAccessToken
				: null;

		const dispatchersForView: JobRuntimeDispatchers = this.opts.dispatchersBuilder
			? Object.freeze({ ...this.opts.dispatchersBuilder(snapshot) })
			: base.dispatchersImpl;

		const view: TriggerTenantBindingView = Object.freeze({
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
			tenantProjectAccessToken
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

/**
 * Translate a Trigger.dev v4 SDK status string into the 6-value
 * {@link JobRunStatus} union the contract exposes. Mirrors the mapping
 * in `packages/tasks/src/trigger/trigger.service.ts` exactly so both
 * code paths (synthetic in-repo provider + canonical plugin) agree on
 * cross-provider lifecycle reads. Unknown values fall back to
 * `'unknown'` rather than throwing so a future SDK widening doesn't
 * break callers.
 */
export function mapTriggerStatus(status: string): JobRunStatus {
	switch (status) {
		// Pre-execution — task is in Trigger.dev's queue / waiting for
		// a slot / version. `WAITING` here is the queue-side wait, NOT
		// an in-task `wait.for(...)` call.
		case 'PENDING_VERSION':
		case 'QUEUED':
		case 'DEQUEUED':
		case 'WAITING':
		case 'DELAYED':
			return 'queued';

		case 'EXECUTING':
		// Synonym kept by some SDK versions — same lifecycle state.
		// eslint-disable-next-line no-fallthrough
		case 'REATTEMPTING':
			return 'running';

		case 'COMPLETED':
		case 'COMPLETED_SUCCESSFULLY':
			return 'completed';

		// Trigger.dev SDK v4 uses single-L `CANCELED`; the contract
		// uses double-L `cancelled` (matches the DB enums).
		case 'CANCELED':
			return 'cancelled';

		case 'FAILED':
		case 'CRASHED':
		case 'SYSTEM_FAILURE':
		case 'TIMED_OUT':
		case 'EXPIRED':
		case 'COMPLETED_WITH_ERRORS':
			return 'failed';

		default:
			return 'unknown';
	}
}
