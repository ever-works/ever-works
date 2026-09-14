import { DataSource, Repository } from 'typeorm';
import type { FleetJobKind } from '@ever-works/contracts';
import { ENTITIES } from '../../database/_entities-inventory';
import { FleetJob } from '../../entities/fleet-job.entity';
import { FleetJobRepository } from '../fleet-job.repository';

/**
 * The REAL kind predicate behind a lane's lease scan, against a real
 * (better-sqlite3, synchronize) schema.
 *
 * A lane may name the kinds it wants, the kinds it never wants, or both.
 * Whatever it names has to be applied before the result window is cut:
 * a filter applied after `take` lets rows the lane can never claim fill
 * the window and hide eligible work behind them.
 */
describe('fleet job lease scan — kind filters (better-sqlite3)', () => {
    const OWNER = '44444444-4444-4444-8444-444444444444';
    const NODE = '11111111-1111-4111-8111-111111111111';

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

    /** Enqueue one job with an explicit queue position (oldest first). */
    async function queued(kind: FleetJobKind, minute: number): Promise<FleetJob> {
        const job = await jobs.create({ userId: OWNER, kind });
        await rows.update({ id: job.id }, { createdAt: new Date(Date.UTC(2026, 8, 1, 9, minute)) });
        return rows.findOneByOrFail({ id: job.id });
    }

    it('applies an inclusion AND an exclusion before the window, so excluded rows cannot hide eligible work', async () => {
        await queued('computer-session', 1);
        await queued('computer-session', 2);
        await queued('computer-session', 3);
        const eligible = await queued('acceptance-checks', 4);

        const found = await jobs.findQueuedForNode(OWNER, NODE, 2, {
            kinds: ['computer-session', 'acceptance-checks'],
            excludeKinds: ['computer-session'],
        });

        expect(found.map((job) => job.id)).toEqual([eligible.id]);
    });

    it('returns nothing when every requested kind is also excluded', async () => {
        await queued('computer-session', 1);

        const found = await jobs.findQueuedForNode(OWNER, NODE, 5, {
            kinds: ['computer-session'],
            excludeKinds: ['computer-session'],
        });

        expect(found).toEqual([]);
    });

    it('keeps the single-filter and unfiltered scans as they were', async () => {
        const live = await queued('computer-session', 1);
        const checks = await queued('acceptance-checks', 2);
        const task = await queued('agent-task', 3);

        const only = await jobs.findQueuedForNode(OWNER, NODE, 5, { kinds: ['computer-session'] });
        expect(only.map((job) => job.id)).toEqual([live.id]);

        const without = await jobs.findQueuedForNode(OWNER, NODE, 5, {
            excludeKinds: ['computer-session'],
        });
        expect(without.map((job) => job.id)).toEqual([checks.id, task.id]);

        const all = await jobs.findQueuedForNode(OWNER, NODE, 5);
        expect(all.map((job) => job.id)).toEqual([live.id, checks.id, task.id]);
    });
});
