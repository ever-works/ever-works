import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { CreateWorkAppSpecStates1792030000000 } from '../1792030000000-CreateWorkAppSpecStates';

/**
 * APW-03 T10 — the migration test for `1792030000000-CreateWorkAppSpecStates`,
 * run against an in-memory better-sqlite3 DataSource (the same harness as the
 * sibling migration specs, e.g. `CreateWorkUpstreamStates.spec.ts` and
 * `CreateAppLauncherPreferences.spec.ts`).
 *
 * What matters, in the order T10 states it:
 *
 *  - `up()` creates **only** the new table and its three indexes — asserted
 *    against the live schema *and* against the source, because a `DROP COLUMN`
 *    that happened to be a no-op on this fixture is still a removal, which
 *    CONTRACTS R-26 forbids outright;
 *  - `down()` drops only what `up()` created and leaves everything that
 *    predates it — the `works` stub and its rows — intact;
 *  - a fresh database migrates **up, down and up again** (T10's "Done when");
 *  - the table carries exactly the 55 columns of plan §3.1:403-449, so the
 *    entity and the schema cannot drift apart unnoticed;
 *  - a fresh row starts `missing` with every sequence at zero — the values the
 *    App spec tab renders before anything has been evaluated.
 *
 * The `works` table is a stub created here: this migration owns one table and
 * one foreign key into a table another migration owns, and the FK's behaviour —
 * not the `works` schema — is what is under test.
 *
 * Inserts pass `id` explicitly: `uuid_generate_v4()` is a Postgres function and
 * sqlite is only a DDL harness here.
 */
describe('CreateWorkAppSpecStates1792030000000', () => {
    let dataSource: DataSource;
    const migration = new CreateWorkAppSpecStates1792030000000();

    const source = readFileSync(
        join(__dirname, '..', '1792030000000-CreateWorkAppSpecStates.ts'),
        'utf8',
    );
    // The two method BODIES only: the class docstring quotes the DDL it
    // describes (and the `ALTER` word belongs in prose, not in SQL), so a scan
    // over the whole file would report the explanation rather than the code.
    const upSource = source.slice(
        source.indexOf('public async up('),
        source.indexOf('public async down('),
    );
    const downSource = source.slice(source.indexOf('public async down('));

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
        // A pre-existing table this migration must not touch, with a row in it
        // so a silent DELETE or ALTER is visible.
        await dataSource.query(
            `CREATE TABLE "works" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "works" ("id", "name") VALUES ('w1', 'An App Work'), ('w2', 'Another App Work')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    function insert(id: string, workId = 'w1'): Promise<unknown> {
        // Only the columns the plan makes NOT NULL (plus `id`, which sqlite
        // cannot generate): everything else is the schema's own default.
        return dataSource.query(
            `INSERT INTO "work_app_spec_states" ("id", "workId", "trackedBranch")
             VALUES ('${id}', '${workId}', 'main')`,
        );
    }

    async function rows(): Promise<Array<Record<string, unknown>>> {
        return dataSource.query(`SELECT * FROM "work_app_spec_states" ORDER BY "id"`);
    }

    async function tableNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        return rows.map((row) => row.name);
    }

    async function indexNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'work_app_spec_states'`,
        );
        return rows.map((row) => row.name);
    }

    async function columnNames(table = 'work_app_spec_states'): Promise<string[]> {
        const columns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return columns.map((column) => column.name);
    }

    describe('the table', () => {
        it('creates the table with exactly the 55 declared columns', async () => {
            await run('up');

            const names = await columnNames();

            expect(names).toHaveLength(55);
            expect([...names].sort()).toEqual(
                [
                    'attestation',
                    'blueprintApplyError',
                    'blueprintApplyRef',
                    'blueprintApplyStatus',
                    'blueprintId',
                    'blueprintLatestVersion',
                    'blueprintMatchSource',
                    'blueprintMatchedAt',
                    'blueprintRepo',
                    'blueprintSha',
                    'blueprintUpgradeDismissedVersion',
                    'blueprintUpgradePr',
                    'blueprintVersion',
                    'createdAt',
                    'dispatchedAt',
                    'displayName',
                    'effectiveAt',
                    'effectiveCommitSha',
                    'effectiveSpec',
                    'effectiveSpecHash',
                    'errorCount',
                    'evaluatedSeq',
                    'headCommitSha',
                    'headSpecHash',
                    'id',
                    'issues',
                    'issuesTruncated',
                    'lastEvaluatedAt',
                    'lastEvaluationError',
                    'lastEvaluationTrigger',
                    'licenseClass',
                    'licenseCommitSha',
                    'licenseEvaluatedAt',
                    'licenseEvaluatedSeq',
                    'licenseEvidence',
                    'licenseMixed',
                    'licenseObligations',
                    'licenseRegistryHash',
                    'licenseRegistrySource',
                    'licenseRequestedSeq',
                    'licenseScanIncomplete',
                    'licenseSource',
                    'licenseSpdx',
                    'organizationId',
                    'protectedPaths',
                    'requestedSeq',
                    'sourceOfferRequired',
                    'startedSeq',
                    'tenantId',
                    'trackedBranch',
                    'trademarkNotice',
                    'updatedAt',
                    'validationStatus',
                    'warningCount',
                    'workId',
                ].sort(),
            );
        });

        it('starts a fresh row missing, with every sequence at zero and every flag false', async () => {
            await run('up');
            await insert('s1');

            const [row] = await rows();
            expect(row.validationStatus).toBe('missing');
            expect(Number(row.requestedSeq)).toBe(0);
            expect(Number(row.startedSeq)).toBe(0);
            expect(Number(row.evaluatedSeq)).toBe(0);
            expect(Number(row.licenseRequestedSeq)).toBe(0);
            expect(Number(row.licenseEvaluatedSeq)).toBe(0);
            expect(Number(row.errorCount)).toBe(0);
            expect(Number(row.warningCount)).toBe(0);
            // A fresh row is NOT inside the coalescing window (plan §2.3:189-192).
            expect(row.dispatchedAt).toBeNull();
            // Nothing has been read, applied, classified or attested yet.
            expect(row.headCommitSha).toBeNull();
            expect(row.effectiveCommitSha).toBeNull();
            expect(row.blueprintMatchedAt).toBeNull();
            expect(row.licenseSpdx).toBeNull();
            expect(row.attestation).toBeNull();
            expect(Number(row.issuesTruncated)).toBe(0);
            expect(Number(row.licenseMixed)).toBe(0);
            expect(Number(row.licenseScanIncomplete)).toBe(0);
            expect(Number(row.sourceOfferRequired)).toBe(0);
        });

        it('uses a portable timestamp default for createdAt / updatedAt, so the sqlite test path can insert', async () => {
            // `now()` is a Postgres function: with it as the default, every
            // insert under this driver fails with "unknown function: now()".
            await run('up');
            await insert('s1');

            const [row] = await rows();
            expect(row.createdAt).toBeTruthy();
            expect(row.updatedAt).toBeTruthy();
        });

        it('carries exactly one foreign key — on the Work', async () => {
            await run('up');
            const foreignKeys: Array<{
                table: string;
                from: string;
                to: string;
                on_delete: string;
            }> = await dataSource.query(`PRAGMA foreign_key_list("work_app_spec_states")`);

            expect(foreignKeys).toHaveLength(1);
            expect(foreignKeys[0].table).toBe('works');
            expect(foreignKeys[0].from).toBe('workId');
            expect(foreignKeys[0].to).toBe('id');
            expect(foreignKeys[0].on_delete).toBe('CASCADE');
        });

        it('keeps tenantId and organizationId bare uuids — no second foreign key', async () => {
            await run('up');
            const foreignKeys: unknown[] = await dataSource.query(
                `PRAGMA foreign_key_list("work_app_spec_states")`,
            );

            expect(foreignKeys).toHaveLength(1);
        });

        it('deletes an App Work’s spec state with the Work (FK cascade)', async () => {
            await run('up');
            await insert('s1', 'w1');
            await insert('s2', 'w2');

            await dataSource.query(`DELETE FROM "works" WHERE "id" = 'w1'`);

            expect((await rows()).map((row) => row.id)).toEqual(['s2']);
        });
    });

    describe('the three indexes', () => {
        it('creates the names plan §3.1:451-452 fixes', async () => {
            await run('up');
            const names = await indexNames();

            expect(names).toContain('uq_work_app_spec_states_work');
            expect(names).toContain('idx_work_app_spec_states_blueprint');
            expect(names).toContain('idx_work_app_spec_states_registry');
            // The auto-index sqlite creates for the primary key is not one of ours.
            expect(
                names.filter((name) => name.startsWith('idx_work_app_spec_states')),
            ).toHaveLength(2);
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
    });

    describe('up() is additive and idempotent', () => {
        it('creates one table and nothing else, and never alters an existing one', () => {
            // Read from the source rather than inferred from the result.
            expect(upSource).toMatch(/createTable\(/);
            expect(upSource).not.toMatch(/\bALTER\b/i);
            expect(upSource).not.toMatch(/\bDROP\b/i);
            expect(upSource).not.toMatch(/addColumn|dropColumn|renameColumn|dropTable|dropIndex/i);
            expect(upSource).not.toMatch(/RENAME\s+TO/i);
            // One CREATE TABLE: the three indexes are created as indexes, and
            // the only foreign key is the one on `works`.
            expect(upSource.match(/createTable\(/g)).toHaveLength(1);
        });

        it('names only the table this migration owns', () => {
            // `works` may appear once — as the FK's referenced table — and never
            // as something this migration creates or changes.
            const referencedTables = [...source.matchAll(/referencedTableName: '([^']+)'/g)].map(
                (match) => match[1],
            );

            expect(referencedTables).toEqual(['works']);
            expect(source).toContain("private static readonly TABLE = 'work_app_spec_states'");
        });

        it('does not touch the pre-existing table’s columns or rows', async () => {
            const before = await columnNames('works');
            await run('up');
            const after = await columnNames('works');

            expect(after).toEqual(before);
            expect(await dataSource.query(`SELECT * FROM "works" ORDER BY "id"`)).toHaveLength(2);
        });

        it('is idempotent — a second up() over an applied schema is a no-op', async () => {
            await run('up');
            await insert('s1');
            await run('up');

            expect((await rows()).map((row) => row.id)).toEqual(['s1']);
            const names = await indexNames();
            expect(names.filter((name) => name === 'uq_work_app_spec_states_work')).toHaveLength(1);
            expect(
                names.filter((name) => name === 'idx_work_app_spec_states_blueprint'),
            ).toHaveLength(1);
            expect(
                names.filter((name) => name === 'idx_work_app_spec_states_registry'),
            ).toHaveLength(1);
        });
    });

    describe('down()', () => {
        it('drops the three indexes and the table, and nothing else', async () => {
            await run('up');
            await insert('s1');
            await run('down');

            const names = await tableNames();
            expect(names).not.toContain('work_app_spec_states');
            // The table this migration did not create is still here, with its rows.
            expect(names).toContain('works');
            expect(await dataSource.query(`SELECT * FROM "works" ORDER BY "id"`)).toHaveLength(2);

            const remaining: Array<{ name: string }> = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%work_app_spec_states%'`,
            );
            expect(remaining).toEqual([]);
        });

        it('drops only what up() created, in the source too', () => {
            expect(downSource).toMatch(/queryRunner\.dropTable\(/);
            expect(downSource).toMatch(/queryRunner\.dropIndex\(/);
            expect(downSource).not.toMatch(/\bALTER\b/i);
            expect(downSource).not.toMatch(/dropColumn|renameColumn|RENAME\s+TO/i);
            // No second table is ever named for a drop: one statement, one table.
            expect(downSource.match(/queryRunner\.dropTable\(/g)).toHaveLength(1);
        });

        it('is safe on a database where up() never ran', async () => {
            await expect(run('down')).resolves.toBeUndefined();
            expect(await dataSource.query(`SELECT * FROM "works"`)).toHaveLength(2);
        });
    });

    it('migrates a fresh database up, down and up again (T10 "Done when")', async () => {
        await run('up');
        expect(await tableNames()).toContain('work_app_spec_states');
        await insert('s1');

        await run('down');
        expect(await tableNames()).not.toContain('work_app_spec_states');

        await run('up');

        // Back, empty, and fully usable — with all three indexes and the FK.
        expect(await tableNames()).toContain('work_app_spec_states');
        expect(await rows()).toEqual([]);
        await insert('s2');
        expect((await rows()).map((row) => row.id)).toEqual(['s2']);
        expect(await indexNames()).toContain('uq_work_app_spec_states_work');
        expect(await indexNames()).toContain('idx_work_app_spec_states_blueprint');
        expect(await indexNames()).toContain('idx_work_app_spec_states_registry');
        const foreignKeys: unknown[] = await dataSource.query(
            `PRAGMA foreign_key_list("work_app_spec_states")`,
        );
        expect(foreignKeys).toHaveLength(1);
        // And the table it never owned is still untouched.
        expect(await dataSource.query(`SELECT * FROM "works" ORDER BY "id"`)).toHaveLength(2);
    });
});
