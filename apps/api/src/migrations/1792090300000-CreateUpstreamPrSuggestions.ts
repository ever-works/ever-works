import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * APW-09 T7 — `upstream_pr_suggestions`, FR-34's counters and the dismissal record
 * (plan §3.1B, G20).
 *
 * Slot `03` of APW-09's `179209` block (R-39, stamped in merge order: `00` is T43's
 * `AddWorkUpstreamCredentialMember`, `01` `CreateUpstreamPullRequests`, `02`
 * `CreateWorkUpstreamPrSettings`).
 *
 * Indexes: `uq_ups_task (taskId)` UNIQUE — at most one suggestion per Task;
 * `idx_ups_work_sent (workId, sentAt)` — the 3-per-App-Work-per-7-days window.
 * `workId → works(id)` ON DELETE CASCADE; `taskId` / `userId` are bare. Forward-only,
 * idempotent, portable: every step is guarded and there is no driver branch or raw statement.
 */
export class CreateUpstreamPrSuggestions1792090300000 implements MigrationInterface {
    name = 'CreateUpstreamPrSuggestions1792090300000';

    private static readonly TABLE = 'upstream_pr_suggestions';
    private static readonly UNIQUE_TASK = 'uq_ups_task';
    private static readonly INDEX_WORK_SENT = 'idx_ups_work_sent';
    private static readonly FK_WORK = 'fk_ups_work';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = CreateUpstreamPrSuggestions1792090300000.TABLE;

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
                        { name: 'taskId', type: 'uuid' },
                        { name: 'userId', type: 'uuid' },
                        { name: 'reason', type: 'varchar', length: '300', isNullable: true },
                        { name: 'sentAt', type: 'timestamp', isNullable: true },
                        { name: 'dismissedAt', type: 'timestamp', isNullable: true },
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

        const indexes = [
            new TableIndex({
                name: CreateUpstreamPrSuggestions1792090300000.UNIQUE_TASK,
                columnNames: ['taskId'],
                isUnique: true,
            }),
            new TableIndex({
                name: CreateUpstreamPrSuggestions1792090300000.INDEX_WORK_SENT,
                columnNames: ['workId', 'sentAt'],
            }),
        ];
        for (const index of indexes) {
            if (!created.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(table, index);
            }
        }

        if (
            !created.foreignKeys.some(
                (fk) => fk.name === CreateUpstreamPrSuggestions1792090300000.FK_WORK,
            )
        ) {
            await queryRunner.createForeignKey(
                table,
                new TableForeignKey({
                    name: CreateUpstreamPrSuggestions1792090300000.FK_WORK,
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    /** Drops the two indexes and then the table — nothing else, each step re-checked. */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = CreateUpstreamPrSuggestions1792090300000.TABLE;

        if (!(await queryRunner.hasTable(table))) {
            return;
        }

        const existing = await queryRunner.getTable(table);
        for (const name of [
            CreateUpstreamPrSuggestions1792090300000.UNIQUE_TASK,
            CreateUpstreamPrSuggestions1792090300000.INDEX_WORK_SENT,
        ]) {
            if (existing?.indices.some((index) => index.name === name)) {
                await queryRunner.dropIndex(table, name);
            }
        }

        await queryRunner.dropTable(table, true, true, true);
    }
}
