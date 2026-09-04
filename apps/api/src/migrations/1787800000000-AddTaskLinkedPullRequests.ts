import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Multi-repo Task workspaces (self-build slice C) — `tasks.linkedPullRequests`.
 *
 * A Task keeps ONE primary branch and pull request (`branchRef`,
 * `prNumber`, `prUrl`). When a fleet run also changes repositories mounted
 * next to the primary worktree, each of those gets its own branch and pull
 * request in ITS repository; this column records them
 * (`{ repositoryId, branch, baseRef, headSha, prNumber, prUrl, state, error }`
 * per repository) so the Task page can list them and the reconciler can
 * update rather than duplicate them on a re-run.
 *
 * Additive, nullable JSON, no index: read by Task primary key only. Every
 * existing row reads NULL ("no linked pull requests"), which is the correct
 * history. Forward-only with a guard so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddTaskLinkedPullRequests1787800000000 implements MigrationInterface {
    name = 'AddTaskLinkedPullRequests1787800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks && !tasks.findColumnByName('linkedPullRequests')) {
            await queryRunner.addColumn(
                'tasks',
                new TableColumn({ name: 'linkedPullRequests', type: 'text', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks?.findColumnByName('linkedPullRequests')) {
            await queryRunner.dropColumn('tasks', 'linkedPullRequests');
        }
    }
}
