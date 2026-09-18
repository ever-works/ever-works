/**
 * APW-07 T17 — `app-dependency-provision` runner (plan §7:864-888).
 *
 * Every assertion here is one line of the contract, and every one of them runs
 * through the REAL `AppDependenciesService` and the REAL
 * `AppDependencyFacadeService` over fakes for the store, the provider plugin,
 * the cipher and APW-06's two ports — so what is exercised is the shipped
 * behaviour, not a double of it:
 *
 * - **the lease** (plan §4.8:563-566) — the row is claimed before the provider
 *   is dialled, and a lease another worker holds is never dialled past;
 * - **`pending`** (plan §7:875-876) — the same kind is re-dispatched with
 *   `notBefore` / `deferUntil`, **never sleeping in the job**, at most 30 s out,
 *   and past the kind's deadline the card fails `deadlineExceeded` (FR-41)
 *   instead of scheduling a run nobody will honour;
 * - **a transient failure** (FR-43, ACC-07-20) — `clusterUnreachable` is retried
 *   3 times at 5-minute spacing before the row reads **Failed**;
 * - **a definite failure** (FR-43) — `noDefaultStorageClass` fails at once with
 *   its reason and nothing is re-dispatched;
 * - **outputs** (FR-44) — stored encrypted, `outputsVersion + 1` **only when
 *   they changed**;
 * - **`refresh`** (FR-42, FR-48) — re-reads the outputs and the backup state;
 * - **`deprovision`** (FR-45, FR-46, ACC-07-21/22) — keep → row `kept` +
 *   `app.dependency.released`; delete → row `deleted` +
 *   `app.dependency.data_deleted`.
 */

import { type AppDependencyKind, type AppDependencyTarget } from '@ever-works/contracts';
import type {
    AppDependencyContext,
    AppDependencyProvisionOutcome,
    AppDependencyProviderDescriptor,
    IAppDependencyProvider,
} from '@ever-works/plugin';
import type { WorkAppDependencyMetadata } from '../../database/repositories/work-app-dependency.repository';
import type { WorkAppDependency } from '../../entities/work-app-dependency.entity';
import { AppDependencyFacadeService } from '../../facades/app-dependency.facade';
import {
    AppDependenciesService,
    type AppDependencySpecSnapshot,
} from '../app-dependencies.service';
import {
    APP_DEPENDENCY_PROVISION_LEASE_MS,
    APP_DEPENDENCY_PROVISION_MAX_REDISPATCH_MS,
    AppDependencyProvisionRunner,
    type AppDependencyProvisionRunResult,
} from '../app-dependency-provision.runner';
import type {
    AppDependencyProvisionMode,
    AppDependencyProvisionPayload,
} from '../../tasks/app-dependency-provision.types';

/* -------------------------------------------------------------------------- *
 * A pinned clock — the deadline and the retry spacing are arithmetic, so they
 * are asserted against an instant the spec owns rather than against `Date.now()`.
 * -------------------------------------------------------------------------- */

const T0 = Date.parse('2026-09-17T09:00:00.000Z');
let clock = T0;

class ClockedService extends AppDependenciesService {
    protected nowMs(): number {
        return clock;
    }
}

class ClockedRunner extends AppDependencyProvisionRunner {
    protected nowMs(): number {
        return clock;
    }
}

const WORK_ID = '3f1c8b7e-0000-4000-8000-000000000001';
const NAMESPACE = 'ew-hello-1a2b3c4d';

/* -------------------------------------------------------------------------- *
 * Fakes — one per seam, each writing to the shared journal
 * -------------------------------------------------------------------------- */

/** A stored row with every column the runner and the service read, overridable per test. */
function row(overrides: Partial<WorkAppDependencyMetadata> = {}): WorkAppDependencyMetadata {
    return {
        id: overrides.id ?? `row-${overrides.kind ?? 'postgres'}`,
        workId: WORK_ID,
        kind: 'postgres',
        deployTarget: 'your-cluster',
        providerPluginId: 'k8s',
        providerId: 'k8s-inline-postgres',
        status: 'pending',
        statusReason: null,
        statusDetail: null,
        attempts: 0,
        declared: {},
        actualVersion: null,
        sizeGiB: 10,
        outputsVersion: 0,
        resourceRefs: null,
        inSpec: true,
        backupPolicy: 'none',
        backupState: null,
        lastBackupAt: null,
        backupCheckedAt: null,
        lastProvisionedAt: null,
        lastCheckedAt: null,
        provisionLeaseUntil: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...overrides,
    } as WorkAppDependencyMetadata;
}

/** The `work_app_dependencies` store, in memory. */
class FakeStore {
    readonly rows: Array<Record<string, unknown>> = [];

    /**
     * TypeORM's `update(criteria, patch)`. The criteria is honoured field by
     * field — the runner's lease release is a compare-and-clear on
     * (`id`, `provisionLeaseUntil`), so a fake that matched on `id` alone would
     * hide a stolen lease.
     */
    async update(
        criteria: { id: string; [column: string]: unknown },
        patch: Record<string, unknown>,
    ): Promise<unknown> {
        const found = this.rows.find((entry) =>
            Object.entries(criteria).every(([column, value]) => {
                const stored = entry[column];
                if (value instanceof Date) {
                    return stored instanceof Date && stored.getTime() === value.getTime();
                }
                return stored === value;
            }),
        );
        if (found) Object.assign(found, patch);
        return { affected: found ? 1 : 0 };
    }

    async findOne(options: { where: { id: string } }): Promise<Record<string, unknown> | null> {
        return this.rows.find((entry) => entry.id === options.where.id) ?? null;
    }

    /** The last stored row for a kind — what the assertions read. */
    stored(kind: AppDependencyKind): Record<string, unknown> | undefined {
        return [...this.rows].reverse().find((entry) => entry.kind === kind);
    }
}

/** The feature repository, over the same in-memory rows — with a real lease compare-and-set. */
class FakeRepository {
    /** Every claim the runner made, in order. */
    readonly leaseClaims: Array<{ id: string; leaseMs: number }> = [];
    /** How many times the outputs envelope was written (the `outputsVersion` bump). */
    updateOutputsCalls = 0;

    constructor(private readonly store: FakeStore) {}

    private all(): Array<WorkAppDependencyMetadata> {
        return this.store.rows as unknown as Array<WorkAppDependencyMetadata>;
    }

    async findActiveByWork(workId: string): Promise<WorkAppDependencyMetadata[]> {
        return this.all()
            .filter(
                (entry) =>
                    entry.workId === workId && !['kept', 'deleted'].includes(String(entry.status)),
            )
            .sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
    }

    async findByWorkAndKind(
        workId: string,
        kind: AppDependencyKind,
    ): Promise<WorkAppDependencyMetadata | null> {
        const candidates = this.all().filter(
            (entry) => entry.workId === workId && entry.kind === kind && entry.status !== 'deleted',
        );
        const active = candidates.find(
            (entry) => !['kept', 'deleted'].includes(String(entry.status)),
        );
        return active ?? candidates[candidates.length - 1] ?? null;
    }

    /** The parameterised compare-and-set of plan §4.8:563-566, over the pinned clock. */
    async claimLease(id: string, leaseMs: number): Promise<WorkAppDependency | null> {
        this.leaseClaims.push({ id, leaseMs });
        const found = this.all().find((entry) => entry.id === id);
        if (!found) return null;
        const until = found.provisionLeaseUntil ? new Date(found.provisionLeaseUntil).getTime() : 0;
        if (until > clock) return null;
        const claimed = { ...found, provisionLeaseUntil: new Date(clock + leaseMs) };
        Object.assign(found as unknown as Record<string, unknown>, {
            provisionLeaseUntil: claimed.provisionLeaseUntil,
        });
        return claimed as unknown as WorkAppDependency;
    }

    async markKept(id: string): Promise<boolean> {
        return this.setStatus(id, 'kept');
    }

    async markDeleted(id: string): Promise<boolean> {
        return this.setStatus(id, 'deleted');
    }

    async updateOutputs(id: string, envelope: string | null): Promise<WorkAppDependency | null> {
        this.updateOutputsCalls += 1;
        const found = this.all().find((entry) => entry.id === id);
        if (!found) return null;
        const target = found as unknown as Record<string, unknown>;
        target.outputsEncrypted = envelope;
        target.outputsVersion = Number(target.outputsVersion ?? 0) + 1;
        return found as unknown as WorkAppDependency;
    }

    private async setStatus(id: string, status: string): Promise<boolean> {
        await this.store.update({ id }, { status });
        return true;
    }
}

/** The `PluginRegistryService`, as the facade consumes it. */
class FakeRegistry {
    constructor(private readonly plugins: Array<Record<string, unknown>>) {}

    async getEnabledPluginsScoped(capability?: string): Promise<Array<Record<string, unknown>>> {
        return this.plugins.filter(
            (entry) =>
                (entry.manifest as { capabilities: string[] }).capabilities.includes(
                    capability ?? '',
                ) && entry.state === 'loaded',
        );
    }

    get(pluginId: string): Record<string, unknown> | undefined {
        return this.plugins.find((entry) => (entry.plugin as { id: string }).id === pluginId);
    }

    async isPluginEnabledForScope(): Promise<boolean> {
        return true;
    }
}

/** The provider double: one plugin, several kinds, every answer settable per test. */
interface ProviderDouble {
    plugin: IAppDependencyProvider;
    /** Every `provision` call, in order. */
    provisionCalls: Array<{ providerId: string; ctx: AppDependencyContext }>;
    /** Every `deprovision` call's options, in order. */
    deprovisionCalls: Array<Record<string, unknown>>;
    getOutputsCalls: number;
    backupStatusCalls: number;
    setOutcome(outcome: AppDependencyProvisionOutcome): void;
    setOutputs(outputs: Record<string, string>): void;
    setBackup(state: string, lastBackupAt?: string): void;
    setDeprovision(state: 'released' | 'deleted' | 'pending'): void;
}

function descriptor(id: string, kind: AppDependencyKind): AppDependencyProviderDescriptor {
    return {
        id,
        kind,
        targets: ['your-cluster', 'ever-works-apps'] as AppDependencyTarget[],
        label: id,
        preference: 10,
        backupPolicy: 'none',
    };
}

/**
 * The provider's happy-path answer. The outputs are a separate constant because
 * `packages/agent` compiles with `strictNullChecks: false`, under which a
 * discriminated union does not narrow — reading `.outputs` off the union type
 * is a compile error, which is the same reason every discriminant in this
 * epic's own code is a string the caller switches on.
 */
const READY_OUTPUTS: Record<string, string> = {
    url: 'postgres://app@dep-postgres:5432/app',
    password: 'pw',
};

const READY_OUTCOME: AppDependencyProvisionOutcome = {
    state: 'ready',
    outputs: READY_OUTPUTS,
    actualVersion: '16',
    resourceRefs: {
        namespace: NAMESPACE,
        objects: [{ kind: 'StatefulSet', name: 'dep-postgres' }],
    },
};

function providerDouble(): ProviderDouble {
    let outcome: AppDependencyProvisionOutcome = READY_OUTCOME;
    let outputs: Record<string, string> = { ...READY_OUTPUTS };
    let backup: { state: string; lastBackupAt?: string } = { state: 'none' };
    let deprovisionState: 'released' | 'deleted' | 'pending' = 'released';

    const double: ProviderDouble = {
        provisionCalls: [],
        deprovisionCalls: [],
        getOutputsCalls: 0,
        backupStatusCalls: 0,
        setOutcome(next) {
            outcome = next;
        },
        setOutputs(next) {
            outputs = next;
        },
        setBackup(state, lastBackupAt) {
            backup = lastBackupAt ? { state, lastBackupAt } : { state };
        },
        setDeprovision(state) {
            deprovisionState = state;
        },
        plugin: undefined as unknown as IAppDependencyProvider,
    };

    const plugin = {
        id: 'k8s',
        name: 'k8s',
        version: '1.0.0',
        category: 'utility',
        capabilities: ['app-dependency'],
        settingsSchema: {},
        dependencyProviders: [
            descriptor('k8s-inline-postgres', 'postgres'),
            descriptor('k8s-inline-redis', 'redis'),
        ],
        async onLoad() {},
        async onUnload() {},
        async supports() {
            return { supported: true as const, providerId: 'k8s-inline-postgres' };
        },
        async provision(providerId: string, ctx: AppDependencyContext) {
            double.provisionCalls.push({ providerId, ctx });
            return outcome;
        },
        async getOutputs() {
            double.getOutputsCalls += 1;
            return outputs;
        },
        async deprovision(_providerId: string, _ctx: unknown, opts: Record<string, unknown>) {
            double.deprovisionCalls.push(opts);
            return { state: deprovisionState };
        },
        async backupStatus() {
            double.backupStatusCalls += 1;
            return backup;
        },
    };

    double.plugin = plugin as unknown as IAppDependencyProvider;
    return double;
}

/** The cipher stand-in — an envelope prefix plus base64, never plaintext at rest. */
const cipher = {
    async encrypt(value: string): Promise<string> {
        return `enc::v1::${Buffer.from(value, 'utf8').toString('base64')}`;
    },
    async decrypt(envelope: string): Promise<string> {
        if (!envelope.startsWith('enc::v1::')) throw new Error('unprefixed');
        return Buffer.from(envelope.slice('enc::v1::'.length), 'base64').toString('utf8');
    },
};

interface Harness {
    runner: AppDependencyProvisionRunner;
    service: AppDependenciesService;
    store: FakeStore;
    repository: FakeRepository;
    provider: ProviderDouble;
    /** Every payload handed to the dispatcher, in order. */
    dispatches: AppDependencyProvisionPayload[];
    events: Array<{ name: string; payload: Record<string, unknown> }>;
    /** The clock's current instant. */
    now(): number;
    advance(ms: number): void;
}

function harness(options: {
    rows?: WorkAppDependencyMetadata[];
    /** Omit the service / the store / the dispatcher to exercise an absent seam. */
    withService?: boolean;
    withStore?: boolean;
    withDispatcher?: boolean;
    withRows?: boolean;
    withEvents?: boolean;
    snapshot?: AppDependencySpecSnapshot | null;
}): Harness {
    const store = new FakeStore();
    for (const existing of options.rows ?? []) store.rows.push({ ...existing });
    const repository = new FakeRepository(store);
    const provider = providerDouble();

    const registry = new FakeRegistry([
        {
            plugin: provider.plugin,
            manifest: { capabilities: ['app-dependency'] },
            state: 'loaded',
        },
    ]);
    const facade = new AppDependencyFacadeService(registry as never, undefined, undefined);

    const dispatches: AppDependencyProvisionPayload[] = [];
    const dispatcher =
        options.withDispatcher === false
            ? undefined
            : {
                  async dispatchAppDependencyProvision(payload: AppDependencyProvisionPayload) {
                      dispatches.push(payload);
                      return `job-${dispatches.length}`;
                  },
              };

    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const sink = {
        async emit(event: { name: string; payload: Record<string, unknown> }) {
            events.push(event);
        },
    };

    const snapshot: AppDependencySpecSnapshot =
        options.snapshot === undefined
            ? {
                  deployTarget: 'your-cluster',
                  appName: 'hello',
                  dependencies: [
                      { kind: 'postgres', declared: { version: '16' }, required: true },
                      { kind: 'redis', declared: {}, required: false },
                  ],
              }
            : (options.snapshot as AppDependencySpecSnapshot);

    const service =
        options.withService === false
            ? (undefined as unknown as AppDependenciesService)
            : new ClockedService(
                  repository as never,
                  (options.withRows === false ? undefined : store) as never,
                  facade,
                  { read: async () => snapshot },
                  dispatcher as never,
                  cipher as never,
                  {
                      async prepareDependencyTarget() {
                          return {
                              ref: {
                                  workId: WORK_ID,
                                  namespace: NAMESPACE,
                                  target: 'your-cluster' as AppDependencyTarget,
                                  kubeContext: null,
                              },
                              podLabels: { 'app.kubernetes.io/part-of': 'hello' },
                          };
                      },
                  } as never,
                  {
                      async resolveClusterAccess() {
                          return {
                              outcome: 'access' as const,
                              access: { credential: 'kubeconfig' },
                          };
                      },
                  } as never,
                  (options.withEvents === false ? undefined : sink) as never,
              );

    const runner = new ClockedRunner(
        service,
        (options.withStore === false ? undefined : repository) as never,
        dispatcher as never,
        (options.withEvents === false ? undefined : sink) as never,
        (options.withRows === false ? undefined : store) as never,
    );

    return {
        runner,
        service,
        store,
        repository,
        provider,
        dispatches,
        events,
        now: () => clock,
        advance(ms: number) {
            clock += ms;
        },
    };
}

/** Provision one named kind, with the chain starting at the current instant. */
function provision(
    h: Harness,
    kind: AppDependencyKind,
    mode: AppDependencyProvisionMode = 'provision',
    extra: Partial<AppDependencyProvisionPayload> = {},
): Promise<AppDependencyProvisionRunResult> {
    return h.runner.run({
        workId: WORK_ID,
        kind,
        mode,
        requestedAtMs: clock,
        ...extra,
    });
}

/* -------------------------------------------------------------------------- *
 * The lease
 * -------------------------------------------------------------------------- */

describe('AppDependencyProvisionRunner — the lease', () => {
    beforeEach(() => {
        clock = T0;
    });

    it("claims the row's lease before dialling the provider", async () => {
        const h = harness({ rows: [row()] });

        const result = await provision(h, 'postgres');

        expect(h.repository.leaseClaims).toEqual([
            { id: 'row-postgres', leaseMs: APP_DEPENDENCY_PROVISION_LEASE_MS },
        ]);
        expect(h.provider.provisionCalls).toHaveLength(1);
        expect(result.kinds).toEqual([{ kind: 'postgres', status: 'ready', outputsVersion: 1 }]);
    });

    it('does not dial the provider when another worker holds the lease', async () => {
        const h = harness({
            // A lease that expires a minute from the pinned instant.
            rows: [row({ provisionLeaseUntil: new Date(T0 + 60_000) })],
        });

        const result = await provision(h, 'postgres');

        expect(result.kinds).toEqual([
            { kind: 'postgres', status: 'skipped', reason: 'leaseHeld' },
        ]);
        expect(h.provider.provisionCalls).toHaveLength(0);
        expect(result.redispatch).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * A `pending` outcome — plan §7:875-876, FR-41
 * -------------------------------------------------------------------------- */

describe('AppDependencyProvisionRunner — a pending outcome', () => {
    beforeEach(() => {
        clock = T0;
    });

    it('re-dispatches the same kind with notBefore/deferUntil, never more than 30 seconds out', async () => {
        const h = harness({ rows: [row()] });
        // The provider asks for a minute; the card is polled while pending, so
        // the runner answers with the 30 s cap (plan §7:875-876).
        h.provider.setOutcome({ state: 'pending', retryAfterMs: 60_000 });

        const result = await provision(h, 'postgres');

        expect(result.kinds).toEqual([
            { kind: 'postgres', status: 'pending', notBefore: T0 + 30_000 },
        ]);
        expect(result.redispatch).toHaveLength(1);
        expect(result.redispatch[0]).toMatchObject({
            workId: WORK_ID,
            kind: 'postgres',
            mode: 'provision',
            requestedAtMs: T0,
            notBefore: T0 + APP_DEPENDENCY_PROVISION_MAX_REDISPATCH_MS,
            deferUntil: new Date(T0 + APP_DEPENDENCY_PROVISION_MAX_REDISPATCH_MS).toISOString(),
        });
        expect(h.dispatches).toEqual(result.redispatch);
        // The row is left `pending`: the run after this one is a continuation
        // of the same chain, which is what the deadline is measured against.
        expect(h.store.stored('postgres')).toMatchObject({ status: 'pending' });
    });

    it('fails deadlineExceeded, without dialling, once the deadline has passed', async () => {
        // The row is `pending` and its chain started 10 minutes ago: Postgres's
        // deadline is 10 minutes (FR-41), so this run has nothing left to spend.
        const h = harness({ rows: [row({ status: 'pending' })] });
        h.provider.setOutcome({ state: 'pending', retryAfterMs: 5_000 });
        clock = T0 + 600_000;

        const result = await provision(h, 'postgres', 'provision', { requestedAtMs: T0 });

        expect(result.kinds).toEqual([
            { kind: 'postgres', status: 'failed', reason: 'deadlineExceeded' },
        ]);
        expect(h.provider.provisionCalls).toHaveLength(0);
        expect(result.redispatch).toEqual([]);
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'failed',
            statusReason: 'deadlineExceeded',
        });
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.failed']);
        expect(h.events[0].payload).toMatchObject({
            workId: WORK_ID,
            kind: 'postgres',
            reason: 'deadlineExceeded',
        });
    });

    it('fails deadlineExceeded instead of scheduling a re-dispatch that lands past it', async () => {
        const h = harness({ rows: [row({ status: 'pending' })] });
        h.provider.setOutcome({ state: 'pending', retryAfterMs: 5_000 });
        // One second of the budget is left; the provider asks for five.
        clock = T0 + 599_000;

        const result = await provision(h, 'postgres', 'provision', { requestedAtMs: T0 });

        expect(h.provider.provisionCalls).toHaveLength(1);
        expect(result.kinds).toEqual([
            { kind: 'postgres', status: 'failed', reason: 'deadlineExceeded' },
        ]);
        expect(result.redispatch).toEqual([]);
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'failed',
            statusReason: 'deadlineExceeded',
        });
    });
});

/* -------------------------------------------------------------------------- *
 * Transient and definite failures — FR-43, ACC-07-20
 * -------------------------------------------------------------------------- */

describe('AppDependencyProvisionRunner — failures (FR-43)', () => {
    beforeEach(() => {
        clock = T0;
    });

    it('retries clusterUnreachable three times at five-minute spacing before failing with clusterUnreachable', async () => {
        const h = harness({ rows: [row()] });
        h.provider.setOutcome({
            state: 'failed',
            reason: 'clusterUnreachable',
            transient: true,
        });

        // Attempt 1 — the first retry is scheduled five minutes out.
        const first = await provision(h, 'postgres');
        expect(first.kinds).toEqual([
            {
                kind: 'postgres',
                status: 'failed',
                reason: 'clusterUnreachable',
                notBefore: T0 + 300_000,
            },
        ]);
        expect(first.redispatch[0].notBefore).toBe(T0 + 300_000);
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'provisioning',
            attempts: 1,
        });

        // Attempt 2 — five minutes later, the same outcome and the same spacing.
        h.advance(300_000);
        const second = await h.runner.run(first.redispatch[0]);
        expect(second.kinds).toEqual([
            {
                kind: 'postgres',
                status: 'failed',
                reason: 'clusterUnreachable',
                notBefore: T0 + 600_000,
            },
        ]);
        expect(second.redispatch[0].notBefore).toBe(T0 + 600_000);

        // Attempt 3 — the allowance is spent: the row reads Failed and nothing
        // is scheduled behind it (ACC-07-20's "retried 3 times over 15 minutes
        // before Failed").
        h.advance(300_000);
        const third = await h.runner.run(second.redispatch[0]);
        expect(third.kinds).toEqual([
            { kind: 'postgres', status: 'failed', reason: 'clusterUnreachable' },
        ]);
        expect(third.redispatch).toEqual([]);
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'failed',
            statusReason: 'clusterUnreachable',
            attempts: 3,
        });
        // Exactly three dials — attempts, not attempts-plus-retries.
        expect(h.provider.provisionCalls).toHaveLength(3);
        // The service records the failure event once, when the allowance is
        // spent (FR-43) — the runner adds nothing on top of it.
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.failed']);
    });

    it('fails a definite reason at once, with no re-dispatch', async () => {
        const h = harness({ rows: [row()] });
        h.provider.setOutcome({
            state: 'failed',
            reason: 'noDefaultStorageClass',
            transient: false,
        });

        const result = await provision(h, 'postgres');

        expect(result.kinds).toEqual([
            { kind: 'postgres', status: 'failed', reason: 'noDefaultStorageClass' },
        ]);
        expect(result.redispatch).toEqual([]);
        expect(h.dispatches).toEqual([]);
        expect(h.provider.provisionCalls).toHaveLength(1);
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'failed',
            statusReason: 'noDefaultStorageClass',
        });
    });
});

/* -------------------------------------------------------------------------- *
 * Outputs — FR-44
 * -------------------------------------------------------------------------- */

describe('AppDependencyProvisionRunner — outputs (FR-44)', () => {
    beforeEach(() => {
        clock = T0;
    });

    it('stores the outputs encrypted and bumps outputsVersion only when they changed', async () => {
        const h = harness({ rows: [row()] });

        await provision(h, 'postgres');

        const first = h.store.stored('postgres') as { outputsEncrypted?: string };
        expect(first.outputsEncrypted).toMatch(/^enc::v1::/);
        expect(first.outputsEncrypted).not.toContain('postgres://');
        expect(h.store.stored('postgres')).toMatchObject({ outputsVersion: 1 });
        expect(h.repository.updateOutputsCalls).toBe(1);

        // A refresh that reports the SAME outputs is a no-op for the version —
        // otherwise every poll would restart every app that derives a value
        // from them (FR-44, plan §7:876).
        const unchanged = await provision(h, 'postgres', 'refresh');
        expect(unchanged.kinds).toEqual([{ kind: 'postgres', status: 'ready', outputsVersion: 1 }]);
        expect(h.store.stored('postgres')).toMatchObject({ outputsVersion: 1 });
        expect(h.repository.updateOutputsCalls).toBe(1);

        // New outputs bump it exactly once.
        h.provider.setOutputs({ url: 'postgres://app@dep-postgres:5432/other', password: 'pw2' });
        const changed = await provision(h, 'postgres', 'refresh');
        expect(changed.kinds).toEqual([{ kind: 'postgres', status: 'ready', outputsVersion: 2 }]);
        expect(h.store.stored('postgres')).toMatchObject({ outputsVersion: 2 });
        expect(h.repository.updateOutputsCalls).toBe(2);
    });
});

/* -------------------------------------------------------------------------- *
 * Refresh — FR-42, FR-48
 * -------------------------------------------------------------------------- */

describe('AppDependencyProvisionRunner — refresh (FR-42, FR-48)', () => {
    beforeEach(() => {
        clock = T0;
    });

    it('re-reads the outputs and the backup state for a ready row', async () => {
        const h = harness({ rows: [row()] });

        // First run provisions the row (and stores its outputs), then the row
        // is refreshed: `outputsVersion` must not move on a refresh that sees
        // the same outputs (asserted in full by the FR-44 case above).
        await provision(h, 'postgres');
        h.provider.setBackup('healthy', '2026-09-17T08:00:00.000Z');
        const provisionsAfterSeed = h.provider.provisionCalls.length;

        const result = await provision(h, 'postgres', 'refresh');

        expect(result.kinds).toEqual([{ kind: 'postgres', status: 'ready', outputsVersion: 1 }]);
        // A refresh dials the provider for `getOutputs` + `backupStatus` and
        // NEVER re-provisions (FR-42).
        expect(h.provider.provisionCalls).toHaveLength(provisionsAfterSeed);
        expect(h.provider.getOutputsCalls).toBe(1);
        expect(h.provider.backupStatusCalls).toBe(1);
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'ready',
            backupState: 'healthy',
            backupCheckedAt: new Date(T0),
        });
        expect((h.store.stored('postgres') as { lastBackupAt?: Date }).lastBackupAt).toEqual(
            new Date('2026-09-17T08:00:00.000Z'),
        );
    });
});

/* -------------------------------------------------------------------------- *
 * Deprovision — FR-45, FR-46, ACC-07-21 / ACC-07-22
 * -------------------------------------------------------------------------- */

describe('AppDependencyProvisionRunner — deprovision', () => {
    beforeEach(() => {
        clock = T0;
    });

    it('keeping the data releases the dependency: row kept and app.dependency.released (ACC-07-21)', async () => {
        const h = harness({ rows: [row({ status: 'ready' })] });

        const result = await provision(h, 'postgres', 'deprovision');

        expect(result.kinds).toEqual([{ kind: 'postgres', status: 'released' }]);
        expect(h.provider.deprovisionCalls).toEqual([{ deleteData: false, stopWorkloads: true }]);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'kept' });
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.released']);
    });

    it('deleting the data records app.dependency.data_deleted and marks the row deleted (ACC-07-22)', async () => {
        // `requestDataDeletion` marks the row `deleting` before it dispatches
        // this job, which is exactly the state a real delete-data run sees.
        const h = harness({ rows: [row({ status: 'deleting' })] });
        h.provider.setDeprovision('deleted');

        const result = await provision(h, 'postgres', 'deprovision', { deleteData: true });

        expect(result.kinds).toEqual([{ kind: 'postgres', status: 'deleted' }]);
        expect(h.provider.deprovisionCalls).toEqual([{ deleteData: true }]);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'deleted' });
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.data_deleted']);
        expect(result.redispatch).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * The unspecified shapes
 * -------------------------------------------------------------------------- */

describe('AppDependencyProvisionRunner — the payload and the absent seams', () => {
    beforeEach(() => {
        clock = T0;
    });

    it('runs every active kind when the payload names none', async () => {
        const h = harness({
            rows: [
                row({ kind: 'postgres' }),
                row({ id: 'row-redis', kind: 'redis', providerId: 'k8s-inline-redis' }),
            ],
        });

        const result = await h.runner.run({
            workId: WORK_ID,
            mode: 'provision',
            requestedAtMs: T0,
        });

        expect(result.kinds.map((entry) => entry.kind)).toEqual(['postgres', 'redis']);
        expect(h.repository.leaseClaims.map((claim) => claim.id)).toEqual([
            'row-postgres',
            'row-redis',
        ]);
        expect(h.provider.provisionCalls).toHaveLength(2);
    });

    it('reports serviceUnavailable rather than dialling when the service is not bound', async () => {
        const h = harness({ rows: [row()], withService: false });

        const result = await provision(h, 'postgres');

        expect(result.reason).toBe('serviceUnavailable');
        expect(result.kinds).toEqual([]);
        expect(h.provider.provisionCalls).toHaveLength(0);
    });

    it('reports storeUnavailable rather than dialling when no lease can be claimed', async () => {
        const h = harness({ rows: [row()], withStore: false });

        const result = await provision(h, 'postgres');

        expect(result.reason).toBe('storeUnavailable');
        expect(h.provider.provisionCalls).toHaveLength(0);
    });

    it('audits a re-dispatch it cannot schedule instead of pretending it did', async () => {
        const h = harness({ rows: [row()], withDispatcher: false });
        h.provider.setOutcome({ state: 'pending', retryAfterMs: 1_000 });

        const result = await provision(h, 'postgres');

        expect(result.kinds).toEqual([
            { kind: 'postgres', status: 'pending', notBefore: T0 + 1_000 },
        ]);
        expect(result.redispatch).toEqual([]);
    });
});
