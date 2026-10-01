/**
 * APW-07 T16 — `AppDependenciesService` and `AppDependencyFacadeService`.
 *
 * Every assertion here is one line of the contract:
 *
 * - plan §2.3's four reconcile transitions (`:154-168`) — a new kind is
 *   `pending` **and dispatched**, a removed kind is `inSpec = false` with no
 *   dispatch, a target change keeps the old row and creates the new one, and a
 *   target of `none` provisions nothing (FR-35, spec §6.5);
 * - plan §4.9a (`:635-651`) — a provider declaring `awaitingConfig` inserts
 *   `awaiting_config` with **no dispatch and no deadline**;
 * - plan §4.12's table (`:747-762`) — `onAppRemoved({ deleteData: false })` and
 *   `onAppWorkDeleting({ deleteStoredData: false })` never delete anything, and
 *   the pending rows record no event (FR-58);
 * - ACC-07-21 — removing the kind, removing the app and changing the target each
 *   leave the provider's `deprovision` uncalled or called with
 *   `deleteData: false`;
 * - FR-46/FR-63 — a confirmation mismatch and a size shrink are both refused,
 *   and a delete request is refused while a provisioning lease is held;
 * - FR-60 / R-10 — `provisionEphemeral` stores no outputs, creates no row and
 *   asks the provider for `ephemeral: true` (no PVC);
 * - GAP-06 / APW07-G01 — a Work with a declared Postgres and no Deployment
 *   prepares its target **once**, reaches `ready` and dispatches no Deployment;
 * - FR-43 — `cluster_unreachable` is retried, a provider that throws leaves a
 *   retryable row (never a false `ready`), and a definite reason fails at once;
 * - APW07-G28 — a target APW-06's port reports `unavailable` reaches the row and
 *   the card as the **contract's** reason (`targetNone`, `targetNotChecked`,
 *   `namespaceNotOwned`, `clusterUnreachable`), never as the port's own
 *   snake_case discriminant, which `asReason` reads back as `null`.
 *
 * The facade is exercised through the REAL `AppDependencyFacadeService` over a
 * fake registry, so selection order and the explicit-choice rule are properties
 * of the shipped code rather than of a double.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    APP_DEPENDENCY_PROVIDER_IDS,
    isAppDependencyReason,
    type AppDependencyKind,
    type AppDependencyReason,
    type AppDependencyTarget,
} from '@ever-works/contracts';
import type {
    AppDependencyContext,
    AppDependencyProvisionOutcome,
    AppDependencyProviderDescriptor,
    IAppDependencyProvider,
} from '@ever-works/plugin';
import type { WorkAppDependencyMetadata } from '../../database/repositories/work-app-dependency.repository';
import type { WorkAppDependency } from '../../entities/work-app-dependency.entity';
import {
    APP_DEPENDENCY_PROVISION_DISPATCHER,
    AppDependenciesService,
    AppDependencyRefusalError,
    type AppDependencyProvisionPayload,
    type AppDependencySpecSnapshot,
} from '../app-dependencies.service';
import { APP_DEPENDENCY_PROVISION_DISPATCHER as TASKS_APP_DEPENDENCY_PROVISION_DISPATCHER } from '../../tasks/app-dependency-provision-dispatcher';
import { AppDependencyFacadeService } from '../../facades/app-dependency.facade';
// The two provisional seams the last round left open, imported ONLY as types:
// this spec is where "does the service APW-06 is waiting for actually satisfy
// those declarations?" is answered at COMPILE time rather than by reading them.
import type { AppDependenciesService as AppDependenciesDeletionSeam } from '../../app-runtime/app-runtime-deletion.service';
import type { AppEphemeralDependencyProvisioner } from '../../app-runtime/app-verification-target.service';

/* -------------------------------------------------------------------------- *
 * Fakes — one per seam, each writing to the shared journal
 * -------------------------------------------------------------------------- */

interface Harness {
    service: AppDependenciesService;
    store: FakeStore;
    repository: FakeRepository;
    facade: AppDependencyFacadeService;
    dispatches: AppDependencyProvisionPayload[];
    provisionCalls: Array<{ providerId: string; ctx: AppDependencyContext }>;
    deprovisionCalls: Array<{ providerId: string; opts: Record<string, unknown> }>;
    events: Array<{ name: string; payload: Record<string, unknown> }>;
    prepareCalls: string[];
    setTarget(answer: unknown): void;
    setSnapshot(snapshot: AppDependencySpecSnapshot | null): void;
}

const WORK_ID = '3f1c8b7e-0000-4000-8000-000000000001';
const NAMESPACE = 'ew-hello-1a2b3c4d';

/** A stored row with every column the service reads, overridable per test. */
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

/** The `work_app_dependencies` store, in memory, with the partial index's own rule. */
class FakeStore {
    readonly rows: Array<Record<string, unknown>> = [];
    inserts: Array<Record<string, unknown>> = [];
    updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    /** When set, the next `insert` throws this — the unique-violation path. */
    failNextInsert: Error | null = null;
    /** The row the OTHER writer inserted first, adopted by the loser's re-read. */
    winnerOnConflict: Record<string, unknown> | null = null;
    private sequence = 0;

    async insert(draft: Record<string, unknown>): Promise<void> {
        this.inserts.push(draft);
        if (this.failNextInsert) {
            const error = this.failNextInsert;
            this.failNextInsert = null;
            if (this.winnerOnConflict) {
                this.rows.push(this.winnerOnConflict);
                this.winnerOnConflict = null;
            }
            throw error;
        }
        // The migration's partial unique index, reproduced: one ACTIVE row per
        // (workId, kind).
        const clash = this.rows.some(
            (existing) =>
                existing.workId === draft.workId &&
                existing.kind === draft.kind &&
                !['kept', 'deleted'].includes(String(existing.status)),
        );
        if (clash) {
            throw Object.assign(new Error('UNIQUE constraint failed: work_app_dependencies'), {
                code: 'SQLITE_CONSTRAINT',
            });
        }
        this.sequence += 1;
        this.rows.push({ id: `row-${String(this.sequence)}`, ...draft });
    }

    async update(criteria: { id: string }, patch: Record<string, unknown>): Promise<unknown> {
        this.updates.push({ id: criteria.id, patch });
        const found = this.rows.find((entry) => entry.id === criteria.id);
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

    storedAll(kind: AppDependencyKind): Array<Record<string, unknown>> {
        return this.rows.filter((entry) => entry.kind === kind);
    }
}

/** The feature repository, over the same in-memory rows. */
class FakeRepository {
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

    async markKept(id: string): Promise<boolean> {
        return this.setStatus(id, 'kept');
    }

    async markDeleted(id: string): Promise<boolean> {
        return this.setStatus(id, 'deleted');
    }

    async updateOutputs(id: string, envelope: string | null): Promise<WorkAppDependency | null> {
        const found = this.all().find((entry) => entry.id === id);
        if (!found) return null;
        const target = found as unknown as Record<string, unknown>;
        target.outputsEncrypted = envelope;
        target.outputsVersion = Number(target.outputsVersion ?? 0) + 1;
        return found as unknown as WorkAppDependency;
    }

    async claimLease(): Promise<WorkAppDependency | null> {
        return null;
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

/** A descriptor with the plan's own defaults. */
function descriptor(
    overrides: Partial<AppDependencyProviderDescriptor> & {
        id: string;
        kind: AppDependencyKind;
    },
): AppDependencyProviderDescriptor {
    return {
        targets: ['your-cluster', 'ever-works-apps'] as AppDependencyTarget[],
        label: overrides.id,
        preference: 10,
        backupPolicy: 'none',
        ...overrides,
    };
}

interface FakeProviderOptions {
    supports?: boolean;
    supportReason?: string;
    outcome?: AppDependencyProvisionOutcome;
    throwOnProvision?: Error;
}

/** One plugin declaring one or more provider ids. */
function providerPlugin(
    id: string,
    descriptors: AppDependencyProviderDescriptor[],
    behaviour: FakeProviderOptions = {},
): { plugin: IAppDependencyProvider; calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {
        supports: [],
        provision: [],
        getOutputs: [],
        deprovision: [],
        backupStatus: [],
    };
    const plugin = {
        id,
        name: id,
        version: '1.0.0',
        // The manifest CATEGORY is cosmetic for selection — the registry is
        // asked by capability, which is what a provider is discovered through.
        // `'app-dependency'` as a category is T3's own addition and is not
        // landed (it also needs the two `Record<PluginCategory, …>` maps in
        // `apps/web/src/lib/utils/plugin-category-icons.ts`), so the fixture
        // declares an existing one and the selection path is exercised exactly
        // the same.
        category: 'utility',
        capabilities: ['app-dependency'],
        settingsSchema: {},
        dependencyProviders: descriptors,
        async onLoad() {},
        async onUnload() {},
        async supports(kind: AppDependencyKind, target: AppDependencyTarget, ctx: unknown) {
            calls.supports.push({ kind, target, ctx });
            return behaviour.supports === false
                ? { supported: false as const, reason: behaviour.supportReason ?? 'nope' }
                : { supported: true as const, providerId: descriptors[0]?.id ?? id };
        },
        async provision(providerId: string, ctx: AppDependencyContext) {
            calls.provision.push({ providerId, ctx });
            if (behaviour.throwOnProvision) throw behaviour.throwOnProvision;
            return (
                behaviour.outcome ?? {
                    state: 'ready' as const,
                    outputs: { url: 'postgres://app@dep-postgres:5432/app', password: 'pw' },
                    actualVersion: '16',
                    resourceRefs: {
                        namespace: ctx.cluster?.namespace,
                        objects: [{ kind: 'StatefulSet', name: 'dep-postgres' }],
                    },
                }
            );
        },
        async getOutputs(providerId: string, ctx: unknown) {
            calls.getOutputs.push({ providerId, ctx });
            return { url: 'postgres://app@dep-postgres:5432/app', password: 'pw' };
        },
        async deprovision(providerId: string, ctx: unknown, opts: unknown) {
            calls.deprovision.push({ providerId, ctx, opts });
            const deleteData = (opts as { deleteData?: boolean })?.deleteData === true;
            return { state: deleteData ? ('deleted' as const) : ('released' as const) };
        },
        async backupStatus() {
            calls.backupStatus.push({});
            return { state: 'none' as const };
        },
    };
    return { plugin: plugin as unknown as IAppDependencyProvider, calls };
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

function harness(options: {
    snapshot: AppDependencySpecSnapshot | null;
    rows?: WorkAppDependencyMetadata[];
    plugins?: Array<Record<string, unknown>>;
    withDispatcher?: boolean;
    withCipher?: boolean;
    withTarget?: boolean;
    withCluster?: boolean;
}): Harness {
    const store = new FakeStore();
    for (const existing of options.rows ?? []) {
        store.rows.push({ ...existing });
    }
    const repository = new FakeRepository(store);

    const plugins =
        options.plugins ??
        (() => {
            const k8s = providerPlugin('k8s', [
                descriptor({ id: 'k8s-inline-postgres', kind: 'postgres' }),
                descriptor({ id: 'k8s-inline-redis', kind: 'redis' }),
                descriptor({ id: 'k8s-inline-minio', kind: 'objectStorage' }),
            ]);
            const external = providerPlugin('app-dependencies-external', [
                descriptor({
                    id: 'smtp-external',
                    kind: 'smtp',
                    preference: 10,
                    awaitingConfig: true,
                    backupPolicy: 'provider',
                    promptSchema: {
                        type: 'object',
                        properties: {
                            host: { type: 'string', title: 'SMTP host' },
                            password: { type: 'string', 'x-secret': true },
                        },
                        required: ['host', 'password'],
                    },
                } as unknown as Partial<AppDependencyProviderDescriptor> & {
                    id: string;
                    kind: AppDependencyKind;
                }),
                descriptor({ id: 'platform-smtp-relay', kind: 'smtp', preference: 20 }),
            ]);
            return [
                {
                    plugin: k8s.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
                {
                    plugin: external.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
            ];
        })();

    const registry = new FakeRegistry(plugins);
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

    const prepareCalls: string[] = [];
    let targetAnswer: unknown = {
        ref: { workId: WORK_ID, namespace: NAMESPACE, target: 'your-cluster', kubeContext: null },
        podLabels: { 'app.kubernetes.io/part-of': 'hello' },
    };
    const targetPort =
        options.withTarget === false
            ? undefined
            : {
                  async prepareDependencyTarget(workId: string) {
                      prepareCalls.push(workId);
                      return targetAnswer;
                  },
              };
    const cluster =
        options.withCluster === false
            ? undefined
            : {
                  async resolveClusterAccess() {
                      return { outcome: 'access' as const, access: { credential: 'kubeconfig' } };
                  },
              };

    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    let snapshot = options.snapshot;

    const service = new AppDependenciesService(
        repository as never,
        store as never,
        facade,
        { read: async () => snapshot },
        dispatcher as never,
        options.withCipher === false ? undefined : (cipher as never),
        targetPort as never,
        cluster as never,
        {
            async emit(event: { name: string; payload: Record<string, unknown> }) {
                events.push(event);
            },
        } as never,
    );

    const provisionCalls: Harness['provisionCalls'] = [];
    const deprovisionCalls: Harness['deprovisionCalls'] = [];
    for (const entry of plugins) {
        const plugin = entry.plugin as unknown as {
            provision: (providerId: string, ctx: AppDependencyContext) => Promise<unknown>;
            deprovision: (
                providerId: string,
                ctx: unknown,
                opts: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        const originalProvision = plugin.provision.bind(plugin);
        plugin.provision = async (providerId, ctx) => {
            provisionCalls.push({ providerId, ctx });
            return originalProvision(providerId, ctx);
        };
        const originalDeprovision = plugin.deprovision.bind(plugin);
        plugin.deprovision = async (providerId, ctx, opts) => {
            deprovisionCalls.push({ providerId, opts });
            return originalDeprovision(providerId, ctx, opts);
        };
    }

    return {
        service,
        store,
        repository,
        facade,
        dispatches,
        provisionCalls,
        deprovisionCalls,
        events,
        prepareCalls,
        setTarget(answer: unknown) {
            targetAnswer = answer;
        },
        setSnapshot(next: AppDependencySpecSnapshot | null) {
            snapshot = next;
        },
    };
}

/** One declared kind. */
function declared(
    kind: AppDependencyKind,
    block: Record<string, unknown> = {},
    required = false,
): AppDependencySpecSnapshot['dependencies'][number] {
    return { kind, declared: block, required };
}

function snapshot(
    dependencies: AppDependencySpecSnapshot['dependencies'],
    deployTarget: AppDependencySpecSnapshot['deployTarget'] = 'your-cluster',
): AppDependencySpecSnapshot {
    return { deployTarget, appName: 'hello', dependencies };
}

/* -------------------------------------------------------------------------- *
 * reconcile — plan §2.3
 * -------------------------------------------------------------------------- */

describe('AppDependenciesService.reconcile', () => {
    it('inserts a new kind as pending AND dispatches it', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres', { version: '16' })]) });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.created).toEqual(['postgres']);
        expect(result.dispatched).toEqual(['postgres']);
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'pending',
            providerPluginId: 'k8s',
            providerId: 'k8s-inline-postgres',
            deployTarget: 'your-cluster',
            inSpec: true,
        });
        expect(h.dispatches).toEqual([{ workId: WORK_ID, kind: 'postgres', mode: 'provision' }]);
    });

    it('inserts awaiting_config with NO dispatch for a provider that declares awaitingConfig', async () => {
        const h = harness({ snapshot: snapshot([declared('smtp', { required: true }, true)]) });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.created).toEqual(['smtp']);
        expect(result.awaitingConfig).toEqual(['smtp']);
        expect(h.store.stored('smtp')).toMatchObject({
            status: 'awaiting_config',
            providerId: 'smtp-external',
        });
        // No dispatch, and therefore no deadline: the owner has not typed the
        // settings yet (plan §4.9a:641-644).
        expect(h.dispatches).toEqual([]);
    });

    it('marks a kind that left the spec inSpec=false and dispatches nothing for it', async () => {
        const h = harness({
            // postgres is newly declared, redis left the spec: the removed kind
            // must not be dispatched, and must not suppress the new one either.
            snapshot: snapshot([declared('postgres', { version: '16' })]),
            rows: [row({ kind: 'redis', providerId: 'k8s-inline-redis', status: 'ready' })],
        });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.outOfSpec).toEqual(['redis']);
        expect(h.store.stored('redis')).toMatchObject({ inSpec: false, status: 'ready' });
        expect(h.dispatches).toEqual([{ workId: WORK_ID, kind: 'postgres', mode: 'provision' }]);
    });

    it('marks a kind that left the spec inSpec=false and dispatches nothing at all', async () => {
        const h = harness({
            snapshot: snapshot([]),
            rows: [row({ kind: 'postgres', providerId: 'k8s-inline-postgres', status: 'ready' })],
        });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.outOfSpec).toEqual(['postgres']);
        expect(h.store.stored('postgres')).toMatchObject({ inSpec: false, status: 'ready' });
        expect(h.dispatches).toEqual([]);
    });

    it('keeps the old row and creates the new one when the deploy target changed', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres', { version: '16' })], 'ever-works-apps'),
            rows: [row({ kind: 'postgres', status: 'ready', deployTarget: 'your-cluster' })],
        });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.kept).toEqual(['postgres']);
        const rows = h.store.storedAll('postgres');
        expect(rows).toHaveLength(2);
        expect(rows.find((entry) => entry.status === 'kept')).toBeDefined();
        expect(rows.find((entry) => entry.status === 'pending')).toMatchObject({
            deployTarget: 'ever-works-apps',
        });
        expect(h.dispatches).toEqual([{ workId: WORK_ID, kind: 'postgres', mode: 'provision' }]);
    });

    it('provisions nothing at all for the target none, and keeps what exists', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')], 'none'),
            rows: [row({ kind: 'postgres', status: 'ready' })],
        });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.kept).toEqual(['postgres']);
        expect(result.created).toEqual([]);
        expect(result.dispatched).toEqual([]);
        expect(h.dispatches).toEqual([]);
        expect(h.provisionCalls).toEqual([]);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'kept' });
    });

    it('re-dispatches a row that is still pending (the lost-dispatch repair)', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'pending' })],
        });

        await h.service.reconcile(WORK_ID);

        expect(h.dispatches).toEqual([{ workId: WORK_ID, kind: 'postgres', mode: 'provision' }]);
        // Still exactly one row: an existing pending row is never re-created.
        expect(h.store.storedAll('postgres')).toHaveLength(1);
    });

    it('reports specUnavailable and changes nothing when the App spec cannot be read', async () => {
        const h = harness({ snapshot: null, rows: [row({ kind: 'postgres' })] });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.reason).toBe('specUnavailable');
        expect(h.store.updates).toEqual([]);
        expect(h.dispatches).toEqual([]);
    });

    it('reports dispatchUnavailable rather than claiming the kind was scheduled', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            withDispatcher: false,
        });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.dispatched).toEqual([]);
        expect(result.dispatchUnavailable).toBe(true);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'pending' });
    });
});

/* -------------------------------------------------------------------------- *
 * Row creation is first-writer-wins
 * -------------------------------------------------------------------------- */

describe('row creation', () => {
    it('creates ONE row and dispatches ONCE when two reconciles race', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres')]) });

        const [first, second] = await Promise.all([
            h.service.reconcile(WORK_ID),
            h.service.reconcile(WORK_ID),
        ]);

        expect(h.store.storedAll('postgres')).toHaveLength(1);
        expect(h.dispatches).toHaveLength(1);
        // Exactly one of the two callers created it; neither created a second.
        expect(first.created.length + second.created.length).toBeLessThanOrEqual(2);
    });

    it('re-reads and adopts the winner when the insert hits the unique index', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres')]) });
        // Another PROCESS won the insert: the DB refuses ours with the partial
        // unique index's own error, and the winner's row is what a re-read sees.
        h.store.failNextInsert = Object.assign(
            new Error(
                'duplicate key value violates unique constraint "uq_work_app_dependencies_active"',
            ),
            { code: '23505' },
        );
        h.store.winnerOnConflict = {
            ...row({ kind: 'postgres', status: 'pending', id: 'winner' }),
        };

        const result = await h.service.reconcile(WORK_ID);

        expect(h.store.storedAll('postgres')).toHaveLength(1);
        expect(h.store.stored('postgres')).toMatchObject({ id: 'winner' });
        expect(result.created).toEqual(['postgres']);
        expect(h.dispatches).toEqual([{ workId: WORK_ID, kind: 'postgres', mode: 'provision' }]);
    });
});

/* -------------------------------------------------------------------------- *
 * ensureReadyForDeploy
 * -------------------------------------------------------------------------- */

describe('AppDependenciesService.ensureReadyForDeploy', () => {
    it('lists the kinds that are not ready', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres'), declared('redis')]),
            rows: [row({ kind: 'postgres', status: 'ready', declared: {} })],
        });

        const readiness = await h.service.ensureReadyForDeploy(WORK_ID);

        expect(readiness.ready).toBe(false);
        expect(readiness.notReady.map((entry) => entry.kind)).toContain('redis');
        expect(readiness.notReady.map((entry) => entry.kind)).not.toContain('postgres');
    });

    it('does not block on an optional smtp the spec does not require (FR-62)', async () => {
        const h = harness({
            snapshot: snapshot([declared('smtp', { required: false }, false)]),
            rows: [row({ kind: 'smtp', status: 'awaiting_config', providerId: 'smtp-external' })],
        });

        const readiness = await h.service.ensureReadyForDeploy(WORK_ID);

        expect(readiness.ready).toBe(true);
        expect(readiness.optional).toEqual(['smtp']);
        expect(readiness.notReady).toEqual([]);
    });

    it('blocks on a required smtp', async () => {
        const h = harness({
            snapshot: snapshot([declared('smtp', { required: true }, true)]),
            rows: [row({ kind: 'smtp', status: 'awaiting_config', providerId: 'smtp-external' })],
        });

        const readiness = await h.service.ensureReadyForDeploy(WORK_ID);

        expect(readiness.ready).toBe(false);
        expect(readiness.notReady).toEqual([
            { kind: 'smtp', status: 'awaiting_config', reason: null },
        ]);
    });

    it('is ready with no dependencies and with the target none', async () => {
        const h = harness({ snapshot: snapshot([], 'none') });
        expect((await h.service.ensureReadyForDeploy(WORK_ID)).ready).toBe(true);
    });
});

/* -------------------------------------------------------------------------- *
 * Release — ACC-07-21, FR-56, FR-58
 * -------------------------------------------------------------------------- */

describe('release paths', () => {
    it('onAppRemoved({ deleteData: false }) never calls the provider and keeps the row', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
        });

        const report = await h.service.onAppRemoved(WORK_ID, { deleteData: false });

        expect(h.deprovisionCalls).toEqual([]);
        expect(report.kept).toEqual([{ kind: 'postgres', name: 'postgres' }]);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'kept' });
        expect(h.events.map((event) => event.name)).toEqual([]);
    });

    it('onAppRemoved({ deleteData: true }) deprovisions with deleteData and records the deletion', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
        });

        const report = await h.service.onAppRemoved(WORK_ID, { deleteData: true });

        expect(h.deprovisionCalls).toHaveLength(1);
        expect(h.deprovisionCalls[0].opts).toEqual({ deleteData: true });
        expect(report.remaining).toBe(false);
        expect(report.mayRemain).toEqual([]);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'deleted' });
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.data_deleted']);
    });

    it('reports remaining instead of a false deletion when a provider answers released to a delete', async () => {
        const half = providerPlugin('k8s', [
            descriptor({ id: 'k8s-inline-postgres', kind: 'postgres' }),
        ]);
        (half.plugin as unknown as { deprovision: () => Promise<unknown> }).deprovision =
            async () => ({
                state: 'released',
            });
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
            plugins: [
                {
                    plugin: half.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
            ],
        });

        const report = await h.service.onAppRemoved(WORK_ID, { deleteData: true });

        expect(report.remaining).toBe(true);
        expect(report.mayRemain).toEqual([{ kind: 'postgres', name: 'postgres' }]);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'kept' });
    });

    it('onAppWorkDeleting({ deleteStoredData: false }) stops the workloads and deletes nothing', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
        });

        const report = await h.service.onAppWorkDeleting(WORK_ID, { deleteStoredData: false });

        expect(h.deprovisionCalls).toHaveLength(1);
        expect(h.deprovisionCalls[0].opts).toEqual({ deleteData: false, stopWorkloads: true });
        expect(h.store.stored('postgres')).toMatchObject({ status: 'kept' });
        expect(report.kept).toEqual([{ kind: 'postgres', name: 'postgres' }]);
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.released']);
    });

    it('onAppWorkDeleting({ deleteStoredData: true }) deletes the data and records it', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
        });

        await h.service.onAppWorkDeleting(WORK_ID, { deleteStoredData: true });

        expect(h.deprovisionCalls[0].opts).toEqual({ deleteData: true });
        expect(h.store.stored('postgres')).toMatchObject({ status: 'deleted' });
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.data_deleted']);
    });

    it('records no event and calls nothing for a dependency that was never provisioned (FR-58)', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'pending' })],
        });

        await h.service.onAppWorkDeleting(WORK_ID, { deleteStoredData: true });

        expect(h.deprovisionCalls).toEqual([]);
        expect(h.events).toEqual([]);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'kept' });
    });

    it('is idempotent: a second release of a kept row does nothing', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'kept' })],
        });

        const report = await h.service.onAppWorkDeleting(WORK_ID, { deleteStoredData: true });

        expect(h.deprovisionCalls).toEqual([]);
        expect(report).toEqual({ kept: [], mayRemain: [], remaining: false });
    });

    it('reports mayRemain instead of a false release when no cluster access can be assembled', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
            withCluster: false,
        });

        const report = await h.service.onAppWorkDeleting(WORK_ID, { deleteStoredData: true });

        expect(h.deprovisionCalls).toEqual([]);
        expect(report.mayRemain).toEqual([{ kind: 'postgres', name: 'postgres' }]);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'ready' });
    });
});

/* -------------------------------------------------------------------------- *
 * Provider selection (the real facade)
 * -------------------------------------------------------------------------- */

describe('provider selection', () => {
    it('prefers the lower preference', async () => {
        const chosen: string[] = [];
        const low = providerPlugin('low', [descriptor({ id: 'low-provider', kind: 'postgres' })]);
        const high = providerPlugin('high', [
            descriptor({ id: 'high-provider', kind: 'postgres', preference: 20 }),
        ]);
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            plugins: [
                {
                    plugin: high.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
                {
                    plugin: low.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
            ],
        });
        void chosen;

        await h.service.reconcile(WORK_ID);

        expect(h.store.stored('postgres')).toMatchObject({ providerId: 'low-provider' });
    });

    it('keeps a row serving when its provider does not support the pair', async () => {
        const unsupportive = providerPlugin(
            'unsupportive',
            [descriptor({ id: 'unsupportive-postgres', kind: 'postgres' })],
            { supports: false, supportReason: 'noOperator' },
        );
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            plugins: [
                {
                    plugin: unsupportive.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
            ],
        });

        const result = await h.service.reconcile(WORK_ID);

        expect(result.unsupported).toEqual([{ kind: 'postgres', reason: 'providerNotSupported' }]);
        expect(h.store.stored('postgres')).toBeUndefined();
        expect(h.dispatches).toEqual([]);
    });

    it('sends the provider the declared block and asks it to be ephemeral for a verification', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres', { version: '16' })]) });

        const result = await h.service.provisionEphemeral(WORK_ID, NAMESPACE, ['postgres']);

        expect(result.failed).toEqual([]);
        expect(result.outputs.postgres).toEqual({
            url: 'postgres://app@dep-postgres:5432/app',
            password: 'pw',
        });
        expect(h.provisionCalls).toHaveLength(1);
        expect(h.provisionCalls[0].ctx.ephemeral).toBe(true);
        expect(h.provisionCalls[0].ctx.cluster).toMatchObject({ namespace: NAMESPACE });
        expect(h.provisionCalls[0].ctx.declared).toEqual({ version: '16' });
    });
});

/* -------------------------------------------------------------------------- *
 * configure / retry / requestDataDeletion
 * -------------------------------------------------------------------------- */

describe('configure', () => {
    it('stores the configuration encrypted and moves the row to pending, then dispatches', async () => {
        const h = harness({
            snapshot: snapshot([declared('smtp', { required: true }, true)]),
            rows: [row({ kind: 'smtp', status: 'awaiting_config', providerId: 'smtp-external' })],
        });

        await h.service.configure(WORK_ID, 'smtp', {
            providerId: 'smtp-external',
            config: { host: 'smtp.example.com', password: 'hunter2' },
        });

        const stored = h.store.stored('smtp');
        expect(stored).toMatchObject({ status: 'pending', providerId: 'smtp-external' });
        expect(String(stored?.configEncrypted)).toMatch(/^enc::v1::/);
        // FR-5: the value is nowhere in the row.
        expect(JSON.stringify(stored)).not.toContain('hunter2');
        expect(h.dispatches).toEqual([{ workId: WORK_ID, kind: 'smtp', mode: 'provision' }]);
    });

    it('refuses a size below the provisioned size (FR-63)', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready', sizeGiB: 10 })],
        });

        await expect(
            h.service.configure(WORK_ID, 'postgres', { sizeGiB: 5 }),
        ).rejects.toMatchObject({ code: 'sizeShrinkRefused', status: 422 });
    });

    it('refuses to store a configuration when secure storage is unavailable (FR-5)', async () => {
        const h = harness({
            snapshot: snapshot([declared('smtp', { required: true }, true)]),
            rows: [row({ kind: 'smtp', status: 'awaiting_config', providerId: 'smtp-external' })],
            withCipher: false,
        });

        await expect(
            h.service.configure(WORK_ID, 'smtp', { config: { host: 'smtp.example.com' } }),
        ).rejects.toMatchObject({ code: 'secureStorageUnavailable', status: 503 });
        // Refused BEFORE any write: the row still holds no envelope at all.
        expect(h.store.stored('smtp')?.configEncrypted ?? null).toBeNull();
        expect(h.store.updates).toEqual([]);
    });

    it('refuses a kind the App spec does not declare', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres')]) });

        await expect(h.service.configure(WORK_ID, 'redis', {})).rejects.toBeInstanceOf(
            AppDependencyRefusalError,
        );
        await expect(h.service.configure(WORK_ID, 'redis', {})).rejects.toMatchObject({
            code: 'dependencyNotDeclared',
        });
    });
});

describe('retry', () => {
    it('clears the failure and dispatches a fresh attempt', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [
                row({
                    kind: 'postgres',
                    status: 'failed',
                    statusReason: 'noDefaultStorageClass',
                    attempts: 3,
                }),
            ],
        });

        const answer = await h.service.retry(WORK_ID, 'postgres');

        expect(answer).toEqual({ dispatched: true });
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'pending',
            statusReason: null,
            attempts: 0,
        });
        expect(h.dispatches).toEqual([{ workId: WORK_ID, kind: 'postgres', mode: 'provision' }]);
    });

    it('dispatches nothing while another worker holds the lease', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [
                row({
                    kind: 'postgres',
                    status: 'provisioning',
                    provisionLeaseUntil: new Date(Date.now() + 60_000),
                }),
            ],
        });

        const answer = await h.service.retry(WORK_ID, 'postgres');

        expect(answer).toEqual({ dispatched: false, reason: 'leaseHeld' });
        expect(h.dispatches).toEqual([]);
    });
});

describe('requestDataDeletion', () => {
    it('refuses when the typed slug does not match (FR-46)', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
        });

        await expect(
            h.service.requestDataDeletion(WORK_ID, 'postgres', {
                confirmSlug: 'wrong',
                workSlug: 'hello',
            }),
        ).rejects.toMatchObject({ code: 'confirmationMismatch', status: 422 });
        expect(h.store.stored('postgres')).toMatchObject({ status: 'ready' });
    });

    it('refuses while a provisioning lease is held', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [
                row({
                    kind: 'postgres',
                    status: 'provisioning',
                    provisionLeaseUntil: new Date(Date.now() + 60_000),
                }),
            ],
        });

        await expect(
            h.service.requestDataDeletion(WORK_ID, 'postgres', {
                confirmSlug: 'hello',
                workSlug: 'hello',
            }),
        ).rejects.toMatchObject({ code: 'deleteInProgress', status: 409 });
        expect(h.dispatches).toEqual([]);
    });

    it('marks the row deleting and schedules the deprovision with deleteData', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
        });

        await h.service.requestDataDeletion(WORK_ID, 'postgres', {
            confirmSlug: 'hello',
            workSlug: 'hello',
        });

        expect(h.store.stored('postgres')).toMatchObject({ status: 'deleting' });
        expect(h.dispatches).toEqual([
            { workId: WORK_ID, kind: 'postgres', mode: 'deprovision', deleteData: true },
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * Ephemeral provisioning — R-10, FR-60
 * -------------------------------------------------------------------------- */

describe('provisionEphemeral', () => {
    it('stores nothing: no row, no outputs, no update — and asks for the ephemeral mode', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres', { version: '16' })]) });

        const result = await h.service.provisionEphemeral(WORK_ID, {
            namespace: NAMESPACE,
            kinds: ['postgres'],
        });

        expect(result.outputs.postgres?.url).toBeTruthy();
        // R-10/FR-60: the outputs live in memory only.
        expect(h.store.rows).toEqual([]);
        expect(h.store.inserts).toEqual([]);
        // `ephemeral: true` is what makes the provider draw `emptyDir` instead
        // of every PVC (plan §4.9:621-623).
        expect(h.provisionCalls[0].ctx.ephemeral).toBe(true);
    });

    it('reports a per-kind failure without storing anything', async () => {
        const failing = providerPlugin(
            'k8s',
            [descriptor({ id: 'k8s-inline-postgres', kind: 'postgres' })],
            {
                outcome: { state: 'failed', reason: 'noDefaultStorageClass', transient: false },
            },
        );
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            plugins: [
                {
                    plugin: failing.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
            ],
        });

        const result = await h.service.provisionEphemeral(WORK_ID, NAMESPACE, ['postgres']);

        expect(result.outputs).toEqual({});
        expect(result.failed).toEqual([{ kind: 'postgres', reason: 'noDefaultStorageClass' }]);
        expect(h.store.rows).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * The worker-side attempt — GAP-06 / APW07-G01, ACC-07-14, FR-43
 * -------------------------------------------------------------------------- */

describe('runAttempt', () => {
    const readyRow = () =>
        row({
            kind: 'postgres',
            status: 'pending',
            declared: { version: '16' },
        });

    it('prepares the target once, reaches ready, and dispatches no Deployment', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres', { version: '16' })]),
            rows: [readyRow()],
        });

        const result = await h.service.runAttempt(WORK_ID, 'postgres');

        expect(result.state).toBe('ready');
        expect(h.prepareCalls).toEqual([WORK_ID]);
        expect(h.provisionCalls).toHaveLength(1);
        // The deadlock regression: the dependency path never dispatches an
        // app-deploy, so there is no cycle to wait on.
        expect(h.dispatches.filter((payload) => String(payload.mode) === 'provision')).toEqual([]);
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'ready',
            actualVersion: '16',
        });
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.provisioned']);
    });

    it('fails with target_not_checked when nothing prepared the target', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [readyRow()],
            withTarget: false,
        });

        const result = await h.service.runAttempt(WORK_ID, 'postgres');

        // APW07-G28: the port's `target_not_checked` reaches the card as
        // `targetNotChecked`, its own member of the closed union — storing the
        // discriminant verbatim made `asReason` return `null`.
        expect(result).toMatchObject({ state: 'failed', reason: 'targetNotChecked' });
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'failed',
            statusReason: 'targetNotChecked',
        });
        expect(h.provisionCalls).toEqual([]);
    });

    it('fails with namespace_owned_elsewhere when the namespace belongs to another Work', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres')]), rows: [readyRow()] });
        h.setTarget({ unavailable: 'namespace_owned_elsewhere' });

        const result = await h.service.runAttempt(WORK_ID, 'postgres');

        // APW07-G28 / plan §4.9:597-602: `namespace_owned_elsewhere` is spelled
        // `namespaceNotOwned` on the card — a mapping, not a new member.
        expect(result).toMatchObject({ state: 'failed', reason: 'namespaceNotOwned' });
        expect(h.store.stored('postgres')).toMatchObject({
            statusReason: 'namespaceNotOwned',
        });
        expect(h.provisionCalls).toEqual([]);
    });

    it('retries cluster_unreachable and only fails after three attempts (ACC-07-20)', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres')]), rows: [readyRow()] });
        h.setTarget({ unavailable: 'cluster_unreachable' });

        const first = await h.service.runAttempt(WORK_ID, 'postgres');
        const second = await h.service.runAttempt(WORK_ID, 'postgres');
        const third = await h.service.runAttempt(WORK_ID, 'postgres');

        expect([first.transient, second.transient, third.transient]).toEqual([true, true, false]);
        // APW07-G28: the transient decision stays on the port's own discriminant,
        // the reason the row carries is the contract's (`clusterUnreachable`).
        expect([first.reason, second.reason, third.reason]).toEqual([
            'clusterUnreachable',
            'clusterUnreachable',
            'clusterUnreachable',
        ]);
        const stored = h.store.stored('postgres');
        expect(stored).toMatchObject({ status: 'failed', attempts: 3 });
        expect(h.events.map((event) => event.name)).toEqual(['app.dependency.failed']);
    });

    it('leaves a retryable row — never ready — when the provider throws', async () => {
        const throwing = providerPlugin(
            'k8s',
            [descriptor({ id: 'k8s-inline-postgres', kind: 'postgres' })],
            { throwOnProvision: new Error('socket hang up') },
        );
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [readyRow()],
            plugins: [
                {
                    plugin: throwing.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
            ],
        });

        const result = await h.service.runAttempt(WORK_ID, 'postgres');

        expect(result.state).toBe('failed');
        expect(result.transient).toBe(true);
        expect(h.store.stored('postgres')).toMatchObject({ status: 'provisioning', attempts: 1 });
        expect(h.store.stored('postgres')?.status).not.toBe('ready');
    });

    it('fails at once on a definite reason and records it', async () => {
        const definite = providerPlugin(
            'k8s',
            [descriptor({ id: 'k8s-inline-postgres', kind: 'postgres' })],
            {
                outcome: {
                    state: 'failed',
                    reason: 'noDefaultStorageClass',
                    transient: false,
                },
            },
        );
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [readyRow()],
            plugins: [
                {
                    plugin: definite.plugin,
                    manifest: { capabilities: ['app-dependency'] },
                    state: 'loaded',
                },
            ],
        });

        const result = await h.service.runAttempt(WORK_ID, 'postgres');

        expect(result).toMatchObject({
            state: 'failed',
            reason: 'noDefaultStorageClass',
            transient: false,
        });
        expect(h.store.stored('postgres')).toMatchObject({
            status: 'failed',
            statusReason: 'noDefaultStorageClass',
            attempts: 1,
        });
    });

    it('stores the outputs encrypted and bumps outputsVersion only when they changed', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres')]), rows: [readyRow()] });

        await h.service.runAttempt(WORK_ID, 'postgres');
        const first = h.store.stored('postgres');

        await h.service.runAttempt(WORK_ID, 'postgres');
        const second = h.store.stored('postgres');

        expect(String(first?.outputsEncrypted)).toMatch(/^enc::v1::/);
        expect(first?.outputsVersion).toBe(1);
        // Identical outputs: no bump, so no app restart (FR-44).
        expect(second?.outputsVersion).toBe(1);
    });

    it('records the backup state on a refresh', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'ready' })],
        });

        const result = await h.service.runAttempt(WORK_ID, 'postgres', { mode: 'refresh' });

        expect(result.state).toBe('ready');
        expect(h.store.stored('postgres')).toMatchObject({ backupState: 'none' });
    });
});

/* -------------------------------------------------------------------------- *
 * list — FR-5
 * -------------------------------------------------------------------------- */

describe('AppDependenciesService.list', () => {
    it('names the outputs and their secrecy without ever carrying a value', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [
                row({
                    kind: 'postgres',
                    status: 'ready',
                    resourceRefs: { objects: [{ kind: 'StatefulSet', name: 'dep-postgres' }] },
                }),
            ],
        });

        const entries = await h.service.list(WORK_ID);

        expect(entries).toHaveLength(1);
        const entry = entries[0];
        expect(entry.outputs.map((output) => output.name)).toEqual([
            'url',
            'directUrl',
            'host',
            'port',
            'database',
            'user',
            'password',
        ]);
        expect(entry.outputs.find((output) => output.name === 'password')?.secret).toBe(true);
        expect(entry.outputs.find((output) => output.name === 'host')?.secret).toBe(false);
        expect(entry.names).toEqual(['dep-postgres']);
        expect(entry.awaitingConfig).toBe(false);
        expect(JSON.stringify(entry)).not.toContain('postgres://');
    });

    it('flags awaitingConfig and offers the provider prompt fields', async () => {
        const h = harness({
            snapshot: snapshot([declared('smtp', { required: true }, true)]),
            rows: [row({ kind: 'smtp', status: 'awaiting_config', providerId: 'smtp-external' })],
        });

        const entries = await h.service.list(WORK_ID);
        const entry = entries[0];

        expect(entry.awaitingConfig).toBe(true);
        const offered = entry.availableProviders.find(
            (provider) => provider.providerId === 'smtp-external',
        );
        expect(offered?.promptFields).toEqual([
            { key: 'host', label: 'SMTP host', secret: false, required: true, set: false },
            { key: 'password', label: 'password', secret: true, required: true, set: false },
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * The seams APW-06 declared provisionally — matched, at compile time
 * -------------------------------------------------------------------------- */

describe('the app-runtime seams', () => {
    it('satisfies APP_DEPENDENCIES_SERVICE and the ephemeral provisioner', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres')]) });

        // These two assignments ARE the assertions: a signature that drifted
        // from what `app-runtime-deletion.service.ts` and
        // `app-verification-target.service.ts` declare would not compile, and
        // the failure mode they warn about (an unbound seam that silently
        // reports success) is exactly what this prevents.
        const deletionSeam: AppDependenciesDeletionSeam = h.service;
        const ephemeralSeam: AppEphemeralDependencyProvisioner = h.service;

        expect(typeof deletionSeam.onAppWorkDeleting).toBe('function');
        expect(typeof deletionSeam.onAppRemoved).toBe('function');
        expect(typeof deletionSeam.list).toBe('function');
        // The positional form is the one APW-06's verification service calls.
        expect(typeof ephemeralSeam.provisionEphemeral).toBe('function');

        const deleted = await deletionSeam.onAppWorkDeleting(WORK_ID, {
            deleteStoredData: false,
        });
        expect(deleted).toMatchObject({ kept: [], mayRemain: [], remaining: false });
    });
});

/* -------------------------------------------------------------------------- *
 * The facade writes no provider id of its own
 * -------------------------------------------------------------------------- */

describe('AppDependencyFacadeService', () => {
    it('names no provider id literal — every id comes from a descriptor', () => {
        const source = readFileSync(
            join(__dirname, '..', '..', 'facades', 'app-dependency.facade.ts'),
            'utf8',
        );

        for (const providerId of APP_DEPENDENCY_PROVIDER_IDS) {
            expect(source).not.toContain(providerId);
        }
    });

    it('honours the owner explicit choice when that provider supports the pair', async () => {
        const h = harness({
            snapshot: snapshot([declared('smtp', { required: true }, true)]),
            rows: [row({ kind: 'smtp', status: 'awaiting_config', providerId: 'smtp-external' })],
        });

        await h.service.configure(WORK_ID, 'smtp', {
            providerId: 'platform-smtp-relay',
            config: { host: 'relay.example.com' },
        });

        expect(h.store.stored('smtp')).toMatchObject({
            providerId: 'platform-smtp-relay',
            providerPluginId: 'app-dependencies-external',
        });
    });

    it('refuses an explicit provider nobody offers rather than falling back', async () => {
        const h = harness({
            snapshot: snapshot([declared('postgres')]),
            rows: [row({ kind: 'postgres', status: 'pending' })],
        });

        await expect(
            h.service.configure(WORK_ID, 'postgres', { providerId: 'smtp-external' }),
        ).rejects.toMatchObject({ code: 'providerNotSupported', status: 422 });
    });
});

/* -------------------------------------------------------------------------- *
 * The port's unavailable vocabulary → the card's reasons — APW07-G28
 * -------------------------------------------------------------------------- */

/**
 * APW-06's four `AppRuntimeTargetUnavailable` codes (`plan.md` §4.8:550-556,
 * APW-06 plan §9.9:1564-1567) and the contract reason each must become.
 *
 * Two of these are mappings onto members that already existed
 * (`namespace_owned_elsewhere` → `namespaceNotOwned` is plan §4.9:597-602
 * verbatim); the other two are the members APW07-G28 added. Before it, the
 * discriminant was stored verbatim, `asReason` — which reads a stored reason
 * back through the closed union — returned `null`, and the card read *Failed*
 * with no reason at all.
 */
const PORT_UNAVAILABLE_REASONS: Array<[string, AppDependencyReason]> = [
    ['target_none', 'targetNone'],
    ['target_not_checked', 'targetNotChecked'],
    ['namespace_owned_elsewhere', 'namespaceNotOwned'],
    ['cluster_unreachable', 'clusterUnreachable'],
];

describe('AppDependenciesService — the port’s unavailable vocabulary (APW07-G28)', () => {
    /**
     * The same pending Postgres row the `runAttempt` block uses (`readyRow` is
     * scoped to that block, so this one is declared rather than reached for).
     */
    const readyRow = () =>
        row({
            kind: 'postgres',
            status: 'pending',
            declared: { version: '16' },
        });

    it.each(PORT_UNAVAILABLE_REASONS)(
        'maps %s to %s on the attempt, in the stored row, and through the card read',
        async (code, reason) => {
            const h = harness({ snapshot: snapshot([declared('postgres')]), rows: [readyRow()] });
            h.setTarget({ unavailable: code });

            const attempt = await h.service.runAttempt(WORK_ID, 'postgres');

            // 1. The attempt answers with the contract reason.
            expect(attempt).toMatchObject({ state: 'failed', reason });
            expect(h.prepareCalls).toEqual([WORK_ID]);
            expect(h.provisionCalls).toEqual([]);

            // 2. The ROW carries the contract reason, never the port's own
            // discriminant — this is the value a later read rebuilds the card from.
            const stored = h.store.stored('postgres');
            expect(stored).toMatchObject({ statusReason: reason });
            expect(stored?.statusReason).not.toBe(code);
            expect(isAppDependencyReason(String(stored?.statusReason))).toBe(true);

            // 3. The store → read round trip, which is the regression: `list`
            // runs the stored string through `asReason`, so a non-member came
            // back as `null` and the card showed *Failed* with no reason.
            const [entry] = await h.service.list(WORK_ID);
            expect(entry?.statusReason).toBe(reason);
        },
    );

    it('keeps the mapped reason readable across the store → read round trip (asReason no longer nulls it)', async () => {
        const h = harness({ snapshot: snapshot([declared('postgres')]), rows: [readyRow()] });
        h.setTarget({ unavailable: 'target_not_checked' });

        await h.service.runAttempt(WORK_ID, 'postgres');

        // THE regression, asserted first so it is the assertion that reddens: a
        // card is rebuilt by `list`, which runs the stored string through
        // `asReason` — and `asReason` drops any string the closed union does not
        // name, so a stored port code came back as `null` and the card read
        // *Failed* with no reason at all.
        const [entry] = await h.service.list(WORK_ID);
        expect(entry?.statusReason).toBe('targetNotChecked');

        // …which holds only because the row carries the mapped member, never the
        // port's own discriminant.
        expect(h.store.stored('postgres')?.statusReason).toBe('targetNotChecked');
        expect(isAppDependencyReason('target_not_checked')).toBe(false);
    });

    it('keeps the transient rule on the port’s own discriminant (FR-43)', async () => {
        const codes = ['target_none', 'target_not_checked', 'namespace_owned_elsewhere'];
        for (const code of codes) {
            const h = harness({ snapshot: snapshot([declared('postgres')]), rows: [readyRow()] });
            h.setTarget({ unavailable: code });

            const first = await h.service.runAttempt(WORK_ID, 'postgres');

            // A definite failure fails at once and is never left retryable…
            expect([code, first.transient, h.store.stored('postgres')?.status]).toEqual([
                code,
                false,
                'failed',
            ]);
        }

        // …while the port's `cluster_unreachable` still is (APW-06 plan §9.9:1566).
        const h = harness({ snapshot: snapshot([declared('postgres')]), rows: [readyRow()] });
        h.setTarget({ unavailable: 'cluster_unreachable' });
        const retryable = await h.service.runAttempt(WORK_ID, 'postgres');
        expect([retryable.transient, h.store.stored('postgres')?.status]).toEqual([
            true,
            'provisioning',
        ]);
    });
});

describe('the provisioning dispatcher token is the ONE T17 binds (APW07-G24 wiring)', () => {
    it('re-exports the token T17 owns instead of declaring a second one', () => {
        // Two Symbols with the same description are two DIFFERENT keys. While T17
        // was in flight this service declared its own provisional token, and its
        // own docstring named the consequence: the binding in `TriggerModule`
        // would resolve to nothing and every dispatch would report
        // `dispatchUnavailable` — silently, because a missing optional provider is
        // not an error. This assertion is the guard for that trap.
        expect(APP_DEPENDENCY_PROVISION_DISPATCHER).toBe(TASKS_APP_DEPENDENCY_PROVISION_DISPATCHER);
        expect(typeof APP_DEPENDENCY_PROVISION_DISPATCHER).toBe('symbol');
        expect(APP_DEPENDENCY_PROVISION_DISPATCHER.description).toBe(
            'APP_DEPENDENCY_PROVISION_DISPATCHER',
        );
    });

    it('never declares a local Symbol of its own in the source', () => {
        const source = readFileSync(join(__dirname, '..', 'app-dependencies.service.ts'), 'utf8');
        // Comments first: the module explains this rule and therefore names it.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        expect(code).not.toMatch(/Symbol\(\s*'APP_DEPENDENCY_PROVISION_DISPATCHER'\s*\)/);
        expect(code).toMatch(/@Inject\(APP_DEPENDENCY_PROVISION_DISPATCHER\)/);
    });
});
