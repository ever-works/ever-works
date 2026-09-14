import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { config } from '@src/config';
import { AgentRun } from '@src/entities/agent-run.entity';
import { ENTITIES } from '@src/database/_entities-inventory';
import { AgentRunRepository } from '@src/database/repositories/agent-run.repository';
import { RunSteeringService } from '../run-steering.service';

/**
 * Resume single-flight — at most ONE successor per parked run, however many
 * decisions arrive for it at once.
 *
 * The race this pins: `resume` checked resumability on a READ, then created
 * and enqueued a successor, and only then cleared `awaitingInput`. Two
 * requests deciding different Inbox items on the same parked run both
 * passed the check, and one parked run got two successor runs. The fix is a
 * compare-and-set claim on the source run, and a claim is only as good as
 * the SQL behind it — so everything here runs the real service against the
 * real repository on an in-memory better-sqlite3 database (what CI and the
 * e2e stack run), not a mocked query builder.
 *
 * Interleavings are forced, never hoped for: a barrier holds every request
 * after its load until all of them have read the run, which is exactly the
 * window the old code could not survive.
 */
describe('RunSteeringService — resume single-flight (better-sqlite3)', () => {
    let dataSource: DataSource;
    let rows: Repository<AgentRun>;
    let runs: AgentRunRepository;
    let dispatcher: { enqueue: jest.Mock };
    const queries: string[] = [];

    const USER = '11111111-1111-4111-8111-111111111111';
    const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const TASK = '77777777-7777-4777-8777-777777777777';
    const WORK = '33333333-3333-4333-8333-333333333333';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            // Captured so the emitted claim SQL can be asserted on: SQLite
            // matches unquoted camelCase identifiers case-insensitively, but
            // Postgres folds them to lower case and fails.
            logging: ['query'],
            logger: {
                logQuery: (query: string) => queries.push(query),
                logQueryError: () => undefined,
                logQuerySlow: () => undefined,
                logSchemaBuild: () => undefined,
                logMigration: () => undefined,
                log: () => undefined,
            },
        });
        await dataSource.initialize();
        // Only `agent_runs` rows are seeded; parents are irrelevant here.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        rows = dataSource.getRepository(AgentRun);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await rows.clear();
        queries.length = 0;
        runs = new AgentRunRepository(rows);
        dispatcher = {
            enqueue: jest.fn().mockImplementation(async ({ runId }: { runId: string }) => ({
                runId: `trigger-${runId}`,
            })),
        };
    });

    afterEach(() => jest.restoreAllMocks());

    function makeSvc(): RunSteeringService {
        const svc = new RunSteeringService(runs, undefined, dispatcher);
        for (const level of ['log', 'warn'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    }

    /** A run parked on a human: finished, awaiting input, Task-attached. */
    function seedSource(overrides: Partial<AgentRun> = {}): Promise<AgentRun> {
        return rows.save(
            rows.create({
                userId: USER,
                agentId: AGENT,
                taskId: TASK,
                workId: WORK,
                triggerKind: 'task',
                status: 'completed',
                gateAttempts: 0,
                persistent: false,
                awaitingInput: true,
                interruptRequested: false,
                cliSessionId: 'cli-session-parked',
                tenantId: null,
                organizationId: null,
                ...overrides,
            } as Partial<AgentRun>),
        );
    }

    async function successorsOf(source: AgentRun): Promise<AgentRun[]> {
        const all = await rows.find({ where: { taskId: TASK }, order: { createdAt: 'ASC' } });
        return all.filter((row) => row.id !== source.id);
    }

    async function reload(source: AgentRun): Promise<AgentRun> {
        return rows.findOneByOrFail({ id: source.id });
    }

    function deferred<T = void>() {
        let resolve!: (value: T) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    /**
     * Hold every `findByIdAndUser` after it has read the row until `count`
     * of them have — so every request decides on the same pre-claim state.
     */
    function holdLoadsUntil(count: number): void {
        const load = AgentRunRepository.prototype.findByIdAndUser;
        const allLoaded = deferred();
        let loaded = 0;
        jest.spyOn(runs, 'findByIdAndUser').mockImplementation(async (...args) => {
            const row = await load.apply(runs, args);
            loaded += 1;
            if (loaded === count) allLoaded.resolve();
            await allLoaded.promise;
            return row;
        });
    }

    function partition(results: PromiseSettledResult<unknown>[]) {
        return {
            won: results.filter((r) => r.status === 'fulfilled'),
            lost: results
                .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
                .map((r) => r.reason),
        };
    }

    describe('concurrent decisions', () => {
        it('⭐ two concurrent resumes of one parked run create exactly one successor and one 409', async () => {
            // THE RACE. Two Inbox items on the same parked run, answered at
            // the same moment.
            const source = await seedSource();
            holdLoadsUntil(2);
            const svc = makeSvc();

            const { won, lost } = partition(
                await Promise.allSettled([
                    svc.resume(source.id, USER, 'Use Postgres'),
                    svc.resume(source.id, USER, 'Ship on Friday'),
                ]),
            );

            expect(won).toHaveLength(1);
            expect(lost).toHaveLength(1);
            expect(lost[0]).toBeInstanceOf(ConflictException);
            expect((lost[0] as ConflictException).message).toContain('is not resumable');
            expect(await successorsOf(source)).toHaveLength(1);
            expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);

            // The winner answered the question and spent its claim.
            const after = await reload(source);
            expect(after.awaitingInput).toBe(false);
            expect(after.resumeClaimedAt).toBeNull();
            expect(after.resumeClaimToken).toEqual(expect.any(String));
        });

        it('⭐ five concurrent resumes still create exactly one successor', async () => {
            const source = await seedSource();
            holdLoadsUntil(5);
            const svc = makeSvc();

            const { won, lost } = partition(
                await Promise.allSettled(
                    [1, 2, 3, 4, 5].map((n) => svc.resume(source.id, USER, `decision ${n}`)),
                ),
            );

            expect(won).toHaveLength(1);
            expect(lost).toHaveLength(4);
            for (const reason of lost) expect(reason).toBeInstanceOf(ConflictException);
            expect(await successorsOf(source)).toHaveLength(1);
        });

        it('⭐ auto-resume of a COMPLETED run is single-flight too (no awaitingInput to clear)', async () => {
            // Slice AC — two red-build deliveries for the run that pushed
            // the branch. A completed run stays auto-resumable after a
            // resume, so the claim is its only guard.
            const source = await seedSource({ awaitingInput: false });
            holdLoadsUntil(2);
            const svc = makeSvc();

            const { won, lost } = partition(
                await Promise.allSettled([
                    svc.resumeRun({ runId: source.id, userId: USER, allowCompleted: true }),
                    svc.resumeRun({ runId: source.id, userId: USER, allowCompleted: true }),
                ]),
            );

            expect(won).toHaveLength(1);
            expect(lost).toHaveLength(1);
            expect(lost[0]).toBeInstanceOf(ConflictException);
            expect(await successorsOf(source)).toHaveLength(1);
        });

        it('⭐ a request that read the run before the winner claimed it still loses after the winner finished', async () => {
            // A run that stays resumable after its first resume (a parked
            // terminal that also asked a question). "Unclaimed" alone would
            // let the late request through once the winner cleared its
            // in-flight stamp; the kept token is what refuses it.
            const source = await seedSource({ terminalEndedReason: 'parked' });
            holdLoadsUntil(2);
            const winnerConsumed = deferred();
            const consume = AgentRunRepository.prototype.consumeResumeClaim;
            jest.spyOn(runs, 'consumeResumeClaim').mockImplementation(async (...args) => {
                const consumed = await consume.apply(runs, args);
                winnerConsumed.resolve();
                return consumed;
            });
            const claim = AgentRunRepository.prototype.claimResume;
            let claims = 0;
            jest.spyOn(runs, 'claimResume').mockImplementation(async (...args) => {
                claims += 1;
                // The second claimant only reaches the database once the
                // first resume has fully completed.
                if (claims === 2) await winnerConsumed.promise;
                return claim.apply(runs, args);
            });
            const svc = makeSvc();

            const { won, lost } = partition(
                await Promise.allSettled([
                    svc.resume(source.id, USER, 'first answer'),
                    svc.resume(source.id, USER, 'second answer'),
                ]),
            );

            expect(won).toHaveLength(1);
            expect(lost).toHaveLength(1);
            expect(lost[0]).toBeInstanceOf(ConflictException);
            expect(await successorsOf(source)).toHaveLength(1);

            // A single, uncontended resume afterwards is judged exactly as
            // before the fix: a parked run is still resumable.
            const again = await makeSvc().resume(source.id, USER, 'carry on');
            expect(again.dispatched).toBe('new-run');
            expect(await successorsOf(source)).toHaveLength(2);
        });
    });

    describe('release on failure', () => {
        it('⭐ a failed enqueue releases the claim — refused while in flight, resumable again after', async () => {
            const source = await seedSource();
            const inEnqueue = deferred();
            const runtime = deferred();
            dispatcher.enqueue.mockImplementationOnce(async () => {
                inEnqueue.resolve();
                await runtime.promise;
                throw new Error('runtime down');
            });
            const svc = makeSvc();

            const first = svc.resume(source.id, USER, 'Use Postgres');
            first.catch(() => undefined);
            await inEnqueue.promise;
            try {
                // While the first resume holds the claim, a second decision
                // is refused instead of creating a second successor.
                await expect(svc.resume(source.id, USER, 'Ship on Friday')).rejects.toBeInstanceOf(
                    ConflictException,
                );
            } finally {
                runtime.resolve();
            }
            await expect(first).rejects.toThrow('Resume could not be dispatched');

            // The source reads exactly as it did before the attempt.
            const afterFailure = await reload(source);
            expect(afterFailure.awaitingInput).toBe(true);
            expect(afterFailure.resumeClaimToken).toBeNull();
            expect(afterFailure.resumeClaimedAt).toBeNull();

            // The owner retries, and it goes through.
            const retry = await svc.resume(source.id, USER, 'Use Postgres');
            expect(retry.dispatched).toBe('new-run');
            const successors = await successorsOf(source);
            expect(successors.map((row) => row.status).sort()).toEqual(['failed', 'queued']);
            expect(successors.find((row) => row.status === 'queued')?.id).toBe(retry.runId);
            expect((await reload(source)).awaitingInput).toBe(false);
        });

        it('a failed seed rolls the orphan successor back and releases the claim', async () => {
            // Left `queued`, the orphan could later be drained into a second,
            // unseeded successor once the retry below succeeds.
            const source = await seedSource();
            jest.spyOn(runs, 'seedResumeContext').mockRejectedValueOnce(new Error('db blip'));
            const svc = makeSvc();

            await expect(svc.resume(source.id, USER, 'Use Postgres')).rejects.toThrow('db blip');

            const [orphan] = await successorsOf(source);
            expect(orphan.status).toBe('failed');
            expect(orphan.errorMessage).toContain('resume aborted before enqueue');
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
            const afterFailure = await reload(source);
            expect(afterFailure.awaitingInput).toBe(true);
            expect(afterFailure.resumeClaimToken).toBeNull();
            expect(afterFailure.resumeClaimedAt).toBeNull();

            const retry = await svc.resume(source.id, USER, 'Use Postgres');
            expect(retry.dispatched).toBe('new-run');
            expect((await successorsOf(source)).map((row) => row.status).sort()).toEqual([
                'failed',
                'queued',
            ]);
        });
    });

    describe('expiry', () => {
        const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
        const DEAD_HOLDER = '99999999-9999-4999-8999-999999999999';

        it('⭐ a claim older than the stuck-run sweeper cutoff is taken over', async () => {
            // The process that took this claim died before releasing it.
            const source = await seedSource({
                resumeClaimToken: DEAD_HOLDER,
                resumeClaimedAt: minutesAgo(config.agents.getRunStuckSweepMinutes() + 5),
            });

            const outcome = await makeSvc().resume(source.id, USER, 'Use Postgres');

            expect(outcome.dispatched).toBe('new-run');
            expect(await successorsOf(source)).toHaveLength(1);
            const after = await reload(source);
            expect(after.resumeClaimToken).not.toBe(DEAD_HOLDER);
            expect(after.resumeClaimedAt).toBeNull();
            expect(after.awaitingInput).toBe(false);
        });

        it('⭐ a claim inside the cutoff is still in flight — refused, nothing created', async () => {
            const source = await seedSource({
                resumeClaimToken: DEAD_HOLDER,
                resumeClaimedAt: minutesAgo(1),
            });

            await expect(makeSvc().resume(source.id, USER, 'Use Postgres')).rejects.toBeInstanceOf(
                ConflictException,
            );

            expect(await successorsOf(source)).toHaveLength(0);
            expect(dispatcher.enqueue).not.toHaveBeenCalled();
            const after = await reload(source);
            expect(after.resumeClaimToken).toBe(DEAD_HOLDER);
            expect(after.awaitingInput).toBe(true);
        });
    });

    describe('AgentRunRepository claim / release / consume', () => {
        const future = () => new Date(Date.now() + 60_000);
        const past = () => new Date(Date.now() - 60_000);

        it('lets only one claimant win from the same observed state', async () => {
            const source = await seedSource();

            const first = await runs.claimResume(source.id, {
                observedToken: null,
                staleBefore: past(),
            });
            const second = await runs.claimResume(source.id, {
                observedToken: null,
                staleBefore: past(),
            });

            expect(first).toEqual({
                runId: source.id,
                token: expect.any(String),
                previousToken: null,
            });
            expect(second).toBeNull();
        });

        it('never lets a stale holder release or consume the claim that took it over', async () => {
            const source = await seedSource();
            const stale = await runs.claimResume(source.id, {
                observedToken: null,
                staleBefore: past(),
            });
            // Everything before `future()` counts as abandoned.
            const taker = await runs.claimResume(source.id, {
                observedToken: stale!.token,
                staleBefore: future(),
            });
            expect(taker).not.toBeNull();

            expect(await runs.releaseResumeClaim(stale!)).toBe(false);
            expect(await runs.consumeResumeClaim(stale!)).toBe(false);
            const held = await reload(source);
            expect(held.resumeClaimToken).toBe(taker!.token);
            expect(held.resumeClaimedAt).not.toBeNull();

            // The taker's own release restores what IT replaced.
            expect(await runs.releaseResumeClaim(taker!)).toBe(true);
            const released = await reload(source);
            expect(released.resumeClaimToken).toBe(stale!.token);
            expect(released.resumeClaimedAt).toBeNull();
        });

        it('keeps the token on consume, so a claimant holding an older read loses', async () => {
            const source = await seedSource();
            const claim = await runs.claimResume(source.id, {
                observedToken: null,
                staleBefore: past(),
            });
            expect(await runs.consumeResumeClaim(claim!)).toBe(true);

            expect(
                await runs.claimResume(source.id, { observedToken: null, staleBefore: past() }),
            ).toBeNull();
            expect(
                await runs.claimResume(source.id, {
                    observedToken: claim!.token,
                    staleBefore: past(),
                }),
            ).not.toBeNull();
        });

        it('emits quoted identifiers, so the claim runs on Postgres too', async () => {
            const source = await seedSource();
            queries.length = 0;

            const claim = await runs.claimResume(source.id, {
                observedToken: null,
                staleBefore: past(),
            });
            await runs.consumeResumeClaim(claim!);
            await runs.releaseResumeClaim(claim!);

            const writes = queries.filter((query) => query.startsWith('UPDATE'));
            expect(writes).toHaveLength(3);
            for (const query of writes) {
                expect(query).toContain('"resumeClaimToken"');
                expect(query).not.toMatch(/[^"]resumeClaim(Token|edAt)[^"]/);
            }
        });
    });
});
