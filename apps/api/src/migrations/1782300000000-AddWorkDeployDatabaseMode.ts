import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `works.deployDatabaseMode` — whether a Work's deployed site uses the
 * platform-managed "Ever Works DB" (`'shared'`) or a bring-your-own connection
 * string (`'custom'`).
 *
 * Nullable, no backfill: legacy rows read as `'custom'` when a
 * `deployDatabaseUrlEncrypted` is set, else `'shared'` when the shared-DB
 * feature is enabled (resolved in WorkRuntimeEnvService). Forward-only and
 * idempotent (`hasColumn` guard) — mirrors AddWorkDeployRuntimeEnv.
 */
export class AddWorkDeployDatabaseMode1782300000000 implements MigrationInterface {
    name = 'AddWorkDeployDatabaseMode1782300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'deployDatabaseMode'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({ name: 'deployDatabaseMode', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('works', 'deployDatabaseMode')) {
            await queryRunner.dropColumn('works', 'deployDatabaseMode');
        }
    }
}
