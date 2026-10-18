import { DataSource } from 'typeorm';
import { AddFleetNodeFavorite1796010100000 } from '../1796010100000-AddFleetNodeFavorite';

/**
 * Migration test for the Fleet hub's favourite mark: `fleet_nodes.isFavorite`.
 * Same in-memory better-sqlite3 harness as `AddFleetModelUsageLimits.spec`,
 * asserting the PHYSICAL schema via PRAGMA.
 */
describe('AddFleetNodeFavorite1796010100000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeFavorite1796010100000();

    const columns = async (): Promise<
        Array<{ name: string; notnull: number; dflt_value: string | null }>
    > => dataSource.query(`PRAGMA table_info("fleet_nodes")`);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar(200) NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name") VALUES ('n1', 'u1', 'build-01')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a NOT NULL isFavorite defaulting to false, existing rows unstarred', async () => {
        await migration.up(dataSource.createQueryRunner());

        const favorite = (await columns()).find((column) => column.name === 'isFavorite');
        expect(favorite?.notnull).toBe(1);
        // better-sqlite3 stores the boolean default as 0.
        expect(['0', 'false']).toContain(String(favorite?.dflt_value).replace(/'/g, ''));

        expect(await dataSource.query(`SELECT "isFavorite" FROM "fleet_nodes"`)).toEqual([
            { isFavorite: 0 },
        ]);
    });

    it('is idempotent and reversible', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        await migration.down(dataSource.createQueryRunner());
        expect((await columns()).some((column) => column.name === 'isFavorite')).toBe(false);
        await expect(migration.down(dataSource.createQueryRunner())).resolves.toBeUndefined();
    });
});
