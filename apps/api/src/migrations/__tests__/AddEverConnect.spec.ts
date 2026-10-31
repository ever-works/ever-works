import { DataSource } from 'typeorm';
import { AddEverConnect1797300000000 } from '../1797300000000-AddEverConnect';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs. What
 * matters: the five tables exist; one integration row per (link, key), one
 * outbox row per `dedupeKey` and one answer per platform job (the unique
 * indexes are what make a report or a request handled twice handled once);
 * `up()` re-runs as a no-op; `down()` removes the tables.
 */
describe('AddEverConnect1797300000000', () => {
    let dataSource: DataSource;
    const migration = new AddEverConnect1797300000000();
    const TABLES = [
        'ever_connect_connection',
        'ever_connect_integration',
        'ever_connect_outbox',
        'ever_connect_lease',
        'ever_connect_person_requests',
    ];

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

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

    it('creates the five tables', async () => {
        await run('up');
        const runner = dataSource.createQueryRunner();
        for (const table of TABLES) expect(await runner.hasTable(table)).toBe(true);
        const requests = await runner.getTable('ever_connect_person_requests');
        expect(requests?.columns.map((column) => column.name).sort()).toEqual(
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
        await runner.release();
    });

    it('keeps one integration per link and key, one outbox row per key, one answer per job', async () => {
        await run('up');
        const integration = (id: string, linkId: string) =>
            dataSource.query(
                `INSERT INTO "ever_connect_integration" ("id", "linkId", "integrationKey", "state") VALUES (?, ?, 'ever_id_login', 'enabled')`,
                [id, linkId],
            );
        await integration('i1', '');
        await expect(integration('i2', '')).rejects.toThrow();
        await integration('i3', 'link-1');

        const outbox = (id: string) =>
            dataSource.query(
                `INSERT INTO "ever_connect_outbox" ("id", "event", "payload", "dedupeKey", "nextAttemptAt") VALUES (?, 'person_link', '{}', 'k1', CURRENT_TIMESTAMP)`,
                [id],
            );
        await outbox('o1');
        await expect(outbox('o2')).rejects.toThrow();

        const request = (id: string) =>
            dataSource.query(
                `INSERT INTO "ever_connect_person_requests" ("id", "jobId", "eventId", "kind", "result") VALUES (?, '01K6A7S2ABCDEFGHJKMNPQRSTV', 'evt', 'deletion', 'no_account')`,
                [id],
            );
        await request('r1');
        await expect(request('r2')).rejects.toThrow();

        const [{ state }] = await dataSource.query(`SELECT "state" FROM "ever_connect_outbox"`);
        expect(state).toBe('pending');
    });

    it('re-runs as a no-op and keeps the rows', async () => {
        await run('up');
        await dataSource.query(
            `INSERT INTO "ever_connect_connection" ("id", "platformInstanceId") VALUES ('self', '01K6A7S2ABCDEFGHJKMNPQRSTV')`,
        );
        await run('up');
        expect(await dataSource.query(`SELECT "id", "status" FROM "ever_connect_connection"`)).toEqual([
            { id: 'self', status: 'disconnected' },
        ]);
    });

    it('down() removes the tables', async () => {
        await run('up');
        await run('down');
        const runner = dataSource.createQueryRunner();
        for (const table of TABLES) expect(await runner.hasTable(table)).toBe(false);
        await runner.release();
    });
});
