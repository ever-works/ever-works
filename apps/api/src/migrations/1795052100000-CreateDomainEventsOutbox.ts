import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';

/**
 * Domain events (EW-P1-1, `docs/specs/features/domain-events/spec.md`).
 *
 * 1. `domain_events` — the transactional outbox. `outboxSeq` is the
 *    auto-increment primary key (insert order); `seq` is the feed position the
 *    single-leader relay assigns at dispatch (null until then, unique, gap-free).
 *    Postgres and MySQL get a 64-bit key; better-sqlite3 only accepts
 *    `INTEGER PRIMARY KEY AUTOINCREMENT`, which is 64-bit there anyway. `data` is
 *    `longtext` on MySQL because a task snapshot can exceed `text`'s 64 KiB.
 * 2. `domain_event_relay_state` — the one lease / last-position / retention-floor
 *    row, seeded here so every replica finds it.
 * 3. `plugin_event_cursors` — per plugin and tenant, the last position delivered.
 * 4. `version int NOT NULL DEFAULT 1` on the P1 aggregates `tasks`, `teams`,
 *    `agents`, `works` and `organizations` (every existing row starts at 1).
 *
 * The undispatched-rows index is partial (`WHERE "dispatchedAt" IS NULL`) on
 * Postgres and better-sqlite3; MySQL has no partial indexes and gets the plain
 * composite, which serves the same `IS NULL ... ORDER BY outboxSeq` scan.
 *
 * Additive and idempotent: every step is guarded, so a partially applied
 * database converges. `down` drops the three tables and the five columns (the
 * outbox is transient plumbing; nothing else references it).
 */
export class CreateDomainEventsOutbox1795052100000 implements MigrationInterface {
    name = 'CreateDomainEventsOutbox1795052100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const driver = String(queryRunner.connection.options.type);
        const isSqlite = driver === 'better-sqlite3' || driver === 'sqlite' || driver === 'sqljs';
        const isMysql = driver === 'mysql' || driver === 'mariadb';
        const isPostgres = driver === 'postgres';
        const uuidDefault = isPostgres ? 'uuid_generate_v4()' : undefined;

        if (!(await queryRunner.hasTable('domain_events'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'domain_events',
                    columns: [
                        {
                            name: 'outboxSeq',
                            type: isSqlite ? 'integer' : 'bigint',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'increment',
                        },
                        { name: 'seq', type: 'bigint', isNullable: true },
                        { name: 'id', type: 'varchar', length: '32' },
                        { name: 'type', type: 'varchar', length: '64' },
                        { name: 'version', type: 'smallint', default: 1 },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'aggregateType', type: 'varchar', length: '32' },
                        { name: 'aggregateId', type: 'varchar', length: '64' },
                        { name: 'aggregateVersion', type: 'int', default: 1 },
                        { name: 'visibility', type: 'varchar', length: '16', isNullable: true },
                        { name: 'actorType', type: 'varchar', length: '16' },
                        { name: 'actorId', type: 'varchar', length: '100' },
                        { name: 'actorLabel', type: 'varchar', length: '200', isNullable: true },
                        { name: 'originTag', type: 'varchar', length: '100', isNullable: true },
                        { name: 'integrationKeyId', type: 'uuid', isNullable: true },
                        { name: 'changedFields', type: 'text' },
                        { name: 'data', type: isMysql ? 'longtext' : 'text' },
                        { name: 'previous', type: isMysql ? 'longtext' : 'text' },
                        { name: 'occurredAt', type: 'timestamp' },
                        { name: 'dispatchedAt', type: 'timestamp', isNullable: true },
                        {
                            name: 'correlationId',
                            type: 'varchar',
                            length: '100',
                            isNullable: true,
                        },
                    ],
                }),
                true,
            );
        }

        const events = await queryRunner.getTable('domain_events');
        const has = (name: string) => events?.indices.some((index) => index.name === name) ?? false;
        const indexes: TableIndex[] = [
            new TableIndex({ name: 'uq_domain_events_id', columnNames: ['id'], isUnique: true }),
            new TableIndex({ name: 'uq_domain_events_seq', columnNames: ['seq'], isUnique: true }),
            new TableIndex({
                name: 'idx_domain_events_tenant_seq',
                columnNames: ['tenantId', 'seq'],
            }),
            new TableIndex({
                name: 'idx_domain_events_org_seq',
                columnNames: ['organizationId', 'seq'],
            }),
            new TableIndex({
                name: 'idx_domain_events_aggregate_seq',
                columnNames: ['aggregateType', 'aggregateId', 'seq'],
            }),
            new TableIndex({
                name: 'idx_domain_events_undispatched',
                columnNames: ['dispatchedAt', 'outboxSeq'],
                // TypeORM drops the predicate on MySQL, which has no partial indexes.
                where: isMysql
                    ? undefined
                    : `${queryRunner.connection.driver.escape('dispatchedAt')} IS NULL`,
            }),
        ];
        for (const index of indexes) {
            if (!has(index.name as string)) await queryRunner.createIndex('domain_events', index);
        }

        if (!(await queryRunner.hasTable('domain_event_relay_state'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'domain_event_relay_state',
                    columns: [
                        { name: 'id', type: 'varchar', length: '32', isPrimary: true },
                        { name: 'holder', type: 'varchar', length: '64', isNullable: true },
                        { name: 'leaseExpiresAt', type: 'timestamp', isNullable: true },
                        { name: 'lastSeq', type: 'bigint', default: 0 },
                        { name: 'retentionFloorSeq', type: 'bigint', default: 0 },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
        await queryRunner.manager
            .createQueryBuilder()
            .insert()
            .into('domain_event_relay_state')
            .values({ id: 'relay', lastSeq: 0, retentionFloorSeq: 0 })
            .orIgnore()
            .execute();

        if (!(await queryRunner.hasTable('plugin_event_cursors'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'plugin_event_cursors',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: uuidDefault,
                        },
                        { name: 'pluginId', type: 'varchar', length: '100' },
                        { name: 'tenantId', type: 'uuid' },
                        { name: 'lastSeq', type: 'bigint', default: 0 },
                        { name: 'consecutiveFailures', type: 'int', default: 0 },
                        { name: 'lastError', type: 'text', isNullable: true },
                        { name: 'lastErrorAt', type: 'timestamp', isNullable: true },
                        { name: 'deadLetterCount', type: 'int', default: 0 },
                        {
                            name: 'lastDeadLetterEventId',
                            type: 'varchar',
                            length: '32',
                            isNullable: true,
                        },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
        const cursors = await queryRunner.getTable('plugin_event_cursors');
        if (
            !cursors?.indices.some(
                (index) => index.name === 'uq_plugin_event_cursors_plugin_tenant',
            )
        ) {
            await queryRunner.createIndex(
                'plugin_event_cursors',
                new TableIndex({
                    name: 'uq_plugin_event_cursors_plugin_tenant',
                    columnNames: ['pluginId', 'tenantId'],
                    isUnique: true,
                }),
            );
        }

        for (const tableName of CreateDomainEventsOutbox1795052100000.VERSIONED_TABLES) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.findColumnByName('version')) {
                await queryRunner.addColumn(
                    tableName,
                    new TableColumn({
                        name: 'version',
                        type: 'int',
                        default: 1,
                        isNullable: false,
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of CreateDomainEventsOutbox1795052100000.VERSIONED_TABLES) {
            const table = await queryRunner.getTable(tableName);
            if (table?.findColumnByName('version')) {
                await queryRunner.dropColumn(tableName, 'version');
            }
        }
        for (const tableName of [
            'plugin_event_cursors',
            'domain_event_relay_state',
            'domain_events',
        ]) {
            if (await queryRunner.hasTable(tableName)) await queryRunner.dropTable(tableName, true);
        }
    }

    /** The P1 aggregates that carry a `version` (spec §4). */
    static readonly VERSIONED_TABLES: readonly string[] = [
        'tasks',
        'teams',
        'agents',
        'works',
        'organizations',
    ];
}
