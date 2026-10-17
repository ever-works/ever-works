import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

const TABLE = 'inbox_items';
const COLUMN = 'version';

/**
 * EW-P3-1 — `inbox_items.version int NOT NULL DEFAULT 1`: the aggregate
 * version the `inbox.item.*` domain events carry (and the `ETag` of
 * `GET /api/integrations/v1/inbox/items/:id`), exactly like the P1 aggregates
 * got theirs in `CreateDomainEventsOutbox1795052100000`.
 *
 * Entity: `packages/agent/src/entities/inbox-item.entity.ts`.
 *
 * Every existing row starts at 1. No index (read with its row only).
 * Forward-only with a guard so a partially applied database converges;
 * portable `TableColumn` DDL for Postgres, MySQL and better-sqlite3.
 */
export class AddInboxItemVersion1795090000000 implements MigrationInterface {
    name = 'AddInboxItemVersion1795090000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'int', default: 1, isNullable: false }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (table?.findColumnByName(COLUMN)) {
            await queryRunner.dropColumn(TABLE, COLUMN);
        }
    }
}
