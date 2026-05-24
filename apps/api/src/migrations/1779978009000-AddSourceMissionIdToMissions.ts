import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.10.
 *
 * Adds the `sourceMissionId` self-FK on `missions` for Mission
 * Clone traceability (spec §4.4a + Decision A25).
 *
 * Cloned Missions get this set to the source Mission's id at
 * clone time by the Phase 3 PR HH `MissionCloneService`. The
 * Mission detail page renders:
 *   - "Cloned from: <source title>" backlink on the clone (this FK).
 *   - "Cloned as: N other Mission(s)" on the source (reverse query).
 *   - "Related Works (inherited from source Mission)" panel on the
 *     clone — Phase 6 PR GG joins through this FK to surface the
 *     source's Works read-only (Clone Full Fork does NOT duplicate
 *     Works per Decision A25).
 *
 * FK on delete: SET NULL. Deleting the source Mission (rare;
 * normally Missions get Marked Completed, not deleted) breaks the
 * back-link but leaves the clone intact — the clone has its own
 * independent repo + Ideas + Works.
 *
 * Single-column index supports the "find all clones of this
 * source Mission" reverse lookup powering the "Cloned as: N"
 * affordance on the source's detail page.
 *
 * Idempotent and reversible.
 */
export class AddSourceMissionIdToMissions1779978009000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('missions', 'sourceMissionId'))) {
            await queryRunner.addColumn(
                'missions',
                new TableColumn({
                    name: 'sourceMissionId',
                    type: 'uuid',
                    isNullable: true,
                }),
            );
        }

        const table = await queryRunner.getTable('missions');

        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_missions_source');
        if (!hasIndex) {
            await queryRunner.createIndex(
                'missions',
                new TableIndex({
                    name: 'idx_missions_source',
                    columnNames: ['sourceMissionId'],
                }),
            );
        }

        const refreshed = await queryRunner.getTable('missions');
        const hasFk = refreshed?.foreignKeys.some((fk) => fk.name === 'fk_missions_source');
        if (!hasFk) {
            await queryRunner.createForeignKey(
                'missions',
                new TableForeignKey({
                    name: 'fk_missions_source',
                    columnNames: ['sourceMissionId'],
                    referencedTableName: 'missions',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('missions');
        const fk = table?.foreignKeys.find((f) => f.name === 'fk_missions_source');
        if (fk) {
            await queryRunner.dropForeignKey('missions', fk);
        }
        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_missions_source');
        if (hasIndex) {
            await queryRunner.dropIndex('missions', 'idx_missions_source');
        }
        if (await queryRunner.hasColumn('missions', 'sourceMissionId')) {
            await queryRunner.dropColumn('missions', 'sourceMissionId');
        }
    }
}
