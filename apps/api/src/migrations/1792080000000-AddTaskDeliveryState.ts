import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * APW-08 T9 (plan §3.1, §3.5 slot `00`) — the App Works delivery chain's columns on `tasks`.
 *
 * | column                 | type             | what                                                            |
 * |------------------------|------------------|-----------------------------------------------------------------|
 * | `mergeCommitSha`       | varchar(64)      | the commit a Build/Deployment must contain                      |
 * | `deliveryState`        | varchar(24)      | one of `TASK_DELIVERY_STATES`; NULL = not tracked               |
 * | `deliveryBuildId`      | uuid             | the `work_builds.id` that decided the state (no FK)             |
 * | `deliveryDeploymentId` | uuid             | the `work_deployments.id` that decided it (no FK)               |
 * | `deliveryUpdatedAt`    | timestamp        | reconciler ordering, stalest first                              |
 * | `deliveryClosedById`   | uuid             | who chose **Close anyway**                                      |
 * | `followUpKey`          | varchar(120)     | APW08-G23's server-side dedup key of an automatic follow-up     |
 *
 * Indexes: `idx_tasks_delivery_due (deliveryState, deliveryUpdatedAt)` — the reconciler's scan;
 * `uq_tasks_work_merge_commit (workId, mergeCommitSha)` UNIQUE `WHERE "mergeCommitSha" IS NOT NULL`
 * — "a merge is recorded once" (S29) as a database guarantee; `uq_tasks_follow_up_key
 * (followUpKey)` UNIQUE — one automatic follow-up per failure record.
 *
 * ## `followUpKey` is here, not in slot `03`
 *
 * Plan §3.5 put `followUpKey` beside T54's `task_chat_messages` columns in slot `03`
 * (`AddTaskChatMessageKey`). The delivery chain needs the key and does not need T54's keyed
 * thread posts, so the key ships with the other delivery columns and slot `03` stays whole for
 * T54 (which then only touches `task_chat_messages`). Same column, same index name.
 *
 * ## Portable (APW08-G17)
 *
 * TypeORM renders a `TableIndex`'s `where` on PostgreSQL and the SQLite family (both support
 * partial indexes) and drops it on MySQL/MariaDB, which have none. There the plain unique index
 * is the **stronger** guarantee — NULLs are distinct inside a unique index on every driver, so a
 * Task with no merge commit never collides — and `TaskDeliveryService` also re-reads before its
 * first write. No `queryRunner.query(...)` and no driver branch beyond the date spelling, which
 * follows what TypeORM maps a `Date` column to (`timestamp` on Postgres, `datetime` elsewhere),
 * exactly as `1795110000000-AddTaskDatesAndEstimate` does.
 *
 * ## No backfill, forward-only, idempotent
 *
 * Every column is NULL on every existing row, which is what "not tracked" means: an existing Task
 * completes on merge exactly as before. Every step re-reads the table first (SQLite recreates it on
 * an added column), so a re-run is a no-op and `down()` drops exactly what `up()` added.
 */
export class AddTaskDeliveryState1792080000000 implements MigrationInterface {
    name = 'AddTaskDeliveryState1792080000000';

    static readonly TABLE = 'tasks';
    static readonly INDEX_DUE = 'idx_tasks_delivery_due';
    static readonly UNIQUE_MERGE = 'uq_tasks_work_merge_commit';
    static readonly UNIQUE_FOLLOW_UP = 'uq_tasks_follow_up_key';

    static dateType(driver: string): string {
        return driver === 'postgres' || driver === 'cockroachdb' ? 'timestamp' : 'datetime';
    }

    static columns(driver: string): TableColumn[] {
        const date = AddTaskDeliveryState1792080000000.dateType(driver);
        return [
            new TableColumn({ name: 'mergeCommitSha', type: 'varchar', length: '64', isNullable: true }),
            new TableColumn({ name: 'deliveryState', type: 'varchar', length: '24', isNullable: true }),
            new TableColumn({ name: 'deliveryBuildId', type: 'uuid', isNullable: true }),
            new TableColumn({ name: 'deliveryDeploymentId', type: 'uuid', isNullable: true }),
            new TableColumn({ name: 'deliveryUpdatedAt', type: date, isNullable: true }),
            new TableColumn({ name: 'deliveryClosedById', type: 'uuid', isNullable: true }),
            new TableColumn({ name: 'followUpKey', type: 'varchar', length: '120', isNullable: true }),
        ];
    }

    static indexes(): TableIndex[] {
        const C = AddTaskDeliveryState1792080000000;
        return [
            new TableIndex({ name: C.INDEX_DUE, columnNames: ['deliveryState', 'deliveryUpdatedAt'] }),
            new TableIndex({
                name: C.UNIQUE_MERGE,
                columnNames: ['workId', 'mergeCommitSha'],
                isUnique: true,
                where: '"mergeCommitSha" IS NOT NULL',
            }),
            new TableIndex({ name: C.UNIQUE_FOLLOW_UP, columnNames: ['followUpKey'], isUnique: true }),
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const C = AddTaskDeliveryState1792080000000;
        if (!(await queryRunner.getTable(C.TABLE))) return;

        for (const column of C.columns(queryRunner.connection.options.type)) {
            const table = await queryRunner.getTable(C.TABLE);
            if (table?.findColumnByName(column.name)) continue;
            await queryRunner.addColumn(C.TABLE, column);
        }

        for (const index of C.indexes()) {
            const table = await queryRunner.getTable(C.TABLE);
            if (!table || table.indices.some((existing) => existing.name === index.name)) continue;
            await queryRunner.createIndex(C.TABLE, index);
        }
    }

    /** Drops the three indexes, then the seven columns — nothing else. */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const C = AddTaskDeliveryState1792080000000;
        if (!(await queryRunner.getTable(C.TABLE))) return;

        for (const index of C.indexes()) {
            const table = await queryRunner.getTable(C.TABLE);
            const existing = table?.indices.find((entry) => entry.name === index.name);
            if (existing) await queryRunner.dropIndex(C.TABLE, existing);
        }
        for (const column of [...C.columns(queryRunner.connection.options.type)].reverse()) {
            const table = await queryRunner.getTable(C.TABLE);
            const existing = table?.findColumnByName(column.name);
            if (existing) await queryRunner.dropColumn(C.TABLE, existing);
        }
    }
}
