import { DataSource } from 'typeorm';
import { CreateEverConnectPersonRequests1797300000000 } from '../1797300000000-CreateEverConnectPersonRequests';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs. What
 * matters: one answer per platform job (the unique index is what makes a
 * request delivered twice answered once), `up()` re-runs as a no-op, and
 * `down()` removes the table.
 */
describe('CreateEverConnectPersonRequests1797300000000', () => {
    let dataSource: DataSource;
    const migration = new CreateEverConnectPersonRequests1797300000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    const insert = (id: string, jobId: string) =>
        dataSource.query(
            `INSERT INTO "ever_connect_person_requests" ("id", "jobId", "eventId", "kind", "result")
             VALUES (?, ?, ?, 'deletion', 'no_account')`,
            [id, jobId, `evt-${id}`],
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates the table with one answer per job', async () => {
        await run('up');

        const table = await dataSource.createQueryRunner().getTable('ever_connect_person_requests');
        expect(table?.columns.map((column) => column.name).sort()).toEqual(
            [
                'answeredAt',
                'createdAt',
                'eventId',
                'exportUrl',
                'id',
                'jobId',
                'kind',
                'legalBasis',
                'reasonCode',
                'result',
                'updatedAt',
            ].sort(),
        );

        await insert('r1', '01K6A7S2ABCDEFGHJKMNPQRSTV');
        await expect(insert('r2', '01K6A7S2ABCDEFGHJKMNPQRSTV')).rejects.toThrow();
        await insert('r3', '01K6A7S2ABCDEFGHJKMNPQRSTW');
        const [{ count }] = await dataSource.query(
            `SELECT COUNT(*) AS count FROM "ever_connect_person_requests"`,
        );
        expect(Number(count)).toBe(2);
    });

    it('re-runs as a no-op and keeps the rows', async () => {
        await run('up');
        await insert('r1', '01K6A7S2ABCDEFGHJKMNPQRSTV');
        await run('up');

        const rows = await dataSource.query(`SELECT "jobId" FROM "ever_connect_person_requests"`);
        expect(rows).toEqual([{ jobId: '01K6A7S2ABCDEFGHJKMNPQRSTV' }]);
    });

    it('down() removes the table', async () => {
        await run('up');
        await run('down');

        expect(await dataSource.createQueryRunner().hasTable('ever_connect_person_requests')).toBe(
            false,
        );
    });
});
