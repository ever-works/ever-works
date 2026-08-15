import { DataSource } from 'typeorm';
import { FleetRunnerTelemetryAndRouting1785100000000 } from '../1785100000000-FleetRunnerTelemetryAndRouting';

/**
 * Migration test for the fleet local-runner polish schema.
 *
 * Uses the same in-memory better-sqlite3 harness as the sibling
 * migration specs. What matters here is unglamorous but load-bearing:
 *
 *  - existing `fleet_nodes` rows survive with NULL telemetry, which the
 *    heartbeat reads as "this daemon has never reported it" rather than
 *    as an error — that is what keeps older daemons working;
 *  - `fleet_jobs.queuedReason` lands NULL on existing rows, i.e. every
 *    already-queued job reads as "queued normally", not as waiting for a
 *    runner;
 *  - `up()` is idempotent, because the house pattern is forward-only
 *    with per-step guards and re-running must not throw;
 *  - `down()` actually reverses all of it.
 *
 * The `notification_event_types` seed is deliberately NOT exercised: it
 * is Postgres-only SQL (`$1`, `::jsonb`, `ON CONFLICT`) guarded by
 * `hasTable`, and this harness never creates that table — which is
 * exactly the shape it takes on SQLite/CI, where the bootstrap service
 * seeds the row instead.
 */
describe('FleetRunnerTelemetryAndRouting1785100000000', () => {
    let dataSource: DataSource;
    const migration = new FleetRunnerTelemetryAndRouting1785100000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        // The subset of the fleet tables this migration touches.
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL,
                "version" varchar
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status", "version")
             VALUES ('n1', 'u1', 'laptop', 'desktop-node', 'online', '1.0.0')`,
        );
        await dataSource.query(`
            CREATE TABLE "fleet_jobs" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_jobs" ("id", "userId", "kind", "status")
             VALUES ('j1', 'u1', 'agent-task', 'queued')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the node telemetry columns and leaves existing rows NULL', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(
            `SELECT "cliVersion", "diskFreeBytes", "version" FROM "fleet_nodes"`,
        );
        expect(rows).toHaveLength(1);
        // NULL, not '' and not 0: a node that predates the field has
        // never reported it, and 0 free bytes would render as a full disk.
        expect(rows[0].cliVersion).toBeNull();
        expect(rows[0].diskFreeBytes).toBeNull();
        // The daemon version column is untouched — the two are distinct.
        expect(rows[0].version).toBe('1.0.0');
    });

    it('adds fleet_jobs.queuedReason as NULL on existing rows', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(`SELECT "queuedReason" FROM "fleet_jobs"`);
        // An already-queued job is queued normally, not "waiting for a
        // runner" — backfilling a reason would misreport history.
        expect(rows[0].queuedReason).toBeNull();
    });

    it('creates the execution-preference table with both indexes', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        expect(await runner.hasTable('fleet_execution_preferences')).toBe(true);
        const table = await runner.getTable('fleet_execution_preferences');
        expect(table?.findColumnByName('scopeType')).toBeDefined();
        expect(table?.findColumnByName('scopeId')?.isNullable).toBe(true);
        expect(table?.findColumnByName('mode')).toBeDefined();
        const indexNames = (table?.indices ?? []).map((index) => index.name);
        expect(indexNames).toEqual(
            expect.arrayContaining(['idx_fleet_exec_prefs_user', 'idx_fleet_exec_prefs_scope']),
        );
        // Deliberately NOT unique: the account row carries a NULL
        // scopeId, and neither engine treats NULLs as equal — so a unique
        // index would enforce nothing for the row most likely to be
        // double-written while implying that it did.
        const scopeIndex = (table?.indices ?? []).find(
            (index) => index.name === 'idx_fleet_exec_prefs_scope',
        );
        expect(scopeIndex?.isUnique).toBe(false);
    });

    it('is idempotent — re-running up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
    });

    it('down() reverses every step', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        expect(await runner.hasTable('fleet_execution_preferences')).toBe(false);
        const nodes = await runner.getTable('fleet_nodes');
        expect(nodes?.findColumnByName('cliVersion')).toBeUndefined();
        expect(nodes?.findColumnByName('diskFreeBytes')).toBeUndefined();
        const jobs = await runner.getTable('fleet_jobs');
        expect(jobs?.findColumnByName('queuedReason')).toBeUndefined();
        // The pre-existing row survives the round trip.
        const rows = await dataSource.query(`SELECT "id" FROM "fleet_nodes"`);
        expect(rows).toHaveLength(1);
    });

    it('does not explode when the fleet tables do not exist at all', async () => {
        await dataSource.query(`DROP TABLE "fleet_nodes"`);
        await dataSource.query(`DROP TABLE "fleet_jobs"`);
        const runner = dataSource.createQueryRunner();

        await expect(migration.up(runner)).resolves.toBeUndefined();
        // The independent table still lands — a guard on one step must
        // not skip the others.
        expect(await runner.hasTable('fleet_execution_preferences')).toBe(true);
    });
});
