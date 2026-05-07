import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class AddTemplatesCatalog1762300800000 implements MigrationInterface {
    name = 'AddTemplatesCatalog1762300800000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const timestampType = isPostgres ? 'timestamp with time zone' : 'datetime';
        const preferenceIdType = isPostgres ? 'uuid' : 'varchar';

        await queryRunner.createTable(
            new Table({
                name: 'templates',
                columns: [
                    { name: 'id', type: 'varchar', length: '120', isPrimary: true },
                    { name: 'kind', type: 'varchar', length: '32' },
                    {
                        name: 'sourceType',
                        type: 'varchar',
                        length: '32',
                        default: "'built_in'",
                    },
                    { name: 'ownerUserId', type: 'varchar', isNullable: true },
                    { name: 'name', type: 'varchar', length: '120' },
                    { name: 'description', type: 'text', isNullable: true },
                    { name: 'framework', type: 'varchar', length: '80', isNullable: true },
                    {
                        name: 'previewImageUrl',
                        type: 'varchar',
                        length: '2048',
                        isNullable: true,
                    },
                    {
                        name: 'repositoryUrl',
                        type: 'varchar',
                        length: '2048',
                        isNullable: true,
                    },
                    { name: 'repositoryOwner', type: 'varchar', length: '255' },
                    { name: 'repositoryName', type: 'varchar', length: '255' },
                    { name: 'branch', type: 'varchar', length: '255', default: "'main'" },
                    { name: 'syncBranches', type: 'text', default: "'[]'" },
                    { name: 'betaBranch', type: 'varchar', length: '255', isNullable: true },
                    { name: 'isActive', type: 'boolean', default: true },
                    { name: 'metadata', type: 'text', default: "'{}'" },
                    {
                        name: 'createdAt',
                        type: timestampType,
                        default: isPostgres ? 'now()' : 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: timestampType,
                        default: isPostgres ? 'now()' : 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'templates',
            new TableIndex({
                name: 'IDX_templates_kind_source_active',
                columnNames: ['kind', 'sourceType', 'isActive'],
            }),
        );

        await queryRunner.createIndex(
            'templates',
            new TableIndex({
                name: 'IDX_templates_owner_kind',
                columnNames: ['ownerUserId', 'kind'],
            }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'user_template_preferences',
                columns: [
                    {
                        name: 'id',
                        type: preferenceIdType,
                        isPrimary: true,
                        ...(isPostgres ? { default: 'uuid_generate_v4()' } : {}),
                    },
                    { name: 'userId', type: 'varchar' },
                    { name: 'kind', type: 'varchar', length: '32' },
                    { name: 'templateId', type: 'varchar', length: '120' },
                    {
                        name: 'createdAt',
                        type: timestampType,
                        default: isPostgres ? 'now()' : 'CURRENT_TIMESTAMP',
                    },
                    {
                        name: 'updatedAt',
                        type: timestampType,
                        default: isPostgres ? 'now()' : 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'user_template_preferences',
            new TableIndex({
                name: 'IDX_user_template_preferences_user_kind',
                columnNames: ['userId', 'kind'],
                isUnique: true,
            }),
        );

        await queryRunner.createIndex(
            'user_template_preferences',
            new TableIndex({
                name: 'IDX_user_template_preferences_template_id',
                columnNames: ['templateId'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('user_template_preferences', true);
        await queryRunner.dropTable('templates', true);
    }
}
