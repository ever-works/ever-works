import { DataSource } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { WorkAppDependency, WorkAppEnvValue } from '@ever-works/agent/entities';
import { APP_DEPENDENCY_INACTIVE_STATUSES, APP_DEPENDENCY_STATUSES } from '@ever-works/contracts';
import { CreateAppEnvAndDependencies1792070000000 } from '../1792070000000-CreateAppEnvAndDependencies';

/**
 * APW-07 T7 — the migration for `work_app_env_values` and
 * `work_app_dependencies`, run against an in-memory better-sqlite3 DataSource
 * (the same harness as the sibling migration specs).
 *
 * What matters:
 *
 *  - the two tables carry EXACTLY the columns the entities declare — read from
 *    the entity metadata, never from a list typed into this file, so an entity
 *    column added without the migration fails here rather than only on
 *    production Postgres, which runs migrations and nothing else;
 *  - the plan's defaults: `version` 1, `attempts` 0, `outputsVersion` 0,
 *    `inSpec` true;
 *  - ONE foreign key per table, on the Work, `ON DELETE CASCADE`;
 *  - the four plain indexes and the ONE partial active unique index — the
 *    latter exercised for real on SQLite (a second active row refused, any
 *    number of `kept` rows allowed), which is the (workId, kind) contract T8's
 *    repository spec also leans on;
 *  - **no `ALTER TABLE "works"`** — the migration creates two tables and
 *    touches nothing that already exists (`plan.md:339-340`);
 *  - `up()` is idempotent, and `down()` drops the two tables and nothing else:
 *    up → down → up puts both tables, both foreign keys and the active unique
 *    index back, and the enforcement holds again.
 *
 * The three driver spellings of the active unique index are pinned through
 * `activeUniqueIndexStatements()`, so the Postgres and MySQL/MariaDB branches
 * are asserted without needing a database of each kind.
 *
 * The `works` table is a stub created here: this migration owns two tables and
 * two foreign keys into a table another migration owns, and the FK's behaviour
 * — not the `works` schema — is what is under test.
 *
 * The opt-in Postgres run (`EVER_WORKS_POSTGRES_RACE_TEST_URL`, the convention
 * of `apps/api/src/works/existing-website-link.postgres.integration.spec.ts:12-13`)
 * repeats the same up → down → up against the driver production runs, which is
 * the only place the raw `WHERE` form of the partial index is actually
 * executed.
 */
describe('CreateAppEnvAndDependencies1792070000000', () => {
    let dataSource: DataSource;
    const migration = new CreateAppEnvAndDependencies1792070000000();

    const ENV_TABLE = 'work_app_env_values';
    const DEP_TABLE = 'work_app_dependencies';
    const ACTIVE_UNIQUE = 'uq_work_app_dependencies_active';

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

    /** The physical column list, straight from sqlite. */
    async function columns(table: string): Promise<Array<{ name: string; notnull: number }>> {
        return dataSource.query(`PRAGMA table_info("${table}")`);
    }

    /**
     * The ENTITY's own column metadata — not a list typed into this file, and
     * built from the same `ENTITIES` inventory the API boots with.
     */
    async function entityColumns(
        target: Function,
    ): Promise<Array<{ name: string; nullable: boolean; length: string }>> {
        const metadataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: false,
        });
        await metadataSource.initialize();
        try {
            return metadataSource.getMetadata(target).columns.map((column) => ({
                name: column.databaseName,
                nullable: column.isNullable,
                length: String(column.length ?? ''),
            }));
        } finally {
            await metadataSource.destroy();
        }
    }

    async function indexNames(table: string): Promise<string[]> {
        const indexes: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}'`,
        );
        return indexes.map((index) => index.name);
    }

    async function tableNames(): Promise<string[]> {
        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        return tables.map((table) => table.name);
    }

    /** Insert an env row with only the columns the plan makes NOT NULL. */
    function insertEnv(id: string, workId = 'w1', name = id): Promise<unknown> {
        return dataSource.query(
            `INSERT INTO "${ENV_TABLE}" ("id", "workId", "name", "origin", "valueEncrypted", "valueBytes")
             VALUES ('${id}', '${workId}', '${name}', 'generated', 'enc::v1::${id}', 32)`,
        );
    }

    /** Insert a dependency row with only the columns the plan makes NOT NULL. */
    function insertDependency(id: string, workId = 'w1', kind = 'postgres', status = 'pending') {
        return dataSource.query(
            `INSERT INTO "${DEP_TABLE}"
                ("id", "workId", "kind", "deployTarget", "providerPluginId", "providerId", "status", "declared", "backupPolicy")
             VALUES ('${id}', '${workId}', '${kind}', 'your-cluster', 'k8s', 'k8s-inline-${kind}', '${status}', '{}', 'none')`,
        );
    }

    describe('the tables (plan §3.1 and §3.2)', () => {
        it('creates work_app_env_values with EXACTLY the columns the entity declares', async () => {
            await run('up');
            const physical = await columns(ENV_TABLE);
            const declared = await entityColumns(WorkAppEnvValue);

            expect(physical.map((column) => column.name).sort()).toEqual(
                declared.map((column) => column.name).sort(),
            );
            expect(physical).toHaveLength(15);
        });

        it('creates work_app_dependencies with EXACTLY the columns the entity declares', async () => {
            await run('up');
            const physical = await columns(DEP_TABLE);
            const declared = await entityColumns(WorkAppDependency);

            expect(physical.map((column) => column.name).sort()).toEqual(
                declared.map((column) => column.name).sort(),
            );
            expect(physical).toHaveLength(29);
        });

        it('agrees with the entities on nullability', async () => {
            await run('up');
            const env = new Map((await columns(ENV_TABLE)).map((row) => [row.name, row.notnull]));
            const envDeclared = await entityColumns(WorkAppEnvValue);
            for (const column of envDeclared) {
                expect(`${column.name}:${env.get(column.name) === 1}`).toBe(
                    `${column.name}:${column.nullable === false}`,
                );
            }

            const dep = new Map((await columns(DEP_TABLE)).map((row) => [row.name, row.notnull]));
            const depDeclared = await entityColumns(WorkAppDependency);
            for (const column of depDeclared) {
                expect(`${column.name}:${dep.get(column.name) === 1}`).toBe(
                    `${column.name}:${column.nullable === false}`,
                );
            }
        });

        it('starts an env row at version 1, with the envelope NOT NULL', async () => {
            await run('up');
            await insertEnv('e1');

            const [row] = await dataSource.query(`SELECT * FROM "${ENV_TABLE}"`);
            expect(Number(row.version)).toBe(1);
            expect(row.valueEncrypted).toBe('enc::v1::e1');
            expect(row.generatorFingerprint).toBeNull();
            expect(row.derivedFromName).toBeNull();
            expect(row.generatedAt).toBeNull();
            expect(row.setByUserId).toBeNull();
            expect(row.tenantId).toBeNull();
            expect(row.organizationId).toBeNull();
            expect(row.createdAt).toBeTruthy();
            expect(row.updatedAt).toBeTruthy();

            await expect(
                dataSource.query(
                    `INSERT INTO "${ENV_TABLE}" ("id", "workId", "name", "origin", "valueBytes")
                     VALUES ('e2', 'w1', 'NO_ENVELOPE', 'generated', 32)`,
                ),
            ).rejects.toThrow();
        });

        it('starts a dependency row pending, with no attempts, no outputs version and still in the spec', async () => {
            await run('up');
            await insertDependency('d1');

            const [row] = await dataSource.query(`SELECT * FROM "${DEP_TABLE}"`);
            expect(row.status).toBe('pending');
            expect(Number(row.attempts)).toBe(0);
            expect(Number(row.outputsVersion)).toBe(0);
            expect(Number(row.inSpec)).toBe(1);
            expect(row.statusReason).toBeNull();
            expect(row.statusDetail).toBeNull();
            expect(row.actualVersion).toBeNull();
            expect(row.sizeGiB).toBeNull();
            expect(row.configEncrypted).toBeNull();
            expect(row.outputsEncrypted).toBeNull();
            expect(row.resourceRefs).toBeNull();
            expect(row.backupState).toBeNull();
            expect(row.lastBackupAt).toBeNull();
            expect(row.backupCheckedAt).toBeNull();
            expect(row.lastProvisionedAt).toBeNull();
            expect(row.lastCheckedAt).toBeNull();
            expect(row.provisionLeaseUntil).toBeNull();
        });

        it('stores every stamp as an epoch-millisecond number', async () => {
            await run('up');
            await insertDependency('d1');
            await dataSource.query(
                `UPDATE "${DEP_TABLE}" SET "provisionLeaseUntil" = 1789000000000 WHERE "id" = 'd1'`,
            );

            const [row] = await dataSource.query(`SELECT * FROM "${DEP_TABLE}"`);
            expect(Number(row.provisionLeaseUntil)).toBe(1789000000000);
        });

        it('holds a status wide enough for every member of the contracts union', async () => {
            await run('up');
            for (const [index, status] of APP_DEPENDENCY_STATUSES.entries()) {
                // One App Work each: the point is the COLUMN's width, and the
                // active unique index would otherwise refuse the second active
                // status of the same kind.
                const workId = `w-status-${index}`;
                await dataSource.query(`INSERT INTO "works" ("id") VALUES ('${workId}')`);
                await insertDependency(`d-${index}`, workId, 'redis', status);
            }

            const rows: Array<{ status: string }> = await dataSource.query(
                `SELECT "status" FROM "${DEP_TABLE}" ORDER BY "id"`,
            );
            expect(rows.map((row) => row.status).sort()).toEqual(
                [...APP_DEPENDENCY_STATUSES].sort(),
            );
        });
    });

    describe('foreign keys and cascades', () => {
        it('carries exactly one foreign key per table, on the Work, cascading', async () => {
            await run('up');

            for (const table of [ENV_TABLE, DEP_TABLE]) {
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

        it('deletes an App Work’s values and dependencies with the Work', async () => {
            await run('up');
            await insertEnv('e1', 'w1');
            await insertEnv('e2', 'w2');
            await insertDependency('d1', 'w1');
            await insertDependency('d2', 'w2', 'redis');

            await dataSource.query(`DELETE FROM "works" WHERE "id" = 'w1'`);

            expect(await dataSource.query(`SELECT * FROM "${ENV_TABLE}"`)).toHaveLength(1);
            expect(await dataSource.query(`SELECT * FROM "${DEP_TABLE}"`)).toHaveLength(1);
        });

        it('leaves no way to attach a value to a Work that does not exist', async () => {
            await run('up');

            await expect(insertEnv('e3', 'nope')).rejects.toThrow();
        });
    });

    describe('indexes', () => {
        it('creates the env table’s two indexes, one of them unique on (workId, name)', async () => {
            await run('up');
            const names = await indexNames(ENV_TABLE);

            expect(names).toContain('uq_work_app_env_values_work_name');
            expect(names).toContain('idx_work_app_env_values_work');

            const unique: Array<{ name: string; sql: string }> = await dataSource.query(
                `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_work_app_env_values_work_name'`,
            );
            expect(unique[0].sql).toContain('UNIQUE');
        });

        it('holds one env row per (workId, name), and one per Work for the same name', async () => {
            await run('up');
            await insertEnv('e1', 'w1', 'JWT_SECRET');
            await insertEnv('e2', 'w2', 'JWT_SECRET');

            await expect(insertEnv('e3', 'w1', 'JWT_SECRET')).rejects.toThrow();
        });

        it('creates the dependency table’s two plain indexes', async () => {
            await run('up');
            const names = await indexNames(DEP_TABLE);

            expect(names).toContain('idx_work_app_dependencies_work');
            expect(names).toContain('idx_work_app_dependencies_status');

            const status: Array<{ sql: string }> = await dataSource.query(
                `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_app_dependencies_status'`,
            );
            expect(status[0].sql).toContain('"status", "lastCheckedAt"');
        });

        it('creates the active unique index as the SQLite expression form', async () => {
            await run('up');

            const created: Array<{ sql: string }> = await dataSource.query(
                `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '${ACTIVE_UNIQUE}'`,
            );

            expect(created).toHaveLength(1);
            expect(created[0].sql).toContain('UNIQUE');
            expect(created[0].sql).toContain('"workId", "kind"');
            expect(created[0].sql).toContain(
                `CASE WHEN "status" NOT IN ('${APP_DEPENDENCY_INACTIVE_STATUSES.join("', '")}') THEN 1 ELSE NULL END`,
            );
        });
    });

    describe('the active unique index actually enforces (workId, kind)', () => {
        it('refuses a second active row for one kind, whatever its status', async () => {
            await run('up');
            await insertDependency('d1', 'w1', 'postgres', 'ready');

            await expect(insertDependency('d2', 'w1', 'postgres', 'pending')).rejects.toThrow();
            await expect(
                insertDependency('d3', 'w1', 'postgres', 'provisioning'),
            ).rejects.toThrow();
        });

        it('allows a kept row beside a new active one, and any number of kept rows', async () => {
            await run('up');
            await insertDependency('kept-1', 'w1', 'postgres', 'kept');
            await insertDependency('kept-2', 'w1', 'postgres', 'kept');
            await insertDependency('deleted-1', 'w1', 'postgres', 'deleted');
            await insertDependency('active-1', 'w1', 'postgres', 'pending');

            expect(await dataSource.query(`SELECT * FROM "${DEP_TABLE}"`)).toHaveLength(4);
        });

        it('keeps two App Works and two kinds of one App Work independent', async () => {
            await run('up');
            await insertDependency('d1', 'w1', 'postgres', 'ready');
            await insertDependency('d2', 'w1', 'redis', 'ready');
            await insertDependency('d3', 'w2', 'postgres', 'ready');

            expect(await dataSource.query(`SELECT * FROM "${DEP_TABLE}"`)).toHaveLength(3);
        });
    });

    describe('the other two driver spellings (APW07-G12)', () => {
        const statements = (driver: string) =>
            CreateAppEnvAndDependencies1792070000000.activeUniqueIndexStatements(driver);

        it('emits the Postgres-guarded raw partial index', () => {
            expect(statements('postgres')).toEqual([
                `CREATE UNIQUE INDEX IF NOT EXISTS "${ACTIVE_UNIQUE}" ` +
                    `ON "work_app_dependencies" ("workId", "kind") ` +
                    `WHERE "status" NOT IN ('${APP_DEPENDENCY_INACTIVE_STATUSES.join("', '")}')`,
            ]);
        });

        it('emits the SQLite unique expression index', () => {
            expect(statements('better-sqlite3')).toEqual([
                `CREATE UNIQUE INDEX IF NOT EXISTS "${ACTIVE_UNIQUE}" ` +
                    `ON "work_app_dependencies" ("workId", "kind", ` +
                    `CASE WHEN "status" NOT IN ('${APP_DEPENDENCY_INACTIVE_STATUSES.join("', '")}') THEN 1 ELSE NULL END)`,
            ]);
        });

        it('emits the MySQL/MariaDB generated-column unique key', () => {
            expect(statements('mysql')).toEqual([
                `ALTER TABLE \`work_app_dependencies\` ` +
                    `ADD COLUMN \`activeKey\` TINYINT GENERATED ALWAYS AS ` +
                    `(CASE WHEN \`status\` NOT IN ('${APP_DEPENDENCY_INACTIVE_STATUSES.join("', '")}') THEN 1 ELSE NULL END) STORED, ` +
                    `ADD UNIQUE KEY \`${ACTIVE_UNIQUE}\` (\`workId\`, \`kind\`, \`activeKey\`)`,
            ]);
            expect(statements('mariadb')).toEqual(statements('mysql'));
        });

        it('gives every other driver the expression form rather than nothing', () => {
            expect(statements('sqlite')).toEqual(statements('better-sqlite3'));
            expect(statements('sqljs')).toEqual(statements('better-sqlite3'));
        });
    });

    describe('nothing that already exists is touched', () => {
        it('does not alter the works table (plan §3.4)', async () => {
            await run('up');

            const works: Array<{ name: string }> = await dataSource.query(
                `PRAGMA table_info("works")`,
            );
            expect(works.map((column) => column.name)).toEqual(['id']);
            expect(await dataSource.query(`SELECT * FROM "works"`)).toHaveLength(2);
        });

        it('leaves a table it did not create alone', async () => {
            await dataSource.query(
                `CREATE TABLE "other_child" ("id" varchar PRIMARY KEY NOT NULL, "workId" varchar)`,
            );
            await run('up');
            await run('down');

            expect((await tableNames()).sort()).toEqual(['other_child', 'works']);
        });
    });

    describe('up / down / up', () => {
        it('is idempotent — a second up() over an applied schema is a no-op', async () => {
            await run('up');
            await insertDependency('d1');
            await run('up');

            expect(await dataSource.query(`SELECT * FROM "${DEP_TABLE}"`)).toHaveLength(1);
            expect(
                (await indexNames(DEP_TABLE)).filter((name) => name === ACTIVE_UNIQUE),
            ).toHaveLength(1);
        });

        it('down() drops the two tables and nothing else', async () => {
            await run('up');
            await insertEnv('e1');
            await insertDependency('d1');
            await run('down');

            const tables = await tableNames();
            expect(tables).not.toContain(ENV_TABLE);
            expect(tables).not.toContain(DEP_TABLE);
            expect(tables).toContain('works');
            expect(await dataSource.query(`SELECT * FROM "works"`)).toHaveLength(2);

            const remaining: Array<{ name: string }> = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE '%work_app%')`,
            );
            expect(remaining).toEqual([]);
        });

        it('down() is safe on a database where up() never ran', async () => {
            await expect(run('down')).resolves.toBeUndefined();

            expect(await dataSource.query(`SELECT * FROM "works"`)).toHaveLength(2);
        });

        it('puts both tables, both foreign keys and the active index back on a second up()', async () => {
            await run('up');
            await insertDependency('d1', 'w1', 'postgres', 'ready');
            await run('down');
            await run('up');

            const tables = await tableNames();
            expect(tables).toContain(ENV_TABLE);
            expect(tables).toContain(DEP_TABLE);
            expect(await indexNames(DEP_TABLE)).toContain(ACTIVE_UNIQUE);

            const foreignKeys: Array<{ table: string }> = await dataSource.query(
                `PRAGMA foreign_key_list("${DEP_TABLE}")`,
            );
            expect(foreignKeys.map((fk) => fk.table)).toEqual(['works']);

            // And the (workId, kind) contract holds again after the round trip:
            // the one row written after it is there, and a second active row for
            // the same kind is refused.
            await insertDependency('d2', 'w1', 'postgres', 'pending');
            await expect(insertDependency('d3', 'w1', 'postgres', 'ready')).rejects.toThrow();
            expect(await dataSource.query(`SELECT * FROM "${DEP_TABLE}"`)).toHaveLength(1);
        });

        it('the schema after a round trip is the schema the entities declare', async () => {
            await run('up');
            await run('down');
            await run('up');

            for (const [table, entity] of [
                [ENV_TABLE, WorkAppEnvValue],
                [DEP_TABLE, WorkAppDependency],
            ] as const) {
                expect((await columns(table)).map((column) => column.name).sort()).toEqual(
                    (await entityColumns(entity)).map((column) => column.name).sort(),
                );
            }
        });
    });
});

/**
 * The opt-in Postgres lane — the driver production runs, where the plan's
 * `WHERE`-guarded partial index is the statement that is actually created.
 *
 * Skipped unless `EVER_WORKS_POSTGRES_RACE_TEST_URL` names a dedicated test
 * database (the name must contain `test`), exactly as
 * `apps/api/src/works/existing-website-link.postgres.integration.spec.ts` does.
 */
const postgresUrl = process.env.EVER_WORKS_POSTGRES_RACE_TEST_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

describePostgres('CreateAppEnvAndDependencies1792070000000 — PostgreSQL', () => {
    const ENV_TABLE = 'work_app_env_values';
    const DEP_TABLE = 'work_app_dependencies';
    const ACTIVE_UNIQUE = 'uq_work_app_dependencies_active';

    let dataSource: DataSource;
    let worksCreatedHere = false;
    const migration = new CreateAppEnvAndDependencies1792070000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    beforeAll(async () => {
        const url = postgresUrl as string;
        const databaseName = decodeURIComponent(new URL(url).pathname.slice(1)).toLowerCase();
        if (!/(^|[-_])test($|[-_])/.test(databaseName)) {
            throw new Error(
                'EVER_WORKS_POSTGRES_RACE_TEST_URL must point to a dedicated database whose name contains "test"',
            );
        }

        dataSource = new DataSource({ type: 'postgres', url, entities: [], synchronize: false });
        await dataSource.initialize();
        await run('down');

        const works: Array<{ exists: boolean }> = await dataSource.query(
            `SELECT to_regclass('public.works') IS NOT NULL AS exists`,
        );
        if (!works[0].exists) {
            worksCreatedHere = true;
            await dataSource.query(`CREATE TABLE "works" ("id" uuid PRIMARY KEY)`);
        }
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await run('down');
            await dataSource.query(`DROP INDEX IF EXISTS "${ACTIVE_UNIQUE}"`);
            if (worksCreatedHere) {
                await dataSource.query(`DROP TABLE IF EXISTS "works"`);
            }
            await dataSource.destroy();
        }
    });

    it('creates the plan’s partial unique index and enforces it at the database', async () => {
        await run('up');

        const indexes: Array<{ indexdef: string }> = await dataSource.query(
            `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
            [ACTIVE_UNIQUE],
        );
        expect(indexes).toHaveLength(1);
        expect(indexes[0].indexdef).toContain('UNIQUE');
        // The plan's partial predicate, as Postgres normalises it.
        expect(indexes[0].indexdef).toMatch(/WHERE .*kept.*deleted/);

        await dataSource.query(
            `INSERT INTO "works" ("id") VALUES ('11111111-1111-4111-8111-111111111111')`,
        );
        const insert = (id: string, status: string) =>
            dataSource.query(
                `INSERT INTO "${DEP_TABLE}"
                    ("id", "workId", "kind", "deployTarget", "providerPluginId", "providerId", "status", "declared", "backupPolicy")
                 VALUES ($1, '11111111-1111-4111-8111-111111111111', 'postgres', 'your-cluster', 'k8s', 'k8s-inline-postgres', $2, '{}', 'none')`,
                [id, status],
            );

        await insert('11111111-1111-4111-8111-1111111111a1', 'ready');
        // A second ACTIVE row for the same (workId, kind) is refused…
        await expect(insert('11111111-1111-4111-8111-1111111111a2', 'pending')).rejects.toThrow();
        // …while any number of kept rows coexist with it.
        await insert('11111111-1111-4111-8111-1111111111a3', 'kept');
        await insert('11111111-1111-4111-8111-1111111111a4', 'kept');

        const kept: Array<{ count: string }> = await dataSource.query(
            `SELECT COUNT(*)::text AS count FROM "${DEP_TABLE}" WHERE "status" = 'kept'`,
        );
        expect(Number(kept[0].count)).toBe(2);
    });

    it('creates both tables with the entities’ columns, and down() removes exactly them', async () => {
        await run('up');

        const columns: Array<{ table_name: string; column_name: string; is_nullable: string }> =
            await dataSource.query(
                `SELECT table_name, column_name, is_nullable FROM information_schema.columns
                 WHERE table_name IN ($1, $2) ORDER BY table_name, column_name`,
                [ENV_TABLE, DEP_TABLE],
            );

        expect(columns.filter((column) => column.table_name === ENV_TABLE)).toHaveLength(15);
        expect(columns.filter((column) => column.table_name === DEP_TABLE)).toHaveLength(29);

        await dataSource.query(`DELETE FROM "${DEP_TABLE}"`);
        await run('down');

        const remaining: Array<{ exists: boolean }> = await dataSource.query(
            `SELECT to_regclass('public.work_app_env_values') IS NOT NULL AS exists,
                    to_regclass('public.work_app_dependencies') IS NOT NULL AS exists`,
        );
        expect(remaining[0].exists).toBe(false);

        await run('up');
    });

    it('reports the bigint stamps as epoch milliseconds, as the entities declare them', async () => {
        await run('up');
        const columns: Array<{ column_name: string; data_type: string }> = await dataSource.query(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_name = $1 AND column_name IN
                ('lastBackupAt', 'backupCheckedAt', 'lastProvisionedAt', 'lastCheckedAt', 'provisionLeaseUntil')`,
            [DEP_TABLE],
        );
        expect(columns).toHaveLength(5);
        for (const column of columns) {
            expect(column.data_type).toBe('bigint');
        }

        const env: Array<{ column_name: string; data_type: string }> = await dataSource.query(
            `SELECT column_name, data_type FROM information_schema.columns
             WHERE table_name = $1 AND column_name = 'generatedAt'`,
            [ENV_TABLE],
        );
        expect(env[0].data_type).toBe('bigint');
    });
});
