import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

function timestampColumnType(queryRunner: QueryRunner) {
    return queryRunner.connection.options.type === 'postgres' ? 'timestamp' : 'datetime';
}

export class AlignAuthRuntimeSingularTables1760000001000 implements MigrationInterface {
    name = 'AlignAuthRuntimeSingularTables1760000001000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const timestampType = timestampColumnType(queryRunner);

        await queryRunner.createTable(
            new Table({
                name: 'account',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'userId', type: 'varchar' },
                    { name: 'accountId', type: 'varchar' },
                    { name: 'providerId', type: 'varchar' },
                    { name: 'accessToken', type: 'text', isNullable: true },
                    { name: 'refreshToken', type: 'text', isNullable: true },
                    { name: 'accessTokenExpiresAt', type: timestampType, isNullable: true },
                    { name: 'refreshTokenExpiresAt', type: timestampType, isNullable: true },
                    { name: 'expiresAt', type: timestampType, isNullable: true },
                    { name: 'scope', type: 'varchar', isNullable: true },
                    { name: 'password', type: 'text', isNullable: true },
                    { name: 'idToken', type: 'text', isNullable: true },
                    { name: 'tokenType', type: 'varchar', isNullable: true },
                    { name: 'createdAt', type: timestampType, default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: timestampType, default: 'CURRENT_TIMESTAMP' },
                ],
                foreignKeys: [
                    new TableForeignKey({
                        name: 'FK_account_user',
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                ],
                indices: [
                    new TableIndex({
                        name: 'IDX_account_provider_account',
                        columnNames: ['providerId', 'accountId'],
                        isUnique: true,
                    }),
                    new TableIndex({
                        name: 'IDX_account_user_provider',
                        columnNames: ['userId', 'providerId'],
                        isUnique: true,
                    }),
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'session',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'userId', type: 'varchar' },
                    { name: 'token', type: 'text' },
                    { name: 'expiresAt', type: timestampType },
                    { name: 'ipAddress', type: 'varchar', isNullable: true },
                    { name: 'userAgent', type: 'varchar', isNullable: true },
                    { name: 'createdAt', type: timestampType, default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: timestampType, default: 'CURRENT_TIMESTAMP' },
                ],
                foreignKeys: [
                    new TableForeignKey({
                        name: 'FK_session_user',
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                ],
                indices: [
                    new TableIndex({
                        name: 'IDX_session_token',
                        columnNames: ['token'],
                        isUnique: true,
                    }),
                    new TableIndex({
                        name: 'IDX_session_userId',
                        columnNames: ['userId'],
                    }),
                ],
            }),
            true,
        );

        await queryRunner.createTable(
            new Table({
                name: 'verification',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'identifier', type: 'varchar' },
                    { name: 'value', type: 'text' },
                    { name: 'expiresAt', type: timestampType },
                    { name: 'createdAt', type: timestampType, default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: timestampType, default: 'CURRENT_TIMESTAMP' },
                ],
                indices: [
                    new TableIndex({
                        name: 'IDX_verification_identifier_value',
                        columnNames: ['identifier', 'value'],
                        isUnique: true,
                    }),
                ],
            }),
            true,
        );

        const hasPluralAccounts = await queryRunner.hasTable('accounts');
        const hasPluralSessions = await queryRunner.hasTable('sessions');
        const hasPluralVerifications = await queryRunner.hasTable('verifications');

        const [{ count: accountCount }] = (await queryRunner.query(
            `SELECT COUNT(*) as count FROM "account"`,
        )) as Array<{ count: number | string }>;
        const [{ count: sessionCount }] = (await queryRunner.query(
            `SELECT COUNT(*) as count FROM "session"`,
        )) as Array<{ count: number | string }>;
        const [{ count: verificationCount }] = (await queryRunner.query(
            `SELECT COUNT(*) as count FROM "verification"`,
        )) as Array<{ count: number | string }>;

        if (hasPluralAccounts && Number(accountCount) === 0) {
            await queryRunner.query(`
                INSERT INTO "account" (
                    "id", "userId", "accountId", "providerId", "accessToken", "refreshToken",
                    "accessTokenExpiresAt", "refreshTokenExpiresAt", "expiresAt", "scope",
                    "password", "idToken", "tokenType", "createdAt", "updatedAt"
                )
                SELECT
                    "id", "userId", "accountId", "providerId", "accessToken", "refreshToken",
                    "accessTokenExpiresAt", "refreshTokenExpiresAt", "expiresAt", "scope",
                    "password", "idToken", "tokenType", "createdAt", "updatedAt"
                FROM "accounts"
            `);
        }

        if (hasPluralSessions && Number(sessionCount) === 0) {
            await queryRunner.query(`
                INSERT INTO "session" (
                    "id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"
                )
                SELECT
                    "id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"
                FROM "sessions"
            `);
        }

        if (hasPluralVerifications && Number(verificationCount) === 0) {
            await queryRunner.query(`
                INSERT INTO "verification" (
                    "id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"
                )
                SELECT
                    "id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"
                FROM "verifications"
            `);
        }
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
