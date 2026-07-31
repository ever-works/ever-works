import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Judgment layer G9 — `tasks.delegationDepth`.
 *
 * How many sub-agent delegations deep a Task sits. The delegation runner
 * stamps `parent + 1` on every child Task it creates, and
 * `SubAgentDelegationService` resolves it back through `parentTaskId`
 * before validating a new delegation.
 *
 * Why a column and not a derived walk: the depth ceiling in
 * `validateSubAgentDelegationRequest` was evaluated against a
 * CALLER-DECLARED integer that nothing ever set above 0, so
 * `depth >= maxDepth` could never fire and the cap was inert. Deriving
 * the value server-side is the only version that actually bounds
 * recursion — a caller cannot declare itself shallow if the platform
 * wrote the number.
 *
 * **Nothing is backfilled.** Every existing Task keeps NULL, which every
 * reader treats as 0 ("not delegated"). That is correct rather than
 * merely convenient: no Task predating this column was created by a
 * delegation, because the runner that creates them is the only writer.
 *
 * No index. The column is only ever read by primary-key lookup of a
 * specific parent Task during delegation validation, never filtered or
 * sorted on.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1784770000000-AddEscalationConfidence).
 */
export class AddTaskDelegationDepth1784800000000 implements MigrationInterface {
    name = 'AddTaskDelegationDepth1784800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('tasks');
        if (!table) return;

        if (!table.findColumnByName('delegationDepth')) {
            await queryRunner.query(`ALTER TABLE "tasks" ADD COLUMN "delegationDepth" integer`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('tasks');
        if (!table) return;

        // Safe to drop: the column carries only derived provenance the
        // platform wrote itself. Reverting loses the recursion bound
        // (delegations fall back to the caller-declared depth), not user
        // data — so unlike a content column this does not need the
        // refuse-and-report treatment.
        if (table.findColumnByName('delegationDepth')) {
            await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "delegationDepth"`);
        }
    }
}
