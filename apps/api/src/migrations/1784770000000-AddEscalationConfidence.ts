import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Judgment layer G3 — the confidence column on `agent_escalations`.
 *
 *  - `confidence`       — `0..1`, how sure the platform is that this
 *                         escalation genuinely needs a HUMAN. Written at
 *                         record time by the AI judge (through the AI
 *                         facade) or, when no judge is reachable, by the
 *                         deterministic reason-code table.
 *  - `confidenceSource` — `ai-judge` | `heuristic`. Stored because a
 *                         `0.4` from a model and a `0.4` from the
 *                         fallback table are not the same claim, and a
 *                         UI that renders them identically would be
 *                         lying about how the number was reached.
 *
 * Why it matters enough to be a column rather than a derived value: the
 * escalation queue is ORDERED by it (`listForUser`). Recomputing a score
 * on read would mean re-running a model call per page — and the score
 * would drift from the one a human already acted on.
 *
 * **Nothing is backfilled.** Every existing escalation keeps NULL, which
 * every reader treats as "never scored" — deliberately NOT as "low
 * confidence", because sorting real escalations below unscored ones (or
 * vice versa on a fabricated `0`) is exactly the silent demotion this
 * column exists to prevent. The list query sorts with
 * `COALESCE(confidence, -1) DESC`, so unscored rows sit below scored
 * ones on both Postgres and sqlite without a driver-specific NULLS
 * clause.
 *
 * `double precision` is what TypeORM's `float` column type maps to on
 * Postgres, matching the sibling score columns
 * (`goals.currentValue`, `works.domainTypeConfidence`).
 *
 * No index: confidence is only ever read on rows already selected by
 * `userId` (+ `status`), which the existing
 * `idx_agent_escalation_user_status` index already covers.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1784500000000-AddGoalJudgmentColumns).
 */
export class AddEscalationConfidence1784770000000 implements MigrationInterface {
    name = 'AddEscalationConfidence1784770000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_escalations');
        if (!table) return;

        const addColumn = async (name: string, ddl: string) => {
            if (!table.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "agent_escalations" ADD COLUMN ${ddl}`);
            }
        };

        await addColumn('confidence', `"confidence" double precision`);
        await addColumn('confidenceSource', `"confidenceSource" varchar(16)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_escalations');
        if (!table) return;
        for (const column of ['confidenceSource', 'confidence']) {
            if (table.findColumnByName(column)) {
                await queryRunner.query(`ALTER TABLE "agent_escalations" DROP COLUMN "${column}"`);
            }
        }
    }
}
