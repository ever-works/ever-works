import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Missions/Ideas/Works — Phase 0 PR 0.2.
 *
 * Creates the `missions` table behind the new `Mission` entity
 * (spec §1.3) and attaches the FK constraint on
 * `work_proposals.missionId → missions.id` that PR 0.1
 * intentionally deferred to this migration.
 *
 * Columns mirror `Mission` entity 1:1:
 *   - id, userId (FK→users with ON DELETE CASCADE),
 *   - title (varchar 200), description (text),
 *   - type (varchar 16), status (varchar 16, default 'active'),
 *   - schedule (varchar 64, nullable),
 *   - autoBuildWorks (boolean, default false),
 *   - outstandingIdeasCap (int, nullable),
 *   - guardrailsOverride (simple-json / text on portable dialects),
 *   - missionTemplateRepo, missionRepo (varchar 200, nullable),
 *   - createdAt, updatedAt (timestamps).
 *
 * Index `idx_missions_user_status` on (userId, status) matches the
 * entity decorator; used for the "list my missions" dashboard query.
 *
 * FK on `work_proposals.missionId`: ON DELETE SET NULL. Deleting a
 * Mission must NOT cascade-delete its child Ideas — they stay in the
 * user's account and lose the back-link. This preserves their build
 * history + Done-state retention (spec §3.7).
 *
 * Idempotent: all checks gate on `hasTable` / `hasColumn` /
 * `hasIndex` so the migration can be re-run safely during dev resets
 * and CI.
 */
export class CreateMissionsTable1779978001000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('missions'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'missions',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid', isNullable: false },
                        { name: 'title', type: 'varchar', length: '200', isNullable: false },
                        { name: 'description', type: 'text', isNullable: false },
                        { name: 'type', type: 'varchar', length: '16', isNullable: false },
                        {
                            name: 'status',
                            type: 'varchar',
                            length: '16',
                            isNullable: false,
                            default: "'active'",
                        },
                        {
                            name: 'schedule',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        {
                            name: 'autoBuildWorks',
                            type: 'boolean',
                            isNullable: false,
                            default: false,
                        },
                        {
                            name: 'outstandingIdeasCap',
                            type: 'int',
                            isNullable: true,
                        },
                        {
                            // `simple-json` stores as text on SQLite and as
                            // jsonb / text on Postgres depending on driver
                            // defaults. Use `text` here so the migration is
                            // dialect-portable (the test driver is sqlite).
                            name: 'guardrailsOverride',
                            type: 'text',
                            isNullable: true,
                        },
                        {
                            name: 'missionTemplateRepo',
                            type: 'varchar',
                            length: '200',
                            isNullable: true,
                        },
                        {
                            name: 'missionRepo',
                            type: 'varchar',
                            length: '200',
                            isNullable: true,
                        },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                        {
                            name: 'updatedAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                    foreignKeys: [
                        {
                            name: 'fk_missions_user',
                            columnNames: ['userId'],
                            referencedTableName: 'users',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                    ],
                }),
                true,
            );
        }

        const missions = await queryRunner.getTable('missions');
        const hasIndex = missions?.indices.some((idx) => idx.name === 'idx_missions_user_status');
        if (!hasIndex) {
            await queryRunner.createIndex(
                'missions',
                new TableIndex({
                    name: 'idx_missions_user_status',
                    columnNames: ['userId', 'status'],
                }),
            );
        }

        // Attach FK on work_proposals.missionId now that `missions` exists.
        const wp = await queryRunner.getTable('work_proposals');
        const alreadyHasFk = wp?.foreignKeys.some((fk) => fk.name === 'fk_work_proposals_mission');
        if (!alreadyHasFk) {
            await queryRunner.createForeignKey(
                'work_proposals',
                new TableForeignKey({
                    name: 'fk_work_proposals_mission',
                    columnNames: ['missionId'],
                    referencedTableName: 'missions',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const wp = await queryRunner.getTable('work_proposals');
        const fk = wp?.foreignKeys.find((f) => f.name === 'fk_work_proposals_mission');
        if (fk) {
            await queryRunner.dropForeignKey('work_proposals', fk);
        }

        if (await queryRunner.hasTable('missions')) {
            await queryRunner.dropTable('missions');
        }
    }
}
