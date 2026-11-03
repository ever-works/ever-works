import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Memory Files — link BOTH upload spines to `memory_folders`:
 * `user_uploads.folderId` and `work_knowledge_uploads.folderId`, both
 * nullable uuid (NULL = unfiled ⇒ shown at the Files root).
 *
 * Membership only: no bytes move, no lifecycle changes. The FK (postgres
 * only — better-sqlite3 cannot ALTER in an FK without a table rebuild,
 * and the service layer re-validates folder ownership on every write
 * anyway) is `ON DELETE SET NULL`, so dropping a folder can never drop
 * an upload row.
 *
 * Idempotent + portable per the house pattern (guards on hasColumn, no
 * raw postgres-only DDL outside the driver check).
 */
export class AddMemoryFolderIdToUploads1786830001000 implements MigrationInterface {
    name = 'AddMemoryFolderIdToUploads1786830001000';

    private static readonly TARGETS = ['user_uploads', 'work_knowledge_uploads'] as const;

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of AddMemoryFolderIdToUploads1786830001000.TARGETS) {
            if (!(await queryRunner.hasTable(table))) continue;
            if (await queryRunner.hasColumn(table, 'folderId')) continue;

            await queryRunner.addColumn(
                table,
                new TableColumn({ name: 'folderId', type: 'uuid', isNullable: true }),
            );
            await queryRunner.createIndex(
                table,
                new TableIndex({
                    name: `idx_${table}_folder`,
                    columnNames: ['folderId'],
                }),
            );

            if (
                queryRunner.connection.options.type === 'postgres' &&
                (await queryRunner.hasTable('memory_folders'))
            ) {
                await queryRunner.query(
                    `ALTER TABLE "${table}"
                     ADD CONSTRAINT "fk_${table}_memory_folder"
                     FOREIGN KEY ("folderId") REFERENCES "memory_folders"("id")
                     ON DELETE SET NULL`,
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of AddMemoryFolderIdToUploads1786830001000.TARGETS) {
            if (!(await queryRunner.hasTable(table))) continue;
            if (!(await queryRunner.hasColumn(table, 'folderId'))) continue;

            if (queryRunner.connection.options.type === 'postgres') {
                await queryRunner.query(
                    `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "fk_${table}_memory_folder"`,
                );
            }
            await queryRunner.dropIndex(table, `idx_${table}_folder`);
            await queryRunner.dropColumn(table, 'folderId');
        }
    }
}
