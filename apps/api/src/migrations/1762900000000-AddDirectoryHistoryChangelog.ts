import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddDirectoryHistoryChangelog1762900000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumns('directory_generation_history', [
            new TableColumn({
                name: 'activityType',
                type: 'varchar',
                isNullable: false,
                default: "'generation'",
            }),
            new TableColumn({
                name: 'changelog',
                type: queryRunner.connection.options.type === 'postgres' ? 'jsonb' : 'json',
                isNullable: true,
            }),
        ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('directory_generation_history', 'changelog');
        await queryRunner.dropColumn('directory_generation_history', 'activityType');
    }
}
