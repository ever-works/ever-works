import { DataSource, Table } from 'typeorm';
import { AddSafetyRailsCore1791240000000 } from '../1791240000000-AddSafetyRailsCore';

/**
 * Safety rails (AW-24, P1) — the three tables.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs,
 * asserting against the PHYSICAL schema (`PRAGMA table_info`,
 * `PRAGMA index_list`, `PRAGMA foreign_key_list`) rather than against the
 * DDL the migration meant to emit.
 */
describe('AddSafetyRailsCore1791240000000', () => {
    let dataSource: DataSource;
    const migration = new AddSafetyRailsCore1791240000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'users',
                columns: [{ name: 'id', type: 'uuid', isPrimary: true }],
            }),
        );
        await runner.query(`INSERT INTO "users" ("id") VALUES ('u1'), ('u2')`);
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function runDown(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
    }

    async function columns(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return rows.map((row) => row.name).sort();
    }

    async function indexNames(table: string): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("${table}")`,
        );
        return rows.map((row) => row.name).sort();
    }

    it('creates all three tables with their declared columns', async () => {
        await runUp();

        expect(await columns('autonomy_grants')).toEqual([
            'category',
            'createdAt',
            'id',
            'note',
            'organizationId',
            'rung',
            'scopeId',
            'scopeType',
            'setByUserId',
            'tenantId',
            'updatedAt',
            'userId',
        ]);
        expect(await columns('rail_refusals')).toEqual([
            'agentId',
            'category',
            'ceiling',
            'collapseKey',
            'createdAt',
            'id',
            'organizationId',
            'proposalId',
            'railId',
            'reasonCode',
            'requested',
            'runId',
            'subjectId',
            'subjectType',
            'summary',
            'tenantId',
            'userId',
            'verdict',
        ]);
        expect(await columns('workspace_pauses')).toEqual([
            'cleanlyStopped',
            'createdAt',
            'id',
            'organizationId',
            'pausedAt',
            'pausedByUserId',
            'reason',
            'refusedStarts',
            'tenantId',
            'updatedAt',
            'userId',
        ]);
    });

    it('declares every index the resolver and the log read through', async () => {
        await runUp();

        expect(await indexNames('autonomy_grants')).toEqual(
            expect.arrayContaining([
                'idx_autonomy_grants_scope',
                'idx_autonomy_grants_user',
                'uq_autonomy_grants_owner_scope_category',
            ]),
        );
        expect(await indexNames('rail_refusals')).toEqual(
            expect.arrayContaining([
                'idx_rail_refusals_agent_category',
                'idx_rail_refusals_collapse',
                'idx_rail_refusals_rail',
                'idx_rail_refusals_user_created',
            ]),
        );
        expect(await indexNames('workspace_pauses')).toEqual(
            expect.arrayContaining([
                'idx_workspace_pauses_tenant',
                'idx_workspace_pauses_user',
                'uq_workspace_pauses_scope',
                'uq_workspace_pauses_tenant_only',
            ]),
        );
    });

    it('refuses a second rung for the same owner, scope and category', async () => {
        await runUp();
        const insert = (id: string) =>
            dataSource.query(
                `INSERT INTO "autonomy_grants"
                 ("id","userId","scopeType","scopeId","category","rung","setByUserId","createdAt","updatedAt")
                 VALUES ('${id}','u1','workspace','org1','message.external','draft','u1','2026-09-01','2026-09-01')`,
            );

        await insert('g1');
        // Two rows disagreeing about what an Agent may do is not a race we can
        // resolve at read time — the database has to refuse it.
        await expect(insert('g2')).rejects.toThrow();
    });

    it('allows the same category on a different scope', async () => {
        await runUp();
        await dataSource.query(
            `INSERT INTO "autonomy_grants"
             ("id","userId","scopeType","scopeId","category","rung","setByUserId","createdAt","updatedAt")
             VALUES ('g1','u1','workspace','org1','message.external','draft','u1','2026-09-01','2026-09-01'),
                    ('g2','u1','agent','agent1','message.external','off','u1','2026-09-01','2026-09-01')`,
        );
        const rows = await dataSource.query(`SELECT "id" FROM "autonomy_grants" ORDER BY "id"`);
        expect(rows.map((row: { id: string }) => row.id)).toEqual(['g1', 'g2']);
    });

    it('allows at most one pause per workspace, NULL organization included', async () => {
        await runUp();
        const pause = (id: string, organizationId: string | null) =>
            dataSource.query(
                `INSERT INTO "workspace_pauses"
                 ("id","userId","tenantId","organizationId","pausedByUserId","pausedAt","refusedStarts","cleanlyStopped","createdAt","updatedAt")
                 VALUES ('${id}','u1','t1',${
                     organizationId === null ? 'NULL' : `'${organizationId}'`
                 },'u1','2026-09-01',0,0,'2026-09-01','2026-09-01')`,
            );

        await pause('p1', 'org1');
        await expect(pause('p2', 'org1')).rejects.toThrow();

        // The bare-tenant workspace is the case a plain unique pair would miss:
        // SQL treats NULLs as DISTINCT inside a unique index.
        await pause('p3', null);
        await expect(pause('p4', null)).rejects.toThrow();
    });

    it('cascades every table to its owner', async () => {
        await runUp();
        for (const table of ['autonomy_grants', 'rail_refusals', 'workspace_pauses']) {
            const keys: Array<{ table: string; from: string; on_delete: string }> =
                await dataSource.query(`PRAGMA foreign_key_list("${table}")`);
            const owner = keys.find((key) => key.from === 'userId');
            expect(owner?.table).toBe('users');
            expect(owner?.on_delete).toBe('CASCADE');
        }
    });

    it('never joins the audit stamp to users', async () => {
        // CASCADE there would delete a narrowed rung (a silent WIDENING) or
        // lift a pause (a silent RESUME) because another account was removed.
        await runUp();
        const grantKeys: Array<{ from: string }> = await dataSource.query(
            `PRAGMA foreign_key_list("autonomy_grants")`,
        );
        expect(grantKeys.map((key) => key.from)).not.toContain('setByUserId');
        const pauseKeys: Array<{ from: string }> = await dataSource.query(
            `PRAGMA foreign_key_list("workspace_pauses")`,
        );
        expect(pauseKeys.map((key) => key.from)).not.toContain('pausedByUserId');
    });

    it('is re-runnable and writes nothing the second time', async () => {
        await runUp();
        await dataSource.query(
            `INSERT INTO "autonomy_grants"
             ("id","userId","scopeType","scopeId","category","rung","setByUserId","createdAt","updatedAt")
             VALUES ('g1','u1','workspace','org1','publish.external','ask','u1','2026-09-01','2026-09-01')`,
        );

        await runUp();

        const rows = await dataSource.query(`SELECT "id" FROM "autonomy_grants"`);
        expect(rows).toHaveLength(1);
        expect(await indexNames('autonomy_grants')).toEqual(
            expect.arrayContaining(['uq_autonomy_grants_owner_scope_category']),
        );
    });

    it('drops only the tables it created', async () => {
        await runUp();
        await runDown();

        for (const table of ['autonomy_grants', 'rail_refusals', 'workspace_pauses']) {
            const rows = await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
            );
            expect(rows).toHaveLength(0);
        }
        // Somebody else's table is untouched.
        const users = await dataSource.query(`SELECT "id" FROM "users" ORDER BY "id"`);
        expect(users.map((row: { id: string }) => row.id)).toEqual(['u1', 'u2']);
    });

    it('refuses to adopt a foreign table that happens to share the name', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'rail_refusals',
                columns: [{ name: 'id', type: 'uuid', isPrimary: true }],
            }),
        );
        await runner.release();

        await expect(runUp()).rejects.toThrow(/already exists without the columns/);
    });

    it('keeps an adopted table and its rows on the way back down', async () => {
        // A schema-synchronised database (the e2e harness) builds these tables
        // from the entities, so `up()` adopts rather than creates. `down()`
        // must then never drop somebody else's rows.
        await runUp();
        const runner = dataSource.createQueryRunner();
        await runner.dropIndex('autonomy_grants', 'idx_autonomy_grants_owned_1791240000000');
        await runner.release();
        await dataSource.query(
            `INSERT INTO "autonomy_grants"
             ("id","userId","scopeType","scopeId","category","rung","setByUserId","createdAt","updatedAt")
             VALUES ('g1','u1','workspace','org1','machine.run','ask','u1','2026-09-01','2026-09-01')`,
        );

        await runDown();

        const rows = await dataSource.query(`SELECT "id" FROM "autonomy_grants"`);
        expect(rows).toHaveLength(1);
        expect(await indexNames('autonomy_grants')).not.toEqual(
            expect.arrayContaining(['uq_autonomy_grants_owner_scope_category']),
        );
    });
});
