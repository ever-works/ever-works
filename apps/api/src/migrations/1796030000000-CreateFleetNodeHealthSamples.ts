import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Computer health (FL-03) — the health history table.
 *
 * Before this a computer reported that it was alive, what its worker was
 * doing and how much disk was left, and nothing kept any of it over time:
 * "is this machine getting worse?" had no answer. `fleet_node_health_samples`
 * holds one RAW row per accepted heartbeat that carried a health snapshot
 * (at most one per node per 55 s, kept 7 days) and one HOURLY roll-up row
 * per node per hour (means, plus the hour's `cpuMax` / `memMax` / `diskMax`,
 * kept 90 days) — one table with a `resolution` column, exactly the
 * CONTRACTS §4.5 (revision 3) columns. Rows are written only while
 * `FLEET_HEALTH_HISTORY_ENABLED` is on; the roll-up and retention run as a
 * scheduled task on the configured job runtime.
 *
 * Indexes: a UNIQUE `(nodeId, resolution, at)` — one row per node per
 * instant per resolution, which is what makes a re-run roll-up a no-op —
 * and `(resolution, at)` for the retention sweep's range deletes.
 *
 * `nodeId` has no foreign key, like `fleet_audit.nodeId`: history is pruned
 * by its own retention, never cascaded. Portable `Table` DDL (CI and e2e run
 * better-sqlite3, production Postgres); each step guarded so a partially
 * applied database converges. Forward-only: `down` keeps the table and its
 * rows, so rolling the application back loses no history.
 */
export class CreateFleetNodeHealthSamples1796030000000 implements MigrationInterface {
    name = 'CreateFleetNodeHealthSamples1796030000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('fleet_node_health_samples'))) {
            const isPostgres = queryRunner.connection.options.type === 'postgres';
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_node_health_samples',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'nodeId', type: 'uuid', isNullable: false },
                        { name: 'at', type: 'timestamp', isNullable: false },
                        { name: 'resolution', type: 'varchar', length: '8', isNullable: false },
                        { name: 'cpuPercent', type: 'float', isNullable: true },
                        { name: 'memPercent', type: 'float', isNullable: true },
                        { name: 'memTotalMiB', type: 'bigint', isNullable: true },
                        { name: 'diskPercent', type: 'float', isNullable: true },
                        { name: 'diskFreeMiB', type: 'bigint', isNullable: true },
                        { name: 'loadAvg1', type: 'float', isNullable: true },
                        { name: 'uptimeSec', type: 'bigint', isNullable: true },
                        { name: 'gpu', type: 'text', isNullable: true },
                        { name: 'pendingReboot', type: 'boolean', isNullable: true },
                        { name: 'failedServices', type: 'int', isNullable: true },
                        { name: 'cpuMax', type: 'float', isNullable: true },
                        { name: 'memMax', type: 'float', isNullable: true },
                        { name: 'diskMax', type: 'float', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const table = await queryRunner.getTable('fleet_node_health_samples');
        if (
            table &&
            !table.indices.some(
                (index) => index.name === 'uq_fleet_node_health_samples_node_res_at',
            )
        ) {
            await queryRunner.createIndex(
                'fleet_node_health_samples',
                new TableIndex({
                    name: 'uq_fleet_node_health_samples_node_res_at',
                    columnNames: ['nodeId', 'resolution', 'at'],
                    isUnique: true,
                }),
            );
        }
        if (
            table &&
            !table.indices.some((index) => index.name === 'idx_fleet_node_health_samples_res_at')
        ) {
            await queryRunner.createIndex(
                'fleet_node_health_samples',
                new TableIndex({
                    name: 'idx_fleet_node_health_samples_res_at',
                    columnNames: ['resolution', 'at'],
                }),
            );
        }
    }

    /**
     * Intentionally forward-only. Rolling the application back leaves the
     * table and every sample in place for a later roll-forward; nothing reads
     * it without the code that writes it.
     */
    public async down(_queryRunner: QueryRunner): Promise<void> {}
}
