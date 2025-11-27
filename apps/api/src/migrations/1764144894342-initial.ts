import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from 'typeorm';

export class Initial1764144894342 implements MigrationInterface {
    name = 'Initial1764144894342';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Create cache_entries table
        if (!(await queryRunner.hasTable('cache_entries'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'cache_entries',
                    columns: [
                        { name: 'key', type: 'varchar', isPrimary: true },
                        { name: 'value', type: 'text', isNullable: false },
                        { name: 'expiresAt', type: 'bigint', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'cache_entries',
                new TableIndex({ name: 'IDX_cache_entries_expiresAt', columnNames: ['expiresAt'] }),
            );
        }

        // 2. Create subscription_plans table (no foreign keys, needed by users)
        if (!(await queryRunner.hasTable('subscription_plans'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'subscription_plans',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'code', type: 'varchar', isUnique: true, isNullable: false },
                        { name: 'displayName', type: 'varchar', isNullable: false },
                        { name: 'maxDirectories', type: 'int', default: 1 },
                        { name: 'allowedCadences', type: 'text', isNullable: false },
                        {
                            name: 'monthlyPrice',
                            type: 'decimal',
                            precision: 10,
                            scale: 2,
                            default: 0,
                        },
                        {
                            name: 'overagePricePerRun',
                            type: 'decimal',
                            precision: 10,
                            scale: 2,
                            default: 0,
                        },
                        { name: 'currency', type: 'varchar', default: "'usd'" },
                        { name: 'active', type: 'boolean', default: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'subscription_plans',
                new TableIndex({
                    name: 'IDX_subscription_plans_code',
                    columnNames: ['code'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'subscription_plans',
                new TableIndex({ name: 'IDX_subscription_plans_active', columnNames: ['active'] }),
            );
        }

        // 3. Create users table
        if (!(await queryRunner.hasTable('users'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'users',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'username', type: 'varchar', isNullable: false },
                        { name: 'email', type: 'varchar', isUnique: true, isNullable: false },
                        { name: 'password', type: 'varchar', isNullable: false },
                        { name: 'registrationProvider', type: 'varchar', default: "'local'" },
                        { name: 'avatar', type: 'varchar', isNullable: true },
                        { name: 'emailVerified', type: 'boolean', default: false },
                        { name: 'emailVerificationToken', type: 'varchar', isNullable: true },
                        { name: 'emailVerificationExpires', type: 'timestamp', isNullable: true },
                        { name: 'vercelToken', type: 'varchar', isNullable: true },
                        { name: 'isActive', type: 'boolean', default: true },
                        { name: 'lastLoginAt', type: 'timestamp', isNullable: true },
                        { name: 'lastLoginIp', type: 'varchar', isNullable: true },
                        { name: 'passwordResetToken', type: 'varchar', isNullable: true },
                        { name: 'passwordResetExpires', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'defaultPlanId', type: 'varchar', isNullable: true },
                    ],
                }),
                true,
            );
            await queryRunner.createForeignKey(
                'users',
                new TableForeignKey({
                    name: 'FK_users_defaultPlanId',
                    columnNames: ['defaultPlanId'],
                    referencedTableName: 'subscription_plans',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }

        // 4. Create oauth_tokens table
        if (!(await queryRunner.hasTable('oauth_tokens'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'oauth_tokens',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'userId', type: 'varchar', isNullable: false },
                        { name: 'provider', type: 'varchar', isNullable: false },
                        { name: 'accessToken', type: 'text', isNullable: false },
                        { name: 'refreshToken', type: 'text', isNullable: true },
                        { name: 'username', type: 'varchar', isNullable: true },
                        { name: 'email', type: 'varchar', isNullable: true },
                        { name: 'tokenType', type: 'varchar', isNullable: true },
                        { name: 'scope', type: 'varchar', isNullable: true },
                        { name: 'expiresAt', type: 'timestamp', isNullable: true },
                        { name: 'metadata', type: 'json', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createForeignKey(
                'oauth_tokens',
                new TableForeignKey({
                    name: 'FK_oauth_tokens_userId',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        // 5. Create refresh_tokens table
        if (!(await queryRunner.hasTable('refresh_tokens'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'refresh_tokens',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'token', type: 'varchar', isUnique: true, isNullable: false },
                        { name: 'userId', type: 'varchar', isNullable: false },
                        { name: 'expiresAt', type: 'timestamp', isNullable: false },
                        { name: 'family', type: 'varchar', isNullable: true },
                        { name: 'revoked', type: 'boolean', default: false },
                        { name: 'revokedAt', type: 'timestamp', isNullable: true },
                        { name: 'revokedReason', type: 'varchar', isNullable: true },
                        { name: 'userAgent', type: 'varchar', isNullable: true },
                        { name: 'ipAddress', type: 'varchar', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'refresh_tokens',
                new TableIndex({
                    name: 'IDX_refresh_tokens_token',
                    columnNames: ['token'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'refresh_tokens',
                new TableIndex({
                    name: 'IDX_refresh_tokens_expiresAt',
                    columnNames: ['expiresAt'],
                }),
            );
            await queryRunner.createForeignKey(
                'refresh_tokens',
                new TableForeignKey({
                    name: 'FK_refresh_tokens_userId',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        // 6. Create directories table
        if (!(await queryRunner.hasTable('directories'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'directories',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'name', type: 'varchar', isNullable: false },
                        { name: 'slug', type: 'varchar', isNullable: false },
                        { name: 'userId', type: 'varchar', isNullable: false },
                        { name: 'owner', type: 'varchar', isNullable: true },
                        { name: 'repoProvider', type: 'varchar', default: "'github'" },
                        { name: 'website', type: 'varchar', isNullable: true },
                        { name: 'companyName', type: 'varchar', isNullable: true },
                        { name: 'organization', type: 'boolean', default: false },
                        { name: 'description', type: 'varchar', isNullable: false },
                        { name: 'readmeConfig', type: 'text', isNullable: true },
                        { name: 'generateStatus', type: 'text', isNullable: true },
                        { name: 'generationStartedAt', type: 'bigint', isNullable: true },
                        { name: 'generationProgressedAt', type: 'bigint', isNullable: true },
                        { name: 'generationFinishedAt', type: 'bigint', isNullable: true },
                        { name: 'scheduledUpdatesEnabled', type: 'boolean', default: false },
                        { name: 'scheduledCadence', type: 'varchar', isNullable: true },
                        { name: 'scheduledNextRunAt', type: 'bigint', isNullable: true },
                        { name: 'scheduledStatus', type: 'varchar', isNullable: true },
                        { name: 'deploymentState', type: 'varchar', isNullable: true },
                        { name: 'deploymentStartedAt', type: 'bigint', isNullable: true },
                        { name: 'lastPullRequest', type: 'text', isNullable: true },
                        { name: 'itemsCount', type: 'int', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createForeignKey(
                'directories',
                new TableForeignKey({
                    name: 'FK_directories_userId',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        // 7. Create directory_schedules table
        if (!(await queryRunner.hasTable('directory_schedules'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'directory_schedules',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'directoryId', type: 'varchar', isUnique: true, isNullable: false },
                        { name: 'userId', type: 'varchar', isNullable: false },
                        { name: 'cadence', type: 'varchar', isNullable: true },
                        { name: 'status', type: 'varchar', default: "'disabled'" },
                        { name: 'billingMode', type: 'varchar', default: "'subscription'" },
                        { name: 'nextRunAt', type: 'bigint', isNullable: true },
                        { name: 'lastRunAt', type: 'bigint', isNullable: true },
                        { name: 'lastRunStatus', type: 'varchar', isNullable: true },
                        { name: 'failureCount', type: 'int', default: 0 },
                        { name: 'maxFailureBeforePause', type: 'int', default: 3 },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'directory_schedules',
                new TableIndex({
                    name: 'IDX_directory_schedules_directoryId',
                    columnNames: ['directoryId'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'directory_schedules',
                new TableIndex({
                    name: 'IDX_directory_schedules_userId_status',
                    columnNames: ['userId', 'status'],
                }),
            );
            await queryRunner.createIndex(
                'directory_schedules',
                new TableIndex({
                    name: 'IDX_directory_schedules_status_nextRunAt',
                    columnNames: ['status', 'nextRunAt'],
                }),
            );
            await queryRunner.createForeignKey(
                'directory_schedules',
                new TableForeignKey({
                    name: 'FK_directory_schedules_directoryId',
                    columnNames: ['directoryId'],
                    referencedTableName: 'directories',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'directory_schedules',
                new TableForeignKey({
                    name: 'FK_directory_schedules_userId',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        // 8. Create directory_generation_history table
        if (!(await queryRunner.hasTable('directory_generation_history'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'directory_generation_history',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'directoryId', type: 'varchar', isNullable: false },
                        { name: 'userId', type: 'varchar', isNullable: true },
                        { name: 'generationMethod', type: 'varchar', isNullable: true },
                        { name: 'status', type: 'varchar', default: "'generating'" },
                        { name: 'parameters', type: 'json', isNullable: true },
                        { name: 'metrics', type: 'json', isNullable: true },
                        { name: 'triggeredBy', type: 'varchar', default: "'user'" },
                        { name: 'scheduleId', type: 'varchar', isNullable: true },
                        { name: 'newItemsCount', type: 'int', default: 0 },
                        { name: 'updatedItemsCount', type: 'int', default: 0 },
                        { name: 'totalItemsCount', type: 'int', default: 0 },
                        { name: 'startedAt', type: 'bigint', isNullable: true },
                        { name: 'finishedAt', type: 'bigint', isNullable: true },
                        { name: 'durationInSeconds', type: 'int', isNullable: true },
                        { name: 'errorMessage', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'directory_generation_history',
                new TableIndex({
                    name: 'IDX_directory_generation_history_directoryId_status',
                    columnNames: ['directoryId', 'status'],
                }),
            );
            await queryRunner.createIndex(
                'directory_generation_history',
                new TableIndex({
                    name: 'IDX_directory_generation_history_triggeredBy',
                    columnNames: ['triggeredBy'],
                }),
            );
            await queryRunner.createIndex(
                'directory_generation_history',
                new TableIndex({
                    name: 'IDX_directory_generation_history_scheduleId',
                    columnNames: ['scheduleId'],
                }),
            );
            await queryRunner.createForeignKey(
                'directory_generation_history',
                new TableForeignKey({
                    name: 'FK_directory_generation_history_directoryId',
                    columnNames: ['directoryId'],
                    referencedTableName: 'directories',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'directory_generation_history',
                new TableForeignKey({
                    name: 'FK_directory_generation_history_userId',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
            await queryRunner.createForeignKey(
                'directory_generation_history',
                new TableForeignKey({
                    name: 'FK_directory_generation_history_scheduleId',
                    columnNames: ['scheduleId'],
                    referencedTableName: 'directory_schedules',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }

        // 9. Create user_subscriptions table
        if (!(await queryRunner.hasTable('user_subscriptions'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'user_subscriptions',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'userId', type: 'varchar', isNullable: false },
                        { name: 'planCode', type: 'varchar', isNullable: false },
                        { name: 'planId', type: 'varchar', isNullable: true },
                        { name: 'status', type: 'varchar', default: "'active'" },
                        { name: 'billingProvider', type: 'varchar', default: "'stripe'" },
                        { name: 'currentPeriodEnd', type: 'bigint', isNullable: false },
                        { name: 'cancelAtPeriodEnd', type: 'boolean', default: false },
                        { name: 'paymentMethodMeta', type: 'json', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'user_subscriptions',
                new TableIndex({
                    name: 'IDX_user_subscriptions_userId_status',
                    columnNames: ['userId', 'status'],
                }),
            );
            await queryRunner.createIndex(
                'user_subscriptions',
                new TableIndex({
                    name: 'IDX_user_subscriptions_planCode',
                    columnNames: ['planCode'],
                }),
            );
            await queryRunner.createForeignKey(
                'user_subscriptions',
                new TableForeignKey({
                    name: 'FK_user_subscriptions_userId',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'user_subscriptions',
                new TableForeignKey({
                    name: 'FK_user_subscriptions_planId',
                    columnNames: ['planId'],
                    referencedTableName: 'subscription_plans',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }

        // 10. Create usage_ledger_entries table
        if (!(await queryRunner.hasTable('usage_ledger_entries'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'usage_ledger_entries',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'userId', type: 'varchar', isNullable: false },
                        { name: 'directoryId', type: 'varchar', isNullable: false },
                        { name: 'scheduleId', type: 'varchar', isNullable: true },
                        { name: 'triggerType', type: 'varchar', default: "'manual'" },
                        { name: 'billingMode', type: 'varchar', default: "'usage'" },
                        { name: 'units', type: 'int', default: 1 },
                        { name: 'amountCents', type: 'int', default: 0 },
                        { name: 'currency', type: 'varchar', default: "'usd'" },
                        { name: 'status', type: 'varchar', default: "'pending'" },
                        { name: 'generationHistoryId', type: 'varchar', isNullable: true },
                        { name: 'metadata', type: 'json', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'usage_ledger_entries',
                new TableIndex({
                    name: 'IDX_usage_ledger_entries_userId_status',
                    columnNames: ['userId', 'status'],
                }),
            );
            await queryRunner.createIndex(
                'usage_ledger_entries',
                new TableIndex({
                    name: 'IDX_usage_ledger_entries_directoryId',
                    columnNames: ['directoryId'],
                }),
            );
            await queryRunner.createIndex(
                'usage_ledger_entries',
                new TableIndex({
                    name: 'IDX_usage_ledger_entries_createdAt',
                    columnNames: ['createdAt'],
                }),
            );
            await queryRunner.createIndex(
                'usage_ledger_entries',
                new TableIndex({
                    name: 'IDX_usage_ledger_entries_scheduleId',
                    columnNames: ['scheduleId'],
                }),
            );
            await queryRunner.createForeignKey(
                'usage_ledger_entries',
                new TableForeignKey({
                    name: 'FK_usage_ledger_entries_userId',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'usage_ledger_entries',
                new TableForeignKey({
                    name: 'FK_usage_ledger_entries_directoryId',
                    columnNames: ['directoryId'],
                    referencedTableName: 'directories',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'usage_ledger_entries',
                new TableForeignKey({
                    name: 'FK_usage_ledger_entries_scheduleId',
                    columnNames: ['scheduleId'],
                    referencedTableName: 'directory_schedules',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
            await queryRunner.createForeignKey(
                'usage_ledger_entries',
                new TableForeignKey({
                    name: 'FK_usage_ledger_entries_generationHistoryId',
                    columnNames: ['generationHistoryId'],
                    referencedTableName: 'directory_generation_history',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }

        // 11. Create chat_histories table
        if (!(await queryRunner.hasTable('chat_histories'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'chat_histories',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'sessionId', type: 'varchar', isUnique: true, isNullable: false },
                        { name: 'userId', type: 'varchar', isNullable: true },
                        { name: 'title', type: 'varchar', isNullable: true },
                        { name: 'metadata', type: 'json', isNullable: true },
                        { name: 'isActive', type: 'boolean', default: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'chat_histories',
                new TableIndex({
                    name: 'IDX_chat_histories_sessionId_userId',
                    columnNames: ['sessionId', 'userId'],
                }),
            );
            await queryRunner.createForeignKey(
                'chat_histories',
                new TableForeignKey({
                    name: 'FK_chat_histories_userId',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        // 12. Create chat_messages table
        if (!(await queryRunner.hasTable('chat_messages'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'chat_messages',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'chatHistoryId', type: 'varchar', isNullable: false },
                        { name: 'role', type: 'varchar', isNullable: false },
                        { name: 'content', type: 'text', isNullable: false },
                        { name: 'name', type: 'varchar', isNullable: true },
                        { name: 'additionalKwargs', type: 'json', isNullable: true },
                        { name: 'functionCall', type: 'json', isNullable: true },
                        { name: 'toolCalls', type: 'json', isNullable: true },
                        { name: 'metadata', type: 'json', isNullable: true },
                        { name: 'orderIndex', type: 'int', default: 0 },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'chat_messages',
                new TableIndex({
                    name: 'IDX_chat_messages_chatHistoryId_createdAt',
                    columnNames: ['chatHistoryId', 'createdAt'],
                }),
            );
            await queryRunner.createForeignKey(
                'chat_messages',
                new TableForeignKey({
                    name: 'FK_chat_messages_chatHistoryId',
                    columnNames: ['chatHistoryId'],
                    referencedTableName: 'chat_histories',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop tables in reverse order (respecting foreign key dependencies)
        await queryRunner.dropTable('chat_messages', true, true, true);
        await queryRunner.dropTable('chat_histories', true, true, true);
        await queryRunner.dropTable('usage_ledger_entries', true, true, true);
        await queryRunner.dropTable('user_subscriptions', true, true, true);
        await queryRunner.dropTable('directory_generation_history', true, true, true);
        await queryRunner.dropTable('directory_schedules', true, true, true);
        await queryRunner.dropTable('directories', true, true, true);
        await queryRunner.dropTable('refresh_tokens', true, true, true);
        await queryRunner.dropTable('oauth_tokens', true, true, true);
        await queryRunner.dropTable('users', true, true, true);
        await queryRunner.dropTable('subscription_plans', true, true, true);
        await queryRunner.dropTable('cache_entries', true, true, true);
    }
}
