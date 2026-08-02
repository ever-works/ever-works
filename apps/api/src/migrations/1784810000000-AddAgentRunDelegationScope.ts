import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Judgment layer G9 — `agent_runs.delegationScope`.
 *
 * The effective, already-narrowed scope a DELEGATED run executes under.
 * `dispatchAgentRun` snapshots it onto the pre-created run row, and the
 * tool loop intersects the run's resolved tools against it.
 *
 * Why the column exists: `narrowSubAgentScope` computed a correct
 * narrowed scope and the runner then discarded it — it read only
 * `scope.workId`. So the delegation contract's headline property,
 * "privilege can only ever shrink going down the tree", held at the
 * ADMISSION boundary (an over-broad request was refused) and nowhere
 * else: a child that was admitted ran with its own agent's full tool
 * set, and `childAgentId` defaults to the parent, so by default the
 * child WAS the parent with every permission it holds.
 *
 * Why on the run and not the Task: the run row is pre-created by
 * `dispatchAgentRun` before the worker starts, and `AgentRunService`
 * already injects `AgentRunRepository` — so the tool loop reads it with
 * no new dependency and, critically, without
 * `packages/agent/src/agents/` gaining a runtime import of
 * `tasks-domain`, which the AGENT_DOMAIN_TOOL_SOURCES seam exists to
 * prevent.
 *
 * A snapshot, not a reference: re-deriving the scope later from a parent
 * whose permissions may since have changed could hand an in-flight child
 * something other than what it was admitted with.
 *
 * **Nothing is backfilled.** Every existing run keeps NULL, which the
 * filter treats as "no additional restriction" — the correct reading,
 * since no run predating this column was dispatched with a scope. That
 * also makes the rollout fail-OPEN for one deploy window (an old worker
 * ignores the column and a child keeps full tools, exactly as today),
 * which is a non-regression rather than a new hole.
 *
 * `simple-json` matches the sibling snapshot columns on this table
 * (`resolvedChecks`, `checkResults`), which TypeORM maps to text on
 * every supported driver. No index: the column is only ever read by
 * primary-key lookup of the run already being executed.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1784800000000-AddTaskDelegationDepth).
 */
export class AddAgentRunDelegationScope1784810000000 implements MigrationInterface {
    name = 'AddAgentRunDelegationScope1784810000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;

        if (!table.findColumnByName('delegationScope')) {
            await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN "delegationScope" text`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;

        // Safe to drop: the column holds a snapshot the platform wrote
        // itself, never user content. Reverting loses the runtime half of
        // the scope guarantee (delegated children go back to running with
        // their agent's full tool set — the pre-change behaviour), not
        // any data, so unlike a content column this needs no
        // refuse-and-report guard.
        if (table.findColumnByName('delegationScope')) {
            await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "delegationScope"`);
        }
    }
}
