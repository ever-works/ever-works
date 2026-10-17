import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * EW-P3-2 — Knowledge Base domain events and the integration KB routes:
 *
 * - `work_knowledge_documents.version` and `memory_folders.version`
 *   (`int NOT NULL DEFAULT 1`): the aggregate version `kb.document.*` /
 *   `kb.folder.*` events carry and the `ETag` of `GET /api/integrations/v1/kb/...`,
 *   exactly like the P1 aggregates got theirs in
 *   `CreateDomainEventsOutbox1795052100000`. Every existing row starts at 1.
 * - keyset indexes `(organizationId, updatedAt, id)` for the integration lists
 *   of an organization's documents and library folders (as
 *   `AddIntegrationApiKeysetIndexes1795080300000` did for the P1 lists).
 *
 * Entities: `work-knowledge-document.entity.ts`, `memory-folder.entity.ts`.
 *
 * Additive and idempotent (each step only when its table and columns exist and
 * the column / index does not); portable `TableColumn` / `TableIndex` DDL for
 * Postgres, MySQL and better-sqlite3. `down` drops exactly what `up` adds.
 */
const VERSIONED_TABLES = ['work_knowledge_documents', 'memory_folders'] as const;

const KEYSET_INDEXES: ReadonlyArray<{ table: string; name: string; columns: string[] }> = [
    {
        table: 'work_knowledge_documents',
        name: 'idx_wkd_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
    {
        table: 'memory_folders',
        name: 'idx_memory_folders_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
];

export class AddKbAggregateVersions1795130200000 implements MigrationInterface {
    name = 'AddKbAggregateVersions1795130200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of VERSIONED_TABLES) {
            const table = await queryRunner.getTable(tableName);
            if (!table || table.findColumnByName('version')) continue;
            await queryRunner.addColumn(
                tableName,
                new TableColumn({ name: 'version', type: 'int', default: 1, isNullable: false }),
            );
        }
        for (const { table: tableName, name, columns } of KEYSET_INDEXES) {
            const table = await queryRunner.getTable(tableName);
            if (!table) continue;
            const present = new Set(table.columns.map((column) => column.name));
            if (!columns.every((column) => present.has(column))) continue;
            if (table.indices.some((index) => index.name === name)) continue;
            await queryRunner.createIndex(
                tableName,
                new TableIndex({ name, columnNames: columns }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const { table: tableName, name } of KEYSET_INDEXES) {
            const table = await queryRunner.getTable(tableName);
            if (table?.indices.some((index) => index.name === name)) {
                await queryRunner.dropIndex(tableName, name);
            }
        }
        for (const tableName of VERSIONED_TABLES) {
            const table = await queryRunner.getTable(tableName);
            if (table?.findColumnByName('version')) {
                await queryRunner.dropColumn(tableName, 'version');
            }
        }
    }
}
