import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class AddAuthRuntimeTables1760000000000 implements MigrationInterface {
    name = 'AddAuthRuntimeTables1760000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'auth_accounts',
                columns: [
                    {
                        name: 'id',
                        type: 'varchar',
                        isPrimary: true,
                    },
                    {
                        name: 'userId',
                        type: 'varchar',
                    },
                    {
                        name: 'accountId',
                        type: 'varchar',
                    },
                    {
                        name: 'providerId',
                        type: 'varchar',
                    },
                    {
                        name: 'accessToken',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'refreshToken',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'accessTokenExpiresAt',
                        type: 'bigint',
                        isNullable: true,
                    },
                    {
                        name: 'refreshTokenExpiresAt',
                        type: 'bigint',
                        isNullable: true,
                    },
                    {
                        name: 'scope',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'idToken',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'password',
                        type: 'text',
                        isNullable: true,
                    },
                    {
                        name: 'createdAt',
                        type: 'datetime',
                        default:
                            queryRunner.connection.options.type === 'postgres'
                                ? 'CURRENT_TIMESTAMP'
                                : 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: 'datetime',
                        default:
                            queryRunner.connection.options.type === 'postgres'
                                ? 'CURRENT_TIMESTAMP'
                                : 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'auth_accounts',
            new TableIndex({
                name: 'IDX_auth_accounts_provider_account',
                columnNames: ['providerId', 'accountId'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'auth_accounts',
            new TableIndex({
                name: 'IDX_auth_accounts_user_provider',
                columnNames: ['userId', 'providerId'],
                isUnique: true,
            }),
        );
        await queryRunner.createForeignKey(
            'auth_accounts',
            new TableForeignKey({
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'auth_sessions',
                columns: [
                    {
                        name: 'id',
                        type: 'varchar',
                        isPrimary: true,
                    },
                    {
                        name: 'userId',
                        type: 'varchar',
                    },
                    {
                        name: 'token',
                        type: 'text',
                    },
                    {
                        name: 'expiresAt',
                        type: 'bigint',
                    },
                    {
                        name: 'ipAddress',
                        type: 'varchar',
                        isNullable: true,
                    },
                    {
                        name: 'userAgent',
                        type: 'varchar',
                        isNullable: true,
                    },
                    {
                        name: 'createdAt',
                        type: 'datetime',
                        default:
                            queryRunner.connection.options.type === 'postgres'
                                ? 'CURRENT_TIMESTAMP'
                                : 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: 'datetime',
                        default:
                            queryRunner.connection.options.type === 'postgres'
                                ? 'CURRENT_TIMESTAMP'
                                : 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'auth_sessions',
            new TableIndex({
                name: 'IDX_auth_sessions_token',
                columnNames: ['token'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'auth_sessions',
            new TableIndex({
                name: 'IDX_auth_sessions_user',
                columnNames: ['userId'],
            }),
        );
        await queryRunner.createForeignKey(
            'auth_sessions',
            new TableForeignKey({
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'auth_verifications',
                columns: [
                    {
                        name: 'id',
                        type: 'varchar',
                        isPrimary: true,
                    },
                    {
                        name: 'identifier',
                        type: 'varchar',
                    },
                    {
                        name: 'value',
                        type: 'text',
                    },
                    {
                        name: 'expiresAt',
                        type: 'bigint',
                    },
                    {
                        name: 'createdAt',
                        type: 'datetime',
                        default:
                            queryRunner.connection.options.type === 'postgres'
                                ? 'CURRENT_TIMESTAMP'
                                : 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: 'datetime',
                        default:
                            queryRunner.connection.options.type === 'postgres'
                                ? 'CURRENT_TIMESTAMP'
                                : 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'auth_verifications',
            new TableIndex({
                name: 'IDX_auth_verifications_identifier',
                columnNames: ['identifier'],
            }),
        );
        await queryRunner.createIndex(
            'auth_verifications',
            new TableIndex({
                name: 'IDX_auth_verifications_value',
                columnNames: ['value'],
                isUnique: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const verificationTable = await queryRunner.getTable('auth_verifications');
        if (verificationTable) {
            for (const index of verificationTable.indices) {
                await queryRunner.dropIndex('auth_verifications', index);
            }
        }
        await queryRunner.dropTable('auth_verifications', true);

        const sessionTable = await queryRunner.getTable('auth_sessions');
        if (sessionTable) {
            for (const foreignKey of sessionTable.foreignKeys) {
                await queryRunner.dropForeignKey('auth_sessions', foreignKey);
            }
            for (const index of sessionTable.indices) {
                await queryRunner.dropIndex('auth_sessions', index);
            }
        }
        await queryRunner.dropTable('auth_sessions', true);

        const accountTable = await queryRunner.getTable('auth_accounts');
        if (accountTable) {
            for (const foreignKey of accountTable.foreignKeys) {
                await queryRunner.dropForeignKey('auth_accounts', foreignKey);
            }
            for (const index of accountTable.indices) {
                await queryRunner.dropIndex('auth_accounts', index);
            }
        }
        await queryRunner.dropTable('auth_accounts', true);
    }
}
