import { DataSource } from 'typeorm';
import { CreateFleetCommands1796120000000 } from '../1796120000000-CreateFleetCommands';
import { CreateFleetCommandRuns1796120100000 } from '../1796120100000-CreateFleetCommandRuns';
import { AddFleetCommandCadence1796130000000 } from '../1796130000000-AddFleetCommandCadence';
import { AddFleetNodeTimeZone1796130100000 } from '../1796130100000-AddFleetNodeTimeZone';

/**
 * Migration test for FL-13 slots `1796130000000` and `1796130100000` on the
 * in-memory better-sqlite3 harness of the sibling specs (production runs
 * Postgres with the same portable DDL).
 *
 *  - the schedule-state columns land on `fleet_commands`, `scheduledFor` on
 *    `fleet_command_runs`, `timeZone` on `fleet_nodes`, with both indexes;
 *  - existing rows keep their values and read the defaults;
 *  - `up()` twice converges (per-step guards).
 */
describe('AddFleetCommandCadence1796130000000 + AddFleetNodeTimeZone1796130100000', () => {
    let dataSource: DataSource;

    const runUp = async () => {
        const runner = dataSource.createQueryRunner();
        await new CreateFleetCommands1796120000000().up(runner);
        await new CreateFleetCommandRuns1796120100000().up(runner);
        await new AddFleetCommandCadence1796130000000().up(runner);
        await new AddFleetNodeTimeZone1796130100000().up(runner);
        await runner.release();
    };

    const table = async (name: string) => {
        const runner = dataSource.createQueryRunner();
        const found = await runner.getTable(name);
        await runner.release();
        return found;
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`CREATE TABLE "fleet_nodes" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
        await dataSource.query(`INSERT INTO "fleet_nodes" ("id") VALUES ('n1')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it('adds the schedule columns, the run fire time, the node zone and both indexes', async () => {
        await runUp();
        const commands = await table('fleet_commands');
        for (const name of [
            'pausedAt',
            'pausedReason',
            'syncGeneration',
            'syncedGeneration',
            'deletedAt',
        ]) {
            expect(commands?.findColumnByName(name)).toBeDefined();
        }
        expect(commands?.indices.map((index) => index.name)).toContain(
            'idx_fleet_commands_schedule',
        );
        const runs = await table('fleet_command_runs');
        expect(runs?.findColumnByName('scheduledFor')?.isNullable).toBe(true);
        expect(runs?.indices.map((index) => index.name)).toContain(
            'idx_fleet_command_runs_scheduled',
        );
        const nodes = await table('fleet_nodes');
        expect(nodes?.findColumnByName('timeZone')?.isNullable).toBe(true);
    });

    it('keeps an existing Command and reads the defaults', async () => {
        const runner = dataSource.createQueryRunner();
        await new CreateFleetCommands1796120000000().up(runner);
        await runner.release();
        await dataSource.query(
            `INSERT INTO "fleet_commands" ("id", "userId", "nodeIds", "command") VALUES ('c1', 'u1', '["n1"]', 'uptime')`,
        );
        await runUp();
        const [row] = await dataSource.query(
            `SELECT "command", "syncGeneration", "syncedGeneration", "pausedAt", "deletedAt" FROM "fleet_commands"`,
        );
        expect(row).toMatchObject({
            command: 'uptime',
            syncGeneration: 0,
            syncedGeneration: 0,
            pausedAt: null,
        });
        expect(row.deletedAt).toBeNull();
    });

    it('converges when applied twice', async () => {
        await runUp();
        await expect(runUp()).resolves.toBeUndefined();
    });
});
