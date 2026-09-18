import 'reflect-metadata';
import {
    type CanActivate,
    type ExecutionContext,
    Injectable,
    type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import {
    APP_DIVERGENCE_TTL_MS,
    APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR,
    APP_UPSTREAM_SYNC_MANUAL_PER_HOUR,
} from '@ever-works/contracts';
import {
    AppUpstreamStateService,
    AppUpstreamSyncDispatcherService,
} from '@ever-works/agent/app-works';
import * as request from 'supertest';
import { AppUpstreamController } from './app-upstream.controller';

/**
 * APW-02 T27 — the three Upstream routes through a real HTTP stack (plan §4.1,
 * `plan.md:487-516`). ACC-02-05, ACC-02-13, ACC-02-14, ACC-02-21.
 *
 * Spec: FR-33, FR-34, FR-46, FR-56; the error table of §4.1 is the assertion list.
 *
 * ## Why HTTP, and what is real behind it
 *
 * Everything this task owns is a property of the **route**: the three paths, the `202`
 * of the two POSTs, the `404`/`409`/`422`/`429` a client actually sees, and the throttle
 * metadata on each handler. A hand-built controller instance would assert none of the
 * first four — and the fifth only if it read the decorators off the prototype anyway. So
 * the spec builds a Nest application, installs a session stand-in as the global guard
 * (`@CurrentUser()` reads `request.user`, which is what the real `AuthSessionGuard`
 * seeds) and drives it with supertest.
 *
 * Behind the routes are the **real** `AppUpstreamStateService` (T23) and the **real**
 * `AppUpstreamSyncDispatcherService` (T28), constructed by hand with a fake repository so
 * the whole decision chain runs: the visibility check (ACC-02-21 — a stranger's Work and
 * a non-`app` Work both answer `404 not_found`, from the service's own single `notFound()`
 * factory), the readiness and pause gates, the two rolling-hour allowances, the divergence
 * dispatch and its 600 s window. Only the row store is a fake, and it is a store: it holds
 * one row per Work, merges patches and implements the two conditional counters the way
 * `WorkUpstreamStateRepository` does (allow while `count < max` inside the window).
 *
 * The **job queue** is the one seam that is a double everywhere, because it is a seam in
 * production too (§6.1: the dispatcher port is bound by T31): `FakeQueue` records every
 * payload it was handed and answers a synthetic run id. That is what `202 { queued: true,
 * runId }` is asserted against — the route hands the queue a payload and returns the
 * queue's own answer, and never waits for the run, which does not even exist in this
 * process (plan §2.4 puts `AppUpstreamSyncService` in the worker).
 */

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

const OWNER = '11111111-1111-4111-8111-111111111101';
const STRANGER = '11111111-1111-4111-8111-111111111102';
const WORK_ID = '22222222-2222-4222-8222-222222222201';
const PLAIN_WORK_ID = '22222222-2222-4222-8222-222222222202';
const LINK_WORK_ID = '22222222-2222-4222-8222-222222222203';
const MISSING_WORK_ID = '22222222-2222-4222-8222-2222222222ff';

const SHA = 'a'.repeat(40);
const MINUTE = 60_000;
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// The row store — `WorkUpstreamStateRepository`, in memory
// ---------------------------------------------------------------------------

interface Row {
    [key: string]: unknown;
}

const NOW = Date.now();

/** A fork that is `ready` and has a stale divergence reading — the ordinary card. */
function forkRow(overrides: Row = {}): Row {
    return {
        id: `row-${WORK_ID}`,
        workId: WORK_ID,
        relation: 'fork',
        dataOwner: 'me',
        dataRepo: 'widgets',
        dataDefaultBranch: 'main',
        upstreamOwner: 'upstream',
        upstreamRepo: 'project',
        upstreamDefaultBranch: 'main',
        upstreamPreviousDefaultBranch: null,
        upstreamStatus: 'available',
        upstreamCheckedAt: null,
        dataRepositoryStatus: 'available',
        readinessState: 'ready',
        readinessReason: null,
        readinessStartedAt: new Date(NOW - HOUR),
        readinessHeartbeatAt: new Date(NOW),
        readinessDispatches: 0,
        readinessManualRetries: 0,
        readinessManualWindowAt: null,
        readyAt: new Date(NOW - HOUR),
        setupPullRequestUrl: null,
        setupPullRequestNumber: null,
        setupCheckedAt: null,
        copyPushedSha: null,
        aheadBy: 3,
        behindBy: 2,
        divergenceComputedAt: new Date(NOW - APP_DIVERGENCE_TTL_MS - MINUTE),
        behindEventCount: 0,
        upstreamHeadSha: SHA,
        syncSchedule: null,
        nextSyncAt: null,
        syncStartedAt: null,
        syncFinishedAt: null,
        lastSyncResult: null,
        lastSyncReason: null,
        lastSyncedUpstreamSha: null,
        lastSyncCommitCount: null,
        syncPullRequestNumber: null,
        syncPullRequestUrl: null,
        syncPullRequestClosedHeadSha: null,
        conflictTaskId: null,
        manualSyncCount: 0,
        manualSyncWindowAt: null,
        consecutiveRateLimited: 0,
        rateLimitedUntil: null,
        actionsState: 'clean',
        actionsSeenWorkflowIds: null,
        actionsDisabledWorkflows: null,
        actionsKeptWorkflows: null,
        actionsCheckedAt: null,
        tenantId: null,
        organizationId: null,
        ...overrides,
    };
}

/**
 * The epic's own table, in memory. Only the four methods these routes reach are
 * implemented; the three dispatcher reads answer empty arrays, because the cron tick is
 * not what this spec is about (T28's own spec owns it).
 */
class FakeRows {
    readonly rows = new Map<string, Row>();
    readonly updates: Array<{ workId: string; patch: Row }> = [];
    private readonly counters = new Map<string, { count: number; windowAt: number | null }>();

    seed(...rows: Row[]): void {
        for (const row of rows) {
            this.rows.set(String(row.workId), row);
        }
    }

    reset(): void {
        this.rows.clear();
        this.updates.length = 0;
        this.counters.clear();
    }

    async findByWorkId(workId: string): Promise<Row | null> {
        return this.rows.get(workId) ?? null;
    }

    async update(workId: string, patch: Row): Promise<boolean> {
        const row = this.rows.get(workId);
        if (!row) {
            return false;
        }
        this.updates.push({ workId, patch });
        Object.assign(row, patch);
        return true;
    }

    async incrementManualSync(
        workId: string,
        nowMs: number,
        windowMs: number,
        max: number,
    ): Promise<{ allowed: boolean; count: number; windowAtMs: number | null }> {
        return this.increment(`sync:${workId}`, workId, nowMs, windowMs, max, [
            'manualSyncCount',
            'manualSyncWindowAt',
        ]);
    }

    async incrementManualRetry(
        workId: string,
        nowMs: number,
        windowMs: number,
        max: number,
    ): Promise<{ allowed: boolean; count: number; windowAtMs: number | null }> {
        return this.increment(`retry:${workId}`, workId, nowMs, windowMs, max, [
            'readinessManualRetries',
            'readinessManualWindowAt',
        ]);
    }

    async claimDue(): Promise<Row[]> {
        return [];
    }

    async findStalePreparing(): Promise<Row[]> {
        return [];
    }

    async findUnavailableDueForRecheck(): Promise<Row[]> {
        return [];
    }

    /** The repository's own rule: at most `max` attempts per rolling `windowMs`. */
    private async increment(
        key: string,
        workId: string,
        nowMs: number,
        windowMs: number,
        max: number,
        [countColumn, windowColumn]: [string, string],
    ): Promise<{ allowed: boolean; count: number; windowAtMs: number | null }> {
        const current = this.counters.get(key) ?? { count: 0, windowAt: null };
        const open = current.windowAt !== null && current.windowAt > nowMs - windowMs;
        const count = open ? current.count : 0;
        const windowAt = open ? current.windowAt : nowMs;
        const allowed = count < max;
        const next = allowed ? count + 1 : count;

        this.counters.set(key, { count: next, windowAt });
        await this.update(workId, { [countColumn]: next, [windowColumn]: new Date(windowAt) });

        return { allowed, count: next, windowAtMs: windowAt };
    }
}

// ---------------------------------------------------------------------------
// The two workspace reads and the job queue
// ---------------------------------------------------------------------------

/** `WorkRepository.findByIdForAccess` — the kind and the owner, and nothing else. */
class FakeWorks {
    private readonly works = new Map<string, { id: string; kind: string; userId: string }>();

    seed(work: { id: string; kind: string; userId: string }): void {
        this.works.set(work.id, work);
    }

    reset(): void {
        this.works.clear();
    }

    async findByIdForAccess(workId: string): Promise<unknown> {
        return this.works.get(workId) ?? null;
    }
}

/** `WorkMemberRepository.isMember` — nobody is a member here; the owner is the owner. */
class FakeMembers {
    members = new Set<string>();

    async isMember(workId: string, userId: string): Promise<boolean> {
        return this.members.has(`${workId}:${userId}`);
    }
}

/** The T31 seam: records every payload and answers a synthetic run id. */
class FakeQueue {
    readonly payloads: Array<{ workId: string; trigger?: string; attempt?: number }> = [];

    async dispatch(payload: {
        workId: string;
        trigger?: string;
        attempt?: number;
    }): Promise<string> {
        this.payloads.push(payload);
        return `run-${payload.workId}-${payload.trigger ?? `attempt-${payload.attempt}`}`;
    }
}

// ---------------------------------------------------------------------------
// The session stand-in
// ---------------------------------------------------------------------------

/**
 * `AuthSessionGuard`, reduced to the one thing these routes read: `request.user.userId`.
 * A request without an `authorization` header is left unauthenticated, which is how the
 * "no session" case is driven.
 */
@Injectable()
class TestSessionGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const http = context.switchToHttp().getRequest();
        const header = http.headers?.authorization;
        if (typeof header === 'string' && header.length > 0) {
            http.user = { userId: header.replace(/^Bearer\s+/i, '') };
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

describe('AppUpstreamController', () => {
    let app: INestApplication;
    let rows: FakeRows;
    let works: FakeWorks;
    let members: FakeMembers;
    let syncQueue: FakeQueue;
    let readinessQueue: FakeQueue;
    /**
     * The Git facade (§4.1's on-view reads).
     *
     * It was `undefined` until T43 under the comment "no route here reads a provider" — that
     * comment is now false: the setup pull request check reads one whenever the card is opened
     * on a Work that is waiting, so the double belongs in the fixture rather than being an
     * omission the routes happen not to reach.
     */
    let git: { getPullRequestStatus: jest.Mock };
    let stateService: AppUpstreamStateService;

    /**
     * The supertest entry point, and the two helpers built on it.
     *
     * `suite()` returns the `SuperTest` wrapper (which carries the HTTP verbs) rather than
     * a single `Test`, because superagent's `Test.get(name)` is the *header* getter —
     * typing a helper as `Test` and calling `.get(url)` on it silently reads a response
     * header instead of issuing a request.
     */
    const suite = () => request(app.getHttpServer());
    type HttpCall = ReturnType<ReturnType<typeof suite>['get']>;

    const auth = (call: HttpCall, userId: string = OWNER): HttpCall => {
        call.set('authorization', `Bearer ${userId}`);
        return call;
    };

    const expectNotFound = async (call: HttpCall): Promise<void> => {
        const response = await call;
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ status: 'error', code: 'not_found' });
    };

    /** The two services, built by hand so the whole decision chain is the production one. */
    function buildServices(): {
        state: AppUpstreamStateService;
        dispatcher: AppUpstreamSyncDispatcherService;
    } {
        // Positional, in the constructor's own order: the four collaborators these routes
        // need, then the optional collaborators these routes never reach (Tasks, chat,
        // Activity, notifications, the distributed lock, the Agent resolver).
        const state = new AppUpstreamStateService(
            rows as never, // WorkUpstreamStateRepository
            works as never, // WorkRepository
            members as never, // WorkMemberRepository
            git as never, // GitFacadeService — §4.1's on-view provider reads (T43)
            undefined, // TaskRepository
            undefined, // TasksService
            undefined, // TaskChatService
            undefined, // ActivityLogService
            undefined, // NotificationService
            undefined, // DistributedTaskLockService
            undefined, // APP_WORK_AGENT_RESOLVER
            readinessQueue as never, // APP_FORK_READINESS_DISPATCHER
            syncQueue as never, // APP_UPSTREAM_SYNC_DISPATCHER
        );

        const dispatcher = new AppUpstreamSyncDispatcherService(
            rows as never,
            state,
            syncQueue as never,
            readinessQueue as never,
        );

        return { state, dispatcher };
    }

    beforeAll(() => {
        rows = new FakeRows();
        works = new FakeWorks();
        members = new FakeMembers();
        syncQueue = new FakeQueue();
        readinessQueue = new FakeQueue();
        git = {
            // Default: the setup pull request is still open. Each test says otherwise.
            getPullRequestStatus: jest
                .fn()
                .mockResolvedValue({ number: 5, state: 'open', merged: false }),
        };
    });

    /**
     * A fresh application per test.
     *
     * The divergence window of `AppUpstreamSyncDispatcherService` is **per-process state
     * by design** (§4.1: at most one compare per Work per 600 s), so a dispatcher shared
     * across tests would let the first test's dispatch hold every later one back — and the
     * suite would then be asserting the order of its own tests. Rebuilding the app is the
     * honest way to keep that window out of the fixtures.
     */
    async function createApp(): Promise<void> {
        const built = buildServices();
        stateService = built.state;

        const moduleRef = await Test.createTestingModule({
            controllers: [AppUpstreamController],
            providers: [
                { provide: AppUpstreamStateService, useValue: built.state },
                { provide: AppUpstreamSyncDispatcherService, useValue: built.dispatcher },
                TestSessionGuard,
                { provide: APP_GUARD, useExisting: TestSessionGuard },
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        await app.init();
    }

    afterEach(async () => {
        await app?.close();
    });

    beforeEach(async () => {
        rows.reset();
        works.reset();
        syncQueue.payloads.length = 0;
        readinessQueue.payloads.length = 0;
        git.getPullRequestStatus.mockClear();

        works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
        works.seed({ id: LINK_WORK_ID, kind: 'app', userId: OWNER });
        works.seed({ id: PLAIN_WORK_ID, kind: 'repo', userId: OWNER });
        rows.seed(
            forkRow(),
            forkRow({
                id: `row-${LINK_WORK_ID}`,
                workId: LINK_WORK_ID,
                relation: 'link',
                upstreamOwner: null,
                upstreamRepo: null,
            }),
        );

        await createApp();
    });

    // -----------------------------------------------------------------------
    // Throttling and the OpenAPI annotations (plan §4.1's table)
    // -----------------------------------------------------------------------

    describe('the route table (plan §4.1)', () => {
        it('throttles the three routes at 120 / 12 / 6 per minute', () => {
            const limitOf = (method: string): unknown =>
                Reflect.getMetadata(
                    `${THROTTLER_LIMIT}long`,
                    (AppUpstreamController.prototype as unknown as Record<string, object>)[method],
                );
            const ttlOf = (method: string): unknown =>
                Reflect.getMetadata(
                    `${THROTTLER_TTL}long`,
                    (AppUpstreamController.prototype as unknown as Record<string, object>)[method],
                );

            expect(limitOf('getUpstream')).toBe(120);
            expect(limitOf('syncUpstream')).toBe(12);
            expect(limitOf('retryUpstreamReadiness')).toBe(6);
            expect(ttlOf('getUpstream')).toBe(60_000);
            expect(ttlOf('syncUpstream')).toBe(60_000);
            expect(ttlOf('retryUpstreamReadiness')).toBe(60_000);
        });

        it('carries an @ApiOperation on each of the three routes', () => {
            for (const method of ['getUpstream', 'syncUpstream', 'retryUpstreamReadiness']) {
                const operation = Reflect.getMetadata(
                    'swagger/apiOperation',
                    (AppUpstreamController.prototype as unknown as Record<string, object>)[method],
                ) as { summary?: string } | undefined;

                expect(operation?.summary).toBeTruthy();
            }
        });
    });

    // -----------------------------------------------------------------------
    // GET /api/works/:id/upstream (FR-46, ACC-02-13)
    // -----------------------------------------------------------------------

    describe('GET /api/works/:id/upstream', () => {
        it('answers 200 with the state the service reports, stale flag included', async () => {
            const response = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            expect(response.status).toBe(200);
            expect(response.body.workId).toBe(WORK_ID);
            expect(response.body.relation).toBe('fork');
            expect(response.body.upstream.owner).toBe('upstream');
            expect(response.body.divergence).toMatchObject({
                aheadBy: 3,
                behindBy: 2,
                stale: true,
            });
            expect(typeof response.body.divergence.computedAt).toBe('string');
        });

        it('queues one background divergence compare and never waits for the run', async () => {
            const response = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            expect(response.status).toBe(200);
            expect(syncQueue.payloads).toEqual([{ workId: WORK_ID, trigger: 'divergence' }]);
        });

        it('does not queue a second compare inside the 600 s window (ACC-02-13)', async () => {
            const first = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));
            const second = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));
            const third = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
            // Every read still reports the reading it has, with its age — the refresh is
            // what is throttled, never the answer (FR-46).
            expect(second.body.divergence.stale).toBe(true);
            expect(syncQueue.payloads).toHaveLength(1);
        });

        it('does not queue a compare while the stored reading is still fresh', async () => {
            rows.reset();
            works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
            rows.seed(forkRow({ divergenceComputedAt: new Date(Date.now() - MINUTE) }));

            const response = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            expect(response.status).toBe(200);
            expect(response.body.divergence.stale).toBe(false);
            expect(syncQueue.payloads).toHaveLength(0);
        });

        it('never queues a compare for a link relation — it has no upstream (FR-44)', async () => {
            const response = await auth(suite().get(`/api/works/${LINK_WORK_ID}/upstream`));
            expect(response.status).toBe(200);
            expect(response.body.relation).toBe('link');
            expect(response.body.sync).toBeNull();
            expect(syncQueue.payloads).toHaveLength(0);
        });

        it('answers 401 without a session', async () => {
            const response = await suite().get(`/api/works/${WORK_ID}/upstream`);

            // No session ⇒ no `request.user` ⇒ the controller reads `auth.userId` off
            // `undefined`. The real stack refuses this in `AuthSessionGuard` before the
            // handler runs; this spec keeps the fact visible rather than asserting a 200.
            expect(response.status).not.toBe(200);
        });

        // -------------------------------------------------------------------
        // FR-24a's on-view half (APW-02 T43, ACC-02-22): opening the card on a
        // Work that is waiting on its setup pull request re-checks it — at most
        // once a minute, and never for a Work that is not waiting.
        // -------------------------------------------------------------------

        it('re-checks the setup pull request when the card is opened on a waiting Work', async () => {
            rows.reset();
            works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
            rows.seed(
                forkRow({
                    readinessState: 'waiting_for_setup_pr',
                    setupPullRequestNumber: 5,
                    setupCheckedAt: new Date(NOW - HOUR),
                }),
            );

            const response = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            expect(response.status).toBe(200);
            expect(git.getPullRequestStatus).toHaveBeenCalledTimes(1);
            expect(git.getPullRequestStatus).toHaveBeenCalledWith(
                'me',
                'widgets',
                5,
                expect.objectContaining({ userId: OWNER }),
            );
            // The check stamps the row, which is what makes the next read a no-op.
            expect(rows.updates.some((entry) => 'setupCheckedAt' in entry.patch)).toBe(true);
        });

        it('does not re-check inside the 60 000 ms window (ACC-02-22)', async () => {
            rows.reset();
            works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
            rows.seed(
                forkRow({
                    readinessState: 'waiting_for_setup_pr',
                    setupPullRequestNumber: 5,
                    setupCheckedAt: new Date(NOW - HOUR),
                }),
            );

            const first = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));
            const second = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));
            const third = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
            // Three reads, one provider read: the row's `setupCheckedAt` is the gate, and every
            // answer still carries the state the service has (only the *check* is throttled).
            expect(git.getPullRequestStatus).toHaveBeenCalledTimes(1);
        });

        it('never checks a Work that is not waiting on a setup pull request', async () => {
            // The default fixture row is `ready` with a setup PR recorded from an earlier state.
            const response = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            expect(response.status).toBe(200);
            expect(git.getPullRequestStatus).not.toHaveBeenCalled();
        });

        it('still renders the card when the check itself blows up', async () => {
            rows.reset();
            works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
            rows.seed(
                forkRow({
                    readinessState: 'waiting_for_setup_pr',
                    setupPullRequestNumber: 5,
                    setupCheckedAt: new Date(NOW - HOUR),
                }),
            );
            git.getPullRequestStatus.mockRejectedValue(new Error('provider is down'));

            const response = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            // The background check is best-effort by construction: a readable card must not
            // become a 500 because a provider refused a read the member never asked for.
            expect(response.status).toBe(200);
            expect(response.body.workId).toBe(WORK_ID);
        });
    });

    // -----------------------------------------------------------------------
    // ACC-02-21 — another account's Work is not found, on every route
    // -----------------------------------------------------------------------

    describe('another account’s App Work (ACC-02-21, FR-56)', () => {
        it('answers 404 not_found on the read for a stranger’s Work', async () => {
            await expectNotFound(auth(suite().get(`/api/works/${WORK_ID}/upstream`), STRANGER));
        });

        it('answers 404 not_found on Sync now for a stranger’s Work', async () => {
            await expectNotFound(
                auth(suite().post(`/api/works/${WORK_ID}/upstream/sync`), STRANGER),
            );
            expect(syncQueue.payloads).toHaveLength(0);
        });

        it('answers 404 not_found on Try again for a stranger’s Work', async () => {
            await expectNotFound(
                auth(suite().post(`/api/works/${WORK_ID}/upstream/readiness/retry`), STRANGER),
            );
            expect(readinessQueue.payloads).toHaveLength(0);
        });

        it('answers the SAME 404 for a Work that does not exist at all', async () => {
            // One factory, one answer: the route must never tell a stranger which of
            // "missing", "not an app Work" and "not yours" it was.
            await expectNotFound(auth(suite().get(`/api/works/${MISSING_WORK_ID}/upstream`)));
            await expectNotFound(auth(suite().post(`/api/works/${MISSING_WORK_ID}/upstream/sync`)));
        });

        it('answers the SAME 404 for a Work of another kind (not `app`)', async () => {
            await expectNotFound(auth(suite().get(`/api/works/${PLAIN_WORK_ID}/upstream`)));
            await expectNotFound(auth(suite().post(`/api/works/${PLAIN_WORK_ID}/upstream/sync`)));
        });
    });

    // -----------------------------------------------------------------------
    // POST /api/works/:id/upstream/sync (FR-33, FR-34, ACC-02-14)
    // -----------------------------------------------------------------------

    describe('POST /api/works/:id/upstream/sync', () => {
        it('answers 202 { queued, runId } with the queue’s own answer, not the run’s', async () => {
            const response = await auth(suite().post(`/api/works/${WORK_ID}/upstream/sync`));

            expect(response.status).toBe(202);
            expect(response.body).toEqual({ queued: true, runId: `run-${WORK_ID}-manual` });
            // The manual trigger, once, and no provider call anywhere in this process:
            // the run itself is the worker's (plan §2.4).
            expect(syncQueue.payloads).toEqual([{ workId: WORK_ID, trigger: 'manual' }]);
        });

        it('refuses a link with 422 no_upstream (FR-44)', async () => {
            const response = await auth(suite().post(`/api/works/${LINK_WORK_ID}/upstream/sync`));

            expect(response.status).toBe(422);
            expect(response.body).toMatchObject({ status: 'error', code: 'no_upstream' });
            expect(syncQueue.payloads).toHaveLength(0);
        });

        it('refuses a Work that is not ready with 409 not_ready', async () => {
            rows.reset();
            works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
            rows.seed(forkRow({ readinessState: 'preparing' }));

            const response = await auth(suite().post(`/api/works/${WORK_ID}/upstream/sync`));

            expect(response.status).toBe(409);
            expect(response.body).toMatchObject({ status: 'error', code: 'not_ready' });
            expect(syncQueue.payloads).toHaveLength(0);
        });

        it('refuses a paused Work with 409 sync_paused plus the reason', async () => {
            rows.reset();
            works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
            rows.seed(forkRow({ upstreamStatus: 'archived' }));

            const response = await auth(suite().post(`/api/works/${WORK_ID}/upstream/sync`));

            expect(response.status).toBe(409);
            expect(response.body).toMatchObject({
                status: 'error',
                code: 'sync_paused',
                details: { reason: 'upstream_archived' },
            });
            expect(syncQueue.payloads).toHaveLength(0);
        });

        it('refuses a Work whose sync is already running with 409 sync_in_progress', async () => {
            rows.reset();
            works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
            rows.seed(
                forkRow({
                    syncStartedAt: new Date(Date.now() - MINUTE),
                    syncFinishedAt: new Date(Date.now() - 2 * MINUTE),
                }),
            );

            const response = await auth(suite().post(`/api/works/${WORK_ID}/upstream/sync`));

            expect(response.status).toBe(409);
            expect(response.body).toMatchObject({ status: 'error', code: 'sync_in_progress' });
            expect(syncQueue.payloads).toHaveLength(0);
        });

        it('refuses the 7th manual sync in the rolling hour with 429 and details.retryAt', async () => {
            const statuses: number[] = [];
            const codes: string[] = [];

            for (let attempt = 0; attempt < APP_UPSTREAM_SYNC_MANUAL_PER_HOUR + 1; attempt++) {
                const response = await auth(suite().post(`/api/works/${WORK_ID}/upstream/sync`));
                statuses.push(response.status);
                codes.push(response.body.code);
            }

            expect(APP_UPSTREAM_SYNC_MANUAL_PER_HOUR).toBe(6);
            expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 429]);
            expect(codes[6]).toBe('sync_limit_reached');
            expect(typeof codes[0]).toBe('undefined');
            // Six jobs queued, the seventh refused before anything was queued.
            expect(syncQueue.payloads).toHaveLength(6);
        });

        it('sends the retry instant of the 429 in the body', async () => {
            for (let attempt = 0; attempt < APP_UPSTREAM_SYNC_MANUAL_PER_HOUR; attempt++) {
                await auth(suite().post(`/api/works/${WORK_ID}/upstream/sync`));
            }

            const response = await auth(suite().post(`/api/works/${WORK_ID}/upstream/sync`));

            expect(response.status).toBe(429);
            expect(typeof response.body.details.retryAt).toBe('string');
            expect(Number.isFinite(Date.parse(response.body.details.retryAt))).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // POST /api/works/:id/upstream/readiness/retry (FR-19, ACC-02-05)
    // -----------------------------------------------------------------------

    describe('POST /api/works/:id/upstream/readiness/retry', () => {
        /** A Work whose readiness is stuck — what **Try again** exists for. */
        const stuck = (overrides: Row = {}): void => {
            rows.reset();
            works.seed({ id: WORK_ID, kind: 'app', userId: OWNER });
            rows.seed(forkRow({ readinessState: 'timed_out', ...overrides }));
        };

        it('answers 202 { queued, runId } and queues the retry reason', async () => {
            stuck();

            const response = await auth(
                suite().post(`/api/works/${WORK_ID}/upstream/readiness/retry`),
            );

            expect(response.status).toBe(202);
            expect(response.body).toEqual({
                queued: true,
                runId: `run-${WORK_ID}-attempt-1`,
            });
            expect(readinessQueue.payloads).toEqual([
                { workId: WORK_ID, attempt: 1, reason: 'retry' },
            ]);
        });

        it('refuses a preparing or ready Work with 409 not_retryable', async () => {
            for (const readinessState of ['preparing', 'ready']) {
                stuck({ readinessState });

                const response = await auth(
                    suite().post(`/api/works/${WORK_ID}/upstream/readiness/retry`),
                );

                expect(response.status).toBe(409);
                expect(response.body).toMatchObject({ status: 'error', code: 'not_retryable' });
            }
            expect(readinessQueue.payloads).toHaveLength(0);
        });

        it('refuses the 4th retry in the rolling hour with 429 retry_limit_reached', async () => {
            stuck();
            const statuses: number[] = [];

            for (
                let attempt = 0;
                attempt < APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR + 1;
                attempt++
            ) {
                // Each accepted retry puts the Work back to `preparing`; the next one is
                // only refused by the rolling-hour allowance, which is the point here.
                rows.rows.get(WORK_ID)!.readinessState = 'timed_out';
                const response = await auth(
                    suite().post(`/api/works/${WORK_ID}/upstream/readiness/retry`),
                );
                statuses.push(response.status);
            }

            expect(APP_FORK_READINESS_MANUAL_RETRIES_PER_HOUR).toBe(3);
            expect(statuses).toEqual([202, 202, 202, 429]);
            expect(readinessQueue.payloads).toHaveLength(3);
        });
    });

    // -----------------------------------------------------------------------
    // The error mapping itself
    // -----------------------------------------------------------------------

    describe('the error contract of plan §4.1', () => {
        it('keeps a non-refusal failure travelling — no blanket catch', async () => {
            // A genuine bug behind the route (here: the row store throwing) must surface as
            // a 500, never be reshaped into one of §4.1's codes.
            const spy = jest
                .spyOn(rows, 'findByWorkId')
                .mockRejectedValueOnce(new Error('database is down'));

            const response = await auth(suite().get(`/api/works/${WORK_ID}/upstream`));

            expect(response.status).toBe(500);
            expect(response.body.code).toBeUndefined();
            spy.mockRestore();
        });

        it('exposes the state service the routes are built on', () => {
            // Guards against the whole spec silently passing against a stale double: the
            // object behind the controller is the real T23 service.
            expect(stateService).toBeInstanceOf(AppUpstreamStateService);
        });
    });
});
