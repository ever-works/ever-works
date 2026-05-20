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
                default:
                    "'Create a Work from this personalized idea. Research relevant items, categories, fields, and metadata based on the proposal details.'",
            }),
        );
        const driverType = queryRunner.connection.options.type;
        if (driverType === 'postgres' || driverType === 'cockroachdb') {
            await queryRunner.query(
                'ALTER TABLE "work_proposals" ALTER COLUMN "generatedPrompt" DROP DEFAULT',
            );
        } else if (driverType === 'mysql' || driverType === 'mariadb') {
            await queryRunner.query(
                'ALTER TABLE `work_proposals` ALTER COLUMN `generatedPrompt` DROP DEFAULT',
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('work_proposals'))) return;
        const table = await queryRunner.getTable('work_proposals');
        if (!table?.findColumnByName('generatedPrompt')) return;
        await queryRunner.dropColumn('work_proposals', 'generatedPrompt');
    }
}
