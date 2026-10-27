import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { CreateUpstreamPullRequests1792090100000 } from '../1792090100000-CreateUpstreamPullRequests';
import { CreateWorkUpstreamPrSettings1792090200000 } from '../1792090200000-CreateWorkUpstreamPrSettings';
import { CreateUpstreamPrSuggestions1792090300000 } from '../1792090300000-CreateUpstreamPrSuggestions';

/**
 * APW-09 T7 — the three APW-09 tables, against an in-memory better-sqlite3 DataSource
 * (the harness of `CreateWorkAppProvisionings.spec.ts`).
 *
 * - every migration is re-runnable: `up → up` is a no-op, `up → down → up` rebuilds the same
 *   indexes and keys, and `down` on a database where `up` never ran does nothing;
 * - no migration touches a pre-existing table;
 * - `uq_upr_active_source` is PARTIAL in the DDL the driver received, so a second ACTIVE
 *   record for one source Task fails while a closed one (and a NULL source) does not
 *   (FR-5, S27, ACC-09-34);
 * - the foreign keys cascade from `works` and `users`;
 * - the sources carry no driver branch, no raw statement and no `ALTER`, and nothing in
 *   the migrations names a token or credential column (the record never stores a token).
 *
 * `works` and `users` are stubs: the FK behaviour is under test, not their schemas.
 * Inserts pass `id` explicitly — `uuid_generate_v4()` is one dialect's function.
 */

const sources = [
    '1792090100000-CreateUpstreamPullRequests.ts',
    '1792090200000-CreateWorkUpstreamPrSettings.ts',
    '1792090300000-CreateUpstreamPrSuggestions.ts',
].map((file) => ({ file, source: readFileSync(join(__dirname, '..', file), 'utf8') }));

function codeOf(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('APW-09 migrations (1792090100000 · 1792090200000 · 1792090300000)', () => {
    let dataSource: DataSource;
    const prs = new CreateUpstreamPullRequests1792090100000();
    const settings = new CreateWorkUpstreamPrSettings1792090200000();
    const suggestions = new CreateUpstreamPrSuggestions1792090300000();
    const all = [prs, settings, suggestions];

    const run = async (
        migration: { up(r: unknown): Promise<void>; down(r: unknown): Promise<void> },
        direction: 'up' | 'down',
    ) => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner as never);
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
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1'), ('u2')`);
        await dataSource.query(
            `CREATE TABLE "pre_existing" ("id" varchar PRIMARY KEY NOT NULL, "note" varchar)`,
        );
        await dataSource.query(`INSERT INTO "pre_existing" ("id", "note") VALUES ('p1', 'kept')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function tableNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        return rows.map((row) => row.name);
    }

    async function indexNames(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}'`,
        );
        return rows
            .map((row) => row.name)
            .filter((name) => !name.startsWith('sqlite_autoindex_'))
            .sort();
    }

    async function columnNames(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return rows.map((row) => row.name);
    }

    async function indexSql(name: string): Promise<string> {
        const rows: Array<{ sql: string | null }> = await dataSource.query(
            `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '${name}'`,
        );
        return rows[0]?.sql ?? '';
    }

    function insertPr(
        id: string,
        sourceTaskId: string | null,
        state: string,
        workId = 'w1',
        userId = 'u1',
    ): Promise<unknown> {
        const source = sourceTaskId === null ? 'NULL' : `'${sourceTaskId}'`;
        return dataSource.query(
            `INSERT INTO "upstream_pull_requests"
               ("id", "userId", "workId", "sourceTaskId", "upstreamOwner", "upstreamRepo",
                "baseBranch", "headOwner", "headRepo", "headBranch", "state")
             VALUES ('${id}', '${userId}', '${workId}', ${source}, 'acme', 'bookings', 'main',
                     'maya', 'bookings', 'upstream-pr/sms-1a2b', '${state}')`,
        );
    }

    const PR_INDEXES = [
        'idx_upr_due',
        'idx_upr_preparing_started',
        'idx_upr_upstream_opened',
        'idx_upr_user_upstream_opened',
        'idx_upr_work_state',
        'uq_upr_active_source',
    ];

    it('creates the three tables with their indexes, leaving the pre-existing tables alone', async () => {
        for (const migration of all) await run(migration, 'up');

        const tables = await tableNames();
        expect(tables).toEqual(
            expect.arrayContaining([
                'upstream_pull_requests',
                'work_upstream_pr_settings',
                'upstream_pr_suggestions',
                'works',
                'users',
                'pre_existing',
            ]),
        );
        expect(await indexNames('upstream_pull_requests')).toEqual(PR_INDEXES);
        expect(await indexNames('work_upstream_pr_settings')).toEqual(['uq_wups_work']);
        expect(await indexNames('upstream_pr_suggestions')).toEqual([
            'idx_ups_work_sent',
            'uq_ups_task',
        ]);
        expect(await dataSource.query(`SELECT * FROM "pre_existing"`)).toEqual([
            { id: 'p1', note: 'kept' },
        ]);
    });

    it('creates every plan §3.1 column, plus origin and draft, and no token column', async () => {
        await run(prs, 'up');
        const columns = await columnNames('upstream_pull_requests');
        for (const name of [
            'userId',
            'workId',
            'sourceTaskId',
            'preparationTaskId',
            'followUpTaskId',
            'origin',
            'upstreamOwner',
            'upstreamRepo',
            'baseBranch',
            'headOwner',
            'headRepo',
            'headBranch',
            'headSha',
            'upstreamBaseSha',
            'preparationStartedAt',
            'preparationHeldSince',
            'preparationPausedMs',
            'state',
            'number',
            'url',
            'draft',
            'title',
            'body',
            'disclosureText',
            'claUrl',
            'missingPieces',
            'maintainerCanModify',
            'fingerprint',
            'approvalProposalId',
            'approvalExpiresAt',
            'extraFilesAcknowledgedAt',
            'extraFilesAcknowledgedById',
            'checksSummary',
            'reviewSummary',
            'signatureState',
            'refusalCode',
            'refusalDetail',
            'diffStats',
            'checkResults',
            'seenReviewIds',
            'pushTimestamps',
            'forkBranchDeletedAt',
            'lastUpstreamActivityAt',
            'lastCheckedAt',
            'nextCheckAt',
            'openedAt',
            'mergedAt',
            'closedAt',
            'tenantId',
            'organizationId',
            'createdAt',
            'updatedAt',
        ]) {
            expect(columns).toContain(name);
        }
        expect(columns.filter((name) => /token|secret|credential|password/i.test(name))).toEqual(
            [],
        );
    });

    it('is a no-op on a second up, and rebuilds the same shape after down → up', async () => {
        for (const migration of all) await run(migration, 'up');
        for (const migration of all) await run(migration, 'up');
        expect(await indexNames('upstream_pull_requests')).toEqual(PR_INDEXES);

        for (const migration of [...all].reverse()) await run(migration, 'down');
        const afterDown = await tableNames();
        expect(afterDown).not.toContain('upstream_pull_requests');
        expect(afterDown).not.toContain('work_upstream_pr_settings');
        expect(afterDown).not.toContain('upstream_pr_suggestions');
        expect(afterDown).toEqual(expect.arrayContaining(['works', 'users', 'pre_existing']));

        for (const migration of all) await run(migration, 'up');
        expect(await indexNames('upstream_pull_requests')).toEqual(PR_INDEXES);
        expect(await indexNames('work_upstream_pr_settings')).toEqual(['uq_wups_work']);
    });

    it('down() where up() never ran does nothing', async () => {
        for (const migration of [...all].reverse()) await run(migration, 'down');
        expect(await tableNames()).toEqual(
            expect.arrayContaining(['works', 'users', 'pre_existing']),
        );
    });

    it('the active-source index is PARTIAL in the DDL the driver received', async () => {
        await run(prs, 'up');
        const sql = await indexSql('uq_upr_active_source');
        expect(sql).toMatch(/UNIQUE INDEX/i);
        expect(sql).toMatch(/WHERE/i);
        for (const state of [
            'preparing',
            'needs_signature',
            'awaiting_approval',
            'opening',
            'open',
        ]) {
            expect(sql).toContain(`'${state}'`);
        }
        expect(sql).not.toContain("'merged'");
    });

    it('refuses a second ACTIVE record for one source Task; a closed one and a NULL source do not collide', async () => {
        await run(prs, 'up');
        await insertPr('r1', 't1', 'open');
        await expect(insertPr('r2', 't1', 'preparing')).rejects.toThrow(/UNIQUE/i);
        // A final record frees nothing it never held: a closed and a refused row coexist.
        await insertPr('r3', 't1', 'closed');
        await insertPr('r4', 't1', 'refused');
        // A direct, branch-named pull request carries no source Task — never a collision.
        await insertPr('r5', null, 'open');
        await insertPr('r6', null, 'open');
        // Closing the active row frees the slot.
        await dataSource.query(
            `UPDATE "upstream_pull_requests" SET "state" = 'merged' WHERE "id" = 'r1'`,
        );
        await insertPr('r7', 't1', 'preparing');
        const rows: Array<{ id: string }> = await dataSource.query(
            `SELECT id FROM "upstream_pull_requests" ORDER BY id`,
        );
        expect(rows.map((row) => row.id)).toEqual(['r1', 'r3', 'r4', 'r5', 'r6', 'r7']);
    });

    it('defaults origin, state, draft, maintainerCanModify and preparationPausedMs', async () => {
        await run(prs, 'up');
        await insertPr('r1', 't1', 'preparing');
        const [row] = await dataSource.query(
            `SELECT "origin", "draft", "maintainerCanModify", "preparationPausedMs" FROM "upstream_pull_requests"`,
        );
        expect(row.origin).toBe('proposal');
        expect(Number(row.draft)).toBe(0);
        expect(Number(row.maintainerCanModify)).toBe(1);
        expect(Number(row.preparationPausedMs)).toBe(0);
    });

    it('cascades from the Work and from the author', async () => {
        for (const migration of all) await run(migration, 'up');
        await insertPr('r1', 't1', 'open', 'w1', 'u1');
        await insertPr('r2', 't2', 'open', 'w2', 'u2');
        await dataSource.query(
            `INSERT INTO "work_upstream_pr_settings" ("id", "workId", "requestedEnabled", "requestedById", "requestedAt")
             VALUES ('s1', 'w1', 1, 'u1', CURRENT_TIMESTAMP)`,
        );
        await dataSource.query(
            `INSERT INTO "upstream_pr_suggestions" ("id", "workId", "taskId", "userId") VALUES ('g1', 'w1', 't1', 'u1')`,
        );

        await dataSource.query(`DELETE FROM "works" WHERE "id" = 'w1'`);
        expect(await dataSource.query(`SELECT id FROM "upstream_pull_requests"`)).toEqual([
            { id: 'r2' },
        ]);
        expect(await dataSource.query(`SELECT id FROM "work_upstream_pr_settings"`)).toEqual([]);
        expect(await dataSource.query(`SELECT id FROM "upstream_pr_suggestions"`)).toEqual([]);

        await dataSource.query(`DELETE FROM "users" WHERE "id" = 'u2'`);
        expect(await dataSource.query(`SELECT id FROM "upstream_pull_requests"`)).toEqual([]);
    });

    it('one settings row per App Work, one suggestion per Task', async () => {
        for (const migration of all) await run(migration, 'up');
        await dataSource.query(
            `INSERT INTO "work_upstream_pr_settings" ("id", "workId", "requestedEnabled", "requestedById", "requestedAt")
             VALUES ('s1', 'w1', 1, 'u1', CURRENT_TIMESTAMP)`,
        );
        await expect(
            dataSource.query(
                `INSERT INTO "work_upstream_pr_settings" ("id", "workId", "requestedEnabled", "requestedById", "requestedAt")
                 VALUES ('s2', 'w1', 0, 'u1', CURRENT_TIMESTAMP)`,
            ),
        ).rejects.toThrow(/UNIQUE/i);
        await dataSource.query(
            `INSERT INTO "upstream_pr_suggestions" ("id", "workId", "taskId", "userId") VALUES ('g1', 'w1', 't1', 'u1')`,
        );
        await expect(
            dataSource.query(
                `INSERT INTO "upstream_pr_suggestions" ("id", "workId", "taskId", "userId") VALUES ('g2', 'w1', 't1', 'u1')`,
            ),
        ).rejects.toThrow(/UNIQUE/i);
    });

    it.each(sources)(
        '$file is portable: no driver branch, no raw statement, no ALTER',
        ({ source }) => {
            const code = codeOf(source);
            expect(code).not.toMatch(/connection\.options\.type/);
            expect(code).not.toMatch(/queryRunner\.query\(/);
            expect(code).not.toMatch(/\bALTER\b/);
            expect(code).not.toMatch(/interval '/);
            expect(code).not.toMatch(/now\(\)/);
        },
    );
});
