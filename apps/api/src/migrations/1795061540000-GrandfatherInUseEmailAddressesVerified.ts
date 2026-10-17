import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EW-P4-3 — grandfather tenant email addresses that are already IN USE as
 * verified, before the platform starts refusing to send from unverified ones.
 *
 * Until EW-P4-3, address verification was cosmetic: no confirmation email
 * was ever sent and `tenant_email_addresses.verified` was never checked, so no
 * address could have become verified the honest way. The send path now
 * refuses unverified senders. Marking every address that is ALREADY being
 * used keeps working setups working (no-removal / no-breakage rule):
 *
 * - it is assigned to an Agent (`agent_email_assignments`), or
 * - it already sent mail (an outbound `email_messages` row), or
 * - an Agent's inbox pins it as the sending address (`agent_inboxes`).
 *
 * Anything else (registered but never used) stays unverified; its owner
 * verifies it through the confirmation email before its first send.
 *
 * Portable: one `UPDATE ... WHERE id IN (SELECT ...)` per source, with
 * driver-escaped identifiers and the driver's boolean literal, on Postgres,
 * MySQL and better-sqlite3. Each source table is checked first, so an
 * install that lacks one simply skips it. Idempotent (`verified = false`
 * guard).
 *
 * `down()` is a deliberate no-op: once grandfathered, a row is
 * indistinguishable from one its owner verified later, and un-verifying a
 * row that was really verified would break sending.
 */
export class GrandfatherInUseEmailAddressesVerified1795061540000 implements MigrationInterface {
    name = 'GrandfatherInUseEmailAddressesVerified1795061540000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tenant_email_addresses'))) return;
        const driver = queryRunner.connection.driver;
        const q = (identifier: string): string => driver.escape(identifier);
        const type = queryRunner.connection.options.type;
        const TRUE = type === 'postgres' ? 'TRUE' : '1';
        const FALSE = type === 'postgres' ? 'FALSE' : '0';

        const sources: Array<{ table: string; where?: string }> = [
            { table: 'agent_email_assignments' },
            { table: 'email_messages', where: `${q('direction')} = 'outbound'` },
            { table: 'agent_inboxes', where: `${q('emailAddressId')} IS NOT NULL` },
        ];
        for (const source of sources) {
            if (!(await queryRunner.hasTable(source.table))) continue;
            await queryRunner.query(
                `UPDATE ${q('tenant_email_addresses')} SET ${q('verified')} = ${TRUE} ` +
                    `WHERE ${q('verified')} = ${FALSE} AND ${q('id')} IN (` +
                    `SELECT ${q('emailAddressId')} FROM ${q(source.table)}` +
                    (source.where ? ` WHERE ${source.where}` : '') +
                    `)`,
            );
        }
    }

    public async down(): Promise<void> {
        // Deliberately a no-op: see the class comment.
    }
}
