import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-09 T7 — `work_upstream_pr_settings`, the Upstream pull requests toggle's in-flight
 * state (plan §3.1A, G07 / FR-48). The App spec stays the source of truth; this row records
 * the request, the App spec change that carries it and the value read back once it merged.
 *
 * Slot `02` of APW-09's `179209` block (R-39: slot `00` is T43's
 * `AddWorkUpstreamCredentialMember`, slot `01` is `CreateUpstreamPullRequests`).
 *
 * One row per App Work (`uq_wups_work`); `workId → works(id)` ON DELETE CASCADE. Scope
 * columns are plain uuids. Forward-only, idempotent, portable: every step is guarded and
 * there is no driver branch or raw statement.
 */
export class CreateWorkUpstreamPrSettings1792090200000 implements MigrationInterface {
    name = 'CreateWorkUpstreamPrSettings1792090200000';

    private static readonly TABLE = 'work_upstream_pr_settings';
    private static readonly UNIQUE_WORK = 'uq_wups_work';
    private static readonly FK_WORK = 'fk_wups_work';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = CreateWorkUpstreamPrSettings1792090200000.TABLE;

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
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'workId', type: 'uuid' },
                        { name: 'requestedEnabled', type: 'boolean' },
                        { name: 'requestedById', type: 'uuid' },
                        { name: 'requestedAt', type: 'timestamp' },
                        { name: 'changeBranch', type: 'varchar', length: '255', isNullable: true },
                        { name: 'changeNumber', type: 'int', isNullable: true },
                        { name: 'changeUrl', type: 'varchar', length: '512', isNullable: true },
                        { name: 'appliedValue', type: 'boolean', isNullable: true },
                        { name: 'appliedAt', type: 'timestamp', isNullable: true },
                        { name: 'refusalCode', type: 'varchar', length: '32', isNullable: true },
                        { name: 'refusalDetail', type: 'varchar', length: '500', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const created = await queryRunner.getTable(table);
        if (!created) {
            return;
        }

        if (
            !created.indices.some(
                (index) => index.name === CreateWorkUpstreamPrSettings1792090200000.UNIQUE_WORK,
            )
        ) {
            await queryRunner.createIndex(
                table,
                new TableIndex({
                    name: CreateWorkUpstreamPrSettings1792090200000.UNIQUE_WORK,
                    columnNames: ['workId'],
                    isUnique: true,
                }),
            );
        }

        if (
            !created.foreignKeys.some(
                (fk) => fk.name === CreateWorkUpstreamPrSettings1792090200000.FK_WORK,
            )
        ) {
            await queryRunner.createForeignKey(
                table,
                new TableForeignKey({
                    name: CreateWorkUpstreamPrSettings1792090200000.FK_WORK,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /** Drops the one index and then the table — nothing else, each step re-checked. */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = CreateWorkUpstreamPrSettings1792090200000.TABLE;

        if (!(await queryRunner.hasTable(table))) {
            return;
        }

        const existing = await queryRunner.getTable(table);
        if (
            existing?.indices.some(
                (index) => index.name === CreateWorkUpstreamPrSettings1792090200000.UNIQUE_WORK,
            )
        ) {
            await queryRunner.dropIndex(
                table,
                CreateWorkUpstreamPrSettings1792090200000.UNIQUE_WORK,
            );
        }

        await queryRunner.dropTable(table, true, true, true);
    }
}
