import { DataSource } from 'typeorm';
import { AddApiKeyKindAndFleetRunBinding1788800000000 } from '../1788800000000-AddApiKeyKindAndFleetRunBinding';

/**
 * Migration test for `api_keys.kind` + the fleet-run binding columns
 * (self-build slice Z, EW-796).
 *
 * Runs on the same in-memory better-sqlite3 harness as its siblings, and
 * for the same reason: production is Postgres while CI and the e2e stack
 * are sqlite, so DDL that only works on one of them would pass in prod
 * and fail every CI run — or the reverse.
 *
 * What is pinned here beyond "the columns exist":
 *  - EXISTING rows read `kind = 'personal'` after up() with no UPDATE
 *    pass, and a row inserted afterwards without the column defaults to it.
 *  - A `fleet-run` row with all three bindings inserts cleanly, and the
 *    SAME insert fails before up().
 *  - The unique index on `hashedKey` that predates this migration
 *    survives the column adds.
 *  - The `boundJobId` index the rotation / revoke path depends on exists.
 *  - down() is symmetric: run rows are deleted, personal rows survive,
 *    and every column this migration added is gone.
 *  - up() and down() are both idempotent (re-running changes nothing).
 */
describe('AddApiKeyKindAndFleetRunBinding1788800000000', () => {
    let dataSource: DataSource;
    const migration = new AddApiKeyKindAndFleetRunBinding1788800000000();

    const BINDING_COLUMNS = ['boundJobId', 'boundNodeId', 'boundRunId'];

    /** A minimal stand-in for the pre-existing `api_keys` table (+ its indexes). */
    const createApiKeysTable = async () => {
        await dataSource.query(`
            CREATE TABLE "api_keys" (
                "id" varchar PRIMARY KEY,
                "userId" varchar NOT NULL,
                "name" varchar(100) NOT NULL,
                "hashedKey" varchar NOT NULL,
                "prefix" varchar(12) NOT NULL,
                "expiresAt" datetime,
                "lastUsedAt" datetime,
                "isActive" boolean NOT NULL DEFAULT 1,
                "tenantId" uuid,
                "organizationId" uuid,
                "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await dataSource.query(
            `CREATE UNIQUE INDEX "idx_api_keys_hashed_key" ON "api_keys" ("hashedKey")`,
        );
        await dataSource.query(`CREATE INDEX "idx_api_keys_user" ON "api_keys" ("userId")`);
    };

    const insertPersonalRow = (id: string) =>
        dataSource.query(
            `INSERT INTO "api_keys" ("id","userId","name","hashedKey","prefix")
             VALUES ('${id}','u1','My key','hash-${id}','ew_live_abcd')`,
        );

    const insertRunRow = (id: string) =>
        dataSource.query(
            `INSERT INTO "api_keys" ("id","userId","name","hashedKey","prefix","kind","boundJobId","boundNodeId","boundRunId","expiresAt")
             VALUES ('${id}','u1','Fleet run job-1','hash-${id}','ew_run_abcd','fleet-run','job-1','node-1','run-1','2026-09-05T12:00:00Z')`,
        );

    const columnNames = async (): Promise<string[]> => {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("api_keys")`,
        );
        return rows.map((row) => row.name);
    };

    const indexNames = async (): Promise<string[]> => {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("api_keys")`,
        );
        return rows.map((row) => row.name);
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds kind + the three binding columns and the boundJobId index', async () => {
        await createApiKeysTable();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const columns = await columnNames();
        expect(columns).toContain('kind');
        for (const name of BINDING_COLUMNS) {
            expect(columns).toContain(name);
        }
        expect(await indexNames()).toContain('idx_api_keys_bound_job');
    });

    it('backfills every EXISTING row to personal with no UPDATE pass', async () => {
        await createApiKeysTable();
        await insertPersonalRow('k1');
        await insertPersonalRow('k2');

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const rows = await dataSource.query(`SELECT "id","kind" FROM "api_keys" ORDER BY "id"`);
        expect(rows).toEqual([
            { id: 'k1', kind: 'personal' },
            { id: 'k2', kind: 'personal' },
        ]);
    });

    it('defaults a row inserted AFTER up() to personal and leaves its bindings NULL', async () => {
        await createApiKeysTable();
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        await insertPersonalRow('k3');
        const [row] = await dataSource.query(
            `SELECT "kind","boundJobId","boundNodeId","boundRunId" FROM "api_keys" WHERE "id" = 'k3'`,
        );
        expect(row.kind).toBe('personal');
        expect(row.boundJobId).toBeNull();
        expect(row.boundNodeId).toBeNull();
        expect(row.boundRunId).toBeNull();
    });

    it('a fleet-run row only inserts AFTER up()', async () => {
        await createApiKeysTable();
        await expect(insertRunRow('r0')).rejects.toThrow();

        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        await insertRunRow('r1');
        const [row] = await dataSource.query(
            `SELECT "kind","boundJobId","boundNodeId","boundRunId" FROM "api_keys" WHERE "id" = 'r1'`,
        );
        expect(row).toEqual({
            kind: 'fleet-run',
            boundJobId: 'job-1',
            boundNodeId: 'node-1',
            boundRunId: 'run-1',
        });
    });

    it('keeps the pre-existing indexes and the unique constraint on hashedKey', async () => {
        await createApiKeysTable();
        await insertPersonalRow('k1');
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const indexes = await indexNames();
        expect(indexes).toContain('idx_api_keys_hashed_key');
        expect(indexes).toContain('idx_api_keys_user');
        // The unique index still bites.
        await expect(
            dataSource.query(
                `INSERT INTO "api_keys" ("id","userId","name","hashedKey","prefix") VALUES ('dup','u1','n','hash-k1','ew_live_abcd')`,
            ),
        ).rejects.toThrow();
    });

    it('up() is idempotent', async () => {
        await createApiKeysTable();
        const first = dataSource.createQueryRunner();
        await migration.up(first);
        await first.release();
        const before = await columnNames();

        const second = dataSource.createQueryRunner();
        await migration.up(second);
        await second.release();

        expect(await columnNames()).toEqual(before);
        expect((await indexNames()).filter((n) => n === 'idx_api_keys_bound_job')).toHaveLength(1);
    });

    it('down() removes the run rows and every column it added, keeping personal keys', async () => {
        await createApiKeysTable();
        await insertPersonalRow('k1');

        const up = dataSource.createQueryRunner();
        await migration.up(up);
        await up.release();
        await insertRunRow('r1');

        const down = dataSource.createQueryRunner();
        await migration.down(down);
        await down.release();

        const columns = await columnNames();
        expect(columns).not.toContain('kind');
        for (const name of BINDING_COLUMNS) {
            expect(columns).not.toContain(name);
        }
        const rows = await dataSource.query(`SELECT "id" FROM "api_keys" ORDER BY "id"`);
        expect(rows).toEqual([{ id: 'k1' }]);
    });

    it('down() is a no-op on a table this migration never touched', async () => {
        await createApiKeysTable();
        await insertPersonalRow('k1');
        const runner = dataSource.createQueryRunner();
        await expect(migration.down(runner)).resolves.toBeUndefined();
        await runner.release();
        expect(await columnNames()).not.toContain('kind');
    });
});
