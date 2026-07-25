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
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            for (const col of ['branchState', 'branchRef', 'isolationMode']) {
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
