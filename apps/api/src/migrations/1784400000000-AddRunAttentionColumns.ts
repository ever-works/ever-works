import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * State-aware sweeper (Wave 4 M6) — the two `agent_runs` columns the
 * needs-attention surface needs.
 *
 *  - `attentionReason` — short machine token (`queued-too-long`,
 *                        `stale-parked`) saying why the PLATFORM thinks a
 *                        human should look at this run. Deliberately
 *                        separate from `awaitingInput`, which means the
 *                        AGENT asked a question: the Sessions list's
 *                        `attention=1` filter is the union of the two, so
 *                        neither has to be overloaded.
 *  - `attentionAt`     — when the flag was raised. `timestamp` NULL, the
 *                        `PortableDateColumn` shape used by every other
 *                        date column on this table.
 *
 * Both NULL on every pre-existing row, which is exactly "this run is
 * fine" — nothing is backfilled and no existing behavior changes.
 *
 * Forward-only, idempotent per-step guards (house pattern, mirrors
 * 1784100000000-AddRunSteeringColumns). No index: the queued-too-long
 * scan already narrows on `status='queued'` (covered by
 * `idx_agent_runs_status`) before testing this column, and the Sessions
 * filter is always userId-scoped first.
 */
export class AddRunAttentionColumns1784400000000 implements MigrationInterface {
    name = 'AddRunAttentionColumns1784400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;

        const addColumn = async (name: string, ddl: string) => {
            if (!table.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN ${ddl}`);
            }
        };

        await addColumn('attentionReason', `"attentionReason" varchar(32)`);
        await addColumn('attentionAt', `"attentionAt" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;
        for (const col of ['attentionAt', 'attentionReason']) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "${col}"`);
            }
        }
    }
}
