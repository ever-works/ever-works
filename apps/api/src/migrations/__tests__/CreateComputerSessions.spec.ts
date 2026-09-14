import { DataSource } from 'typeorm';
import { CreateComputerSessions1791110000000 } from '../1791110000000-CreateComputerSessions';

/**
 * Migration test for the live-view tables and the node control columns.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters:
 *
 *  - an existing machine backfills to the most private settings: owner-only
 *    control, no watch recording, 14-day retention, and NOBODY holding the
 *    control lock;
 *  - exactly one profile per (Node, Agent) — the unique index is the
 *    isolation guarantee;
 *  - `up()` is idempotent and `down()` removes exactly what `up()` added,
 *    leaving the pre-existing node row intact.
 */
describe('CreateComputerSessions1791110000000', () => {
    let dataSource: DataSource;
    const migration = new CreateComputerSessions1791110000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        // The tables the foreign keys point at (sqlite refuses a key to a
        // table that does not exist when it rebuilds the referencing table).
        for (const table of ['users', 'agents', 'agent_runs']) {
            await dataSource.query(`CREATE TABLE "${table}" ("id" varchar PRIMARY KEY NOT NULL)`);
        }
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
        await dataSource.query(`INSERT INTO "agents" ("id") VALUES ('a1')`);
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL,
                "kind" varchar NOT NULL,
                "status" varchar NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name", "kind", "status")
             VALUES ('n1', 'u1', 'studio', 'desktop-node', 'online')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('backfills every existing node to owner-only control with no holder', async () => {
        await run('up');

        const [row] = await dataSource.query(
            `SELECT "controlPolicy", "recordWatchSessions", "recordingRetentionDays",
                    "controlHolderUserId", "controlHolderSessionId", "controlHeldSince", "controlExpiresAt", "name"
             FROM "fleet_nodes"`,
        );
        expect(row.controlPolicy).toBe('owner');
        expect(Number(row.recordWatchSessions)).toBe(0);
        expect(row.recordingRetentionDays).toBe(14);
        expect(row.controlHolderUserId).toBeNull();
        expect(row.controlHolderSessionId).toBeNull();
        expect(row.controlHeldSince).toBeNull();
        expect(row.controlExpiresAt).toBeNull();
        expect(row.name).toBe('studio');
    });

    it('creates both tables with their indexes', async () => {
        await run('up');

        const runner = dataSource.createQueryRunner();
        const sessions = await runner.getTable('computer_sessions');
        const profiles = await runner.getTable('node_agent_profiles');
        await runner.release();

        expect(sessions?.indices.map((index) => index.name).sort()).toEqual([
            'idx_computer_sessions_agent',
            'idx_computer_sessions_node_status',
            'idx_computer_sessions_run',
            'idx_computer_sessions_user_status',
        ]);
        const unique = profiles?.indices.find(
            (index) => index.name === 'uq_node_agent_profiles_node_agent',
        );
        expect(unique?.isUnique).toBe(true);
        expect(unique?.columnNames).toEqual(['nodeId', 'agentId']);
        expect(sessions?.findColumnByName('bytesOut')).toBeDefined();
        // No column anywhere that could hold a path on the machine.
        expect(profiles?.columns.map((column) => column.name)).not.toContain('path');
    });

    it('refuses a second profile for the same Agent on the same Node', async () => {
        await run('up');
        const insert = (id: string) =>
            dataSource.query(
                `INSERT INTO "node_agent_profiles" ("id", "userId", "nodeId", "agentId", "profileKey")
                 VALUES ('${id}', 'u1', 'n1', 'a1', 'key-${id}')`,
            );
        await insert('p1');
        await expect(insert('p2')).rejects.toThrow();
    });

    it('defaults a new session to a requested, sharp screen view', async () => {
        await run('up');
        await dataSource.query(
            `INSERT INTO "computer_sessions" ("id", "userId", "agentId", "nodeId", "openedByUserId", "channels")
             VALUES ('s1', 'u1', 'a1', 'n1', 'u1', '["screen"]')`,
        );
        const [row] = await dataSource.query(
            `SELECT "status", "quality", "activeChannel", "frameCount", "bytesOut", "recorded" FROM "computer_sessions"`,
        );
        expect(row).toMatchObject({
            status: 'requested',
            quality: 'sharp',
            activeChannel: 'screen',
            frameCount: 0,
        });
        expect(Number(row.bytesOut)).toBe(0);
        expect(Number(row.recorded)).toBe(0);
    });

    it('is idempotent', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
    });

    it('down() removes exactly what up() added', async () => {
        await run('up');
        await run('down');

        const runner = dataSource.createQueryRunner();
        expect(await runner.hasTable('computer_sessions')).toBe(false);
        expect(await runner.hasTable('node_agent_profiles')).toBe(false);
        const nodes = await runner.getTable('fleet_nodes');
        await runner.release();
        expect(nodes?.columns.map((column) => column.name).sort()).toEqual([
            'id',
            'kind',
            'name',
            'status',
            'userId',
        ]);
        const [row] = await dataSource.query(`SELECT "name" FROM "fleet_nodes"`);
        expect(row.name).toBe('studio');
    });
});
