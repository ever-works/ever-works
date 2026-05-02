import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddWebsiteTemplateIdToWorks1761912000000 implements MigrationInterface {
    name = 'AddWebsiteTemplateIdToWorks1761912000000';

    async up(queryRunner: QueryRunner): Promise<void> {
        const hasColumn = await queryRunner.hasColumn('works', 'websiteTemplateId');
        if (hasColumn) {
            return;
        }

        await queryRunner.addColumn(
            'works',
            new TableColumn({
                name: 'websiteTemplateId',
                type: 'varchar',
                isNullable: false,
                default: "'classic'",
            }),
        );

        const escapedTable = queryRunner.connection.driver.escape('works');
        const escapedColumn = queryRunner.connection.driver.escape('websiteTemplateId');
        await queryRunner.query(
            `UPDATE ${escapedTable} SET ${escapedColumn} = 'classic' WHERE ${escapedColumn} IS NULL`,
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        const hasColumn = await queryRunner.hasColumn('works', 'websiteTemplateId');
        if (!hasColumn) {
            return;
        }

        await queryRunner.dropColumn('works', 'websiteTemplateId');
    }
}
