/**
 * APW-06 T70 — the nine `app-cluster-op` handlers (plan §9.10:1574-1595).
 *
 * Every case below is one line of §9.10's op table, and each is asserted **against the fakes only**:
 * the service is constructed with exactly the collaborators it declares, so a call that is not in
 * the table cannot happen without a fake recording it.
 *
 * The table's own clauses, in order:
 *
 * - `status-refresh` — the snapshot is saved, and an unreachable cluster keeps the previous one with
 *   `failed` (**ACC-06-31**);
 * - `logs` — cached under `app-logs:<workId>:<requestId>` with TTL 300 000, **nothing** written to a
 *   repository, runtime state or Activity, no secret value in the entry, and a foreign `requestId`
 *   cannot answer (**ACC-06-34**);
 * - `pause` — refused while the lock is held, otherwise `paused` and `app.deploy.paused`;
 * - `resume` — the lock is claimed, the rollout and smoke checks run, `paused` is cleared and
 *   `app.deploy.resumed` is emitted (**ACC-06-35**, FR-49), with the `deferred` re-dispatch when the
 *   wait exceeds the budget;
 * - `remove` — APW-07 runs **before** `destroyApp` on the with-data path, `deleteVolumes` defaults to
 *   `false` and `removedAt` is set (**ACC-06-36**);
 * - `cancel-deploy` — honoured only for the matching `deployLockId` (**ACC-06-22**);
 * - `job-run` — the live image, a concurrent run refused, a long one re-dispatched (**ACC-06-37**,
 *   FR-51);
 * - `cluster-check` — the fingerprint lives **inside** `clusterCheck` and the observed
 *   `ingressAddress` is recorded, while the `clusterFingerprint` column is untouched
 *   (**ACC-06-05**, **ACC-06-54**);
 * - `ingress-reconcile` — `publishAppHosts` only, with **zero** `deployApp` calls (**ACC-06-25**);
 * - and every op refuses `app_work_deleting` (R-15) and reaches the plugin only through T20's facade
 *   (R-5).
 */

import type { AppClusterCheck, AppStatusSnapshot, AppTargetRef } from '@ever-works/plugin';

import {
    APP_LOGS_CACHE_PREFIX,
    APP_OP_CACHE_PREFIX,
    APP_OP_CACHE_TTL_MS,
    APP_RESUME_WAIT_BUDGET_MS,
    AppLifecycleOpsService,
    appLogsCacheKey,
    appOpCacheKey,
    replicasOf,
    smokeInputsOf,
    statusSpecOf,
} from '../app-lifecycle-ops.service';
import type { AppVerificationSpec } from '../app-verification-target.service';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const OTHER_WORK_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'req-7f3a';
const DEPLOYMENT_ID = 'dep-1111';
const NAMESPACE = 'ew-helpdesk-0f8e2c1a';
const KUBECONFIG = 'apiVersion: v1\nkind: Config\ncurrent-context: c\n';
const SENTINEL = 'sk-live-sentinel-value';

const REF: AppTargetRef = { workId: WORK_ID, namespace: NAMESPACE, target: 'your-cluster' };

const SNAPSHOT: AppStatusSnapshot = {
    observedAt: '2026-09-18T10:00:00.000Z',
    components: [{ name: 'web', role: 'web', desired: 2, ready: 2, restarts: 0 }],
    jobs: [],
    cron: [],
    isolationEnforced: true,
};

/** A live spec — the component/job/cron/smoke blocks `AppStatusSpec` and `resume` read. */
const SPEC = {
    input: {
        components: [
            { name: 'web', role: 'web', replicas: 2, primary: true, deadlineSeconds: 750 },
            { name: 'worker', role: 'worker', replicas: 1, primary: false, deadlineSeconds: 600 },
        ],
        jobs: [{ name: 'migrate', when: 'pre-deploy', component: 'web' }],
        cron: [{ name: 'tick', schedule: '* * * * *' }],
        smoke: [{ name: 'health', component: 'web', http: { path: '/api/health' } }],
    },
    dependencyKinds: [],
} as unknown as AppVerificationSpec;

/** A `CACHE_MANAGER` that records what it was asked to store. */
function cacheFake() {
    const entries: Array<{ key: string; value: unknown; ttl: number }> = [];
    return {
        entries,
        get: jest.fn(async (key: string) => entries.find((entry) => entry.key === key)?.value),
        set: jest.fn(async (key: string, value: unknown, ttl: number) => {
            entries.push({ key, value, ttl });
        }),
    };
}

/** T17's repository, as §9.10's handlers call it — every write recorded, none assumed. */
function stateFake(row: Record<string, unknown> | null = {}) {
    return {
        getOrCreate: jest.fn(async (_workId: string) => row),
        saveSnapshot: jest.fn(
            async (_workId: string, _snapshot: unknown, _observedAt: string) => undefined,
        ),
        setPaused: jest.fn(async (_workId: string, _paused: boolean, _at: Date) => true as boolean),
        claimDeployLock: jest.fn(async (_workId: string, _lockId: string) => true as boolean),
        releaseDeployLock: jest.fn(async (_workId: string, _lockId: string) => true as boolean),
        requestCancel: jest.fn(
            async (_workId: string, _deploymentId: string, _userId: string | null) =>
                true as boolean,
        ),
        saveClusterCheck: jest.fn(
            async (_workId: string, _check: unknown, _checkedAt: string, _address: unknown) =>
                undefined,
        ),
        saveIngressAddress: jest.fn(async (_workId: string, _address: unknown) => undefined),
        markRemoved: jest.fn(async (_workId: string, _at: Date) => undefined),
        saveJobResult: jest.fn(async (_workId: string, _job: unknown) => undefined),
    };
}

/** The plugin's App members, each a spy, plus `deployApp` — which no op may ever call. */
function pluginFake(overrides: Record<string, unknown> = {}) {
    return {
        deployApp: jest.fn(async () => {
            throw new Error('deployApp must never be called by an op');
        }),
        getAppStatus: jest.fn(async () => SNAPSHOT),
        getAppLogs: jest.fn(async () => ({
            containers: [{ pod: 'web-1', container: 'web', lines: ['ok'], truncated: false }],
            redactedNames: ['TOKEN'],
            fetchedAt: '2026-09-18T10:00:00.000Z',
        })),
        scaleApp: jest.fn(async () => ({ components: [], smoke: null })),
        destroyApp: jest.fn(async () => ({
            deleted: [{ kind: 'Deployment', name: 'web' }],
            kept: [{ kind: 'PersistentVolumeClaim', name: 'data' }],
            namespaceDeleted: false,
        })),
        runAppJob: jest.fn(async () => ({
            name: 'migrate',
            when: 'pre-deploy',
            runName: 'job-migrate-abc',
            status: 'succeeded',
            startedAt: '2026-09-18T10:00:00.000Z',
        })),
        checkAppCluster: jest.fn(async () => ({
            ok: true,
            serverVersion: 'v1.30.0',
            fingerprint: 'fp-abc',
            missingPermissions: [],
            optionalMissing: [],
            ingressClasses: [{ name: 'nginx', isDefault: true }],
            controllerNamespace: 'ingress-nginx',
            clusterIssuers: ['letsencrypt'],
            storageClasses: [{ name: 'standard', isDefault: true }],
            ingressAddress: { ip: '203.0.113.10' },
        })),
        publishAppHosts: jest.fn(async () => ({ ingressAddress: { ip: '203.0.113.10' } })),
        ...overrides,
    };
}

/** T20's facade, answering one target or one refusal. */
function facadeFake(plugin: Record<string, unknown>) {
    return {
        resolveClusterAccess: jest.fn(
            async (_workId: string): Promise<unknown> => ({
                outcome: 'access',
                access: {
                    target: 'your-cluster',
                    ref: REF,
                    credential: KUBECONFIG,
                    pluginId: 'k8s',
                    plugin,
                    clusterSource: 'custom-kubeconfig',
                },
            }),
        ),
    };
}

/** T26's hosts service. */
function hostsFake() {
    return {
        resolveHosts: jest.fn(async () => ({
            primary: 'helpdesk.ever.works',
            extra: ['www.helpdesk.ever.works'],
            previous: [],
            primaryUrl: 'https://helpdesk.ever.works',
        })),
    };
}

/** The one spec read the worker binds. */
function specFake(spec: AppVerificationSpec | undefined = SPEC) {
    return { readVerificationSpec: jest.fn(async () => spec) };
}

/** The orchestrator, as `remove` reaches it — it owns §5.6 step 8's order. */
function removalFake(
    answer: unknown = { status: 'removed', code: null, reason: null, mayRemain: [] },
) {
    return { removeAppWork: jest.fn(async () => answer) };
}

function eventsFake() {
    return { emit: jest.fn(async () => undefined) };
}

/**
 * One service, assembled from fakes.
 *
 * A collaborator that is **present in `options`** is passed verbatim — including `undefined`, which
 * is how the "unbound collaborator" cases below construct the service exactly as the worker's
 * context would when a token has no provider.
 */
function build(options: {
    plugin?: Record<string, unknown>;
    state?: ReturnType<typeof stateFake>;
    cache?: ReturnType<typeof cacheFake>;
    facade?: ReturnType<typeof facadeFake>;
    hosts?: ReturnType<typeof hostsFake>;
    spec?: ReturnType<typeof specFake>;
    removal?: ReturnType<typeof removalFake>;
    events?: ReturnType<typeof eventsFake>;
    dns?: { removeRecord: jest.Mock };
    dispatcher?: { dispatch: jest.Mock };
    targetUpdated?: { targetUpdated: jest.Mock };
}) {
    const plugin = options.plugin ?? pluginFake();
    const facade = options.facade ?? facadeFake(plugin);
    const state = 'state' in options ? options.state : stateFake();
    const cache = 'cache' in options ? options.cache : cacheFake();
    const events = 'events' in options ? options.events : eventsFake();

    const service = new AppLifecycleOpsService(
        facade as never,
        ('hosts' in options ? options.hosts : hostsFake()) as never,
        ('removal' in options ? options.removal : removalFake()) as never,
        ('spec' in options ? options.spec : specFake()) as never,
        cache as never,
        state as never,
        events as never,
        undefined,
        ('dns' in options ? options.dns : { removeRecord: jest.fn(async () => true) }) as never,
        ('dispatcher' in options
            ? options.dispatcher
            : { dispatch: jest.fn(async () => 'run-1') }) as never,
        ('targetUpdated' in options
            ? options.targetUpdated
            : { targetUpdated: jest.fn(async () => undefined) }) as never,
    );

    return { service, plugin, facade, state, cache };
}

const op = (overrides: Record<string, unknown> = {}) => ({
    op: 'status-refresh',
    workId: WORK_ID,
    requestId: REQUEST_ID,
    userId: 'user-1',
    ...overrides,
});

/* -------------------------------------------------------------------------- *
 * Pure helpers the handlers are built on
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — the pure helpers (APW-06 T70)', () => {
    it('builds the §9.10 cache keys in one place', () => {
        expect(appOpCacheKey(WORK_ID, REQUEST_ID)).toBe(
            `${APP_OP_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`,
        );
        expect(appLogsCacheKey(WORK_ID, REQUEST_ID)).toBe(
            `${APP_LOGS_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`,
        );
        expect(APP_OP_CACHE_TTL_MS).toBe(300_000);
        expect(APP_RESUME_WAIT_BUDGET_MS).toBe(840_000);
    });

    it('reads the status spec, the replicas, the smoke checks and the deadlines off the live spec', () => {
        expect(statusSpecOf(SPEC)).toEqual({
            components: [
                { name: 'web', role: 'web', replicas: 2, primary: true },
                { name: 'worker', role: 'worker', replicas: 1, primary: false },
            ],
            jobs: ['migrate'],
            // T60's mapper answers `cron: []` (a verification renders no CronJob); a status read
            // observes them, which is exactly the difference this helper exists for.
            cron: ['tick'],
        });
        expect(replicasOf(SPEC)).toEqual({ web: 2, worker: 1 });
        expect(smokeInputsOf(SPEC)).toEqual([
            { name: 'health', component: 'web', http: { path: '/api/health' } },
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1586 — status-refresh
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — status-refresh (APW-06 T70)', () => {
    it('saves the snapshot the plugin observed', async () => {
        const { service, plugin, state, cache } = build({});

        const result = await service.statusRefresh(op());

        expect(plugin.getAppStatus).toHaveBeenCalledWith(REF, KUBECONFIG, statusSpecOf(SPEC));
        expect(state.saveSnapshot).toHaveBeenCalledTimes(1);
        const saved = state.saveSnapshot.mock.calls[0];
        expect(saved[0]).toBe(WORK_ID);
        expect(saved[1]).toEqual(SNAPSHOT);
        expect(String(saved[2])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(result.state).toBe('done');
        expect(cache.entries).toEqual([
            {
                key: `${APP_OP_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`,
                value: { op: 'status-refresh', state: 'done' },
                ttl: 300_000,
            },
        ]);
    });

    it('keeps the previous snapshot and records `failed`/`cluster_unreachable` (ACC-06-31)', async () => {
        const plugin = pluginFake({
            getAppStatus: jest.fn(async () => {
                throw new Error('connect ECONNREFUSED');
            }),
        });
        const { service, state } = build({ plugin });

        const result = await service.statusRefresh(op());

        expect(result.state).toBe('failed');
        expect(result.code).toBe('cluster_unreachable');
        // The row still holds whatever it held: nothing overwrote it with an empty observation.
        expect(state.saveSnapshot).not.toHaveBeenCalled();
    });

    it('refuses `op_unsupported_on_target` when the resolved plugin has no getAppStatus', async () => {
        const plugin = pluginFake({ getAppStatus: undefined });
        const { service, state } = build({ plugin });

        const result = await service.statusRefresh(op());

        expect(result.state).toBe('refused');
        expect(result.code).toBe('op_unsupported_on_target');
        expect(state.saveSnapshot).not.toHaveBeenCalled();
    });

    it('refuses when no App spec can be read — the status spec would be invented', async () => {
        const { service } = build({
            spec: { readVerificationSpec: jest.fn(async () => undefined) } as never,
        });

        const result = await service.statusRefresh(op());

        expect(result.state).toBe('refused');
        expect(result.code).toBe('status_spec_unavailable');
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1587 — logs
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — logs (APW-06 T70)', () => {
    it('caches the redacted tail under the Work-scoped key and writes nothing else (ACC-06-34)', async () => {
        const { service, plugin, state, cache } = build({});

        const result = await service.logs(
            op({ op: 'logs', component: 'web', lines: 50, secretValues: { TOKEN: SENTINEL } }),
        );

        expect(plugin.getAppLogs).toHaveBeenCalledWith(
            REF,
            KUBECONFIG,
            expect.objectContaining({
                component: 'web',
                lines: 50,
                secretValues: { TOKEN: SENTINEL },
            }),
        );
        expect(cache.entries).toEqual([
            {
                key: `${APP_LOGS_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`,
                value: {
                    state: 'done',
                    tail: {
                        containers: [
                            { pod: 'web-1', container: 'web', lines: ['ok'], truncated: false },
                        ],
                        redactedNames: ['TOKEN'],
                        fetchedAt: '2026-09-18T10:00:00.000Z',
                    },
                },
                ttl: 300_000,
            },
        ]);
        expect(result.logsKey).toBe(`${APP_LOGS_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`);
        expect(result.opKey).toBeNull();
        expect(result.detail).toEqual({ containers: 1, redactedNames: 1 });

        // No repository, no runtime state, no Activity: the two write seams are the cache and the
        // event sink, and the event sink is T28's `app.*` catalogue, which has no log event.
        for (const write of [
            state.saveSnapshot,
            state.setPaused,
            state.claimDeployLock,
            state.releaseDeployLock,
            state.requestCancel,
            state.saveClusterCheck,
            state.saveIngressAddress,
            state.markRemoved,
            state.saveJobResult,
        ]) {
            expect(write).not.toHaveBeenCalled();
        }
    });

    it('never caches a secret value (T13 redacts; the entry is the redacted tail)', async () => {
        const { service, cache } = build({});

        const result = await service.logs(
            op({ op: 'logs', secretValues: { TOKEN: SENTINEL }, lines: 200 }),
        );

        const serialised = JSON.stringify({ entries: cache.entries, detail: result.detail });
        expect(serialised).not.toContain(SENTINEL);
        expect(JSON.parse(JSON.stringify(cache.entries))[0].value.tail.redactedNames).toEqual([
            'TOKEN',
        ]);
    });

    it('keys the entry by the Work, so a foreign requestId cannot answer (ACC-06-34)', async () => {
        const { service, cache } = build({});

        await service.logs(op({ op: 'logs', workId: OTHER_WORK_ID }));

        expect(cache.entries.map((entry) => entry.key)).toEqual([
            `${APP_LOGS_CACHE_PREFIX}${OTHER_WORK_ID}:${REQUEST_ID}`,
        ]);
        expect(cache.entries.map((entry) => entry.key)).not.toContain(
            `${APP_LOGS_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`,
        );
    });

    it('requires a requestId — the key is the only thing a reader can name', async () => {
        const { service, plugin, cache } = build({});

        const result = await service.logs(op({ op: 'logs', requestId: null }));

        expect(result.state).toBe('refused');
        expect(result.code).toBe('request_id_required');
        expect(plugin.getAppLogs).not.toHaveBeenCalled();
        expect(cache.entries).toEqual([]);
    });

    it('reports a refused log read as a failed op with the code in the entry', async () => {
        const plugin = pluginFake({
            getAppLogs: jest.fn(async () => {
                throw new Error('pods/log is forbidden');
            }),
        });
        const { service, cache } = build({ plugin });

        const result = await service.logs(op({ op: 'logs' }));

        expect(result.state).toBe('failed');
        expect(result.code).toBe('cluster_unreachable');
        expect(cache.entries[0].value).toEqual({ state: 'failed', code: 'cluster_unreachable' });
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1588 — pause
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — pause (APW-06 T70)', () => {
    it('is refused while the deploy lock is held, and dials nothing (S27)', async () => {
        const state = stateFake({ deployLockId: DEPLOYMENT_ID });
        state.setPaused.mockResolvedValue(false);
        const { service, plugin } = build({ state });

        const result = await service.pause(op({ op: 'pause' }));

        expect(result.state).toBe('refused');
        expect(result.code).toBe('deploy_in_progress');
        expect(result.detail).toEqual({ deployLockId: DEPLOYMENT_ID });
        expect(plugin.scaleApp).not.toHaveBeenCalled();
    });

    it('sets `paused`, scales to zero and emits `app.deploy.paused`', async () => {
        const state = stateFake({});
        const events = eventsFake();
        const { service, plugin } = build({ state, events });

        const result = await service.pause(op({ op: 'pause' }));

        expect(state.setPaused).toHaveBeenCalledWith(WORK_ID, true, expect.any(Date));
        expect(plugin.scaleApp).toHaveBeenCalledWith(REF, KUBECONFIG, 'pause', {});
        expect(events.emit).toHaveBeenCalledWith({
            name: 'app.deploy.paused',
            payload: { workId: WORK_ID, userId: 'user-1', target: 'your-cluster' },
        });
        // §9.10:1588 — "refresh the snapshot" after the scale.
        expect(plugin.getAppStatus).toHaveBeenCalledTimes(1);
        expect(result.state).toBe('done');
        expect(result.events).toBe('emitted');
    });

    it('refuses when no runtime-state store is bound — T17 has not landed', async () => {
        const { service, plugin } = build({ state: undefined });

        const result = await service.pause(op({ op: 'pause' }));

        expect(result.state).toBe('refused');
        expect(result.code).toBe('runtime_state_unavailable');
        expect(plugin.scaleApp).not.toHaveBeenCalled();
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1589 — resume
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — resume (APW-06 T70)', () => {
    it('claims the lock, runs the rollout and smoke checks, clears `paused` and emits (ACC-06-35)', async () => {
        const state = stateFake({
            namespace: NAMESPACE,
            paused: true,
            currentDeploymentId: DEPLOYMENT_ID,
        });
        const events = eventsFake();
        const { service, plugin } = build({ state, events });

        const result = await service.resume(op({ op: 'resume' }));

        expect(state.claimDeployLock).toHaveBeenCalledWith(WORK_ID, REQUEST_ID);
        expect(plugin.scaleApp).toHaveBeenCalledWith(
            REF,
            KUBECONFIG,
            'resume',
            { web: 2, worker: 1 },
            {
                smoke: [{ name: 'health', component: 'web', http: { path: '/api/health' } }],
                deadlines: { web: 750, worker: 600 },
            },
        );
        expect(state.setPaused).toHaveBeenCalledWith(WORK_ID, false, expect.any(Date));
        expect(events.emit).toHaveBeenCalledWith({
            name: 'app.deploy.resumed',
            payload: { workId: WORK_ID, userId: 'user-1', target: 'your-cluster', code: null },
        });
        expect(state.releaseDeployLock).toHaveBeenCalledWith(WORK_ID, REQUEST_ID);
        expect(result.state).toBe('done');
    });

    it('keeps the app resumed with the failure code and no rollback (FR-49)', async () => {
        const plugin = pluginFake({
            scaleApp: jest.fn(async () => ({
                components: [],
                smoke: null,
                failure: {
                    code: 'rollout_timeout',
                    message: 'the web component never became ready',
                },
            })),
        });
        const state = stateFake({ namespace: NAMESPACE });
        const events = eventsFake();
        const { service } = build({ plugin, state, events });

        const result = await service.resume(op({ op: 'resume' }));

        expect(result.state).toBe('failed');
        expect(result.code).toBe('rollout_timeout');
        // No rollback: the app stays resumed and FR-47's health notifications follow it.
        expect(state.setPaused).toHaveBeenCalledWith(WORK_ID, false, expect.any(Date));
        expect(events.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'app.deploy.resumed',
                payload: expect.objectContaining({ code: 'rollout_timeout' }),
            }),
        );
        // `destroyApp` is the rollback's tool and this op has none.
        expect(plugin.destroyApp).not.toHaveBeenCalled();
    });

    it('refuses while another Deployment holds the lock', async () => {
        const state = stateFake({ namespace: NAMESPACE, deployLockId: DEPLOYMENT_ID });
        state.claimDeployLock.mockResolvedValue(false);
        const { service, plugin } = build({ state });

        const result = await service.resume(op({ op: 'resume' }));

        expect(result.code).toBe('deploy_in_progress');
        expect(plugin.scaleApp).not.toHaveBeenCalled();
    });

    it('releases the lock even when the scale throws', async () => {
        const plugin = pluginFake({
            scaleApp: jest.fn(async () => {
                throw new Error('the API server went away');
            }),
        });
        const state = stateFake({ namespace: NAMESPACE });
        const { service } = build({ plugin, state });

        const result = await service.resume(op({ op: 'resume' }));

        expect(result.state).toBe('failed');
        expect(state.releaseDeployLock).toHaveBeenCalledWith(WORK_ID, REQUEST_ID);
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1590 — remove
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — remove (APW-06 T70)', () => {
    it('runs APW-07 before destroyApp on the with-data path (ACC-06-36)', async () => {
        const removal = removalFake();
        const order: string[] = [];
        removal.removeAppWork.mockImplementation(async () => {
            order.push('dependencies');
            return { status: 'removed', code: null, reason: null, mayRemain: [] };
        });
        const plugin = pluginFake({
            destroyApp: jest.fn(async () => {
                order.push('destroyApp');
                return { deleted: [], kept: [], namespaceDeleted: true };
            }),
        });
        const state = stateFake({ namespace: NAMESPACE });
        const { service } = build({ plugin, removal, state });

        const result = await service.remove(op({ op: 'remove', deleteStoredData: true }));

        expect(removal.removeAppWork).toHaveBeenCalledWith({ workId: WORK_ID, deleteData: true });
        expect(plugin.destroyApp).toHaveBeenCalledWith(REF, KUBECONFIG, { deleteVolumes: true });
        expect(order).toEqual(['dependencies', 'destroyApp']);
        expect(state.markRemoved).toHaveBeenCalledWith(WORK_ID, expect.any(Date));
        expect(result.state).toBe('done');
    });

    it('defaults `deleteVolumes` to false and destroys before APW-07 on the keep-data path', async () => {
        const removal = removalFake();
        const order: string[] = [];
        removal.removeAppWork.mockImplementation(async () => {
            order.push('dependencies');
            return { status: 'removed', code: null, reason: null, mayRemain: [] };
        });
        const plugin = pluginFake({
            destroyApp: jest.fn(async () => {
                order.push('destroyApp');
                return {
                    deleted: [{ kind: 'Deployment', name: 'web' }],
                    kept: [{ kind: 'PersistentVolumeClaim', name: 'data' }],
                    namespaceDeleted: false,
                };
            }),
        });
        const state = stateFake({ namespace: NAMESPACE });
        const events = eventsFake();
        const { service } = build({ plugin, removal, state, events });

        const result = await service.remove(op({ op: 'remove' }));

        expect(plugin.destroyApp).toHaveBeenCalledWith(REF, KUBECONFIG, { deleteVolumes: false });
        expect(order).toEqual(['destroyApp', 'dependencies']);
        expect(result.detail).toEqual(
            expect.objectContaining({ kept: ['PersistentVolumeClaim/data'] }),
        );
        expect(events.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'app.deploy.removed',
                payload: expect.objectContaining({ names: ['PersistentVolumeClaim/data'] }),
            }),
        );
    });

    it('deletes no volume when APW-07 reports remnants, and ends with mayRemain[]', async () => {
        const removal = removalFake({
            status: 'removed-with-remnants',
            code: 'dependencies_remaining',
            reason: 'the bucket could not be emptied',
            mayRemain: ['s3/helpdesk-assets'],
        });
        const plugin = pluginFake();
        const { service } = build({ plugin, removal });

        const result = await service.remove(op({ op: 'remove', deleteStoredData: true }));

        expect(plugin.destroyApp).not.toHaveBeenCalled();
        expect(result.detail).toEqual(
            expect.objectContaining({ mayRemain: ['s3/helpdesk-assets'] }),
        );
    });

    it('is refused while the deploy lock is held', async () => {
        const plugin = pluginFake();
        const { service } = build({ plugin, state: stateFake({ deployLockId: DEPLOYMENT_ID }) });

        const result = await service.remove(op({ op: 'remove' }));

        expect(result.code).toBe('deploy_in_progress');
        expect(plugin.destroyApp).not.toHaveBeenCalled();
    });

    it('refuses when APW-07 is not bound — the removal has an order it cannot keep', async () => {
        const plugin = pluginFake();
        const { service } = build({
            plugin,
            removal: removalFake({
                status: 'refused',
                code: 'dependencies_unavailable',
                reason: 'no dependencies service',
                mayRemain: [],
            }),
        });

        const result = await service.remove(op({ op: 'remove', deleteStoredData: true }));

        expect(result.code).toBe('dependencies_unavailable');
        expect(plugin.destroyApp).not.toHaveBeenCalled();
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1591 — cancel-deploy
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — cancel-deploy (APW-06 T70)', () => {
    it('is honoured only for the matching deployLockId (ACC-06-22)', async () => {
        const state = stateFake({ deployLockId: DEPLOYMENT_ID });
        const { service } = build({ state });

        const result = await service.cancelDeploy(
            op({ op: 'cancel-deploy', deploymentId: DEPLOYMENT_ID }),
        );

        expect(state.requestCancel).toHaveBeenCalledWith(WORK_ID, DEPLOYMENT_ID, 'user-1');
        expect(result.state).toBe('done');
    });

    it('refuses `no_deploy_in_progress` when the UPDATE matched zero rows', async () => {
        const state = stateFake({ deployLockId: 'someone-elses-deployment' });
        state.requestCancel.mockResolvedValue(false);
        const { service } = build({ state });

        const result = await service.cancelDeploy(
            op({ op: 'cancel-deploy', deploymentId: DEPLOYMENT_ID }),
        );

        expect(result.state).toBe('refused');
        expect(result.code).toBe('no_deploy_in_progress');
    });

    it('refuses when the payload names no Deployment at all', async () => {
        const state = stateFake({});
        const { service } = build({ state });

        const result = await service.cancelDeploy(op({ op: 'cancel-deploy' }));

        expect(result.code).toBe('no_deploy_in_progress');
        expect(state.requestCancel).not.toHaveBeenCalled();
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1592 — job-run
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — job-run (APW-06 T70)', () => {
    const liveRow = {
        namespace: NAMESPACE,
        currentDeploymentId: DEPLOYMENT_ID,
        appRender: { image: { reference: `ghcr.io/ever-works/helpdesk@sha256:${'a'.repeat(64)}` } },
        statusSnapshot: { ...SNAPSHOT, jobs: [] },
    };

    it('runs the declared job with the live image (ACC-06-37)', async () => {
        const state = stateFake(liveRow);
        const events = eventsFake();
        const { service, plugin } = build({ state, events });

        const result = await service.jobRun(op({ op: 'job-run', jobName: 'migrate' }));

        expect(plugin.runAppJob).toHaveBeenCalledWith(REF, KUBECONFIG, {
            name: 'migrate',
            image: `ghcr.io/ever-works/helpdesk@sha256:${'a'.repeat(64)}`,
            confirmFirstDeploy: false,
        });
        expect(state.saveJobResult).toHaveBeenCalledTimes(1);
        expect(events.emit).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'app.job.succeeded' }),
        );
        expect(result.state).toBe('done');
    });

    it('refuses a job the App spec does not declare', async () => {
        const { service, plugin } = build({ state: stateFake(liveRow) });

        const result = await service.jobRun(op({ op: 'job-run', jobName: 'nope' }));

        expect(result.code).toBe('unknown_job');
        expect(plugin.runAppJob).not.toHaveBeenCalled();
    });

    it('refuses a concurrent run of the same job (FR-51)', async () => {
        const running = {
            ...liveRow,
            statusSnapshot: {
                ...SNAPSHOT,
                jobs: [
                    {
                        name: 'migrate',
                        last: {
                            name: 'migrate',
                            when: 'pre-deploy',
                            runName: 'job-migrate-old',
                            status: 'running',
                            startedAt: '2026-09-18T09:59:00.000Z',
                        },
                    },
                ],
            },
        };
        const { service, plugin } = build({ state: stateFake(running) });

        const result = await service.jobRun(op({ op: 'job-run', jobName: 'migrate' }));

        expect(result.state).toBe('refused');
        expect(result.code).toBe('job_active');
        expect(plugin.runAppJob).not.toHaveBeenCalled();
    });

    it("defers a long run for the `{ stage: 'wait' }` re-dispatch", async () => {
        const plugin = pluginFake({
            runAppJob: jest.fn(async () => ({
                name: 'migrate',
                when: 'pre-deploy',
                runName: 'job-migrate-abc',
                status: 'running',
                startedAt: '2026-09-18T09:59:00.000Z',
            })),
        });
        const { service } = build({ plugin, state: stateFake(liveRow) });

        const result = await service.jobRun(op({ op: 'job-run', jobName: 'migrate' }));

        expect(result.state).toBe('deferred');
        expect(JSON.stringify(result.detail)).toContain('840000');
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1593 — cluster-check
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — cluster-check (APW-06 T70)', () => {
    it('writes the fingerprint INSIDE clusterCheck and records the observed address (ACC-06-05, ACC-06-54)', async () => {
        const state = stateFake({ namespace: NAMESPACE });
        const targetUpdated = { targetUpdated: jest.fn(async () => undefined) };
        const { service, plugin } = build({ state, targetUpdated });

        const result = await service.clusterCheck(op({ op: 'cluster-check' }));

        expect(plugin.checkAppCluster).toHaveBeenCalledWith(KUBECONFIG, {
            namespace: NAMESPACE,
            needsCreateNamespace: false,
        });
        const saved = state.saveClusterCheck.mock.calls[0];
        expect(saved[0]).toBe(WORK_ID);
        const check = saved[1] as AppClusterCheck & { fingerprint: string };
        expect(check.fingerprint).toBe('fp-abc');
        // The `clusterFingerprint` COLUMN stays the deployed cluster: the check carries its own
        // fingerprint and never writes that column (§6.3:1005-1007).
        expect(Object.keys(check)).not.toContain('clusterFingerprint');
        expect(String(saved[2])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(saved[3]).toEqual({ ip: '203.0.113.10' });
        expect(targetUpdated.targetUpdated).toHaveBeenCalledWith(WORK_ID, NAMESPACE);
        expect(result.detail).toEqual(
            expect.objectContaining({ fingerprint: 'fp-abc', ok: true, saved: 'written' }),
        );
    });

    it('asks for `create namespaces` only when the Work has no namespace yet', async () => {
        const { service, plugin } = build({ state: stateFake({ namespace: null }) });

        await service.clusterCheck(op({ op: 'cluster-check' }));

        expect(plugin.checkAppCluster).toHaveBeenCalledWith(KUBECONFIG, {
            namespace: null,
            needsCreateNamespace: true,
        });
    });

    it('records the failure when the check itself errors', async () => {
        const plugin = pluginFake({
            checkAppCluster: jest.fn(async () => {
                throw new Error('certificate has expired');
            }),
        });
        const { service, state } = build({ plugin });

        const result = await service.clusterCheck(op({ op: 'cluster-check' }));

        expect(result.state).toBe('failed');
        expect(result.code).toBe('cluster_unreachable');
        expect(state.saveClusterCheck).not.toHaveBeenCalled();
    });
});

/* -------------------------------------------------------------------------- *
 * §9.10:1595 — ingress-reconcile
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — ingress-reconcile (APW-06 T70)', () => {
    it('calls publishAppHosts only, with zero deployApp calls (ACC-06-25)', async () => {
        const state = stateFake({ namespace: NAMESPACE });
        const { service, plugin } = build({ state });

        const result = await service.ingressReconcile(op({ op: 'ingress-reconcile' }));

        expect(plugin.publishAppHosts).toHaveBeenCalledWith(REF, KUBECONFIG, {
            primary: 'helpdesk.ever.works',
            extra: ['www.helpdesk.ever.works'],
            previous: [],
            tls: 'none',
            issuer: null,
        });
        expect(plugin.deployApp).not.toHaveBeenCalled();
        expect(plugin.scaleApp).not.toHaveBeenCalled();
        expect(plugin.destroyApp).not.toHaveBeenCalled();
        expect(state.saveIngressAddress).toHaveBeenCalledWith(WORK_ID, { ip: '203.0.113.10' });
        expect(result.detail).toEqual(expect.objectContaining({ deployAppCalls: 0 }));
    });

    it('refuses when the plugin cannot publish hosts', async () => {
        const plugin = pluginFake({ publishAppHosts: undefined });
        const { service } = build({ plugin });

        const result = await service.ingressReconcile(op({ op: 'ingress-reconcile' }));

        expect(result.state).toBe('refused');
        expect(result.code).toBe('op_unsupported_on_target');
        expect(result.detail).toEqual({ member: 'publishAppHosts' });
    });

    it('refuses when the host set cannot be resolved', async () => {
        const hosts = { resolveHosts: jest.fn(async () => null) };
        const { service, plugin } = build({ hosts });

        const result = await service.ingressReconcile(op({ op: 'ingress-reconcile' }));

        expect(result.code).toBe('hosts_unavailable');
        expect(plugin.publishAppHosts).not.toHaveBeenCalled();
    });
});

/* -------------------------------------------------------------------------- *
 * R-15 — every op refuses a deleting App Work
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — R-15 (APW-06 T70)', () => {
    const everyOp = [
        { op: 'status-refresh' },
        { op: 'logs' },
        { op: 'pause' },
        { op: 'resume' },
        { op: 'remove' },
        { op: 'cancel-deploy', deploymentId: DEPLOYMENT_ID },
        { op: 'job-run', jobName: 'migrate' },
        { op: 'cluster-check' },
        { op: 'ingress-reconcile' },
    ];

    it.each(everyOp)('refuses $op while deletionRequestedAt is set', async (payload) => {
        const state = stateFake({
            namespace: NAMESPACE,
            deletionRequestedAt: '2026-09-18T09:00:00.000Z',
        });
        const { service, plugin } = build({ state });

        const result = await service.handle(op({ ...payload, workId: WORK_ID }));

        expect(result.state).toBe('refused');
        expect(result.code).toBe('app_work_deleting');
        for (const member of [
            plugin.deployApp,
            plugin.getAppStatus,
            plugin.getAppLogs,
            plugin.scaleApp,
            plugin.destroyApp,
            plugin.runAppJob,
            plugin.checkAppCluster,
            plugin.publishAppHosts,
        ]) {
            expect(member).not.toHaveBeenCalled();
        }
    });
});

/* -------------------------------------------------------------------------- *
 * R-5 — the plugin is reached through the facade and nowhere else
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — R-5 (APW-06 T70)', () => {
    it('dials no plugin member when the facade refuses — on every op', async () => {
        const plugin = pluginFake();
        const facade = {
            resolveClusterAccess: jest.fn(
                async (_workId: string): Promise<unknown> => ({
                    outcome: 'refused',
                    refusal: 'target_unavailable',
                }),
            ),
        };
        const { service } = build({ plugin, facade });

        const results = [];
        for (const payload of [
            { op: 'status-refresh' },
            { op: 'logs' },
            { op: 'pause' },
            { op: 'resume' },
            { op: 'remove' },
            { op: 'cancel-deploy', deploymentId: DEPLOYMENT_ID },
            { op: 'job-run', jobName: 'migrate' },
            { op: 'cluster-check' },
            { op: 'ingress-reconcile' },
        ]) {
            results.push(await service.handle(op({ ...payload, workId: WORK_ID })));
        }

        expect(results.map((result) => [result.op, result.code])).toEqual([
            ['status-refresh', 'target_unavailable'],
            ['logs', 'target_unavailable'],
            ['pause', 'target_unavailable'],
            ['resume', 'target_unavailable'],
            ['remove', 'target_unavailable'],
            // `cancel-deploy` is §9.10:1591's single UPDATE and dials nothing, so a refused facade
            // does not reach it — the flag is exactly what a member sets when the cluster is down.
            ['cancel-deploy', null],
            ['job-run', 'target_unavailable'],
            ['cluster-check', 'target_unavailable'],
            ['ingress-reconcile', 'target_unavailable'],
        ]);
        expect(results.map((result) => result.state)).toEqual([
            'refused',
            'refused',
            'refused',
            'refused',
            'refused',
            'done',
            'refused',
            'refused',
            'refused',
        ]);
        for (const member of [
            plugin.deployApp,
            plugin.getAppStatus,
            plugin.getAppLogs,
            plugin.scaleApp,
            plugin.destroyApp,
            plugin.runAppJob,
            plugin.checkAppCluster,
            plugin.publishAppHosts,
        ]) {
            expect(member).not.toHaveBeenCalled();
        }
    });
});

/* -------------------------------------------------------------------------- *
 * The router's entry point
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — handle() (APW-06 T70)', () => {
    it('refuses an op outside §9.10’s nine', async () => {
        const { service } = build({});

        const result = await service.handle(op({ op: 'dns-reconcile' }));

        expect(result.state).toBe('refused');
        expect(result.code).toBe('unknown_op');
    });

    it('refuses a payload with no Work', async () => {
        const { service } = build({});

        const result = await service.handle(op({ op: 'status-refresh', workId: '' }));

        expect(result.code).toBe('invalid_payload');
    });

    it('reports an unbound cache rather than pretending the op is readable', async () => {
        const { service } = build({ cache: undefined });

        const result = await service.statusRefresh(op());

        expect(result.state).toBe('done');
        expect(result.cache).toBe('unbound');
        expect(result.opKey).toBe(`${APP_OP_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`);
    });

    it('reports an unbound event sink rather than pretending the event was emitted', async () => {
        const { service } = build({ events: undefined });

        const result = await service.pause(op({ op: 'pause' }));

        expect(result.state).toBe('done');
        expect(result.events).toBe('unbound');
    });

    it('writes the op entry for every op but logs, with the 300 000 ms TTL', async () => {
        const cache = cacheFake();
        const { service } = build({ cache });

        await service.statusRefresh(op());
        await service.clusterCheck(op({ op: 'cluster-check' }));

        expect(cache.entries.map((entry) => entry.key)).toEqual([
            `${APP_OP_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`,
            `${APP_OP_CACHE_PREFIX}${WORK_ID}:${REQUEST_ID}`,
        ]);
        expect(cache.entries.every((entry) => entry.ttl === APP_OP_CACHE_TTL_MS)).toBe(true);
    });
});

/* -------------------------------------------------------------------------- *
 * The plugin contract this service reads
 * -------------------------------------------------------------------------- */

describe('app-lifecycle-ops — the plugin members it binds', () => {
    it('passes the plugin’s own answer through, unmodified', async () => {
        const check: AppClusterCheck = {
            ok: false,
            fingerprint: 'fp-xyz',
            missingPermissions: [{ verb: 'create', resource: 'deployments' }],
            optionalMissing: [],
            ingressClasses: [],
            controllerNamespace: null,
            clusterIssuers: [],
            storageClasses: [],
            error: { code: 'forbidden', message: 'no' },
        };
        const plugin = pluginFake({ checkAppCluster: jest.fn(async () => check) });
        const state = stateFake({ namespace: NAMESPACE });
        const { service } = build({ plugin, state });

        const result = await service.clusterCheck(op({ op: 'cluster-check' }));

        const saved = state.saveClusterCheck.mock.calls[0];
        expect((saved[1] as AppClusterCheck).missingPermissions).toEqual([
            { verb: 'create', resource: 'deployments' },
        ]);
        // A check that carries an error observed no address: nothing is recorded as one.
        expect(saved[3]).toBeNull();
        expect(result.state).toBe('done');
    });
});
