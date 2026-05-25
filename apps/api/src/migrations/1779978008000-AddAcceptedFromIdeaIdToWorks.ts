import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.9.
 *
 * Adds the `acceptedFromIdeaId` back-pointer from `works` to
 * `work_proposals` so the Mission detail page (Phase 6 PR R) can
 * roll up "Works built from Ideas this Mission spawned" via a
 * single join — `Mission -> WorkProposal (by missionId) -> Work
 * (by acceptedFromIdeaId)` — without a heavy multi-hop query
 * (spec §3.7 + PLAN §10.6).
 *
 * Set by `acceptInternal(ideaId, workId)` (Phase 1 PR B) when a
 * build-from-Idea Goal completes. NULL for every existing Work
 * (none came from an Idea pre-feature) and for any Work created
 * via the pre-Missions paths going forward (manual create, wizard,
 * import) — those keep working unchanged.
 *
 * FK on delete: SET NULL. Deleting an Idea (rare; Ideas are soft-
 * hidden when Done, not deleted) does NOT delete the Work it
 * produced. The Work survives as a standalone entity; the
 * Mission detail page just doesn't roll it up via this back-link
 * anymore.
 *
 * Single-column index on `acceptedFromIdeaId` supports the
 * Mission detail page query "give me every Work built from these
 * N Ideas".
 *
 * Idempotent and reversible.
 */
export class AddAcceptedFromIdeaIdToWorks1779978008000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('works', 'acceptedFromIdeaId'))) {
            await queryRunner.addColumn(
                'works',
                new TableColumn({
                    name: 'acceptedFromIdeaId',
                    type: 'uuid',
                    isNullable: true,
                }),
            );
        }

        const table = await queryRunner.getTable('works');

        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_works_accepted_from_idea');
        if (!hasIndex) {
            await queryRunner.createIndex(
                'works',
                new TableIndex({
                    name: 'idx_works_accepted_from_idea',
                    columnNames: ['acceptedFromIdeaId'],
                }),
            );
        }

        const refreshed = await queryRunner.getTable('works');
        const hasFk = refreshed?.foreignKeys.some(
            (fk) => fk.name === 'fk_works_accepted_from_idea',
        );
        if (!hasFk) {
            await queryRunner.createForeignKey(
                'works',
                new TableForeignKey({
                    name: 'fk_works_accepted_from_idea',
                    columnNames: ['acceptedFromIdeaId'],
                    referencedTableName: 'work_proposals',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('works');
        const fk = table?.foreignKeys.find((f) => f.name === 'fk_works_accepted_from_idea');
        if (fk) {
            await queryRunner.dropForeignKey('works', fk);
        }
        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_works_accepted_from_idea');
        if (hasIndex) {
            await queryRunner.dropIndex('works', 'idx_works_accepted_from_idea');
        }
        if (await queryRunner.hasColumn('works', 'acceptedFromIdeaId')) {
            await queryRunner.dropColumn('works', 'acceptedFromIdeaId');
        }
    }
}
