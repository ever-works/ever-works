import { DataSource } from 'typeorm';
import { AddFleetNodeCliVersions1795025000000 } from '../1795025000000-AddFleetNodeCliVersions';

/**
 * Migration test for the pinned model-CLI versions (self-build slice AR).
 *
 * Same in-memory better-sqlite3 harness as `AddFleetNodeHousekeeping.spec.ts`,
 * and for the same reason every schema assertion reads `PRAGMA table_info`
 * — the PHYSICAL schema — rather than the query runner's own metadata,
 * which a raw `DROP COLUMN` can desynchronise.
 */
describe('AddFleetNodeCliVersions1795025000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeCliVersions1795025000000();

    const physicalColumns = async (): Promise<
        Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    > => dataSource.query(`PRAGMA table_info("fleet_nodes")`);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        // The subset of `fleet_nodes` this migration sits next to: the old
        // PATH-scanned `cliVersion` it complements must survive untouched.
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL,
                "cliVersion" varchar(64)
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status", "cliVersion")
             VALUES ('n1', 'u1', 'Office PC', 'desktop-node', 'online', 'claude 1.4.2')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds cliVersions as a nullable text column with no default', async () => {
        await migration.up(dataSource.createQueryRunner());

        const column = (await physicalColumns()).find(
            (candidate) => candidate.name === 'cliVersions',
        );
        expect(column).toBeDefined();
        // The entity's `simple-json` — the same storage `capabilities` uses.
        expect(column?.type.toLowerCase()).toBe('text');
        expect(column?.notnull).toBe(0);
        // NULL is "never reported"; an empty-list default would claim every
        // enrolled machine has no CLI pinned.
        expect(column?.dflt_value).toBeNull();
    });

    it('leaves existing rows NULL and the PATH-scanned cliVersion untouched', async () => {
        await migration.up(dataSource.createQueryRunner());

        const rows = await dataSource.query(
            `SELECT "cliVersions", "cliVersion" FROM "fleet_nodes"`,
        );
        expect(rows).toEqual([{ cliVersions: null, cliVersion: 'claude 1.4.2' }]);
    });

    it('round-trips a JSON list the way the entity stores one', async () => {
        await migration.up(dataSource.createQueryRunner());

        const list = JSON.stringify(['claude-code 2.1.3', 'codex 0.48.0']);
        await dataSource.query(`UPDATE "fleet_nodes" SET "cliVersions" = ? WHERE "id" = 'n1'`, [
            list,
        ]);
        const rows = await dataSource.query(`SELECT "cliVersions" FROM "fleet_nodes"`);
        expect(JSON.parse(rows[0].cliVersions)).toEqual(['claude-code 2.1.3', 'codex 0.48.0']);
    });

    it('is idempotent, and down() removes the column from the physical schema', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        expect(
            (await physicalColumns()).filter((column) => column.name === 'cliVersions'),
        ).toHaveLength(1);

        await migration.down(runner);
        expect((await physicalColumns()).map((column) => column.name)).not.toContain('cliVersions');
        await expect(migration.down(runner)).resolves.toBeUndefined();
        const rows = await dataSource.query(`SELECT "id", "cliVersion" FROM "fleet_nodes"`);
        expect(rows).toEqual([{ id: 'n1', cliVersion: 'claude 1.4.2' }]);
    });

    it('does not explode when fleet_nodes does not exist at all', async () => {
        await dataSource.query(`DROP TABLE "fleet_nodes"`);
        const runner = dataSource.createQueryRunner();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
    });
});
