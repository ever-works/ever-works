import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import {
    FLEET_BROWSER_CAPABILITY,
    PROMOTION_TASK_LABEL,
    RELEASE_REVERT_TASK_LABEL,
    RELEASE_VERIFY_ATTEMPT_INTERVAL_MS,
    RELEASE_VERIFY_FAILURE_CONFIRMATIONS,
    RELEASE_VERIFY_MAX_ATTEMPTS,
    RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS,
} from '@ever-works/contracts';
import { ReleasePromotion } from '@src/entities/release-promotion.entity';
import { ReleasePromotionRepository } from '@src/database/repositories/release-promotion.repository';
import { TaskStatus } from '@src/entities/task.entity';
import { ReleaseVerificationService } from '../release-verification.service';

/**
 * Post-deploy verification and revert (self-build slice AJ, EW-809).
 *
 * The REAL `ReleasePromotionRepository` over a real (in-memory sqlite)
 * `release_promotions` table. Only the process edges are stubbed: the git
 * provider, the fleet queue, the Task writer and the Inbox.
 *
 * Every compare-and-set that makes this lane safe across replicas — the
 * start claim, the attempt claim, the result pin, the settle pin, the
 * defer, the burn, the release and the revert-offer claim — is exercised
 * DIRECTLY, from a state the guard is supposed to refuse, in "the
 * compare-and-set guards" block near the end. That block exists because
 * this header used to claim the coverage the behavioural tests give: it
 * does not. Four of those `.andWhere` clauses could be deleted from the
 * repository with the whole suite still green, because each had an
 * in-process guard in front of it that satisfied the assertion on its own.
 * A test that goes through the service exercises the SERVICE's guard; only
 * a test that calls the repository exercises the repository's.
 *
 * What this file is mostly about is the three ways the lane must refuse:
 *
 *   - it must not report green for a build that was never deployed;
 *   - it must not offer a revert for something it did not measure;
 *   - it must not keep checking for ever.
 *
 * The happy path is two tests. Everything else is a refusal or a bound.
 */
describe('ReleaseVerificationService', () => {
    let dataSource: DataSource;
    let rows: Repository<ReleasePromotion>;
    let promotions: ReleasePromotionRepository;

    const USER = 'user-1';
    const OTHER_USER = 'user-2';
    const WORK = 'work-1';
    const AGENT = 'agent-1';
    const ORG = 'org-1';
    /** The promotion's head — the branch being merged FROM. Never deployed. */
    const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    /** The BASE branch's tip after the merge — what actually gets built. */
    const MERGED = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const STAGING = {
        versionUrl: 'https://apistage.ever.works/api/version',
        appUrl: 'https://appstage.ever.works/api/health',
        appExpectText: '"status":"OK"',
    };
    const PRODUCTION = {
        versionUrl: 'https://api.ever.works/api/version',
        appUrl: 'https://app.ever.works/api/health',
        appExpectText: '"status":"OK"',
    };
    const TARGETS = { staging: STAGING, production: PRODUCTION };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [ReleasePromotion],
            synchronize: true,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(ReleasePromotion);
        promotions = new ReleasePromotionRepository(rows);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await rows.clear();
    });

    // ── Harness ───────────────────────────────────────────────────────

    function makeWork(overrides: Record<string, unknown> = {}) {
        return {
            id: WORK,
            slug: 'ever-works',
            userId: USER,
            gitProvider: 'github',
            tenantId: null,
            organizationId: ORG,
            releaseVerification: TARGETS,
            getRepoOwner: () => 'ever-works',
            getDataRepo: () => 'ever-works',
            ...overrides,
        };
    }

    function makeTask(overrides: Record<string, unknown> = {}) {
        return {
            id: 'task-1',
            slug: 'T-7',
            userId: USER,
            agentId: AGENT,
            workId: WORK,
            labels: [PROMOTION_TASK_LABEL, 'release:promotion:stage-to-main'],
            tenantId: null,
            organizationId: ORG,
            ...overrides,
        };
    }

    function build(
        opts: {
            work?: Record<string, unknown> | null;
            branches?: Array<{ name: string; commit: string }>;
            listBranchesError?: Error;
            noFleet?: boolean;
            noGitFacade?: boolean;
            noInbox?: boolean;
            enqueueError?: Error;
            createTaskError?: Error;
            /** Override what `FleetJobService.enqueue` hands back. */
            enqueueReturns?: (
                input: Record<string, unknown>,
                seq: number,
            ) => Record<string, unknown>;
            /** Owner recorded on the fleet job row the enqueue created. */
            enqueueOwner?: string;
            /** Fleet job rows the sweep reads back, keyed by id. */
            fleetJobRows?: Map<string, Record<string, unknown>>;
            noFleetJobs?: boolean;
            fleetJobsError?: Error;
        } = {},
    ) {
        const revertTask = { id: 'revert-task-1', slug: 'T-99', agentId: AGENT, title: 'Revert' };
        const works = {
            findById: jest.fn().mockResolvedValue(opts.work === null ? null : makeWork(opts.work)),
        };
        const tasks = {
            findById: jest.fn().mockResolvedValue(makeTask()),
            updateById: jest.fn().mockResolvedValue(undefined),
        };
        const tasksService = {
            create: opts.createTaskError
                ? jest.fn().mockRejectedValue(opts.createTaskError)
                : jest.fn().mockResolvedValue(revertTask),
        };
        const chat = { create: jest.fn().mockResolvedValue(undefined) };
        let jobSeq = 0;
        const fleetRows = new Map<string, Record<string, unknown>>();
        const fleet = {
            // Models `FleetJobService.enqueue`'s ACTUAL return value — a
            // whole `FleetJobView`, echoing the kind, status and payload of
            // the row it created or found. A double that returned a bare
            // `{ id }` is how the slice shipped with nothing checking that
            // the job handed back was the job it asked for.
            enqueue: opts.enqueueError
                ? jest.fn().mockRejectedValue(opts.enqueueError)
                : jest.fn().mockImplementation((input: Record<string, unknown>) => {
                      jobSeq += 1;
                      const view = opts.enqueueReturns
                          ? opts.enqueueReturns(input, jobSeq)
                          : {
                                id: `job-${jobSeq}`,
                                kind: input.kind,
                                status: 'queued',
                                payload: input.payload,
                            };
                      fleetRows.set(view.id as string, {
                          ...view,
                          userId: (opts.enqueueOwner ?? USER) as string,
                      });
                      return Promise.resolve(view);
                  }),
        };
        const fleetJobs = {
            findById: jest.fn().mockImplementation((id: string) => {
                if (opts.fleetJobsError) return Promise.reject(opts.fleetJobsError);
                return Promise.resolve(opts.fleetJobRows?.get(id) ?? fleetRows.get(id) ?? null);
            }),
        };
        const gitFacade = {
            listBranches: opts.listBranchesError
                ? jest.fn().mockRejectedValue(opts.listBranchesError)
                : jest.fn().mockResolvedValue(
                      opts.branches ?? [
                          { name: 'develop', commit: HEAD, isDefault: true },
                          { name: 'stage', commit: HEAD, isDefault: false },
                          { name: 'main', commit: MERGED, isDefault: false },
                      ],
                  ),
        };
        const inbox = { notice: jest.fn().mockResolvedValue(undefined) };

        const service = new ReleaseVerificationService(
            promotions,
            works as never,
            tasks as never,
            tasksService as never,
            chat as never,
            opts.noFleet ? undefined : (fleet as never),
            opts.noGitFacade ? undefined : (gitFacade as never),
            opts.noInbox ? undefined : (inbox as never),
            opts.noFleetJobs ? undefined : (fleetJobs as never),
        );
        return {
            service,
            works,
            tasks,
            tasksService,
            chat,
            fleet,
            fleetJobs,
            fleetRows,
            gitFacade,
            inbox,
            revertTask,
        };
    }

    /**
     * A merged promotion row, ready for verification.
     *
     * Each gets its own `laneKey`: slice AI's UNIQUE `(workId, rung,
     * laneKey)` index is REAL in this harness, and every terminal
     * promotion writes `'<state>:<id>'` precisely so two of them do not
     * collide.
     */
    let seedSeq = 0;
    async function seed(overrides: Partial<ReleasePromotion> = {}): Promise<ReleasePromotion> {
        seedSeq += 1;
        return rows.save(
            rows.create({
                userId: USER,
                workId: WORK,
                taskId: 'task-1',
                rung: 'stage-to-main',
                headBranch: 'stage',
                baseBranch: 'main',
                headSha: HEAD,
                prNumber: 42,
                prUrl: 'https://github.com/ever-works/ever-works/pull/42',
                state: 'merged',
                laneKey: `merged:seed-${seedSeq}`,
                gateWorkflow: 'promotion-gate.yml',
                organizationId: ORG,
                verifyAttempts: 0,
                verifyStreak: 0,
                ...overrides,
            }),
        );
    }

    async function reload(id: string): Promise<ReleasePromotion> {
        const row = await rows.findOne({ where: { id } });
        if (!row) throw new Error(`promotion ${id} vanished`);
        return row;
    }

    const past = new Date('2026-09-06T00:00:00.000Z');
    const now = new Date('2026-09-06T12:00:00.000Z');

    // ── Starting ──────────────────────────────────────────────────────

    describe('onPromotionMerged', () => {
        it('holds the deployment to the BASE branch tip, not the promotion head', async () => {
            // THE artefact identity. Merging `stage -> main` produces a new
            // commit on `main`; `headSha` is the branch that was merged FROM
            // and will never be what gets built and served. A verification
            // that expected `headSha` would report "not rolled out" for ever.
            const { service } = build();
            const row = await seed();

            await service.onPromotionMerged(row, makeTask() as never);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('awaiting-rollout');
            expect(stored.verifyExpectedSha).toBe(MERGED);
            expect(stored.verifyExpectedSha).not.toBe(HEAD);
        });

        it('points at the environment the RUNG deployed, not at production by default', async () => {
            // `develop -> stage` deploys STAGE. Checking production would
            // pass against a deployment this promotion never touched — the
            // "wrong URL" hazard in its most plausible form.
            const { service } = build({
                branches: [
                    { name: 'develop', commit: HEAD },
                    { name: 'stage', commit: MERGED },
                    { name: 'main', commit: 'cccccccccccccccccccccccccccccccccccccccc' },
                ],
            });
            const row = await seed({
                rung: 'develop-to-stage',
                headBranch: 'develop',
                baseBranch: 'stage',
            });

            await service.onPromotionMerged(row, makeTask() as never);

            const stored = await reload(row.id);
            expect(stored.verifyTargetUrl).toBe(STAGING.versionUrl);
            expect(stored.verifyTargetUrl).not.toBe(PRODUCTION.versionUrl);
            expect(stored.verifyExpectedSha).toBe(MERGED);
        });

        it('sets both bounds, so the verification can never run for ever', async () => {
            const { service } = build();
            const row = await seed();

            await service.onPromotionMerged(row, makeTask() as never);

            const stored = await reload(row.id);
            expect(stored.verifyDeadlineAt).toBeTruthy();
            expect(new Date(stored.verifyDeadlineAt!).getTime()).toBeGreaterThan(Date.now());
            expect(stored.verifyAttempts).toBe(0);
        });

        it('records `unsupported` — not a pass — when the environment has no target', async () => {
            const { service, inbox } = build({ work: { releaseVerification: null } });
            const row = await seed();

            await service.onPromotionMerged(row, makeTask() as never);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('unsupported');
            expect(stored.verifyState).not.toBe('passed');
            // The human is TOLD. "Nobody configured a URL" must not look
            // like silence, which a reader rounds up to "fine".
            expect(inbox.notice).toHaveBeenCalledTimes(1);
            expect(inbox.notice.mock.calls[0][1].title).toContain('NOT VERIFIED');
        });

        it('records `unsupported` when only the OTHER environment is configured', async () => {
            const { service } = build({ work: { releaseVerification: { staging: STAGING } } });
            const row = await seed({ rung: 'stage-to-main', baseBranch: 'main' });

            await service.onPromotionMerged(row, makeTask() as never);

            expect((await reload(row.id)).verifyState).toBe('unsupported');
        });

        it.each([
            ['the base branch tip cannot be read', { listBranchesError: new Error('403') }],
            [
                'the base branch is missing from the listing',
                { branches: [{ name: 'develop', commit: HEAD }] },
            ],
            ['no git provider is wired', { noGitFacade: true }],
            ['no fleet job runtime is wired', { noFleet: true }],
            ['the Work has vanished', { work: null }],
        ])('records `inconclusive` when %s', async (_label, opts) => {
            const { service } = build(opts as never);
            const row = await seed();

            await service.onPromotionMerged(row, makeTask() as never);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('inconclusive');
            expect(stored.verifyDetail).toBeTruthy();
            // An inconclusive start offers nothing.
            expect(stored.revertTaskId).toBeNull();
        });

        it('refuses when the Work has changed hands under the promotion', async () => {
            // Everything downstream — the URL to load, the credentials to
            // read the branch with, the owner whose fleet runs the browser
            // — would otherwise be taken from one party for a promotion
            // belonging to another.
            const { service, inbox } = build({ work: { userId: OTHER_USER } });
            const row = await seed({ userId: USER });

            await service.onPromotionMerged(row, makeTask() as never);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('inconclusive');
            expect(stored.verifyTargetUrl).toBeNull();
            expect(inbox.notice.mock.calls[0][1].title).toContain('NOT VERIFIED');
        });

        it('starts exactly once, however many times it is called', async () => {
            // Two API replicas can both observe the merge before either
            // frees the lane. `WHERE verifyState IS NULL` decides.
            //
            // The second caller is a SEPARATE service whose git provider
            // answers a DIFFERENT commit. That is what makes this test able
            // to fail: reading the row before the second call and asserting
            // the sha is still MERGED — as this did — is satisfied just as
            // well by a duplicate begin() rewriting the identical values, so
            // deleting `.andWhere('verifyState IS NULL')` from
            // `beginVerification` left it green.
            const { service, inbox } = build();
            const row = await seed();
            const LATER = 'dddddddddddddddddddddddddddddddddddddddd';
            const second = build({
                branches: [
                    { name: 'develop', commit: HEAD },
                    { name: 'stage', commit: HEAD },
                    { name: 'main', commit: LATER },
                ],
            });

            await service.onPromotionMerged(row, makeTask() as never);
            // A second caller holding a STALE row (verifyState still null).
            await second.service.onPromotionMerged(await seedStale(row), makeTask() as never);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('awaiting-rollout');
            expect(stored.verifyExpectedSha).toBe(MERGED);
            expect(stored.verifyExpectedSha).not.toBe(LATER);
            expect(inbox.notice).not.toHaveBeenCalled();
            expect(second.inbox.notice).not.toHaveBeenCalled();
        });

        it('never throws — the caller is a best-effort PR-status refresh', async () => {
            const { service, works } = build();
            works.findById.mockRejectedValue(new Error('database is on fire'));
            const row = await seed();

            await expect(
                service.onPromotionMerged(row, makeTask() as never),
            ).resolves.toBeUndefined();
        });

        /** The same row as the caller would still be holding: state not yet read back. */
        async function seedStale(row: ReleasePromotion): Promise<ReleasePromotion> {
            return { ...row, verifyState: null } as ReleasePromotion;
        }
    });

    // ── The sweep ─────────────────────────────────────────────────────

    describe('enqueueDueChecks', () => {
        it('produces a browser-check against the version URL, expecting the promoted commit', async () => {
            // THE producer. Before this slice nothing on the platform ever
            // enqueued a `browser-check` at all.
            const { service, fleet } = build();
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            const summary = await service.enqueueDueChecks(now);

            expect(summary.enqueued).toBe(1);
            expect(fleet.enqueue).toHaveBeenCalledTimes(1);
            const input = fleet.enqueue.mock.calls[0][0];
            expect(input.kind).toBe('browser-check');
            expect(input.payload.url).toBe(PRODUCTION.versionUrl);
            expect(input.payload.expectText).toBe(MERGED.slice(0, 12));
            expect(input.requiredCapabilities).toEqual([FLEET_BROWSER_CAPABILITY]);
            // ONE attempt: the fleet's own reclaim would otherwise retry
            // each probe underneath this file's attempt ladder, multiplying
            // two independent budgets together.
            expect(input.maxAttempts).toBe(1);
            expect(input.idempotencyKey).toBe(`release-verify:${row.id}:1`);
            expect((await reload(row.id)).verifyJobId).toBe('job-1');
        });

        it('takes the owner and scope from the ROW, never from a request or a payload', async () => {
            // There is no request anywhere on this path — the sweep is a
            // cron — and the browser check runs on the OWNER's fleet, so
            // getting this wrong would run somebody else's job on their PC.
            const { service, fleet } = build({
                work: { organizationId: 'a-different-org' },
            });
            await seed({
                userId: USER,
                organizationId: ORG,
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.enqueueDueChecks(now);

            const input = fleet.enqueue.mock.calls[0][0];
            expect(input.userId).toBe(USER);
            // The promotion's scope, not the Work's current one.
            expect(input.organizationId).toBe(ORG);
        });

        it('checks the APP url once the state says the rollout is confirmed', async () => {
            const { service, fleet } = build();
            await seed({
                verifyState: 'checking-app',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.enqueueDueChecks(now);

            const input = fleet.enqueue.mock.calls[0][0];
            expect(input.payload.url).toBe(PRODUCTION.appUrl);
            expect(input.payload.expectText).toBe(PRODUCTION.appExpectText);
        });

        it('re-checks the VERSION url when confirming a failure', async () => {
            // Not "is the app still broken" — we know that. "Can this node
            // reach the environment at all, and is it still serving what we
            // promoted." A no there is evidence about the node.
            const { service, fleet } = build();
            await seed({
                verifyState: 'confirming-failure',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.enqueueDueChecks(now);

            expect(fleet.enqueue.mock.calls[0][0].payload.url).toBe(PRODUCTION.versionUrl);
        });

        it('does not enqueue a second check while one is in flight', async () => {
            // At most one browser is ever pointed at one environment for one
            // promotion, however many replicas tick at the same second.
            const { service, fleet } = build();
            await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyJobId: 'job-already-out',
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.enqueueDueChecks(now);

            expect(fleet.enqueue).not.toHaveBeenCalled();
        });

        it('leaves a claimed row VISIBLE to the sweep, so its deadline can still be enforced', async () => {
            // The sweep's WHERE clause is `verifyRetryAt <= now`. A claim
            // that nulled it would take the row out of the only query that
            // can expire it, and a browser job that never came back would
            // hold the promotion open for ever. Asserted against the REAL
            // claim, because hand-setting the columns is how a test comes to
            // pass for a reason production does not provide.
            const { service } = build();
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.enqueueDueChecks(now);

            const claimed = await reload(row.id);
            expect(claimed.verifyJobId).toBe('job-1');
            expect(claimed.verifyRetryAt).not.toBeNull();
            // And it really is still selectable by the sweep's own query.
            const laterStill = new Date(now.getTime() + 3 * RELEASE_VERIFY_ATTEMPT_INTERVAL_MS);
            const due = await promotions.findVerificationsDue(laterStill);
            expect(due.map((p) => p.id)).toContain(row.id);
        });

        it('settles a wedged verification on its deadline EVEN with a check in flight', async () => {
            // THE anti-wedge, driven through the real claim rather than by
            // hand: enqueue a check, let the deadline pass while the node
            // never reports, and sweep again.
            const { service, fleet, inbox } = build();
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                // Enough clock for the first sweep to claim an attempt.
                verifyDeadlineAt: new Date(now.getTime() + 60_000),
            });

            await service.enqueueDueChecks(now);
            expect((await reload(row.id)).verifyJobId).toBe('job-1');
            fleet.enqueue.mockClear();

            // Later. The job never came back.
            const afterDeadline = new Date(now.getTime() + 3 * RELEASE_VERIFY_ATTEMPT_INTERVAL_MS);
            const summary = await service.enqueueDueChecks(afterDeadline);

            expect(summary.settled).toBe(1);
            // And it did NOT put a second browser on the environment.
            expect(fleet.enqueue).not.toHaveBeenCalled();
            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('inconclusive');
            expect(stored.verifyRetryAt).toBeNull();
            expect(stored.verifyJobId).toBeNull();
            expect(stored.revertTaskId).toBeNull();
            expect(inbox.notice.mock.calls[0][1].title).toContain('NOT VERIFIED');
        });

        it('does not enqueue a second check on a re-sweep while the first is still out', async () => {
            const { service, fleet } = build();
            await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 86_400_000),
            });

            await service.enqueueDueChecks(now);
            const laterStill = new Date(now.getTime() + 3 * RELEASE_VERIFY_ATTEMPT_INTERVAL_MS);
            await service.enqueueDueChecks(laterStill);

            expect(fleet.enqueue).toHaveBeenCalledTimes(1);
        });

        it('settles on the ATTEMPT cap even with time left on the clock', async () => {
            const { service, fleet } = build();
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyAttempts: RELEASE_VERIFY_MAX_ATTEMPTS,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 86_400_000),
            });

            await service.enqueueDueChecks(now);

            expect(fleet.enqueue).not.toHaveBeenCalled();
            expect((await reload(row.id)).verifyState).toBe('inconclusive');
        });

        it('stops probing when the Work changes hands mid-verification', async () => {
            const { service, fleet } = build({ work: { userId: OTHER_USER } });
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.enqueueDueChecks(now);

            expect(fleet.enqueue).not.toHaveBeenCalled();
            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('inconclusive');
            expect(stored.revertTaskId).toBeNull();
        });

        it('settles `inconclusive` when the target is removed underneath a running verification', async () => {
            const { service } = build({ work: { releaseVerification: null } });
            const row = await seed({
                verifyState: 'checking-app',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.enqueueDueChecks(now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('inconclusive');
            expect(stored.revertTaskId).toBeNull();
        });

        it('never looks at a settled verification again', async () => {
            const { service, fleet } = build();
            for (const state of ['passed', 'failed', 'inconclusive', 'unsupported'] as const) {
                await rows.clear();
                await seed({
                    verifyState: state,
                    verifyExpectedSha: MERGED,
                    // Even with a due-looking retry stamp, which a settled
                    // row should never carry.
                    verifyRetryAt: past,
                    verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
                });
                const summary = await service.enqueueDueChecks(now);
                expect(summary.considered).toBe(0);
            }
            expect(fleet.enqueue).not.toHaveBeenCalled();
        });

        it('leaves the row due when the fleet refuses the job', async () => {
            const { service } = build({ enqueueError: new Error('queue down') });
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            const summary = await service.enqueueDueChecks(now);

            expect(summary.enqueued).toBe(0);
            const stored = await reload(row.id);
            // Still due, still no attempt burned, and the deadline still
            // ends it if the fleet stays broken.
            expect(stored.verifyAttempts).toBe(0);
            expect(stored.verifyJobId).toBeNull();
            expect(stored.verifyState).toBe('awaiting-rollout');
        });

        it('does not let one bad row stop the sweep for the rest', async () => {
            const { service, works, fleet } = build();
            const bad = await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: new Date(past.getTime() - 1000),
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });
            await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyRetryAt: past,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });
            works.findById.mockImplementation((id: string) =>
                id === WORK && works.findById.mock.calls.length === 1
                    ? Promise.reject(new Error('transient'))
                    : Promise.resolve(makeWork()),
            );

            const summary = await service.enqueueDueChecks(now);

            expect(summary.considered).toBe(2);
            expect(fleet.enqueue).toHaveBeenCalledTimes(1);
            // And the row that threw is left exactly as the per-row catch
            // promises: STILL DUE, no attempt burned, nothing settled. This
            // used to be `expect(bad).toBeTruthy()` — a tautology on a value
            // `seed()` had just returned, which could not fail for any
            // change to the code under test. A catch block that settled the
            // row, or nulled its `verifyRetryAt` so it dropped out of
            // `findVerificationsDue` for ever, passed the old assertion.
            const failed = await reload(bad.id);
            expect(failed.verifyState).toBe('awaiting-rollout');
            expect(failed.verifyAttempts).toBe(0);
            expect(failed.verifyJobId).toBeNull();
            expect(failed.verifyRetryAt).not.toBeNull();
            expect((await promotions.findVerificationsDue(now)).map((row) => row.id)).toContain(
                bad.id,
            );
        });

        // ── The job handed back is not always the job we asked for ────

        describe('the job `enqueue` returns is checked before it is recorded', () => {
            /**
             * `FleetJobService.enqueue` short-circuits on the idempotency
             * key with `FleetJobRepository.findByIdempotencyKey`, a bare
             * `findOne({ where: { idempotencyKey } })` — no status filter,
             * no owner scope, no kind check. Every case below is a job it
             * would hand back for a key this lane derived, and none of them
             * is a check this lane can read a verdict from.
             *
             * In every one the attempt is BURNED rather than bound: the next
             * sweep derives attempt N+1, therefore a different key,
             * therefore a genuinely new job. Binding instead would wedge the
             * row for its whole eight-hour budget, because `sweepOne` will
             * not enqueue while `verifyJobId` is set.
             */
            async function dueRow() {
                return seed({
                    verifyState: 'awaiting-rollout',
                    verifyExpectedSha: MERGED,
                    verifyRetryAt: past,
                    verifyDeadlineAt: new Date(now.getTime() + 86_400_000),
                });
            }

            it.each([
                [
                    'it has ALREADY SETTLED, so no completion will ever arrive',
                    {
                        enqueueReturns: (input: Record<string, unknown>) => ({
                            id: 'job-done',
                            kind: 'browser-check',
                            status: 'done',
                            payload: input.payload,
                        }),
                    },
                ],
                [
                    'it settled FAILED before we ever saw it',
                    {
                        enqueueReturns: (input: Record<string, unknown>) => ({
                            id: 'job-failed',
                            kind: 'browser-check',
                            status: 'failed',
                            payload: input.payload,
                        }),
                    },
                ],
                [
                    'it is a different KIND of job',
                    {
                        enqueueReturns: (input: Record<string, unknown>) => ({
                            id: 'job-other',
                            kind: 'agent-task',
                            status: 'queued',
                            payload: input.payload,
                        }),
                    },
                ],
                [
                    'its payload points somewhere this lane never chose',
                    {
                        enqueueReturns: () => ({
                            id: 'job-evil',
                            kind: 'browser-check',
                            status: 'queued',
                            payload: {
                                url: 'https://attacker.example.com/page',
                                expectText: MERGED.slice(0, 12),
                            },
                        }),
                    },
                ],
                ['it belongs to somebody else', { enqueueOwner: OTHER_USER }],
            ])('refuses a job because %s', async (_label, opts) => {
                const { service } = build(opts as never);
                const row = await dueRow();

                const summary = await service.enqueueDueChecks(now);

                expect(summary.enqueued).toBe(0);
                const stored = await reload(row.id);
                // NOT bound — this is the whole point. A bound row is deaf
                // to the sweep until its deadline.
                expect(stored.verifyJobId).toBeNull();
                // But the attempt IS burned, so the next key differs.
                expect(stored.verifyAttempts).toBe(1);
                expect(stored.verifyState).toBe('awaiting-rollout');
                expect(stored.verifyDetail).toContain('Attempt 1 could not be started');
            });

            it('re-enqueues under a DIFFERENT key on the next pass, so it cannot loop', async () => {
                const { service, fleet } = build({
                    enqueueReturns: (input: Record<string, unknown>, seq: number) => ({
                        id: `job-${seq}`,
                        kind: 'browser-check',
                        // Always settled: the pathological case.
                        status: 'done',
                        payload: input.payload,
                    }),
                });
                await dueRow();

                await service.enqueueDueChecks(now);
                await service.enqueueDueChecks(new Date(now.getTime() + 60_000));

                expect(fleet.enqueue.mock.calls.map((call) => call[0].idempotencyKey)).toEqual([
                    expect.stringMatching(/:1$/),
                    expect.stringMatching(/:2$/),
                ]);
            });

            it('still bounds itself — a fleet that only returns settled jobs runs out of attempts', async () => {
                const { service } = build({
                    enqueueReturns: (input: Record<string, unknown>, seq: number) => ({
                        id: `job-${seq}`,
                        kind: 'browser-check',
                        status: 'done',
                        payload: input.payload,
                    }),
                });
                const row = await seed({
                    verifyState: 'awaiting-rollout',
                    verifyExpectedSha: MERGED,
                    verifyAttempts: RELEASE_VERIFY_MAX_ATTEMPTS - 1,
                    verifyRetryAt: past,
                    verifyDeadlineAt: new Date(now.getTime() + 86_400_000),
                });

                await service.enqueueDueChecks(now);
                await service.enqueueDueChecks(new Date(now.getTime() + 60_000));

                expect((await reload(row.id)).verifyState).toBe('inconclusive');
            });

            it('binds a job that IS the check it asked for', async () => {
                // The negative control for every refusal above.
                const { service } = build();
                const row = await dueRow();

                await service.enqueueDueChecks(now);

                const stored = await reload(row.id);
                expect(stored.verifyJobId).toBe('job-1');
                expect(stored.verifyAttempts).toBe(1);
            });
        });

        // ── A check that settled with nobody listening ────────────────

        describe('an in-flight check is reconciled, not assumed', () => {
            /**
             * `onBrowserCheckCompleted` and the api-side listener both
             * swallow their own failures by contract, so one transient
             * database error — or an API replica restarting between the
             * fleet's write and the `@OnEvent` handler — drops a result for
             * ever. The job is terminal, `verifyJobId` stays set, and the
             * sweep used to answer `skipped` every five minutes until the
             * eight-hour deadline settled the row `inconclusive` for a
             * reason that never happened.
             */
            function jobRows(job: Record<string, unknown>) {
                return new Map<string, Record<string, unknown>>([
                    ['job-out', { id: 'job-out', kind: 'browser-check', userId: USER, ...job }],
                ]);
            }

            async function inFlight(job: Record<string, unknown>) {
                const built = build({ fleetJobRows: jobRows(job) });
                const row = await seed({
                    verifyState: 'awaiting-rollout',
                    verifyExpectedSha: MERGED,
                    verifyJobId: 'job-out',
                    verifyAttempts: 1,
                    verifyStreak: RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS - 1,
                    verifyRetryAt: past,
                    verifyDeadlineAt: new Date(now.getTime() + 86_400_000),
                });
                return { ...built, row };
            }

            it('reads a dropped PASS off the job row and advances the verification', async () => {
                const { service, row } = await inFlight({
                    status: 'done',
                    result: { ok: true, title: 'version' },
                });

                const summary = await service.enqueueDueChecks(now);

                expect(summary.recovered).toBe(1);
                const stored = await reload(row.id);
                // The streak completed, so the rollout is confirmed and the
                // lane moved on — exactly as the listener would have done.
                expect(stored.verifyState).toBe('checking-app');
                expect(stored.verifyJobId).toBeNull();
            });

            it('reads a dropped FAILURE off the job row without calling it a pass', async () => {
                const { service, row } = await inFlight({
                    status: 'failed',
                    error: 'Browser exited with code 1',
                });

                await service.enqueueDueChecks(now);

                const stored = await reload(row.id);
                expect(stored.verifyState).toBe('awaiting-rollout');
                // Not a pass: the streak resets.
                expect(stored.verifyStreak).toBe(0);
                expect(stored.verifyJobId).toBeNull();
                expect(stored.verifyDetail).toContain('Browser exited with code 1');
            });

            it.each([
                ['a done job with no result', { status: 'done', result: null }],
                [
                    'a done job whose ok is the STRING true',
                    { status: 'done', result: { ok: 'true' } },
                ],
                ['a done job whose ok is 1', { status: 'done', result: { ok: 1 } }],
            ])('does not treat %s as a pass', async (_label, job) => {
                const { service, row } = await inFlight(job);

                await service.enqueueDueChecks(now);

                expect((await reload(row.id)).verifyStreak).toBe(0);
            });

            it('does not touch a check that is still running — it reschedules it', async () => {
                // The pair: recovery must not steal a job a node is holding.
                const { service, row } = await inFlight({ status: 'running', result: null });

                const summary = await service.enqueueDueChecks(now);

                expect(summary.recovered).toBe(0);
                const stored = await reload(row.id);
                expect(stored.verifyJobId).toBe('job-out');
                expect(stored.verifyStreak).toBe(RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS - 1);
            });

            it('pushes a still-running row DOWN the sweep queue, so it cannot starve other owners', async () => {
                // `findVerificationsDue` pages 25 rows platform-wide ordered
                // `verifyRetryAt ASC`. A skipped in-flight row that was never
                // rescheduled stayed permanently `verifyRetryAt <= now` and
                // drifted further into the past on every pass, so 25 of them
                // filled the page for ever and no other tenant's promotion
                // was enqueued or expired again.
                const { service, row } = await inFlight({ status: 'queued', result: null });

                await service.enqueueDueChecks(now);

                const stored = await reload(row.id);
                expect(new Date(stored.verifyRetryAt!).getTime()).toBe(
                    now.getTime() + RELEASE_VERIFY_ATTEMPT_INTERVAL_MS,
                );
                // Not due any more at `now`, so it yields its slot.
                expect((await promotions.findVerificationsDue(now)).map((r) => r.id)).not.toContain(
                    row.id,
                );
            });

            it('still enforces the DEADLINE on a row whose check never comes back', async () => {
                // Rescheduling must not become a way to postpone the bound.
                const { service } = build({ fleetJobRows: jobRows({ status: 'running' }) });
                const row = await seed({
                    verifyState: 'awaiting-rollout',
                    verifyExpectedSha: MERGED,
                    verifyJobId: 'job-out',
                    verifyAttempts: 1,
                    verifyRetryAt: past,
                    verifyDeadlineAt: new Date(now.getTime() - 1),
                });

                await service.enqueueDueChecks(now);

                expect((await reload(row.id)).verifyState).toBe('inconclusive');
            });

            it('lets go of a binding to a job that does not exist at all', async () => {
                const { service } = build({
                    fleetJobRows: new Map<string, Record<string, unknown>>(),
                });
                const row = await seed({
                    verifyState: 'awaiting-rollout',
                    verifyExpectedSha: MERGED,
                    verifyJobId: 'job-vanished',
                    verifyAttempts: 1,
                    verifyRetryAt: past,
                    verifyDeadlineAt: new Date(now.getTime() + 86_400_000),
                });

                await service.enqueueDueChecks(now);

                const stored = await reload(row.id);
                expect(stored.verifyJobId).toBeNull();
                expect(stored.verifyAttempts).toBe(2);
                expect(stored.verifyState).toBe('awaiting-rollout');
            });

            it('degrades to rescheduling — never to inventing a verdict — with no job reader bound', async () => {
                const { service } = build({ noFleetJobs: true });
                const row = await seed({
                    verifyState: 'awaiting-rollout',
                    verifyExpectedSha: MERGED,
                    verifyJobId: 'job-out',
                    verifyAttempts: 1,
                    verifyStreak: RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS - 1,
                    verifyRetryAt: past,
                    verifyDeadlineAt: new Date(now.getTime() + 86_400_000),
                });

                await service.enqueueDueChecks(now);

                const stored = await reload(row.id);
                expect(stored.verifyJobId).toBe('job-out');
                expect(stored.verifyStreak).toBe(RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS - 1);
                expect(new Date(stored.verifyRetryAt!).getTime()).toBe(
                    now.getTime() + RELEASE_VERIFY_ATTEMPT_INTERVAL_MS,
                );
            });
        });
    });

    // ── Reading a verdict ─────────────────────────────────────────────

    describe('onBrowserCheckCompleted — the rollout phase', () => {
        async function rollingOut(overrides: Partial<ReleasePromotion> = {}) {
            return seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyJobId: 'job-1',
                verifyAttempts: 1,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
                ...overrides,
            });
        }

        it('does not advance on ONE sighting of the promoted commit', async () => {
            // ArgoCD replaces pods gradually, so one sample is a coin flip.
            const { service } = build();
            const row = await rollingOut();

            await service.onBrowserCheckCompleted('job-1', true, 'ok', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('awaiting-rollout');
            expect(stored.verifyStreak).toBe(1);
            expect(RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS).toBeGreaterThan(1);
        });

        it('advances to the app check after consecutive sightings', async () => {
            const { service } = build();
            const row = await rollingOut({
                verifyStreak: RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS - 1,
            });

            await service.onBrowserCheckCompleted('job-1', true, 'ok', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('checking-app');
            expect(stored.verifyStreak).toBe(0);
        });

        it('resets the streak on a miss — the confirmations must be CONSECUTIVE', async () => {
            const { service } = build();
            const row = await rollingOut({
                verifyStreak: RELEASE_VERIFY_ROLLOUT_CONFIRMATIONS - 1,
            });

            await service.onBrowserCheckCompleted('job-1', false, 'old sha', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('awaiting-rollout');
            expect(stored.verifyStreak).toBe(0);
        });

        it('treats a miss as WAITING, not as a failed release', async () => {
            // For a production release the expected answer for the first
            // three or four hours is "the old build is still serving".
            const { service, inbox } = build();
            const row = await rollingOut();

            await service.onBrowserCheckCompleted('job-1', false, 'old sha', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).not.toBe('failed');
            expect(stored.revertTaskId).toBeNull();
            expect(inbox.notice).not.toHaveBeenCalled();
            expect(new Date(stored.verifyRetryAt!).getTime()).toBe(
                now.getTime() + RELEASE_VERIFY_ATTEMPT_INTERVAL_MS,
            );
        });

        it('a rollout that never arrives is INCONCLUSIVE, never failed, and offers nothing', async () => {
            // The single most important refusal in the slice: a deploy that
            // did not happen is not a broken release, and must not put a
            // revert in front of a human.
            const { service, tasksService, inbox } = build();
            const row = await rollingOut({ verifyDeadlineAt: past });

            await service.onBrowserCheckCompleted('job-1', false, 'still the old sha', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('inconclusive');
            expect(stored.revertTaskId).toBeNull();
            expect(tasksService.create).not.toHaveBeenCalled();
            expect(inbox.notice).toHaveBeenCalledTimes(1);
            expect(inbox.notice.mock.calls[0][1].body).toContain('No revert has been offered');
        });
    });

    describe('onBrowserCheckCompleted — the app phase', () => {
        async function checkingApp(overrides: Partial<ReleasePromotion> = {}) {
            return seed({
                verifyState: 'checking-app',
                verifyExpectedSha: MERGED,
                verifyJobId: 'job-1',
                verifyAttempts: 4,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
                ...overrides,
            });
        }

        it('passes on a rendering app, and offers no revert', async () => {
            const { service, tasksService, inbox } = build();
            const row = await checkingApp();

            await service.onBrowserCheckCompleted('job-1', true, 'Page loaded', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('passed');
            expect(stored.verifyRetryAt).toBeNull();
            expect(stored.revertTaskId).toBeNull();
            expect(tasksService.create).not.toHaveBeenCalled();
            expect(inbox.notice.mock.calls[0][1].title).toContain('VERIFIED');
        });

        it('does NOT claim the app deployment rolled out when the app probe cannot prove it', async () => {
            // The artefact identity is established at `versionUrl` only.
            // The app phase then reads a DIFFERENT url with whatever
            // expectation the operator configured, and the shipped
            // recommendation is a fixed `"status":"OK"` health string that
            // an old bundle answers identically. So a `stage -> main`
            // promotion whose API image rolled out and whose WEB deployment
            // failed its rollout entirely used to be reported as
            // "Deployment VERIFIED … The app rendered as expected. Nothing
            // further is required."
            const { service, inbox, chat } = build();
            const row = await checkingApp();

            await service.onBrowserCheckCompleted('job-1', true, 'Page loaded', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('passed');
            const detail = stored.verifyDetail ?? '';
            expect(detail).toContain('does NOT prove the app deployment itself rolled out');
            expect(detail).toContain(new URL(PRODUCTION.appUrl).hostname);
            expect(detail).not.toContain('The app rendered the promoted commit');
            // And the founder is not told to stop looking.
            const narrated = chat.create.mock.calls
                .map((call: Array<{ body: string }>) => call[0].body)
                .join(' ');
            expect(narrated).not.toContain('Nothing further is required');
            expect(narrated).toContain('Confirm the app deployment itself by hand');
            expect(inbox.notice.mock.calls[0][1].body).toContain(
                'does NOT prove the app deployment itself rolled out',
            );
        });

        it('DOES claim it when the app expectation carries the promoted commit', async () => {
            // The positive control, and the configuration the runbook now
            // recommends: point the app probe at a page that renders the
            // build sha and the app half becomes artefact-aware too.
            const { service, chat } = build({
                work: {
                    releaseVerification: {
                        production: {
                            ...PRODUCTION,
                            appUrl: 'https://app.ever.works/build-info',
                            appExpectText: MERGED.slice(0, 12),
                        },
                    },
                },
            });
            const row = await checkingApp();

            await service.onBrowserCheckCompleted('job-1', true, 'Page loaded', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('passed');
            expect(stored.verifyDetail).toContain('The app rendered the promoted commit');
            const narrated = chat.create.mock.calls
                .map((call: Array<{ body: string }>) => call[0].body)
                .join(' ');
            expect(narrated).toContain('Nothing further is required');
        });

        it('claims the WEAKER thing when the target can no longer be read', async () => {
            // Fails to the conservative answer rather than throwing: a
            // verdict that cannot check what it measured must not assert the
            // stronger claim.
            const { service, works } = build();
            const row = await checkingApp();
            works.findById.mockRejectedValue(new Error('gone'));

            await service.onBrowserCheckCompleted('job-1', true, 'Page loaded', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('passed');
            expect(stored.verifyDetail).toContain('does NOT prove the app deployment itself');
        });

        it('does not conclude anything on ONE failed page load', async () => {
            const { service } = build();
            const row = await checkingApp();

            await service.onBrowserCheckCompleted('job-1', false, 'expected text missing', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('checking-app');
            expect(stored.verifyStreak).toBe(1);
            expect(stored.revertTaskId).toBeNull();
        });

        it('goes to CONFIRMING, not to failed, after a full failure streak', async () => {
            // "The app is broken" and "this node lost the internet" are the
            // same browser result. The lane goes and asks before it speaks.
            const { service, tasksService } = build();
            const row = await checkingApp({
                verifyStreak: RELEASE_VERIFY_FAILURE_CONFIRMATIONS - 1,
            });

            await service.onBrowserCheckCompleted('job-1', false, 'still down', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('confirming-failure');
            expect(stored.verifyState).not.toBe('failed');
            expect(tasksService.create).not.toHaveBeenCalled();
        });

        it('passes rather than reverting when a flapping app comes back green', async () => {
            // THE flap. Reverting a release that is currently serving pages
            // on the strength of an earlier blip is the failure this
            // ordering exists to prevent — but the human is told it was not
            // clean.
            const { service } = build();
            const row = await checkingApp({
                verifyStreak: RELEASE_VERIFY_FAILURE_CONFIRMATIONS - 1,
                verifyAttempts: 9,
            });

            await service.onBrowserCheckCompleted('job-1', true, 'Page loaded', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('passed');
            expect(stored.verifyDetail).toContain('not clean');
            expect(stored.revertTaskId).toBeNull();
        });

        it('does not call a slow-but-clean production rollout "not clean"', async () => {
            // Waiting hours for the build lane is the NORMAL case on this
            // repository, so a warning keyed on total attempts would fire on
            // every healthy production release and stop meaning anything.
            const { service } = build();
            const row = await checkingApp({ verifyStreak: 0, verifyAttempts: 30 });

            await service.onBrowserCheckCompleted('job-1', true, 'Page loaded', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('passed');
            expect(stored.verifyDetail).not.toContain('not clean');
        });

        it('is INCONCLUSIVE, not failed, if the budget runs out mid-streak', async () => {
            const { service, tasksService } = build();
            const row = await checkingApp({ verifyDeadlineAt: past });

            await service.onBrowserCheckCompleted('job-1', false, 'down', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('inconclusive');
            expect(tasksService.create).not.toHaveBeenCalled();
        });
    });

    describe('onBrowserCheckCompleted — the confirmation', () => {
        async function confirming(overrides: Partial<ReleasePromotion> = {}) {
            return seed({
                verifyState: 'confirming-failure',
                verifyExpectedSha: MERGED,
                verifyJobId: 'job-1',
                verifyAttempts: 8,
                verifyTargetUrl: PRODUCTION.versionUrl,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
                ...overrides,
            });
        }

        it('fails — and offers a revert — only when the environment is confirmed reachable', async () => {
            const { service, tasksService, inbox } = build();
            const row = await confirming();

            await service.onBrowserCheckCompleted('job-1', true, 'version ok', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('failed');
            expect(stored.revertTaskId).toBe('revert-task-1');
            expect(stored.revertOfferedAt).toBeTruthy();
            expect(tasksService.create).toHaveBeenCalledTimes(1);
            // Two notices: the verdict, then the revert offer.
            expect(inbox.notice).toHaveBeenCalledTimes(2);
        });

        it('is INCONCLUSIVE with NO offer when the node cannot reach the environment either', async () => {
            // THE flaky-node refusal. If the version endpoint does not
            // answer, the failing app checks are evidence about this node's
            // network, not about the release.
            const { service, tasksService, inbox } = build();
            const row = await confirming();

            await service.onBrowserCheckCompleted('job-1', false, 'connection refused', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('inconclusive');
            expect(stored.revertTaskId).toBeNull();
            expect(tasksService.create).not.toHaveBeenCalled();
            expect(inbox.notice).toHaveBeenCalledTimes(1);
            expect(inbox.notice.mock.calls[0][1].body).toContain('No revert has been offered');
        });
    });

    describe('onBrowserCheckCompleted — what it ignores', () => {
        it('ignores a job no promotion is pointing at', async () => {
            const { service } = build();
            const row = await seed({ verifyState: 'awaiting-rollout', verifyJobId: 'job-1' });

            await service.onBrowserCheckCompleted('somebody-elses-job', true, 'ok', now);

            expect((await reload(row.id)).verifyState).toBe('awaiting-rollout');
        });

        it('ignores a LATE report from a superseded job', async () => {
            // The row moved on (its deadline expired and the sweep settled
            // it, say). A stale completion must not resurrect it.
            const { service } = build();
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: MERGED,
                verifyJobId: 'job-2',
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.onBrowserCheckCompleted('job-1', true, 'ok', now);

            expect((await reload(row.id)).verifyStreak).toBe(0);
        });

        it('ignores a report for a verification that already settled', async () => {
            const { service } = build();
            const row = await seed({ verifyState: 'passed', verifyJobId: null });

            await service.onBrowserCheckCompleted('job-1', false, 'down', now);

            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('passed');
            expect(stored.revertTaskId).toBeNull();
        });

        it('never throws', async () => {
            const { service } = build();
            await seed({ verifyState: 'confirming-failure', verifyJobId: 'job-1' });

            await expect(
                service.onBrowserCheckCompleted('job-1', true, 'ok', new Date(Number.NaN)),
            ).resolves.toBeUndefined();
        });
    });

    // ── The revert OFFER ──────────────────────────────────────────────

    describe('the revert offer', () => {
        async function failThrough() {
            const built = build();
            const row = await seed({
                verifyState: 'confirming-failure',
                verifyExpectedSha: MERGED,
                verifyJobId: 'job-1',
                verifyTargetUrl: PRODUCTION.appUrl,
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });
            await built.service.onBrowserCheckCompleted('job-1', true, 'version ok', now);
            return { ...built, row };
        }

        it('files an INERT Task — in review, so nothing dispatches an agent against it', async () => {
            // `TaskGraphFanoutService` starts unblocked TODO Tasks. A revert
            // Task filed TODO would be a platform that reverts production by
            // itself the moment a check goes red.
            const { tasksService } = await failThrough();

            const input = tasksService.create.mock.calls[0][1];
            expect(input.status).toBe(TaskStatus.IN_REVIEW);
            expect(input.status).not.toBe(TaskStatus.TODO);
        });

        it('files it as an ORDINARY Task, with no promotion label — that is what breaks the cycle', async () => {
            // A revert Task carrying `release:promotion` would be picked up
            // by the promotion refresh and the promotion merge guard, and a
            // revert that opened a promotion would trigger another
            // verification which could offer another revert.
            const { tasksService } = await failThrough();

            const input = tasksService.create.mock.calls[0][1];
            expect(input.labels).toContain(RELEASE_REVERT_TASK_LABEL);
            expect(input.labels).not.toContain(PROMOTION_TASK_LABEL);
        });

        it('creates the Task for the promotion’s OWNER, from the row', async () => {
            const { tasksService } = await failThrough();

            expect(tasksService.create.mock.calls[0][0]).toBe(USER);
            expect(tasksService.create.mock.calls[0][1].createdById).toBe(USER);
        });

        it('carries the coordinates a human needs: the promotion PR and the commit', async () => {
            const { tasksService, row } = await failThrough();

            const description: string = tasksService.create.mock.calls[0][1].description;
            expect(description).toContain(row.prUrl);
            expect(description).toContain(MERGED);
            expect(description).toContain('main');
        });

        it('says, in the Task and in the Inbox, that nothing has been reverted', async () => {
            const { tasksService, inbox } = await failThrough();

            expect(tasksService.create.mock.calls[0][1].description).toContain(
                'Nothing has been reverted',
            );
            const revertNotice = inbox.notice.mock.calls[1][1];
            expect(revertNotice.body).toContain('NOTHING HAS BEEN REVERTED');
            // And it says what the human must decide.
            expect(revertNotice.body).toContain('Roll forward');
            expect(revertNotice.body).toContain('needs the same "Merge pull request" approval');
        });

        it('is offered at most ONCE, however many times the failure is observed', async () => {
            const { service, tasksService, row } = await failThrough();
            expect(tasksService.create).toHaveBeenCalledTimes(1);

            // A second observation against the settled row.
            await service.onBrowserCheckCompleted('job-1', true, 'version ok', now);

            expect(tasksService.create).toHaveBeenCalledTimes(1);
            expect((await reload(row.id)).revertTaskId).toBe('revert-task-1');
        });

        it('survives the Task write failing, without claiming an offer was made', async () => {
            const { service, tasksService, inbox, chat } = build({
                createTaskError: new Error('no'),
            });
            const row = await seed({
                verifyState: 'confirming-failure',
                verifyExpectedSha: MERGED,
                verifyJobId: 'job-1',
                verifyDeadlineAt: new Date(now.getTime() + 3_600_000),
            });

            await service.onBrowserCheckCompleted('job-1', true, 'version ok', now);

            const stored = await reload(row.id);
            // The verdict still stands; only the offer is missing.
            expect(stored.verifyState).toBe('failed');
            expect(stored.revertTaskId).toBeNull();
            // TWICE, not once: the first attempt carries the node's own
            // reading, which `TasksService.create` runs through
            // `assertNoSecrets` and can refuse for a token-shaped substring
            // in a browser error string; the retry drops the reading rather
            // than losing the whole offer. Both fail here.
            expect(tasksService.create).toHaveBeenCalledTimes(2);
            expect(tasksService.create.mock.calls[0][1].description).toContain(
                '- Reading: The environment is serving',
            );
            expect(tasksService.create.mock.calls[1][1].description).toContain(
                '- Reading: see the promotion Task thread',
            );

            // AND — the reason the ordering was changed — the human is not
            // told a revert is waiting for them. Before the slice-AJ review
            // the verdict was narrated before the offer was attempted, so
            // this said "a revert Task has been prepared and is waiting in
            // review" for a Task that did not exist, on a TERMINAL verdict
            // the sweep never revisits.
            const notice = inbox.notice.mock.calls[0][1];
            expect(notice.title).toContain('NO revert could be prepared');
            expect(notice.body).toContain('could NOT be filed');
            expect(notice.body).not.toContain('has been prepared and is waiting in review');
            const narrated = chat.create.mock.calls
                .map((call: Array<{ body: string }>) => call[0].body)
                .join(' ');
            expect(narrated).toContain('could NOT be prepared');
            expect(narrated).toContain('NOTHING HAS BEEN REVERTED');
        });

        it('files the offer BEFORE it narrates the verdict, so the notice can tell the truth', async () => {
            // The positive control for the test above: when the Task write
            // succeeds, the notice says so — and it can only say so because
            // `revertTaskId` is already on the row by the time it is built.
            const { inbox, row } = await failThrough();

            expect((await reload(row.id)).revertTaskId).toBe('revert-task-1');
            expect(inbox.notice.mock.calls[0][1].title).toContain('revert prepared');
            expect(inbox.notice.mock.calls[0][1].body).toContain(
                'has been prepared and is waiting in review',
            );
        });

        it('names BOTH hosts in the failure, because they are not the same origin', async () => {
            // `confirming-failure` re-probes the VERSION url to tell "the
            // app is broken" apart from "this node lost the internet" — and
            // that is a different origin from the one that failed. A bot
            // interstitial, an HTTP Basic wall or a proxy rule scoped to the
            // app host alone fails three app probes and is then "confirmed"
            // by a healthy version host. The person deciding on a revert is
            // told which origin produced which half of the evidence.
            const { row } = await failThrough();

            const detail = (await reload(row.id)).verifyDetail ?? '';
            expect(detail).toContain(new URL(PRODUCTION.appUrl).hostname);
            expect(detail).toContain(new URL(PRODUCTION.versionUrl).hostname);
            expect(detail).toContain('would look the same from this node');
        });
    });

    describe('the compare-and-set guards, exercised against the real table', () => {
        /**
         * Slice-AJ review. This file's header claimed every compare-and-set
         * that makes the lane safe across replicas was "EXERCISED rather
         * than mocked". It was not: four of the five `.andWhere` clauses
         * could be DELETED from `ReleasePromotionRepository` with all sixty
         * tests still green, because each one had an in-process guard in
         * front of it that satisfied the assertion on its own — `sweepOne`'s
         * `if (promotion.verifyJobId) return 'skipped'` stood in for the
         * attempt claim, `findByVerifyJobId` returning null stood in for the
         * result pin, and so on.
         *
         * These call the repository DIRECTLY, from a state the guard is
         * supposed to refuse, and assert both the boolean and that the row
         * did not move. Deleting any one clause fails one of them.
         */
        it('beginVerification refuses a row that already has a state', async () => {
            const row = await seed({ verifyState: 'awaiting-rollout', verifyExpectedSha: MERGED });

            const started = await promotions.beginVerification(row.id, {
                verifyState: 'awaiting-rollout',
                verifyExpectedSha: 'cccccccccccccccccccccccccccccccccccccccc',
                verifyTargetUrl: PRODUCTION.versionUrl,
                verifyStartedAt: now,
                verifyDeadlineAt: now,
                verifyRetryAt: now,
                verifyDetail: null,
            });

            expect(started).toBe(false);
            // Not merely "returned false": the row is untouched, which is
            // what stops a second replica re-baselining a live verification.
            expect((await reload(row.id)).verifyExpectedSha).toBe(MERGED);
        });

        it('claimVerifyAttempt refuses while another job is already claimed', async () => {
            // THE mutual exclusion: at most one browser is ever pointed at
            // one environment for one promotion.
            const row = await seed({ verifyState: 'awaiting-rollout', verifyJobId: 'job-first' });

            const claimed = await promotions.claimVerifyAttempt(row.id, 'awaiting-rollout', {
                jobId: 'job-second',
                attempts: 9,
                targetUrl: PRODUCTION.versionUrl,
                reconsiderAt: now,
            });

            expect(claimed).toBe(false);
            const stored = await reload(row.id);
            expect(stored.verifyJobId).toBe('job-first');
            expect(stored.verifyAttempts).toBe(0);
        });

        it('claimVerifyAttempt refuses from a state the row has left', async () => {
            const row = await seed({ verifyState: 'checking-app' });

            const claimed = await promotions.claimVerifyAttempt(row.id, 'awaiting-rollout', {
                jobId: 'job-1',
                attempts: 1,
                targetUrl: PRODUCTION.versionUrl,
                reconsiderAt: now,
            });

            expect(claimed).toBe(false);
            expect((await reload(row.id)).verifyJobId).toBeNull();
        });

        it('recordVerifyResult refuses a result from a SUPERSEDED job', async () => {
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyJobId: 'job-current',
                verifyStreak: 1,
            });

            const applied = await promotions.recordVerifyResult(
                row.id,
                { jobId: 'job-stale', state: 'awaiting-rollout' },
                {
                    verifyState: 'checking-app',
                    verifyStreak: 99,
                    verifyCheckedAt: now,
                    verifyRetryAt: now,
                    verifyDetail: 'from the wrong job',
                },
            );

            expect(applied).toBe(false);
            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('awaiting-rollout');
            expect(stored.verifyStreak).toBe(1);
            expect(stored.verifyJobId).toBe('job-current');
        });

        it('recordVerifyResult refuses a result read against a state the row has left', async () => {
            const row = await seed({ verifyState: 'confirming-failure', verifyJobId: 'job-1' });

            const applied = await promotions.recordVerifyResult(
                row.id,
                { jobId: 'job-1', state: 'checking-app' },
                {
                    verifyState: 'checking-app',
                    verifyStreak: 2,
                    verifyCheckedAt: now,
                    verifyRetryAt: now,
                    verifyDetail: 'late',
                },
            );

            expect(applied).toBe(false);
            expect((await reload(row.id)).verifyState).toBe('confirming-failure');
        });

        it('settleVerification refuses from a state the row has left — one verdict, one notice', async () => {
            // This pin is what makes "exactly one Inbox item per verdict"
            // true across replicas: the service narrates only when it
            // returned true.
            const row = await seed({ verifyState: 'passed', verifyDetail: 'the real verdict' });

            const applied = await promotions.settleVerification(row.id, 'checking-app', {
                verifyState: 'failed',
                verifyCheckedAt: now,
                verifyDetail: 'a second replica settling the same row',
            });

            expect(applied).toBe(false);
            const stored = await reload(row.id);
            expect(stored.verifyState).toBe('passed');
            expect(stored.verifyDetail).toBe('the real verdict');
        });

        it('settleVerification lands exactly once for two racing callers', async () => {
            const row = await seed({ verifyState: 'checking-app' });
            const patch = {
                verifyState: 'passed' as const,
                verifyCheckedAt: now,
                verifyDetail: 'ok',
            };

            expect(await promotions.settleVerification(row.id, 'checking-app', patch)).toBe(true);
            expect(await promotions.settleVerification(row.id, 'checking-app', patch)).toBe(false);
        });

        it('burnVerifyAttempt refuses to touch a row with a live claim', async () => {
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyJobId: 'job-live',
                verifyAttempts: 1,
            });

            const burned = await promotions.burnVerifyAttempt(row.id, 'awaiting-rollout', {
                attempts: 7,
                reconsiderAt: now,
                detail: 'nope',
            });

            expect(burned).toBe(false);
            expect((await reload(row.id)).verifyAttempts).toBe(1);
        });

        it('deferVerification only reschedules the row it is still waiting on', async () => {
            const row = await seed({ verifyState: 'awaiting-rollout', verifyJobId: 'job-1' });

            expect(
                await promotions.deferVerification(row.id, 'awaiting-rollout', 'job-other', now),
            ).toBe(false);
            expect(
                await promotions.deferVerification(row.id, 'awaiting-rollout', 'job-1', now),
            ).toBe(true);
            expect(new Date((await reload(row.id)).verifyRetryAt!).getTime()).toBe(now.getTime());
        });

        it('releaseVerifyJob only lets go of the job the row is actually bound to', async () => {
            const row = await seed({
                verifyState: 'awaiting-rollout',
                verifyJobId: 'job-1',
                verifyAttempts: 1,
            });

            expect(
                await promotions.releaseVerifyJob(row.id, 'awaiting-rollout', 'job-other', {
                    attempts: 2,
                    reconsiderAt: now,
                    detail: null,
                }),
            ).toBe(false);
            expect((await reload(row.id)).verifyJobId).toBe('job-1');
        });
    });

    describe('the database refuses a revert offer the state does not justify', () => {
        it.each(['passed', 'inconclusive', 'unsupported', 'awaiting-rollout'] as const)(
            'refuses to record one for a %s verification',
            async (state) => {
                // The last line of the "an inconclusive verdict does not
                // trigger a revert" rule, underneath the service check and
                // the contracts predicate: `claimRevertOffer` writes only
                // `WHERE verifyState = 'failed'`.
                const row = await seed({ verifyState: state });

                const claimed = await promotions.claimRevertOffer(row.id, 'task-x', now);

                expect(claimed).toBe(false);
                expect((await reload(row.id)).revertTaskId).toBeNull();
            },
        );

        it('records one exactly once for a failed verification', async () => {
            const row = await seed({ verifyState: 'failed' });

            expect(await promotions.claimRevertOffer(row.id, 'task-x', now)).toBe(true);
            expect(await promotions.claimRevertOffer(row.id, 'task-y', now)).toBe(false);
            expect((await reload(row.id)).revertTaskId).toBe('task-x');
        });
    });

    // ── The absences ──────────────────────────────────────────────────

    describe('what this service cannot do', () => {
        const source = readFileSync(
            join(__dirname, '..', 'release-verification.service.ts'),
            'utf8',
        );

        it('contains no call that could revert, merge, push or deploy anything', () => {
            // Read from SOURCE rather than asserted behaviourally, so that
            // ADDING one fails rather than merely exercising one. The class
            // docblock names the slice-AE merge path in prose when
            // explaining where a revert would have to go, and that sentence
            // is worth keeping — so these match CALL SITES.
            expect(source).not.toMatch(/\.mergePullRequest\(/);
            expect(source).not.toMatch(/\.createPullRequest\(/);
            expect(source).not.toMatch(/\.createBranch\(/);
            expect(source).not.toMatch(/\.push\(/);
            expect(source).not.toMatch(/attemptMergeForOpenPullRequest\(/);
            expect(source).not.toMatch(/attemptAgentMerge\(/);
            expect(source).not.toMatch(/\.deploy\(/);
            expect(source).not.toMatch(/\.rollback\(/);
        });

        it('cannot open a promotion, so a revert cannot start another release', () => {
            expect(source).not.toMatch(/openPromotion\(/);
        });

        it('enqueues fleet work in exactly one place', () => {
            // The producer is `enqueueProbe`, reached only from the sweep.
            // A second `enqueue(` would be a path that could re-enqueue from
            // a completion, which is how a failed check loops for ever.
            expect(source.match(/this\.fleet\.enqueue\(/g)).toHaveLength(1);
        });

        it('flattens node-reported text with escapes, never a literal control byte', () => {
            // The note that reaches a row, an Inbox body and a Task
            // thread is derived from a browser result reported by
            // somebody's PC. It is collapsed before it lands so a node
            // cannot forge extra lines in either surface — and the
            // collapsing regex is written with escapes, because a source
            // file must never carry a raw control byte.
            expect(source).toMatch(/\\u0000-\\u001f/);
            const literalControlBytes = [...source].filter(
                (character) => character.charCodeAt(0) < 32 && character !== '\n',
            );
            expect(literalControlBytes).toEqual([]);
        });
    });
});
