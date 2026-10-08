import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobRepository } from '../fleet-job.repository';

/**
 * Self-build slice AP — the retention purge's REAL predicates, against a real
 * (better-sqlite3, synchronize) schema.
 *
 * What would hurt to get wrong, and what a mocked repository could not see:
 *
 *   - purging an ACTIVE job (a running node would lose its payload mid-run,
 *     and a reclaim would re-offer a job with no instructions);
 *   - purging a RECENT terminal job (the owner's evidence gone in a day);
 *   - losing the row's METADATA (status, node, timings, cost, error);
 *   - a second pass touching an already-purged row (not idempotent);
 *   - a batch that ignores its limit.
 */
describe('FleetJobRepository.purgeTerminalBodies (self-build slice AP, better-sqlite3)', () => {
    const OWNER = '11111111-1111-4111-8111-111111111111';
    const NODE = '33333333-3333-4333-8333-333333333333';
    const NOW = new Date('2026-10-08T03:35:00.000Z');
    const CUTOFF = new Date('2026-09-08T03:35:00.000Z');
    const OLD = new Date('2026-08-01T00:00:00.000Z');
    const RECENT = new Date('2026-10-01T00:00:00.000Z');

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

    const seed = (overrides: Partial<FleetJob>): Promise<FleetJob> =>
        rows.save(
            rows.create({
                userId: OWNER,
                nodeId: NODE,
                kind: 'agent-task',
                status: 'done',
                requiredCapabilities: ['workspace'],
                payload: {
                    runId: 'run-1',
                    taskId: 'task-1',
                    execution: { instructions: 'the whole prompt' },
                },
                result: { status: 'succeeded', model: { transcript: '{"type":"result"}' } },
                attempts: 1,
                costCents: 42,
                startedAt: new Date(OLD.getTime() - 60_000),
                completedAt: OLD,
                ...overrides,
            }),
        );

    it('NULLs the bodies of old TERMINAL jobs only, and keeps every row and its metadata', async () => {
        const oldDone = await seed({});
        const oldFailed = await seed({
            status: 'failed',
            result: null,
            error: 'pnpm lint exited 1',
        });
        const recentDone = await seed({ completedAt: RECENT });
        // An ACTIVE row with an ancient completedAt cannot exist in practice;
        // seeded anyway because the status predicate is what must hold.
        const oldActive = await seed({ status: 'running', completedAt: OLD });
        const queued = await seed({ status: 'queued', completedAt: null });

        await expect(jobs.purgeTerminalBodies(CUTOFF, 100, NOW)).resolves.toBe(2);

        const byId = new Map((await rows.find()).map((row) => [row.id, row]));
        for (const purged of [oldDone, oldFailed]) {
            const row = byId.get(purged.id)!;
            expect(row.payload).toBeNull();
            expect(row.result).toBeNull();
            expect(row.bodiesPurgedAt?.toISOString()).toBe(NOW.toISOString());
        }
        // Metadata survives the purge.
        const failed = byId.get(oldFailed.id)!;
        expect(failed).toMatchObject({
            status: 'failed',
            nodeId: NODE,
            attempts: 1,
            costCents: 42,
            error: 'pnpm lint exited 1',
            kind: 'agent-task',
        });
        expect(failed.completedAt?.toISOString()).toBe(OLD.toISOString());
        // Recent, active and queued rows are untouched.
        for (const kept of [recentDone, oldActive, queued]) {
            const row = byId.get(kept.id)!;
            expect(row.payload).toEqual(kept.payload);
            expect(row.bodiesPurgedAt ?? null).toBeNull();
        }
        expect(byId.get(recentDone.id)!.result).toEqual(recentDone.result);
    });

    it('is idempotent: a second pass purges nothing', async () => {
        await seed({});
        await expect(jobs.purgeTerminalBodies(CUTOFF, 100, NOW)).resolves.toBe(1);
        await expect(
            jobs.purgeTerminalBodies(CUTOFF, 100, new Date(NOW.getTime() + 86_400_000)),
        ).resolves.toBe(0);
        const [row] = await rows.find();
        // The FIRST pass's stamp stands.
        expect(row.bodiesPurgedAt?.toISOString()).toBe(NOW.toISOString());
    });

    it('honours its batch limit, oldest first', async () => {
        const oldest = await seed({ completedAt: new Date('2026-06-01T00:00:00.000Z') });
        const middle = await seed({ completedAt: new Date('2026-07-01T00:00:00.000Z') });
        const newest = await seed({ completedAt: OLD });

        await expect(jobs.purgeTerminalBodies(CUTOFF, 2, NOW)).resolves.toBe(2);
        const purgedIds = (await rows.find())
            .filter((row) => row.bodiesPurgedAt)
            .map((row) => row.id);
        expect(purgedIds.sort()).toEqual([oldest.id, middle.id].sort());

        await expect(jobs.purgeTerminalBodies(CUTOFF, 2, NOW)).resolves.toBe(1);
        expect((await rows.findOneByOrFail({ id: newest.id })).payload).toBeNull();
    });
});
