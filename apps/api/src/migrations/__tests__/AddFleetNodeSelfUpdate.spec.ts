import { DataSource } from 'typeorm';
import { AddFleetNodeSelfUpdate1796020100000 } from '../1796020100000-AddFleetNodeSelfUpdate';

/**
 * Migration test for the node's self-update report (FL-02 T-25):
 * `fleet_nodes.selfUpdate`. In-memory better-sqlite3, asserting the PHYSICAL
 * schema via PRAGMA, like `AddFleetNodeConsents.spec`.
 */
describe('AddFleetNodeSelfUpdate1796020100000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeSelfUpdate1796020100000();

    const columns = async (): Promise<
        Array<{ name: string; notnull: number; dflt_value: string | null; type: string }>
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
            `INSERT INTO "fleet_nodes" ("id", "userId", "name") VALUES ('n1', 'u1', 'build-02')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable text selfUpdate; an existing row reads never reported', async () => {
        await migration.up(dataSource.createQueryRunner());
        const column = (await columns()).find((entry) => entry.name === 'selfUpdate');
        expect(column?.type.toLowerCase()).toBe('text');
        expect(column?.notnull).toBe(0);
        expect(column?.dflt_value).toBeNull();
        const [row] = await dataSource.query(`SELECT "selfUpdate" FROM "fleet_nodes"`);
        expect(row.selfUpdate).toBeNull();
    });

    it('applies twice without error (a partially applied database converges)', async () => {
        await migration.up(dataSource.createQueryRunner());
        await migration.up(dataSource.createQueryRunner());
        expect((await columns()).filter((entry) => entry.name === 'selfUpdate')).toHaveLength(1);
    });

    it('reverts cleanly, and a revert on a database without the column is a no-op', async () => {
        await migration.up(dataSource.createQueryRunner());
        await migration.down(dataSource.createQueryRunner());
        expect((await columns()).some((entry) => entry.name === 'selfUpdate')).toBe(false);
        await migration.down(dataSource.createQueryRunner());
    });
});
