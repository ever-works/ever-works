import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Agent Plugins MCP slice (docs/specs/features/agent-plugins plan §2.4/§2.5)
 * — the two tables behind manual MCP connections + per-agent bindings:
 *
 *   - mcp_server_connections    — workspace-global registry of external
 *                                 MCP servers (url + transport + encrypted
 *                                 auth headers). `source` is 'manual' in
 *                                 v1; 'package' is reserved for the
 *                                 agent-plugins package work (T1–T22).
 *   - agent_mcp_server_bindings — which agents get which connections:
 *                                 'tenant' rows inherit to every agent,
 *                                 'agent' rows override per agent
 *                                 (skill_bindings template).
 *
 * `authHeaders` is `text` (the entity's `simple-json` + encryption
 * transformer) — portable between SQLite (dev/CI) and Postgres (prod).
 * Values are AES-256-GCM envelope-encrypted at the application layer, so
 * the column never holds plaintext credentials when a key is configured.
 *
 * Idempotent: every createTable / createIndex gates on the matching
 * `has*` check (house pattern, mirrors 1779978012000-CreateSkillsTables).
 */
export class CreateMcpServerConnections1785100000000 implements MigrationInterface {
    name = 'CreateMcpServerConnections1785100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('mcp_server_connections'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'mcp_server_connections',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid', isNullable: false },
                        { name: 'name', type: 'varchar', length: '80', isNullable: false },
                        { name: 'url', type: 'varchar', length: '2048', isNullable: false },
                        {
                            name: 'transport',
                            type: 'varchar',
                            length: '16',
                            isNullable: false,
                            default: "'streamable-http'",
                        },
                        { name: 'authHeaders', type: 'text', isNullable: true },
                        { name: 'enabled', type: 'boolean', isNullable: false, default: true },
                        {
                            name: 'source',
                            type: 'varchar',
                            length: '16',
                            isNullable: false,
                            default: "'manual'",
                        },
                        { name: 'lastConnectedAt', type: 'timestamp', isNullable: true },
                        { name: 'lastError', type: 'text', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                        {
                            name: 'updatedAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                    foreignKeys: [
                        {
                            columnNames: ['userId'],
                            referencedTableName: 'users',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                    ],
                }),
                true,
            );
        }

        await this.ensureIndex(
            queryRunner,
            'mcp_server_connections',
            'uq_mcp_connection_user_name',
            ['userId', 'name'],
            true,
        );
        await this.ensureIndex(queryRunner, 'mcp_server_connections', 'idx_mcp_connection_user', [
            'userId',
        ]);

        if (!(await queryRunner.hasTable('agent_mcp_server_bindings'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'agent_mcp_server_bindings',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'connectionId', type: 'uuid', isNullable: false },
                        { name: 'targetType', type: 'varchar', length: '16', isNullable: false },
                        { name: 'targetId', type: 'uuid', isNullable: true },
                        { name: 'userId', type: 'uuid', isNullable: false },
                        { name: 'enabled', type: 'boolean', isNullable: false, default: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                    foreignKeys: [
                        {
                            columnNames: ['connectionId'],
                            referencedTableName: 'mcp_server_connections',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                        {
                            columnNames: ['userId'],
                            referencedTableName: 'users',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                    ],
                }),
                true,
            );
        }

        await this.ensureIndex(
            queryRunner,
            'agent_mcp_server_bindings',
            'uq_mcp_binding',
            ['connectionId', 'targetType', 'targetId'],
            true,
        );
        await this.ensureIndex(queryRunner, 'agent_mcp_server_bindings', 'idx_mcp_binding_target', [
            'targetType',
            'targetId',
        ]);
        await this.ensureIndex(queryRunner, 'agent_mcp_server_bindings', 'idx_mcp_binding_user', [
            'userId',
        ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of ['agent_mcp_server_bindings', 'mcp_server_connections']) {
            if (await queryRunner.hasTable(table)) {
                await queryRunner.dropTable(table);
            }
        }
    }

    private async ensureIndex(
        queryRunner: QueryRunner,
        tableName: string,
        indexName: string,
        columnNames: string[],
        isUnique = false,
    ): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        const exists = table?.indices.some((idx) => idx.name === indexName);
        if (!exists) {
            await queryRunner.createIndex(
                tableName,
                new TableIndex({ name: indexName, columnNames, isUnique }),
            );
        }
    }
}
