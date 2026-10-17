import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

const TABLE = 'tenant_email_addresses';
const COLUMN = 'verificationSentAt';

/**
 * EW-P4-3 — `tenant_email_addresses.verificationSentAt`: when a confirmation
 * email was last SENT for the address.
 *
 * Entity: `packages/agent/src/entities/tenant-email-address.entity.ts`.
 *
 * `POST /api/email/addresses/:id/verify` mails a one-time link and refuses
 * another within a minute. Inferring "a link was just sent" from the token's
 * expiry could not tell a sent token from the one `createAddress` mints (and
 * never mails), so the first click right after adding an address was refused,
 * and quick retries could slip through. The send is now recorded here and
 * claimed with a compare-and-set, so concurrent clicks send one email.
 *
 * NULL = never sent (every existing row: no confirmation email was ever sent
 * before EW-P4-3). No backfill, no index (read with its row only).
 *
 * Forward-only with a guard so a partially applied database converges;
 * portable `TableColumn` DDL (`timestamp`, matching `@PortableDateColumn`)
 * for Postgres, MySQL and better-sqlite3.
 */
export class AddTenantEmailAddressVerificationSentAt1795061550000 implements MigrationInterface {
    name = 'AddTenantEmailAddressVerificationSentAt1795061550000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (!table || table.findColumnByName(COLUMN)) return;
        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'timestamp', isNullable: true }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable(TABLE);
        if (table?.findColumnByName(COLUMN)) {
            await queryRunner.dropColumn(TABLE, COLUMN);
        }
    }
}
