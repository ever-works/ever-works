import { DataSource } from 'typeorm';
import { AddP2AggregateSyncColumns1795100000000 } from '../1795100000000-AddP2AggregateSyncColumns';

/**
 * Migration test for the P2 sync columns (EW-P2-1 / -2 / -5). In-memory
 * better-sqlite3; assertions read `PRAGMA table_info` (the physical schema).
 */
describe('AddP2AggregateSyncColumns1795100000000', () => {
    let dataSource: DataSource;
    const migration = new AddP2AggregateSyncColumns1795100000000();
    const tables = ['work_proposals', 'goals', 'missions'];

    type PhysicalColumn = {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
    };
    const columnsOf = async (table: string): Promise<PhysicalColumn[]> =>
        dataSource.query(`PRAGMA table_info("${table}")`);
    const columnOf = async (table: string, name: string): Promise<PhysicalColumn | undefined> =>
        (await columnsOf(table)).find((column) => column.name === name);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        for (const table of tables) {
            await dataSource.query(
                `CREATE TABLE "${table}" ("id" varchar PRIMARY KEY NOT NULL, "title" varchar NOT NULL)`,
            );
            await dataSource.query(
                `INSERT INTO "${table}" ("id", "title") VALUES ('r1', 'Existing')`,
            );
        }
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds version NOT NULL DEFAULT 1 and nullable createdByType / createdById to the three tables', async () => {
        await migration.up(dataSource.createQueryRunner());

        for (const table of tables) {
            const version = await columnOf(table, 'version');
            expect(version?.notnull).toBe(1);
            expect(String(version?.dflt_value)).toContain('1');
            expect((await columnOf(table, 'createdByType'))?.notnull).toBe(0);
            expect((await columnOf(table, 'createdById'))?.notnull).toBe(0);
            const [row] = await dataSource.query(
                `SELECT "version", "createdByType", "createdById" FROM "${table}" WHERE "id" = 'r1'`,
            );
            expect(Number(row.version)).toBe(1);
            expect(row.createdByType).toBeNull();
            expect(row.createdById).toBeNull();
        }
    });

    it('is idempotent and skips a missing table', async () => {
        await dataSource.query(`DROP TABLE "missions"`);
        await migration.up(dataSource.createQueryRunner());
        await migration.up(dataSource.createQueryRunner());

        expect(await columnOf('goals', 'version')).toBeDefined();
        expect(await columnOf('work_proposals', 'createdById')).toBeDefined();
    });

    it('down drops the columns and keeps the rows', async () => {
        await migration.up(dataSource.createQueryRunner());
        await migration.down(dataSource.createQueryRunner());

        for (const table of tables) {
            const names = (await columnsOf(table)).map((column) => column.name);
            expect(names).toEqual(['id', 'title']);
            expect(await dataSource.query(`SELECT "id" FROM "${table}"`)).toHaveLength(1);
        }
    });
});
