import { DataSource } from 'typeorm';
import { AddWorkUpstreamSyncRelease1796500000000 } from '../1796500000000-AddWorkUpstreamSyncRelease';

/** APW-02 T46/T47 — three nullable, default-free columns on `work_upstream_states`. */
describe('AddWorkUpstreamSyncRelease1796500000000', () => {
    let dataSource: DataSource;
    const migration = new AddWorkUpstreamSyncRelease1796500000000();
    const COLUMNS = ['syncPullRequestCheckedAt', 'workflowHold', 'workflowRelease'];

    async function columns(): Promise<Array<{ name: string; notnull: number; dflt_value: string | null }>> {
        return (await dataSource.query(`PRAGMA table_info("work_upstream_states")`)) as Array<{
            name: string;
            notnull: number;
            dflt_value: string | null;
        }>;
    }

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "work_upstream_states" (
                "id" varchar PRIMARY KEY NOT NULL,
                "workId" varchar NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "work_upstream_states" ("id", "workId") VALUES ('s1', 'w1')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the three columns nullable and default-free, rows untouched', async () => {
        await migration.up(dataSource.createQueryRunner());

        const added = (await columns()).filter((column) => COLUMNS.includes(column.name));
        expect(added.map((column) => column.name).sort()).toEqual([...COLUMNS].sort());
        for (const column of added) {
            expect(column.notnull).toBe(0);
            expect(column.dflt_value).toBeNull();
        }
        expect(
            await dataSource.query(
                `SELECT "syncPullRequestCheckedAt", "workflowHold", "workflowRelease" FROM "work_upstream_states"`,
            ),
        ).toEqual([{ syncPullRequestCheckedAt: null, workflowHold: null, workflowRelease: null }]);
    });

    it('is idempotent and reversible, and a no-op without the table', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        await migration.down(dataSource.createQueryRunner());
        expect((await columns()).some((column) => COLUMNS.includes(column.name))).toBe(false);
        await expect(migration.down(dataSource.createQueryRunner())).resolves.toBeUndefined();

        await dataSource.query(`DROP TABLE "work_upstream_states"`);
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
    });
});
