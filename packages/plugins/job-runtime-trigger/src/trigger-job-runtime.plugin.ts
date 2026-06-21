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
 * Default Trigger.dev SaaS API endpoint. Kept in sync with the schema
 * default on {@link TriggerJobRuntimePlugin.settingsSchema}.`apiUrl`
 * — change BOTH if the SaaS endpoint moves.
 */
export const DEFAULT_TRIGGER_API_URL = 'https://api.trigger.dev';

/**
 * Tenant-supplied Trigger.dev credentials, as they live inside
 * {@link TenantCredentialSnapshot.credentials} for `byo` / `override`
 * modes. The shape is data-only (jsonb at rest, no migration); the
 * validator at `bindToTenant` enforces presence of the three required
 * fields.
 */
export interface TriggerTenantCredentials {
	/** Trigger.dev Personal Access Token (`tr_pat_*`). */
	readonly accessToken: string;
	/** Project-scoped secret (`tr_dev_*` / `tr_prod_*`). */
	readonly secretKey: string;
	/** Trigger.dev project ref (`proj_*`). */
	readonly projectRef: string;
	/**
	 * Optional API endpoint override — defaults to
	 * {@link DEFAULT_TRIGGER_API_URL}. Operators of self-hosted
	 * Trigger.dev point this at their own deployment.
	 */
	readonly apiUrl?: string;
}

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
	/**
	 * Per-tenant Trigger.dev SDK client when the snapshot carried a full
	 * {@link TriggerTenantCredentials} bag AND the plugin was constructed
	 * with a `clientFactory`. `null` for `inherit` mode (no credentials
	 * present), malformed credentials, or when the operator didn't wire a
	 * `clientFactory` — callers must then dispatch through the platform-
	 * default `client` instead.
	 */
	readonly tenantClient: TriggerClient | null;
}

export interface TriggerJobRuntimePluginOptions {
	/**
	 * Per-tenant dispatcher builder — operator escape hatch when they
	 * want to swap MORE than just the SDK client (e.g. per-tenant queues,
	 * per-tenant tag prefixes). When present, this takes precedence over
	 * the `clientFactory` auto-wiring below.
	 *
	 * Receives the bound `TriggerClient` (if `clientFactory` resolved
	 * one) so the builder can reuse it instead of constructing yet
	 * another client. Falls through to the platform default
	 * `dispatchers` if the builder returns `undefined`.
	 */
	readonly dispatchersBuilder?: (
		snapshot: TenantCredentialSnapshot,
		tenantClient: TriggerClient | null
	) => JobRuntimeDispatchers | undefined;
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
	/**
	 * EW-742 P3.2 T22 — operator-supplied factory that turns a tenant's
	 * credential bag into a per-tenant `TriggerClient`. Invoked by
	 * `bindToTenant` when the snapshot carries a full
	 * {@link TriggerTenantCredentials} payload (BYO / override modes).
	 *
	 * Operator implementation typically constructs a fresh Trigger.dev
	 * SDK client against `credentials.apiUrl ?? DEFAULT_TRIGGER_API_URL`
	 * with `credentials.accessToken` for management calls and
	 * `credentials.secretKey` for the task dispatch path — same SDK
	 * surface (`{ tasks, runs }`) the platform-default `client` exposes.
	 *
	 * When omitted, BYO / override snapshots fall through to the
	 * platform-default behaviour and the plugin logs a warn — operators
	 * who want true BYO MUST wire this hook (the plugin can't take a
	 * hard dependency on `@trigger.dev/sdk` itself; see `trigger-types.ts`).
	 */
	readonly clientFactory?: (credentials: TriggerTenantCredentials) => TriggerClient;
	/**
	 * Optional per-credential-bundle dispatcher builder. Same role as
	 * {@link dispatchersBuilder} but receives the per-tenant
	 * `TriggerClient` directly — operators who only need to swap the
	 * SDK client (not the dispatcher shape) wire `clientFactory` +
	 * `dispatchersFromClient` instead of the more general
	 * `dispatchersBuilder`.
	 */
	readonly dispatchersFromClient?: (client: TriggerClient) => JobRuntimeDispatchers;
	/**
	 * Optional logger sink for warnings about missing / malformed tenant
	 * credentials. Defaults to `console.warn` so the plugin works without
	 * a NestJS logger context, but operators inside the API typically
	 * inject `Logger.warn.bind(new Logger('TriggerJobRuntimePlugin'))`.
	 */
	readonly logger?: { warn(message: string): void };
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

	/**
	 * Tenant-overlay settings schema (EW-742). Three modes:
	 *
	 *   - `inherit`  — use the platform's shared Trigger.dev project +
	 *                  credentials (operator-supplied via env / global
	 *                  plugin settings). The `accessToken` /
	 *                  `secretKey` / `projectRef` fields are ignored.
	 *                  Default for every tenant.
	 *   - `byo`      — tenant brings their own Trigger.dev SaaS account.
	 *                  All three credential fields below are REQUIRED.
	 *   - `override` — same shape as `byo`; semantically "I am replacing
	 *                  the platform default with my own". Validation is
	 *                  identical.
	 *
	 * Credential fields are stamped `x-scope: 'tenant'` so the
	 * tenant-overlay settings UI surfaces them per-tenant rather than
	 * globally, and `x-secret: true` so they never appear in plaintext
	 * read-back endpoints (the platform stores them via the encrypted
	 * secrets envelope per `settings-system.md` §5).
	 *
	 * `apiUrl` default (`https://api.trigger.dev`) is encoded in the
	 * schema AND in `DEFAULT_TRIGGER_API_URL` below — keep both in sync
	 * if either changes.
	 */
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			mode: {
				type: 'string',
				enum: ['inherit', 'byo', 'override'],
				default: 'inherit',
				title: 'Tenant Mode',
				description:
					'Tenant overlay mode. `inherit` uses the platform default; `byo` / `override` use the tenant credentials below.'
			},
			accessToken: {
				type: 'string',
				title: 'Trigger.dev Personal Access Token (PAT)',
				description:
					'Tenant-supplied management PAT (tr_pat_*). Required when mode is `byo` or `override`.',
				'x-secret': true,
				'x-scope': 'tenant'
			},
			secretKey: {
				type: 'string',
				title: 'Trigger.dev Secret Key',
				description:
					'Project-scoped server secret (tr_dev_* or tr_prod_*). Used by the SDK to authenticate tasks.trigger calls. Required when mode is `byo` or `override`; in `inherit` mode the operator default (TRIGGER_SECRET_KEY) is used.',
				'x-secret': true,
				'x-scope': 'tenant',
				'x-envVar': 'TRIGGER_SECRET_KEY'
			},
			projectRef: {
				type: 'string',
				title: 'Trigger.dev Project Ref',
				description:
					'Trigger.dev project reference (e.g. proj_abc123). Required when mode is `byo` or `override`.',
				'x-scope': 'tenant',
				'x-envVar': 'TRIGGER_PROJECT_REF'
			},
			apiUrl: {
				type: 'string',
				title: 'Trigger.dev API URL',
				description:
					'Override for self-hosted Trigger.dev (default https://api.trigger.dev).',
				default: 'https://api.trigger.dev',
				'x-scope': 'tenant',
				'x-envVar': 'TRIGGER_API_URL'
			}
		},
		allOf: [
			{
				// When mode is `byo` or `override`, all three credential fields are
				// REQUIRED. JSON Schema `if/then` keyed off the `mode` discriminator.
				if: {
					properties: { mode: { enum: ['byo', 'override'] } },
					required: ['mode']
				},
				then: { required: ['accessToken', 'secretKey', 'projectRef'] }
			}
		]
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

	/**
	 * EW-742 P3.2 T22 — per-tenant Trigger.dev binding (BYO / override
	 * support).
	 *
	 * Three observable behaviours based on the snapshot's credential bag:
	 *
	 *   1. **Inherit semantic** (no `credentials` keys recognised) —
	 *      returns a frozen view of THIS provider with the snapshot
	 *      captured. The view's `dispatchers` delegate to the
	 *      platform-default `dispatchersImpl`; `tenantClient` is `null`;
	 *      `tenantProjectAccessToken` is `null`. Byte-identical to the
	 *      pre-T22 path for any tenant that hasn't opted into BYO.
	 *
	 *   2. **BYO / override happy-path** (`accessToken` + `secretKey` +
	 *      `projectRef` all present AND a `clientFactory` is wired) —
	 *      builds a per-tenant `TriggerClient` via
	 *      {@link TriggerJobRuntimePluginOptions.clientFactory}, surfaces
	 *      it on `tenantClient`, and routes the view's `dispatchers`
	 *      through it (via `dispatchersFromClient` if provided,
	 *      `dispatchersBuilder` if provided, else the platform default).
	 *      The platform-default `dispatchersImpl` is NEVER mutated —
	 *      `inherit` mode for other tenants stays byte-identical.
	 *
	 *   3. **Malformed credentials / no factory** — logs a warn naming
	 *      the missing field (or "no clientFactory wired") and returns
	 *      the inherit-shaped view as a fail-open. Operators see the
	 *      warn in stdout; in-flight runs keep working against the
	 *      platform default rather than failing the dispatch loudly at
	 *      bind time (network at bind-time is fragile — the first
	 *      dispatch through wrong credentials is the right place for
	 *      loud failure).
	 *
	 * Memoisation: cached by `(tenantId, credentialVersion)`; bumping
	 * the version evicts and replaces the previous entry. Cache stays
	 * bounded by tenant count per the {@link IJobRuntimeProvider}
	 * contract idempotency guarantee.
	 */
	bindToTenant(snapshot: TenantCredentialSnapshot): TriggerTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;

		// EW-742 P3.2 T22 — resolve per-tenant Trigger.dev SDK client.
		// `extractTenantCredentials` validates the bag shape; missing
		// fields → null + a fail-open warn. `clientFactory` produces the
		// actual `{ tasks, runs }` client; without it, we still surface
		// the validated credentials on `tenantProjectAccessToken` so
		// operators can build a client downstream.
		const tenantCredentials = this.extractTenantCredentials(snapshot);
		const tenantClient: TriggerClient | null =
			tenantCredentials && this.opts.clientFactory
				? this.safeBuildClient(snapshot, tenantCredentials)
				: null;

		// The PAT we surface for the operator-built per-tenant client.
		// Back-compat: snapshots that used the historical
		// `projectAccessToken` key keep working — the conformance suite
		// at `__tests__/trigger-tenant-conformance.spec.ts` exercises
		// that path.
		const tenantProjectAccessToken =
			tenantCredentials?.accessToken ??
			(typeof snapshot.credentials.projectAccessToken === 'string'
				? snapshot.credentials.projectAccessToken
				: null);

		// Dispatcher selection precedence:
		//   1. operator's full `dispatchersBuilder(snapshot, tenantClient)`
		//      (most flexible — can swap queues, tags, etc.);
		//   2. `dispatchersFromClient(tenantClient)` when a per-tenant
		//      client was constructed;
		//   3. platform-default `dispatchersImpl` (inherit semantic).
		let dispatchersForView: JobRuntimeDispatchers = base.dispatchersImpl;
		if (this.opts.dispatchersBuilder) {
			const built = this.opts.dispatchersBuilder(snapshot, tenantClient);
			if (built) {
				dispatchersForView = Object.freeze({ ...built });
			}
		} else if (tenantClient && this.opts.dispatchersFromClient) {
			dispatchersForView = Object.freeze({
				...this.opts.dispatchersFromClient(tenantClient)
			});
		}

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
			tenantProjectAccessToken,
			tenantClient
		});

		for (const key of this.tenantViews.keys()) {
			if (key.startsWith(`${snapshot.tenantId}:`)) {
				this.tenantViews.delete(key);
			}
		}
		this.tenantViews.set(cacheKey, view);
		return view;
	}

	/**
	 * Validate the snapshot's `credentials` bag against the
	 * {@link TriggerTenantCredentials} shape. Returns the typed bundle
	 * on success; `null` (with a fail-open warn) when ANY required field
	 * is missing or non-string.
	 *
	 * Inherit-shaped snapshots (empty `credentials`, or only the legacy
	 * `projectAccessToken` key from earlier T21 wiring) intentionally
	 * return `null` WITHOUT a warn — they're the dominant path and noise
	 * here would drown the actually-actionable BYO misconfigurations.
	 * The warn fires only when there's at least one Trigger.dev-shaped
	 * key but the bundle is incomplete.
	 */
	private extractTenantCredentials(
		snapshot: TenantCredentialSnapshot
	): TriggerTenantCredentials | null {
		const bag = snapshot.credentials;
		const accessToken = typeof bag.accessToken === 'string' ? bag.accessToken : null;
		const secretKey = typeof bag.secretKey === 'string' ? bag.secretKey : null;
		const projectRef = typeof bag.projectRef === 'string' ? bag.projectRef : null;
		const apiUrl = typeof bag.apiUrl === 'string' ? bag.apiUrl : undefined;

		// Pure inherit case — no Trigger.dev-shaped keys at all. Silent.
		if (!accessToken && !secretKey && !projectRef) {
			return null;
		}

		// Partial bag — at least one field present but not all three.
		// This is operator misconfiguration: warn loudly so it's visible,
		// then fail-open to the platform default.
		if (!accessToken || !secretKey || !projectRef) {
			const missing = [
				!accessToken && 'accessToken',
				!secretKey && 'secretKey',
				!projectRef && 'projectRef'
			]
				.filter(Boolean)
				.join(', ');
			this.warn(
				`bindToTenant(tenantId=${snapshot.tenantId}, v=${snapshot.credentialVersion}): ` +
					`malformed BYO credentials — missing ${missing}. Falling back to platform default.`
			);
			return null;
		}

		return apiUrl !== undefined
			? { accessToken, secretKey, projectRef, apiUrl }
			: { accessToken, secretKey, projectRef };
	}

	/**
	 * Wrap the `clientFactory` call in a try/catch so a misbehaving
	 * operator factory (throws on construction, returns wrong shape)
	 * doesn't crash the whole bind. On failure we fall open to the
	 * platform default and warn — same shape as the missing-field path.
	 */
	private safeBuildClient(
		snapshot: TenantCredentialSnapshot,
		credentials: TriggerTenantCredentials
	): TriggerClient | null {
		try {
			return this.opts.clientFactory!(credentials);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.warn(
				`bindToTenant(tenantId=${snapshot.tenantId}, v=${snapshot.credentialVersion}): ` +
					`clientFactory threw — ${reason}. Falling back to platform default.`
			);
			return null;
		}
	}

	/**
	 * Route warns through the operator-supplied logger when present,
	 * otherwise `console.warn`. Kept private so the rest of the file
	 * doesn't have to know about the optionality.
	 */
	private warn(message: string): void {
		const target =
			this.opts.logger ??
			({
				warn: (m: string) => console.warn(`[@ever-works/job-runtime-trigger-plugin] ${m}`)
			} as const);
		target.warn(message);
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
