import { DataSource } from 'typeorm';
import { AddIntegrationApiKeysetIndexes1795080300000 } from '../1795080300000-AddIntegrationApiKeysetIndexes';

/**
 * Keyset indexes of the integration API v1 lists (EW-P1-4) on in-memory
 * better-sqlite3: created where table and columns exist, skipped where they do
 * not, idempotent, and dropped by `down`.
 */
describe('AddIntegrationApiKeysetIndexes1795080300000', () => {
    let dataSource: DataSource;
    const migration = new AddIntegrationApiKeysetIndexes1795080300000();

    const indexColumns = async (table: string, index: string): Promise<string[]> =>
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
        for (const table of ['tasks', 'teams', 'agents', 'works', 'organization_members']) {
            await dataSource.query(
                `CREATE TABLE "${table}" ("id" varchar PRIMARY KEY, "organizationId" varchar, "updatedAt" datetime)`,
            );
        }
        // No `updatedAt` here: the index is skipped, not failed.
        await dataSource.query(
            `CREATE TABLE "task_chat_messages" ("id" varchar PRIMARY KEY, "taskId" varchar)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates (organizationId, updatedAt, id) indexes, skips a table without the columns, and is idempotent', async () => {
        await run('up');
        await run('up');
        expect(await indexColumns('tasks', 'idx_tasks_org_updated')).toEqual([
            'organizationId',
            'updatedAt',
            'id',
        ]);
        for (const [table, index] of [
            ['teams', 'idx_teams_org_updated'],
            ['agents', 'idx_agents_org_updated'],
            ['works', 'idx_works_org_updated'],
            ['organization_members', 'idx_org_members_org_updated'],
        ]) {
            expect(await indexNames(table)).toContain(index);
        }
        expect(await indexNames('task_chat_messages')).not.toContain('idx_task_chat_task_updated');
    });

    it('down drops them', async () => {
        await run('up');
        await run('down');
        expect(await indexNames('tasks')).not.toContain('idx_tasks_org_updated');
        expect(await indexNames('teams')).not.toContain('idx_teams_org_updated');
    });
});
