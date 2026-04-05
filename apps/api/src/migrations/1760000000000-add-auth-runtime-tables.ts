import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

export class AddAuthRuntimeTables1760000000000 implements MigrationInterface {
    name = 'AddAuthRuntimeTables1760000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'account',
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
                        default: 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: 'datetime',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'account',
            new TableIndex({
                name: 'IDX_account_provider_account',
                columnNames: ['providerId', 'accountId'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'account',
            new TableIndex({
                name: 'IDX_account_user_provider',
                columnNames: ['userId', 'providerId'],
                isUnique: true,
            }),
        );
        await queryRunner.createForeignKey(
            'account',
            new TableForeignKey({
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'session',
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
                        default: 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: 'datetime',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'session',
            new TableIndex({
                name: 'IDX_session_token',
                columnNames: ['token'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'session',
            new TableIndex({
                name: 'IDX_session_userId',
                columnNames: ['userId'],
            }),
        );
        await queryRunner.createForeignKey(
            'session',
            new TableForeignKey({
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'verification',
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
                        default: 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: 'datetime',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'verification',
            new TableIndex({
                name: 'IDX_verification_identifier',
                columnNames: ['identifier'],
            }),
        );
        await queryRunner.createIndex(
            'verification',
            new TableIndex({
                name: 'IDX_verification_value',
                columnNames: ['value'],
                isUnique: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const verificationTable = await queryRunner.getTable('verification');
        if (verificationTable) {
            for (const index of verificationTable.indices) {
                await queryRunner.dropIndex('verification', index);
            }
        }
        await queryRunner.dropTable('verification', true);

        const sessionTable = await queryRunner.getTable('session');
        if (sessionTable) {
            for (const foreignKey of sessionTable.foreignKeys) {
                await queryRunner.dropForeignKey('session', foreignKey);
            }
            for (const index of sessionTable.indices) {
                await queryRunner.dropIndex('session', index);
            }
        }
        await queryRunner.dropTable('session', true);

        const accountTable = await queryRunner.getTable('account');
        if (accountTable) {
            for (const foreignKey of accountTable.foreignKeys) {
                await queryRunner.dropForeignKey('account', foreignKey);
            }
            for (const index of accountTable.indices) {
                await queryRunner.dropIndex('account', index);
            }
        }
        await queryRunner.dropTable('account', true);
    }
}
