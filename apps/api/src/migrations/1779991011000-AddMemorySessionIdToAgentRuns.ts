import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Follow-up to PR #1073 (agent-memory capability) + #1081
 * (memory-pipeline-modifier).
 *
 * `AgentRunService.execute()` opens an agent-memory session at the start
 * of every run (when the configured agent-memory provider is enabled for
 * the user / Work) and stores the returned session id on the run row so
 * that:
 *
 *   1. Observations saved during the run can be linked to it in audit
 *      surfaces / the eventual memory-session listing UI.
 *   2. Compensating cleanup paths (e.g. revoke-on-account-deletion) can
 *      `forget` all observations for a user's runs by joining on this
 *      column.
 *
 * The column is `varchar(128)` rather than `uuid` because the id format
 * is up to the agent-memory provider — `@ever-works/agentmemory-plugin`
 * happens to use ULIDs, but mem0 / zep / community plugins may not.
 *
 * Forward-only, additive, idempotent (gates on `hasColumn`). The `down()`
 * drops the column. No index for v1 — runs are typically looked up by
 * `agentId` or `id`, and reverse-lookup ("which run owns this session?")
 * isn't a planned query path yet. Add an index in a follow-up if needed.
 */
export class AddMemorySessionIdToAgentRuns1779991011000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('agent_runs', 'memorySessionId'))) {
            await queryRunner.addColumn(
                'agent_runs',
                new TableColumn({
                    name: 'memorySessionId',
                    type: 'varchar',
                    length: '128',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('agent_runs', 'memorySessionId')) {
            await queryRunner.dropColumn('agent_runs', 'memorySessionId');
        }
    }
}
