import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Actions runners on computers (FL-18, CONTRACTS §4.11, §13 slot `1796180000000`).
 *
 * Entity: `packages/agent/src/entities/fleet-actions-runner.entity.ts` (new).
 *
 * ## `fleet_actions_runners`
 *
 * One row per GitHub Actions self-hosted runner on one Node. The CONTRACTS
 * §4.11 columns (`nodeId`, `name`, `scope`, `target`, `labels`, `mode`,
 * `state`, `githubRunnerId`, `lastSeenAt`, `installedAt`, `ownerUserId`) plus
 * the epic-local ones of plan §4.1 (installation, version, service unit,
 * folder, state source, owner stop, install phase, current job, last error,
 * last job, last check, soft remove).
 *
 * `labels` and `currentJob` are `simple-json` text (CONTRACTS §4 storage
 * types), enums are `varchar` validated in code. Foreign keys: `nodeId` →
 * `fleet_nodes` CASCADE (a runner means nothing without its computer — the
 * audit rows keep the history) and `ownerUserId` → `users` CASCADE. No key
 * into `github_app_installations`: an installation deleted at GitHub leaves
 * the row to say so, not to vanish.
 *
 * Indexes: `(nodeId)`, `(ownerUserId, state)`, `(installationEntityId)`, and a
 * unique `(nodeId, name)` among the rows not removed (a partial index — both
 * Postgres and SQLite support `WHERE`), so a removed runner's name may be used
 * again on the same computer.
 *
 * Forward-only with per-step guards (`hasTable` / index and FK names), so a
 * partially applied database converges; portable `Table` DDL because
 * production runs Postgres while CI and the e2e stack run better-sqlite3.
 * `down()` removes exactly what `up()` added.
 */
export class CreateFleetActionsRunners1796180000000 implements MigrationInterface {
    name = 'CreateFleetActionsRunners1796180000000';

    private static readonly TABLE = 'fleet_actions_runners';

    private static readonly INDEXES = [
        new TableIndex({ name: 'idx_fleet_actions_runners_node', columnNames: ['nodeId'] }),
        new TableIndex({
            name: 'idx_fleet_actions_runners_owner_state',
            columnNames: ['ownerUserId', 'state'],
        }),
        new TableIndex({
            name: 'idx_fleet_actions_runners_installation',
            columnNames: ['installationEntityId'],
        }),
        new TableIndex({
            name: 'uq_fleet_actions_runners_node_name',
            columnNames: ['nodeId', 'name'],
            isUnique: true,
            where: '"removedAt" IS NULL',
        }),
    ];

    private static readonly FOREIGN_KEYS = [
        new TableForeignKey({
            name: 'fk_fleet_actions_runners_node',
            columnNames: ['nodeId'],
            referencedTableName: 'fleet_nodes',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_fleet_actions_runners_owner',
            columnNames: ['ownerUserId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const table = CreateFleetActionsRunners1796180000000.TABLE;

        if (!(await queryRunner.hasTable(table))) {
            await queryRunner.createTable(
                new Table({
                    name: table,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'nodeId', type: 'uuid' },
                        { name: 'ownerUserId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'installationEntityId', type: 'uuid', isNullable: true },
                        { name: 'scope', type: 'varchar', length: '8' },
                        { name: 'target', type: 'varchar', length: '200' },
                        { name: 'name', type: 'varchar', length: '64' },
                        { name: 'labels', type: 'text' },
                        { name: 'mode', type: 'varchar', length: '16', default: "'service'" },
                        { name: 'state', type: 'varchar', length: '16', default: "'installing'" },
                        { name: 'stateSource', type: 'varchar', length: '8', isNullable: true },
                        { name: 'stoppedByOwner', type: 'boolean', default: false },
                        { name: 'phase', type: 'varchar', length: '24', isNullable: true },
                        { name: 'githubRunnerId', type: 'bigint', isNullable: true },
                        { name: 'runnerVersion', type: 'varchar', length: '32', isNullable: true },
                        { name: 'serviceUnit', type: 'varchar', length: '200', isNullable: true },
                        { name: 'installDir', type: 'varchar', length: '400' },
                        { name: 'currentJob', type: 'text', isNullable: true },
                        { name: 'lastError', type: 'varchar', length: '512', isNullable: true },
                        { name: 'lastJobId', type: 'uuid', isNullable: true },
                        { name: 'lastSeenAt', type: 'timestamp', isNullable: true },
                        { name: 'lastCheckAt', type: 'timestamp', isNullable: true },
                        { name: 'installedAt', type: 'timestamp', isNullable: true },
                        { name: 'removedAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        // Keys before indexes: SQLite adds a key by rebuilding the table, and the
        // indexes are created last so a rebuild never re-creates them.
        for (const foreignKey of CreateFleetActionsRunners1796180000000.FOREIGN_KEYS) {
            const current = await queryRunner.getTable(table);
            if (
                current &&
                !current.foreignKeys.some((existing) => existing.name === foreignKey.name)
            ) {
                await queryRunner.createForeignKey(table, foreignKey);
            }
        }
        for (const index of CreateFleetActionsRunners1796180000000.INDEXES) {
            const current = await queryRunner.getTable(table);
            if (current && !current.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(table, index);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable(CreateFleetActionsRunners1796180000000.TABLE)) {
            await queryRunner.dropTable(
                CreateFleetActionsRunners1796180000000.TABLE,
                true,
                true,
                true,
            );
        }
    }
}
