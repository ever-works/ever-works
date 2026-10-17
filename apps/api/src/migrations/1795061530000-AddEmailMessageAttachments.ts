import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

const TABLE = 'email_messages';
const COLUMN = 'attachments';

/**
 * EW-P4-3 — `email_messages.attachments`: the attachments of an inbound
 * message, as `simple-json` (`text`) like the address lists next to it.
 *
 * Entity: `packages/agent/src/entities/email-message.entity.ts`
 * (`EmailMessageAttachmentRecord[]`). Each entry lists the attachment
 * (filename, MIME type, size, Content-ID) and where its bytes went: the
 * `user_uploads` content id when the upload pipeline stored them, or why it
 * refused them. Before this column the inbound webhook dropped attachments
 * entirely.
 *
 * NULL = no attachments (every existing row: none were ever kept). No
 * backfill, no index (it is read with its message, never searched).
 *
 * Forward-only with a guard so a partially applied database converges;
 * portable `TableColumn` DDL for Postgres, MySQL and better-sqlite3.
 */
export class AddEmailMessageAttachments1795061530000 implements MigrationInterface {
    name = 'AddEmailMessageAttachments1795061530000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'text', isNullable: true }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (table?.findColumnByName(COLUMN)) {
            await queryRunner.dropColumn(TABLE, COLUMN);
        }
    }
}
