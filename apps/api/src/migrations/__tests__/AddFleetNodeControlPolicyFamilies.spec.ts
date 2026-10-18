import { DataSource } from 'typeorm';
import { effectiveControlPolicy } from '@ever-works/contracts';
import { AddFleetNodeControlPolicyFamilies1796010000000 } from '../1796010000000-AddFleetNodeControlPolicyFamilies';

/**
 * Migration test for the Fleet hub's per-family control policy:
 * `fleet_nodes.controlPolicyFamilies`. Same in-memory better-sqlite3
 * harness as `AddFleetModelUsageLimits.spec`, asserting the PHYSICAL schema
 * via PRAGMA, plus the read-through that makes a data backfill unnecessary.
 */
describe('AddFleetNodeControlPolicyFamilies1796010000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeControlPolicyFamilies1796010000000();

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
                "name" varchar(200) NOT NULL,
                "controlPolicy" varchar(24) NOT NULL DEFAULT ('owner')
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "controlPolicy") VALUES ('n1', 'u1', 'build-01', 'org-admins')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a nullable controlPolicyFamilies with no default and leaves controlPolicy untouched', async () => {
        await migration.up(dataSource.createQueryRunner());

        const families = (await columns()).find(
            (column) => column.name === 'controlPolicyFamilies',
        );
        expect(families?.notnull).toBe(0);
        expect(families?.dflt_value).toBeNull();

        const [row] = await dataSource.query(
            `SELECT "controlPolicy", "controlPolicyFamilies" FROM "fleet_nodes"`,
        );
        expect(row).toEqual({ controlPolicy: 'org-admins', controlPolicyFamilies: null });
    });

    it('reads an existing legacy value as the desktop family with no backfill (ACC-FL01-15)', async () => {
        await migration.up(dataSource.createQueryRunner());
        const [row] = await dataSource.query(
            `SELECT "controlPolicy", "controlPolicyFamilies" FROM "fleet_nodes"`,
        );
        const policy = effectiveControlPolicy(row);
        expect(policy.desktop).toBe('org-admins');
        expect(policy.view).toBe('org-members');
        expect(policy.services).toBe('owner');
    });

    it('is idempotent and reversible', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        await migration.down(dataSource.createQueryRunner());
        expect((await columns()).some((column) => column.name === 'controlPolicyFamilies')).toBe(
            false,
        );
        expect((await columns()).some((column) => column.name === 'controlPolicy')).toBe(true);
        await expect(migration.down(dataSource.createQueryRunner())).resolves.toBeUndefined();
    });
});
