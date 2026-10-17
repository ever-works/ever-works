import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

const TABLE = 'email_messages';
const INDEX_NAME = 'idx_email_messages_user_message_id_header';

/**
 * EW-P4-3 — RFC threading columns on `email_messages`.
 *
 * Entity: `packages/agent/src/entities/email-message.entity.ts`.
 *
 * - `messageIdHeader` — the message's own RFC 5322 `Message-ID`, bare (no
 *   angle brackets). Outbound: the id the platform now sets on every send.
 *   Inbound: the sender's, when the provider surfaces it. Distinct from
 *   `providerMessageId` (the provider's handle, e.g. Postmark's UUID).
 * - `inReplyTo` — the first id of `In-Reply-To`, bare.
 * - `references` — every id of `References`, bare, oldest first, as
 *   `simple-json` (`text`) like the address lists next to it.
 *
 * Index (`userId`, `messageIdHeader`): the inbound dispatcher asks "which of
 * this owner's messages has Message-ID X?" for every id an inbound reply
 * names, and the lookup is owner-scoped because the header is sender-written.
 *
 * No backfill: no existing row recorded the headers, and NULL means
 * "unknown", which threads by subject exactly as before.
 *
 * Forward-only with per-step guards, so a partially applied database
 * converges; portable `TableColumn` / `TableIndex` DDL, because production
 * runs Postgres, self-hosted installs may run MySQL, and CI / e2e run
 * better-sqlite3. `references` is a reserved word in SQL: the DDL and every
 * query TypeORM writes quote identifiers, and nothing reads it in raw SQL.
 */
export class AddEmailMessageThreadingHeaders1795061520000 implements MigrationInterface {
    name = 'AddEmailMessageThreadingHeaders1795061520000';

    private static columns(): TableColumn[] {
        return [
            new TableColumn({
                name: 'messageIdHeader',
                type: 'varchar',
                length: '255',
                isNullable: true,
            }),
            new TableColumn({
                name: 'inReplyTo',
                type: 'varchar',
                length: '255',
                isNullable: true,
            }),
            new TableColumn({ name: 'references', type: 'text', isNullable: true }),
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) return;

        for (const column of AddEmailMessageThreadingHeaders1795061520000.columns()) {
            // Re-read each time: the sqlite driver rebuilds the table on
            // addColumn, so earlier metadata is stale.
            const current = await queryRunner.getTable(TABLE);
            if (current && !current.findColumnByName(column.name)) {
                await queryRunner.addColumn(TABLE, column);
            }
        }

        const refreshed = await queryRunner.getTable(TABLE);
        if (refreshed && !refreshed.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.createIndex(
                TABLE,
                new TableIndex({ name: INDEX_NAME, columnNames: ['userId', 'messageIdHeader'] }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table) return;
        if (table.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.dropIndex(TABLE, INDEX_NAME);
        }
        for (const name of ['references', 'inReplyTo', 'messageIdHeader']) {
            const current = await queryRunner.getTable(TABLE);
            if (current?.findColumnByName(name)) {
                await queryRunner.dropColumn(TABLE, name);
            }
        }
    }
}
