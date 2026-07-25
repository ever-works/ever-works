import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kanban run cockpit (Wave 2 M1) — run telemetry + latest-run denorm.
 *
 * `agent_runs`: currentActivity (one-line live activity feed, plain
 * text), totalTokens (cumulative token usage), changedFilesCount
 * (workspace files touched). Written by the worker via
 * `AgentRunRepository.updateTelemetry`.
 *
 * `tasks`: latestRunId (pointer to the most recent AgentRun dispatched
 * for the Task), latestRunStatus (status mirror). Maintained by
 * `TaskRunDenormService` so the board list can batch-embed the latest
 * run per card with a single IN query.
 *
 * Forward-only, idempotent per-step guards (house pattern). Every
 * column is nullable — existing rows simply carry no telemetry.
 */
export class AddRunTelemetryColumns1782900000000 implements MigrationInterface {
    name = 'AddRunTelemetryColumns1782900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const agentRuns = await queryRunner.getTable('agent_runs');
        if (agentRuns) {
            const add = async (name: string, ddl: string) => {
                if (!agentRuns.findColumnByName(name)) {
                    await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN ${ddl}`);
                }
            };
            await add('currentActivity', `"currentActivity" varchar(300)`);
            await add('totalTokens', `"totalTokens" int`);
            await add('changedFilesCount', `"changedFilesCount" int`);
        }

        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            const add = async (name: string, ddl: string) => {
                if (!tasks.findColumnByName(name)) {
                    await queryRunner.query(`ALTER TABLE "tasks" ADD COLUMN ${ddl}`);
                }
            };
            await add('latestRunId', `"latestRunId" uuid`);
            await add('latestRunStatus', `"latestRunStatus" varchar(16)`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks) {
            for (const col of ['latestRunStatus', 'latestRunId']) {
                if (tasks.findColumnByName(col)) {
                    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "${col}"`);
                }
            }
        }
        const agentRuns = await queryRunner.getTable('agent_runs');
        if (agentRuns) {
            for (const col of ['changedFilesCount', 'totalTokens', 'currentActivity']) {
                if (agentRuns.findColumnByName(col)) {
                    await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "${col}"`);
                }
            }
        }
    }
}
