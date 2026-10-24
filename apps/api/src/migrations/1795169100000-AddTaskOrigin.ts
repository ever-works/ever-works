import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Works-security (2026-10-18) — `tasks.origin`, the server-written provenance
 * of a Task (`packages/agent/src/entities/task.entity.ts`, `Task.origin`).
 *
 * The App change guard used to exempt a Task from its guarded-spec-block rule
 * because the Task carried the `app-provision` LABEL, and labels are free-form
 * text any caller of `PATCH /api/tasks/:id` can write — a fleet-run token, an
 * integration key, an MCP client steered by injected text. The exemption now
 * reads this column, which only `AppProvisioningService.start` writes and which
 * no DTO accepts.
 *
 *  - `origin` (varchar 32, nullable). `NULL` for every ordinary Task.
 *
 * No backfill, deliberately (fail closed): a row written before this column
 * existed cannot prove the platform filed it, because its label could have
 * been added by anyone. A provisioning Task that was still open at deploy time
 * loses the exemption; restarting provisioning files a new Task that has it.
 *
 * Timestamp `1795169100000`: first merged as `1796040000000`, which is fleet
 * epic FL-04's reserved slot (`docs/specs/features/fleet/CONTRACTS.md` §13,
 * `CreateFleetSessions`). Renumbered out of the fleet range; a database that
 * already ran it under the old name runs this one as a no-op (the guard below).
 *
 * Forward-only with a per-step guard so a partially applied database
 * converges; portable `TableColumn` DDL (Postgres in prod, better-sqlite3 in
 * CI / e2e).
 */
export class AddTaskOrigin1795169100000 implements MigrationInterface {
    name = 'AddTaskOrigin1795169100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (!tasks) return;
        if (!tasks.findColumnByName('origin')) {
            await queryRunner.addColumn(
                'tasks',
                new TableColumn({
                    name: 'origin',
                    type: 'varchar',
                    length: '32',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks?.findColumnByName('origin')) {
            await queryRunner.dropColumn('tasks', 'origin');
        }
    }
}
