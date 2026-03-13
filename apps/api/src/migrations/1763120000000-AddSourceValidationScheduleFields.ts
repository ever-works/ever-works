import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSourceValidationScheduleFields1763120000000 implements MigrationInterface {
    name = 'AddSourceValidationScheduleFields1763120000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "directory_schedules" ADD "sourceValidationCadence" character varying`,
        );
        await queryRunner.query(
            `ALTER TABLE "directory_schedules" ADD "sourceValidationNextRunAt" TIMESTAMP`,
        );
        await queryRunner.query(
            `ALTER TABLE "directory_schedules" ADD "sourceValidationLastRunAt" TIMESTAMP`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "directory_schedules" DROP COLUMN "sourceValidationLastRunAt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "directory_schedules" DROP COLUMN "sourceValidationNextRunAt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "directory_schedules" DROP COLUMN "sourceValidationCadence"`,
        );
    }
}
