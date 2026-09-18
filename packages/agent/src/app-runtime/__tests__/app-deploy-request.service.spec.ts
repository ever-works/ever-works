/**
 * APW-06 T24 — `AppDeployRequestService` (plan §2.2, §5.8, §9.2; spec FR-23, FR-24, FR-30, FR-34;
 * ACC-06-21, ACC-06-23, ACC-06-55).
 *
 * T24's Test line (`tasks.md:431-436`) names six cases — a second manual request refused with
 * `APP_DEPLOY_IN_PROGRESS`; three Build-triggered requests during one run; a rollback carrying the
 * old Build (or the digest and spec commit under `image`) and `skipPreDeployJobs: true`; the 2 s
 * budget against a 5 s dispatcher; a deleting App Work; a missing dispatcher leaving zero rows — and
 * the **Added** paragraphs add the rest: the `400 build_not_applicable`, the `image` request's null
 * `buildId` and null `queuedBuildId`, the other-strategy supersede, and the dispatcher gate running
 * before the lock claim. `tasks.md:1153-1160` (APW06-G16) then fixes the queue itself: which
 * triggers queue and which are refused, the row created immediately as `INITIALIZING`, both queue
 * columns written together, `appRender.supersededBy`, and **three Build-triggered requests leaving
 * two rows**.
 *
 * Every collaborator is a hand-written fake, so the suite also pins **what was asked of them**:
 * that the dispatcher gate precedes every state read and every insert (ACC-06-55's "zero rows, zero
 * cache entries"), that an unmet precondition leaves no row and claims no lock, that `image` never
 * stores a Build, and that a dispatch failure releases the lock instead of stranding the row.
 */

import { Logger } from '@nestjs/common';
import { APP_DEPLOY_REQUEST_BUDGET_MS } from '@ever-works/contracts';

import type {
    AppDeployPreconditionRequest,
    AppDeployPreconditionResult,
    AppDeployPreconditionsService,
} from '../app-deploy-preconditions.service';
import {
    APP_DEPLOY_CODE_BUILD_NOT_APPLICABLE,
    APP_DEPLOY_CODE_DISPATCH_FAILED,
    APP_DEPLOY_CODE_IN_PROGRESS,
    APP_DEPLOY_CODE_PRECONDITIONS,
    APP_DEPLOY_CODE_STATE_UNAVAILABLE,
    APP_DEPLOY_LOCK_STALE_S,
    APP_DEPLOY_QUEUEABLE_TRIGGERS,
    APP_DEPLOY_STATE_INITIALIZING,
    APP_DEPLOY_STATE_SUPERSEDED,
    APP_DEPLOY_TRIGGERS,
    APP_DEPLOY_WARNING_DISPATCH_SLOW,
    AppDeployRefusedError,
    AppDeployRequestService,
    isSet,
    normaliseTrigger,
    queueIdentity,
    rowDraft,
    skipPreDeployJobsFor,
    storedFacts,
    type AppDeployDeploymentStore,
    type AppDeployDispatcher,
    type AppDeployDispatchPayload,
    type AppDeployRequest,
    type AppDeployRequestState,
    type AppDeployRollbackFacts,
    type AppDeployRowDraft,
    type AppDeployRowFacts,
    type AppDeployRuntimeStateStore,
} from '../app-deploy-request.service';

/* -------------------------------------------------------------------------- *
 * Fakes — one per seam, each recording what it was asked
 * -------------------------------------------------------------------------- */

/**
 * The logger is spied, not asserted on: several cases deliberately make a seam throw, and the
 * service's contract is that it *reports* rather than crashes. The behaviour under test is the
 * returned result and the calls the seams saw, never the log.
 */
beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

/** The `app-deploy` dispatcher, in both of §9.2's shapes. */
class FakeDispatcher implements AppDeployDispatcher {
    readonly calls: AppDeployDispatchPayload[] = [];
    enabled = true;
    /** The object `resolve()` answers with; `undefined` ⇒ this provider is the runtime itself. */
    resolved: unknown = undefined;
    failWith: Error | null = null;
    /** When true the dispatch stays pending until {@link release} or {@link fail}. */
    hold = false;
    private deferred: { resolve: () => void; reject: (error: unknown) => void } | null = null;

    async dispatchAppDeploy(payload: AppDeployDispatchPayload): Promise<string | null> {
        this.calls.push(payload);
        if (this.hold) {
            return await new Promise<string | null>((resolve, reject) => {
                this.deferred = {
                    resolve: () => resolve('run-id'),
                    reject: (error) => reject(error),
                };
            });
        }
        if (this.failWith) throw this.failWith;

        return 'run-id';
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** `buildJobRuntimeProviders`' shape: a factory whose `resolve()` answers the active runtime. */
    resolve(): unknown {
        return this.resolved === undefined ? this : this.resolved;
    }

    release(): void {
        this.deferred?.resolve();
        this.deferred = null;
    }

    fail(error: unknown): void {
        this.deferred?.reject(error);
        this.deferred = null;
    }
}

/** APW-06 T16's `WorkDeploymentRepository`, as this service consumes it. */
class FakeStore implements AppDeployDeploymentStore {
    readonly rows: AppDeployRowDraft[] = [];
    readonly superseded: Array<{ id: string; by: string }> = [];
    readonly failed: Array<{ id: string; code: string; message: string }> = [];
    readonly findCalls: string[] = [];
    failCreate = false;
    failFind = false;

    async create(draft: AppDeployRowDraft): Promise<{ id: string }> {
        if (this.failCreate) throw new Error('insert failed');
        this.rows.push(draft);
        return { id: draft.id };
    }

    async findById(deploymentId: string): Promise<AppDeployRowFacts | null> {
        this.findCalls.push(deploymentId);
        if (this.failFind) throw new Error('read failed');

        const row = this.rows.find((entry) => entry.id === deploymentId);
        return row
            ? {
                  id: row.id,
                  state: row.state,
                  buildId: row.buildId,
                  commitSha: row.commitSha,
                  appTrigger: row.appTrigger,
              }
            : null;
    }

    async markSuperseded(deploymentId: string, supersededBy: string): Promise<void> {
        this.superseded.push({ id: deploymentId, by: supersededBy });
        const row = this.rows.find((entry) => entry.id === deploymentId);
        if (row) {
            row.state = APP_DEPLOY_STATE_SUPERSEDED;
            row.appRender = { ...row.appRender, supersededBy };
        }
    }

    async markDispatchFailed(deploymentId: string, code: string, message: string): Promise<void> {
        this.failed.push({ id: deploymentId, code, message });
    }

    row(deploymentId: string): AppDeployRowDraft | undefined {
        return this.rows.find((entry) => entry.id === deploymentId);
    }
}

/** APW-06 T17's `WorkAppRuntimeStateRepository`, as this service consumes it. */
class FakeStates implements AppDeployRuntimeStateStore {
    readonly calls: string[] = [];
    readonly claims: Array<{ workId: string; deploymentId: string; staleAfterS?: number }> = [];
    readonly released: Array<{ workId: string; deploymentId: string }> = [];
    readonly queued: Array<{ workId: string; value: unknown }> = [];
    state: AppDeployRequestState = {
        target: 'your-cluster',
        paused: false,
        deployLockId: null,
        deletionRequestedAt: null,
        queuedDeploymentId: null,
        queuedBuildId: null,
    };
    /** `false` ⇒ the atomic claim found a lock already held. */
    claimGranted = true;
    failClaim = false;
    failRead = false;
    /** What `setQueued` answers: the row it replaced. */
    supersedeOnQueue: string | null = null;

    async getOrCreate(workId: string): Promise<AppDeployRequestState | null> {
        this.calls.push(workId);
        if (this.failRead) throw new Error('state unreadable');
        return this.state;
    }

    async claimDeployLock(
        workId: string,
        deploymentId: string,
        staleAfterS?: number,
    ): Promise<boolean> {
        this.claims.push({ workId, deploymentId, staleAfterS });
        if (this.failClaim) throw new Error('claim failed');
        if (this.claimGranted) this.state = { ...this.state, deployLockId: deploymentId };
        return this.claimGranted;
    }

    async releaseDeployLock(workId: string, deploymentId: string): Promise<boolean> {
        this.released.push({ workId, deploymentId });
        this.state = { ...this.state, deployLockId: null };
        return true;
    }

    async setQueued(
        workId: string,
        queued: { queuedDeploymentId: string | null; queuedBuildId: string | null },
    ): Promise<{ supersededDeploymentId: string | null }> {
        this.queued.push({ workId, value: queued });
        this.state = {
            ...this.state,
            queuedDeploymentId: queued.queuedDeploymentId,
            queuedBuildId: queued.queuedBuildId,
        };
        return { supersededDeploymentId: this.supersedeOnQueue };
    }
}

/**
 * T21's precondition pass, as this service consumes it.
 *
 * The fake **echoes the commit and the Build it was asked about** into the context it answers with,
 * exactly as the real pass does (`getEffectiveSpec(workId, commitSha)` sets `context.specCommitSha`
 * to the commit it read). That is what lets a case assert *which* commit this service asked for —
 * ACC-06-23's old commit, §5.8's spec commit — instead of only what it stored.
 */
class FakePreconditions {
    readonly requests: AppDeployPreconditionRequest[] = [];
    result: AppDeployPreconditionResult | null = null;
    failWith: Error | null = null;

    async evaluate(request: AppDeployPreconditionRequest): Promise<AppDeployPreconditionResult> {
        this.requests.push(request);
        if (this.failWith) throw this.failWith;
        if (this.result) return this.result;

        const base = ready();
        return {
            ...base,
            context: {
                ...base.context,
                specCommitSha: request.specCommitSha ?? base.context.specCommitSha,
                buildId: request.buildId ?? null,
            },
        };
    }
}

/** The service under test, with deterministic Deployment ids. */
class TestRequestService extends AppDeployRequestService {
    ids = 0;

    protected newDeploymentId(): string {
        this.ids += 1;
        return `00000000-0000-4000-8000-${String(this.ids).padStart(12, '0')}`;
    }
}

/** A ready precondition result for a `dockerfile` Deployment on **your** cluster. */
function ready(overrides: Partial<AppDeployPreconditionResult> = {}): AppDeployPreconditionResult {
    return {
        unmet: [],
        advisory: [],
        warnings: [],
        context: {
            target: 'your-cluster',
            specCommitSha: 'sha-spec-1',
            strategy: 'dockerfile',
            buildId: null,
            latestGreenBuildId: null,
            primaryHost: 'app.example.com',
        },
        ready: true,
        ...overrides,
    };
}

/** The harness: one service wired to the four fakes. */
function harness(options: { dispatcher?: boolean; store?: boolean; states?: boolean } = {}) {
    const dispatcher = new FakeDispatcher();
    const store = new FakeStore();
    const states = new FakeStates();
    const preconditions = new FakePreconditions();

    const service = new TestRequestService(
        preconditions as unknown as AppDeployPreconditionsService,
        options.dispatcher === false ? undefined : dispatcher,
        options.store === false ? undefined : store,
        options.states === false ? undefined : states,
    );

    return { service, dispatcher, store, states, preconditions };
}

/** A manual request, the shape `POST :id/deploy` produces. */
function manual(overrides: Partial<AppDeployRequest> = {}): AppDeployRequest {
    return {
        workId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        trigger: 'manual',
        buildId: '33333333-3333-4333-8333-333333333333',
        provider: 'k8s',
        branch: 'main',
        ...overrides,
    };
}

describe('AppDeployRequestService (APW-06 T24)', () => {
    /* ---------------------------------------------------------------------- *
     * The happy path and the stored facts
     * ---------------------------------------------------------------------- */

    describe('a request that is accepted (§2.2 steps 3–5)', () => {
        it('claims the lock, creates the row, dispatches and answers 202', async () => {
            const h = harness();

            const result = await h.service.request(manual());

            expect(result.status).toBe('accepted');
            expect(result.httpStatus).toBe(202);
            expect(result.code).toBeNull();
            expect(result.dispatched).toBe(true);
            expect(result.deduplicated).toBe(false);
            expect(result.deploymentId).toBe('00000000-0000-4000-8000-000000000001');

            // The lock is claimed with the Deployment's own id and T17's stale window.
            expect(h.states.claims).toEqual([
                {
                    workId: manual().workId,
                    deploymentId: result.deploymentId,
                    staleAfterS: APP_DEPLOY_LOCK_STALE_S,
                },
            ]);
            expect(APP_DEPLOY_LOCK_STALE_S).toBe(7_260);

            // The row carries §2.2:156-158's facts, and no Build for a strategy that has none.
            expect(h.store.rows).toEqual([
                expect.objectContaining({
                    id: result.deploymentId,
                    workId: manual().workId,
                    state: APP_DEPLOY_STATE_INITIALIZING,
                    provider: 'k8s',
                    triggerSource: 'manual',
                    appTrigger: 'manual',
                    buildId: manual().buildId,
                    appTarget: 'your-cluster',
                    commitSha: 'sha-spec-1',
                    branch: 'main',
                    triggeredByUserId: manual().userId,
                }),
            ]);
            expect(h.store.rows[0].appRender).toEqual({
                specCommitSha: 'sha-spec-1',
                skipPreDeployJobs: false,
            });

            // The dispatch names the row, never the plugin, and carries the idempotency key.
            expect(h.dispatcher.calls).toEqual([
                {
                    workId: manual().workId,
                    deploymentId: result.deploymentId,
                    trigger: 'manual',
                    buildId: manual().buildId,
                    specCommitSha: 'sha-spec-1',
                    requestId: null,
                },
            ]);
        });

        it('mints a UUID Deployment id by default, so the lock and the row share one id', async () => {
            const store = new FakeStore();
            const plain = new AppDeployRequestService(
                new FakePreconditions() as unknown as AppDeployPreconditionsService,
                new FakeDispatcher(),
                store,
                new FakeStates(),
            );

            const result = await plain.request(manual({ requestId: 'event-1' }));

            expect(result.deploymentId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            );
            expect(store.rows[0].id).toBe(result.deploymentId);
        });

        it('passes the request’s own facts to the precondition pass, and its answers back', async () => {
            const h = harness();
            h.preconditions.result = ready({
                advisory: [
                    {
                        code: 'primary_domain_missing',
                        names: ['APP_URL'],
                        message: 'no primary host',
                    },
                ],
                warnings: [{ code: 'primary_url_incluster', message: 'in-cluster URLs are used' }],
            });

            const result = await h.service.request(
                manual({ confirmClusterChange: true, specCommitSha: 'sha-requested' }),
            );

            expect(h.preconditions.requests).toEqual([
                {
                    workId: manual().workId,
                    buildId: manual().buildId,
                    specCommitSha: 'sha-requested',
                    headCommitSha: null,
                    userId: manual().userId,
                    confirmClusterChange: true,
                },
            ]);
            expect(result.advisory.map((entry) => entry.code)).toEqual(['primary_domain_missing']);
            expect(result.warnings.map((entry) => entry.code)).toEqual([
                'primary_url_incluster',
                'primary_domain_missing',
            ]);
        });
    });

    /* ---------------------------------------------------------------------- *
     * The worker gate — before anything at all
     * ---------------------------------------------------------------------- */

    describe('the isolated-worker gate (§9.2, APW06-G02; ACC-06-55)', () => {
        it('refuses 422 worker_not_isolated with no dispatcher, and touches nothing', async () => {
            const h = harness({ dispatcher: false });

            const result = await h.service.request(manual());

            expect(result.status).toBe('refused');
            expect(result.httpStatus).toBe(422);
            expect(result.code).toBe('worker_not_isolated');
            expect(result.unmet.map((entry) => entry.code)).toEqual(['worker_not_isolated']);

            // "creates no row" — and, in this service, reads nothing either.
            expect(h.store.rows).toEqual([]);
            expect(h.store.findCalls).toEqual([]);
            expect(h.states.calls).toEqual([]);
            expect(h.states.claims).toEqual([]);
            expect(h.states.queued).toEqual([]);
            expect(h.dispatcher.calls).toEqual([]);
            expect(h.preconditions.requests).toEqual([]);
        });

        it('refuses when the dispatcher resolves null — the factory shape', async () => {
            const h = harness();
            h.dispatcher.resolved = null;

            const result = await h.service.request(manual());

            expect(result.code).toBe('worker_not_isolated');
            expect(h.store.rows).toEqual([]);
            expect(h.states.calls).toEqual([]);
        });

        it('refuses when dispatch is disabled in this process', async () => {
            const h = harness();
            h.dispatcher.enabled = false;

            expect((await h.service.request(manual())).code).toBe('worker_not_isolated');
            expect(h.store.rows).toEqual([]);
        });

        it('refuses when the resolved runtime lacks `dispatchAppDeploy` — no in-process fallback', async () => {
            const h = harness();
            h.dispatcher.resolved = { someOtherMethod: () => undefined };

            const result = await h.service.request(manual());

            expect(result.code).toBe('worker_not_isolated');
            expect(h.store.rows).toEqual([]);
        });

        it('refuses when resolving the dispatcher throws, and never throws itself', async () => {
            const h = harness();
            h.dispatcher.resolve = () => {
                throw new Error('registry unavailable');
            };

            expect((await h.service.request(manual())).code).toBe('worker_not_isolated');
            expect(h.store.rows).toEqual([]);
        });
    });

    /* ---------------------------------------------------------------------- *
     * Preconditions — the 422 and the two 400s
     * ---------------------------------------------------------------------- */

    describe('preconditions and validation (§5.1, §2.2:158)', () => {
        it('refuses an unmet precondition with 422 and creates nothing (ACC-06-19)', async () => {
            const h = harness();
            h.preconditions.result = ready({
                unmet: [
                    {
                        code: 'no_green_build_for_head',
                        names: ['build-9'],
                        message:
                            'The newest green Build is build-9, which was built from another commit.',
                    },
                ],
                ready: false,
            });

            const result = await h.service.request(manual());

            expect(result.status).toBe('refused');
            expect(result.httpStatus).toBe(422);
            expect(result.code).toBe(APP_DEPLOY_CODE_PRECONDITIONS);
            expect(result.unmet).toHaveLength(1);
            expect(result.unmet[0].code).toBe('no_green_build_for_head');

            // No lock claim, no row, no dispatch — the precondition pass is the last thing that ran.
            expect(h.states.claims).toEqual([]);
            expect(h.states.calls).toEqual([]);
            expect(h.store.rows).toEqual([]);
            expect(h.dispatcher.calls).toEqual([]);
        });

        it('refuses `503` when the pass is not bound in this process, naming the platform', async () => {
            const h = harness();
            const bare = new TestRequestService(undefined, h.dispatcher, h.store, h.states);

            const result = await bare.request(manual());

            expect(result.httpStatus).toBe(503);
            expect(result.code).toBe(APP_DEPLOY_CODE_STATE_UNAVAILABLE);
            expect(h.store.rows).toEqual([]);
        });

        it('refuses `400 build_not_applicable` when a Build accompanies strategy `image`', async () => {
            const h = harness();
            h.preconditions.result = ready({
                context: {
                    target: 'your-cluster',
                    specCommitSha: 'sha-image',
                    strategy: 'image',
                    buildId: null,
                    latestGreenBuildId: null,
                    primaryHost: 'app.example.com',
                },
            });

            const result = await h.service.request(manual({ buildId: 'build-1' }));

            expect(result.status).toBe('refused');
            expect(result.httpStatus).toBe(400);
            expect(result.code).toBe(APP_DEPLOY_CODE_BUILD_NOT_APPLICABLE);
            expect(result.deploymentId).toBeNull();
            expect(h.store.rows).toEqual([]);
            expect(h.states.claims).toEqual([]);
            expect(h.dispatcher.calls).toEqual([]);
        });

        it('stores `buildId: null` and the spec commit for a strategy-`image` request (§5.8)', async () => {
            const h = harness();
            h.preconditions.result = ready({
                context: {
                    target: 'your-cluster',
                    specCommitSha: 'sha-image',
                    strategy: 'image',
                    buildId: null,
                    latestGreenBuildId: null,
                    primaryHost: 'app.example.com',
                },
            });

            const result = await h.service.request(
                manual({ buildId: null, specCommitSha: 'sha-image' }),
            );

            expect(result.status).toBe('accepted');
            expect(result.stored.buildId).toBeNull();
            expect(result.stored.specCommitSha).toBe('sha-image');
            expect(result.stored.commitSha).toBe('sha-image');
            expect(h.store.rows[0]).toMatchObject({
                buildId: null,
                commitSha: 'sha-image',
                appTrigger: 'manual',
            });
            expect(h.store.rows[0].appRender).toEqual({
                specCommitSha: 'sha-image',
                skipPreDeployJobs: false,
            });
        });
    });

    /* ---------------------------------------------------------------------- *
     * The lock — 409, the queue, and the dedupe
     * ---------------------------------------------------------------------- */

    describe('one Deployment per App Work (FR-30, ACC-06-21)', () => {
        it('refuses a second manual request with 409 APP_DEPLOY_IN_PROGRESS and the running id', async () => {
            const h = harness();
            h.states.claimGranted = false;
            h.states.state = {
                ...h.states.state,
                deployLockId: '00000000-0000-4000-8000-00000000aaaa',
            };

            const result = await h.service.request(manual());

            expect(result.status).toBe('refused');
            expect(result.httpStatus).toBe(409);
            expect(result.code).toBe(APP_DEPLOY_CODE_IN_PROGRESS);
            expect(result.runningDeploymentId).toBe('00000000-0000-4000-8000-00000000aaaa');
            expect(result.deploymentId).toBeNull();
            expect(result.unmet[0].code).toBe('deploy_in_progress');
            expect(result.unmet[0].names).toEqual(['00000000-0000-4000-8000-00000000aaaa']);

            // The losing request creates nothing and dispatches nothing.
            expect(h.store.rows).toEqual([]);
            expect(h.dispatcher.calls).toEqual([]);
        });

        it('queues a Build-triggered request behind the running one, in one write', async () => {
            const h = harness();
            h.states.claimGranted = false;
            h.states.state = {
                ...h.states.state,
                deployLockId: '00000000-0000-4000-8000-00000000aaaa',
            };

            const result = await h.service.request(
                manual({ trigger: 'build', userId: null, buildId: 'build-2' }),
            );

            expect(result.status).toBe('queued');
            expect(result.httpStatus).toBe(202);
            expect(result.code).toBeNull();
            expect(result.queuedBuildId).toBe('build-2');
            expect(result.queuedDeploymentId).toBe(result.deploymentId);

            // `tasks.md:1154`: the row exists immediately, `INITIALIZING`, with the App trigger.
            expect(h.store.rows).toEqual([
                expect.objectContaining({
                    id: result.deploymentId,
                    state: APP_DEPLOY_STATE_INITIALIZING,
                    appTrigger: 'build',
                    buildId: 'build-2',
                    appTarget: 'your-cluster',
                    triggeredByUserId: null,
                }),
            ]);
            // …and both queue columns are written by the one call that can be atomic.
            expect(h.states.queued).toEqual([
                {
                    workId: manual().workId,
                    value: { queuedDeploymentId: result.deploymentId, queuedBuildId: 'build-2' },
                },
            ]);
            expect(h.dispatcher.calls).toEqual([]);
        });

        it('leaves two rows for three Build-triggered requests: one SUPERSEDED, one INITIALIZING', async () => {
            const h = harness();
            h.states.claimGranted = false;
            h.states.state = {
                ...h.states.state,
                deployLockId: '00000000-0000-4000-8000-00000000aaaa',
            };

            const first = await h.service.request(manual({ trigger: 'build', buildId: 'build-1' }));
            // The queue now holds `first`, and the state the next request reads knows it.
            h.states.supersedeOnQueue = first.deploymentId;

            const second = await h.service.request(
                manual({ trigger: 'build', buildId: 'build-2' }),
            );
            // A redelivery of the same Build is idempotent: it returns the queued row and creates
            // nothing (`tasks.md:1158-1160`).
            const third = await h.service.request(manual({ trigger: 'build', buildId: 'build-2' }));

            expect(h.store.rows).toHaveLength(2);
            expect(h.store.rows.map((row) => row.buildId)).toEqual(['build-1', 'build-2']);
            expect(h.store.rows.map((row) => row.state)).toEqual([
                APP_DEPLOY_STATE_SUPERSEDED,
                APP_DEPLOY_STATE_INITIALIZING,
            ]);
            expect(h.store.superseded).toEqual([
                { id: first.deploymentId, by: second.deploymentId },
            ]);
            expect(h.store.row(first.deploymentId)?.appRender).toMatchObject({
                supersededBy: second.deploymentId,
            });

            expect(second.status).toBe('queued');
            expect(second.deduplicated).toBe(false);
            expect(third.status).toBe('queued');
            expect(third.deploymentId).toBe(second.deploymentId);
            expect(third.deduplicated).toBe(true);
            // The deduped request wrote no second queue entry.
            expect(h.states.queued).toHaveLength(2);
        });

        it('supersedes a queued request made under the other strategy (§5.8)', async () => {
            const h = harness();
            h.states.claimGranted = false;
            h.states.state = {
                ...h.states.state,
                deployLockId: '00000000-0000-4000-8000-00000000aaaa',
            };

            const built = await h.service.request(manual({ trigger: 'build', buildId: 'build-1' }));
            h.states.supersedeOnQueue = built.deploymentId;

            // The App spec moves to `strategy: image`: no Build, the spec commit is the handle.
            h.preconditions.result = ready({
                context: {
                    target: 'your-cluster',
                    specCommitSha: 'sha-image',
                    strategy: 'image',
                    buildId: null,
                    latestGreenBuildId: null,
                    primaryHost: 'app.example.com',
                },
            });

            const published = await h.service.request(
                manual({ trigger: 'build', buildId: null, specCommitSha: 'sha-image' }),
            );

            expect(published.deduplicated).toBe(false);
            expect(published.queuedBuildId).toBeNull();
            expect(h.store.rows.map((row) => row.state)).toEqual([
                APP_DEPLOY_STATE_SUPERSEDED,
                APP_DEPLOY_STATE_INITIALIZING,
            ]);
            expect(h.store.superseded).toEqual([
                { id: built.deploymentId, by: published.deploymentId },
            ]);
            expect(h.states.queued[1].value).toEqual({
                queuedDeploymentId: published.deploymentId,
                queuedBuildId: null,
            });
        });

        it('queues a domain-change request and refuses rollback and target-saved with 409', async () => {
            const h = harness();
            h.states.claimGranted = false;
            h.states.state = {
                ...h.states.state,
                deployLockId: '00000000-0000-4000-8000-00000000aaaa',
            };

            const domain = await h.service.request(manual({ trigger: 'domain-change' }));
            expect(domain.status).toBe('queued');

            for (const trigger of ['rollback', 'target-saved'] as const) {
                const refused = await h.service.request(
                    manual({ trigger, rollback: { deploymentId: 'old' } }),
                );
                expect(refused.status).toBe('refused');
                expect(refused.httpStatus).toBe(409);
                expect(refused.code).toBe(APP_DEPLOY_CODE_IN_PROGRESS);
            }

            // `tasks.md:1157` names manual, rollback and target-saved as the refused three;
            // `spec-applied` (FR-23's sixth source, §5.8:886-889) queues with the event-driven two.
            expect(APP_DEPLOY_QUEUEABLE_TRIGGERS).toEqual([
                'build',
                'domain-change',
                'spec-applied',
            ]);
            expect(h.store.rows).toHaveLength(1);
        });

        it('queues a `spec-applied` request, recording FR-23’s sixth source by name', async () => {
            const h = harness();
            h.states.claimGranted = false;
            h.states.state = {
                ...h.states.state,
                deployLockId: '00000000-0000-4000-8000-00000000aaaa',
            };

            const result = await h.service.request(
                manual({ trigger: 'spec-applied', buildId: null }),
            );

            expect(result.status).toBe('queued');
            expect(h.store.rows[0].appTrigger).toBe('spec-applied');
        });

        it('refuses 409 — never a queue — when the lock store cannot answer at all', async () => {
            const h = harness({ states: false });

            const result = await h.service.request(manual());

            expect(result.status).toBe('refused');
            expect(result.httpStatus).toBe(503);
            expect(result.code).toBe(APP_DEPLOY_CODE_STATE_UNAVAILABLE);
            expect(h.store.rows).toEqual([]);
            expect(h.dispatcher.calls).toEqual([]);
        });

        it('creates no row when the insert fails, and gives the lock straight back', async () => {
            const h = harness();
            h.store.failCreate = true;

            const result = await h.service.request(manual());

            expect(result.httpStatus).toBe(503);
            expect(result.code).toBe(APP_DEPLOY_CODE_STATE_UNAVAILABLE);
            expect(h.store.rows).toEqual([]);
            expect(h.states.released).toEqual([
                { workId: manual().workId, deploymentId: '00000000-0000-4000-8000-000000000001' },
            ]);
            expect(h.dispatcher.calls).toEqual([]);
        });
    });

    /* ---------------------------------------------------------------------- *
     * Deleting
     * ---------------------------------------------------------------------- */

    describe('a deleting App Work (R-15, ACC-06-55)', () => {
        it('refuses `app_work_deleting` before the lock claim', async () => {
            const h = harness();
            h.states.state = {
                ...h.states.state,
                deletionRequestedAt: new Date('2026-09-18T10:00:00.000Z'),
            };

            const result = await h.service.request(manual());

            expect(result.status).toBe('refused');
            expect(result.httpStatus).toBe(409);
            expect(result.code).toBe('app_work_deleting');
            expect(result.unmet.map((entry) => entry.code)).toEqual(['app_work_deleting']);
            expect(h.states.claims).toEqual([]);
            expect(h.store.rows).toEqual([]);
            expect(h.dispatcher.calls).toEqual([]);
        });

        it('also refuses when the precondition pass reports it first (§5.1’s own row)', async () => {
            const h = harness();
            h.preconditions.result = ready({
                unmet: [
                    {
                        code: 'app_work_deleting',
                        message:
                            'This App Work is being deleted, so no Deployment may start for it.',
                    },
                ],
                ready: false,
            });

            const result = await h.service.request(manual());

            expect(result.httpStatus).toBe(422);
            expect(result.code).toBe(APP_DEPLOY_CODE_PRECONDITIONS);
            expect(result.unmet.map((entry) => entry.code)).toEqual(['app_work_deleting']);
            expect(h.store.rows).toEqual([]);
        });
    });

    /* ---------------------------------------------------------------------- *
     * Rollback
     * ---------------------------------------------------------------------- */

    describe('a manual rollback (FR-34, ACC-06-23)', () => {
        it('carries the old Build, its commit and `skipPreDeployJobs: true`', async () => {
            const h = harness();
            const rollback: AppDeployRollbackFacts = {
                deploymentId: '00000000-0000-4000-8000-0000000000aa',
                buildId: 'build-old',
                specCommitSha: 'sha-old',
            };

            const result = await h.service.request(
                manual({ trigger: 'rollback', buildId: 'build-old', rollback }),
            );

            // The pass is asked for the **old** commit, which is the one ACC-06-23 deploys.
            expect(h.preconditions.requests[0].specCommitSha).toBe('sha-old');
            expect(result.status).toBe('accepted');
            expect(result.stored).toMatchObject({
                buildId: 'build-old',
                commitSha: 'sha-old',
                specCommitSha: 'sha-old',
                appTrigger: 'rollback',
                skipPreDeployJobs: true,
                rollback: {
                    rolledBackToDeploymentId: '00000000-0000-4000-8000-0000000000aa',
                    imageDigest: null,
                },
            });
            expect(h.store.rows[0].appRender).toMatchObject({
                skipPreDeployJobs: true,
                rollback: {
                    automatic: false,
                    reason: 'manual',
                    restored: false,
                    rolledBackToDeploymentId: '00000000-0000-4000-8000-0000000000aa',
                },
            });
        });

        it('keeps the pre-deploy jobs when the owner asks for them back', async () => {
            const h = harness();

            const result = await h.service.request(
                manual({
                    trigger: 'rollback',
                    buildId: 'build-old',
                    runPreDeployJobs: true,
                    rollback: { deploymentId: 'old' },
                }),
            );

            expect(result.stored.skipPreDeployJobs).toBe(false);
            expect(h.store.rows[0].appRender).toMatchObject({ skipPreDeployJobs: false });
        });

        it('redeploys the recorded digest and spec commit under `strategy: image`, never a Build', async () => {
            const h = harness();
            h.preconditions.result = ready({
                context: {
                    target: 'your-cluster',
                    specCommitSha: 'sha-image-old',
                    strategy: 'image',
                    buildId: null,
                    latestGreenBuildId: null,
                    primaryHost: 'app.example.com',
                },
            });

            const result = await h.service.request(
                manual({
                    trigger: 'rollback',
                    buildId: null,
                    rollback: {
                        deploymentId: '00000000-0000-4000-8000-0000000000bb',
                        buildId: null,
                        specCommitSha: 'sha-image-old',
                        imageReference: 'ghcr.io/example/app',
                        imageDigest: `sha256:${'a'.repeat(64)}`,
                    },
                }),
            );

            expect(h.preconditions.requests[0].specCommitSha).toBe('sha-image-old');
            expect(result.status).toBe('accepted');
            expect(result.stored.buildId).toBeNull();
            expect(result.stored.commitSha).toBe('sha-image-old');
            expect(h.store.rows[0].buildId).toBeNull();
            expect(h.store.rows[0].appRender).toMatchObject({
                specCommitSha: 'sha-image-old',
                // §5.8: the recorded pair travels with the row, so nothing re-resolves the tag.
                image: {
                    reference: 'ghcr.io/example/app',
                    digest: `sha256:${'a'.repeat(64)}`,
                    resolvedFromTag: false,
                },
                rollback: { rolledBackToDeploymentId: '00000000-0000-4000-8000-0000000000bb' },
            });
        });
    });

    /* ---------------------------------------------------------------------- *
     * The 2 s budget
     * ---------------------------------------------------------------------- */

    describe('the request budget (FR-23: "answers within 2 seconds")', () => {
        it('answers 202 with `dispatch_slow` while a 5 s dispatch is still in flight', async () => {
            expect(APP_DEPLOY_REQUEST_BUDGET_MS).toBe(2_000);

            jest.useFakeTimers();
            const h = harness();
            h.dispatcher.hold = true;

            const pending = h.service.request(manual());
            await jest.advanceTimersByTimeAsync(APP_DEPLOY_REQUEST_BUDGET_MS);
            const result = await pending;

            expect(result.status).toBe('accepted');
            expect(result.httpStatus).toBe(202);
            expect(result.dispatched).toBe(false);
            expect(result.warnings.map((entry) => entry.code)).toContain(
                APP_DEPLOY_WARNING_DISPATCH_SLOW,
            );
            // The row and the lock exist; only the dispatch is late.
            expect(h.store.rows).toHaveLength(1);
            expect(h.states.released).toEqual([]);

            // Five seconds later the dispatch fails: the lock is released and the row records it,
            // so nothing is stranded by the late answer.
            h.dispatcher.fail(new Error('trigger.dev unavailable'));
            await jest.advanceTimersByTimeAsync(5_000);
            await Promise.resolve();

            expect(h.store.failed).toEqual([
                {
                    id: result.deploymentId,
                    code: APP_DEPLOY_CODE_DISPATCH_FAILED,
                    message: 'trigger.dev unavailable',
                },
            ]);
            expect(h.states.released).toEqual([
                { workId: manual().workId, deploymentId: result.deploymentId },
            ]);
        });

        it('answers 500 dispatch_failed when the dispatch throws inside the budget', async () => {
            const h = harness();
            h.dispatcher.failWith = new Error('no worker registered');

            const result = await h.service.request(manual());

            expect(result.status).toBe('refused');
            expect(result.httpStatus).toBe(500);
            expect(result.code).toBe(APP_DEPLOY_CODE_DISPATCH_FAILED);
            expect(result.warnings.map((entry) => entry.code)).toContain(
                APP_DEPLOY_CODE_DISPATCH_FAILED,
            );
            expect(h.store.failed).toHaveLength(1);
            expect(h.states.released).toEqual([
                { workId: manual().workId, deploymentId: result.deploymentId },
            ]);
        });

        it('honours a real budget: a never-answering dispatch does not hold the request', async () => {
            class FastBudget extends TestRequestService {
                protected requestBudgetMs(): number {
                    return 50;
                }
            }

            const dispatcher = new FakeDispatcher();
            dispatcher.hold = true;
            const service = new FastBudget(
                new FakePreconditions() as unknown as AppDeployPreconditionsService,
                dispatcher,
                new FakeStore(),
                new FakeStates(),
            );

            const startedAt = Date.now();
            const result = await service.request(manual());
            const elapsed = Date.now() - startedAt;

            expect(result.status).toBe('accepted');
            expect(result.dispatched).toBe(false);
            expect(elapsed).toBeLessThan(1_000);

            dispatcher.release();
        });
    });

    /* ---------------------------------------------------------------------- *
     * APW-01's port shape
     * ---------------------------------------------------------------------- */

    describe('requestDeploy — APW-01’s APP_DEPLOY_ROUTE_PORT shape', () => {
        it('answers `{ status: pending, deploymentId }` on the happy path', async () => {
            const h = harness();

            const answer = await h.service.requestDeploy({
                workId: manual().workId,
                userId: manual().userId,
                buildId: 'build-1',
                provider: 'k8s',
            });

            expect(answer).toEqual({
                status: 'pending',
                deploymentId: '00000000-0000-4000-8000-000000000001',
            });
        });

        it('throws a typed refusal carrying the 422/409 the route maps', async () => {
            const h = harness();
            h.preconditions.result = ready({
                unmet: [{ code: 'no_green_build', message: 'no green Build' }],
                ready: false,
            });

            await expect(
                h.service.requestDeploy({ workId: manual().workId, userId: manual().userId }),
            ).rejects.toBeInstanceOf(AppDeployRefusedError);

            await expect(
                h.service.requestDeploy({ workId: manual().workId }),
            ).rejects.toMatchObject({
                result: { httpStatus: 422, code: APP_DEPLOY_CODE_PRECONDITIONS },
            });
            expect(h.store.rows).toEqual([]);
        });
    });

    /* ---------------------------------------------------------------------- *
     * The pure helpers
     * ---------------------------------------------------------------------- */

    describe('pure helpers', () => {
        it('keeps §7.1’s five triggers verbatim, appends `spec-applied`, defaults an unknown to manual', () => {
            // The five plan §7.1:1036 stores, in its own order — renamed by nothing.
            expect(APP_DEPLOY_TRIGGERS.slice(0, 5)).toEqual([
                'manual',
                'build',
                'domain-change',
                'rollback',
                'target-saved',
            ]);
            // …and FR-23's sixth source, which that list omits (§5.8:886-889).
            expect(APP_DEPLOY_TRIGGERS).toHaveLength(6);
            expect(APP_DEPLOY_TRIGGERS[5]).toBe('spec-applied');

            expect(normaliseTrigger('build')).toBe('build');
            expect(normaliseTrigger('spec-applied')).toBe('spec-applied');
            expect(normaliseTrigger('nonsense' as never)).toBe('manual');
            expect(normaliseTrigger(null)).toBe('manual');
            expect(normaliseTrigger(undefined)).toBe('manual');
        });

        it('skips the pre-deploy jobs for a rollback only', () => {
            expect(skipPreDeployJobsFor({ workId: 'w', trigger: 'rollback' })).toBe(true);
            expect(
                skipPreDeployJobsFor({ workId: 'w', trigger: 'rollback', runPreDeployJobs: true }),
            ).toBe(false);
            expect(skipPreDeployJobsFor({ workId: 'w', trigger: 'manual' })).toBe(false);
            expect(skipPreDeployJobsFor({ workId: 'w' })).toBe(false);
            expect(skipPreDeployJobsFor(null)).toBe(false);
        });

        it('dedupes a queue entry by its Build, else by its spec commit', () => {
            expect(queueIdentity({ buildId: 'build-1', commitSha: 'sha-1' })).toBe('build:build-1');
            expect(queueIdentity({ buildId: null, commitSha: 'sha-1' })).toBe('spec:sha-1');
            expect(queueIdentity({ buildId: null, commitSha: null })).toBeNull();
            expect(queueIdentity(null)).toBeNull();
        });

        it('reads a stored timestamp the way the row means it', () => {
            expect(isSet(null)).toBe(false);
            expect(isSet(undefined)).toBe(false);
            expect(isSet(false)).toBe(false);
            expect(isSet('')).toBe(false);
            expect(isSet('   ')).toBe(false);
            expect(isSet(0)).toBe(true);
            expect(isSet(new Date())).toBe(true);
            expect(isSet('2026-09-18T10:00:00.000Z')).toBe(true);
        });

        it('stores no Build for a strategy that produces none, and never invents an app target', () => {
            const image = storedFacts(
                manual({ buildId: 'build-1' }),
                ready({
                    context: {
                        target: 'ever-works-apps',
                        specCommitSha: 'sha-image',
                        strategy: 'image',
                        buildId: null,
                        latestGreenBuildId: null,
                        primaryHost: null,
                    },
                }),
                'manual',
                false,
            );

            expect(image).toMatchObject({
                buildId: null,
                commitSha: 'sha-image',
                appTarget: 'ever-works-apps',
                provider: 'k8s',
            });

            const none = storedFacts(
                { workId: 'w' },
                ready({ context: { ...ready().context, strategy: 'none', target: null } }),
                'manual',
                false,
            );
            expect(none).toMatchObject({
                buildId: null,
                appTarget: null,
                provider: '',
                branch: null,
            });
        });

        it('writes §2.2:156’s row from the stored facts', () => {
            const facts = storedFacts(manual(), ready(), 'target-saved', false);
            const draft = rowDraft('dep-1', 'work-1', manual(), facts, 'target-saved');

            expect(draft).toEqual({
                id: 'dep-1',
                workId: 'work-1',
                state: APP_DEPLOY_STATE_INITIALIZING,
                provider: 'k8s',
                triggerSource: 'manual',
                appTrigger: 'target-saved',
                buildId: manual().buildId,
                appTarget: 'your-cluster',
                commitSha: 'sha-spec-1',
                branch: 'main',
                triggeredByUserId: manual().userId,
                appRender: { specCommitSha: 'sha-spec-1', skipPreDeployJobs: false },
            });
        });
    });
});
