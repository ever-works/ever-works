import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Domain-model evolution PR-6 (review §23.5, operator ruling "Vision is
 * OK to add now… simplest solution"): the organization's long-term
 * direction as a plain nullable text field + its change timestamp.
 * A field, not an entity (review §8.2) — its one consumer is prompt
 * context for agents. Idempotent adds; down() drops both.
 */
export class AddOrganizationVision1781900000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('organizations', 'vision'))) {
            await queryRunner.addColumn(
                'organizations',
                new TableColumn({ name: 'vision', type: 'text', isNullable: true }),
            );
        }
        if (!(await queryRunner.hasColumn('organizations', 'visionUpdatedAt'))) {
            await queryRunner.addColumn(
                'organizations',
                new TableColumn({ name: 'visionUpdatedAt', type: 'timestamp', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('organizations', 'visionUpdatedAt')) {
            await queryRunner.dropColumn('organizations', 'visionUpdatedAt');
        }
        if (await queryRunner.hasColumn('organizations', 'vision')) {
            await queryRunner.dropColumn('organizations', 'vision');
        }
    }
}
