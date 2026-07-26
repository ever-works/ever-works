import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kanban run cockpit (plan 04 M5) — PR status + CI cache on `tasks`.
 *
 * `prState`   — `open | draft | closed | merged` as last observed.
 * `ciState`   — rolled-up CI verdict for the PR head
 *               (`passing | failing | pending | unknown`).
 * `ciCheckedAt` — refresh timestamp; the `task-pr-status-sync` cron and
 *               the on-demand endpoint both throttle off this column.
 * `prChecks`  — bounded check summary rendered in the pill tooltip.
 *
 * They sit beside the existing `prNumber` / `prUrl` on `tasks` (added by
 * `AddTaskIsolationColumns`) rather than on `agent_runs`: the pull
 * request belongs to the Task's branch, which outlives any single run.
 *
 * Partial index on the sync predicate so the cron's "PRs still open,
 * stalest first" scan never table-scans `tasks`.
 *
 * Forward-only, idempotent per-step guards (house pattern). Every column
 * is nullable — existing rows simply carry no PR status.
 */
export class AddTaskPrStatusColumns1784300000000 implements MigrationInterface {
    name = 'AddTaskPrStatusColumns1784300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (!tasks) return;

        const add = async (name: string, ddl: string) => {
            if (!tasks.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "tasks" ADD COLUMN ${ddl}`);
            }
        };
        await add('prState', `"prState" varchar(16)`);
        await add('ciState', `"ciState" varchar(16)`);
        await add('ciCheckedAt', `"ciCheckedAt" TIMESTAMP`);
        await add('prChecks', `"prChecks" text`);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_tasks_pr_status_sync" ` +
                `ON "tasks" ("ciCheckedAt") WHERE "prNumber" IS NOT NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_tasks_pr_status_sync"`);
        const tasks = await queryRunner.getTable('tasks');
        if (!tasks) return;
        for (const col of ['prChecks', 'ciCheckedAt', 'ciState', 'prState']) {
            if (tasks.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "${col}"`);
            }
        }
    }
}
