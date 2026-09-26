import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { CreateWorkBuilds1792050000000 } from '../1792050000000-CreateWorkBuilds';

/**
 * APW-05 T5 — migration test for `work_builds` + `work_build_preparations`,
 * run against an in-memory better-sqlite3 DataSource (the same harness as the
 * sibling migration specs, e.g. `CreateWorkUpstreamStates.spec.ts`).
 *
 * What matters:
 *
 *  - `up()` creates BOTH tables with exactly the 54 and 22 columns of plan
 *    §3.1 (`plan.md:329-396`) and §3.1b (`:398-425`), so the entities and the
 *    schema cannot drift apart unnoticed;
 *  - both foreign keys are `workId → works(id) ON DELETE CASCADE` and they are
 *    the only ones — `usageEventId` / `triggeredByUserId` / `verifiesBuildId`
 *    are bare uuids (`plan.md:362`);
 *  - all SIX indexes exist, with the names, columns and uniqueness the plan
 *    names, and `uq_work_builds_provider_run` is a plain UNIQUE whose emitted
 *    DDL carries **no `WHERE`** — the `APW05-G10` portability rule asserted
 *    against the statement the driver actually received, not against the
 *    decorator;
 *  - `down()` removes only those two tables and their indexes;
 *  - the migration SOURCE contains no `ALTER` of a pre-existing table, no raw
 *    statement call and no driver branch, which is T5's own "Test" clause — the
 *    same rule commit `b5a7d6857` established and `APW05-G10` restates.
 *
 * The `works` table is a stub created here: this migration owns two tables and
 * two foreign keys into a table another migration owns, and the FK's behaviour —
 * not the `works` schema — is what is under test.
 *
 * Inserts pass `id` explicitly: `uuid_generate_v4()` is a function of one
 * dialect and sqlite is only a DDL harness here.
 */
describe('CreateWorkBuilds1792050000000', () => {
    let dataSource: DataSource;
    const migration = new CreateWorkBuilds1792050000000();

    const BUILDS = 'work_builds';
    const PREPARATIONS = 'work_build_preparations';

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

    function insertBuild(id: string, workId = 'w1'): Promise<unknown> {
        // Only the columns the plan makes NOT NULL (plus `id`, which sqlite
        // cannot generate): everything else is the schema's own default.
        return dataSource.query(
            `INSERT INTO "${BUILDS}"
                ("id", "workId", "number", "buildPluginId", "status", "trigger", "branch", "commitSha")
             VALUES ('${id}', '${workId}', 1, 'github-actions', 'queued', 'push', 'main', '${'a'.repeat(40)}')`,
        );
    }

    function insertPreparation(id: string, workId = 'w1'): Promise<unknown> {
        return dataSource.query(
            `INSERT INTO "${PREPARATIONS}" ("id", "workId", "buildPluginId")
             VALUES ('${id}', '${workId}', 'github-actions')`,
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
        return indexes.map((index) => index.name);
    }

    /** The exact DDL the driver received for one index. */
    async function indexSql(name: string): Promise<string> {
        const rows: Array<{ sql: string | null }> = await dataSource.query(
            `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '${name}'`,
        );
        return rows[0]?.sql ?? '';
    }

    const BUILD_COLUMNS = [
        'appSpecHash',
        'billableMinutes',
        'blockedDetail',
        'blockedReason',
        'branch',
        'buildInputsHash',
        'buildPluginId',
        'buildSecretNames',
        'cancelReason',
        'checksBillableMinutes',
        'commitSha',
        'completedAt',
        'createdAt',
        'deployable',
        'digestConfirmed',
        'dispatchCorrelationId',
        'dispatchedAt',
        'durationSeconds',
        'failureClass',
        'failureDetail',
        'failureExcerpt',
        'id',
        'imageDigest',
        'imageRepository',
        'imageTags',
        'lastObservedAt',
        'logsUrl',
        'notDeployableReason',
        'number',
        'organizationId',
        'providerRunId',
        'pullRequestNumber',
        'queuedAt',
        'runAttempt',
        'runnerClass',
        'runnerLabel',
        'secretCheck',
        'secretsSyncedAt',
        'specValidAtCommit',
        'startedAt',
        'status',
        'syncFromSha',
        'syncOrigin',
        'syncToSha',
        'tenantId',
        'trigger',
        'triggeredByUserId',
        'updatedAt',
        'usageEventId',
        'verificationResult',
        'verifiesBuildId',
        'verifySecretNames',
        'watchLeaseUntil',
        'workId',
    ].sort();

    const PREPARATION_COLUMNS = [
        'buildInputsHash',
        'buildPluginId',
        'buildSecretNames',
        'createdAt',
        'id',
        'lastPreparedAt',
        'organizationId',
        'prepareSeq',
        'repositoryBlock',
        'runsCheckedAt',
        'runsEtag',
        'secretsSyncedAt',
        'tenantId',
        'updatedAt',
        'webhookId',
        'webhookState',
        'workId',
        'workflowPullRequestNumber',
        'workflowPullRequestUrl',
        'workflowSha256',
        'workflowState',
        'workflowWrittenAt',
    ].sort();

    describe('up()', () => {
        it('creates both tables', async () => {
            await run('up');
            const names = await tableNames();

            expect(names).toContain(BUILDS);
            expect(names).toContain(PREPARATIONS);
        });

        it('creates work_builds with exactly the 54 declared columns', async () => {
            await run('up');

            const names = await columnNames(BUILDS);
            expect(names).toHaveLength(54);
            expect([...names].sort()).toEqual(BUILD_COLUMNS);
        });

        it('creates work_build_preparations with exactly the 22 declared columns', async () => {
            await run('up');

            const names = await columnNames(PREPARATIONS);
            expect(names).toHaveLength(22);
            expect([...names].sort()).toEqual(PREPARATION_COLUMNS);
        });

        it('starts a fresh Build on the documented defaults', async () => {
            await run('up');
            await insertBuild('b1');

            const [row]: Array<Record<string, unknown>> = await dataSource.query(
                `SELECT * FROM "${BUILDS}" WHERE "id" = 'b1'`,
            );
            expect(Number(row.runAttempt)).toBe(1);
            expect(row.syncOrigin).toBe('none');
            // sqlite stores a boolean default as 0 — the plan's `false`.
            expect(Number(row.digestConfirmed)).toBe(0);
            expect(Number(row.deployable)).toBe(0);
            // NULL is "not yet", never 1970.
            expect(row.queuedAt).toBeNull();
            expect(row.startedAt).toBeNull();
            expect(row.completedAt).toBeNull();
            expect(row.watchLeaseUntil).toBeNull();
            expect(row.providerRunId).toBeNull();
        });

        it('starts a fresh preparation with no workflow and no webhook', async () => {
            await run('up');
            await insertPreparation('p1');

            const [row]: Array<Record<string, unknown>> = await dataSource.query(
                `SELECT * FROM "${PREPARATIONS}" WHERE "id" = 'p1'`,
            );
            expect(row.workflowState).toBe('none');
            expect(row.webhookState).toBe('none');
            expect(Number(row.prepareSeq)).toBe(0);
            expect(row.buildInputsHash).toBeNull();
            expect(row.secretsSyncedAt).toBeNull();
            expect(row.buildSecretNames).toBeNull();
        });

        it('uses a portable timestamp default for createdAt / updatedAt, so the sqlite test path can insert', async () => {
            // A dialect-specific "now" function as the default makes every insert
            // under this driver fail with "unknown function".
            await run('up');
            await insertBuild('b1');
            await insertPreparation('p1');

            const [build]: Array<Record<string, unknown>> = await dataSource.query(
                `SELECT * FROM "${BUILDS}" WHERE "id" = 'b1'`,
            );
            expect(build.createdAt).toBeTruthy();
            expect(build.updatedAt).toBeTruthy();
        });

        it('carries exactly one foreign key per table, both cascading from the Work', async () => {
            await run('up');

            for (const table of [BUILDS, PREPARATIONS]) {
                const foreignKeys: Array<{
                    table: string;
                    from: string;
                    to: string;
                    on_delete: string;
                }> = await dataSource.query(`PRAGMA foreign_key_list("${table}")`);

                expect(foreignKeys).toHaveLength(1);
                expect(foreignKeys[0].table).toBe('works');
                expect(foreignKeys[0].from).toBe('workId');
                expect(foreignKeys[0].to).toBe('id');
                expect(foreignKeys[0].on_delete).toBe('CASCADE');
            }
        });

        it('creates all six indexes plan §3.1 and §3.1b name', async () => {
            await run('up');

            const buildIndexes = await indexNames(BUILDS);
            const preparationIndexes = await indexNames(PREPARATIONS);

            for (const name of [
                'uq_work_builds_work_number',
                'uq_work_builds_provider_run',
                'idx_work_builds_work_created',
                'idx_work_builds_work_commit',
                'idx_work_builds_status_observed',
            ]) {
                expect(buildIndexes).toContain(name);
            }
            expect(preparationIndexes).toContain('uq_work_build_preparations_work');
            expect(buildIndexes.filter((name) => name.startsWith('idx_work_builds'))).toHaveLength(
                3,
            );
            expect(buildIndexes.filter((name) => name.startsWith('uq_work_builds'))).toHaveLength(
                2,
            );
        });

        it('emits the run-identity unique as a PLAIN unique — no WHERE in the DDL (APW05-G10)', async () => {
            // The assertion T5 exists for. A partial index would be refused by
            // MySQL/MariaDB outright, and on the drivers that accept one it would
            // stop the webhook and the poll from converging on one row.
            await run('up');

            const sql = await indexSql('uq_work_builds_provider_run');

            expect(sql).toContain('buildPluginId');
            expect(sql).toContain('providerRunId');
            expect(sql).toContain('runAttempt');
            expect(sql.toUpperCase()).toContain('UNIQUE');
            expect(sql.toUpperCase()).not.toContain('WHERE');
        });

        it('declares no partial index anywhere', async () => {
            await run('up');

            const partial: Array<{ name: string; sql: string | null }> = await dataSource.query(
                `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql LIKE '%WHERE%'`,
            );

            expect(partial).toEqual([]);
        });

        it('rejects a second Build with the same number on one Work, and allows it on another', async () => {
            await run('up');
            await insertBuild('b1', 'w1');

            await expect(insertBuild('b2', 'w1')).rejects.toThrow();
            await expect(insertBuild('b3', 'w2')).resolves.toBeDefined();
        });

        it('rejects a second row for the same (plugin, run, attempt) and allows a different attempt', async () => {
            await run('up');
            const row = (id: string, attempt: number) =>
                dataSource.query(
                    `INSERT INTO "${BUILDS}"
                        ("id", "workId", "number", "buildPluginId", "status", "trigger", "branch",
                         "commitSha", "providerRunId", "runAttempt")
                     VALUES ('${id}', 'w1', ${attempt}, 'github-actions', 'running', 'push', 'main',
                             '${'b'.repeat(40)}', 'run-1', ${attempt})`,
                );

            await row('b1', 1);
            await expect(row('b2', 1)).rejects.toThrow();
            // A re-run is a second row under the same provider run id.
            await expect(row('b3', 2)).resolves.toBeDefined();
        });

        it('lets two unadopted Builds coexist, because NULLs are distinct inside the unique', async () => {
            // A manual and a verification Build both have `providerRunId` NULL
            // before adoption; on every one of the four drivers they must not
            // collide (plan.md:376-378).
            await run('up');
            const unadopted = (id: string, number: number) =>
                dataSource.query(
                    `INSERT INTO "${BUILDS}"
                        ("id", "workId", "number", "buildPluginId", "status", "trigger", "branch", "commitSha")
                     VALUES ('${id}', 'w1', ${number}, 'github-actions', 'queued', 'manual', 'main',
                             '${'c'.repeat(40)}')`,
                );

            await unadopted('b1', 1);
            await expect(unadopted('b2', 2)).resolves.toBeDefined();
        });

        it('allows exactly one preparation row per App Work', async () => {
            await run('up');
            await insertPreparation('p1', 'w1');

            await expect(insertPreparation('p2', 'w1')).rejects.toThrow();
            await expect(insertPreparation('p3', 'w2')).resolves.toBeDefined();
        });

        it('deletes a Work’s Builds and preparation row with the Work', async () => {
            await run('up');
            await insertBuild('b1', 'w1');
            await insertBuild('b2', 'w2');
            await insertPreparation('p1', 'w1');
            await insertPreparation('p2', 'w2');

            await dataSource.query(`DELETE FROM "works" WHERE "id" = 'w1'`);

            const builds: Array<{ id: string }> = await dataSource.query(
                `SELECT "id" FROM "${BUILDS}" ORDER BY "id"`,
            );
            const preparations: Array<{ id: string }> = await dataSource.query(
                `SELECT "id" FROM "${PREPARATIONS}" ORDER BY "id"`,
            );
            expect(builds.map((row) => row.id)).toEqual(['b2']);
            expect(preparations.map((row) => row.id)).toEqual(['p2']);
        });

        it('is idempotent — a second up() over an applied schema is a no-op', async () => {
            await run('up');
            await insertBuild('b1');
            await insertPreparation('p1');
            await run('up');

            const builds: Array<{ id: string }> = await dataSource.query(
                `SELECT "id" FROM "${BUILDS}"`,
            );
            expect(builds.map((row) => row.id)).toEqual(['b1']);
            expect(
                (await indexNames(BUILDS)).filter((name) => name === 'uq_work_builds_provider_run'),
            ).toHaveLength(1);
        });
    });

    describe('down()', () => {
        it('drops both tables and every index it created, and nothing else', async () => {
            await run('up');
            await insertBuild('b1');
            await insertPreparation('p1');
            await run('down');

            const names = await tableNames();
            expect(names).not.toContain(BUILDS);
            expect(names).not.toContain(PREPARATIONS);
            // The table this migration did not create is still here, with rows.
            expect(names).toContain('works');
            expect(await dataSource.query(`SELECT * FROM "works" ORDER BY "id"`)).toHaveLength(2);

            const remaining: Array<{ name: string }> = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'index'
                  AND (name LIKE '%work_build%')`,
            );
            expect(remaining).toEqual([]);
        });

        it('is safe on a database where up() never ran', async () => {
            await expect(run('down')).resolves.toBeUndefined();
            expect(await dataSource.query(`SELECT * FROM "works"`)).toHaveLength(2);
        });

        it('leaves a foreign-key target it did not create intact when other tables reference it', async () => {
            await dataSource.query(
                `CREATE TABLE "other_child" ("id" varchar PRIMARY KEY NOT NULL, "workId" varchar)`,
            );
            await run('up');
            await run('down');

            expect((await tableNames()).sort()).toEqual(['other_child', 'works']);
        });

        it('round-trips: up, down, up leaves both tables present again', async () => {
            await run('up');
            await run('down');
            await run('up');

            const names = await tableNames();
            expect(names).toContain(BUILDS);
            expect(names).toContain(PREPARATIONS);
            await expect(insertBuild('b1')).resolves.toBeDefined();
        });
    });

    describe('the migration source itself (T5’s portability rule)', () => {
        /**
         * The migration's docstring NAMES the rules it follows — `indexPredicate`,
         * `dropTable(...)`, the four drivers — so the scan has to read CODE.
         * Stripping comments first is the same device
         * `entities/__tests__/portable-date-columns.spec.ts` uses, and for the
         * same reason: a rule that its own explanation trips is a rule nobody
         * can document.
         */
        const stripComments = (text: string): string =>
            text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

        const source = stripComments(
            readFileSync(join(__dirname, '..', '1792050000000-CreateWorkBuilds.ts'), 'utf8'),
        );

        it('alters no pre-existing table', () => {
            // T5: "the file contains no ALTER TABLE on a pre-existing table".
            // This migration adds two tables and reads nothing, so the stronger
            // form holds: it contains no such statement at all. `dropTable` in
            // `down()` is the sanctioned exception — and it names only the two
            // tables `up()` created, which the down() cases above assert.
            expect(source).not.toMatch(/ALTER\s+TABLE/i);
            expect(source).not.toMatch(/\.(addColumn|dropColumn|changeColumn|renameColumn)\(/);
            expect(source).not.toMatch(/\.renameTable\(/);
            const dropped = [...source.matchAll(/dropTable\(\s*([^,)]+)/g)].map((match) =>
                match[1].trim(),
            );
            expect(dropped).toEqual(['table', 'table']);
        });

        it('contains no driver branch', () => {
            // A quoted driver name is what a branch looks like.
            expect(source).not.toMatch(
                /['"](postgres|postgresql|mysql|mariadb|sqlite|sqlite3|better-sqlite3|sqljs)['"]/i,
            );
            expect(source).not.toContain('connection.options');
            expect(source).not.toMatch(/queryRunner\.connection\b/);
        });

        it('issues no raw statement', () => {
            // The `b5a7d6857` rule: no double-quoted raw SQL and no interval
            // literal, because the same string has to run on four drivers.
            expect(source).not.toMatch(/queryRunner\.query\(/);
            expect(source).not.toContain("interval '");
            expect(source).not.toContain('"SELECT');
            expect(source).not.toContain('"INSERT');
        });

        it('declares every index through TypeORM’s TableIndex', () => {
            const declared = source.match(/new TableIndex\(/g) ?? [];

            expect(declared).toHaveLength(6);
            expect(source).not.toMatch(/indexPredicate/);
            // `where:` is how a partial index would be declared.
            expect(source).not.toMatch(/\bwhere\s*:/);
        });
    });
});
