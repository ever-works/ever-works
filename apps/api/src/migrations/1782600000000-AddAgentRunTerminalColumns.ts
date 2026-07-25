import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Streaming-terminal M4 — AgentRun terminal columns.
 *
 * All nullable (except `persistent`, boolean default false): NULL =
 * "this run has no terminal", which is every pre-existing row. Partial
 * index on non-null `terminalState` for the sweeper's stale-heartbeat
 * scan. Forward-only, idempotent per-step guards (house pattern).
 *
 * Deliberately NO content/transcript/token columns — terminal bytes
 * live only in log chunks and the in-memory relay window (the schema
 * invariant test pins this).
 */
export class AddAgentRunTerminalColumns1782600000000 implements MigrationInterface {
    name = 'AddAgentRunTerminalColumns1782600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;

        const addColumn = async (name: string, ddl: string) => {
            if (!table.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "agent_runs" ADD COLUMN ${ddl}`);
            }
        };

        await addColumn('persistent', `"persistent" boolean NOT NULL DEFAULT false`);
        await addColumn('terminalState', `"terminalState" varchar(16)`);
        await addColumn('terminalEndedReason', `"terminalEndedReason" varchar(32)`);
        await addColumn('terminalProviderId', `"terminalProviderId" varchar(64)`);
        await addColumn('cliSessionId', `"cliSessionId" varchar(128)`);
        await addColumn('lastHeartbeatAt', `"lastHeartbeatAt" timestamp`);
        await addColumn('lastFrameSeq', `"lastFrameSeq" int`);

        // Partial index: the sweeper scans only live-terminal rows.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "idx_agent_runs_terminal_state" ` +
                `ON "agent_runs" ("terminalState") WHERE "terminalState" IS NOT NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_agent_runs_terminal_state"`);
        const table = await queryRunner.getTable('agent_runs');
        if (!table) return;
        for (const col of [
            'lastFrameSeq',
            'lastHeartbeatAt',
            'cliSessionId',
            'terminalProviderId',
            'terminalEndedReason',
            'terminalState',
            'persistent',
        ]) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "agent_runs" DROP COLUMN "${col}"`);
            }
        }
    }
}
