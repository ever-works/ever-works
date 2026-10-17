import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

const TABLE = 'inbox_items';
const INDEX = 'idx_inbox_items_org_updated';
const COLUMNS = ['organizationId', 'updatedAt', 'id'];

/**
 * EW-P3-1 — keyset index of the integration inbox list
 * (`GET /api/integrations/v1/inbox/items`, contract v1 B.6 "Inbox"):
 * `WHERE organizationId = :org AND (updatedAt, id) > (:cursor) ORDER BY
 * updatedAt, id`, exactly like the P1 lists got theirs in
 * `AddIntegrationApiKeysetIndexes1795080300000`.
 *
 * Entity: `packages/agent/src/entities/inbox-item.entity.ts`.
 *
 * Additive and idempotent (created only when the table and its columns exist
 * and the index does not); portable `TableIndex` DDL for Postgres, MySQL and
 * better-sqlite3. `down` drops it.
 */
export class AddInboxItemsKeysetIndex1795130100000 implements MigrationInterface {
    name = 'AddInboxItemsKeysetIndex1795130100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) return;
        const present = new Set(table.columns.map((column) => column.name));
        if (!COLUMNS.every((column) => present.has(column))) return;
        if (table.indices.some((index) => index.name === INDEX)) return;
        await queryRunner.createIndex(TABLE, new TableIndex({ name: INDEX, columnNames: COLUMNS }));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (table?.indices.some((index) => index.name === INDEX)) {
            await queryRunner.dropIndex(TABLE, INDEX);
        }
    }
}
