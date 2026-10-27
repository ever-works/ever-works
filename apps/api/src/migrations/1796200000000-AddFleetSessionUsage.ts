import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Usage & cost on the fleet (FL-20) — what a Session carries about its model
 * work (CONTRACTS §4.2, §13 slot 00):
 *
 *  - `fleet_sessions.tokens` (text, nullable) — the entity's `simple-json`
 *    `FleetSessionUsage`: tokens by model and class, requests, first / last
 *    activity and the list-price version the figures used. Derived from the
 *    Session's usage samples by the reconciler; NULL until the first report
 *    that touches the Session.
 *  - `fleet_sessions.costCents` (int, nullable) — the list-price cost of the
 *    priced models. NULL = nothing priced (unknown models are tokens only).
 *  - `idx_fleet_sessions_provider_session (provider, providerSessionId)` — the
 *    attribution lookup (R-13), run for every report.
 *  - `idx_agent_runs_cli_session (cliSessionId)` — R-13's second key: a Task
 *    run's CLI session (`recordFleetCliSession` writes `cliSessionId` beside
 *    `fleetCliSession`), so a headless run's records find their Run without a
 *    table scan.
 *
 * No `fleet_nodes` column: "last scan" is the newest completed `usage-scan`
 * job and the backlog is that job's `result.backlogPct` (plan §4.1).
 *
 * Portable `TableColumn` / `TableIndex` DDL (CI and e2e run better-sqlite3,
 * production Postgres); every step guarded and re-read, so a partially applied
 * database converges. Additive only.
 */
export class AddFleetSessionUsage1796200000000 implements MigrationInterface {
    name = 'AddFleetSessionUsage1796200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const columns: TableColumn[] = [
            new TableColumn({ name: 'tokens', type: 'text', isNullable: true }),
            new TableColumn({ name: 'costCents', type: 'int', isNullable: true }),
        ];
        for (const column of columns) {
            const sessions = await queryRunner.getTable('fleet_sessions');
            if (sessions && !sessions.findColumnByName(column.name)) {
                await queryRunner.addColumn('fleet_sessions', column);
            }
        }
        const sessions = await queryRunner.getTable('fleet_sessions');
        if (
            sessions &&
            sessions.findColumnByName('providerSessionId') &&
            !sessions.indices.some((index) => index.name === 'idx_fleet_sessions_provider_session')
        ) {
            await queryRunner.createIndex(
                'fleet_sessions',
                new TableIndex({
                    name: 'idx_fleet_sessions_provider_session',
                    columnNames: ['provider', 'providerSessionId'],
                }),
            );
        }
        const runs = await queryRunner.getTable('agent_runs');
        if (
            runs &&
            runs.findColumnByName('cliSessionId') &&
            !runs.indices.some((index) => index.name === 'idx_agent_runs_cli_session')
        ) {
            await queryRunner.createIndex(
                'agent_runs',
                new TableIndex({
                    name: 'idx_agent_runs_cli_session',
                    columnNames: ['cliSessionId'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const runs = await queryRunner.getTable('agent_runs');
        if (runs?.indices.some((index) => index.name === 'idx_agent_runs_cli_session')) {
            await queryRunner.dropIndex('agent_runs', 'idx_agent_runs_cli_session');
        }
        let sessions = await queryRunner.getTable('fleet_sessions');
        if (!sessions) return;
        if (
            sessions.indices.some((index) => index.name === 'idx_fleet_sessions_provider_session')
        ) {
            await queryRunner.dropIndex('fleet_sessions', 'idx_fleet_sessions_provider_session');
        }
        for (const name of ['costCents', 'tokens']) {
            sessions = await queryRunner.getTable('fleet_sessions');
            if (sessions?.findColumnByName(name))
                await queryRunner.dropColumn('fleet_sessions', name);
        }
    }
}
