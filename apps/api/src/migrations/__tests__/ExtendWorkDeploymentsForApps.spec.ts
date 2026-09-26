import { DataSource } from 'typeorm';
import { ExtendWorkDeploymentsForApps1792060000000 } from '../1792060000000-ExtendWorkDeploymentsForApps';

/**
 * APW-06 T16/T18 — migration test for the six App columns on
 * `work_deployments`, run against an in-memory better-sqlite3 DataSource (the
 * same harness as `CreateWorkAppRuntimeStates.spec.ts`).
 *
 * What matters, and why each one is here rather than assumed:
 *
 *  - the six columns of plan §7.1 exist and every one is NULLABLE. A website
 *    Deployment writes none of them; a `NOT NULL` among them would break every
 *    non-App deploy on this table the moment the migration ran;
 *  - **no pre-existing column changed.** The columns are snapshotted before
 *    `up()` and compared after, because this table backs every Work kind and an
 *    accidental narrowing here is a production outage for all of them;
 *  - an existing row survives with six nulls — no backfill, no default;
 *  - the `buildId` index exists, because "was this Build ever deployed?" is the
 *    one question asked of these columns that is not already answered by a row
 *    the caller has in hand;
 *  - `up()` is idempotent from BOTH starting states: a database that never had
 *    the columns, and one synchronised straight from the entity (a dev box, a
 *    test DataSource) that already has all six. The second is the case that
 *    makes a plain `addColumns` throw;
 *  - `down()` drops the six and the index, and nothing else.
 *
 * The `work_deployments` stub below is this file's own: the migration owns six
 * columns on a table another migration created, and what is under test is the
 * six, not that table's schema.
 */
describe('ExtendWorkDeploymentsForApps1792060000000', () => {
    let dataSource: DataSource;
    const migration = new ExtendWorkDeploymentsForApps1792060000000();

    const APP_COLUMNS = [
        'buildId',
        'appTarget',
        'appTrigger',
        'componentStatuses',
        'smokeResult',
        'appRender',
    ] as const;

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
        await dataSource.query(
            `CREATE TABLE "work_deployments" (
                "id" varchar PRIMARY KEY NOT NULL,
                "workId" varchar NOT NULL,
                "provider" varchar NOT NULL,
                "branch" varchar NOT NULL DEFAULT ('main'),
                "state" varchar NOT NULL DEFAULT ('INITIALIZING')
            )`,
        );
        await dataSource.query(
            `INSERT INTO "work_deployments" ("id", "workId", "provider") VALUES ('d1', 'w1', 'vercel')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function columns(): Promise<Array<{ name: string; type: string; notnull: number }>> {
        return dataSource.query(`PRAGMA table_info("work_deployments")`);
    }

    async function columnNames(): Promise<string[]> {
        return (await columns()).map((column) => column.name);
    }

    async function indexNames(): Promise<string[]> {
        const list: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("work_deployments")`,
        );
        return list.map((index) => index.name);
    }

    it('adds exactly the six columns plan §7.1 names', async () => {
        await run('up');

        const names = await columnNames();
        for (const column of APP_COLUMNS) expect(names).toContain(column);
    });

    it('every added column is NULLABLE — a website Deployment writes none of them', async () => {
        await run('up');

        const added = (await columns()).filter((column) =>
            (APP_COLUMNS as readonly string[]).includes(column.name),
        );
        expect(added).toHaveLength(APP_COLUMNS.length);
        for (const column of added) expect(column.notnull).toBe(0);
    });

    it('changes NO pre-existing column — this table backs every Work kind', async () => {
        const before = await columns();

        await run('up');

        const after = await columns();
        for (const column of before) {
            const same = after.find((candidate) => candidate.name === column.name);
            expect(same).toBeDefined();
            expect(same!.type).toBe(column.type);
            expect(same!.notnull).toBe(column.notnull);
        }
    });

    it('leaves the existing row intact, with six nulls and no backfill', async () => {
        await run('up');

        const [row] = await dataSource.query(`SELECT * FROM "work_deployments" WHERE "id" = 'd1'`);
        expect(row.provider).toBe('vercel');
        expect(row.state).toBe('INITIALIZING');
        for (const column of APP_COLUMNS) expect(row[column]).toBeNull();
    });

    it('stores an App Deployment row — the §2.2 step 4 insert', async () => {
        await run('up');

        await dataSource.query(
            `INSERT INTO "work_deployments"
                ("id", "workId", "provider", "state", "buildId", "appTarget", "appTrigger", "appRender")
             VALUES ('d2', 'w1', 'k8s', 'INITIALIZING', 'b1', 'your-cluster', 'manual', '{"specCommitSha":"abc"}')`,
        );

        const [row] = await dataSource.query(`SELECT * FROM "work_deployments" WHERE "id" = 'd2'`);
        expect(row.buildId).toBe('b1');
        expect(row.appTarget).toBe('your-cluster');
        expect(row.appTrigger).toBe('manual');
        // `simple-json` is stored as text and parsed by TypeORM; the raw read
        // proves the column holds the document rather than a truncation.
        expect(JSON.parse(row.appRender)).toEqual({ specCommitSha: 'abc' });
    });

    it('indexes buildId — the one question these columns are searched by', async () => {
        await run('up');

        expect(await indexNames()).toContain('idx_work_deployments_build');
    });

    it('up() is idempotent', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();

        expect(await columnNames()).toEqual(expect.arrayContaining([...APP_COLUMNS]));
    });

    it('up() converges from a database SYNCHRONISED from the entity', async () => {
        // The case a plain `addColumns` throws on, and the one a developer meets
        // first: `synchronize: true` created all six, then the migration runs.
        for (const column of APP_COLUMNS) {
            await dataSource.query(`ALTER TABLE "work_deployments" ADD COLUMN "${column}" text`);
        }

        await expect(run('up')).resolves.toBeUndefined();
        expect(await indexNames()).toContain('idx_work_deployments_build');
    });

    it('down() drops the six columns and the index, and nothing else', async () => {
        const before = await columnNames();

        await run('up');
        await run('down');

        expect(await columnNames()).toEqual(before);
        expect(await indexNames()).not.toContain('idx_work_deployments_build');
    });

    it('down() on a database that never ran up() is a no-op', async () => {
        await expect(run('down')).resolves.toBeUndefined();
    });
});
