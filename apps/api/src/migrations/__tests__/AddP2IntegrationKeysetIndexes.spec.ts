import { DataSource } from 'typeorm';
import { AddP2IntegrationKeysetIndexes1795120000000 } from '../1795120000000-AddP2IntegrationKeysetIndexes';

/**
 * Keyset indexes of the integration API v1 P2 lists (ideas, goals, missions) on
 * in-memory better-sqlite3: created where table and columns exist, skipped where
 * they do not, idempotent, and dropped by `down`.
 */
describe('AddP2IntegrationKeysetIndexes1795120000000', () => {
    let dataSource: DataSource;
    const migration = new AddP2IntegrationKeysetIndexes1795120000000();

    const indexColumns = async (index: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_info("${index}")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
    const indexNames = async (table: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_list("${table}")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        for (const table of ['work_proposals', 'goals']) {
            await dataSource.query(
                `CREATE TABLE "${table}" ("id" varchar PRIMARY KEY, "organizationId" varchar, "updatedAt" datetime)`,
            );
        }
        // No `updatedAt` here: the index is skipped, not failed.
        await dataSource.query(
            `CREATE TABLE "missions" ("id" varchar PRIMARY KEY, "organizationId" varchar)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates (organizationId, updatedAt, id) indexes, skips a table without the columns, and is idempotent', async () => {
        await run('up');
        await run('up');
        expect(await indexColumns('idx_work_proposals_org_updated')).toEqual([
            'organizationId',
            'updatedAt',
            'id',
        ]);
        expect(await indexNames('goals')).toContain('idx_goals_org_updated');
        expect(await indexNames('missions')).not.toContain('idx_missions_org_updated');
    });

    it('skips a missing table', async () => {
        await dataSource.query(`DROP TABLE "goals"`);
        await run('up');
        expect(await indexNames('work_proposals')).toContain('idx_work_proposals_org_updated');
    });

    it('down drops them', async () => {
        await run('up');
        await run('down');
        expect(await indexNames('work_proposals')).not.toContain('idx_work_proposals_org_updated');
        expect(await indexNames('goals')).not.toContain('idx_goals_org_updated');
    });
});
