import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Model accounts (AW-16, phase 1) — the `model_accounts` and `model_policies`
 * tables.
 *
 * Entities:
 *   `packages/agent/src/entities/model-account.entity.ts`
 *   `packages/agent/src/entities/model-policy.entity.ts`
 *
 * ## `model_accounts`
 *
 * One row per set of credentials for one AI-provider plugin in one workspace.
 * `position` is the order accounts are used in; it is kept contiguous by the
 * service, not by an index, so a reorder can swap two rows without a deferred
 * constraint. `(workspaceKey, providerPluginId, label)` is UNIQUE — an owner
 * cannot have two accounts with the same name on one provider.
 * `credentials` is a text column holding the envelope-encrypted JSON the
 * entity's transformer writes.
 *
 * ## `model_policies`
 *
 * One row per scope (`workspace`, `agent:<id>`, `schedule:<source>:<owner>`)
 * per workspace, UNIQUE on `(workspaceKey, scopeKey)`. Every routing column is
 * nullable: NULL is "inherit", which is how a narrower scope sets one field
 * and keeps the rest.
 *
 * Neither key column is nullable, so both unique indexes hold on Postgres and
 * SQLite alike (both treat NULLs as distinct inside a unique index).
 *
 * No backfill: a workspace with no rows resolves models and credentials
 * exactly as it did before this migration.
 *
 * FKs, the same on both tables — a row's lifetime follows the WORKSPACE, never
 * the person who happened to write it:
 *   - `ownerUserId` → `users` CASCADE. Set only for a personal workspace, so
 *     deleting a person deletes their personal accounts and policies.
 *   - `organizationId` → `organizations` CASCADE. An organization's accounts
 *     and policies go with the organization.
 *   - `userId` → `users` SET NULL. The creator (accounts) or last writer
 *     (policies) is a record, not an owner: deleting a member must never
 *     delete credentials or routing the rest of the organization relies on.
 *
 * Forward-only + idempotent (`hasTable` / index-name / FK-name guards),
 * portable `Table` DDL because production runs Postgres while CI runs
 * better-sqlite3. `down()` drops exactly what `up()` added, in reverse.
 */
export class CreateModelAccountsAndPolicies1791160000000 implements MigrationInterface {
    name = 'CreateModelAccountsAndPolicies1791160000000';

    private static readonly ACCOUNT_INDEXES = [
        new TableIndex({
            name: 'uq_model_accounts_workspace_provider_label',
            columnNames: ['workspaceKey', 'providerPluginId', 'label'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'idx_model_accounts_workspace_provider_position',
            columnNames: ['workspaceKey', 'providerPluginId', 'position'],
        }),
        new TableIndex({
            name: 'idx_model_accounts_checked',
            columnNames: ['enabled', 'lastCheckedAt'],
        }),
    ];

    private static readonly POLICY_INDEXES = [
        new TableIndex({
            name: 'uq_model_policies_workspace_scope',
            columnNames: ['workspaceKey', 'scopeKey'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'idx_model_policies_scope',
            columnNames: ['scopeType', 'scopeId'],
        }),
    ];

    private static readonly ACCOUNT_FKS = [
        new TableForeignKey({
            name: 'fk_model_accounts_user',
            columnNames: ['userId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
        }),
        new TableForeignKey({
            name: 'fk_model_accounts_owner_user',
            columnNames: ['ownerUserId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_model_accounts_organization',
            columnNames: ['organizationId'],
            referencedTableName: 'organizations',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
    ];

    private static readonly POLICY_FKS = [
        new TableForeignKey({
            name: 'fk_model_policies_user',
            columnNames: ['userId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
        }),
        new TableForeignKey({
            name: 'fk_model_policies_owner_user',
            columnNames: ['ownerUserId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_model_policies_organization',
            columnNames: ['organizationId'],
            referencedTableName: 'organizations',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('model_accounts'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'model_accounts',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'userId', type: 'uuid', isNullable: true },
                        { name: 'ownerUserId', type: 'uuid', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'workspaceKey', type: 'varchar', length: '80' },
                        { name: 'providerPluginId', type: 'varchar', length: '128' },
                        { name: 'label', type: 'varchar', length: '60' },
                        { name: 'position', type: 'int' },
                        { name: 'health', type: 'varchar', length: '16', default: "'unknown'" },
                        { name: 'enabled', type: 'boolean', default: true },
                        { name: 'credentials', type: 'text', isNullable: true },
                        { name: 'credentialVersion', type: 'int', default: 1 },
                        { name: 'credentialExpiresAt', type: 'timestamp', isNullable: true },
                        { name: 'lastCheckedAt', type: 'timestamp', isNullable: true },
                        { name: 'lastUsedAt', type: 'timestamp', isNullable: true },
                        {
                            name: 'cooldownReason',
                            type: 'varchar',
                            length: '24',
                            isNullable: true,
                        },
                        { name: 'cooldownUntil', type: 'timestamp', isNullable: true },
                        { name: 'consecutiveFailures', type: 'int', default: 0 },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        if (!(await queryRunner.hasTable('model_policies'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'model_policies',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'userId', type: 'uuid', isNullable: true },
                        { name: 'ownerUserId', type: 'uuid', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'workspaceKey', type: 'varchar', length: '80' },
                        { name: 'scopeKey', type: 'varchar', length: '128' },
                        { name: 'scopeType', type: 'varchar', length: '16' },
                        { name: 'scopeId', type: 'varchar', length: '64', isNullable: true },
                        { name: 'scopeVariant', type: 'varchar', length: '32', isNullable: true },
                        { name: 'primaryModel', type: 'text', isNullable: true },
                        { name: 'fallbackModels', type: 'text', isNullable: true },
                        { name: 'reasoningEffort', type: 'varchar', length: '8', isNullable: true },
                        { name: 'runTimeoutSeconds', type: 'int', isNullable: true },
                        { name: 'attemptTimeoutSeconds', type: 'int', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        await this.ensureIndexes(
            queryRunner,
            'model_accounts',
            CreateModelAccountsAndPolicies1791160000000.ACCOUNT_INDEXES,
        );
        await this.ensureIndexes(
            queryRunner,
            'model_policies',
            CreateModelAccountsAndPolicies1791160000000.POLICY_INDEXES,
        );
        await this.ensureForeignKeys(
            queryRunner,
            'model_accounts',
            CreateModelAccountsAndPolicies1791160000000.ACCOUNT_FKS,
        );
        await this.ensureForeignKeys(
            queryRunner,
            'model_policies',
            CreateModelAccountsAndPolicies1791160000000.POLICY_FKS,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('model_policies')) {
            await queryRunner.dropTable('model_policies', true, true, true);
        }
        if (await queryRunner.hasTable('model_accounts')) {
            await queryRunner.dropTable('model_accounts', true, true, true);
        }
    }

    private async ensureIndexes(
        queryRunner: QueryRunner,
        tableName: string,
        indexes: readonly TableIndex[],
    ): Promise<void> {
        for (const index of indexes) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(tableName, index);
            }
        }
    }

    private async ensureForeignKeys(
        queryRunner: QueryRunner,
        tableName: string,
        foreignKeys: readonly TableForeignKey[],
    ): Promise<void> {
        for (const foreignKey of foreignKeys) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
                await queryRunner.createForeignKey(tableName, foreignKey);
            }
        }
    }
}
