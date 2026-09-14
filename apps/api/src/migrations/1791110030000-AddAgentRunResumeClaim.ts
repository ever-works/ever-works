import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Resume single-flight — `agent_runs.resumeClaimToken` + `resumeClaimedAt`.
 *
 * Entity: `packages/agent/src/entities/agent-run.entity.ts`.
 *
 * `RunSteeringService.resume` checked that a run was resumable, created a
 * successor, enqueued it, and only then cleared `awaitingInput` on the
 * source. Two requests deciding different Inbox items on the same parked
 * run could both pass the check, so one parked run got two successor runs.
 * These two columns are the compare-and-set claim `resume` now takes on the
 * source run before it creates anything: one conditional UPDATE only one
 * caller can win, fenced by the token, and expiring by the timestamp so a
 * process that died mid-resume cannot hold the run forever.
 *
 * No existing column could carry the claim safely: `awaitingInput` is
 * never set on a parked or completed run (both resumable), and
 * `attentionReason`, `queuedReason` and `terminalState` each already mean
 * something that a claim would overwrite.
 *
 * Additive and nullable, no index: both are read with the row by primary
 * key, never filtered on. Every existing run reads NULL, which is exactly
 * "no resume in flight". Forward-only with per-column guards so a partially
 * applied database converges; portable `TableColumn` DDL because CI and the
 * e2e stack run better-sqlite3 while production runs Postgres.
 */
export class AddAgentRunResumeClaim1791110030000 implements MigrationInterface {
    name = 'AddAgentRunResumeClaim1791110030000';

    private static readonly COLUMNS = [
        new TableColumn({
            name: 'resumeClaimToken',
            type: 'varchar',
            length: '36',
            isNullable: true,
        }),
        new TableColumn({ name: 'resumeClaimedAt', type: 'timestamp', isNullable: true }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const runs = await queryRunner.getTable('agent_runs');
        if (!runs) return;
        for (const column of AddAgentRunResumeClaim1791110030000.COLUMNS) {
            if (!runs.findColumnByName(column.name)) {
                await queryRunner.addColumn('agent_runs', column);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const column of [...AddAgentRunResumeClaim1791110030000.COLUMNS].reverse()) {
            // Re-read per column: better-sqlite3 rebuilds the table on every
            // drop, so a Table object read before the first drop is stale.
            const runs = await queryRunner.getTable('agent_runs');
            if (runs?.findColumnByName(column.name)) {
                await queryRunner.dropColumn('agent_runs', column.name);
            }
        }
    }
}
