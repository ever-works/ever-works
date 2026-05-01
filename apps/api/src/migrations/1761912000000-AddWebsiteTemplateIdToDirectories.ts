import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

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
