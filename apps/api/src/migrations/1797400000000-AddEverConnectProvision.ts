import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableIndex,
    type TableColumnOptions,
} from 'typeorm';

/**
 * Ever Connect — creating a company a person asked for in Ever. Four new, empty
 * tables; no change to an existing one:
 *
 * - `ever_connect_provision_intents`: the signed requests received, by `jti`
 *   (what was verified, never the signed document), removed once they ended.
 * - `ever_connect_provision_records`: one row per creation, by the key of Ever
 *   Platform's step: the ids made so far and the report to Ever Platform.
 * - `ever_connect_links`: an Organization's link to its Ever organization (one
 *   active link per tenant and per Ever organization).
 * - `organization_company_imports`: a company template imported into an existing
 *   Organization, once per key.
 *
 * Portable `Table` DDL (CI and e2e run better-sqlite3, production Postgres); each
 * step guarded so a partially applied database converges. `down` drops the four.
 */
export class AddEverConnectProvision1797400000000 implements MigrationInterface {
    name = 'AddEverConnectProvision1797400000000';

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

        await this.createTable(queryRunner, 'ever_connect_provision_intents', [
            { name: 'jti', type: 'varchar', length: '64', isPrimary: true },
            { name: 'idempotencyKey', type: 'varchar', length: '200' },
            { name: 'claims', type: 'text' },
            { name: 'status', type: 'varchar', length: '16', default: "'pending'" },
            { name: 'expiresAt', type: 'timestamp' },
            ...stamps,
        ]);
        await this.createIndex(
            queryRunner,
            'ever_connect_provision_intents',
            new TableIndex({
                name: 'idx_ever_connect_provision_intents_key',
                columnNames: ['idempotencyKey'],
            }),
        );
        await this.createIndex(
            queryRunner,
            'ever_connect_provision_intents',
            new TableIndex({
                name: 'idx_ever_connect_provision_intents_expires',
                columnNames: ['expiresAt'],
            }),
        );

        await this.createTable(queryRunner, 'ever_connect_provision_records', [
            uuidId,
            { name: 'creationKey', type: 'varchar', length: '200' },
            { name: 'intentJti', type: 'varchar', length: '64' },
            { name: 'intentIssuedAt', type: 'int', default: 0 },
            { name: 'idempotencyKey', type: 'varchar', length: '128', isNullable: true },
            { name: 'bodyHash', type: 'varchar', length: '64', isNullable: true },
            { name: 'everOrgId', type: 'varchar', length: '64' },
            { name: 'everOrgKey', type: 'varchar', length: '64', isNullable: true },
            { name: 'handle', type: 'varchar', length: '64' },
            { name: 'userId', type: 'uuid', isNullable: true },
            { name: 'tenantId', type: 'uuid', isNullable: true },
            { name: 'organizationId', type: 'uuid', isNullable: true },
            { name: 'organizationSlug', type: 'varchar', length: '64', isNullable: true },
            { name: 'companyWorkId', type: 'uuid', isNullable: true },
            { name: 'missionId', type: 'uuid', isNullable: true },
            { name: 'steps', type: 'text' },
            { name: 'status', type: 'varchar', length: '16', default: "'pending'" },
            { name: 'errorCode', type: 'varchar', length: '64', isNullable: true },
            { name: 'claimedBy', type: 'varchar', length: '36', isNullable: true },
            { name: 'claimedUntil', type: 'timestamp', isNullable: true },
            { name: 'callbackStatus', type: 'varchar', length: '16', isNullable: true },
            { name: 'callbackAttempts', type: 'int', default: 0 },
            { name: 'nextCallbackAt', type: 'timestamp', isNullable: true },
            { name: 'callbackError', type: 'varchar', length: '64', isNullable: true },
            { name: 'completedAt', type: 'timestamp', isNullable: true },
            { name: 'platformLinkId', type: 'varchar', length: '64', isNullable: true },
            ...stamps,
        ]);
        for (const [name, column] of [
            ['uq_ever_connect_provision_records_key', 'creationKey'],
            ['uq_ever_connect_provision_records_jti', 'intentJti'],
            ['uq_ever_connect_provision_records_org', 'everOrgKey'],
        ] as const) {
            await this.createIndex(
                queryRunner,
                'ever_connect_provision_records',
                new TableIndex({ name, columnNames: [column], isUnique: true }),
            );
        }
        await this.createIndex(
            queryRunner,
            'ever_connect_provision_records',
            new TableIndex({
                name: 'idx_ever_connect_provision_records_callback',
                columnNames: ['callbackStatus', 'nextCallbackAt'],
            }),
        );

        await this.createTable(queryRunner, 'ever_connect_links', [
            uuidId,
            { name: 'organizationId', type: 'uuid' },
            { name: 'tenantId', type: 'uuid' },
            { name: 'everOrgId', type: 'varchar', length: '64' },
            { name: 'handle', type: 'varchar', length: '64' },
            { name: 'platformLinkId', type: 'varchar', length: '64', isNullable: true },
            { name: 'createdVia', type: 'varchar', length: '16' },
            { name: 'status', type: 'varchar', length: '16', default: "'active'" },
            ...stamps,
        ]);
        await this.createIndex(
            queryRunner,
            'ever_connect_links',
            new TableIndex({
                name: 'uq_ever_connect_links_organization',
                columnNames: ['organizationId'],
                isUnique: true,
            }),
        );
        for (const [name, column] of [
            ['uq_ever_connect_links_tenant_active', 'tenantId'],
            ['uq_ever_connect_links_ever_org_active', 'everOrgId'],
        ] as const) {
            await this.createIndex(
                queryRunner,
                'ever_connect_links',
                new TableIndex({
                    name,
                    columnNames: [column],
                    isUnique: true,
                    where: `"status" = 'active'`,
                }),
            );
        }

        await this.createTable(queryRunner, 'organization_company_imports', [
            uuidId,
            { name: 'organizationId', type: 'uuid' },
            { name: 'importKey', type: 'varchar', length: '200' },
            { name: 'templateSlug', type: 'varchar', length: '128' },
            { name: 'status', type: 'varchar', length: '16' },
            { name: 'reportJson', type: 'text', isNullable: true },
            ...stamps,
        ]);
        await this.createIndex(
            queryRunner,
            'organization_company_imports',
            new TableIndex({
                name: 'uq_organization_company_imports_key',
                columnNames: ['organizationId', 'importKey'],
                isUnique: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of [
            'organization_company_imports',
            'ever_connect_links',
            'ever_connect_provision_records',
            'ever_connect_provision_intents',
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
