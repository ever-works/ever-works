import { DataSource } from 'typeorm';
import { CreateFleetCommands1796120000000 } from '../1796120000000-CreateFleetCommands';
import { CreateFleetCommandRuns1796120100000 } from '../1796120100000-CreateFleetCommandRuns';

/**
 * Migration test for FL-12 slots `1796120000000` and `1796120100000` — the
 * in-memory better-sqlite3 harness of the sibling migration specs (CI and the
 * e2e stack run SQLite; production runs Postgres with the same portable DDL).
 *
 * What matters:
 *
 *  - both tables exist with the entity's columns and indexes;
 *  - a run's Command is required (FK CASCADE), its computer is not (no FK on
 *    `nodeId`: the history outlives the computer);
 *  - `(commandId, nodeId, startedAt)` is unique;
 *  - `up()` twice converges and `down()` removes what `up()` added.
 */
describe('CreateFleetCommands1796120000000 + CreateFleetCommandRuns1796120100000', () => {
    let dataSource: DataSource;
    const commands = new CreateFleetCommands1796120000000();
    const runs = new CreateFleetCommandRuns1796120100000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        if (direction === 'up') {
            await commands.up(runner);
            await runs.up(runner);
        } else {
            await runs.down(runner);
            await commands.down(runner);
        }
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
        await dataSource.query('PRAGMA foreign_keys = ON');
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it('creates both tables with the entity columns and indexes', async () => {
        await run('up');
        const commandTable = await table('fleet_commands');
        expect(commandTable?.columns.map((column) => column.name).sort()).toEqual(
            [
                'id',
                'userId',
                'nodeIds',
                'command',
                'commandRedacted',
                'cwd',
                'timeoutSec',
                'cadence',
                'name',
                'enabled',
                'requestedBy',
                'state',
                'lastRunAt',
                'nextRunAt',
                'createdAt',
                'updatedAt',
            ].sort(),
        );
        expect(commandTable?.indices.map((index) => index.name).sort()).toEqual([
            'idx_fleet_commands_user_created',
            'idx_fleet_commands_user_state',
        ]);
        const runTable = await table('fleet_command_runs');
        expect(runTable?.columns.map((column) => column.name).sort()).toEqual(
            [
                'id',
                'commandId',
                'nodeId',
                'startedAt',
                'endedAt',
                'exitCode',
                'status',
                'failedReason',
                'errorCode',
                'errorHint',
                'outputHead',
                'outputTail',
                'truncated',
                'capped',
                'outputBytes',
                'outputRef',
                'createdAt',
                'updatedAt',
            ].sort(),
        );
        expect(runTable?.indices.map((index) => index.name).sort()).toEqual([
            'idx_fleet_command_runs_node_started',
            'idx_fleet_command_runs_status',
            'uq_fleet_command_runs_command_node_started',
        ]);
        expect(runTable?.foreignKeys.map((key) => key.columnNames.join(','))).toEqual([
            'commandId',
        ]);
    });

    it('needs the Command but not the computer, and cascades from the Command', async () => {
        await run('up');
        await dataSource.query(
            `INSERT INTO "fleet_commands" ("id", "userId", "nodeIds", "command") VALUES ('c1', 'u1', '["n-gone"]', 'uptime')`,
        );
        await dataSource.query(
            `INSERT INTO "fleet_command_runs" ("id", "commandId", "nodeId", "startedAt") VALUES ('r1', 'c1', 'n-gone', '2026-10-21 10:00:00')`,
        );
        await expect(
            dataSource.query(
                `INSERT INTO "fleet_command_runs" ("id", "commandId", "nodeId", "startedAt") VALUES ('r2', 'c-missing', 'n1', '2026-10-21 10:00:00')`,
            ),
        ).rejects.toThrow();
        await expect(
            dataSource.query(
                `INSERT INTO "fleet_command_runs" ("id", "commandId", "nodeId", "startedAt") VALUES ('r3', 'c1', 'n-gone', '2026-10-21 10:00:00')`,
            ),
        ).rejects.toThrow();
        const [row] = await dataSource.query(
            `SELECT * FROM "fleet_command_runs" WHERE "id" = 'r1'`,
        );
        expect(row.status).toBe('running');
        expect(Number(row.outputBytes)).toBe(0);
        await dataSource.query(`DELETE FROM "fleet_commands" WHERE "id" = 'c1'`);
        const left = await dataSource.query(`SELECT COUNT(*) AS "count" FROM "fleet_command_runs"`);
        expect(Number(left[0].count)).toBe(0);
    });

    it('converges when applied twice and rolls back cleanly', async () => {
        await run('up');
        await run('up');
        expect(await table('fleet_commands')).toBeDefined();
        await run('down');
        expect(await table('fleet_command_runs')).toBeUndefined();
        expect(await table('fleet_commands')).toBeUndefined();
    });
});
