import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Integration API v1 foundation (EW-P1-4, integration contract v1 B.1 / B.6 —
 * `docs/specs/features/integrations-api-v1/spec.md`).
 *
 * 1. `external_record_links` — one Ever Works record ↔ one external record,
 *    org-scoped and unique on both sides per
 *    `(organizationId, source, installationKey, entityType)`. `installationKey`
 *    is `''` when there is no installation, so two rows without one still
 *    collide (NULLs never match in a unique index).
 * 2. `integration_idempotency_keys` — the 24 h `Idempotency-Key` response
 *    store, unique per `(integrationKeyId, idempotencyKey)`. `responseBody` is
 *    `longtext` on MySQL (a task DTO can exceed `text`'s 64 KiB). `expiresAt`
 *    is epoch milliseconds (`TimestampColumn`).
 *
 * Additive and idempotent: every step is guarded. `down` drops both tables;
 * nothing else references them.
 */
export class CreateIntegrationApiFoundation1795080200000 implements MigrationInterface {
    name = 'CreateIntegrationApiFoundation1795080200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const driver = String(queryRunner.connection.options.type);
        const isMysql = driver === 'mysql' || driver === 'mariadb';
        const isPostgres = driver === 'postgres';
        const uuidDefault = isPostgres ? 'uuid_generate_v4()' : undefined;

        if (!(await queryRunner.hasTable('external_record_links'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'external_record_links',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: uuidDefault,
                        },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid' },
                        { name: 'entityType', type: 'varchar', length: '32' },
                        { name: 'entityId', type: 'varchar', length: '64' },
                        { name: 'source', type: 'varchar', length: '100' },
                        { name: 'installationKey', type: 'varchar', length: '200', default: "''" },
                        { name: 'externalId', type: 'varchar', length: '200' },
                        { name: 'externalUrl', type: 'varchar', length: '2048', isNullable: true },
                        { name: 'integrationKeyId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }
        await this.ensureIndex(
            queryRunner,
            'external_record_links',
            new TableIndex({
                name: 'uq_external_record_links_external',
                columnNames: [
                    'organizationId',
                    'source',
                    'installationKey',
                    'entityType',
                    'externalId',
                ],
                isUnique: true,
            }),
        );
        await this.ensureIndex(
            queryRunner,
            'external_record_links',
            new TableIndex({
                name: 'uq_external_record_links_entity',
                columnNames: [
                    'organizationId',
                    'source',
                    'installationKey',
                    'entityType',
                    'entityId',
                ],
                isUnique: true,
            }),
        );
        await this.ensureIndex(
            queryRunner,
            'external_record_links',
            new TableIndex({
                name: 'idx_external_record_links_entity',
                columnNames: ['entityType', 'entityId'],
            }),
        );

        if (!(await queryRunner.hasTable('integration_idempotency_keys'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'integration_idempotency_keys',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: uuidDefault,
                        },
                        { name: 'integrationKeyId', type: 'uuid' },
                        { name: 'idempotencyKey', type: 'varchar', length: '128' },
                        { name: 'requestHash', type: 'varchar', length: '64' },
                        { name: 'state', type: 'varchar', length: '16', default: "'in_progress'" },
                        { name: 'responseStatus', type: 'int', isNullable: true },
                        {
                            name: 'responseBody',
                            type: isMysql ? 'longtext' : 'text',
                            isNullable: true,
                        },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'expiresAt', type: 'bigint' },
                    ],
                }),
                true,
            );
        }
        await this.ensureIndex(
            queryRunner,
            'integration_idempotency_keys',
            new TableIndex({
                name: 'uq_integration_idempotency_key',
                columnNames: ['integrationKeyId', 'idempotencyKey'],
                isUnique: true,
            }),
        );
        await this.ensureIndex(
            queryRunner,
            'integration_idempotency_keys',
            new TableIndex({
                name: 'idx_integration_idempotency_expires',
                columnNames: ['expiresAt'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('integration_idempotency_keys')) {
            await queryRunner.dropTable('integration_idempotency_keys', true, true, true);
        }
        if (await queryRunner.hasTable('external_record_links')) {
            await queryRunner.dropTable('external_record_links', true, true, true);
        }
    }

    private async ensureIndex(
        queryRunner: QueryRunner,
        tableName: string,
        index: TableIndex,
    ): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        if (table && !table.indices.some((existing) => existing.name === index.name)) {
            await queryRunner.createIndex(tableName, index);
        }
    }
}
