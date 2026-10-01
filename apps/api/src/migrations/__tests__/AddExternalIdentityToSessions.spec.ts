import { DataSource } from 'typeorm';
import { AddExternalIdentityToSessions1792120100000 } from '../1792120100000-AddExternalIdentityToSessions';

/**
 * APW-12 (Ever ID) — `1792120100000-AddExternalIdentityToSessions`: two nullable
 * columns and two indexes on `session`, no backfill, no foreign key; `down()`
 * removes exactly those and leaves every existing row and column as it was.
 */
describe('AddExternalIdentityToSessions1792120100000', () => {
    let dataSource: DataSource;
    const migration = new AddExternalIdentityToSessions1792120100000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };
    const columns = async () =>
        (
            (await dataSource.query(`PRAGMA table_info("session")`)) as Array<{
                name: string;
                notnull: number;
            }>
        ).map((column) => column.name);
    const indexes = async () =>
        (
            (await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session'`,
            )) as Array<{ name: string }>
        ).map((index) => index.name);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "session" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "tokenHash" varchar, "expiresAt" datetime NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "session" ("id", "userId", "tokenHash", "expiresAt") VALUES ('s1', 'u1', 'h1', CURRENT_TIMESTAMP)`,
        );
    });
    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the two nullable columns and their indexes; an existing session reads NULL', async () => {
        const before = await columns();

        await run('up');

        expect(await columns()).toEqual([...before, 'externalIdentityId', 'externalSid']);
        expect(await indexes()).toEqual(
            expect.arrayContaining(['idx_session_external_identity', 'idx_session_external_sid']),
        );
        expect(
            await dataSource.query(`SELECT "externalIdentityId", "externalSid" FROM "session"`),
        ).toEqual([{ externalIdentityId: null, externalSid: null }]);
        const foreignKeys = await dataSource.query(`PRAGMA foreign_key_list("session")`);
        expect(foreignKeys).toEqual([]);
    });

    it('is idempotent, and down removes exactly what up added', async () => {
        const before = await columns();
        await run('up');
        await run('up');
        await run('down');
        await run('down');

        expect(await columns()).toEqual(before);
        expect(await indexes()).not.toEqual(
            expect.arrayContaining(['idx_session_external_identity']),
        );
        expect(await dataSource.query(`SELECT "id" FROM "session"`)).toEqual([{ id: 's1' }]);
    });
});
