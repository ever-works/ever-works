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
import { FLEET_JOB_STATUS_TO_RUN_STATUS } from './node-types.js';
import { NodeDispatcherFactory } from './node-dispatcher-factory.js';
import { NodeWorkerHostFactory } from './node-worker-host-factory.js';

/**
 * Desktop PRD §6.2 / M4 — the `node` `IJobRuntimeProvider`.
 *
 * **The queue is the fleet.** Every sibling runtime wraps an external
 * broker (Redis, Postgres, Temporal, a SaaS endpoint); this one wraps
 * the machines the owner enrolled in Fleet. `enqueue` writes a
 * lease-able `fleet_jobs` row, enrolled nodes poll for it over the same
 * outbound-only HTTP channel enrollment and heartbeat already use, and
 * results come back the same way. No inbound port is ever opened on a
 * user's machine.
 *
 * It implements the SAME contract as bullmq / pgboss / temporal /
 * trigger / inngest, so the existing selection paths pick it up with no
 * special-casing:
 *   - `EVER_WORKS_JOB_RUNTIME=node` (instance selector);
 *   - the tenant overlay (`tenant_job_runtime_config.providerId` is a
 *     deliberate `varchar(64)`, so `node` needs zero schema changes);
 *   - the operator allow-list;
 *   - the Job Runtime settings page and the desktop installer's runtime
 *     picker, both of which enumerate the family.
 *
 * Operators wire the real store/transport via:
 *   - `useDispatcherFactory(factory)` — `enqueue`/`cancel`/`getRunStatus`
 *     delegate to the fleet job store.
 *   - `useWorkerHostFactory(factory)` — `startWorkerHost()` runs the
 *     lease → execute → report loop (the in-process host; a headless
 *     `apps/node` install runs the standalone equivalent).
 *
 * ## Scheduling
 *
 * `registerSchedules` is intentionally a no-op. Recurrence on this
 * platform is owned by the platform's own cron surface, and a fleet of
 * intermittently-online consumer machines is the wrong place to anchor
 * a wall-clock schedule: the node that happens to be awake at 04:00
 * would silently become the only one that ever fires. Fleet jobs are
 * enqueued BY those schedules, not registered with the fleet.
 *
 * ## Tenancy
 *
 * `bindToTenant` returns a view whose enqueues are attributed to the
 * tenant. There is no per-tenant broker to swap — isolation is
 * structural: a node only ever sees its OWN owner's queued work, which
 * is enforced server-side by the lease query, not by a credential bag.
 */

export class NodeDispatcherNotConfiguredError extends Error {
	constructor(dispatcherName: string) {
		super(
			`@ever-works/job-runtime-node-plugin: ${dispatcherName} is not configured. ` +
				'Call plugin.useDispatchers({ ... }) with operator-supplied dispatchers built via ' +
				'NodeDispatcherFactory (see the plugin header for an example), or pass ' +
				'dispatchersBuilder when constructing the plugin for per-tenant routing.'
		);
		this.name = 'NodeDispatcherNotConfiguredError';
	}
}

export interface NodeTenantBindingView extends IJobRuntimeProvider {
	readonly tenantSnapshot: TenantCredentialSnapshot;
	/**
	 * Tenant every enqueue through this view is attributed to. Node-side
	 * isolation is structural (a node sees only its owner's work), so
	 * this is an attribution key, not a credential.
	 */
	readonly tenantId: string;
}

export interface NodeJobRuntimePluginOptions {
	/** Per-tenant dispatcher builder — see plugin header. */
	readonly dispatchersBuilder?: (snapshot: TenantCredentialSnapshot) => JobRuntimeDispatchers;
}

export class NodeJobRuntimePlugin implements IJobRuntimeProvider {
	readonly id = 'job-runtime-node';
	readonly name = 'Fleet Node Job Runtime';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'job-runtime';
	readonly capabilities: readonly string[] = [
		'job-runtime-enqueue',
		'job-runtime-cancel',
		'job-runtime-status',
		'job-runtime-schedule',
		'job-runtime-worker-host',
		'job-runtime-bind-tenant'
	];
	readonly runtimeId: JobRuntimeId = 'node';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiUrl: {
				type: 'string',
				title: 'Platform API URL',
				description:
					'Origin the nodes poll for work, e.g. `https://api.ever.works`. Nodes connect outbound only — no inbound port is opened on the machine.',
				'x-envVar': 'FLEET_NODE_API_URL'
			},
			leaseTtlSeconds: {
				type: 'number',
				title: 'Lease TTL (seconds)',
				description:
					'How long a node holds a claim before it must renew. A node that dies mid-job has its work reclaimed after this window.',
				'x-envVar': 'FLEET_NODE_LEASE_TTL_SECONDS'
			},
			requiredCapabilities: {
				type: 'string',
				title: 'Required capability tags',
				description:
					'Comma-separated tags a node must advertise to be eligible for this tenant’s work (e.g. `workspace,git`). Blank means any enrolled node.',
				'x-envVar': 'FLEET_NODE_REQUIRED_CAPABILITIES'
			},
			agentTaskCommand: {
				type: 'string',
				title: 'Agent task command',
				description:
					'Command a node runs for one `agent-task` job. Supports `{taskId}`, `{runId}` and `{agentId}` placeholders. A fleet node has no model access, so this is what running the agent HERE actually means; leaving it blank makes a dispatched run fail on the node naming this setting rather than silently succeeding at nothing.',
				'x-envVar': 'FLEET_NODE_AGENT_TASK_COMMAND'
			},
			agentTaskWorkspace: {
				type: 'string',
				title: 'Agent task workspace',
				description:
					'Absolute directory ON THE NODE that `agent-task` steps run in. Blank lets the node use its own working directory.',
				'x-envVar': 'FLEET_NODE_AGENT_TASK_WORKSPACE'
			},
			agentTaskEnvPassthrough: {
				type: 'string',
				title: 'Agent task credential env names',
				description:
					'Comma-separated environment variable NAMES an `agent-task` step may read from the node’s own environment. A node drops secret-shaped names unless granted, so without this a machine whose Claude or Codex credential lives in an environment variable authenticates with nothing. Only the NAME travels — the value is read on the node and never leaves it, which is why one list works for a fleet of differently-credentialled machines: granting a name a machine does not set is a no-op. Blank inherits the default (the four well-known Claude/Codex names); set it to a single space to grant none.',
				'x-envVar': 'FLEET_NODE_AGENT_TASK_ENV_PASSTHROUGH'
			}
		}
	};

	private readonly stubDispatchers: JobRuntimeDispatchers = new Proxy(
		{},
		{
			get(_target, prop: string): unknown {
				if (typeof prop === 'string' && prop.startsWith('dispatch')) {
					return () => {
						throw new NodeDispatcherNotConfiguredError(prop);
					};
				}
				return undefined;
			}
		}
	);

	private dispatchersImpl: JobRuntimeDispatchers = this.stubDispatchers;
	private workerHostFactory: NodeWorkerHostFactory | null = null;
	private dispatcherFactory: NodeDispatcherFactory | null = null;

	private context?: PluginContext;
	private readonly tenantViews = new Map<string, NodeTenantBindingView>();

	constructor(private readonly opts: NodeJobRuntimePluginOptions = {}) {}

	get dispatchers(): JobRuntimeDispatchers {
		return this.dispatchersImpl;
	}

	useDispatchers(map: JobRuntimeDispatchers): this {
		this.dispatchersImpl = Object.freeze({ ...map });
		this.tenantViews.clear();
		return this;
	}

	useWorkerHostFactory(factory: NodeWorkerHostFactory): this {
		this.workerHostFactory = factory;
		return this;
	}

	useDispatcherFactory(factory: NodeDispatcherFactory): this {
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

	/**
	 * No-op by design — see the plugin header. Recurrence stays on the
	 * platform's own cron; a fleet of intermittently-online machines is
	 * the wrong anchor for a wall-clock schedule.
	 */
	async registerSchedules(_schedules: readonly ScheduleSpec[]): Promise<void> {
		return undefined;
	}

	async cancel(runId: string): Promise<boolean> {
		if (this.dispatcherFactory) return this.dispatcherFactory.cancel(runId);
		return false;
	}

	async getRunStatus(runId: string): Promise<JobRunStatus> {
		if (!this.dispatcherFactory) return 'unknown';
		const job = await this.dispatcherFactory.getJob(runId);
		if (!job) return 'unknown';
		return FLEET_JOB_STATUS_TO_RUN_STATUS[job.status] ?? 'unknown';
	}

	/**
	 * Enabled once an operator has wired a dispatcher factory (the fleet
	 * job store), or explicitly via `FLEET_NODE_RUNTIME_ENABLED`. Unlike
	 * the broker-backed runtimes there is no connection string to probe
	 * — the "broker" is the platform's own database.
	 */
	isEnabled(): boolean {
		if (process.env.FLEET_NODE_RUNTIME_ENABLED === 'false') return false;
		return this.dispatcherFactory !== null || process.env.FLEET_NODE_RUNTIME_ENABLED === 'true';
	}

	async startWorkerHost(opts: WorkerHostOptions = {}): Promise<WorkerHostHandle> {
		if (this.workerHostFactory) return this.workerHostFactory.start(opts);
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): NodeTenantBindingView {
		const cacheKey = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(cacheKey);
		if (cached) {
			return cached;
		}

		const base = this;
		const dispatchersForView: JobRuntimeDispatchers = this.opts.dispatchersBuilder
			? Object.freeze({ ...this.opts.dispatchersBuilder(snapshot) })
			: base.dispatchersImpl;

		const view: NodeTenantBindingView = Object.freeze({
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
			startWorkerHost: (hostOpts: WorkerHostOptions) => base.startWorkerHost(hostOpts),
			onLoad: (context: PluginContext) => base.onLoad(context),
			onUnload: () => base.onUnload(),
			bindToTenant: (other: TenantCredentialSnapshot) => {
				if (other.tenantId === snapshot.tenantId && other.credentialVersion === snapshot.credentialVersion) {
					return view;
				}
				return base.bindToTenant(other);
			},
			tenantSnapshot: snapshot,
			tenantId: snapshot.tenantId
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
