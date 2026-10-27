import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Usage & cost on the fleet (FL-20) — `fleet_usage_samples` (CONTRACTS §4.10,
 * §13 slot 01): one computer's tokens for one model in one hour, for one
 * provider session (or none) and one folder bucket. Counts only — never
 * content.
 *
 * Columns are CONTRACTS §4.10's names plus three epic-local ones (lane log,
 * owner question 2): `priceListVersion` and `dedupeKey` (listed in §4.10) and
 * `agentRunId` (R-13's second attribution key). `dedupeKey` is a sha256 over
 * the bucket's identity and is UNIQUE — nullable key parts make a plain
 * composite unique index unusable on both SQLite and Postgres.
 *
 * Shipped in FL-20's first phase (lane log decision 3): the cumulative /
 * maximum merge needs a per-bucket store from the first report.
 *
 * `nodeId` has no foreign key, like `fleet_node_health_samples.nodeId`.
 * Portable `Table` DDL (CI and e2e run better-sqlite3, production Postgres);
 * each step guarded so a partially applied database converges. Forward-only:
 * `down` keeps the table and its rows.
 */
export class CreateFleetUsageSamples1796200100000 implements MigrationInterface {
    name = 'CreateFleetUsageSamples1796200100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('fleet_usage_samples'))) {
            const isPostgres = queryRunner.connection.options.type === 'postgres';
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_usage_samples',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'nodeId', type: 'uuid', isNullable: false },
                        { name: 'fleetSessionId', type: 'uuid', isNullable: true },
                        { name: 'agentRunId', type: 'uuid', isNullable: true },
                        { name: 'provider', type: 'varchar', length: '32', isNullable: false },
                        {
                            name: 'providerSessionId',
                            type: 'varchar',
                            length: '128',
                            isNullable: true,
                        },
                        { name: 'model', type: 'varchar', length: '120', isNullable: false },
                        { name: 'inputTokens', type: 'bigint', isNullable: false, default: 0 },
                        { name: 'outputTokens', type: 'bigint', isNullable: false, default: 0 },
                        { name: 'cacheReadTokens', type: 'bigint', isNullable: false, default: 0 },
                        { name: 'cacheWriteTokens', type: 'bigint', isNullable: false, default: 0 },
                        { name: 'requests', type: 'int', isNullable: false, default: 0 },
                        { name: 'costCents', type: 'int', isNullable: true },
                        { name: 'bucketStart', type: 'timestamp', isNullable: false },
                        { name: 'checkoutPath', type: 'text', isNullable: true },
                        { name: 'priceListVersion', type: 'int', isNullable: true },
                        { name: 'dedupeKey', type: 'varchar', length: '64', isNullable: false },
                        { name: 'firstAt', type: 'timestamp', isNullable: true },
                        { name: 'lastAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const indices: TableIndex[] = [
            new TableIndex({
                name: 'uq_fleet_usage_samples_dedupe',
                columnNames: ['dedupeKey'],
                isUnique: true,
            }),
            new TableIndex({
                name: 'idx_fleet_usage_samples_node_bucket',
                columnNames: ['nodeId', 'bucketStart'],
            }),
            new TableIndex({
                name: 'idx_fleet_usage_samples_session',
                columnNames: ['fleetSessionId'],
            }),
            new TableIndex({ name: 'idx_fleet_usage_samples_run', columnNames: ['agentRunId'] }),
            new TableIndex({
                name: 'idx_fleet_usage_samples_provider_session',
                columnNames: ['nodeId', 'provider', 'providerSessionId'],
            }),
        ];
        for (const index of indices) {
            // Re-read per step: an index an earlier, interrupted run created must be seen first.
            const table = await queryRunner.getTable('fleet_usage_samples');
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex('fleet_usage_samples', index);
            }
        }
    }

    /**
     * Intentionally forward-only. Rolling the application back leaves the
     * table and every sample in place for a later roll-forward; nothing reads
     * it without the code that writes it.
     */
    public async down(_queryRunner: QueryRunner): Promise<void> {}
}
