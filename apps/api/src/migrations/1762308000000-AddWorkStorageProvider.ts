import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Adds the `storageProvider` column to `works` so the onboarding wizard
 * can record which storage backend a Work uses (Ever Works Git, the
 * user's GitHub account, GitLab, or a generic Git host).
 *
 * Also adds a partial index over `(userId, deployProvider)` filtered to
 * active Works so the Ever Works Deploy quota check (max N active Works
 * per user) is a single fast COUNT.
 *
 * `deployProvider` already exists on the works table (default `'vercel'`);
 * we widen its accepted value space to include `'ever-works'` and `'k8s'`
 * at the application layer (TypeORM column type stays `varchar`).
 */
export class AddWorkStorageProvider1762308000000 implements MigrationInterface {
    name = 'AddWorkStorageProvider1762308000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        if (!table) {
            return;
        }

        if (!table.findColumnByName('storageProvider')) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'storageProvider',
                    type: 'varchar',
                    length: '32',
                    isNullable: false,
                    default: "'user-github'",
                }),
            );
        }

        // Partial index for Ever Works Deploy quota check.
        // Only Postgres supports partial indices via `where`; on SQLite this is a
        // plain composite index which is still effective for the quota query.
        const indexName = 'idx_works_user_deploy_active';
        const alreadyIndexed = table.indices.some((idx) => idx.name === indexName);
        if (!alreadyIndexed) {
            await queryRunner.createIndex(
                'works',
                new TableIndex({
                    name: indexName,
                    columnNames: ['userId', 'deployProvider'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        if (!table) {
            return;
        }

        const indexName = 'idx_works_user_deploy_active';
        if (table.indices.some((idx) => idx.name === indexName)) {
            await queryRunner.dropIndex('works', indexName);
        }

        if (table.findColumnByName('storageProvider')) {
            await queryRunner.dropColumn('works', 'storageProvider');
        }
    }
}
