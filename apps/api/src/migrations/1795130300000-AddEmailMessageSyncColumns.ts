import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

const TABLE = 'email_messages';
const INDEX = 'idx_email_messages_org_updated';

/**
 * EW-P4-2 — agent email in the integration contract (`email.message.*` events,
 * `GET /api/integrations/v1/email/messages?updatedSince=`):
 *
 * - `updatedAt` (`timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP`): every write
 *   moves it, so `updatedSince` catches status and delivery changes. Existing
 *   rows are backfilled with their `createdAt`, so a first sync does not see
 *   every old message as just changed.
 * - `version` (`int NOT NULL DEFAULT 1`): the aggregate version the events
 *   carry, as the other aggregates got in `CreateDomainEventsOutbox1795052100000`.
 * - the keyset index `(organizationId, updatedAt, id)` of the integration list.
 *
 * Entity: `packages/agent/src/entities/email-message.entity.ts`.
 *
 * Additive and idempotent; portable `TableColumn` / `TableIndex` DDL and a
 * driver-escaped backfill for Postgres, MySQL and better-sqlite3. `down` drops
 * exactly what `up` adds.
 */
export class AddEmailMessageSyncColumns1795130300000 implements MigrationInterface {
    name = 'AddEmailMessageSyncColumns1795130300000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        let table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (!table.findColumnByName('updatedAt')) {
            await queryRunner.addColumn(
                TABLE,
                new TableColumn({
                    name: 'updatedAt',
                    type: 'timestamp',
                    default: 'CURRENT_TIMESTAMP',
                    isNullable: false,
                }),
            );
            if (table.findColumnByName('createdAt')) {
                const escape = (name: string) => queryRunner.connection.driver.escape(name);
                await queryRunner.query(
                    `UPDATE ${escape(TABLE)} SET ${escape('updatedAt')} = ${escape('createdAt')}`,
                );
            }
        }
        if (!table.findColumnByName('version')) {
            await queryRunner.addColumn(
                TABLE,
                new TableColumn({ name: 'version', type: 'int', default: 1, isNullable: false }),
            );
        }
        table = await queryRunner.getTable(TABLE);
        if (!table) return;
        const present = new Set(table.columns.map((column) => column.name));
        const columns = ['organizationId', 'updatedAt', 'id'];
        if (
            columns.every((column) => present.has(column)) &&
            !table.indices.some((index) => index.name === INDEX)
        ) {
            await queryRunner.createIndex(
                TABLE,
                new TableIndex({ name: INDEX, columnNames: columns }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (table.indices.some((index) => index.name === INDEX)) {
            await queryRunner.dropIndex(TABLE, INDEX);
        }
        if (table.findColumnByName('version')) await queryRunner.dropColumn(TABLE, 'version');
        if (table.findColumnByName('updatedAt')) await queryRunner.dropColumn(TABLE, 'updatedAt');
    }
}
