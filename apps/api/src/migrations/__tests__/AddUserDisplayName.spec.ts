import { DataSource } from 'typeorm';
import { AddUserDisplayName1795150000000 } from '../1795150000000-AddUserDisplayName';

/**
 * EW-P2-6 — `users.displayName` on in-memory better-sqlite3: nullable on every
 * existing row, idempotent, a missing table skipped, dropped by `down` with the rows kept.
 */
describe('AddUserDisplayName1795150000000', () => {
    let dataSource: DataSource;
    const migration = new AddUserDisplayName1795150000000();

    const columns = async (): Promise<Array<{ name: string; notnull: number }>> =>
        dataSource.query(`PRAGMA table_info("users")`);
    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL, "username" varchar NOT NULL)`,
        );
        await dataSource.query(`INSERT INTO "users" ("id", "username") VALUES ('u1', 'ada')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable displayName, idempotently', async () => {
        await run('up');
        await run('up');
        const column = (await columns()).find((entry) => entry.name === 'displayName');
        expect(column?.notnull).toBe(0);
        const [row] = await dataSource.query(`SELECT "displayName" FROM "users"`);
        expect(row.displayName).toBeNull();
    });

    it('skips a missing table', async () => {
        await dataSource.query(`DROP TABLE "users"`);
        await expect(run('up')).resolves.toBeUndefined();
    });

    it('down drops the column and keeps the rows', async () => {
        await run('up');
        await run('down');
        expect((await columns()).map((entry) => entry.name)).toEqual(['id', 'username']);
        expect(await dataSource.query(`SELECT "id" FROM "users"`)).toHaveLength(1);
    });
});
