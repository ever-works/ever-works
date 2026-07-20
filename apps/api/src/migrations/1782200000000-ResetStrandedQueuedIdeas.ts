import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR-4 (domain-model evolution) — Option A backfill (review §23.7).
 *
 * DATA migration (no schema change). Before this PR the Idea build
 * pipeline was dead: `POST /me/work-proposals/:id/build` (and Mission
 * auto-build) flipped an Idea to `queued` and created a
 * `WorkAgentGoal`, but nothing ever executed that Goal — so those
 * Ideas were stranded in `queued` forever. Mission auto-build was
 * worse: it flipped Ideas to `queued` WITHOUT even creating a Goal.
 *
 * The executor this PR introduces only picks up work that gets
 * enqueued AFTER it is enabled; it will never drain the pre-existing
 * stranded backlog. Per the §23.7 ruling (Option A) we reset those
 * pre-executor stranded Ideas back to `pending` so the user can
 * re-trigger a build cleanly once the executor is on, and so the
 * outstanding-Ideas cap / dashboard counts reflect reality.
 *
 * PRECISION — only truly-stranded Ideas are reset. An Idea is
 * "stranded" iff it is `queued` AND has NO corresponding
 * `work_agent_goals` row (matched on `ideaId`) in a NON-TERMINAL
 * state. Non-terminal goal statuses are `pending`, `planning`,
 * `waiting-for-approval`, `running`. If a non-terminal Goal exists,
 * the Idea is legitimately mid-flight (or about to be) and is left
 * untouched — resetting it would race the executor. Terminal Goals
 * (`completed`, `canceled`, `rejected`, `failed`) do NOT protect an
 * Idea from reset: a `queued` Idea whose only Goals are terminal is
 * stranded (its build already ended without moving the Idea forward).
 *
 * The failure columns (`failureMessage`, `failureKind`) are cleared on
 * reset so a stale failure banner doesn't linger on an Idea that is
 * now cleanly `pending` again.
 *
 * IDEMPOTENT: the `WHERE status = 'queued'` guard means a re-run finds
 * nothing to reset (the first run already moved the rows to `pending`),
 * so running this migration twice is a no-op.
 *
 * DOWN is a deliberate NO-OP: we cannot safely re-strand Ideas. The
 * reset is lossy (we don't record which `pending` rows were previously
 * `queued`), and re-queueing them would recreate exactly the stranded
 * state this migration exists to clear. Operators who want a specific
 * Idea rebuilt use the normal Build button.
 */
export class ResetStrandedQueuedIdeas1782200000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "work_proposals" AS wp
               SET "status" = 'pending',
                   "failureMessage" = NULL,
                   "failureKind" = NULL
             WHERE wp."status" = 'queued'
               AND NOT EXISTS (
                   SELECT 1
                     FROM "work_agent_goals" AS g
                    WHERE g."ideaId" = wp."id"
                      AND g."status" IN (
                          'pending',
                          'planning',
                          'waiting-for-approval',
                          'running'
                      )
               )
        `);
    }

    public async down(): Promise<void> {
        // Irreversible by design — see the class JSDoc. Re-stranding
        // Ideas would recreate the exact bug this migration clears.
    }
}
