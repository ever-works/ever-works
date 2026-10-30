import { MigrationInterface, QueryRunner, Table, TableIndex, type TableColumnOptions } from 'typeorm';

/**
 * Ever Connect — the tables of an installation's connection to Ever Platform.
 *
 * - `ever_connect_connection`: ONE row (`id = 'self'`): the status, Ever
 *   Platform's id for the installation, the connect key id, the feed position.
 *   The connect key itself uses the reserved columns of `ever_instance`.
 * - `ever_connect_integration`: each integration as Ever Platform reported it
 *   (one row per link and key), with what it handed over, wrapped.
 * - `ever_connect_outbox`: reports owed to Ever Platform until delivered
 *   (`dedupeKey` unique; due rows found by state and time).
 * - `ever_connect_lease`: the compare-and-set row that makes one replica run
 *   the worker.
 * - `ever_connect_person_requests`: the answer to each deletion or export
 *   request for a person, one per platform job (`jobId` unique), so a request
 *   delivered again is answered from the row.
 *
 * Identifiers and machine codes only. Portable `Table` DDL (CI and e2e run
 * better-sqlite3, production Postgres); each step guarded so a partially
 * applied database converges. `down` drops the five tables.
 */
export class AddEverConnect1797300000000 implements MigrationInterface {
    name = 'AddEverConnect1797300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const uuidId: TableColumnOptions = {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: isPostgres ? 'uuid_generate_v4()' : undefined,
        };
        const stamps: TableColumnOptions[] = [
            { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
            { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ];

        await this.createTable(queryRunner, 'ever_connect_connection', [
            { name: 'id', type: 'varchar', length: '16', isPrimary: true },
            { name: 'status', type: 'varchar', length: '24', default: "'disconnected'" },
            { name: 'platformInstanceId', type: 'varchar', length: '64', isNullable: true },
            { name: 'kid', type: 'varchar', length: '64', isNullable: true },
            { name: 'connectedAt', type: 'timestamp', isNullable: true },
            { name: 'disconnectedAt', type: 'timestamp', isNullable: true },
            { name: 'lastFeedCursor', type: 'varchar', length: '128', isNullable: true },
            { name: 'envCodeConsumedHash', type: 'varchar', length: '64', isNullable: true },
            { name: 'lastError', type: 'varchar', length: '64', isNullable: true },
            ...stamps,
        ]);

        await this.createTable(queryRunner, 'ever_connect_integration', [
            uuidId,
            { name: 'linkId', type: 'varchar', length: '64', default: "''" },
            { name: 'integrationKey', type: 'varchar', length: '64' },
            { name: 'state', type: 'varchar', length: '32' },
            { name: 'enabled', type: 'boolean', default: false },
            { name: 'consentId', type: 'varchar', length: '64', isNullable: true },
            { name: 'scopeVersion', type: 'int', isNullable: true },
            { name: 'configEncrypted', type: 'text', isNullable: true },
            ...stamps,
        ]);
        await this.createIndex(
            queryRunner,
            'ever_connect_integration',
            new TableIndex({
                name: 'uq_ever_connect_integration_link_key',
                columnNames: ['linkId', 'integrationKey'],
                isUnique: true,
            }),
        );

        await this.createTable(queryRunner, 'ever_connect_outbox', [
            uuidId,
            { name: 'event', type: 'varchar', length: '64' },
            { name: 'payload', type: 'text' },
            { name: 'dedupeKey', type: 'varchar', length: '128' },
            { name: 'seq', type: 'bigint', default: 0 },
            { name: 'state', type: 'varchar', length: '16', default: "'pending'" },
            { name: 'attempts', type: 'int', default: 0 },
            { name: 'nextAttemptAt', type: 'timestamp' },
            { name: 'sentAt', type: 'timestamp', isNullable: true },
            { name: 'lastError', type: 'varchar', length: '64', isNullable: true },
            ...stamps,
        ]);
        await this.createIndex(
            queryRunner,
            'ever_connect_outbox',
            new TableIndex({
                name: 'uq_ever_connect_outbox_dedupe',
                columnNames: ['dedupeKey'],
                isUnique: true,
            }),
        );
        await this.createIndex(
            queryRunner,
            'ever_connect_outbox',
            new TableIndex({
                name: 'idx_ever_connect_outbox_due',
                columnNames: ['state', 'nextAttemptAt'],
            }),
        );

        await this.createTable(queryRunner, 'ever_connect_lease', [
            { name: 'id', type: 'varchar', length: '16', isPrimary: true },
            { name: 'holder', type: 'varchar', length: '64', isNullable: true },
            { name: 'expiresAt', type: 'timestamp', isNullable: true },
            { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ]);

        await this.createTable(queryRunner, 'ever_connect_person_requests', [
            uuidId,
            { name: 'jobId', type: 'varchar', length: '64' },
            { name: 'eventId', type: 'varchar', length: '64' },
            { name: 'kind', type: 'varchar', length: '16' },
            { name: 'result', type: 'varchar', length: '32' },
            { name: 'reasonCode', type: 'varchar', length: '64', isNullable: true },
            { name: 'legalBasis', type: 'varchar', length: '200', isNullable: true },
            { name: 'exportUrl', type: 'varchar', length: '2048', isNullable: true },
            { name: 'answeredAt', type: 'timestamp', isNullable: true },
            ...stamps,
        ]);
        await this.createIndex(
            queryRunner,
            'ever_connect_person_requests',
            new TableIndex({
                name: 'uq_ever_connect_person_requests_job',
                columnNames: ['jobId'],
                isUnique: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of [
            'ever_connect_person_requests',
            'ever_connect_lease',
            'ever_connect_outbox',
            'ever_connect_integration',
            'ever_connect_connection',
        ]) {
            if (await queryRunner.hasTable(table)) await queryRunner.dropTable(table, true);
        }
    }

    private async createTable(
        queryRunner: QueryRunner,
        name: string,
        columns: TableColumnOptions[],
    ): Promise<void> {
        if (await queryRunner.hasTable(name)) return;
        await queryRunner.createTable(new Table({ name, columns }), true);
    }

    private async createIndex(queryRunner: QueryRunner, table: string, index: TableIndex) {
        // Re-read: an index an earlier, interrupted run created must be seen first.
        const current = await queryRunner.getTable(table);
        if (current && !current.indices.some((existing) => existing.name === index.name)) {
            await queryRunner.createIndex(table, index);
        }
    }
}
