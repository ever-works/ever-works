import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Environments (Settings → Environments) — the `environments` table.
 *
 * A named, reusable runtime recipe a user manages under Settings and
 * assigns per-Agent: package lists (pip/npm), networking posture
 * (unrestricted vs. limited + egress allow-list), lifecycle
 * (draft/published), and the available-in-all-projects flag. Consumed v1
 * by the `claude-managed-agent` pipeline plugin when creating Anthropic
 * Managed-Agent environments/sessions.
 *
 * ## Portable DDL
 *
 * Built with TypeORM's `Table`/`TableIndex`/`TableForeignKey` API rather
 * than raw SQL because the e2e stack and CI run better-sqlite3 while
 * production runs Postgres (house pattern — mirrors
 * 1784820000000-CreateWorkflows).
 *
 * `pipPackages` / `npmPackages` / `allowedHosts` are `text` (what
 * TypeORM's `simple-json` maps to on every supported driver). The lists
 * are only ever read and written WHOLE — validation happens at the DTO +
 * service layers — so join tables would buy nothing anything queries.
 *
 * ## Deliberately NO scope XOR CHECK
 *
 * Same reasoning as `workflows`: `ScopeStampingSubscriber` stamps
 * `organizationId` on inserts for entities carrying both scope columns,
 * so ordinary rows may have BOTH `tenantId` and `organizationId`
 * populated and an XOR would abort on real data.
 *
 * Forward-only with an idempotent guard (house pattern).
 */
export class CreateEnvironments1786810000000 implements MigrationInterface {
    name = 'CreateEnvironments1786810000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('environments')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'environments',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'name', type: 'varchar', length: '120' },
                    { name: 'slug', type: 'varchar', length: '80' },
                    { name: 'description', type: 'text', isNullable: true },
                    // simple-json ⇒ text on every driver.
                    { name: 'pipPackages', type: 'text', default: "'[]'" },
                    { name: 'npmPackages', type: 'text', default: "'[]'" },
                    {
                        name: 'networkingMode',
                        type: 'varchar',
                        length: '16',
                        default: "'unrestricted'",
                    },
                    { name: 'allowedHosts', type: 'text', isNullable: true },
                    { name: 'allowPackageManagers', type: 'boolean', default: true },
                    { name: 'status', type: 'varchar', length: '16', default: "'draft'" },
                    { name: 'availableInAllProjects', type: 'boolean', default: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // Durable per-user slug uniqueness — the DB-level CAS for
        // concurrent same-name creates (service translates the lost
        // race into a named 409).
        await queryRunner.createIndex(
            'environments',
            new TableIndex({
                name: 'uq_environments_user_slug',
                columnNames: ['userId', 'slug'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'environments',
            new TableIndex({
                name: 'idx_environments_user_status',
                columnNames: ['userId', 'status'],
            }),
        );

        // Guarded on the users table existing: must not explode on a
        // fresh database whose user table has not been created yet.
        if (await queryRunner.hasTable('users')) {
            await queryRunner.createForeignKey(
                'environments',
                new TableForeignKey({
                    name: 'fk_environments_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Destroys user-authored Environments — acceptable only because
        // it removes the feature wholesale; an operator running it is
        // choosing that. `agents.environmentId` values pointing here are
        // cleared by reverting 1786810001000-AddAgentEnvironmentId first
        // (TypeORM reverts newest-first, so ordering holds).
        if (await queryRunner.hasTable('environments')) {
            await queryRunner.dropTable('environments');
        }
    }
}
