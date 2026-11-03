import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tasks upgrades — schedule modes + attachment roles.
 *
 * `tasks.scheduledAt`       — schedule mode "Scheduled": run once at
 *                             this instant. NULL = Run Once / Recurring.
 * `tasks.scheduleClaimedAt` — CAS guard stamped by the dispatcher worker
 *                             that wins the claim; re-scheduling clears
 *                             it. Two concurrent ticks can never
 *                             double-dispatch the same one-shot.
 * `tasks.recurrenceCron`    — alternative recurring cadence as a 5-field
 *                             cron expression (XOR with `recurrenceRule`,
 *                             enforced by TasksService.setRecurring).
 * `task_attachments.role`   — `initial` (input material) | `result`
 *                             (agent/human output). Default keeps every
 *                             existing row on the input side.
 *
 * Composite index on (scheduledAt, scheduleClaimedAt) so the one-shot
 * due-scan (`scheduledAt <= now AND scheduleClaimedAt IS NULL`) never
 * table-scans; a partial index would be Postgres-only and CI runs
 * better-sqlite3.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1784300000000-AddTaskPrStatusColumns).
 */
export class AddTaskScheduleColumns1786860000000 implements MigrationInterface {
    name = 'AddTaskScheduleColumns1786860000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            const add = async (name: string, ddl: string) => {
                if (!tasks.findColumnByName(name)) {
                    await queryRunner.query(`ALTER TABLE "tasks" ADD COLUMN ${ddl}`);
                }
            };
            await add('scheduledAt', `"scheduledAt" TIMESTAMP`);
            await add('scheduleClaimedAt', `"scheduleClaimedAt" TIMESTAMP`);
            await add('recurrenceCron', `"recurrenceCron" varchar(120)`);

            await queryRunner.query(
                `CREATE INDEX IF NOT EXISTS "idx_tasks_scheduled_due" ` +
                    `ON "tasks" ("scheduledAt", "scheduleClaimedAt")`,
            );
        }

        const attachments = await queryRunner.getTable('task_attachments');
        if (attachments && !attachments.findColumnByName('role')) {
            await queryRunner.query(
                `ALTER TABLE "task_attachments" ADD COLUMN "role" varchar(16) NOT NULL DEFAULT 'initial'`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_tasks_scheduled_due"`);
        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            for (const col of ['recurrenceCron', 'scheduleClaimedAt', 'scheduledAt']) {
                if (tasks.findColumnByName(col)) {
                    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "${col}"`);
                }
            }
        }
        const attachments = await queryRunner.getTable('task_attachments');
        if (attachments && attachments.findColumnByName('role')) {
            await queryRunner.query(`ALTER TABLE "task_attachments" DROP COLUMN "role"`);
        }
    }
}
