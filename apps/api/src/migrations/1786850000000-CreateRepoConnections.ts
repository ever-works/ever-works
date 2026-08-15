import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Repository registry (Feature G) — `repo_connections` +
 * `agent_repo_attachments`.
 *
 * ## Why
 *
 * Repositories only existed as facets of a Work (`sourceRepository.
 * relatedRepositories`) or as a GitHub-App installation snapshot. There
 * was no account-level record of "a repo I want my agents to be able to
 * reach" — nothing to attach a credential pointer or seed `.env` files
 * to, and nothing an Agent could be granted independently of a Work.
 * `repo_connections` is that record; `agent_repo_attachments` is the
 * Agent → repo grant edge the future per-agent Capabilities page reads.
 *
 * ## Additive
 *
 * Two new tables. No existing table gains, loses, or changes a column;
 * the Work three-repo model is untouched (Work repos are surfaced in the
 * registry listing as COMPUTED entries, never materialized here).
 *
 * ## Deliberately NO scope XOR CHECK
 *
 * Both tables carry Tier-C `tenantId` / `organizationId` denorm columns
 * that `ScopeStampingSubscriber` populates together on ordinary inserts
 * — an XOR CHECK would abort on real data (the `work_knowledge_uploads`
 * lesson; see 1784820000000-CreateWorkflows).
 *
 * ## Secrets posture
 *
 * `envFiles` is text holding an envelope-encrypted JSON record
 * (`EncryptedJsonColumn` — every value AES-256-GCM `enc::v1::`), and
 * `credentialRef` is a POINTER (`env:NAME` / `plugin:github` /
 * installation entity id), never a raw token. Nothing in either table is
 * plaintext-secret.
 *
 * Portable Table API (CI/e2e run better-sqlite3, prod runs Postgres);
 * forward-only with an idempotent guard (house pattern, mirrors
 * 1785000000000-CreateTermsAcceptance).
 */
export class CreateRepoConnections1786850000000 implements MigrationInterface {
    name = 'CreateRepoConnections1786850000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('repo_connections'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'repo_connections',
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
                        { name: 'url', type: 'varchar', length: '512' },
                        { name: 'provider', type: 'varchar', length: '16', default: "'github'" },
                        { name: 'defaultBranch', type: 'varchar', length: '120', isNullable: true },
                        { name: 'mountPath', type: 'varchar', length: '200', isNullable: true },
                        { name: 'description', type: 'text', isNullable: true },
                        {
                            name: 'credentialMode',
                            type: 'varchar',
                            length: '24',
                            default: "'inherit'",
                        },
                        { name: 'credentialRef', type: 'varchar', length: '200', isNullable: true },
                        // Envelope-encrypted JSON record ({ [path]: content });
                        // `simple-json` maps to text on every driver.
                        { name: 'envFiles', type: 'text', isNullable: true },
                        { name: 'availableInAllProjects', type: 'boolean', default: true },
                        { name: 'sourceType', type: 'varchar', length: '16', default: "'manual'" },
                        { name: 'sourceWorkId', type: 'uuid', isNullable: true },
                        { name: 'sourceInstallationRepoId', type: 'uuid', isNullable: true },
                        { name: 'enabled', type: 'boolean', default: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            // One name per user — imports collide loudly (409) instead of
            // silently minting "repo (2)" rows nothing else references.
            await queryRunner.createIndex(
                'repo_connections',
                new TableIndex({
                    name: 'uq_repo_connection_user_name',
                    columnNames: ['userId', 'name'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'repo_connections',
                new TableIndex({
                    name: 'idx_repo_connection_user',
                    columnNames: ['userId'],
                }),
            );

            if (await queryRunner.hasTable('users')) {
                await queryRunner.createForeignKey(
                    'repo_connections',
                    new TableForeignKey({
                        name: 'fk_repo_connections_user',
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                );
            }
        }

        if (!(await queryRunner.hasTable('agent_repo_attachments'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'agent_repo_attachments',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'agentId', type: 'uuid' },
                        { name: 'repoConnectionId', type: 'uuid' },
                        { name: 'enabled', type: 'boolean', default: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'agent_repo_attachments',
                new TableIndex({
                    name: 'uq_agent_repo_attachment',
                    columnNames: ['agentId', 'repoConnectionId'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'agent_repo_attachments',
                new TableIndex({
                    name: 'idx_agent_repo_attachment_repo',
                    columnNames: ['repoConnectionId'],
                }),
            );
            await queryRunner.createIndex(
                'agent_repo_attachments',
                new TableIndex({
                    name: 'idx_agent_repo_attachment_user',
                    columnNames: ['userId'],
                }),
            );

            if (await queryRunner.hasTable('agents')) {
                await queryRunner.createForeignKey(
                    'agent_repo_attachments',
                    new TableForeignKey({
                        name: 'fk_agent_repo_attachments_agent',
                        columnNames: ['agentId'],
                        referencedTableName: 'agents',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                );
            }
            await queryRunner.createForeignKey(
                'agent_repo_attachments',
                new TableForeignKey({
                    name: 'fk_agent_repo_attachments_repo',
                    columnNames: ['repoConnectionId'],
                    referencedTableName: 'repo_connections',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            if (await queryRunner.hasTable('users')) {
                await queryRunner.createForeignKey(
                    'agent_repo_attachments',
                    new TableForeignKey({
                        name: 'fk_agent_repo_attachments_user',
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Removes the feature wholesale (registry rows + grants). The Work
        // three-repo model and GitHub-App snapshots are untouched, so
        // nothing else reads these tables.
        if (await queryRunner.hasTable('agent_repo_attachments')) {
            await queryRunner.dropTable('agent_repo_attachments');
        }
        if (await queryRunner.hasTable('repo_connections')) {
            await queryRunner.dropTable('repo_connections');
        }
    }
}
