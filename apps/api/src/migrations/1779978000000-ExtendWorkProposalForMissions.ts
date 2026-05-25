import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.1.
 *
 * Extends `work_proposals` so it can carry the new Idea statuses
 * (`QUEUED` / `BUILDING` / `FAILED`) and sources (`USER_MANUAL` /
 * `MISSION`) introduced by the Missions/Ideas/Works feature, and
 * adds the `missionId` back-pointer that links an Idea to the
 * Mission that spawned it.
 *
 * Status + Source are stored as plain `varchar` (see
 * `WorkProposal.@Column({ type: 'varchar', ... })`), so extending the
 * enums is a pure code change in the entity — no DB-level enum
 * alteration is needed here. This migration handles only the new
 * column + the replacement index.
 *
 * **FK on `missionId` is intentionally NOT added here.** The
 * `missions` table lands in the very next migration
 * (`CreateMissionsTable`). That follow-up migration adds the
 * `REFERENCES missions(id) ON DELETE SET NULL` constraint once the
 * referenced table exists. Until then the column accepts any uuid;
 * the only writer of non-NULL values is the Mission tick worker
 * (Phase 3), which can't run before the Mission entity is wired in.
 *
 * Index swap: drops the v0 index
 * `idx_work_proposals_user_status_generated (userId, status,
 * generatedAt)` and replaces it with
 * `idx_work_proposals_user_status_mission_generated (userId, status,
 * missionId, generatedAt)`. This supports the dashboard query "give
 * me my open Ideas, optionally scoped to a Mission" without a full
 * scan. Per-Mission scoped queries (`WHERE userId = ? AND missionId
 * = ?`) benefit from the same composite leftmost-prefix.
 *
 * Forward-only on the column; idempotent (`hasColumn` / index-name
 * check) so the migration is safe to re-run during dev resets.
 * `down()` restores the original index and drops the column.
 */
export class ExtendWorkProposalForMissions1779978000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('work_proposals', 'missionId'))) {
            await queryRunner.addColumn(
                'work_proposals',
                new TableColumn({
                    name: 'missionId',
                    type: 'uuid',
                    isNullable: true,
                }),
            );
        }

        const table = await queryRunner.getTable('work_proposals');
        const hasOldIndex = table?.indices.some(
            (idx) => idx.name === 'idx_work_proposals_user_status_generated',
        );
        if (hasOldIndex) {
            await queryRunner.dropIndex(
                'work_proposals',
                'idx_work_proposals_user_status_generated',
            );
        }

        const refreshed = await queryRunner.getTable('work_proposals');
        const hasNewIndex = refreshed?.indices.some(
            (idx) => idx.name === 'idx_work_proposals_user_status_mission_generated',
        );
        if (!hasNewIndex) {
            await queryRunner.createIndex(
                'work_proposals',
                new TableIndex({
                    name: 'idx_work_proposals_user_status_mission_generated',
                    columnNames: ['userId', 'status', 'missionId', 'generatedAt'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('work_proposals');
        const hasNewIndex = table?.indices.some(
            (idx) => idx.name === 'idx_work_proposals_user_status_mission_generated',
        );
        if (hasNewIndex) {
            await queryRunner.dropIndex(
                'work_proposals',
                'idx_work_proposals_user_status_mission_generated',
            );
        }

        const refreshed = await queryRunner.getTable('work_proposals');
        const hadOld = refreshed?.indices.some(
            (idx) => idx.name === 'idx_work_proposals_user_status_generated',
        );
        if (!hadOld) {
            await queryRunner.createIndex(
                'work_proposals',
                new TableIndex({
                    name: 'idx_work_proposals_user_status_generated',
                    columnNames: ['userId', 'status', 'generatedAt'],
                }),
            );
        }

        if (await queryRunner.hasColumn('work_proposals', 'missionId')) {
            await queryRunner.dropColumn('work_proposals', 'missionId');
        }
    }
}
