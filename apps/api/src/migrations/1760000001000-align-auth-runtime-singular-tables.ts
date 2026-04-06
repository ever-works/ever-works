import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

function timestampColumnType(queryRunner: QueryRunner) {
    return queryRunner.connection.options.type === 'postgres' ? 'timestamp' : 'datetime';
}

function normalizeDateValue(value: unknown): Date | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    if (value instanceof Date) {
        return value;
    }

    if (typeof value === 'number') {
        return new Date(value);
    }

    if (typeof value === 'string') {
        if (/^\d+$/.test(value)) {
            return new Date(Number(value));
        }

        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return null;
}

export class AlignAuthRuntimeSingularTables1760000001000 implements MigrationInterface {
    name = 'AlignAuthRuntimeSingularTables1760000001000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const timestampType = timestampColumnType(queryRunner);

        await this.alignAccountTable(queryRunner, timestampType);
        await this.alignSessionTable(queryRunner, timestampType);
        await this.alignVerificationTable(queryRunner, timestampType);

        const hasAuthAccounts = await queryRunner.hasTable('auth_accounts');
        const hasAuthSessions = await queryRunner.hasTable('auth_sessions');
        const hasAuthVerifications = await queryRunner.hasTable('auth_verifications');
        const hasPluralAccounts = await queryRunner.hasTable('accounts');
        const hasPluralSessions = await queryRunner.hasTable('sessions');
        const hasPluralVerifications = await queryRunner.hasTable('verifications');

        const accountCount = await this.getTableCount(queryRunner, 'account');
        const sessionCount = await this.getTableCount(queryRunner, 'session');
        const verificationCount = await this.getTableCount(queryRunner, 'verification');

        if (accountCount === 0 && (hasAuthAccounts || hasPluralAccounts)) {
            const sourceTable = hasAuthAccounts ? 'auth_accounts' : 'accounts';
            const rows = await queryRunner.manager
                .createQueryBuilder()
                .select('*')
                .from(sourceTable, 'account_source')
                .getRawMany<Record<string, unknown>>();

            if (rows.length > 0) {
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into('account')
                    .values(
                        rows.map((row) => ({
                            id: row.id as string,
                            userId: row.userId as string,
                            accountId: row.accountId as string,
                            providerId: row.providerId as string,
                            accessToken: (row.accessToken as string | null) ?? null,
                            refreshToken: (row.refreshToken as string | null) ?? null,
                            accessTokenExpiresAt: normalizeDateValue(row.accessTokenExpiresAt),
                            refreshTokenExpiresAt: normalizeDateValue(row.refreshTokenExpiresAt),
                            expiresAt: normalizeDateValue(row.expiresAt),
                            scope: (row.scope as string | null) ?? null,
                            password: (row.password as string | null) ?? null,
                            idToken: (row.idToken as string | null) ?? null,
                            tokenType: (row.tokenType as string | null) ?? null,
                            createdAt: normalizeDateValue(row.createdAt) ?? new Date(),
                            updatedAt: normalizeDateValue(row.updatedAt) ?? new Date(),
                        })),
                    )
                    .execute();
            }
        }

        if (sessionCount === 0 && (hasAuthSessions || hasPluralSessions)) {
            const sourceTable = hasAuthSessions ? 'auth_sessions' : 'sessions';
            const rows = await queryRunner.manager
                .createQueryBuilder()
                .select('*')
                .from(sourceTable, 'session_source')
                .getRawMany<Record<string, unknown>>();

            if (rows.length > 0) {
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into('session')
                    .values(
                        rows.map((row) => ({
                            id: row.id as string,
                            userId: row.userId as string,
                            token: row.token as string,
                            expiresAt: normalizeDateValue(row.expiresAt) ?? new Date(),
                            ipAddress: (row.ipAddress as string | null) ?? null,
                            userAgent: (row.userAgent as string | null) ?? null,
                            createdAt: normalizeDateValue(row.createdAt) ?? new Date(),
                            updatedAt: normalizeDateValue(row.updatedAt) ?? new Date(),
                        })),
                    )
                    .execute();
            }
        }

        if (verificationCount === 0 && (hasAuthVerifications || hasPluralVerifications)) {
            const sourceTable = hasAuthVerifications ? 'auth_verifications' : 'verifications';
            const rows = await queryRunner.manager
                .createQueryBuilder()
                .select('*')
                .from(sourceTable, 'verification_source')
                .getRawMany<Record<string, unknown>>();

            if (rows.length > 0) {
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into('verification')
                    .values(
                        rows.map((row) => ({
                            id: row.id as string,
                            identifier: row.identifier as string,
                            value: row.value as string,
                            expiresAt: normalizeDateValue(row.expiresAt) ?? new Date(),
                            createdAt: normalizeDateValue(row.createdAt) ?? new Date(),
                            updatedAt: normalizeDateValue(row.updatedAt) ?? new Date(),
                        })),
                    )
                    .execute();
            }
        }

        if (hasAuthVerifications) {
            await this.dropLegacyTable(queryRunner, 'auth_verifications');
        }
        if (hasAuthSessions) {
            await this.dropLegacyTable(queryRunner, 'auth_sessions');
        }
        if (hasAuthAccounts) {
            await this.dropLegacyTable(queryRunner, 'auth_accounts');
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

    private async getTableCount(queryRunner: QueryRunner, tableName: string): Promise<number> {
        return queryRunner.manager.createQueryBuilder().from(tableName, 't').getCount();
    }

    private async alignAccountTable(queryRunner: QueryRunner, timestampType: string): Promise<void> {
        const table = await queryRunner.getTable('account');
        if (!table) {
            return;
        }

        await this.ensureColumn(queryRunner, table, 'accessTokenExpiresAt', {
            name: 'accessTokenExpiresAt',
            type: timestampType,
            isNullable: true,
        });
        await this.ensureColumn(queryRunner, table, 'refreshTokenExpiresAt', {
            name: 'refreshTokenExpiresAt',
            type: timestampType,
            isNullable: true,
        });
        await this.ensureColumn(queryRunner, table, 'expiresAt', {
            name: 'expiresAt',
            type: timestampType,
            isNullable: true,
        });
        await this.ensureColumn(queryRunner, table, 'tokenType', {
            name: 'tokenType',
            type: 'varchar',
            isNullable: true,
        });

        await this.changeColumnType(queryRunner, table, 'accessTokenExpiresAt', timestampType);
        await this.changeColumnType(queryRunner, table, 'refreshTokenExpiresAt', timestampType);
        await this.changeColumnType(queryRunner, table, 'expiresAt', timestampType);
        await this.changeColumnType(queryRunner, table, 'scope', 'varchar');
        await this.changeColumnType(queryRunner, table, 'createdAt', timestampType);
        await this.changeColumnType(queryRunner, table, 'updatedAt', timestampType);
    }

    private async alignSessionTable(queryRunner: QueryRunner, timestampType: string): Promise<void> {
        const table = await queryRunner.getTable('session');
        if (!table) {
            return;
        }

        await this.changeColumnType(queryRunner, table, 'expiresAt', timestampType);
        await this.changeColumnType(queryRunner, table, 'createdAt', timestampType);
        await this.changeColumnType(queryRunner, table, 'updatedAt', timestampType);
    }

    private async alignVerificationTable(
        queryRunner: QueryRunner,
        timestampType: string,
    ): Promise<void> {
        const table = await queryRunner.getTable('verification');
        if (!table) {
            return;
        }

        await this.changeColumnType(queryRunner, table, 'expiresAt', timestampType);
        await this.changeColumnType(queryRunner, table, 'createdAt', timestampType);
        await this.changeColumnType(queryRunner, table, 'updatedAt', timestampType);
    }

    private async ensureColumn(
        queryRunner: QueryRunner,
        table: Table,
        columnName: string,
        column: Omit<TableColumn, '@instanceof'>,
    ): Promise<void> {
        if (table.findColumnByName(columnName)) {
            return;
        }

        await queryRunner.addColumn(table, new TableColumn(column));
    }

    private async changeColumnType(
        queryRunner: QueryRunner,
        table: Table,
        columnName: string,
        type: string,
    ): Promise<void> {
        const column = table.findColumnByName(columnName);
        if (!column || column.type === type) {
            return;
        }

        await queryRunner.changeColumn(
            table,
            column,
            new TableColumn({
                ...column,
                type,
            }),
        );
    }

    private async dropLegacyTable(queryRunner: QueryRunner, tableName: string): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        if (!table) {
            return;
        }

        for (const foreignKey of table.foreignKeys) {
            await queryRunner.dropForeignKey(tableName, foreignKey);
        }
        for (const index of table.indices) {
            await queryRunner.dropIndex(tableName, index);
        }

        await queryRunner.dropTable(tableName, true);
    }
}
