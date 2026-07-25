import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Digest briefings (Wave 7) — per-user cadence preference.
 *
 * `users.digestFrequency`: 'off' (default) | 'daily' | 'weekly'.
 * Default 'off' means every existing row keeps meaning "no digests" —
 * the feature is opt-in per user via PUT /api/auth/profile.
 *
 * Forward-only, idempotent per-step guard (house pattern — mirrors
 * 1782700000000-AddTaskIsolationColumns).
 */
export class AddUserDigestPreference1783300000000 implements MigrationInterface {
    name = 'AddUserDigestPreference1783300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const users = await queryRunner.getTable('users');
        if (users && !users.findColumnByName('digestFrequency')) {
            await queryRunner.query(
                `ALTER TABLE "users" ADD COLUMN "digestFrequency" varchar(8) NOT NULL DEFAULT 'off'`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const users = await queryRunner.getTable('users');
        if (users && users.findColumnByName('digestFrequency')) {
            await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "digestFrequency"`);
        }
    }
}
