import { MigrationInterface, QueryRunner, Table, TableColumnOptions, TableIndex } from 'typeorm';

export class AddGitHubAppTables1761782400000 implements MigrationInterface {
    name = 'AddGitHubAppTables1761782400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const driverType = queryRunner.connection.options.type;
        const idType = driverType === 'postgres' ? 'uuid' : 'varchar';
        const dateType = driverType === 'postgres' ? 'timestamp' : 'datetime';

        await queryRunner.createTable(
            new Table({
                name: 'github_app_installations',
                columns: [
                    this.idColumn('id', idType),
                    { name: 'installationId', type: 'varchar', isNullable: false },
                    { name: 'appSlug', type: 'varchar', isNullable: true },
                    { name: 'accountLogin', type: 'varchar', isNullable: false },
                    { name: 'accountType', type: 'varchar', isNullable: false },
                    { name: 'targetType', type: 'varchar', isNullable: false },
                    { name: 'createdByUserId', type: 'varchar', isNullable: true },
                    { name: 'createdByGithubUserId', type: 'varchar', isNullable: true },
                    { name: 'suspendedAt', type: dateType, isNullable: true },
                    { name: 'rawPayload', type: 'text', isNullable: true },
                    this.createdAtColumn('createdAt', dateType),
                    this.createdAtColumn('updatedAt', dateType),
                ],
            }),
            true,
        );
        await queryRunner.createIndex(
            'github_app_installations',
            new TableIndex({
                name: 'IDX_github_app_installations_installation_id',
                columnNames: ['installationId'],
                isUnique: true,
            }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'github_app_installation_repositories',
                columns: [
                    this.idColumn('id', idType),
                    { name: 'installationEntityId', type: 'varchar', isNullable: false },
                    { name: 'githubRepoId', type: 'varchar', isNullable: false },
                    { name: 'owner', type: 'varchar', isNullable: false },
                    { name: 'repo', type: 'varchar', isNullable: false },
                    { name: 'fullName', type: 'varchar', isNullable: false },
                    { name: 'isPrivate', type: 'boolean', isNullable: false, default: false },
                    { name: 'defaultBranch', type: 'varchar', isNullable: true },
                    { name: 'selected', type: 'boolean', isNullable: false, default: true },
                    this.createdAtColumn('createdAt', dateType),
                    this.createdAtColumn('updatedAt', dateType),
                ],
            }),
            true,
        );
        await queryRunner.createIndices('github_app_installation_repositories', [
            new TableIndex({
                name: 'IDX_github_app_installation_repositories_installation_repo_id',
                columnNames: ['installationEntityId', 'githubRepoId'],
                isUnique: true,
            }),
            new TableIndex({
                name: 'IDX_github_app_installation_repositories_installation_full_name',
                columnNames: ['installationEntityId', 'fullName'],
                isUnique: true,
            }),
        ]);

        await queryRunner.createTable(
            new Table({
                name: 'github_app_user_links',
                columns: [
                    this.idColumn('id', idType),
                    { name: 'userId', type: 'varchar', isNullable: false },
                    { name: 'githubUserId', type: 'varchar', isNullable: false },
                    { name: 'githubLogin', type: 'varchar', isNullable: false },
                    { name: 'githubNodeId', type: 'varchar', isNullable: true },
                    { name: 'accessToken', type: 'text', isNullable: true },
                    { name: 'refreshToken', type: 'text', isNullable: true },
                    { name: 'accessTokenExpiresAt', type: dateType, isNullable: true },
                    { name: 'refreshTokenExpiresAt', type: dateType, isNullable: true },
                    { name: 'scope', type: 'text', isNullable: true },
                    this.createdAtColumn('createdAt', dateType),
                    this.createdAtColumn('updatedAt', dateType),
                ],
            }),
            true,
        );
        await queryRunner.createIndices('github_app_user_links', [
            new TableIndex({
                name: 'IDX_github_app_user_links_user_id',
                columnNames: ['userId'],
                isUnique: true,
            }),
            new TableIndex({
                name: 'IDX_github_app_user_links_github_user_id',
                columnNames: ['githubUserId'],
                isUnique: true,
            }),
        ]);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('github_app_user_links', true);
        await queryRunner.dropTable('github_app_installation_repositories', true);
        await queryRunner.dropTable('github_app_installations', true);
    }

    private idColumn(name: string, type: string): TableColumnOptions {
        return {
            name,
            type,
            isPrimary: true,
        };
    }

    private createdAtColumn(name: string, type: string): TableColumnOptions {
        return {
            name,
            type,
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
        };
    }
}
