import { DataSource } from 'typeorm';
import { AddFleetNodeConsents1796020000000 } from '../1796020000000-AddFleetNodeConsents';

/**
 * Migration test for the node link's consents (FL-02): `fleet_nodes.consents`
 * and `fleet_nodes.previewProfileEnabled`. Same in-memory better-sqlite3
 * harness as `AddFleetModelUsageLimits.spec`, asserting the PHYSICAL schema
 * via PRAGMA.
 */
describe('AddFleetNodeConsents1796020000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeConsents1796020000000();

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
            `INSERT INTO "fleet_nodes" ("id", "userId", "name") VALUES ('n1', 'u1', 'build-01')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable text consents and a NOT NULL previewProfileEnabled defaulting to false', async () => {
        await migration.up(dataSource.createQueryRunner());

        const consents = (await columns()).find((column) => column.name === 'consents');
        expect(consents?.type.toLowerCase()).toBe('text');
        expect(consents?.notnull).toBe(0);
        expect(consents?.dflt_value).toBeNull();
        const preview = (await columns()).find((column) => column.name === 'previewProfileEnabled');
        expect(preview?.notnull).toBe(1);
        // better-sqlite3 stores a boolean default as 0.
        expect(['0', 'false']).toContain(String(preview?.dflt_value).toLowerCase());

        // An existing row: consents never reported, preview off.
        const [row] = await dataSource.query(
            `SELECT "consents", "previewProfileEnabled" FROM "fleet_nodes"`,
        );
        expect(row.consents).toBeNull();
        expect(Number(row.previewProfileEnabled)).toBe(0);
    });

    it('stores the simple-json consents the entity writes', async () => {
        await migration.up(dataSource.createQueryRunner());
        const value = JSON.stringify({ work: true, attend: false, manage: true, usageScan: false });
        await dataSource.query(`UPDATE "fleet_nodes" SET "consents" = ? WHERE "id" = 'n1'`, [
            value,
        ]);
        const [row] = await dataSource.query(`SELECT "consents" FROM "fleet_nodes"`);
        expect(JSON.parse(row.consents)).toEqual({
            work: true,
            attend: false,
            manage: true,
            usageScan: false,
        });
    });

    it('converges from a half-applied database and is reversible', async () => {
        // Only the first column landed before an interruption.
        await dataSource.query(`ALTER TABLE "fleet_nodes" ADD COLUMN "consents" text`);
        await migration.up(dataSource.createQueryRunner());
        expect((await columns()).some((column) => column.name === 'previewProfileEnabled')).toBe(
            true,
        );
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();

        await migration.down(dataSource.createQueryRunner());
        const names = (await columns()).map((column) => column.name);
        expect(names).not.toContain('consents');
        expect(names).not.toContain('previewProfileEnabled');
        await expect(migration.down(dataSource.createQueryRunner())).resolves.toBeUndefined();
    });
});
