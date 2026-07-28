import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Org-scoped digest briefings — `organizations.digest_settings`.
 *
 * Nullable `simple-json` payload of shape
 * `{ enabled?, cadence?, narrative?, lastRunAt? }` backing the
 * per-organization opt-in the `digest-dispatcher` cron reads for its
 * ORGANIZATION pass.
 *
 * NULL (every existing row) means the org digest is OFF, so this is
 * additive by construction — no backfill, and the per-USER digest
 * (`users.digestFrequency`) is untouched and keeps working exactly as
 * before.
 *
 * `simple-json` maps to `text` on Postgres (prod) and on the
 * better-sqlite3 test/CLI driver, so a plain nullable `text` column is
 * correct — same shape as `memory_consolidation` next door
 * (`1784300000000-CreateKbRetrievalLogsAndMemoryCadence`).
 *
 * Forward-only and idempotent (`hasColumn` guarded), matching the house
 * migration pattern.
 */
export class AddOrganizationDigestSettings1784710000000 implements MigrationInterface {
    name = 'AddOrganizationDigestSettings1784710000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('organizations', 'digest_settings'))) {
            await queryRunner.addColumn(
                'organizations',
                new TableColumn({
                    name: 'digest_settings',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('organizations', 'digest_settings')) {
            await queryRunner.dropColumn('organizations', 'digest_settings');
        }
    }
}
