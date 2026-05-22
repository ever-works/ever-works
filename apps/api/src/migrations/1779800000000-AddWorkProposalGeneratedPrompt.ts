import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddWorkProposalGeneratedPrompt1779800000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('work_proposals'))) return;
        const table = await queryRunner.getTable('work_proposals');
        if (table?.findColumnByName('generatedPrompt')) return;

        await queryRunner.addColumn(
            'work_proposals',
            new TableColumn({
                name: 'generatedPrompt',
                type: 'text',
                isNullable: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('work_proposals'))) return;
        const table = await queryRunner.getTable('work_proposals');
        if (!table?.findColumnByName('generatedPrompt')) return;
        await queryRunner.dropColumn('work_proposals', 'generatedPrompt');
    }
}
