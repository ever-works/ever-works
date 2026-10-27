import { DataSource } from 'typeorm';
import { AddComputerSessionRecordingColumns1796070100000 } from '../1796070100000-AddComputerSessionRecordingColumns';

/**
 * Migration test for FL-07 slot `1796070100000` (CONTRACTS R-9) on the
 * in-memory better-sqlite3 harness of the sibling specs (production runs
 * Postgres with the same portable DDL):
 *
 *  - every existing row reads `source = 'browser'` with zero recording counters;
 *  - `agentId` becomes nullable (a Desktop view has no Agent) and the existing
 *    row keeps its Agent;
 *  - `up()` twice converges; `down()` drops what it added (`agentId` stays
 *    nullable, by design).
 */
describe('AddComputerSessionRecordingColumns1796070100000', () => {
    let dataSource: DataSource;

    const table = async () => {
        const runner = dataSource.createQueryRunner();
        const found = await runner.getTable('computer_sessions');
        await runner.release();
        return found;
    };

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await new AddComputerSessionRecordingColumns1796070100000()[direction](runner);
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
        await dataSource.query(
            `CREATE TABLE "computer_sessions" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "agentId" varchar NOT NULL, "nodeId" varchar NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "computer_sessions" ("id", "userId", "agentId", "nodeId") VALUES ('s1', 'u1', 'a1', 'n1')`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it('adds the source, display, session and recording columns with their defaults, and the indexes', async () => {
        await run('up');
        const sessions = await table();
        for (const name of [
            'source',
            'displayId',
            'fleetSessionId',
            'recordingRef',
            'recordingBytes',
            'recordingDurationMs',
            'recordingExpiresAt',
            'recordingStoppedReason',
            'controlDriverAt',
        ]) {
            expect(sessions?.findColumnByName(name)).toBeDefined();
        }
        expect(sessions?.indices.map((index) => index.name)).toEqual(
            expect.arrayContaining([
                'idx_computer_sessions_recording_expires',
                'idx_computer_sessions_fleet_session',
            ]),
        );
        const rows = await dataSource.query(
            `SELECT "agentId", "source", "recordingBytes", "recordingDurationMs", "recordingRef" FROM "computer_sessions"`,
        );
        expect(rows).toEqual([
            {
                agentId: 'a1',
                source: 'browser',
                recordingBytes: 0,
                recordingDurationMs: 0,
                recordingRef: null,
            },
        ]);
    });

    it('lets a Desktop view be written with no Agent', async () => {
        await run('up');
        expect((await table())?.findColumnByName('agentId')?.isNullable).toBe(true);
        await dataSource.query(
            `INSERT INTO "computer_sessions" ("id", "userId", "agentId", "nodeId", "source") VALUES ('s2', 'u1', NULL, 'n1', 'desktop')`,
        );
        const rows = await dataSource.query(
            `SELECT "id", "source" FROM "computer_sessions" ORDER BY "id"`,
        );
        expect(rows).toEqual([
            { id: 's1', source: 'browser' },
            { id: 's2', source: 'desktop' },
        ]);
    });

    it('converges when run twice and drops what it added on the way down', async () => {
        await run('up');
        await run('up');
        await run('down');
        const sessions = await table();
        expect(sessions?.findColumnByName('source')).toBeUndefined();
        expect(sessions?.findColumnByName('recordingExpiresAt')).toBeUndefined();
        expect(sessions?.indices.map((index) => index.name)).not.toContain(
            'idx_computer_sessions_recording_expires',
        );
        expect(sessions?.findColumnByName('agentId')).toBeDefined();
    });
});
