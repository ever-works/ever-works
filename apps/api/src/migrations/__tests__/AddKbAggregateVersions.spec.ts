import { DataSource } from 'typeorm';
import { AddKbAggregateVersions1795130200000 } from '../1795130200000-AddKbAggregateVersions';

/**
 * EW-P3-2 — `version` on KB documents and library folders plus their keyset
 * indexes, on in-memory better-sqlite3 (the PHYSICAL schema through `PRAGMA`):
 * existing rows read 1, idempotent, `down` drops exactly what `up` added, and a
 * missing table is skipped.
 */
describe('AddKbAggregateVersions1795130200000', () => {
    let dataSource: DataSource;
    const migration = new AddKbAggregateVersions1795130200000();
    const TABLES = ['work_knowledge_documents', 'memory_folders'];

    const columns = async (
        table: string,
    ): Promise<Array<{ name: string; notnull: number; dflt_value: unknown }>> =>
        dataSource.query(`PRAGMA table_info("${table}")`);
    const indexNames = async (table: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_list("${table}")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
    const indexColumns = async (index: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_info("${index}")`)) as Array<{ name: string }>).map(
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
        for (const table of TABLES) {
            await dataSource.query(
                `CREATE TABLE "${table}" ("id" varchar PRIMARY KEY, "organizationId" varchar, "updatedAt" datetime)`,
            );
            await dataSource.query(`INSERT INTO "${table}" ("id") VALUES ('row-1')`);
        }
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds a NOT NULL version defaulting to 1 (existing rows read 1) and the keyset indexes, idempotently', async () => {
        await run('up');
        await run('up');
        for (const table of TABLES) {
            const version = (await columns(table)).filter((column) => column.name === 'version');
            expect(version).toHaveLength(1);
            expect(version[0].notnull).toBe(1);
            expect(String(version[0].dflt_value)).toBe('1');
            expect(await dataSource.query(`SELECT version FROM "${table}"`)).toEqual([
                { version: 1 },
            ]);
        }
        for (const index of ['idx_wkd_org_updated', 'idx_memory_folders_org_updated']) {
            expect(await indexColumns(index)).toEqual(['organizationId', 'updatedAt', 'id']);
        }
    });

    it('down() drops the columns and indexes and keeps the rows', async () => {
        await run('up');
        await run('down');
        for (const table of TABLES) {
            expect((await columns(table)).map((column) => column.name)).not.toContain('version');
            expect(await dataSource.query(`SELECT id FROM "${table}"`)).toEqual([{ id: 'row-1' }]);
        }
        expect(await indexNames('work_knowledge_documents')).not.toContain('idx_wkd_org_updated');
        expect(await indexNames('memory_folders')).not.toContain('idx_memory_folders_org_updated');
        await expect(run('down')).resolves.toBeUndefined();
    });

    it('skips a missing table', async () => {
        await dataSource.query(`DROP TABLE "memory_folders"`);
        await expect(run('up')).resolves.toBeUndefined();
        expect((await columns('work_knowledge_documents')).map((column) => column.name)).toContain(
            'version',
        );
        await expect(run('down')).resolves.toBeUndefined();
    });
});
