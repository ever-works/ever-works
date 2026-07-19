import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Agent Action Approval Queue — creates the `agent_action_proposals`
 * table backing the human-in-the-loop gate for side-effectful Agent
 * actions (spawn_agent / schedule_task / send_message / budget_override
 * / other). Each row lands PENDING and a human approves/rejects it; the
 * decision (who + when) is recorded on the same row.
 *
 * Tier A entity — carries nullable `tenantId` + `organizationId` FKs
 * (ON DELETE SET NULL), matching the convention in
 * `1779991006000-AddTenantIdAndOrganizationIdToTierA`.
 *
 * Column type choices follow `1779978010000-CreateAgentsTables`:
 *   - `text` for `simple-json` columns (`payload`, `riskFlags`) —
 *     portable across sqlite + postgres.
 *   - `'now()'` default for timestamps.
 *   - explicit `length` on every varchar.
 *
 * Idempotent: `createTable` gates on `hasTable`, every index on a name
 * lookup — safe to re-run on dev resets + CI.
 */
export class CreateAgentActionProposals1781700000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('agent_action_proposals'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'agent_action_proposals',
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
                        { name: 'agentId', type: 'uuid', isNullable: false },
                        { name: 'runId', type: 'uuid', isNullable: true },
                        { name: 'actionType', type: 'varchar', length: '32', isNullable: false },
                        { name: 'title', type: 'varchar', length: '200', isNullable: false },
                        // simple-json — text for dialect portability.
                        { name: 'payload', type: 'text', isNullable: false },
                        { name: 'riskFlags', type: 'text', isNullable: false },
                        {
                            name: 'status',
                            type: 'varchar',
                            length: '16',
                            isNullable: false,
                            default: "'pending'",
                        },
                        { name: 'decidedById', type: 'uuid', isNullable: true },
                        { name: 'decidedAt', type: 'timestamp', isNullable: true },
                        // Tier A scope FKs (nullable — see class docstring).
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
                            name: 'fk_agent_action_proposals_user',
                            columnNames: ['userId'],
                            referencedTableName: 'users',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                        {
                            name: 'fk_agent_action_proposals_agent',
                            columnNames: ['agentId'],
                            referencedTableName: 'agents',
                            referencedColumnNames: ['id'],
                            onDelete: 'CASCADE',
                        },
                        {
                            name: 'fk_agent_action_proposals_tenant',
                            columnNames: ['tenantId'],
                            referencedTableName: 'tenants',
                            referencedColumnNames: ['id'],
                            onDelete: 'SET NULL',
                        },
                        {
                            name: 'fk_agent_action_proposals_organization',
                            columnNames: ['organizationId'],
                            referencedTableName: 'organizations',
                            referencedColumnNames: ['id'],
                            onDelete: 'SET NULL',
                        },
                    ],
                }),
                true,
            );
        }

        await this.ensureIndex(
            queryRunner,
            'agent_action_proposals',
            'idx_agent_action_proposals_org_status',
            ['organizationId', 'status'],
        );
        await this.ensureIndex(
            queryRunner,
            'agent_action_proposals',
            'idx_agent_action_proposals_agent',
            ['agentId'],
        );
        await this.ensureIndex(
            queryRunner,
            'agent_action_proposals',
            'idx_agent_action_proposals_user_status',
            ['userId', 'status'],
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('agent_action_proposals')) {
            await queryRunner.dropTable('agent_action_proposals');
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
