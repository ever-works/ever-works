import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Worktree-per-Task isolation (Wave 2 M1) — settings + identity columns.
 *
 * `works`: taskIsolation ('off' default — opt-in per the founder),
 * taskIsolationBaseBranch (NULL = repo default branch),
 * taskIsolationTargetRepo ('work-output' default), taskBranchCleanup
 * ('on-merge' default).
 *
 * `tasks`: isolationMode (NULL = inherit Work), branchRef
 * (authoritative once written), branchState (lifecycle; NULL = never
 * engaged).
 *
 * Forward-only, idempotent per-step guards (house pattern). Defaults
 * make every existing row mean "isolation off, nothing changes".
 */
export class AddTaskIsolationColumns1782700000000 implements MigrationInterface {
    name = 'AddTaskIsolationColumns1782700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const works = await queryRunner.getTable('works');
        if (works) {
            const add = async (name: string, ddl: string) => {
                if (!works.findColumnByName(name)) {
                    await queryRunner.query(`ALTER TABLE "works" ADD COLUMN ${ddl}`);
                }
            };
            await add('taskIsolation', `"taskIsolation" varchar(16) NOT NULL DEFAULT 'off'`);
            await add('taskIsolationBaseBranch', `"taskIsolationBaseBranch" varchar(128)`);
            await add(
                'taskIsolationTargetRepo',
                `"taskIsolationTargetRepo" varchar(16) NOT NULL DEFAULT 'work-output'`,
            );
            await add(
                'taskBranchCleanup',
                `"taskBranchCleanup" varchar(16) NOT NULL DEFAULT 'on-merge'`,
            );
        }

        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            const add = async (name: string, ddl: string) => {
                if (!tasks.findColumnByName(name)) {
                    await queryRunner.query(`ALTER TABLE "tasks" ADD COLUMN ${ddl}`);
                }
            };
            await add('isolationMode', `"isolationMode" varchar(8)`);
            await add('branchRef', `"branchRef" varchar(200)`);
            await add('branchState', `"branchState" varchar(16)`);
            await add('baseSha', `"baseSha" varchar(40)`);
            await add('prNumber', `"prNumber" int`);
            await add('prUrl', `"prUrl" varchar(512)`);
            await add('conflictPaths', `"conflictPaths" text`);
            // GC sweeper + Tasks-tab filter both scan (workId, branchState).
            await queryRunner.query(
                `CREATE INDEX IF NOT EXISTS "idx_tasks_branch_state" ON "tasks" ("workId", "branchState")`,
            );
        }

        const agentRuns = await queryRunner.getTable('agent_runs');
        if (agentRuns && !agentRuns.findColumnByName('workspaceMeta')) {
            await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN "workspaceMeta" text`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const agentRuns = await queryRunner.getTable('agent_runs');
        if (agentRuns && agentRuns.findColumnByName('workspaceMeta')) {
            await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "workspaceMeta"`);
        }
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_tasks_branch_state"`);
        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            for (const col of [
                'conflictPaths',
                'prUrl',
                'prNumber',
                'baseSha',
                'branchState',
                'branchRef',
                'isolationMode',
            ]) {
                if (tasks.findColumnByName(col)) {
                    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "${col}"`);
                }
            }
        }
        const works = await queryRunner.getTable('works');
        if (works) {
            for (const col of [
                'taskBranchCleanup',
                'taskIsolationTargetRepo',
                'taskIsolationBaseBranch',
                'taskIsolation',
            ]) {
                if (works.findColumnByName(col)) {
                    await queryRunner.query(`ALTER TABLE "works" DROP COLUMN "${col}"`);
                }
            }
        }
    }
}
