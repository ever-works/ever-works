import { DataSource, Table } from 'typeorm';
import { AddWorkUpstreamCredentialMember1792090000000 } from '../1792090000000-AddWorkUpstreamCredentialMember';

/**
 * APW-09 T43 — migration test for the credential-of-record column, run against
 * an in-memory better-sqlite3 DataSource (the same harness as the sibling
 * migration specs, e.g. `CreateWorkUpstreamStates.spec.ts` and
 * `AddAgentHaltReason.spec.ts`).
 *
 * What matters, and what the migration's own docstring claims:
 *
 *  - the column is **nullable with no default**, which is what makes
 *    `ADD COLUMN` legal on a table that already has rows — the reason the API
 *    still boots with `DATABASE_AUTOMIGRATE=true` on an installation that has
 *    App Works (a `NOT NULL` column without a default would fail there);
 *  - a row that exists **before** the migration keeps `NULL`: nobody had handed
 *    anything over, and the migration must not invent the creator's id (NULL is
 *    what makes `source: 'creator'` distinguishable from `source: 'handover'`);
 *  - a handover written after it round-trips;
 *  - a re-run is a no-op and `down()` drops only this one column, leaving the row
 *    and every other column intact;
 *  - a database where `up()` never ran survives both directions.
 *
 * The `work_upstream_states` table below is a stub carrying only the columns the
 * assertions need: this migration owns one column of a table another migration
 * owns, and the table's full 55-column shape is pinned by
 * `CreateWorkUpstreamStates.spec.ts`, not re-asserted here.
 */
describe('AddWorkUpstreamCredentialMember1792090000000', () => {
    let dataSource: DataSource;
    const migration = new AddWorkUpstreamCredentialMember1792090000000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    const column = async (name: string) => {
        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('work_upstream_states');
        await runner.release();
        return table?.findColumnByName(name);
    };

    const stored = (): Promise<Array<Record<string, unknown>>> =>
        dataSource.query(
            `SELECT "id", "workId", "relation", "readinessStartedAt", "organizationId", "credentialMemberUserId"
             FROM "work_upstream_states" ORDER BY "id"`,
        );

    /** The same row read once the column is gone — the post-`down()` shape. */
    const storedWithoutColumn = (): Promise<Array<Record<string, unknown>>> =>
        dataSource.query(
            `SELECT "id", "workId", "relation", "readinessStartedAt", "organizationId"
             FROM "work_upstream_states" ORDER BY "id"`,
        );

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
                name: 'work_upstream_states',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'workId', type: 'uuid' },
                    { name: 'relation', type: 'varchar', length: '16' },
                    { name: 'readinessStartedAt', type: 'bigint' },
                    // EW-655 scope stamping, exactly as 179202 declares it.
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
        );
        // A row that predates the column: the case the nullability exists for.
        await runner.query(
            `INSERT INTO "work_upstream_states" ("id", "workId", "relation", "readinessStartedAt", "organizationId")
             VALUES ('s1', 'w1', 'fork', 1772000000000, 'org-1')`,
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds one nullable uuid column, and nothing else', async () => {
        await run('up');

        const added = await column('credentialMemberUserId');
        expect(added).toBeDefined();
        expect(added?.type).toBe('uuid');
        expect(added?.isNullable).toBe(true);
        // No default: NULL has to mean "no handover", not "the empty uuid".
        expect(added?.default ?? null).toBeNull();

        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('work_upstream_states');
        await runner.release();
        // The stub's own six columns are untouched by the migration.
        expect([...(table?.columns ?? [])].map((entry) => entry.name).sort()).toEqual([
            'createdAt',
            'credentialMemberUserId',
            'id',
            'organizationId',
            'readinessStartedAt',
            'relation',
            'workId',
        ]);
    });

    it('leaves a row that already existed with NULL — nobody handed anything over', async () => {
        await run('up');

        expect(await stored()).toEqual([
            {
                id: 's1',
                workId: 'w1',
                relation: 'fork',
                readinessStartedAt: 1772000000000,
                organizationId: 'org-1',
                credentialMemberUserId: null,
            },
        ]);
    });

    it('round-trips a handover written after it, and leaves the other columns alone', async () => {
        await run('up');

        await dataSource.query(
            `UPDATE "work_upstream_states" SET "credentialMemberUserId" = 'member-2' WHERE "workId" = 'w1'`,
        );

        const [row] = await stored();
        expect(row.credentialMemberUserId).toBe('member-2');
        expect(row.organizationId).toBe('org-1');
        expect(row.relation).toBe('fork');
    });

    it('is idempotent on re-run and reversible, leaving the row behind', async () => {
        await run('up');
        await run('up');

        expect((await column('credentialMemberUserId'))?.isNullable).toBe(true);

        await run('down');
        expect(await column('credentialMemberUserId')).toBeUndefined();

        // The row survives a revert — only the recorded member goes, and the
        // credential of record falls back to the Work's creator, which is the
        // behaviour that existed before this column.
        expect(await storedWithoutColumn()).toEqual([
            {
                id: 's1',
                workId: 'w1',
                relation: 'fork',
                readinessStartedAt: 1772000000000,
                organizationId: 'org-1',
            },
        ]);

        // A second revert is a no-op rather than an error.
        await run('down');
        expect(await column('credentialMemberUserId')).toBeUndefined();
    });

    it('is a no-op in both directions on a database that has no state table', async () => {
        await dataSource.query(`DROP TABLE "work_upstream_states"`);

        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();

        const runner = dataSource.createQueryRunner();
        const table = await runner.getTable('work_upstream_states');
        await runner.release();
        // The migration never re-creates a table another migration owns.
        expect(table).toBeUndefined();
    });
});
