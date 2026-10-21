import { DataSource } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { FleetNode, FleetNodeHealthSample } from '@ever-works/agent/entities';
import { CreateFleetNodeHealthSamples1796030000000 } from '../1796030000000-CreateFleetNodeHealthSamples';
import { AddFleetNodeWakeFields1796030100000 } from '../1796030100000-AddFleetNodeWakeFields';

/**
 * Computer health (FL-03) — the two CONTRACTS §13 slots, both shipped in P1.
 *
 * Asserted against the PHYSICAL sqlite schema (PRAGMA) and against the
 * ENTITY's own metadata built from the `ENTITIES` inventory the API boots
 * with: dev and stage run `synchronize` from the entities while production
 * runs these files, so the two must produce exactly the same columns.
 */
describe('FL-03 migrations', () => {
    let dataSource: DataSource;

    const columns = async (
        table: string,
    ): Promise<Array<{ name: string; notnull: number; dflt_value: string | null; type: string }>> =>
        dataSource.query(`PRAGMA table_info("${table}")`);

    const indexes = async (table: string): Promise<Array<{ name: string; unique: number }>> =>
        dataSource.query(`PRAGMA index_list("${table}")`);

    async function entityColumns(
        target: Function,
    ): Promise<Array<{ name: string; nullable: boolean }>> {
        const metadataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: false,
        });
        await metadataSource.initialize();
        try {
            return metadataSource.getMetadata(target).columns.map((column) => ({
                name: column.databaseName,
                nullable: column.isNullable,
            }));
        } finally {
            await metadataSource.destroy();
        }
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

    describe('1796030000000-CreateFleetNodeHealthSamples', () => {
        const migration = new CreateFleetNodeHealthSamples1796030000000();

        it('creates the table with EXACTLY the columns the entity declares, nullability included', async () => {
            await migration.up(dataSource.createQueryRunner());
            const physical = (await columns('fleet_node_health_samples'))
                .map((column) => ({ name: column.name, nullable: column.notnull === 0 }))
                .sort((a, b) => a.name.localeCompare(b.name));
            const declared = (await entityColumns(FleetNodeHealthSample)).sort((a, b) =>
                a.name.localeCompare(b.name),
            );
            // The id is the primary key; sqlite reports a PK as nullable unless declared NOT NULL.
            const withoutId = (list: Array<{ name: string; nullable: boolean }>) =>
                list.filter((column) => column.name !== 'id');
            expect(physical.map((column) => column.name)).toEqual(
                declared.map((column) => column.name),
            );
            expect(withoutId(physical)).toEqual(withoutId(declared));
        });

        it('carries the CONTRACTS §4.5 (revision 3) columns, peaks included', async () => {
            await migration.up(dataSource.createQueryRunner());
            const names = (await columns('fleet_node_health_samples')).map((column) => column.name);
            for (const name of [
                'nodeId',
                'at',
                'resolution',
                'cpuPercent',
                'memPercent',
                'memTotalMiB',
                'diskPercent',
                'diskFreeMiB',
                'loadAvg1',
                'uptimeSec',
                'gpu',
                'pendingReboot',
                'failedServices',
                'cpuMax',
                'memMax',
                'diskMax',
            ]) {
                expect(names).toContain(name);
            }
        });

        it('makes (nodeId, resolution, at) unique — the property that makes a re-run roll-up a no-op', async () => {
            await migration.up(dataSource.createQueryRunner());
            const list = await indexes('fleet_node_health_samples');
            expect(
                list.find((index) => index.name === 'uq_fleet_node_health_samples_node_res_at')
                    ?.unique,
            ).toBe(1);
            expect(
                list.some((index) => index.name === 'idx_fleet_node_health_samples_res_at'),
            ).toBe(true);

            const insert = () =>
                dataSource.query(
                    `INSERT INTO "fleet_node_health_samples" ("id", "nodeId", "at", "resolution", "cpuPercent")
                     VALUES (lower(hex(randomblob(16))), '11111111-1111-4111-8111-111111111111', '2026-10-18 09:00:00', 'hourly', 31)`,
                );
            await insert();
            await expect(insert()).rejects.toThrow(/UNIQUE/i);
        });

        it('is idempotent, and forward-only: down keeps the table and its rows', async () => {
            await migration.up(dataSource.createQueryRunner());
            await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
            await dataSource.query(
                `INSERT INTO "fleet_node_health_samples" ("id", "nodeId", "at", "resolution")
                 VALUES ('s1', '11111111-1111-4111-8111-111111111111', '2026-10-18 09:00:00', 'raw')`,
            );
            await migration.down(dataSource.createQueryRunner());
            expect(await dataSource.query(`SELECT "id" FROM "fleet_node_health_samples"`)).toEqual([
                { id: 's1' },
            ]);
        });
    });

    describe('1796030100000-AddFleetNodeWakeFields', () => {
        const migration = new AddFleetNodeWakeFields1796030100000();
        const ADDED = ['health', 'macAddress', 'lanId', 'lastWakeAttemptAt'];

        it('adds the four nullable columns, leaving existing rows NULL (no backfill)', async () => {
            await migration.up(dataSource.createQueryRunner());
            const physical = await columns('fleet_nodes');
            for (const name of ADDED) {
                const column = physical.find((candidate) => candidate.name === name);
                expect(column?.notnull).toBe(0);
                expect(column?.dflt_value).toBeNull();
            }
            expect(
                await dataSource.query(
                    `SELECT "health", "macAddress", "lanId", "lastWakeAttemptAt" FROM "fleet_nodes"`,
                ),
            ).toEqual([{ health: null, macAddress: null, lanId: null, lastWakeAttemptAt: null }]);
        });

        it('adds exactly what the FleetNode entity declares for those four', async () => {
            const declared = await entityColumns(FleetNode);
            for (const name of ADDED) {
                expect(declared.find((column) => column.name === name)).toEqual({
                    name,
                    nullable: true,
                });
            }
        });

        it('converges on a partially applied database, and is forward-only', async () => {
            // An interrupted earlier run that added only the first column.
            await dataSource.query(`ALTER TABLE "fleet_nodes" ADD COLUMN "health" text`);
            await dataSource.query(`UPDATE "fleet_nodes" SET "health" = '{"at":"x"}'`);
            await migration.up(dataSource.createQueryRunner());
            await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
            const names = (await columns('fleet_nodes')).map((column) => column.name);
            expect(ADDED.every((name) => names.includes(name))).toBe(true);
            await migration.down(dataSource.createQueryRunner());
            expect(await dataSource.query(`SELECT "health" FROM "fleet_nodes"`)).toEqual([
                { health: '{"at":"x"}' },
            ]);
        });
    });
});
