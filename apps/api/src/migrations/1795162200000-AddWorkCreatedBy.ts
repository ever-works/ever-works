import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * `works.createdByType varchar(16) NULL` + `works.createdById varchar(64) NULL` — who created
 * the Work when it was not the owning user: `integration` + the integration key id for a
 * Project Work created through `POST /api/integrations/v1/works` (EW-P2-4), so the integration
 * DTO's `createdBy` says so (EW-P1-2 attribution), as for tasks, ideas, goals and missions
 * (`1795100000000-AddP2AggregateSyncColumns`). NULL on every existing row, which reads as
 * "the owner created it".
 *
 * Additive and idempotent: each column is guarded, so a partially applied database converges.
 * `down` drops the columns.
 */
export class AddWorkCreatedBy1795162200000 implements MigrationInterface {
    name = 'AddWorkCreatedBy1795162200000';

    static columns(): TableColumn[] {
        return [
            new TableColumn({
                name: 'createdByType',
                type: 'varchar',
                length: '16',
                isNullable: true,
            }),
            new TableColumn({
                name: 'createdById',
                type: 'varchar',
                length: '64',
                isNullable: true,
            }),
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const column of AddWorkCreatedBy1795162200000.columns()) {
            const table = await queryRunner.getTable('works');
            if (table && !table.findColumnByName(column.name)) {
                await queryRunner.addColumn('works', column);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const column of AddWorkCreatedBy1795162200000.columns().reverse()) {
            const table = await queryRunner.getTable('works');
            if (table?.findColumnByName(column.name)) {
                await queryRunner.dropColumn('works', column.name);
            }
        }
    }
}
