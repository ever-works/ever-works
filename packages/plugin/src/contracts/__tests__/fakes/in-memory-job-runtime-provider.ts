import type {
	IJobRuntimeProvider,
	JobRunStatus,
	JobRuntimeDispatchers,
	JobRuntimeId,
	PluginCategory,
	PluginContext,
	ScheduleSpec,
	TenantCredentialSnapshot,
	WorkerHostHandle,
	WorkerHostOptions
} from '../../index.js';
import type { JsonSchema } from '../../../settings/json-schema.types.js';

/**
 * EW-685 / EW-742 — reference in-memory `IJobRuntimeProvider` used by
 * the conformance suite (`runJobRuntimeContractSuite`). Concrete
 * provider plugins (BullMQ, pg-boss, Temporal, Inngest, Trigger.dev)
 * import the suite + their own factory, but the suite ALSO
 * self-applies against this fake so the contract is exercised every
 * time `pnpm --filter @ever-works/plugin test` runs — a canary for
 * accidental contract drift.
 *
 * The fake holds runs in a Map; `dispatchKbEmbedDocument` returns a
 * fresh runId, `cancel`/`getRunStatus` flip the state, `bindToTenant`
 * memoises a view that surfaces the snapshot via off-spec
 * `tenantSnapshot`. No real queue / Redis / Postgres / network.
 */

interface FakeRun {
	id: string;
	status: JobRunStatus;
	enqueuedAt: number;
}

export interface InMemoryJobRuntimeProviderView extends IJobRuntimeProvider {
	readonly tenantSnapshot?: TenantCredentialSnapshot;
}

export class InMemoryJobRuntimeProvider implements InMemoryJobRuntimeProviderView {
	readonly id = 'job-runtime-in-memory';
	readonly name = 'In-memory Job Runtime (test fake)';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'job-runtime';
	readonly capabilities: readonly string[] = [
		'job-runtime-enqueue',
		'job-runtime-cancel',
		'job-runtime-status',
		'job-runtime-schedule',
		'job-runtime-bind-tenant'
	];
	// Cast: the conformance suite asserts runtimeId is one of the
	// canonical 5, but the fake isn't one of them. We use 'bullmq' as
	// the closest analogue (pull-model with no native deps).
	readonly runtimeId: JobRuntimeId = 'bullmq';

	readonly settingsSchema: JsonSchema = { type: 'object', properties: {} };

	private runs = new Map<string, FakeRun>();
	private nextId = 1;
	private tenantViews = new Map<string, InMemoryJobRuntimeProviderView>();
	private registeredScheduleIds: string[] = [];
	private context?: PluginContext;

	readonly dispatchers: JobRuntimeDispatchers = new Proxy(
		{},
		{
			get: (_t, prop: string): unknown => {
				if (typeof prop !== 'string' || !prop.startsWith('dispatch')) return undefined;
				return async (_payload: unknown): Promise<string> => {
					const id = `run_${this.nextId++}`;
					this.runs.set(id, { id, status: 'queued', enqueuedAt: Date.now() });
					return id;
				};
			}
		}
	);

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
	}
	async onUnload(): Promise<void> {
		this.context = undefined;
		this.runs.clear();
		this.tenantViews.clear();
		this.registeredScheduleIds = [];
	}

	async registerSchedules(schedules: readonly ScheduleSpec[]): Promise<void> {
		// Idempotent re-register: drop ids that survive the new list,
		// then keep only the unique latest set.
		const ids = new Set<string>();
		for (const s of schedules) ids.add(s.id);
		this.registeredScheduleIds = Array.from(ids);
	}

	async cancel(runId: string): Promise<boolean> {
		const run = this.runs.get(runId);
		if (!run) return false;
		if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
			return false;
		}
		run.status = 'cancelled';
		return true;
	}

	async getRunStatus(runId: string): Promise<JobRunStatus> {
		return this.runs.get(runId)?.status ?? 'unknown';
	}

	isEnabled(): boolean {
		return true;
	}

	async startWorkerHost(_opts: WorkerHostOptions): Promise<WorkerHostHandle> {
		return { stop: async () => undefined };
	}

	bindToTenant(snapshot: TenantCredentialSnapshot): InMemoryJobRuntimeProviderView {
		const key = `${snapshot.tenantId}:${snapshot.credentialVersion}`;
		const cached = this.tenantViews.get(key);
		if (cached) return cached;
		const base = this;
		const view: InMemoryJobRuntimeProviderView = Object.freeze({
			id: base.id,
			name: base.name,
			version: base.version,
			category: base.category,
			capabilities: base.capabilities,
			settingsSchema: base.settingsSchema,
			runtimeId: base.runtimeId,
			get dispatchers() {
				return base.dispatchers;
			},
			registerSchedules: (s: readonly ScheduleSpec[]) => base.registerSchedules(s),
			cancel: (id: string) => base.cancel(id),
			getRunStatus: (id: string) => base.getRunStatus(id),
			isEnabled: () => base.isEnabled(),
			startWorkerHost: (o: WorkerHostOptions) => base.startWorkerHost(o),
			onLoad: (c: PluginContext) => base.onLoad(c),
			onUnload: () => base.onUnload(),
			bindToTenant: (other: TenantCredentialSnapshot) => {
				if (other.tenantId === snapshot.tenantId && other.credentialVersion === snapshot.credentialVersion) {
					return view;
				}
				return base.bindToTenant(other);
			},
			tenantSnapshot: snapshot
		});
		// Evict older view for the same tenant (cache stays bounded by
		// tenant count, not version count) — matches the pattern every
		// real plugin uses.
		for (const k of this.tenantViews.keys()) {
			if (k.startsWith(`${snapshot.tenantId}:`)) this.tenantViews.delete(k);
		}
		this.tenantViews.set(key, view);
		return view;
	}

	// Test-only — lets the conformance suite reach in and check side
	// effects without exposing them on the IJobRuntimeProvider surface.
	__getScheduleIds(): readonly string[] {
		return this.registeredScheduleIds;
	}
}

export function createInMemoryJobRuntimeProvider(): InMemoryJobRuntimeProvider {
	return new InMemoryJobRuntimeProvider();
}
