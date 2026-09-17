import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Agent halt reason (AW-23 P1) — why an agent is not working, recorded at
 * the moment it stops instead of reconstructed from run history afterwards.
 *
 * Eight additive columns on `agents`; no indexes, no foreign keys:
 *
 *  1. `haltReason`      — `user | credential | failures | cap | platform`.
 *                          NULL = the agent is not halted.
 *  2. `haltNote`        — the optional human note from the pause dialog,
 *                          capped at 200 characters and secret-scanned on
 *                          write.
 *  3. `haltedAt`        — when the halt was written.
 *  4. `haltedByUserId`  — who pressed Pause. Raw uuid, no FK — the same
 *                          posture as `reportsToAgentId`: the row must
 *                          survive the user record being reshaped, and
 *                          nothing joins on it.
 *  5. `haltedRunId`     — the run behind an automatic halt. Raw uuid for
 *                          the same reason: runs are pruned, and a halt
 *                          reason must outlive the run that caused it.
 *  6. `haltDetail`      — a display name plus a coarse kind for whatever
 *                          refused the agent. 🛑 Never a credential.
 *  7. `haltRepeatCount` — consecutive halts with the same reason, so the
 *                          card can say "halted for this reason twice".
 *                          NOT NULL DEFAULT 0, which is exactly right for
 *                          every existing row: none has halted twice.
 *  8. `haltRepeatReason` — WHICH reason `haltRepeatCount` is counting. It
 *                          deliberately OUTLIVES a resume: resuming an
 *                          agent whose credential is still broken clears
 *                          the halt (1–6) but must leave the counter able
 *                          to say "halted for this reason twice" when the
 *                          very next run halts it again. Without this
 *                          column the counter has nothing to compare
 *                          against once the reason is cleared.
 *
 * **No backfill on purpose.** An agent that is already `paused` reads as
 * "Paused by you" with no time and no author, because that is genuinely
 * everything the platform knows about it. Inventing a timestamp would be
 * a nicer-looking lie.
 *
 * Forward-only with existence guards so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddAgentHaltReason1791230000000 implements MigrationInterface {
    name = 'AddAgentHaltReason1791230000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const agents = await queryRunner.getTable('agents');
        if (!agents) return;
        if (!agents.findColumnByName('haltReason')) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({
                    name: 'haltReason',
                    type: 'varchar',
                    length: '16',
                    isNullable: true,
                }),
            );
        }
        if (!agents.findColumnByName('haltNote')) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({
                    name: 'haltNote',
                    type: 'varchar',
                    length: '200',
                    isNullable: true,
                }),
            );
        }
        if (!agents.findColumnByName('haltedAt')) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({ name: 'haltedAt', type: 'timestamp', isNullable: true }),
            );
        }
        if (!agents.findColumnByName('haltedByUserId')) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({ name: 'haltedByUserId', type: 'uuid', isNullable: true }),
            );
        }
        if (!agents.findColumnByName('haltedRunId')) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({ name: 'haltedRunId', type: 'uuid', isNullable: true }),
            );
        }
        if (!agents.findColumnByName('haltDetail')) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({ name: 'haltDetail', type: 'text', isNullable: true }),
            );
        }
        if (!agents.findColumnByName('haltRepeatCount')) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({
                    name: 'haltRepeatCount',
                    type: 'int',
                    isNullable: false,
                    default: 0,
                }),
            );
        }
        if (!agents.findColumnByName('haltRepeatReason')) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({
                    name: 'haltRepeatReason',
                    type: 'varchar',
                    length: '16',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Re-read between drops: `dropColumn` on sqlite REBUILDS the table,
        // so the metadata captured before a drop is stale for the next one.
        for (const column of [
            'haltRepeatReason',
            'haltRepeatCount',
            'haltDetail',
            'haltedRunId',
            'haltedByUserId',
            'haltedAt',
            'haltNote',
            'haltReason',
        ]) {
            const agents = await queryRunner.getTable('agents');
            if (agents?.findColumnByName(column)) {
                await queryRunner.dropColumn('agents', column);
            }
        }
    }
}
