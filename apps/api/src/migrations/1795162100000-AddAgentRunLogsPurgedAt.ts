import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

const INDEX_NAME = 'idx_agent_runs_logs_purge';

/**
 * Self-build slice AT — `agent_runs.logsPurgedAt`, the run-timeline retention
 * marker.
 *
 * `agent_run_logs` kept every run's step timeline forever. The nightly
 * `AgentRunRetentionService` now deletes the timeline of TERMINAL runs that
 * finished more than `AGENT_RUN_LOG_RETENTION_DAYS` (default 90) ago and keeps
 * the run row; this column is what makes that pass idempotent and cheap
 * (NULL = never purged).
 *
 * Index on (`logsPurgedAt`, `finishedAt`): the pass is
 * `logsPurgedAt IS NULL AND finishedAt < cutoff`, oldest first, so purged rows
 * (the vast majority, over time) sit in another key range and are never
 * scanned again. No backfill: every existing row starts unpurged and the first
 * passes work through the backlog in bounded batches.
 *
 * Forward-only with per-step guards; portable `TableColumn` / `TableIndex`
 * DDL (Postgres in prod, better-sqlite3 in CI / e2e).
 */
export class AddAgentRunLogsPurgedAt1795162100000 implements MigrationInterface {
    name = 'AddAgentRunLogsPurgedAt1795162100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const runs = await queryRunner.getTable('agent_runs');
        if (!runs) return;
        if (!runs.findColumnByName('logsPurgedAt')) {
            await queryRunner.addColumn(
                'agent_runs',
                new TableColumn({ name: 'logsPurgedAt', type: 'timestamp', isNullable: true }),
            );
        }
        // Re-read: the sqlite driver rebuilds the table on addColumn.
        const refreshed = await queryRunner.getTable('agent_runs');
        if (refreshed && !refreshed.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.createIndex(
                'agent_runs',
                new TableIndex({ name: INDEX_NAME, columnNames: ['logsPurgedAt', 'finishedAt'] }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const runs = await queryRunner.getTable('agent_runs');
        if (!runs) return;
        if (runs.indices.some((index) => index.name === INDEX_NAME)) {
            await queryRunner.dropIndex('agent_runs', INDEX_NAME);
        }
        const refreshed = await queryRunner.getTable('agent_runs');
        if (refreshed?.findColumnByName('logsPurgedAt')) {
            await queryRunner.dropColumn('agent_runs', 'logsPurgedAt');
        }
    }
}
