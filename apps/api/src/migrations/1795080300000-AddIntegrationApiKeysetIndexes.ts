import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Integration API v1 keyset indexes (EW-P1-4, contract v1 B.1 lists).
 *
 * Every integration list is `WHERE organizationId = :org AND (updatedAt, id) >
 * (:cursor) ORDER BY updatedAt, id` (comments: per task). These composite
 * indexes serve that read directly, so a sync page stays an index range scan
 * however large the organization grows.
 *
 * Additive and idempotent: each index is created only when its table and
 * columns exist and the index does not. `down` drops them.
 */
const KEYSET_INDEXES: ReadonlyArray<{ table: string; name: string; columns: string[] }> = [
    {
        table: 'tasks',
        name: 'idx_tasks_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
    {
        table: 'teams',
        name: 'idx_teams_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
    {
        table: 'agents',
        name: 'idx_agents_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
    {
        table: 'works',
        name: 'idx_works_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
    {
        table: 'organization_members',
        name: 'idx_org_members_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
    {
        table: 'task_chat_messages',
        name: 'idx_task_chat_task_updated',
        columns: ['taskId', 'updatedAt', 'id'],
    },
];

export class AddIntegrationApiKeysetIndexes1795080300000 implements MigrationInterface {
    name = 'AddIntegrationApiKeysetIndexes1795080300000';

    public async up(queryRunner: QueryRunner): Promise<void> {
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
    }
}
