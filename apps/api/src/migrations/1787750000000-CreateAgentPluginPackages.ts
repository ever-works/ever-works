import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Agent Plugins standard interop — the package registry.
 *
 * Two tables, and the reason they are two is the point:
 *
 * - `agent_plugin_packages` records installed **data** packages in the open
 *   Agent Plugins format. Per tenant/organization, because a package's skills
 *   reach one owner's catalog and nobody else's.
 * - `agent_plugin_package_allowlist` records which remote packages an
 *   operator permits fetching. Global, and deliberately NOT the existing
 *   `plugin_allowlist`: a row there authorises installing executable code,
 *   and letting one table grant both powers would mean the safer decision
 *   silently carried the more dangerous one.
 *
 * Both start empty and stay empty until `FEATURE_AGENT_PLUGINS` is turned on,
 * so this migration is inert on every existing deployment.
 *
 * Two deliberate omissions:
 *
 * - **No XOR CHECK on the scope columns.** `ScopeStampingSubscriber`
 *   populates `tenantId` AND `organizationId` on insert, so a XOR constraint
 *   would abort on ordinary data — a bug class this repository has hit
 *   before.
 * - **No foreign key on the scope columns**, matching every other Tier A/C
 *   table here; the entity carries no `@ManyToOne` for them either, to avoid
 *   the entity-graph cycle.
 *
 * `down` drops both tables. They hold no financial or audit record, and a
 * package is re-discoverable from its source, so a clean rollback is safe.
 */
export class CreateAgentPluginPackages1787750000000 implements MigrationInterface {
    name = 'CreateAgentPluginPackages1787750000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('agent_plugin_packages'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'agent_plugin_packages',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'name', type: 'varchar', length: '120' },
                        { name: 'version', type: 'varchar', length: '64', isNullable: true },
                        { name: 'specVersion', type: 'varchar', length: '16' },
                        { name: 'source', type: 'varchar', length: '16', default: "'local'" },
                        { name: 'sourceRef', type: 'varchar', length: '2048' },
                        { name: 'installPath', type: 'varchar', length: '2048', isNullable: true },
                        { name: 'integrity', type: 'varchar', length: '256', isNullable: true },
                        // `simple-json` columns are `text` at the database
                        // level. This codebase uses `simple-json` throughout
                        // and has no `jsonb` column anywhere.
                        { name: 'manifest', type: 'text', isNullable: true },
                        { name: 'findings', type: 'text', default: "'[]'" },
                        { name: 'skillNames', type: 'text', default: "'[]'" },
                        { name: 'mcpServerNames', type: 'text', default: "'[]'" },
                        {
                            name: 'installState',
                            type: 'varchar',
                            length: '16',
                            default: "'available'",
                        },
                        { name: 'installError', type: 'text', isNullable: true },
                        { name: 'contentHash', type: 'varchar', length: '128', isNullable: true },
                        { name: 'lastValidatedAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'agent_plugin_packages',
                new TableIndex({
                    name: 'uq_agent_plugin_package_user_name',
                    columnNames: ['userId', 'name'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'agent_plugin_packages',
                new TableIndex({
                    name: 'idx_agent_plugin_package_user',
                    columnNames: ['userId'],
                }),
            );
            await queryRunner.createIndex(
                'agent_plugin_packages',
                new TableIndex({
                    name: 'idx_agent_plugin_package_state',
                    columnNames: ['installState'],
                }),
            );
            await queryRunner.createForeignKey(
                'agent_plugin_packages',
                new TableForeignKey({
                    name: 'fk_agent_plugin_package_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        if (!(await queryRunner.hasTable('agent_plugin_package_allowlist'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'agent_plugin_package_allowlist',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'packageName', type: 'varchar', length: '2048' },
                        { name: 'source', type: 'varchar', length: '16' },
                        { name: 'versionRange', type: 'varchar', length: '256', isNullable: true },
                        { name: 'integrity', type: 'varchar', length: '256', isNullable: true },
                        { name: 'enabled', type: 'boolean', default: true },
                        { name: 'notes', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'agent_plugin_package_allowlist',
                new TableIndex({
                    name: 'uq_agent_plugin_allowlist_name_source',
                    columnNames: ['packageName', 'source'],
                    isUnique: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('agent_plugin_package_allowlist')) {
            await queryRunner.dropTable('agent_plugin_package_allowlist', true);
        }
        if (await queryRunner.hasTable('agent_plugin_packages')) {
            await queryRunner.dropTable('agent_plugin_packages', true);
        }
    }
}
