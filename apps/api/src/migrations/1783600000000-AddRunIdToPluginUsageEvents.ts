import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pricing Wave 9 M2 — per-run cost attribution on the metering pipeline.
 *
 *  - `runId` — nullable uuid on `plugin_usage_events`; populated when a
 *    usage event is recorded inside an `AgentRun` (threaded through
 *    `FacadeOptions.runId`). The run-cost accumulator sums `costCents`
 *    over rows tagged with the run id at run-terminal time to stamp
 *    `agent_runs.costCents` and emit the credits CONSUMPTION debit
 *    (idempotency key `run:{runId}`). NULL for all historical rows and
 *    for calls made outside a run — honestly "not attributable", never
 *    backfilled (there is no reliable historical mapping from events to
 *    runs; agentId/taskId attribution predates per-run granularity).
 *
 * No FK to `agent_runs` — deleting an Agent (CASCADE onto its runs)
 * must NOT drop usage audit rows, mirroring the agentId/taskId columns.
 *
 * Index `(runId, occurredAt)` for the accumulator's per-run sum.
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1783100000000-AddRunOrchestrationColumns).
 */
export class AddRunIdToPluginUsageEvents1783600000000 implements MigrationInterface {
    name = 'AddRunIdToPluginUsageEvents1783600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('plugin_usage_events');
        if (!table) return;

        if (!table.findColumnByName('runId')) {
            await queryRunner.query(`ALTER TABLE "plugin_usage_events" ADD COLUMN "runId" uuid`);
        }

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_plugin_usage_events_run_occurred" ` +
                `ON "plugin_usage_events" ("runId", "occurredAt")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_plugin_usage_events_run_occurred"`);
        const table = await queryRunner.getTable('plugin_usage_events');
        if (!table) return;
        if (table.findColumnByName('runId')) {
            await queryRunner.query(`ALTER TABLE "plugin_usage_events" DROP COLUMN "runId"`);
        }
    }
}
