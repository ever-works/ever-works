/**
 * Lane aw-safety (2026-10-26) — the deletion state machine's safety edges, beside T58's own spec
 * (`app-runtime-deletion.service.spec.ts`, which is unchanged).
 *
 * Each case is one way an App Work's delete used to end with the Work row gone and its workloads
 * still running, or with a Work reading **Deleting…** while nothing ran the removal:
 *
 * | state | request | answer |
 * | --- | --- | --- |
 * | a Deployment holds the lock (first deploy: no namespace yet) | delete | `pending/deploy_in_progress`, nothing claimed |
 * | the gate says it is off | delete | `pending/dispatcher_unavailable`, nothing claimed |
 * | the claim write throws | delete | `pending/runtime_state_unreadable` |
 * | the claim lost to a Deployment | delete | `pending/deploy_in_progress` |
 * | claimed, dispatch answered `null` / threw | delete | claim RELEASED, `pending/dispatcher_unavailable` |
 * | claim older than 30 min | delete again | ONE fresh dispatch (`redispatched`), compare-and-set |
 * | claim fresh | delete again | `already_deleting`, nothing dispatched |
 * | caller is a member with role `owner` | delete | admitted (was `not_found` → "done") |
 *
 * …and the no-cluster case end to end: three unreachable attempts, five minutes apart, then the
 * completion runs ONCE with the report the owner is told (`mayRemain[]`, the target, the code).
 */

import {
    APP_DELETE_WORK_OP,
    APP_WORK_DELETION_RETRY_DELAY_MS,
    APP_WORK_DELETION_STALE_AFTER_MS,
    AppRuntimeDeletionService,
    AppWorkDeletionRefusalError,
    type AppClusterOpDispatcher,
    type AppDeleteWorkOpPayload,
    type AppRuntimeDeletionFacade,
    type AppWorkDeletionCompletion,
    type AppWorkDeletionCompletionReport,
    type WorkAppRuntimeStateDeletionStore,
    type WorkAppRuntimeStateDeletionView,
} from '../app-runtime-deletion.service';
import { workerAppWorkDeletionCompletion } from '../app-runtime-worker.adapters';
import {
    APP_WORK_DELETION_NOT_STARTED_REASONS,
    isAppWorkDeletionNotStarted,
} from '../../app-works/app-work-deletion.port';
import { WorkMemberRepository } from '../../database/repositories/work-member.repository';
import { WorkMemberRole } from '../../entities/types';
import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import type { AppRuntimeEventSink } from '../ports';

const NAMESPACE = 'ew-hello-1a2b3c4d';
const NOW = Date.UTC(2026, 9, 26, 22, 0, 0);

function row(
    overrides: Partial<WorkAppRuntimeStateDeletionView> = {},
): WorkAppRuntimeStateDeletionView {
    return {
        workId: 'work-1',
        target: 'your-cluster',
        namespace: NAMESPACE,
        currentDeploymentId: 'deployment-1',
        deployLockId: null,
        deletionRequestedAt: null,
        deletionDeleteData: false,
        deletionAttempts: 0,
        deletionRequestedByUserId: null,
        statusSnapshot: { components: [{ name: 'web' }] },
        ...overrides,
    };
}

/** A runtime-state store whose every write is journalled. */
class Store implements WorkAppRuntimeStateDeletionStore {
    readonly calls: string[] = [];
    claimAnswer: boolean | Error = true;
    reclaimAnswer: boolean | undefined = undefined;
    released = 0;

    constructor(
        public current: WorkAppRuntimeStateDeletionView,
        private readonly afterFailedClaim?: WorkAppRuntimeStateDeletionView,
        readonly supports: { release?: boolean; reclaim?: boolean } = {
            release: true,
            reclaim: true,
        },
    ) {
        if (!supports.release) {
            (this as { releaseDeletionClaim?: unknown }).releaseDeletionClaim = undefined;
        }
        if (!supports.reclaim) {
            (this as { reclaimStaleDeletion?: unknown }).reclaimStaleDeletion = undefined;
        }
    }

    async getOrCreate(): Promise<WorkAppRuntimeStateDeletionView> {
        this.calls.push('getOrCreate');
        return { ...this.current };
    }

    async claimDeletion(
        workId: string,
        opts: { deleteStoredData: boolean; requestedByUserId: string },
    ): Promise<boolean> {
        this.calls.push(`claim:${opts.requestedByUserId}`);
        if (this.claimAnswer instanceof Error) throw this.claimAnswer;
        if (!this.claimAnswer) {
            if (this.afterFailedClaim) this.current = this.afterFailedClaim;
            return false;
        }
        this.current = {
            ...this.current,
            deletionRequestedAt: new Date(NOW),
            deletionDeleteData: opts.deleteStoredData,
            deletionRequestedByUserId: opts.requestedByUserId,
        };
        void workId;
        return true;
    }

    async recordDeletionAttempt(): Promise<number> {
        this.calls.push('attempt');
        return 1;
    }

    async releaseDeletionClaim(): Promise<boolean> {
        this.calls.push('release');
        this.released += 1;
        this.current = {
            ...this.current,
            deletionRequestedAt: null,
            deletionRequestedByUserId: null,
        };
        return true;
    }

    async reclaimStaleDeletion(workId: string, staleBefore: Date): Promise<boolean> {
        this.calls.push(`reclaim:${staleBefore.toISOString()}`);
        void workId;
        return this.reclaimAnswer ?? true;
    }
}

interface Rig {
    service: AppRuntimeDeletionService;
    store: Store;
    dispatches: Array<{ payload: AppDeleteWorkOpPayload; delayMs?: number }>;
    completions: Array<{ workId: string; report?: AppWorkDeletionCompletionReport }>;
    events: Array<{ name: string; payload: Record<string, unknown> }>;
    destroyCalls: number;
}

function rig(
    options: {
        state?: WorkAppRuntimeStateDeletionView;
        afterFailedClaim?: WorkAppRuntimeStateDeletionView;
        dispatchAnswer?: string | null | Error;
        gateEnabled?: boolean;
        workUserId?: string;
        memberRole?: WorkMemberRole | null;
        moduleRefMissing?: boolean;
        destroyThrows?: boolean;
        supports?: { release?: boolean; reclaim?: boolean };
        now?: number;
    } = {},
): Rig {
    const store = new Store(options.state ?? row(), options.afterFailedClaim, options.supports);
    const dispatches: Rig['dispatches'] = [];
    const completions: Rig['completions'] = [];
    const events: Rig['events'] = [];
    let destroyCalls = 0;

    const dispatcher: AppClusterOpDispatcher & { isEnabled?: () => boolean } = {
        async dispatch(payload, opts) {
            dispatches.push({ payload, delayMs: opts?.delayMs });
            const answer = options.dispatchAnswer === undefined ? 'run-1' : options.dispatchAnswer;
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
    if (options.gateEnabled !== undefined) {
        dispatcher.isEnabled = () => options.gateEnabled as boolean;
    }

    const facade: AppRuntimeDeletionFacade = {
        async resolveDeletionTarget(workId: string) {
            return {
                target: 'your-cluster',
                ref: { workId, namespace: NAMESPACE } as never,
                credential: 'kubeconfig',
                destroyApp: async () => {
                    destroyCalls += 1;
                    if (options.destroyThrows) throw new Error('connect ECONNREFUSED');
                    return {
                        deleted: [{ kind: 'Deployment', name: 'web' }],
                        kept: [],
                        namespaceDeleted: true,
                    };
                },
            };
        },
    };

    const events$: AppRuntimeEventSink = {
        async emit(event) {
            events.push(event);
        },
    };

    const completion: AppWorkDeletionCompletion = {
        completeAppWorkDeletion(workId: string, report?: AppWorkDeletionCompletionReport) {
            completions.push({ workId, report });
        },
    };

    const works = {
        async findById(id: string) {
            return {
                id,
                kind: 'app',
                userId: options.workUserId ?? 'owner-1',
                slug: 'hello',
                name: 'Hello',
            };
        },
    };

    const members = {
        async findMember(workId: string, userId: string) {
            void workId;
            if (options.memberRole === undefined || options.memberRole === null) return null;
            return { userId, role: options.memberRole };
        },
    };
    const moduleRef = {
        get(token: unknown) {
            if (options.moduleRefMissing || token !== WorkMemberRepository) {
                throw new UnknownElementException('WorkMemberRepository');
            }
            return members;
        },
    };

    class Clocked extends AppRuntimeDeletionService {
        protected override nowMs(): number {
            return options.now ?? NOW;
        }
    }

    const service = new Clocked(
        works as never,
        store,
        undefined,
        facade,
        dispatcher,
        { removeRecord: async () => true },
        events$,
        completion,
        moduleRef as never,
    );

    return {
        service,
        store,
        dispatches,
        completions,
        events,
        get destroyCalls() {
            return destroyCalls;
        },
    } as Rig;
}

const request = (userId = 'owner-1') => ({ workId: 'work-1', userId, deleteStoredData: false });

describe('requestDeletion never starts what it cannot finish (lane aw-safety)', () => {
    it('refuses to claim while a Deployment holds the lock — even the first one, with no namespace yet', async () => {
        const r = rig({
            state: row({
                deployLockId: 'deployment-2',
                namespace: null,
                currentDeploymentId: null,
            }),
        });

        const outcome = await r.service.requestDeletion(request());

        expect(outcome).toEqual({
            status: 'pending',
            target: 'your-cluster',
            reason: 'deploy_in_progress',
        });
        expect(isAppWorkDeletionNotStarted(outcome)).toBe(true);
        expect(r.store.calls.filter((c) => c.startsWith('claim'))).toEqual([]);
        expect(r.dispatches).toEqual([]);
    });

    it('does not claim when the gate says it is switched off', async () => {
        const r = rig({ gateEnabled: false });

        const outcome = await r.service.requestDeletion(request());

        expect(outcome.reason).toBe('dispatcher_unavailable');
        expect(isAppWorkDeletionNotStarted(outcome)).toBe(true);
        expect(r.store.calls.filter((c) => c.startsWith('claim'))).toEqual([]);
        expect(r.dispatches).toEqual([]);
    });

    it('answers the not-started reason when the claim cannot be written (never "a throw is done")', async () => {
        const r = rig();
        r.store.claimAnswer = new Error('connection terminated');

        const outcome = await r.service.requestDeletion(request());

        expect(outcome).toEqual({
            status: 'pending',
            target: 'your-cluster',
            reason: 'runtime_state_unreadable',
        });
        expect(r.dispatches).toEqual([]);
    });

    it('tells a claim lost to a Deployment apart from a concurrent delete', async () => {
        const r = rig({ afterFailedClaim: row({ deployLockId: 'deployment-3' }) });
        r.store.claimAnswer = false;

        const outcome = await r.service.requestDeletion(request());

        expect(outcome.reason).toBe('deploy_in_progress');
        expect(r.dispatches).toEqual([]);
    });

    it.each([
        ['answers null', null],
        ['throws', new Error('trigger down')],
    ])('releases its own claim when the dispatch %s', async (_label, answer) => {
        const r = rig({ dispatchAnswer: answer as string | null | Error });

        const outcome = await r.service.requestDeletion(request());

        expect(outcome).toEqual({
            status: 'pending',
            target: 'your-cluster',
            reason: 'dispatcher_unavailable',
        });
        expect(r.dispatches).toHaveLength(1);
        expect(r.store.released).toBe(1);
        // The Work is exactly as it was: no deletion recorded, so it does not read "Deleting…".
        expect(r.store.current.deletionRequestedAt).toBeNull();
    });

    it('keeps the claim (and says so in the log) when the store cannot release it', async () => {
        const r = rig({ dispatchAnswer: null, supports: { release: false, reclaim: true } });

        const outcome = await r.service.requestDeletion(request());

        expect(outcome.reason).toBe('dispatcher_unavailable');
        expect(r.store.released).toBe(0);
    });

    it('claims and dispatches exactly once on the happy path', async () => {
        const r = rig();

        const outcome = await r.service.requestDeletion(request());

        expect(outcome).toEqual({ status: 'pending', target: 'your-cluster' });
        expect(isAppWorkDeletionNotStarted(outcome)).toBe(false);
        expect(r.dispatches).toHaveLength(1);
        expect(r.dispatches[0].payload).toMatchObject({
            op: APP_DELETE_WORK_OP,
            workId: 'work-1',
            attempt: 1,
        });
        expect(r.store.released).toBe(0);
    });
});

describe('a stale claim is re-dispatched once, and only once (lane aw-safety)', () => {
    const stale = () =>
        row({ deletionRequestedAt: new Date(NOW - APP_WORK_DELETION_STALE_AFTER_MS - 1_000) });

    it('re-dispatches a claim older than the stale window when the compare-and-set wins', async () => {
        const r = rig({ state: stale() });

        const outcome = await r.service.requestDeletion(request());

        expect(outcome).toEqual({
            status: 'pending',
            target: 'your-cluster',
            reason: 'redispatched',
        });
        expect(r.dispatches).toHaveLength(1);
        expect(r.dispatches[0].payload).toMatchObject({
            op: APP_DELETE_WORK_OP,
            attempt: 1,
            requestedAtMs: NOW,
        });
        expect(r.store.calls).toContain(
            `reclaim:${new Date(NOW - APP_WORK_DELETION_STALE_AFTER_MS).toISOString()}`,
        );
    });

    it('dispatches nothing when another request won the re-claim', async () => {
        const r = rig({ state: stale() });
        r.store.reclaimAnswer = false;

        const outcome = await r.service.requestDeletion(request());

        expect(outcome.reason).toBe('already_deleting');
        expect(r.dispatches).toEqual([]);
    });

    it('never re-claims a fresh claim — the plan’s idempotent second row', async () => {
        const r = rig({ state: row({ deletionRequestedAt: new Date(NOW - 60_000) }) });

        const outcome = await r.service.requestDeletion(request());

        expect(outcome.reason).toBe('already_deleting');
        expect(r.store.calls.some((c) => c.startsWith('reclaim'))).toBe(false);
        expect(r.dispatches).toEqual([]);
    });

    it('never re-dispatches through a store that cannot compare-and-set', async () => {
        const r = rig({ state: stale(), supports: { release: true, reclaim: false } });

        const outcome = await r.service.requestDeletion(request());

        expect(outcome.reason).toBe('already_deleting');
        expect(r.dispatches).toEqual([]);
    });
});

describe('a member with the owner role may delete (lane aw-safety)', () => {
    it('admits a member owner — before this the port refused not_found and APW-01 took it as done', async () => {
        const r = rig({ workUserId: 'creator-1', memberRole: WorkMemberRole.OWNER });

        const outcome = await r.service.requestDeletion(request('co-owner-1'));

        expect(outcome.status).toBe('pending');
        expect(r.store.calls).toContain('claim:co-owner-1');
    });

    it.each([
        ['a manager', WorkMemberRole.MANAGER],
        ['an editor', WorkMemberRole.EDITOR],
        ['a stranger', null],
    ])('still refuses %s, exactly as an unknown id', async (_label, role) => {
        const r = rig({ workUserId: 'creator-1', memberRole: role as WorkMemberRole | null });

        await expect(r.service.requestDeletion(request('someone-1'))).rejects.toMatchObject({
            code: 'not_found',
            status: 404,
        });
        expect(r.dispatches).toEqual([]);
    });

    it('refuses when the member repository is not in the container', async () => {
        const r = rig({
            workUserId: 'creator-1',
            memberRole: WorkMemberRole.OWNER,
            moduleRefMissing: true,
        });

        await expect(r.service.requestDeletion(request('co-owner-1'))).rejects.toBeInstanceOf(
            AppWorkDeletionRefusalError,
        );
    });
});

describe('the no-cluster case: three attempts, then the owner is told what may remain', () => {
    it('retries twice five minutes apart, then completes ONCE with the may-remain report', async () => {
        const claimedAt = NOW;
        const state = row({
            deletionRequestedAt: new Date(claimedAt),
            deletionRequestedByUserId: 'owner-1',
        });

        const first = rig({ state, destroyThrows: true, now: claimedAt + 1_000 });
        const one = await first.service.handleDeleteAppWork({
            op: APP_DELETE_WORK_OP,
            workId: 'work-1',
            attempt: 1,
            requestedAtMs: claimedAt,
        });
        expect(one).toMatchObject({
            state: 'retry',
            retryInMs: APP_WORK_DELETION_RETRY_DELAY_MS,
            scheduled: true,
        });
        expect(first.completions).toEqual([]);

        const second = rig({
            state,
            destroyThrows: true,
            now: claimedAt + APP_WORK_DELETION_RETRY_DELAY_MS + 1_000,
        });
        const two = await second.service.handleDeleteAppWork({
            op: APP_DELETE_WORK_OP,
            workId: 'work-1',
            attempt: 2,
            requestedAtMs: claimedAt,
        });
        expect(two.state).toBe('retry');
        expect(second.completions).toEqual([]);

        const third = rig({
            state,
            destroyThrows: true,
            now: claimedAt + 2 * APP_WORK_DELETION_RETRY_DELAY_MS + 1_000,
        });
        const three = await third.service.handleDeleteAppWork({
            op: APP_DELETE_WORK_OP,
            workId: 'work-1',
            attempt: 3,
            requestedAtMs: claimedAt,
        });

        expect(three.state).toBe('may-remain');
        expect(three.code).toBe('attempts_exhausted');
        expect(third.dispatches).toEqual([]);
        expect(third.completions).toHaveLength(1);
        const report = third.completions[0].report;
        expect(report?.target).toBe('your-cluster');
        expect(report?.code).toBe('attempts_exhausted');
        expect(report?.mayRemain).toEqual(
            expect.arrayContaining([
                { kind: 'Component', name: 'web' },
                { kind: 'Namespace', name: NAMESPACE },
            ]),
        );
        // The Activity row is attributed to the member who asked, without reading the Work.
        expect(third.events[0].payload.userId).toBe('owner-1');
        expect(third.events[0].payload.reason).toBe('app_work_deleted');
    });

    it('reports a retry it could not schedule as unscheduled, and never completes', async () => {
        const state = row({ deletionRequestedAt: new Date(NOW) });
        const r = rig({ state, destroyThrows: true, dispatchAnswer: null, now: NOW + 1_000 });

        const result = await r.service.handleDeleteAppWork({
            op: APP_DELETE_WORK_OP,
            workId: 'work-1',
            attempt: 1,
            requestedAtMs: NOW,
        });

        expect(result).toMatchObject({ state: 'retry', scheduled: false, completed: false });
        expect(r.completions).toEqual([]);
    });

    it('hands the completion a report with names and codes only', async () => {
        const state = row({
            deletionRequestedAt: new Date(NOW),
            deletionRequestedByUserId: 'owner-1',
        });
        const r = rig({ state });

        const result = await r.service.handleDeleteAppWork({
            op: APP_DELETE_WORK_OP,
            workId: 'work-1',
            attempt: 1,
        });

        expect(result.state).toBe('done');
        expect(r.completions).toHaveLength(1);
        expect(Object.keys(r.completions[0].report ?? {}).sort()).toEqual([
            'kept',
            'mayRemain',
            'target',
        ]);
        expect(JSON.stringify(r.completions[0].report)).not.toMatch(/kubeconfig|https?:\/\//);
    });
});

describe('describeDeletion — what the delete dialog lists', () => {
    it('separates what is removed (workloads, the managed record) from what is kept', async () => {
        const r = rig({
            state: row({ statusSnapshot: { components: [{ name: 'web' }, { name: 'worker' }] } }),
        });

        const description = await r.service.describeDeletion('work-1');

        expect(description).toEqual({
            target: 'your-cluster',
            deployed: true,
            deleting: false,
            stateUnreadable: false,
            deployInProgress: false,
            removes: [
                { kind: 'Component', name: 'web' },
                { kind: 'Component', name: 'worker' },
                { kind: 'DnsRecord', label: 'managed-subdomain' },
            ],
            keeps: [],
            destroysWithData: [],
        });
        expect(JSON.stringify(description)).not.toContain(NAMESPACE);
    });

    it('says nothing is removed for a Work that was never deployed', async () => {
        const r = rig({
            state: row({ namespace: null, currentDeploymentId: null, statusSnapshot: null }),
        });

        const description = await r.service.describeDeletion('work-1');

        expect(description.deployed).toBe(false);
        expect(description.removes).toEqual([]);
    });

    it('flags a running Deployment and a deletion already in progress', async () => {
        const r = rig({ state: row({ deployLockId: 'd-9', deletionRequestedAt: new Date(NOW) }) });

        const description = await r.service.describeDeletion('work-1');

        expect(description.deployInProgress).toBe(true);
        expect(description.deleting).toBe(true);
    });
});

describe('the not-started reasons are a closed list', () => {
    it('names exactly the three reasons that mean no claim was taken', () => {
        expect([...APP_WORK_DELETION_NOT_STARTED_REASONS].sort()).toEqual(
            ['deploy_in_progress', 'dispatcher_unavailable', 'runtime_state_unreadable'].sort(),
        );
        expect(
            isAppWorkDeletionNotStarted({
                status: 'pending',
                target: 'none',
                reason: 'already_deleting',
            }),
        ).toBe(false);
        expect(
            isAppWorkDeletionNotStarted({
                status: 'done',
                target: 'none',
                reason: 'dispatcher_unavailable',
            }),
        ).toBe(false);
        expect(isAppWorkDeletionNotStarted(undefined)).toBe(false);
    });
});

describe('workerAppWorkDeletionCompletion — the worker’s completion edge fails closed', () => {
    it('resolves only when the API answers completed: true, and forwards the report', async () => {
        const calls: unknown[][] = [];
        const completion = workerAppWorkDeletionCompletion({
            async finishDeletion(...args: unknown[]) {
                calls.push(args);
                return { completed: true };
            },
        } as never);

        await expect(
            completion.completeAppWorkDeletion('work-1', {
                mayRemain: [{ kind: 'Namespace', name: 'ns' }],
            }),
        ).resolves.toBeUndefined();
        expect(calls).toEqual([['work-1', { mayRemain: [{ kind: 'Namespace', name: 'ns' }] }]]);
    });

    it.each([
        ['a refusal', { completed: false, reason: 'not_deleting' }],
        ['no answer', null],
        ['an unexpected shape', { ok: true }],
    ])(
        'throws on %s, so the worker reports completed: false and the row stays',
        async (_label, answer) => {
            const completion = workerAppWorkDeletionCompletion({
                finishDeletion: async () => answer as never,
            });

            await expect(completion.completeAppWorkDeletion('work-1')).rejects.toThrow(
                /did not complete/,
            );
        },
    );

    it('makes the deletion service report completed: false when the API refuses', async () => {
        const service = new AppRuntimeDeletionService(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            workerAppWorkDeletionCompletion({
                finishDeletion: async () => ({ completed: false, reason: 'not_deleting' }),
            }),
        );

        await expect(service.finishDeletion('work-1', { mayRemain: [] })).resolves.toEqual({
            completed: false,
            reason: 'completion_unavailable',
        });
    });
});
