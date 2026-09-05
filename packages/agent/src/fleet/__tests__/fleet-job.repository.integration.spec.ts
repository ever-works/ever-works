import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobRepository } from '../fleet-job.repository';

/**
 * The REAL predicates behind lease generations, against a real
 * (better-sqlite3, synchronize) schema.
 *
 * The service specs drive the repository through in-memory doubles that
 * re-implement the WHERE clause, so they cannot notice the one failure
 * that matters here: a `leaseGeneration` that silently drops out of a
 * conditional UPDATE and turns "pinned to this claim" back into "pinned
 * to this node". Every write a node can trigger is exercised with the
 * current generation (lands) and a stale one (matches zero rows and
 * leaves the row byte-for-byte as it was).
 */
describe('fleet job lease generation — repository integration (better-sqlite3)', () => {
    const OWNER = '44444444-4444-4444-8444-444444444444';
    const NODE_A = '11111111-1111-4111-8111-111111111111';
    const NODE_B = '22222222-2222-4222-8222-222222222222';

    let dataSource: DataSource;
    let jobs: FleetJobRepository;
    let rows: Repository<FleetJob>;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(FleetJob);
        jobs = new FleetJobRepository(rows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    afterEach(async () => {
        await rows.clear();
    });

    const expiry = (offsetMs: number) => new Date(Date.now() + offsetMs);
    const read = (id: string) => rows.findOneByOrFail({ id });

    /** Enqueue and lease once as `nodeId`, returning the row at generation 1. */
    async function leasedJob(nodeId = NODE_A): Promise<FleetJob> {
        const created = await jobs.create({ userId: OWNER, kind: 'acceptance-checks' });
        expect(created.leaseGeneration).toBe(0);
        const won = await jobs.claim(created.id, {
            nodeId,
            status: 'leased',
            leaseExpiresAt: expiry(60_000),
            attempts: 1,
            queuedReason: null,
            leaseGeneration: 1,
            startedAt: null,
        });
        expect(won).toBe(true);
        return read(created.id);
    }

    describe('claim', () => {
        it('mints previous + 1 and refuses to mint a value the row has moved past', async () => {
            const job = await leasedJob();
            expect(job.leaseGeneration).toBe(1);

            // Back to the pool WITHOUT resetting the generation.
            expect(
                await jobs.reclaim(job.id, {
                    status: 'leased',
                    nodeId: NODE_A,
                    leaseExpiresAt: job.leaseExpiresAt!,
                    leaseGeneration: 1,
                }),
            ).toBe(true);
            expect(await read(job.id)).toMatchObject({
                status: 'queued',
                nodeId: null,
                leaseGeneration: 1,
            });

            // A claim computed from a stale read (observed 0 → mint 1) must
            // not land: the platform already issued generation 1 once.
            expect(
                await jobs.claim(job.id, {
                    nodeId: NODE_B,
                    status: 'leased',
                    leaseExpiresAt: expiry(60_000),
                    attempts: 2,
                    queuedReason: null,
                    leaseGeneration: 1,
                    startedAt: null,
                }),
            ).toBe(false);
            expect(await read(job.id)).toMatchObject({ status: 'queued', leaseGeneration: 1 });

            // The claim computed from the current row (observed 1 → mint 2) does.
            expect(
                await jobs.claim(job.id, {
                    nodeId: NODE_B,
                    status: 'leased',
                    leaseExpiresAt: expiry(60_000),
                    attempts: 2,
                    queuedReason: null,
                    leaseGeneration: 2,
                    startedAt: null,
                }),
            ).toBe(true);
            expect(await read(job.id)).toMatchObject({
                status: 'leased',
                nodeId: NODE_B,
                leaseGeneration: 2,
            });
        });
    });

    describe('extendLease', () => {
        it('lands only for the current generation and leaves the row untouched otherwise', async () => {
            const job = await leasedJob();
            const before = await read(job.id);

            expect(await jobs.extendLease(job.id, NODE_A, expiry(120_000), new Date(), 0)).toBe(
                false,
            );
            expect(await jobs.extendLease(job.id, NODE_A, expiry(120_000), new Date(), 2)).toBe(
                false,
            );
            expect(await read(job.id)).toEqual(before);

            expect(await jobs.extendLease(job.id, NODE_A, expiry(120_000), new Date(), 1)).toBe(
                true,
            );
            expect(await read(job.id)).toMatchObject({ status: 'running', leaseGeneration: 1 });
        });

        it('refuses the previous generation on the SAME node after a re-lease', async () => {
            const job = await leasedJob();
            // Lapse → reclaim → the same node claims again at generation 2.
            await jobs.reclaim(job.id, {
                status: 'leased',
                nodeId: NODE_A,
                leaseExpiresAt: job.leaseExpiresAt!,
                leaseGeneration: 1,
            });
            await jobs.claim(job.id, {
                nodeId: NODE_A,
                status: 'leased',
                leaseExpiresAt: expiry(60_000),
                attempts: 2,
                queuedReason: null,
                leaseGeneration: 2,
                startedAt: null,
            });
            const current = await read(job.id);

            // The run that slept: same node, generation 1.
            expect(await jobs.extendLease(job.id, NODE_A, expiry(600_000), new Date(), 1)).toBe(
                false,
            );
            expect(await read(job.id)).toEqual(current);
        });
    });

    describe('complete', () => {
        it('never lets a stale generation write status, result or error over the current claim', async () => {
            const job = await leasedJob();
            await jobs.reclaim(job.id, {
                status: 'leased',
                nodeId: NODE_A,
                leaseExpiresAt: job.leaseExpiresAt!,
                leaseGeneration: 1,
            });
            await jobs.claim(job.id, {
                nodeId: NODE_A,
                status: 'leased',
                leaseExpiresAt: expiry(60_000),
                attempts: 2,
                queuedReason: null,
                leaseGeneration: 2,
                startedAt: null,
            });
            const current = await read(job.id);

            for (const stale of [0, 1, 3]) {
                expect(
                    await jobs.complete(
                        job.id,
                        NODE_A,
                        {
                            status: 'done',
                            result: { branch: 'task/from-the-run-that-slept' },
                            completedAt: new Date(),
                        },
                        stale,
                    ),
                ).toBe(false);
                expect(
                    await jobs.complete(
                        job.id,
                        NODE_A,
                        { status: 'failed', error: 'stale verdict', completedAt: new Date() },
                        stale,
                    ),
                ).toBe(false);
            }
            expect(await read(job.id)).toEqual(current);

            expect(
                await jobs.complete(
                    job.id,
                    NODE_A,
                    {
                        status: 'done',
                        result: { branch: 'task/from-the-current-run' },
                        completedAt: new Date(),
                    },
                    2,
                ),
            ).toBe(true);
            expect(await read(job.id)).toMatchObject({
                status: 'done',
                result: { branch: 'task/from-the-current-run' },
                leaseExpiresAt: null,
                leaseGeneration: 2,
            });
        });
    });

    describe('reclaim / failExhausted', () => {
        it('pin the observed generation and leave it intact on the row', async () => {
            const job = await leasedJob();
            const observed = {
                status: 'leased' as const,
                nodeId: NODE_A,
                leaseExpiresAt: job.leaseExpiresAt!,
            };

            expect(await jobs.reclaim(job.id, { ...observed, leaseGeneration: 2 })).toBe(false);
            expect(
                await jobs.failExhausted(
                    job.id,
                    { ...observed, leaseGeneration: 2 },
                    'budget exhausted',
                    new Date(),
                ),
            ).toBe(false);
            expect(await read(job.id)).toMatchObject({ status: 'leased', leaseGeneration: 1 });

            expect(
                await jobs.failExhausted(
                    job.id,
                    { ...observed, leaseGeneration: 1 },
                    'budget exhausted',
                    new Date(),
                ),
            ).toBe(true);
            expect(await read(job.id)).toMatchObject({
                status: 'failed',
                error: 'budget exhausted',
                leaseGeneration: 1,
            });
        });
    });

    describe('releaseClaimsForNode (drain)', () => {
        it('requeues without advancing the generation — the next claim does that', async () => {
            const job = await leasedJob();
            expect(await jobs.releaseClaimsForNode(OWNER, NODE_A)).toBe(1);
            expect(await read(job.id)).toMatchObject({
                status: 'queued',
                nodeId: null,
                leaseExpiresAt: null,
                leaseGeneration: 1,
            });
        });
    });
});
