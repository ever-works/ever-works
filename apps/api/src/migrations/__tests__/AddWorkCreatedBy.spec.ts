import { DataSource } from 'typeorm';
import { AddWorkCreatedBy1795162200000 } from '../1795162200000-AddWorkCreatedBy';

/**
 * `works.createdByType` / `works.createdById` on in-memory better-sqlite3 (EW-P1-2 attribution
 * for a Project Work created through an integration key, EW-P2-4): nullable on every existing
 * row (= the owner created it), idempotent, a missing table skipped, dropped by `down` with
 * the rows kept.
 */
describe('AddWorkCreatedBy1795162200000', () => {
    let dataSource: DataSource;
    const migration = new AddWorkCreatedBy1795162200000();

    const columns = async (): Promise<Array<{ name: string; notnull: number }>> =>
        dataSource.query(`PRAGMA table_info("works")`);
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
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL)`,
        );
        await dataSource.query(`INSERT INTO "works" ("id", "name") VALUES ('w1', 'Relaunch')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds nullable createdByType and createdById, idempotently', async () => {
        await run('up');
        await run('up');
        const added = (await columns()).filter((entry) =>
            ['createdByType', 'createdById'].includes(entry.name),
        );
        expect(added.map((entry) => [entry.name, entry.notnull])).toEqual([
            ['createdByType', 0],
            ['createdById', 0],
        ]);
        const [row] = await dataSource.query(`SELECT "createdByType", "createdById" FROM "works"`);
        expect(row).toEqual({ createdByType: null, createdById: null });
    });

    it('skips a missing table', async () => {
        await dataSource.query(`DROP TABLE "works"`);
        await expect(run('up')).resolves.toBeUndefined();
    });

    it('down drops the columns and keeps the rows', async () => {
        await run('up');
        await run('down');
        expect((await columns()).map((entry) => entry.name)).toEqual(['id', 'name']);
        expect(await dataSource.query(`SELECT "id" FROM "works"`)).toHaveLength(1);
    });
});
