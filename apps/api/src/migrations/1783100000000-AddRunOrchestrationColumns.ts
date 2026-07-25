import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Run orchestration (Wave 4 M1) — `agent_runs` scheduling + telemetry
 * columns for the dispatch gate and the Sessions view.
 *
 *  - `workId`        — nullable uuid, denormalized from `task.workId` at
 *                      creation (backfilled below for historical rows);
 *                      powers per-Work concurrency counts + grouping.
 *  - `awaitingInput` — boolean default false; parked-on-a-human flag,
 *                      never reaped by TTL sweeps.
 *  - `queuedReason`  — varchar(64) nullable; why a queued run was NOT
 *                      dispatched (`concurrency-limit` today).
 *  - `runnerKind`    — varchar(32) nullable; pipeline plugin id.
 *  - `costCents`     — int nullable; per-run cumulative cost estimate
 *                      (per-event source of truth stays
 *                      `plugin_usage_events.costCents`).
 *
 * Index `(workId, status)` for the gate's in-flight counts and the
 * per-Work runs summary. Forward-only, idempotent per-step guards
 * (house pattern, mirrors 1782700000000-AddTaskIsolationColumns).
 */
export class AddRunOrchestrationColumns1783100000000 implements MigrationInterface {
    name = 'AddRunOrchestrationColumns1783100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;

        const addColumn = async (name: string, ddl: string) => {
            if (!table.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN ${ddl}`);
            }
        };

        await addColumn('workId', `"workId" uuid`);
        await addColumn('awaitingInput', `"awaitingInput" boolean NOT NULL DEFAULT false`);
        await addColumn('queuedReason', `"queuedReason" varchar(64)`);
        await addColumn('runnerKind', `"runnerKind" varchar(32)`);
        await addColumn('costCents', `"costCents" int`);

        // Backfill workId for historical task-attached runs where derivable.
        // Correlated subquery is portable across Postgres and sqlite (the
        // e2e suite runs on sqlite). Rows whose Task has no Work — or whose
        // Task was deleted — honestly stay NULL.
        await queryRunner.query(
            `UPDATE "agent_runs" SET "workId" = ` +
                `(SELECT "workId" FROM "tasks" WHERE "tasks"."id" = "agent_runs"."taskId") ` +
                `WHERE "workId" IS NULL AND "taskId" IS NOT NULL`,
        );

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_agent_runs_work_status" ` +
                `ON "agent_runs" ("workId", "status")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_runs_work_status"`);
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;
        for (const col of ['costCents', 'runnerKind', 'queuedReason', 'awaitingInput', 'workId']) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "${col}"`);
            }
        }
    }
}
