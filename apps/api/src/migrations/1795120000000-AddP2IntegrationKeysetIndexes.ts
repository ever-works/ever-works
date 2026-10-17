import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Integration API v1 keyset indexes on the Phase 2 aggregates (integration plan
 * EW-P2-1 / -2 / -5): Ideas (`work_proposals`), `goals` and `missions`.
 *
 * Their lists are `WHERE organizationId = :org AND (updatedAt, id) > (:cursor)
 * ORDER BY updatedAt, id`, like the P1 lists that
 * `1795080300000-AddIntegrationApiKeysetIndexes` serves; these composite indexes
 * keep a sync page an index range scan however large the organization grows.
 *
 * Additive and idempotent: each index is created only when its table and columns
 * exist and the index does not. `down` drops them.
 */
const KEYSET_INDEXES: ReadonlyArray<{ table: string; name: string; columns: string[] }> = [
    {
        table: 'work_proposals',
        name: 'idx_work_proposals_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
    {
        table: 'goals',
        name: 'idx_goals_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
    {
        table: 'missions',
        name: 'idx_missions_org_updated',
        columns: ['organizationId', 'updatedAt', 'id'],
    },
];

export class AddP2IntegrationKeysetIndexes1795120000000 implements MigrationInterface {
    name = 'AddP2IntegrationKeysetIndexes1795120000000';

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
