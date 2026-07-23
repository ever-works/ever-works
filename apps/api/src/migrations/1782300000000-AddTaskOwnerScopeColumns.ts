import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Tasks — additional optional owners: Team, Agent, Goal.
 *
 * `tasks` already carried nullable `missionId` / `ideaId` / `workId`.
 * This adds the remaining three owners so a Task can be filed against any
 * combination of Work / Team / Agent / Idea / Goal / Mission.
 *
 * Entity: `packages/agent/src/entities/task.entity.ts`
 *
 * **Schema notes:**
 *   - All three are nullable — ownership is optional and non-exclusive. A
 *     Task may belong to a Work AND a Team AND have been raised by a
 *     Mission simultaneously, which is why these are independent columns
 *     rather than one polymorphic `(subjectType, subjectId)` pair: every
 *     owner needs to be independently filterable.
 *   - `(ownerId, status)` composite indexes mirror the existing
 *     `idx_tasks_work` / `idx_tasks_mission` / `idx_tasks_idea` shape —
 *     each owner surface lists that owner's tasks filtered by status.
 *   - Raw uuid reference columns with NO entity-level `@ManyToOne` (cycle
 *     avoidance per EW-654, same as the existing scope columns); the FKs
 *     live here instead.
 *   - All three FKs are `ON DELETE SET NULL`, not CASCADE: deleting a Team,
 *     Agent or Goal must never destroy the Tasks filed against it. The
 *     Task survives and simply loses that association — the opposite
 *     choice would silently delete a user's work.
 *
 * Forward-only and idempotent (`hasColumn` guards) so a partially-applied
 * run is safe to repeat.
 */
export class AddTaskOwnerScopeColumns1782300000000 implements MigrationInterface {
    name = 'AddTaskOwnerScopeColumns1782300000000';

    private static readonly COLUMNS: ReadonlyArray<{
        column: string;
        index: string;
        fk: string | null;
        referencedTable: string;
    }> = [
        {
            column: 'teamId',
            index: 'idx_tasks_team',
            fk: 'fk_tasks_team',
            referencedTable: 'teams',
        },
        {
            column: 'agentId',
            index: 'idx_tasks_agent',
            fk: 'fk_tasks_agent',
            referencedTable: 'agents',
        },
        {
            column: 'goalId',
            index: 'idx_tasks_goal',
            fk: 'fk_tasks_goal',
            referencedTable: 'goals',
        },
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tasks'))) {
            return;
        }

        for (const {
            column,
            index,
            fk,
            referencedTable,
        } of AddTaskOwnerScopeColumns1782300000000.COLUMNS) {
            if (await queryRunner.hasColumn('tasks', column)) {
                continue;
            }

            await queryRunner.addColumn(
                'tasks',
                new TableColumn({ name: column, type: 'uuid', isNullable: true }),
            );

            await queryRunner.createIndex(
                'tasks',
                new TableIndex({ name: index, columnNames: [column, 'status'] }),
            );

            // The referenced table may legitimately not exist yet in a
            // partially-migrated environment; skip the FK rather than fail
            // the whole migration, the column and index still land.
            if (fk && (await queryRunner.hasTable(referencedTable))) {
                await queryRunner.createForeignKey(
                    'tasks',
                    new TableForeignKey({
                        name: fk,
                        columnNames: [column],
                        referencedTableName: referencedTable,
                        referencedColumnNames: ['id'],
                        onDelete: 'SET NULL',
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tasks'))) {
            return;
        }

        for (const { column, index, fk } of AddTaskOwnerScopeColumns1782300000000.COLUMNS) {
            if (!(await queryRunner.hasColumn('tasks', column))) {
                continue;
            }

            const table = await queryRunner.getTable('tasks');
            const existingFk = table?.foreignKeys.find((candidate) => candidate.name === fk);
            if (existingFk) {
                await queryRunner.dropForeignKey('tasks', existingFk);
            }

            const existingIndex = table?.indices.find((candidate) => candidate.name === index);
            if (existingIndex) {
                await queryRunner.dropIndex('tasks', existingIndex);
            }

            await queryRunner.dropColumn('tasks', column);
        }
    }
}
