import { DataSource } from 'typeorm';
import { AddAgentRunResumeClaim1791110030000 } from '../1791110030000-AddAgentRunResumeClaim';

/**
 * Migration test for the resume single-flight claim on `agent_runs`.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs,
 * asserting the PHYSICAL schema. What matters:
 *
 *  - all three columns land nullable and every existing run reads NULL,
 *    which is "no resume in flight, no successor linked" — a pre-existing
 *    parked run must stay resumable the moment this migration lands;
 *  - the claim's compare-and-set actually works against the new columns
 *    (a second claimant from the same observation matches no row);
 *  - up() is idempotent and converges a half-applied database, and
 *    down() removes exactly what up() added.
 */
describe('AddAgentRunResumeClaim1791110030000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentRunResumeClaim1791110030000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        // The subset of `agent_runs` this migration touches.
        await dataSource.query(`
            CREATE TABLE "agent_runs" (
                "id" varchar PRIMARY KEY NOT NULL,
                "agentId" varchar NOT NULL,
                "userId" varchar NOT NULL,
                "status" varchar NOT NULL,
                "awaitingInput" boolean NOT NULL DEFAULT (0)
            )
        `);
        await dataSource.query(
            `INSERT INTO "agent_runs" ("id", "agentId", "userId", "status", "awaitingInput") VALUES ('r1', 'a1', 'u1', 'completed', 1)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function columns(): Promise<Record<string, { notnull: number }>> {
        const rows: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("agent_runs")`,
        );
        return Object.fromEntries(rows.map((row) => [row.name, { notnull: row.notnull }]));
    }

    it('adds all three claim columns as nullable and leaves every existing run unclaimed', async () => {
        await runUp();

        const after = await columns();
        expect(after.resumeClaimToken).toEqual({ notnull: 0 });
        expect(after.resumeClaimedAt).toEqual({ notnull: 0 });
        expect(after.resumeSuccessorRunId).toEqual({ notnull: 0 });
        expect(
            await dataSource.query(
                `SELECT "resumeClaimToken", "resumeClaimedAt", "resumeSuccessorRunId", "awaitingInput" FROM "agent_runs" WHERE id = 'r1'`,
            ),
        ).toEqual([
            {
                resumeClaimToken: null,
                resumeClaimedAt: null,
                resumeSuccessorRunId: null,
                awaitingInput: 1,
            },
        ]);
    });

    it('carries a compare-and-set claim: the second claimant from the same read matches no row', async () => {
        await runUp();
        const claim = (token: string) =>
            dataSource.query(
                `UPDATE "agent_runs" SET "resumeClaimToken" = ?, "resumeClaimedAt" = ? WHERE id = 'r1' AND "resumeClaimToken" IS NULL`,
                [token, '2026-09-14 10:00:00.000'],
            );

        await claim('11111111-1111-4111-8111-111111111111');
        await claim('22222222-2222-4222-8222-222222222222');

        expect(await dataSource.query(`SELECT "resumeClaimToken" FROM "agent_runs"`)).toEqual([
            { resumeClaimToken: '11111111-1111-4111-8111-111111111111' },
        ]);
    });

    it('finishes a previous attempt that added only the token column', async () => {
        await dataSource.query(
            `ALTER TABLE "agent_runs" ADD COLUMN "resumeClaimToken" varchar(36)`,
        );

        await runUp();

        const after = await columns();
        expect(after.resumeClaimToken).toBeDefined();
        expect(after.resumeClaimedAt).toBeDefined();
        expect(after.resumeSuccessorRunId).toBeDefined();
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        expect(Object.keys(await columns())).toEqual(
            expect.arrayContaining(['resumeClaimToken', 'resumeClaimedAt', 'resumeSuccessorRunId']),
        );

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        const after = await columns();
        expect(after.resumeClaimToken).toBeUndefined();
        expect(after.resumeClaimedAt).toBeUndefined();
        expect(after.resumeSuccessorRunId).toBeUndefined();
        // Pre-existing data survives the round trip.
        expect(await dataSource.query(`SELECT id, status FROM "agent_runs"`)).toEqual([
            { id: 'r1', status: 'completed' },
        ]);

        await expect(migration.down(runner)).resolves.toBeUndefined();
        await runner.release();
    });

    it('is a no-op when agent_runs does not exist yet', async () => {
        await dataSource.query(`DROP TABLE "agent_runs"`);
        const runner = dataSource.createQueryRunner();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
