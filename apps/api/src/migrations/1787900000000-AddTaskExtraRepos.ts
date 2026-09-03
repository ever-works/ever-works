import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Multi-repo Task workspaces (self-build slice C, PR C2) — `tasks.extraRepos`.
 *
 * The repositories a Task spans in addition to its primary Work repository
 * and the run agent's attachments: `{ repoConnectionId, mountDir?, writable? }`
 * per entry, each naming a connection in the owner's repository registry.
 * On a fleet run they become workspace mounts next to the primary worktree.
 *
 * Additive, nullable JSON, no index: read by Task primary key only. Every
 * existing row reads NULL ("no extra repositories"), which is the correct
 * history. Forward-only with a guard so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddTaskExtraRepos1787900000000 implements MigrationInterface {
    name = 'AddTaskExtraRepos1787900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks && !tasks.findColumnByName('extraRepos')) {
            await queryRunner.addColumn(
                'tasks',
                new TableColumn({ name: 'extraRepos', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks?.findColumnByName('extraRepos')) {
            await queryRunner.dropColumn('tasks', 'extraRepos');
        }
    }
}
