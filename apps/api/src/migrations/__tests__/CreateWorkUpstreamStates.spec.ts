import { DataSource } from 'typeorm';
import { CreateWorkUpstreamStates1792020000000 } from '../1792020000000-CreateWorkUpstreamStates';

/**
 * APW-02 T13 — migration test for `work_upstream_states`, run against an
 * in-memory better-sqlite3 DataSource (the same harness as the sibling
 * migration specs, e.g. `CreateWorkspaceBackups.spec.ts`).
 *
 * What matters:
 *  - the table carries exactly the 55 columns of plan §3.1 (`plan.md:210-256`),
 *    so the entity and the schema cannot drift apart unnoticed;
 *  - a fresh row starts `preparing` / `unknown` / `available` / `pending` with
 *    every counter at zero — the values the Upstream card renders before
 *    anything has happened;
 *  - deleting the Work deletes its Upstream state (FK cascade), while a deleted
 *    Task does NOT (there is no second foreign key — `plan.md:244`);
 *  - the three indexes the plan names exist, and the `workId` one is UNIQUE;
 *  - `up()` is idempotent and `down()` drops only what `up()` created.
 *
 * The `works` table is a stub created here: this migration owns one table and
 * one foreign key into a table another migration owns, and the FK's behaviour —
 * not the `works` schema — is what is under test.
 *
 * Inserts pass `id` explicitly: `uuid_generate_v4()` is a Postgres function and
 * sqlite is only a DDL harness here.
 */
describe('CreateWorkUpstreamStates1792020000000', () => {
    let dataSource: DataSource;
    const migration = new CreateWorkUpstreamStates1792020000000();

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
        await dataSource.query(`PRAGMA foreign_keys = ON`);
        await dataSource.query(`CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "works" ("id") VALUES ('w1'), ('w2')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    function insert(id: string, workId = 'w1'): Promise<unknown> {
        // Only the columns the plan makes NOT NULL (plus `id`, which sqlite
        // cannot generate): everything else is the schema's own default.
        return dataSource.query(
            `INSERT INTO "work_upstream_states"
                ("id", "workId", "relation", "dataOwner", "dataRepo", "dataDefaultBranch", "readinessStartedAt")
             VALUES ('${id}', '${workId}', 'fork', 'ever-works', 'demo', 'main', 1772000000000)`,
        );
    }

    async function rows(): Promise<Array<Record<string, unknown>>> {
        return dataSource.query(`SELECT * FROM "work_upstream_states" ORDER BY "id"`);
    }

    async function indexNames(): Promise<string[]> {
        const indexes: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_upstream_states'`,
        );
        return indexes.map((index) => index.name);
    }

    it('creates the table with exactly the 55 declared columns', async () => {
        await run('up');
        const columns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("work_upstream_states")`,
        );
        const names = columns.map((column) => column.name);

        expect(names).toHaveLength(55);
        expect([...names].sort()).toEqual(
            [
                'aheadBy',
                'actionsCheckedAt',
                'actionsDisabledWorkflows',
                'actionsKeptWorkflows',
                'actionsSeenWorkflowIds',
                'actionsState',
                'behindBy',
                'behindEventCount',
                'conflictTaskId',
                'consecutiveRateLimited',
                'copyPushedSha',
                'createdAt',
                'dataDefaultBranch',
                'dataOwner',
                'dataRepo',
                'dataRepositoryStatus',
                'divergenceComputedAt',
                'id',
                'lastSyncCommitCount',
                'lastSyncReason',
                'lastSyncResult',
                'lastSyncedUpstreamSha',
                'manualSyncCount',
                'manualSyncWindowAt',
                'nextSyncAt',
                'organizationId',
                'rateLimitedUntil',
                'readinessDispatches',
                'readinessHeartbeatAt',
                'readinessManualRetries',
                'readinessManualWindowAt',
                'readinessReason',
                'readinessStartedAt',
                'readinessState',
                'readyAt',
                'relation',
                'setupCheckedAt',
                'setupPullRequestNumber',
                'setupPullRequestUrl',
                'syncFinishedAt',
                'syncPullRequestClosedHeadSha',
                'syncPullRequestNumber',
                'syncPullRequestUrl',
                'syncSchedule',
                'syncStartedAt',
                'tenantId',
                'updatedAt',
                'upstreamCheckedAt',
                'upstreamDefaultBranch',
                'upstreamHeadSha',
                'upstreamOwner',
                'upstreamPreviousDefaultBranch',
                'upstreamRepo',
                'upstreamStatus',
                'workId',
            ].sort(),
        );
    });

    it('starts a fresh row preparing, with an unknown upstream, an available repository and pending Actions', async () => {
        await run('up');
        await insert('s1');

        const [row] = await rows();
        expect(row.readinessState).toBe('preparing');
        expect(row.upstreamStatus).toBe('unknown');
        expect(row.dataRepositoryStatus).toBe('available');
        expect(row.actionsState).toBe('pending');
    });

    it('starts every counter at zero and every unset stamp NULL', async () => {
        await run('up');
        await insert('s1');

        const [row] = await rows();
        expect(Number(row.readinessDispatches)).toBe(0);
        expect(Number(row.readinessManualRetries)).toBe(0);
        expect(Number(row.manualSyncCount)).toBe(0);
        expect(Number(row.consecutiveRateLimited)).toBe(0);
        // NULL is "no window yet" and, for nextSyncAt, "paused" — not 1970.
        expect(row.readinessManualWindowAt).toBeNull();
        expect(row.manualSyncWindowAt).toBeNull();
        expect(row.nextSyncAt).toBeNull();
        expect(row.readyAt).toBeNull();
        expect(row.setupCheckedAt).toBeNull();
        expect(row.rateLimitedUntil).toBeNull();
        expect(row.actionsSeenWorkflowIds).toBeNull();
    });

    it('uses a portable timestamp default for createdAt / updatedAt, so the sqlite test path can insert', async () => {
        // `now()` is a Postgres function: with it as the default, every insert
        // under this driver fails with "unknown function: now()".
        await run('up');
        await insert('s1');

        const [row] = await rows();
        expect(row.createdAt).toBeTruthy();
        expect(row.updatedAt).toBeTruthy();
    });

    it('stores the epoch-millisecond timestamps as plain numbers', async () => {
        await run('up');
        await insert('s1');

        const [row] = await rows();
        expect(Number(row.readinessStartedAt)).toBe(1772000000000);
    });

    it('deletes an App Work’s upstream state with the Work (FK cascade)', async () => {
        await run('up');
        await insert('s1', 'w1');
        await insert('s2', 'w2');

        await dataSource.query(`DELETE FROM "works" WHERE "id" = 'w1'`);

        expect((await rows()).map((row) => row.id)).toEqual(['s2']);
    });

    it('carries exactly one foreign key — on the Work, never on the conflict Task', async () => {
        await run('up');
        const foreignKeys: Array<{ table: string; from: string; to: string; on_delete: string }> =
            await dataSource.query(`PRAGMA foreign_key_list("work_upstream_states")`);

        expect(foreignKeys).toHaveLength(1);
        expect(foreignKeys[0].table).toBe('works');
        expect(foreignKeys[0].from).toBe('workId');
        expect(foreignKeys[0].to).toBe('id');
        expect(foreignKeys[0].on_delete).toBe('CASCADE');
    });

    it('creates the three indexes plan §3.1 names', async () => {
        await run('up');
        const names = await indexNames();

        expect(names).toContain('uq_work_upstream_states_work');
        expect(names).toContain('idx_work_upstream_states_next_sync');
        expect(names).toContain('idx_work_upstream_states_readiness');
        // The auto-index sqlite creates for the primary key is not one of ours.
        expect(names.filter((name) => name.startsWith('idx_work_upstream_states'))).toHaveLength(2);
    });

    it('makes one App Work hold exactly one state row', async () => {
        await run('up');
        await insert('s1', 'w1');

        await expect(insert('s2', 'w1')).rejects.toThrow();
        expect((await rows()).map((row) => row.id)).toEqual(['s1']);
    });

    it('allows two different App Works their own row', async () => {
        await run('up');
        await insert('s1', 'w1');
        await insert('s2', 'w2');

        expect((await rows()).map((row) => row.id)).toEqual(['s1', 's2']);
    });

    it('is idempotent — a second up() over an applied schema is a no-op', async () => {
        await run('up');
        await insert('s1');
        await run('up');

        expect((await rows()).map((row) => row.id)).toEqual(['s1']);
        const names = await indexNames();
        expect(names.filter((name) => name === 'uq_work_upstream_states_work')).toHaveLength(1);
    });

    it('down() drops the three indexes and the table, and nothing else', async () => {
        await run('up');
        await insert('s1');
        await run('down');

        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        const names = tables.map((table) => table.name);
        expect(names).not.toContain('work_upstream_states');
        // The table this migration did not create is still here, with its rows.
        expect(names).toContain('works');
        expect(await dataSource.query(`SELECT * FROM "works" ORDER BY "id"`)).toHaveLength(2);

        const remaining: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%work_upstream_states%'`,
        );
        expect(remaining).toEqual([]);
    });

    it('down() is safe on a database where up() never ran', async () => {
        await expect(run('down')).resolves.toBeUndefined();
        // And the foreign-key target it did not create is untouched.
        expect(await dataSource.query(`SELECT * FROM "works"`)).toHaveLength(2);
    });

    it('down() leaves a foreign-key target it did not create intact when other tables reference it', async () => {
        await dataSource.query(
            `CREATE TABLE "other_child" ("id" varchar PRIMARY KEY NOT NULL, "workId" varchar)`,
        );
        await run('up');
        await run('down');

        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        expect(tables.map((table) => table.name).sort()).toEqual(['other_child', 'works']);
    });
});
