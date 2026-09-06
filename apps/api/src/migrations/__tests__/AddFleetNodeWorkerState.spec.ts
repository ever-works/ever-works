import { DataSource } from 'typeorm';
import { AddFleetNodeWorkerState1788900000000 } from '../1788900000000-AddFleetNodeWorkerState';

/**
 * Migration test for the fleet health-signal schema (EW-776).
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters here is unglamorous and load-bearing:
 *
 *  - every new column lands NULLABLE and NULL on existing rows. `NULL`
 *    is the honest backfill — an already-enrolled node genuinely has
 *    never reported a worker state, and a `'idle'` default would state
 *    in the schema the exact fabrication the slice exists to end;
 *  - the notice dedup markers start unset, so the first outage after an
 *    upgrade notifies rather than being silently pre-deduped;
 *  - `up()` is idempotent, because the house pattern is forward-only
 *    with per-step guards and a partially-applied database must converge;
 *  - `down()` reverses all of it and leaves the row itself intact.
 */
describe('AddFleetNodeWorkerState1788900000000', () => {
    let dataSource: DataSource;
    const migration = new AddFleetNodeWorkerState1788900000000();

    const NEW_COLUMNS = [
        'workerState',
        'workerStateReason',
        'workerStateChangedAt',
        'offlineNoticedAt',
        'offlineLongNoticedAt',
        'quarantineNoticedAt',
    ];

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        // The subset of `fleet_nodes` this migration touches.
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL,
                "lastHeartbeatAt" datetime
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status", "lastHeartbeatAt")
             VALUES ('n1', 'u1', 'Office PC', 'desktop-node', 'online', '2026-09-01 10:00:00')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds every worker-state and notice-marker column as nullable', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('fleet_nodes');
        for (const name of NEW_COLUMNS) {
            expect(table?.findColumnByName(name)?.isNullable).toBe(true);
        }
    });

    it('leaves existing rows NULL rather than inventing a state for them', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const rows = await dataSource.query(
            `SELECT "workerState", "workerStateReason", "workerStateChangedAt",
                    "offlineNoticedAt", "offlineLongNoticedAt", "quarantineNoticedAt",
                    "status", "lastHeartbeatAt"
             FROM "fleet_nodes"`,
        );
        expect(rows).toHaveLength(1);
        // NULL, not 'idle': a machine we have never heard from about its
        // worker is UNKNOWN, and the UI says so.
        expect(rows[0].workerState).toBeNull();
        expect(rows[0].workerStateReason).toBeNull();
        expect(rows[0].workerStateChangedAt).toBeNull();
        // The dedup markers start unset, so the first outage after the
        // upgrade actually notifies.
        expect(rows[0].offlineNoticedAt).toBeNull();
        expect(rows[0].offlineLongNoticedAt).toBeNull();
        expect(rows[0].quarantineNoticedAt).toBeNull();
        // Existing registry facts are untouched.
        expect(rows[0].status).toBe('online');
        expect(rows[0].lastHeartbeatAt).toBe('2026-09-01 10:00:00');
    });

    it('creates the (status, lastHeartbeatAt) index the sweep reads', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('fleet_nodes');
        const index = (table?.indices ?? []).find(
            (candidate) => candidate.name === 'idx_fleet_nodes_status_heartbeat',
        );
        expect(index).toBeDefined();
        expect(index?.columnNames).toEqual(['status', 'lastHeartbeatAt']);
    });

    it('is idempotent — re-running up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
    });

    it('down() drops every column and the index, and keeps the row', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        const table = await runner.getTable('fleet_nodes');
        for (const name of NEW_COLUMNS) {
            expect(table?.findColumnByName(name)).toBeUndefined();
        }
        expect(
            (table?.indices ?? []).some(
                (index) => index.name === 'idx_fleet_nodes_status_heartbeat',
            ),
        ).toBe(false);
        const rows = await dataSource.query(`SELECT "id", "status" FROM "fleet_nodes"`);
        expect(rows).toEqual([{ id: 'n1', status: 'online' }]);
    });

    it('down() is safe to re-run', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await expect(migration.down(runner)).resolves.toBeUndefined();
    });

    it('does not explode when fleet_nodes does not exist at all', async () => {
        // A stripped-down or not-yet-created schema must converge, not abort
        // — the API self-applies migrations on every boot.
        await dataSource.query(`DROP TABLE "fleet_nodes"`);
        const runner = dataSource.createQueryRunner();

        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
    });
});
