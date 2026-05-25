import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.7.
 *
 * Adds `ideaId` back-link from `work_agent_goals` to
 * `work_proposals` (Decision A3 / PLAN §10.6).
 *
 * The build-from-Idea pipeline (Phase 1 PR B) creates a Goal with
 * `maxWorksPerRun=1` and `ideaId=<this>`. On Goal completion the
 * shared `acceptInternal(ideaId, workId)` helper transitions the
 * Idea to ACCEPTED via this back-link. On Goal failure the
 * Goal-completion handler (Phase 1 PR FF) joins through `ideaId`
 * to persist `failure_message` + `failure_kind` on the Idea.
 *
 * Existing `POST /me/work-agent/goals` direct-queue path keeps
 * working unchanged — Goals it creates have `ideaId = NULL`.
 *
 * FK on delete: SET NULL. Deleting an Idea (rare; Ideas are soft-
 * hidden on Done rather than deleted) does NOT cascade-delete its
 * historical Goals — those are still useful for auditing what was
 * tried.
 *
 * Single-column index on `ideaId` supports the Goal-completion
 * handler's "for this Idea, find its in-flight Goal" lookup.
 *
 * Idempotent and reversible.
 */
export class AddIdeaIdToWorkAgentGoal1779978006000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('work_agent_goals', 'ideaId'))) {
            await queryRunner.addColumn(
                'work_agent_goals',
                new TableColumn({
                    name: 'ideaId',
                    type: 'uuid',
                    isNullable: true,
                }),
            );
        }

        const table = await queryRunner.getTable('work_agent_goals');

        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_work_agent_goals_idea');
        if (!hasIndex) {
            await queryRunner.createIndex(
                'work_agent_goals',
                new TableIndex({
                    name: 'idx_work_agent_goals_idea',
                    columnNames: ['ideaId'],
                }),
            );
        }

        const refreshed = await queryRunner.getTable('work_agent_goals');
        const hasFk = refreshed?.foreignKeys.some((fk) => fk.name === 'fk_work_agent_goals_idea');
        if (!hasFk) {
            await queryRunner.createForeignKey(
                'work_agent_goals',
                new TableForeignKey({
                    name: 'fk_work_agent_goals_idea',
                    columnNames: ['ideaId'],
                    referencedTableName: 'work_proposals',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('work_agent_goals');
        const fk = table?.foreignKeys.find((f) => f.name === 'fk_work_agent_goals_idea');
        if (fk) {
            await queryRunner.dropForeignKey('work_agent_goals', fk);
        }
        const hasIndex = table?.indices.some((idx) => idx.name === 'idx_work_agent_goals_idea');
        if (hasIndex) {
            await queryRunner.dropIndex('work_agent_goals', 'idx_work_agent_goals_idea');
        }
        if (await queryRunner.hasColumn('work_agent_goals', 'ideaId')) {
            await queryRunner.dropColumn('work_agent_goals', 'ideaId');
        }
    }
}
