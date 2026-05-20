import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * 1f — Magic-link passwordless auth columns.
 *
 * Adds the storage backing the new `/api/auth/magic-link` issuance +
 * redemption endpoints. The token is hashed at rest (sha256, mirroring
 * the password-reset and email-verification token storage in
 * `auth.service.ts`); only the raw token travels via email.
 *
 *  - `magicLinkToken` (varchar, nullable) — sha256 hex of the issued
 *    token, NULL when no link is outstanding.
 *  - `magicLinkExpires` (timestamp, nullable) — when the link stops
 *    being valid. The redemption path checks `now > expires` and
 *    rejects.
 *
 * Both default to NULL so existing rows pick up the new shape without
 * a backfill. The migration is idempotent — calling it twice is a
 * no-op (mirrors AddLoginLockoutH17_1779400000000).
 */
export class AddMagicLinkToken_1779800000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns = [
            new TableColumn({
                name: 'magicLinkToken',
                type: 'varchar',
                isNullable: true,
            }),
            new TableColumn({
                name: 'magicLinkExpires',
                type: 'timestamp',
                isNullable: true,
            }),
        ];

        for (const column of columns) {
            if (!(await queryRunner.hasColumn('users', column.name))) {
                await queryRunner.addColumn('users', column);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const columnName of ['magicLinkExpires', 'magicLinkToken']) {
            if (await queryRunner.hasColumn('users', columnName)) {
                await queryRunner.dropColumn('users', columnName);
            }
        }
    }
}
