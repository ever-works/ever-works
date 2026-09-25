/**
 * APW-06 T58 — deleting an App Work: the runtime half of Resolution R-15.
 *
 * Every assertion here is one line of the contract:
 *
 * - `plan.md` §9.7's three-row table for `requestDeletion` (`:1486-1490`);
 * - the op's order (`:1492-1510`) — APW-07 **before** `destroyApp`, `deleteVolumes` equal to
 *   `deleteStoredData`, the managed DNS record after the workloads, the Activity row, then APW-01's
 *   completion;
 * - ACC-06-45 (keep path) and ACC-06-46 (Remove-with-data, and three unreachable attempts);
 * - Ever Works Apps routed to the `apps-tier` seam and **never** to `destroyApp` (R-5, `:1503`);
 * - §9.4:1325-1326 — the Activity payload carries kinds and names only: no host, no address, no
 *   token, no value;
 * - the fail-closed answers of §9.8: an unbound collaborator never turns into a silent success.
 *
 * The order assertions use one shared `order[]` journal written by every fake, so "APW-07 first" is
 * a property of the sequence rather than of two call counts that happen to match.
 */

import {
    APP_DELETE_WORK_OP,
    APP_DEPLOY_REMOVED_EVENT,
    APP_WORK_DELETION_MAX_ATTEMPTS,
    APP_WORK_DELETION_ATTEMPT_WINDOW_MS,
    APP_WORK_DELETION_PORT,
    APP_WORK_DELETION_PORT_PROVIDER,
    APP_WORK_DELETION_RETRY_DELAY_MS,
    AppRuntimeDeletionService,
    AppWorkDeletionRefusalError,
    deletionRetryDelayMs,
    type AppDeleteWorkOpPayload,
    type AppDependenciesService,
    type AppDependencyDeletionReport,
    type AppRuntimeDeletionFacade,
    type AppWorkDeletionCompletion,
    type WorkAppRuntimeStateDeletionStore,
    type WorkAppRuntimeStateDeletionView,
    type AppsDomainDnsService,
    type AppClusterOpDispatcher,
} from '../app-runtime-deletion.service';
// APW-01 T39 — the OWNER's token, imported under its own file's name so the identity
// assertions below compare the runtime's binding with what `WorkLifecycleService` injects,
// rather than with this file's re-export of it.
import {
    APP_WORK_DELETION_PORT as APW01_APP_WORK_DELETION_PORT,
    type AppWorkDeletionPort as Apw01AppWorkDeletionPort,
} from '../../app-works/app-work-deletion.port';
import type { AppDestroyResult, AppTargetRef } from '@ever-works/plugin';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AppRuntimeEventSink } from '../ports';

/* -------------------------------------------------------------------------- *
 * Fakes — one per optional seam, each writing to the shared journal
 * -------------------------------------------------------------------------- */

const TARGET_NONE = 'none' as const;
const TARGET_CLUSTER = 'your-cluster' as const;
const TARGET_TIER = 'ever-works-apps' as const;

const NAMESPACE = 'ew-hello-1a2b3c4d';

interface Harness {
    service: AppRuntimeDeletionService;
    order: string[];
    dispatches: Array<{ payload: AppDeleteWorkOpPayload; delayMs?: number }>;
    claims: Array<{ deleteStoredData: boolean; requestedByUserId: string }>;
    destroyCalls: Array<{ deleteVolumes: boolean; namespace: string }>;
    completionCalls: string[];
    events: Array<{ name: string; payload: Record<string, unknown> }>;
    dependencyCalls: Array<{ method: string; opts: unknown }>;
    dnsCalls: string[];
    states: FakeRuntimeStates;
}

/** A `work_app_runtime_states` row (plan §7.2) with the fields a deletion reads. */
function runtimeState(
    overrides: Partial<WorkAppRuntimeStateDeletionView> = {},
): WorkAppRuntimeStateDeletionView {
    return {
        workId: 'work-1',
        target: TARGET_CLUSTER,
        namespace: NAMESPACE,
        currentDeploymentId: 'deployment-1',
        deployLockId: null,
        // Relative to the clock: the fifteen-minute window is measured from this claim, so a fixed
        // date would make the retry tests depend on when they run.
        deletionRequestedAt: new Date(Date.now() - 1_000),
        deletionDeleteData: false,
        deletionAttempts: 0,
        deletionRequestedByUserId: 'user-1',
        statusSnapshot: {
            components: [{ name: 'web' }, { name: 'worker' }],
        },
        ...overrides,
    };
}

class FakeRuntimeStates implements WorkAppRuntimeStateDeletionStore {
    readonly claims: Array<{ deleteStoredData: boolean; requestedByUserId: string }> = [];
    attemptsRecorded = 0;

    constructor(
        private row: WorkAppRuntimeStateDeletionView | null = runtimeState(),
        private readonly claimResult: boolean = true,
        private readonly order: string[] = [],
    ) {}

    async getOrCreate(workId: string): Promise<WorkAppRuntimeStateDeletionView> {
        this.order.push('state:getOrCreate');
        if (!this.row) {
            throw new Error('no runtime state row');
        }
        return { ...this.row, workId };
    }

    async claimDeletion(
        workId: string,
        opts: { deleteStoredData: boolean; requestedByUserId: string },
    ): Promise<boolean> {
        this.order.push('state:claimDeletion');
        if (!this.claimResult) {
            return false;
        }
        this.claims.push(opts);
        void workId;
        return true;
    }

    async recordDeletionAttempt(workId: string): Promise<number> {
        this.order.push('state:recordDeletionAttempt');
        this.attemptsRecorded += 1;
        void workId;
        return this.attemptsRecorded;
    }
}

/** APW-07's service: every call is journalled, and every answer is configurable per test. */
class FakeDependencies implements AppDependenciesService {
    readonly calls: Array<{ method: string; opts: unknown }> = [];

    constructor(
        private readonly order: string[],
        private readonly answers: {
            onAppWorkDeleting?: AppDependencyDeletionReport | undefined;
            onAppRemoved?: AppDependencyDeletionReport | undefined;
            list?: Array<{ kind: string; label?: string; sizeGiB?: number; names?: string[] }>;
        } = {},
    ) {}

    async onAppWorkDeleting(
        workId: string,
        opts: { deleteStoredData: boolean },
    ): Promise<AppDependencyDeletionReport | undefined> {
        this.calls.push({ method: 'onAppWorkDeleting', opts });
        this.order.push(`dependencies:onAppWorkDeleting:${opts.deleteStoredData}`);
        void workId;
        return this.answers.onAppWorkDeleting;
    }

    async onAppRemoved(
        workId: string,
        opts: { deleteData: boolean },
    ): Promise<AppDependencyDeletionReport | undefined> {
        this.calls.push({ method: 'onAppRemoved', opts });
        this.order.push(`dependencies:onAppRemoved:${opts.deleteData}`);
        void workId;
        return this.answers.onAppRemoved;
    }

    async list(workId: string): Promise<Array<{ kind: string; label?: string; sizeGiB?: number }>> {
        void workId;
        return this.answers.list ?? [];
    }
}

/** The service under test, with every seam bound to a fake that journals its calls. */
function harness(
    options: {
        row?: WorkAppRuntimeStateDeletionView | null;
        claimResult?: boolean;
        destroyResult?: unknown;
        destroyThrows?: Error | null;
        target?: 'your-cluster' | 'ever-works-apps';
        withDestroyApp?: boolean;
        withDispatcher?: boolean;
        withDependencies?: boolean;
        withFacade?: boolean;
        withDns?: boolean;
        withEvents?: boolean;
        withCompletion?: boolean;
        withRuntimeStates?: boolean;
        workUserId?: string | null;
        workKind?: string;
        dependencyAnswers?: ConstructorParameters<typeof FakeDependencies>[1];
    } = {},
): Harness {
    const order: string[] = [];
    const dispatches: Harness['dispatches'] = [];
    const destroyCalls: Harness['destroyCalls'] = [];
    const completionCalls: string[] = [];
    const emitted: Harness['events'] = [];
    const dnsCalls: string[] = [];

    const states = new FakeRuntimeStates(
        options.row === undefined ? runtimeState() : options.row,
        options.claimResult ?? true,
        order,
    );

    const dependencies =
        options.withDependencies === false
            ? undefined
            : new FakeDependencies(order, options.dependencyAnswers);

    const facade: AppRuntimeDeletionFacade | undefined =
        options.withFacade === false
            ? undefined
            : {
                  async resolveDeletionTarget(workId: string) {
                      order.push('facade:resolveDeletionTarget');
                      const target = options.target ?? TARGET_CLUSTER;
                      return {
                          target,
                          ref: { workId, namespace: NAMESPACE, target } as AppTargetRef,
                          credential: 'kubeconfig-for-work',
                          destroyApp:
                              options.withDestroyApp === false
                                  ? undefined
                                  : async (
                                        ref: AppTargetRef,
                                        credential: string,
                                        opts: { deleteVolumes: boolean },
                                    ): Promise<AppDestroyResult> => {
                                        order.push('destroyApp');
                                        destroyCalls.push({
                                            deleteVolumes: opts.deleteVolumes,
                                            namespace: ref.namespace,
                                        });
                                        void credential;
                                        if (options.destroyThrows) {
                                            throw options.destroyThrows;
                                        }
                                        return (options.destroyResult ?? {
                                            deleted: [{ kind: 'Deployment', name: 'web' }],
                                            kept: [
                                                {
                                                    kind: 'PersistentVolumeClaim',
                                                    name: 'data-postgres-0',
                                                },
                                            ],
                                            namespaceDeleted: false,
                                        }) as AppDestroyResult;
                                    },
                      };
                  },
              };

    const dispatcher: AppClusterOpDispatcher | undefined =
        options.withDispatcher === false
            ? undefined
            : {
                  async dispatch(payload, opts) {
                      order.push(`dispatcher:${payload.attempt ?? 1}`);
                      dispatches.push({ payload, delayMs: opts?.delayMs });
                      return 'run-1';
                  },
              };

    const appsDns: AppsDomainDnsService | undefined =
        options.withDns === false
            ? undefined
            : {
                  async removeRecord(workId: string) {
                      order.push('dns:removeRecord');
                      dnsCalls.push(workId);
                      return true;
                  },
              };

    const eventSink: AppRuntimeEventSink | undefined =
        options.withEvents === false
            ? undefined
            : {
                  async emit(event) {
                      order.push(`event:${event.name}`);
                      emitted.push(event);
                  },
              };

    const completion: AppWorkDeletionCompletion | undefined =
        options.withCompletion === false
            ? undefined
            : {
                  completeAppWorkDeletion(workId: string) {
                      order.push('completion:completeAppWorkDeletion');
                      completionCalls.push(workId);
                  },
              };

    const works = {
        async findById(id: string) {
            if (options.workUserId === null) {
                return null;
            }
            return {
                id,
                kind: options.workKind ?? 'app',
                userId: options.workUserId ?? 'user-1',
                slug: 'hello',
                name: 'Hello',
            };
        },
    } as unknown as ConstructorParameters<typeof AppRuntimeDeletionService>[0];

    const service = new AppRuntimeDeletionService(
        works,
        options.withRuntimeStates === false ? undefined : states,
        dependencies,
        facade,
        dispatcher,
        appsDns,
        eventSink,
        completion,
    );

    return {
        service,
        order,
        dispatches,
        claims: states.claims,
        destroyCalls,
        completionCalls,
        events: emitted,
        dependencyCalls: (dependencies?.calls ?? []) as Harness['dependencyCalls'],
        dnsCalls,
        states,
    };
}

/** The op as T70's router would hand it over (§9.2:1247). */
function op(overrides: Partial<AppDeleteWorkOpPayload> = {}): AppDeleteWorkOpPayload {
    return { op: APP_DELETE_WORK_OP, workId: 'work-1', attempt: 1, ...overrides };
}

/* -------------------------------------------------------------------------- *
 * The op, in §9.7's order
 * -------------------------------------------------------------------------- */

describe('the delete-app-work op runs in §9.7’s order (ACC-06-45)', () => {
    it('calls APW-07 before destroyApp, and passes deleteVolumes: false by default', async () => {
        const h = harness({ row: runtimeState({ deletionDeleteData: false }) });

        const result = await h.service.handleDeleteAppWork(op());

        // The order, not just the calls: APW-07 first, then the destroy, then the keep-path release.
        expect(h.order).toEqual([
            'state:getOrCreate',
            'dependencies:onAppWorkDeleting:false',
            'facade:resolveDeletionTarget',
            'destroyApp',
            'dependencies:onAppRemoved:false',
            'dns:removeRecord',
            'state:recordDeletionAttempt',
            'event:app.deploy.removed',
            'completion:completeAppWorkDeletion',
        ]);
        expect(h.destroyCalls).toEqual([{ deleteVolumes: false, namespace: NAMESPACE }]);
        expect(result.state).toBe('done');
        expect(result.namespaceDeleted).toBe(false);
    });

    it('deprovisions APW-07 before destroyApp(…, { deleteVolumes: true }) on the data path (ACC-06-46)', async () => {
        const h = harness({ row: runtimeState({ deletionDeleteData: true }) });

        await h.service.handleDeleteAppWork(op());

        const destroyIndex = h.order.indexOf('destroyApp');
        expect(destroyIndex).toBeGreaterThan(
            h.order.indexOf('dependencies:onAppWorkDeleting:true'),
        );
        expect(destroyIndex).toBeGreaterThan(h.order.indexOf('dependencies:onAppRemoved:true'));
        // …and the keep-path release does **not** run on the data path.
        expect(h.order).not.toContain('dependencies:onAppRemoved:false');
        expect(h.destroyCalls).toEqual([{ deleteVolumes: true, namespace: NAMESPACE }]);
    });

    it('keeps the volume delete when APW-07 reports `remaining` (§9.7:1497-1499)', async () => {
        const h = harness({
            row: runtimeState({ deletionDeleteData: true }),
            dependencyAnswers: {
                onAppRemoved: {
                    remaining: true,
                    mayRemain: [{ kind: 'postgres', name: 'dep-postgres' }],
                },
            },
        });

        const result = await h.service.handleDeleteAppWork(op());

        // The volume and namespace delete is skipped: the destroy is downgraded, not cancelled.
        expect(h.destroyCalls).toEqual([{ deleteVolumes: false, namespace: NAMESPACE }]);
        expect(result.state).toBe('may-remain');
        expect(result.code).toBe('dependencies_remaining');
        expect(result.mayRemain).toEqual(
            expect.arrayContaining([{ kind: 'postgres', name: 'dep-postgres' }]),
        );
        // Step 4 still runs: the Work is not left in `deleting` forever.
        expect(h.completionCalls).toEqual(['work-1']);
    });

    it('writes the Activity entry from the destruction result, names only', async () => {
        const h = harness({ row: runtimeState({ deletionDeleteData: false }) });

        const result = await h.service.handleDeleteAppWork(op());

        expect(h.events).toHaveLength(1);
        expect(h.events[0].name).toBe(APP_DEPLOY_REMOVED_EVENT);
        expect(h.events[0].payload.reason).toBe('app_work_deleted');
        expect(h.events[0].payload.target).toBe(TARGET_CLUSTER);
        expect(result.kept).toEqual([{ kind: 'PersistentVolumeClaim', name: 'data-postgres-0' }]);
        expect(h.events[0].payload.kept).toEqual(result.kept);
    });

    it('refuses an op that arrives for a Work whose state records no deletion', async () => {
        const h = harness({ row: runtimeState({ deletionRequestedAt: null }) });

        const result = await h.service.handleDeleteAppWork(op());

        expect(result.state).toBe('refused');
        expect(result.code).toBe('not_deleting');
        expect(h.destroyCalls).toEqual([]);
        expect(h.completionCalls).toEqual([]);
        expect(h.events).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * Ever Works Apps — the SAME destroyApp call, resolved for that target (R-5)
 * -------------------------------------------------------------------------- */

describe('an Ever Works Apps runtime is removed through the plugin that serves that target', () => {
    it('calls the resolved destroyApp — which on that target IS the apps-tier plugin — with deleteVolumes = deleteStoredData', async () => {
        const h = harness({
            row: runtimeState({ target: TARGET_TIER, deletionDeleteData: false }),
            target: TARGET_TIER,
        });

        const result = await h.service.handleDeleteAppWork(op());

        // The plan's letter (`plan.md:1500-1503`): the op calls `destroyApp` for every target and the
        // `apps-tier` plugin's own `destroyApp` is what maps to APW-10's `removeWork(workId, {
        // deleteData })`. `resolveAccess` resolved the plugin FOR THIS TARGET, so the call below is
        // that plugin's method — the service never has to know which plugin it is talking to.
        expect(h.destroyCalls).toEqual([{ deleteVolumes: false, namespace: NAMESPACE }]);
        expect(result.state).toBe('done');
        expect(result.target).toBe(TARGET_TIER);
    });

    it('carries the deleteStoredData boolean into deleteVolumes on the data path', async () => {
        const h = harness({
            row: runtimeState({ target: TARGET_TIER, deletionDeleteData: true }),
            target: TARGET_TIER,
        });

        await h.service.handleDeleteAppWork(op());

        expect(h.destroyCalls).toHaveLength(1);
        expect(h.destroyCalls[0].deleteVolumes).toBe(true);
    });

    it('answers target_unavailable, and retries, when no plugin serves the target', async () => {
        // The refusal is the PLUGIN's (the k8s plugin refuses `ever-works-apps` outright —
        // `assertThisPluginServes`, T14, covered by `k8s.plugin.spec.ts`), and this service's answer
        // to "nothing serves this target" is a retryable `target_unavailable` — never a silent
        // success and never a fallback to a plugin that did not claim the target.
        const h = harness({
            row: runtimeState({ target: TARGET_TIER }),
            target: TARGET_TIER,
            withDestroyApp: false,
        });

        const result = await h.service.handleDeleteAppWork(op());

        expect(h.destroyCalls).toEqual([]);
        expect(result.state).toBe('retry');
        expect(result.code).toBe('target_unavailable');
    });
});

/* -------------------------------------------------------------------------- *
 * The Activity payload (ACC-06-41, §9.4:1325-1326)
 * -------------------------------------------------------------------------- */

describe('the app.deploy.removed payload carries no host, token or address', () => {
    const FORBIDDEN_KEYS = [
        'host',
        'hostname',
        'url',
        'uri',
        'address',
        'ip',
        'server',
        'endpoint',
        'namespace',
        'token',
        'secret',
        'password',
        'kubeconfig',
        'value',
        'values',
        'env',
    ];

    /** Every key and every string leaf of a payload, however deeply nested. */
    function walk(value: unknown, path: string, keys: string[], strings: string[]): void {
        if (Array.isArray(value)) {
            value.forEach((entry, index) => walk(entry, `${path}[${index}]`, keys, strings));
            return;
        }
        if (value && typeof value === 'object') {
            for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
                keys.push(key.toLowerCase());
                walk(entry, `${path}.${key}`, keys, strings);
            }
            return;
        }
        if (typeof value === 'string') {
            strings.push(value);
        }
    }

    it('has no forbidden key, no URL and no address', async () => {
        const h = harness({
            row: runtimeState({
                deletionDeleteData: false,
                statusSnapshot: { components: [{ name: 'web' }] },
            }),
        });

        await h.service.handleDeleteAppWork(op());

        const keys: string[] = [];
        const strings: string[] = [];
        walk(h.events[0].payload, 'payload', keys, strings);

        expect(keys.filter((key) => FORBIDDEN_KEYS.includes(key))).toEqual([]);
        expect(strings.filter((text) => text.includes('://'))).toEqual([]);
        expect(strings.filter((text) => /\b\d{1,3}(\.\d{1,3}){3}\b/.test(text))).toEqual([]);
        // Known-good control: the scan really reads the payload's leaves.
        expect(strings).toEqual(expect.arrayContaining([TARGET_CLUSTER, 'data-postgres-0']));
        // Kinds and names only — the object list is exactly what the plugin reported.
        expect(h.events[0].payload.kept).toEqual([
            { kind: 'PersistentVolumeClaim', name: 'data-postgres-0' },
        ]);
        expect(h.events[0].payload.deletedCount).toBe(1);
    });

    it('reports what may remain when the cluster was unreachable', async () => {
        const h = harness({
            destroyThrows: new Error('connect ECONNREFUSED'),
            row: runtimeState({
                deletionRequestedAt: new Date(Date.now() - 2 * APP_WORK_DELETION_RETRY_DELAY_MS),
            }),
        });

        const first = await h.service.handleDeleteAppWork(op({ attempt: 3 }));

        expect(first.state).toBe('may-remain');
        // Names only, and each one is a Kubernetes object name rather than an address.
        expect(first.mayRemain).toContainEqual({ kind: 'Component', name: 'web' });
        expect(first.mayRemain).toContainEqual({ kind: 'Namespace', name: NAMESPACE });
        expect(h.events[0].payload.mayRemain).toEqual(first.mayRemain);
    });
});

/* -------------------------------------------------------------------------- *
 * The retry policy (3 attempts over 15 minutes, §9.7:1509-1510)
 * -------------------------------------------------------------------------- */

describe('the retry policy: three attempts over fifteen minutes', () => {
    it('spaces the attempts five minutes apart, and never schedules a fourth', () => {
        expect(APP_WORK_DELETION_MAX_ATTEMPTS).toBe(3);
        expect(APP_WORK_DELETION_RETRY_DELAY_MS).toBe(300_000);
        expect(APP_WORK_DELETION_ATTEMPT_WINDOW_MS).toBe(900_000);

        expect(deletionRetryDelayMs({ attempt: 1, elapsedMs: 0 })).toBe(300_000);
        expect(deletionRetryDelayMs({ attempt: 2, elapsedMs: 300_000 })).toBe(300_000);
        // The third attempt is the ceiling: the fourth is not scheduled…
        expect(deletionRetryDelayMs({ attempt: 3, elapsedMs: 600_000 })).toBeNull();
        expect(deletionRetryDelayMs({ attempt: 4, elapsedMs: 900_000 })).toBeNull();
        // …and neither is one that would fall outside the fifteen-minute window.
        expect(deletionRetryDelayMs({ attempt: 2, elapsedMs: 800_000 })).toBeNull();
    });

    it('schedules attempts 2 and 3 after five minutes, then finishes with mayRemain[]', async () => {
        const h = harness({ destroyThrows: new Error('cluster unreachable') });
        const requestedAtMs = Date.now();

        const first = await h.service.handleDeleteAppWork(op({ attempt: 1, requestedAtMs }));
        const second = await h.service.handleDeleteAppWork(op({ attempt: 2, requestedAtMs }));
        const third = await h.service.handleDeleteAppWork(op({ attempt: 3, requestedAtMs }));

        expect(first.state).toBe('retry');
        expect(first.retryInMs).toBe(APP_WORK_DELETION_RETRY_DELAY_MS);
        expect(second.state).toBe('retry');
        expect(third.state).toBe('may-remain');
        expect(third.code).toBe('attempts_exhausted');

        // Three attempts in total: two retries were dispatched, and the third scheduled nothing.
        expect(h.dispatches.map((entry) => entry.payload.attempt)).toEqual([2, 3]);
        expect(h.dispatches.map((entry) => entry.delayMs)).toEqual([300_000, 300_000]);
        expect(h.destroyCalls).toHaveLength(3);
        // A fourth dispatch never happens; the completion is what ends the removal.
        expect(h.completionCalls).toEqual(['work-1']);
        expect(h.events).toHaveLength(1);
        expect(h.events[0].payload.mayRemain).toEqual(
            expect.arrayContaining([{ kind: 'Component', name: 'web' }]),
        );
    });

    it('refuses to schedule a fourth attempt', async () => {
        const h = harness({ destroyThrows: new Error('cluster unreachable') });

        const fourth = await h.service.handleDeleteAppWork(op({ attempt: 4 }));

        expect(fourth.state).toBe('may-remain');
        expect(fourth.code).toBe('attempts_exhausted');
        expect(fourth.retryInMs).toBeUndefined();
        expect(h.dispatches).toEqual([]);
    });

    it('gives up instead of promising an attempt past the fifteen-minute window', async () => {
        const h = harness({ destroyThrows: new Error('cluster unreachable') });
        const requestedAtMs = Date.now() - 800_000;

        const result = await h.service.handleDeleteAppWork(op({ attempt: 2, requestedAtMs }));

        expect(result.state).toBe('may-remain');
        expect(result.code).toBe('window_exhausted');
        expect(h.dispatches).toEqual([]);
        expect(h.completionCalls).toEqual(['work-1']);
    });

    it('never reaches APW-01’s completion on an attempt that will be retried', async () => {
        const h = harness({ destroyThrows: new Error('cluster unreachable') });

        const result = await h.service.handleDeleteAppWork(op({ attempt: 1 }));

        expect(result.state).toBe('retry');
        expect(result.completed).toBe(false);
        expect(h.completionCalls).toEqual([]);
        expect(h.events).toEqual([]);
    });

    it('reports `scheduled: false` when a retry is due but no dispatcher is bound', async () => {
        const h = harness({
            destroyThrows: new Error('cluster unreachable'),
            withDispatcher: false,
        });

        const result = await h.service.handleDeleteAppWork(op({ attempt: 1 }));

        expect(result.state).toBe('retry');
        expect(result.scheduled).toBe(false);
        expect(result.retryInMs).toBe(APP_WORK_DELETION_RETRY_DELAY_MS);
        expect(h.completionCalls).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * APW-01's completion, exactly once
 * -------------------------------------------------------------------------- */

describe('completeAppWorkDeletion is called exactly once, and only for a finished removal', () => {
    it('is called once after a successful removal', async () => {
        const h = harness({});

        await h.service.handleDeleteAppWork(op());

        expect(h.completionCalls).toEqual(['work-1']);
        expect(h.order.filter((entry) => entry.startsWith('completion:'))).toEqual([
            'completion:completeAppWorkDeletion',
        ]);
    });

    it('is not called after a failure that is retried', async () => {
        const h = harness({ destroyThrows: new Error('cluster unreachable') });

        await h.service.handleDeleteAppWork(op({ attempt: 1 }));

        expect(h.completionCalls).toEqual([]);
    });

    it('is called once when the removal is given up after the third attempt (§9.7:1509-1510)', async () => {
        const h = harness({ destroyThrows: new Error('cluster unreachable') });

        await h.service.handleDeleteAppWork(op({ attempt: 3 }));

        expect(h.completionCalls).toEqual(['work-1']);
    });

    it('keeps the Work row when the completion seam is not bound', async () => {
        const h = harness({ withCompletion: false });

        const result = await h.service.handleDeleteAppWork(op());

        expect(result.state).toBe('done');
        expect(result.completed).toBe(false);
        expect(h.destroyCalls).toHaveLength(1);
        // The answer says the row was not deleted, rather than pretending it was.
        await expect(h.service.finishDeletion('work-1')).resolves.toEqual({
            completed: false,
            reason: 'completion_unavailable',
        });
    });
});

/* -------------------------------------------------------------------------- *
 * requestDeletion — §9.7's three rows (plan.md:1486-1490)
 * -------------------------------------------------------------------------- */

describe('requestDeletion follows §9.7’s table', () => {
    it('answers done, with zero dispatches, for a Work whose target is none', async () => {
        const h = harness({
            row: runtimeState({
                target: TARGET_NONE,
                namespace: null,
                currentDeploymentId: null,
                deletionRequestedAt: null,
            }),
        });

        const outcome = await h.service.requestDeletion({
            workId: 'work-1',
            userId: 'user-1',
            deleteStoredData: false,
        });

        expect(outcome).toEqual({
            status: 'done',
            target: TARGET_NONE,
            reason: 'nothing_deployed',
        });
        expect(h.dispatches).toEqual([]);
        expect(h.claims).toEqual([]);
        // APW-07 still ran, in-process, so its rows are marked kept (APW-07 §4.12).
        expect(h.dependencyCalls).toEqual([
            { method: 'onAppWorkDeleting', opts: { deleteStoredData: false } },
        ]);
    });

    it('answers done for a Work that was never deployed', async () => {
        const h = harness({
            row: runtimeState({
                namespace: null,
                currentDeploymentId: null,
                deletionRequestedAt: null,
            }),
        });

        const outcome = await h.service.requestDeletion({
            workId: 'work-1',
            userId: 'user-1',
            deleteStoredData: true,
        });

        expect(outcome.status).toBe('done');
        expect(h.dispatches).toEqual([]);
        expect(h.dependencyCalls).toEqual([
            { method: 'onAppWorkDeleting', opts: { deleteStoredData: true } },
        ]);
    });

    it('claims a live App Work and dispatches exactly one delete-app-work op', async () => {
        const h = harness({ row: runtimeState({ deletionRequestedAt: null }) });

        const outcome = await h.service.requestDeletion({
            workId: 'work-1',
            userId: 'user-1',
            deleteStoredData: true,
        });

        expect(outcome).toEqual({ status: 'pending', target: TARGET_CLUSTER });
        expect(h.claims).toEqual([{ deleteStoredData: true, requestedByUserId: 'user-1' }]);
        expect(h.dispatches).toHaveLength(1);
        expect(h.dispatches[0].payload.op).toBe(APP_DELETE_WORK_OP);
        expect(h.dispatches[0].payload.workId).toBe('work-1');
        expect(h.dispatches[0].payload.attempt).toBe(1);
        expect(typeof h.dispatches[0].payload.requestedAtMs).toBe('number');
    });

    it('is idempotent: a second request while pending claims and dispatches nothing', async () => {
        const h = harness({
            row: runtimeState({ deletionRequestedAt: new Date('2026-09-17T10:00:00.000Z') }),
        });

        const outcome = await h.service.requestDeletion({
            workId: 'work-1',
            userId: 'user-1',
            deleteStoredData: false,
        });

        expect(outcome).toEqual({
            status: 'pending',
            target: TARGET_CLUSTER,
            reason: 'already_deleting',
        });
        expect(h.dispatches).toEqual([]);
        expect(h.claims).toEqual([]);
    });

    it('answers pending without a claim when the dispatcher is not bound (§9.2:1261-1266)', async () => {
        const h = harness({
            row: runtimeState({ deletionRequestedAt: null }),
            withDispatcher: false,
        });

        const outcome = await h.service.requestDeletion({
            workId: 'work-1',
            userId: 'user-1',
            deleteStoredData: false,
        });

        expect(outcome).toEqual({
            status: 'pending',
            target: TARGET_CLUSTER,
            reason: 'dispatcher_unavailable',
        });
        expect(h.claims).toEqual([]);
    });

    it('refuses a Work that is not the caller’s, exactly as an unknown id', async () => {
        const h = harness({ workUserId: 'someone-else' });

        await expect(
            h.service.requestDeletion({
                workId: 'work-1',
                userId: 'user-1',
                deleteStoredData: false,
            }),
        ).rejects.toBeInstanceOf(AppWorkDeletionRefusalError);

        const foreign = await refusalOf(h.service, 'work-1', 'user-1');
        const missing = await refusalOf(h.service, 'work-9', 'user-1');

        expect(foreign).toEqual({ code: 'not_found', status: 404, message: missing.message });
        expect(h.claims).toEqual([]);
        expect(h.dispatches).toEqual([]);
        expect(h.dependencyCalls).toEqual([]);
    });

    it('refuses a Work that is not kind app', async () => {
        const h = harness({ workKind: 'repo' });

        const refusal = await refusalOf(h.service, 'work-1', 'user-1');

        expect(refusal.code).toBe('not_found');
        expect(h.dispatches).toEqual([]);
    });

    it('keeps the row instead of reporting done when the runtime state cannot be read', async () => {
        const h = harness({ row: null });

        const outcome = await h.service.requestDeletion({
            workId: 'work-1',
            userId: 'user-1',
            deleteStoredData: false,
        });

        expect(outcome).toEqual({
            status: 'pending',
            target: TARGET_NONE,
            reason: 'runtime_state_unreadable',
        });
        expect(h.dispatches).toEqual([]);
        expect(h.claims).toEqual([]);
    });

    it('takes the done path when no runtime-state store is bound at all', async () => {
        const h = harness({ withRuntimeStates: false });

        const outcome = await h.service.requestDeletion({
            workId: 'work-1',
            userId: 'user-1',
            deleteStoredData: false,
        });

        expect(outcome).toEqual({
            status: 'done',
            target: TARGET_NONE,
            reason: 'nothing_deployed',
        });
        expect(h.claims).toEqual([]);
        expect(h.dispatches).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * preview (plan §9.7:1477-1479)
 * -------------------------------------------------------------------------- */

describe('preview lists names and sizes only', () => {
    it('lists the dependencies and their sizes, and marks a deletion in progress', async () => {
        const h = harness({
            row: runtimeState({ deletionRequestedAt: new Date('2026-09-17T10:00:00.000Z') }),
            dependencyAnswers: {
                list: [
                    {
                        kind: 'postgres',
                        label: 'Postgres',
                        sizeGiB: 10,
                        names: ['dep-postgres'],
                    },
                    { kind: 'redis', label: 'Redis', sizeGiB: 1 },
                ],
            },
        });

        const preview = await h.service.preview('work-1');

        expect(preview.deferred).toBe(true);
        expect(preview.keeps).toEqual([
            { kind: 'Component', name: 'web' },
            { kind: 'Component', name: 'worker' },
            { kind: 'postgres', label: 'Postgres', sizeGiB: 10 },
            { kind: 'redis', label: 'Redis', sizeGiB: 1 },
        ]);
        expect(preview.destroysWithData).toEqual([
            { kind: 'postgres', label: 'Postgres', sizeGiB: 10 },
            { kind: 'postgres', name: 'dep-postgres' },
            { kind: 'redis', label: 'Redis', sizeGiB: 1 },
        ]);
        // Names and sizes only: no value, no host, no kubeconfig ever reaches this shape.
        expect(JSON.stringify(preview)).not.toContain(NAMESPACE);
    });
});

/* -------------------------------------------------------------------------- *
 * Fail-closed: the module compiles with nothing bound
 * -------------------------------------------------------------------------- */

describe('the service is constructible with nothing bound (like AppUpstreamStateService)', () => {
    it('constructs with no arguments and answers every entry point', async () => {
        const service = new AppRuntimeDeletionService();

        await expect(service.preview('work-1')).resolves.toEqual({
            deferred: false,
            keeps: [],
            destroysWithData: [],
        });

        // No WorkRepository ⇒ the refusal, never a silent deletion.
        await expect(
            service.requestDeletion({
                workId: 'work-1',
                userId: 'user-1',
                deleteStoredData: false,
            }),
        ).rejects.toBeInstanceOf(AppWorkDeletionRefusalError);

        const result = await service.handleDeleteAppWork({
            op: 'delete-app-work',
            workId: 'work-1',
            attempt: 1,
        });

        // Nothing is deleted and nothing is reported as done: the op asks for a retry it cannot
        // schedule, which is the honest answer for a graph with no cluster access in it.
        expect(result.state).toBe('retry');
        expect(result.code).toBe('facade_unavailable');
        expect(result.scheduled).toBe(false);
        expect(result.deleted).toEqual([]);
        expect(result.completed).toBe(false);
    });

    it('never reports a removal when the event sink is absent', async () => {
        const h = harness({ withEvents: false });

        const result = await h.service.handleDeleteAppWork(op());

        expect(result.state).toBe('done');
        expect(h.destroyCalls).toHaveLength(1);
        expect(h.completionCalls).toEqual(['work-1']);
    });

    it('records the leftover DNS record in mayRemain[] when the DNS seam is absent', async () => {
        const h = harness({ withDns: false });

        const result = await h.service.handleDeleteAppWork(op());

        expect(result.state).toBe('done');
        expect(result.mayRemain).toContainEqual({
            kind: 'DnsRecord',
            name: 'managed-subdomain',
        });
        expect(h.events[0].payload.mayRemain).toEqual(result.mayRemain);
    });
});

/* -------------------------------------------------------------------------- *
 * The port binding (plan §9.8:1524-1536) — the API file T33 owns does not exist yet
 * -------------------------------------------------------------------------- */

describe('the APP_WORK_DELETION_PORT binding is the lazy, cycle-safe one §9.8 fixes', () => {
    it('is a useFactory with inject: [ModuleRef], never useExisting or useClass', () => {
        expect(APP_WORK_DELETION_PORT_PROVIDER.provide).toBe(APP_WORK_DELETION_PORT);
        expect((APP_WORK_DELETION_PORT_PROVIDER as { useExisting?: unknown }).useExisting).toBe(
            undefined,
        );
        expect((APP_WORK_DELETION_PORT_PROVIDER as { useClass?: unknown }).useClass).toBe(
            undefined,
        );
        expect(APP_WORK_DELETION_PORT_PROVIDER.inject).toEqual([ModuleRef]);
        expect(typeof APP_WORK_DELETION_PORT_PROVIDER.useFactory).toBe('function');
    });

    it('resolves AppRuntimeDeletionService when called, and delegates to it', async () => {
        const h = harness({
            row: runtimeState({ target: TARGET_NONE, namespace: null, deletionRequestedAt: null }),
        });
        const moduleRef = {
            get: (token: unknown) => {
                expect(token).toBe(AppRuntimeDeletionService);
                return h.service;
            },
        } as unknown as ModuleRef;

        const factory = APP_WORK_DELETION_PORT_PROVIDER.useFactory as (ref: ModuleRef) => {
            requestDeletion: (input: unknown) => Promise<unknown>;
        };
        const port = factory(moduleRef);

        const outcome = await port.requestDeletion({
            workId: 'work-1',
            userId: 'user-1',
            deleteStoredData: false,
        });

        expect(outcome).toEqual({
            status: 'done',
            target: TARGET_NONE,
            reason: 'nothing_deployed',
        });
        expect(h.dependencyCalls).toEqual([
            { method: 'onAppWorkDeleting', opts: { deleteStoredData: false } },
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * The port's token is APW-01's — one Symbol, not two that share a name
 * -------------------------------------------------------------------------- */

/**
 * The consumer shape `WorkLifecycleService` has (`work-lifecycle.service.ts`, its last
 * constructor parameter): `@Optional()` and injected by APW-01's own token. A synthetic class,
 * so this proves the DI edge without booting the Work lifecycle's whole graph.
 */
@Injectable()
class Apw01DeletionPortConsumer {
    constructor(
        @Optional()
        @Inject(APW01_APP_WORK_DELETION_PORT)
        readonly port?: Apw01AppWorkDeletionPort,
    ) {}
}

describe('APP_WORK_DELETION_PORT_PROVIDER provides the token APW-01 injects', () => {
    // The defect this closes: this file used to declare its own
    // `Symbol('APP_WORK_DELETION_PORT')` while `app-work-deletion.port.ts` declared another.
    // A Nest token is compared by IDENTITY, so the provider bound a token nobody injected and
    // `WorkLifecycleService`'s `@Optional()` port stayed `undefined` — which `deleteWork` takes as
    // "no App runtime, delete the row now", leaving a deployed App Work's workloads running.
    // The two Symbols print identically; only identity tells them apart.

    it('is the very Symbol app-work-deletion.port.ts declares', () => {
        expect(APP_WORK_DELETION_PORT_PROVIDER.provide).toBe(APW01_APP_WORK_DELETION_PORT);
        expect(APP_WORK_DELETION_PORT).toBe(APW01_APP_WORK_DELETION_PORT);
        // Negative control: a same-named Symbol is a different token, so the two assertions
        // above cannot pass by description alone.
        expect(APW01_APP_WORK_DELETION_PORT).not.toBe(Symbol('APP_WORK_DELETION_PORT') as unknown);
    });

    it('reaches an @Optional() @Inject(APW-01 token) consumer in a real Nest container', async () => {
        const requests: unknown[] = [];
        const fakeService = {
            requestDeletion: async (input: unknown) => {
                requests.push(input);
                return { status: 'pending', target: TARGET_CLUSTER, reason: 'dispatched' };
            },
        };

        const moduleRef = await Test.createTestingModule({
            providers: [
                APP_WORK_DELETION_PORT_PROVIDER,
                { provide: AppRuntimeDeletionService, useValue: fakeService },
                Apw01DeletionPortConsumer,
            ],
        }).compile();

        try {
            const consumer = moduleRef.get(Apw01DeletionPortConsumer);

            // Undefined here is the whole defect: `deleteWork` would delete the row at once.
            expect(consumer.port).toBeDefined();

            const outcome = await consumer.port.requestDeletion({
                workId: 'work-1',
                userId: 'user-1',
                deleteStoredData: true,
            });

            expect(outcome).toEqual({
                status: 'pending',
                target: TARGET_CLUSTER,
                reason: 'dispatched',
            });
            expect(requests).toEqual([
                { workId: 'work-1', userId: 'user-1', deleteStoredData: true },
            ]);
        } finally {
            await moduleRef.close();
        }
    });
});

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

/** The refusal a `requestDeletion` throws, as a comparable shape. */
async function refusalOf(
    service: AppRuntimeDeletionService,
    workId: string,
    userId: string,
): Promise<{ code: string; status: number; message: string }> {
    try {
        await service.requestDeletion({ workId, userId, deleteStoredData: false });
    } catch (error) {
        const refusal = error as AppWorkDeletionRefusalError;
        return { code: refusal.code, status: refusal.status, message: refusal.message };
    }
    throw new Error('Expected the deletion request to be refused, but it resolved.');
}
