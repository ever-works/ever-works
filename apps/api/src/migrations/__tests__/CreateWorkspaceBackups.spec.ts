import { DataSource } from 'typeorm';
import { CreateWorkspaceBackups1791220000000 } from '../1791220000000-CreateWorkspaceBackups';

/**
 * Workspace backup (AW-22) — migration test for `workspace_backups`, run
 * against an in-memory better-sqlite3 DataSource (the same harness as the
 * sibling migration specs).
 *
 * What matters:
 *  - the table carries exactly the declared columns, so the entity and the
 *    schema cannot drift apart unnoticed;
 *  - a fresh row starts queued, unstarted, at zero progress, with the
 *    fifteen domains it is expected to walk;
 *  - deleting the account deletes its backup records (FK cascade);
 *  - the two plain indexes the history read and the hourly sweeper depend on
 *    both exist;
 *  - `up()` is idempotent and `down()` drops only what `up()` created.
 *
 * The PARTIAL unique index (`uq_workspace_backups_active`) is deliberately
 * NOT asserted present here: it is guarded on Postgres, because a non-partial
 * equivalent would reject the second backup a workspace ever took. On this
 * driver the one-at-a-time rule is held by the service's compare-and-set,
 * which is covered in `workspace-backup.service.spec.ts`. Asserting its
 * ABSENCE is the honest thing to assert, and this file does.
 *
 * Inserts pass `id` explicitly: `uuid_generate_v4()` is a Postgres function
 * and sqlite is only a DDL harness here.
 */
describe('CreateWorkspaceBackups1791220000000', () => {
    let dataSource: DataSource;
    const migration = new CreateWorkspaceBackups1791220000000();

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
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1'), ('u2')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    function insert(
        id: string,
        userId = 'u1',
        organizationId: string | null = 'o1',
        status = 'queued',
    ): Promise<unknown> {
        const org = organizationId === null ? 'NULL' : `'${organizationId}'`;
        return dataSource.query(
            `INSERT INTO "workspace_backups"
                ("id", "userId", "organizationId", "status", "formatVersion")
             VALUES ('${id}', '${userId}', ${org}, '${status}', '1.0')`,
        );
    }

    async function rows(): Promise<Array<Record<string, unknown>>> {
        return dataSource.query(`SELECT * FROM "workspace_backups" ORDER BY "id"`);
    }

    it('creates the table with exactly the declared columns', async () => {
        await run('up');
        const columns: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("workspace_backups")`,
        );
        expect(columns.map((column) => column.name).sort()).toEqual(
            [
                'artifactDeletedAt',
                'buildRef',
                'credentialVersion',
                'currentDomain',
                'domainsCompleted',
                'domainsTotal',
                'downloadCount',
                'expiresAt',
                'failureDetail',
                'failureReason',
                'fileCount',
                'finishedAt',
                'formatVersion',
                'id',
                'includeFullHistory',
                'lastDownloadedAt',
                'lastHeartbeatAt',
                'manifestSummary',
                'omittedFileCount',
                'organizationId',
                'progressPercent',
                'requestedAt',
                'runtimeRunId',
                'sha256',
                'sizeBytes',
                'startedAt',
                'status',
                'storageBackend',
                'storageKey',
                'tenantId',
                'updatedAt',
                'userId',
            ].sort(),
        );
    });

    it('starts a row queued, unstarted, at zero progress and expecting fifteen sections', async () => {
        await run('up');
        await insert('b1');

        const [row] = await rows();
        expect(row.status).toBe('queued');
        expect(row.startedAt).toBeNull();
        expect(row.finishedAt).toBeNull();
        expect(Number(row.progressPercent)).toBe(0);
        expect(Number(row.domainsCompleted)).toBe(0);
        // The fifteen domains of the published format. A row that expected a
        // different number would report a coverage fraction nobody can read.
        expect(Number(row.domainsTotal)).toBe(15);
        expect(Number(row.downloadCount)).toBe(0);
        expect(Number(row.fileCount)).toBe(0);
        expect(Number(row.omittedFileCount)).toBe(0);
        expect(row.includeFullHistory === 0 || row.includeFullHistory === false).toBe(true);
        // Nothing has been stored yet, so there is no artefact to point at.
        expect(row.storageKey).toBeNull();
        expect(row.expiresAt).toBeNull();
    });

    it('uses a portable timestamp default, so the sqlite test path can insert', async () => {
        // `now()` is a Postgres function: with it as the default, every
        // insert under this driver fails with "unknown function: now()" and
        // the whole table becomes untestable outside production.
        await run('up');
        await insert('b1');

        const [row] = await rows();
        expect(row.requestedAt).toBeTruthy();
        expect(row.updatedAt).toBeTruthy();
    });

    it('allows the personal workspace (no organization) a row of its own', async () => {
        await run('up');
        await insert('b1', 'u1', null);
        const [row] = await rows();
        expect(row.organizationId).toBeNull();
    });

    it('deletes an account’s backup records with the account', async () => {
        await run('up');
        await insert('b1', 'u1');
        await insert('b2', 'u2');

        await dataSource.query(`DELETE FROM "users" WHERE "id" = 'u1'`);

        const remaining = await rows();
        expect(remaining.map((row) => row.id)).toEqual(['b2']);
    });

    it('creates the history and sweeper indexes', async () => {
        await run('up');
        const indexes: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_backups'`,
        );
        const names = indexes.map((index) => index.name);
        // "this workspace, newest first" — the history list.
        expect(names).toContain('idx_workspace_backups_scope');
        // The hourly sweeper's three passes.
        expect(names).toContain('idx_workspace_backups_sweep');
    });

    it('does NOT create the partial unique index on a non-Postgres driver', async () => {
        // Guarded on purpose: a non-partial equivalent would reject the
        // second backup a workspace ever took. The one-at-a-time rule is
        // held here by the service's compare-and-set instead.
        await run('up');
        const indexes: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_backups'`,
        );
        expect(indexes.map((index) => index.name)).not.toContain('uq_workspace_backups_active');

        // And so a second queued row for the same workspace is accepted by
        // this driver — which is why the application check is not optional.
        await insert('b1', 'u1', 'o1', 'queued');
        await expect(insert('b2', 'u1', 'o1', 'queued')).resolves.toBeDefined();
    });

    it('is idempotent — a second up() over an applied schema is a no-op', async () => {
        await run('up');
        await insert('b1');
        await run('up');

        const remaining = await rows();
        expect(remaining.map((row) => row.id)).toEqual(['b1']);
    });

    it('down() drops only the table up() created', async () => {
        await run('up');
        await insert('b1');
        await run('down');

        const tables: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        const names = tables.map((table) => table.name);
        expect(names).not.toContain('workspace_backups');
        // The table this migration did not create is still here, with its rows.
        expect(names).toContain('users');
        expect(await dataSource.query(`SELECT * FROM "users" ORDER BY "id"`)).toHaveLength(2);
    });

    it('down() is safe on a database where up() never ran', async () => {
        await expect(run('down')).resolves.toBeUndefined();
    });
});
