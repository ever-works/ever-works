import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Inbound receivers — creates `ingest_install_bindings`, the external
 * workspace/installation → platform user binding that the Slack Events
 * receiver and the GitHub webhook receiver resolve deliveries through.
 *
 * Before this table both receivers resolved "the oldest enabled install
 * platform-wide" and attributed EVERY inbound event to that one user — a
 * multi-tenant data-isolation defect (a second customer's Slack workspace
 * or GitHub repository had its messages and diffs executed under, and
 * billed to, the first customer's account).
 *
 * Entity: `packages/agent/src/entities/ingest-install-binding.entity.ts`
 * Repository: `packages/agent/src/ingest/ingest-install-binding.repository.ts`
 *
 * **Schema notes:**
 *   - `provider` is a deliberate varchar(32) (not an enum) so a new
 *     inbound surface ships without a schema change — same convention as
 *     `fleet_nodes.kind`.
 *   - `externalWorkspaceId` holds the identity carried on the webhook:
 *     Slack's raw `team_id`, or — for GitHub — `installation:<id>` /
 *     `owner:<login>` under a disambiguating prefix so the two GitHub
 *     namespaces can never collide.
 *   - UNIQUE `(provider, externalWorkspaceId)` — one external workspace
 *     has exactly one owning platform user. The uniqueness is what makes
 *     resolution exact rather than a guess; it also resolves the
 *     concurrent-first-delivery race in the repository's `record()`.
 *   - `externalEnterpriseId` (nullable) carries Slack's `enterprise_id`
 *     when a delivery has one (Enterprise Grid). A stored value must
 *     match the incoming delivery or the binding does not apply.
 *   - FK `userId` → `users.id` ON DELETE CASCADE (a binding is
 *     meaningless without the account it attributes events to; deleting
 *     the account must not leave inbound events pointing at a ghost).
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1783900000000-CreateFleetNodes`.
 */
export class CreateIngestInstallBindings1784200000000 implements MigrationInterface {
    name = 'CreateIngestInstallBindings1784200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ingest_install_bindings')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'ingest_install_bindings',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'provider', type: 'varchar', length: '32' },
                    { name: 'externalWorkspaceId', type: 'varchar', length: '200' },
                    {
                        name: 'externalEnterpriseId',
                        type: 'varchar',
                        length: '200',
                        isNullable: true,
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'pluginId', type: 'varchar', length: '64' },
                    {
                        name: 'externalWorkspaceName',
                        type: 'varchar',
                        length: '200',
                        isNullable: true,
                    },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // Exact workspace → owner lookup on every inbound delivery. Unique
        // so two platform users can never claim the same workspace.
        await queryRunner.createIndex(
            'ingest_install_bindings',
            new TableIndex({
                name: 'idx_ingest_install_bindings_workspace',
                columnNames: ['provider', 'externalWorkspaceId'],
                isUnique: true,
            }),
        );

        // Owner-scoped list reads (settings UI / diagnostics).
        await queryRunner.createIndex(
            'ingest_install_bindings',
            new TableIndex({
                name: 'idx_ingest_install_bindings_user',
                columnNames: ['userId'],
            }),
        );

        await queryRunner.createForeignKey(
            'ingest_install_bindings',
            new TableForeignKey({
                name: 'fk_ingest_install_bindings_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ingest_install_bindings')) {
            await queryRunner.dropTable('ingest_install_bindings', true);
        }
    }
}
