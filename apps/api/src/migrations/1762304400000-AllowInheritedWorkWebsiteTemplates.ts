import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AllowInheritedWorkWebsiteTemplates1762304400000 implements MigrationInterface {
    name = 'AllowInheritedWorkWebsiteTemplates1762304400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        const column = table?.findColumnByName('websiteTemplateId');

        if (!column) {
            return;
        }

        await queryRunner.changeColumn(
            'works',
            column,
            new TableColumn({
                ...column,
                isNullable: true,
                default: null,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `UPDATE works SET "websiteTemplateId" = 'classic' WHERE "websiteTemplateId" IS NULL`,
        );

        const table = await queryRunner.getTable('works');
        const column = table?.findColumnByName('websiteTemplateId');

        if (!column) {
            return;
        }

        await queryRunner.changeColumn(
            'works',
            column,
            new TableColumn({
                ...column,
                isNullable: false,
                default: "'classic'",
            }),
        );
    }
}
