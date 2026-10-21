import { DataSource } from 'typeorm';
import { CreateFleetSessions1796040000000 } from '../1796040000000-CreateFleetSessions';

/**
 * Migration test for FL-04 slot `1796040000000` — the same in-memory
 * better-sqlite3 harness as the sibling migration specs (CI and the e2e
 * stack run SQLite; production runs Postgres with the same portable DDL).
 *
 * What matters:
 *
 *  - `fleet_sessions` exists with exactly the entity's columns and indexes,
 *    and `(nodeId, daemonSessionId)` is unique — how a node's facts find
 *    their row;
 *  - an existing Run transcript chunk survives untouched; a chunk keyed by a
 *    session only saves; a chunk with neither key is refused (CONTRACTS R-9);
 *  - `fleet_nodes` gains `sessionDaemon`, and an existing node keeps its data;
 *  - `up()` is idempotent (a partially applied database converges) and
 *    `down()` removes what `up()` added without deleting a recording.
 */
describe('CreateFleetSessions1796040000000', () => {
    let dataSource: DataSource;
    const migration = new CreateFleetSessions1796040000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    const table = async (name: string) => {
        const runner = dataSource.createQueryRunner();
        const found = await runner.getTable(name);
        await runner.release();
        return found;
    };

    const insertSession = (id: string, daemonSessionId: string, extra = '') =>
        dataSource.query(
            `INSERT INTO "fleet_sessions" ("id", "nodeId", "userId", "kind", "provider", "cwd", "title", "daemonSessionId", "startedBy"${extra ? ', ' + extra.split('=')[0] : ''})
             VALUES ('${id}', 'n1', 'u1', 'owner', 'shell', '/home/dana', '~', '${daemonSessionId}', 'user:u1'${extra ? `, '${extra.split('=')[1]}'` : ''})`,
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = ON');
        for (const name of ['users', 'agents', 'agent_runs']) {
            await dataSource.query(`CREATE TABLE "${name}" ("id" varchar PRIMARY KEY NOT NULL)`);
        }
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
        await dataSource.query(`INSERT INTO "agents" ("id") VALUES ('a1')`);
        await dataSource.query(`INSERT INTO "agent_runs" ("id") VALUES ('r1')`);
        await dataSource.query(`
            CREATE TABLE "fleet_nodes" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "name" varchar NOT NULL
            )
        `);
        await dataSource.query(
            `INSERT INTO "fleet_nodes" ("id", "userId", "name") VALUES ('n1', 'u1', 'build-01')`,
        );
        // The transcript table exactly as `1784300000000` created it.
        await dataSource.query(`
            CREATE TABLE "terminal_transcript_chunks" (
                "id" varchar PRIMARY KEY NOT NULL,
                "runId" varchar NOT NULL,
                "seq" integer NOT NULL,
                "direction" varchar(8) NOT NULL DEFAULT ('out'),
                "text" text NOT NULL,
                "byteLength" integer NOT NULL DEFAULT (0),
                "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                CONSTRAINT "fk_terminal_transcript_chunks_run" FOREIGN KEY ("runId") REFERENCES "agent_runs" ("id") ON DELETE CASCADE
            )
        `);
        await dataSource.query(
            `CREATE UNIQUE INDEX "idx_terminal_transcript_chunks_run_seq" ON "terminal_transcript_chunks" ("runId", "seq")`,
        );
        await dataSource.query(
            `INSERT INTO "terminal_transcript_chunks" ("id", "runId", "seq", "text") VALUES ('c1', 'r1', 0, 'hello')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates fleet_sessions with the entity columns and indexes', async () => {
        await run('up');
        const sessions = await table('fleet_sessions');
        expect(sessions?.columns.map((column) => column.name).sort()).toEqual(
            [
                'id',
                'nodeId',
                'userId',
                'organizationId',
                'kind',
                'provider',
                'agentId',
                'agentRunId',
                'checkoutId',
                'cwd',
                'title',
                'state',
                'outcome',
                'daemonSessionId',
                'providerSessionId',
                'firstMessage',
                'lastScreen',
                'restartOfSessionId',
                'startedBy',
                'lastActivityAt',
                'startedAt',
                'endedAt',
                'endedReason',
                'exitCode',
                'recordingState',
                'createdAt',
                'updatedAt',
            ].sort(),
        );
        expect(sessions?.indices.map((index) => index.name).sort()).toEqual([
            'idx_fleet_sessions_node_state',
            'idx_fleet_sessions_org_state',
            'idx_fleet_sessions_user_state_activity',
            'uq_fleet_sessions_agent_run',
            'uq_fleet_sessions_node_daemon',
        ]);
        expect(sessions?.foreignKeys.map((key) => key.name).sort()).toEqual([
            'fk_fleet_sessions_agent',
            'fk_fleet_sessions_node',
            'fk_fleet_sessions_restart_of',
            'fk_fleet_sessions_run',
            'fk_fleet_sessions_user',
        ]);
    });

    it('defaults a new session to starting, not recording', async () => {
        await run('up');
        await insertSession('s1', 'd1');
        const [row] = await dataSource.query(
            `SELECT "state", "recordingState", "endedReason", "exitCode" FROM "fleet_sessions"`,
        );
        expect(row).toEqual({
            state: 'starting',
            recordingState: 'off',
            endedReason: null,
            exitCode: null,
        });
    });

    it('refuses a second session with the same daemon id on the same node', async () => {
        await run('up');
        await insertSession('s1', 'd1');
        await expect(insertSession('s2', 'd1')).rejects.toThrow();
    });

    it('allows many sessions without a Run but only one session per Run', async () => {
        await run('up');
        await insertSession('s1', 'd1');
        await insertSession('s2', 'd2');
        await insertSession('s3', 'd3', 'agentRunId=r1');
        await expect(insertSession('s4', 'd4', 'agentRunId=r1')).rejects.toThrow();
    });

    it('adds the session key to transcripts without touching a Run chunk', async () => {
        await run('up');
        const [existing] = await dataSource.query(
            `SELECT "runId", "seq", "text", "fleetSessionId" FROM "terminal_transcript_chunks" WHERE "id" = 'c1'`,
        );
        expect(existing).toEqual({ runId: 'r1', seq: 0, text: 'hello', fleetSessionId: null });

        await insertSession('s1', 'd1');
        await dataSource.query(
            `INSERT INTO "terminal_transcript_chunks" ("id", "fleetSessionId", "seq", "text") VALUES ('c2', 's1', 0, 'a session line')`,
        );
        // Neither key: the check refuses it.
        await expect(
            dataSource.query(
                `INSERT INTO "terminal_transcript_chunks" ("id", "seq", "text") VALUES ('c3', 1, 'orphan')`,
            ),
        ).rejects.toThrow();
        // (session, seq) is unique where set.
        await expect(
            dataSource.query(
                `INSERT INTO "terminal_transcript_chunks" ("id", "fleetSessionId", "seq", "text") VALUES ('c4', 's1', 0, 'again')`,
            ),
        ).rejects.toThrow();
        // (run, seq) still is.
        await expect(
            dataSource.query(
                `INSERT INTO "terminal_transcript_chunks" ("id", "runId", "seq", "text") VALUES ('c5', 'r1', 0, 'again')`,
            ),
        ).rejects.toThrow();

        const chunks = await table('terminal_transcript_chunks');
        expect(chunks?.findColumnByName('runId')?.isNullable).toBe(true);
        expect(chunks?.indices.map((index) => index.name)).toEqual(
            expect.arrayContaining([
                'idx_terminal_transcript_chunks_run_seq',
                'uq_terminal_transcript_chunks_session_seq',
            ]),
        );
    });

    it('takes a session recording with the session when the session is deleted', async () => {
        await run('up');
        await insertSession('s1', 'd1');
        await dataSource.query(
            `INSERT INTO "terminal_transcript_chunks" ("id", "fleetSessionId", "seq", "text") VALUES ('c2', 's1', 0, 'line')`,
        );
        await dataSource.query(`DELETE FROM "fleet_sessions" WHERE "id" = 's1'`);
        const rows = await dataSource.query(
            `SELECT "id" FROM "terminal_transcript_chunks" ORDER BY "id"`,
        );
        expect(rows).toEqual([{ id: 'c1' }]);
    });

    it('adds fleet_nodes.sessionDaemon and keeps the node row', async () => {
        await run('up');
        const [node] = await dataSource.query(`SELECT "name", "sessionDaemon" FROM "fleet_nodes"`);
        expect(node).toEqual({ name: 'build-01', sessionDaemon: null });
    });

    it('is idempotent: a second up() changes nothing and fails nothing', async () => {
        await run('up');
        await insertSession('s1', 'd1');
        await run('up');
        const sessions = await table('fleet_sessions');
        expect(sessions?.indices).toHaveLength(5);
        const [{ count }] = await dataSource.query(
            `SELECT COUNT(*) AS "count" FROM "fleet_sessions"`,
        );
        expect(Number(count)).toBe(1);
    });

    it('converges from a partially applied state (column added, nothing else)', async () => {
        await dataSource.query(`ALTER TABLE "fleet_nodes" ADD COLUMN "sessionDaemon" text`);
        await run('up');
        expect(await table('fleet_sessions')).toBeDefined();
        const chunks = await table('terminal_transcript_chunks');
        expect(chunks?.findColumnByName('fleetSessionId')).toBeDefined();
    });

    it('down() removes what up() added and restores the strict runId when it can', async () => {
        await run('up');
        await run('down');
        expect(
            await dataSource.query(`SELECT name FROM sqlite_master WHERE name = 'fleet_sessions'`),
        ).toEqual([]);
        const chunks = await table('terminal_transcript_chunks');
        expect(chunks?.findColumnByName('fleetSessionId')).toBeUndefined();
        expect(chunks?.findColumnByName('runId')?.isNullable).toBe(false);
        const nodes = await table('fleet_nodes');
        expect(nodes?.findColumnByName('sessionDaemon')).toBeUndefined();
        const [chunk] = await dataSource.query(`SELECT "text" FROM "terminal_transcript_chunks"`);
        expect(chunk).toEqual({ text: 'hello' });
    });
});
