import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Creates the `user_uploads` table — a first-class, ownable record of a file
 * uploaded via `POST /api/uploads/{file,image}`.
 *
 * Plain uploads previously left no DB trace (bytes in a Storage plugin, the
 * sha256 returned as the upload id), so an attachment's `uploadId` could not be
 * validated against a real, caller-owned upload — letting a ghost/foreign id
 * persist a dangling attachment edge (unmapped-500-hunt finding). This row makes
 * the upload owned (`userId`, NULL = anonymous), keyed by `sha256`, and
 * optionally associated with a work / mission / idea / tenant / org scope.
 *
 * Forward-only, idempotent (`ifNotExists`). The file bytes are unchanged; this
 * is the metadata / ownership index only.
 */
export class CreateUserUploads1780600000000 implements MigrationInterface {
    name = 'CreateUserUploads1780600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'user_uploads',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid', isNullable: true },
                    { name: 'sha256', type: 'varchar', length: '64' },
                    { name: 'workId', type: 'uuid', isNullable: true },
                    { name: 'missionId', type: 'uuid', isNullable: true },
                    { name: 'ideaId', type: 'uuid', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'storage_provider', type: 'varchar', length: '64' },
                    { name: 'storage_path', type: 'varchar', length: '1024' },
                    { name: 'original_filename', type: 'varchar', length: '512', isNullable: true },
                    { name: 'mime_type', type: 'varchar', length: '128', isNullable: true },
                    { name: 'file_size', type: 'bigint', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'user_uploads',
            new TableForeignKey({
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createIndex(
            'user_uploads',
            new TableIndex({
                name: 'idx_user_uploads_user_sha',
                columnNames: ['userId', 'sha256'],
            }),
        );

        await queryRunner.createIndex(
            'user_uploads',
            new TableIndex({
                name: 'idx_user_uploads_sha',
                columnNames: ['sha256'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('user_uploads', true);
    }
}
