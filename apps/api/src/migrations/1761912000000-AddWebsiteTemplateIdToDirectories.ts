import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * NOTE: this migration is intentionally named after the legacy DB table
 * (`directories`). TypeORM tracks migrations by class/`name` field; renaming
 * either causes existing prod databases to think this is a fresh, unrun
 * migration on next deploy, which then targets a `works` table that does
 * NOT exist (the entity is still `@Entity({ name: 'directories' })`).
 *
 * The bulk Directory→Work rename mistakenly renamed this file/class/table
 * — we keep the file name, class name, `name` property, and table name in
 * the SQL all aligned with the real DB table `directories`.
 *
 * (See: incident — empty Works list in production after the rename PRs.)
 */
export class AddWebsiteTemplateIdToDirectories1761912000000 implements MigrationInterface {
    name = 'AddWebsiteTemplateIdToDirectories1761912000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        const hasColumn = await queryRunner.hasColumn('directories', 'websiteTemplateId');
        if (hasColumn) {
            return;
        }

        await queryRunner.addColumn(
            'directories',
            new TableColumn({
                name: 'websiteTemplateId',
                type: 'varchar',
                isNullable: false,
                default: "'classic'",
            }),
        );

        const escapedTable = queryRunner.connection.driver.escape('directories');
        const escapedColumn = queryRunner.connection.driver.escape('websiteTemplateId');
        await queryRunner.query(
            `UPDATE ${escapedTable} SET ${escapedColumn} = 'classic' WHERE ${escapedColumn} IS NULL`,
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        const hasColumn = await queryRunner.hasColumn('directories', 'websiteTemplateId');
        if (!hasColumn) {
            return;
        }

        await queryRunner.dropColumn('directories', 'websiteTemplateId');
    }
}
