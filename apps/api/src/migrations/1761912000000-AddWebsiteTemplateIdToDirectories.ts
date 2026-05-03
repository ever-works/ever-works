import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `websiteTemplateId` to the works table.
 *
 * Original target was the legacy `directories` table. The follow-up
 * migration `RenameDirectoriesToWorks1762200000000` renames that table
 * to `works`. Both code paths are kept here so this migration is safe
 * to run regardless of order: if `directories` still exists (pre-rename
 * prod state) we operate on it; if `works` already exists (post-rename,
 * fresh dev DBs, or environments where this migration was never recorded)
 * we operate on `works`.
 *
 * The class name and `name` field stay anchored to the original
 * `…ToDirectories…` form because TypeORM tracks migrations by `name`,
 * and renaming would make existing prod DBs see this as a new unrun
 * migration.
 */
export class AddWebsiteTemplateIdToDirectories1761912000000 implements MigrationInterface {
    name = 'AddWebsiteTemplateIdToDirectories1761912000000';

    private async resolveTable(queryRunner: QueryRunner): Promise<string | null> {
        if (await queryRunner.hasTable('works')) return 'works';
        if (await queryRunner.hasTable('directories')) return 'directories';
        return null;
    }

    async up(queryRunner: QueryRunner): Promise<void> {
        const table = await this.resolveTable(queryRunner);
        if (!table) {
            // No table at all yet — nothing to do; synchronize/forward
            // migrations will create it with the column already in place.
            return;
        }

        const hasColumn = await queryRunner.hasColumn(table, 'websiteTemplateId');
        if (hasColumn) {
            return;
        }

        await queryRunner.addColumn(
            table,
            new TableColumn({
                name: 'websiteTemplateId',
                type: 'varchar',
                isNullable: false,
                default: "'classic'",
            }),
        );

        const escapedTable = queryRunner.connection.driver.escape(table);
        const escapedColumn = queryRunner.connection.driver.escape('websiteTemplateId');
        await queryRunner.query(
            `UPDATE ${escapedTable} SET ${escapedColumn} = 'classic' WHERE ${escapedColumn} IS NULL`,
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        const table = await this.resolveTable(queryRunner);
        if (!table) return;

        const hasColumn = await queryRunner.hasColumn(table, 'websiteTemplateId');
        if (!hasColumn) {
            return;
        }

        await queryRunner.dropColumn(table, 'websiteTemplateId');
    }
}
