import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Scope-aware lookup support for `UserUploadRepository.record` and
 * `findOwnedByUser`. This is deliberately additive: the historical
 * `(userId, sha256)` and `sha256` indexes remain in place and no row is
 * rewritten. The index is non-unique because PostgreSQL/SQLite NULL
 * uniqueness differs; repository-level dedupe implements the explicit
 * legacy-personal compatibility rule.
 */
export class AddUserUploadScopeIndex1786950000000 implements MigrationInterface {
    name = 'AddUserUploadScopeIndex1786950000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('user_uploads');
        if (
            !table ||
            table.indices.some((index) => index.name === 'idx_user_uploads_user_scope_sha')
        ) {
            return;
        }
        await queryRunner.createIndex(
            table,
            new TableIndex({
                name: 'idx_user_uploads_user_scope_sha',
                columnNames: ['userId', 'tenantId', 'organizationId', 'sha256'],
                isUnique: false,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('user_uploads');
        const index = table?.indices.find(
            (candidate) => candidate.name === 'idx_user_uploads_user_scope_sha',
        );
        if (table && index) await queryRunner.dropIndex(table, index);
    }
}
