import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { CreateWorkAppProvisionings1792040000000 } from '../1792040000000-CreateWorkAppProvisionings';

/**
 * APW-04 T8 — migration test for `work_app_provisionings`, run against an
 * in-memory better-sqlite3 DataSource (the same harness as the sibling migration
 * specs, e.g. `CreateWorkBuilds.spec.ts`).
 *
 * T8's own Test clause names two things, and both are here:
 *
 *  - **"no statement touches a pre-existing table"** — proved twice: by reading
 *    this migration's source for any `ALTER`, `DROP` or raw statement, and by
 *    running `up()` and `down()` with two PRE-EXISTING tables present and
 *    asserting their columns, their rows and their existence are untouched.
 *  - **"`up()` then `down()` then `up()` succeeds"** — run in that order against
 *    one database, with the six index names, the six column counts and the one
 *    foreign key re-asserted after the second `up()`.
 *
 * On top of that:
 *
 *  - the table is created with exactly the **56 columns** of plan §3.1
 *    (`plan.md:346-394`), including `questionReason`, `questionParams` and
 *    `lastRunOutput`, so the entity (T7) and the schema cannot drift apart
 *    unnoticed;
 *  - all SIX indexes exist with the plan's names, columns and uniqueness, and
 *    the **DDL the driver actually received** for the three partial ones carries
 *    its `WHERE` clause — asserted against `sqlite_master`, not against the
 *    decorator or the `TableIndex` object;
 *  - the migration SOURCE contains no driver branch
 *    (`queryRunner.connection.options.type`), no raw `queryRunner.query(...)`, no
 *    `interval '` literal and no `ALTER` — the rule commit `b5a7d6857` established
 *    and APW-05's `CreateWorkBuilds.spec.ts` restates;
 *  - the REPOSITORY source (`work-app-provisioning.repository.ts`) is scanned for
 *    the repository half of the same rule — no raw statement, no double-quoted
 *    SQL fragment, no `interval '` literal, no `FOR UPDATE`, no `indexPredicate`
 *    — which is the "pin the cross-driver rule by test" half of T7/T8, kept in
 *    this file because `query-shape.spec.ts`'s `REPOSITORIES` array belongs to
 *    APW-05's slice.
 *
 * The `works` table is a stub created here: this migration owns one table and one
 * foreign key into a table another migration owns, and the FK's behaviour — not
 * the `works` schema — is what is under test.
 *
 * Inserts pass `id` explicitly: `uuid_generate_v4()` is a function of one dialect
 * and sqlite is only a DDL harness here.
 */

const TABLE = 'work_app_provisionings';

/** The migration's own file, and the repository this slice also has to keep portable. */
const migrationSource = readFileSync(
    join(__dirname, '..', '1792040000000-CreateWorkAppProvisionings.ts'),
    'utf8',
);

const repositorySource = readFileSync(
    join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        'packages',
        'agent',
        'src',
        'database',
        'repositories',
        'work-app-provisioning.repository.ts',
    ),
    'utf8',
);

/** Read one source with its comments removed — the code, not its prose. */
function codeOf(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('CreateWorkAppProvisionings1792040000000', () => {
    let dataSource: DataSource;
    const migration = new CreateWorkAppProvisionings1792040000000();

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
        // Two PRE-EXISTING tables this migration must never touch: the Work
        // table its foreign key points at, and a sentinel with a row in it.
        await dataSource.query(`CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "works" ("id") VALUES ('w1'), ('w2')`);
        await dataSource.query(
            `CREATE TABLE "pre_existing" ("id" varchar PRIMARY KEY NOT NULL, "note" varchar)`,
        );
        await dataSource.query(`INSERT INTO "pre_existing" ("id", "note") VALUES ('p1', 'kept')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    function insertProvisioning(id: string, workId = 'w1'): Promise<unknown> {
        // Only the columns the plan makes NOT NULL (plus `id`, which sqlite
        // cannot generate): everything else is the schema's own default.
        return dataSource.query(
            `INSERT INTO "${TABLE}" ("id", "workId", "userId", "trigger", "status")
             VALUES ('${id}', '${workId}', 'u1', 'manual', 'queued')`,
        );
    }

    async function tableNames(): Promise<string[]> {
        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        return tables.map((table) => table.name);
    }

    async function columnNames(table: string): Promise<string[]> {
        const columns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return columns.map((column) => column.name);
    }

    async function indexNames(table: string): Promise<string[]> {
        const indexes: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}'`,
        );
        // SQLite creates an implicit `sqlite_autoindex_<table>_<n>` for a
        // NON-INTEGER primary key. It is the database's, not this migration's,
        // so the exact-name assertion below filters it rather than counting it.
        return indexes
            .map((index) => index.name)
            .filter((name) => !name.startsWith('sqlite_autoindex_'));
    }

    /** The exact DDL the driver received for one index. */
    async function indexSql(name: string): Promise<string> {
        const rows: Array<{ sql: string | null }> = await dataSource.query(
            `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '${name}'`,
        );
        return rows[0]?.sql ?? '';
    }

    /** The 56 columns of plan §3.1:352-383, verbatim and complete. */
    const PLAN_COLUMNS = [
        'activeMs',
        'agentId',
        'attemptBudget',
        'attempts',
        'attemptsUsed',
        'baseSha',
        'buildIds',
        'chatMessagesPosted',
        'conversationId',
        'createdAt',
        'detectionSource',
        'failureReason',
        'finishedAt',
        'headSha',
        'id',
        'lastRunOutput',
        'lease',
        'leaseExpiresAt',
        'note',
        'openInboxItemId',
        'organizationId',
        'parkedAt',
        'parkedReason',
        'prNumber',
        'prUrl',
        'questionAskedAt',
        'questionParams',
        'questionReason',
        'questionRemindedAt',
        'questionsAsked',
        'queuedReason',
        'runIds',
        'runnerMinuteCap',
        'runnerMinutesUsed',
        'startedAt',
        'status',
        'step',
        'stepStates',
        'suggestedAt',
        'suggestionBundle',
        'suggestionState',
        'suggestionUpstream',
        'taskId',
        'tenantId',
        'tokenCap',
        'tokensUsed',
        'trigger',
        'upstreamFromSha',
        'upstreamToSha',
        'updatedAt',
        'userId',
        'verificationExpiresAt',
        'verificationNamespace',
        'verificationTargetKind',
        'verified',
        'workId',
    ];

    /** The six indexes of plan §3.1:387-394. */
    const PLAN_INDEXES = [
        'uq_work_app_provisionings_active',
        'uq_work_app_provisionings_task',
        'idx_work_app_provisionings_user_status',
        'idx_work_app_provisionings_org_status',
        'idx_work_app_provisionings_expiry',
        'uq_work_app_provisionings_suggestion',
    ];

    /** The three the plan makes PARTIAL. */
    const PARTIAL_INDEXES = [
        'uq_work_app_provisionings_active',
        'uq_work_app_provisionings_task',
        'uq_work_app_provisionings_suggestion',
    ];

    describe('up()', () => {
        it('creates the table with exactly the 56 columns of plan §3.1', async () => {
            await run('up');

            expect(await tableNames()).toContain(TABLE);
            expect([...(await columnNames(TABLE))].sort()).toEqual([...PLAN_COLUMNS].sort());
            expect(PLAN_COLUMNS).toHaveLength(56);
        });

        it('carries the three columns T8:163 names by hand', async () => {
            await run('up');

            const columns = await columnNames(TABLE);

            expect(columns).toContain('questionReason');
            expect(columns).toContain('questionParams');
            expect(columns).toContain('lastRunOutput');
        });

        it('creates all six indexes with the plan’s names — no seventh', async () => {
            await run('up');

            expect([...(await indexNames(TABLE))].sort()).toEqual([...PLAN_INDEXES].sort());
        });

        it('emits the WHERE clause for the three PARTIAL indexes on the SQLite driver', async () => {
            await run('up');

            const active = await indexSql('uq_work_app_provisionings_active');
            const task = await indexSql('uq_work_app_provisionings_task');
            const suggestion = await indexSql('uq_work_app_provisionings_suggestion');

            // Asserted against the statement the driver RECEIVED, not against
            // the `TableIndex` object that asked for it: a partial predicate
            // TypeORM silently dropped would leave these three without a WHERE
            // and the test would still pass on the object.
            expect(active).toMatch(/WHERE\s+status IN \('queued', 'running', 'needs_input'\)/);
            expect(task).toMatch(/WHERE\s+"taskId" IS NOT NULL/);
            expect(suggestion).toMatch(/WHERE\s+"suggestionState" = 'queued'/);
            for (const name of PARTIAL_INDEXES) {
                expect(await indexSql(name)).toContain('WHERE');
            }
        });

        it('leaves the three plain indexes without a predicate', async () => {
            await run('up');

            for (const name of [
                'idx_work_app_provisionings_user_status',
                'idx_work_app_provisionings_org_status',
                'idx_work_app_provisionings_expiry',
            ]) {
                expect(await indexSql(name)).not.toContain('WHERE');
            }
        });

        it('creates the one foreign key, workId → works(id) ON DELETE CASCADE', async () => {
            await run('up');

            const keys: Array<{ table: string; from: string; to: string; on_delete: string }> =
                await dataSource.query(`PRAGMA foreign_key_list("${TABLE}")`);

            expect(keys).toHaveLength(1);
            expect(keys[0].table).toBe('works');
            expect(keys[0].from).toBe('workId');
            expect(keys[0].to).toBe('id');
            expect(keys[0].on_delete).toBe('CASCADE');
        });

        it('enforces the ONE ACTIVE row per App Work through the partial unique', async () => {
            await run('up');
            await insertProvisioning('row-1');

            await expect(insertProvisioning('row-2')).rejects.toThrow(/UNIQUE constraint failed/);

            // …and a terminal row is still legal beside the active one.
            await dataSource.query(
                `UPDATE "${TABLE}" SET "status" = 'failed' WHERE "id" = 'row-1'`,
            );
            await expect(insertProvisioning('row-2')).resolves.toBeDefined();
        });

        it('cascades a Work delete to its provisionings', async () => {
            await run('up');
            await insertProvisioning('row-1', 'w1');

            await dataSource.query(`DELETE FROM "works" WHERE "id" = 'w1'`);

            const rows: unknown[] = await dataSource.query(`SELECT "id" FROM "${TABLE}"`);
            expect(rows).toEqual([]);
        });

        it('is idempotent — a second up() is a no-op', async () => {
            await run('up');
            await run('up');

            expect(await columnNames(TABLE)).toHaveLength(56);
            expect(await indexNames(TABLE)).toHaveLength(6);
        });
    });

    describe('nothing pre-existing is touched (T8:166)', () => {
        it('leaves the two pre-existing tables’ columns and rows exactly as they were', async () => {
            const worksBefore = await columnNames('works');
            const preExistingBefore = await columnNames('pre_existing');

            await run('up');
            await run('down');

            expect(await columnNames('works')).toEqual(worksBefore);
            expect(await columnNames('pre_existing')).toEqual(preExistingBefore);
            const kept: Array<{ id: string; note: string }> = await dataSource.query(
                `SELECT "id", "note" FROM "pre_existing"`,
            );
            expect(kept).toEqual([{ id: 'p1', note: 'kept' }]);
            const works: Array<{ id: string }> = await dataSource.query(`SELECT "id" FROM "works"`);
            expect(works.map((row) => row.id).sort()).toEqual(['w1', 'w2']);
        });

        it('names no other table in a DROP or an ALTER anywhere in its source', async () => {
            const code = codeOf(migrationSource);

            expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
            expect(code).not.toMatch(/\bDROP\s+TABLE\b/i);
            expect(code).not.toMatch(/\bRENAME\b/i);
            // The only tables it may name are the one it creates and the one its
            // foreign key points at.
            const named = [...code.matchAll(/'(work[a-z_]*)'/g)].map((match) => match[1]);
            expect([...new Set(named)].sort()).toEqual(['work_app_provisionings', 'works']);
            // Every table name in the source is accounted for by those two: a
            // third would be a statement about somebody else's table.
            expect(named.filter((name) => name !== 'work_app_provisionings')).toEqual(['works']);
        });

        it('drops only what up() created — the two stubs survive down()', async () => {
            await run('up');
            await run('down');

            const tables = await tableNames();
            expect(tables).toContain('works');
            expect(tables).toContain('pre_existing');
            expect(tables).not.toContain(TABLE);
        });

        it('answers without error on a database where up() never ran', async () => {
            await expect(run('down')).resolves.toBeUndefined();
            expect(await tableNames()).toContain('pre_existing');
        });
    });

    describe('down() then up() again (T8:166)', () => {
        it('recreates everything the first up() created', async () => {
            await run('up');
            const columnsFirst = await columnNames(TABLE);
            const indexesFirst = await indexNames(TABLE);

            await run('down');
            expect(await tableNames()).not.toContain(TABLE);

            await run('up');

            expect([...(await columnNames(TABLE))].sort()).toEqual([...columnsFirst].sort());
            expect([...(await indexNames(TABLE))].sort()).toEqual([...indexesFirst].sort());
            const keys: unknown[] = await dataSource.query(`PRAGMA foreign_key_list("${TABLE}")`);
            expect(keys).toHaveLength(1);
            // And it is usable again, not merely present.
            await expect(insertProvisioning('row-after-recreate')).resolves.toBeDefined();
        });

        it('drops the six indexes by name, so a re-up() finds none of them', async () => {
            await run('up');
            await run('down');

            const leftover: Array<{ name: string }> = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%work_app_provisionings%'`,
            );
            expect(leftover).toEqual([]);
        });
    });

    describe('the cross-driver rule, pinned by test (b5a7d6857)', () => {
        it('the migration names no driver and issues no raw statement', () => {
            const code = codeOf(migrationSource);

            // 🛑 No branch on `queryRunner.connection.options.type`: the partial
            // predicates above are ONE `TableIndex` declaration, and TypeORM
            // emits the WHERE on PostgreSQL and SQLite alike.
            expect(code).not.toContain('connection.options.type');
            expect(code).not.toContain('connection.options');
            expect(code).not.toMatch(/\.query\(/);
            expect(code).not.toContain('createQueryRunner');
            expect(code).not.toMatch(/\bINSERT INTO\b/i);
            expect(code).not.toMatch(/\bSELECT\b/);
            expect(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
        });

        it('the migration contains no interval literal', () => {
            expect(codeOf(migrationSource)).not.toMatch(/interval\s*'/i);
        });

        it('the repository issues no raw statement', () => {
            const code = codeOf(repositorySource);

            expect(code).not.toMatch(/\.query\(/);
            expect(code).not.toContain('createQueryRunner');
            expect(code).not.toMatch(/\bINSERT INTO\b/i);
            expect(code).not.toMatch(/\bSELECT\b/);
            expect(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
        });

        it('the repository contains no interval literal and no FOR UPDATE', () => {
            const code = codeOf(repositorySource);

            expect(code).not.toMatch(/interval\s*'/i);
            expect(code).not.toMatch(/FOR\s+UPDATE/i);
            expect(code).not.toMatch(/indexPredicate/);
        });

        it('the repository writes no double-quoted SQL fragment', () => {
            // MySQL treats a double-quoted token as a string literal, not an
            // identifier (`ANSI_QUOTES` is off by default), so a table alias in
            // double quotes is a silent syntax error there. This is the half of
            // the rule the migration cannot carry: an index predicate may quote
            // a camelCase column, a query may not.
            const code = codeOf(repositorySource);
            const fragments = [...code.matchAll(/'([^'\n]*)'/g)]
                .map((match) => match[1])
                .filter((fragment) => fragment.includes('"'));

            expect(fragments).toEqual([]);
        });

        it('the repository declares no partial index predicate of its own', () => {
            // The partial predicates belong to the schema (the entity and this
            // migration). A repository that re-stated one would be a second
            // source of truth for "active".
            const code = codeOf(repositorySource);

            expect(code).not.toContain('CREATE INDEX');
            expect(code).not.toMatch(/\bWHERE\s+status IN/i);
        });
    });
});
