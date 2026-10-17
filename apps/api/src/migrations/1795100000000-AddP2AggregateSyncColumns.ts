import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Sync columns on the Phase 2 aggregates (integration plan EW-P2-1 / -2 / -5):
 * `work_proposals` (Ideas), `goals` and `missions`.
 *
 * - `version int NOT NULL DEFAULT 1` — the column the P1 aggregates got in
 *   `1795052100000-CreateDomainEventsOutbox` (`docs/specs/features/domain-events/spec.md`
 *   §4). Every existing row starts at 1; `DomainEventRecorder.bumpAggregateVersion`
 *   increments it at each recorded change, so `idea.*`, `goal.*` and `mission.*`
 *   events carry an ordered `aggregate.version`.
 * - `createdByType varchar(16) NULL` + `createdById varchar(64) NULL` — who created
 *   the record when it was not the owning user (`integration` + the integration key
 *   id for an integration write). NULL on every existing row, which reads as "the
 *   owner created it" (the integration DTO's `createdBy`).
 *
 * Additive and idempotent: each column is guarded, so a partially applied database
 * converges. `down` drops the columns.
 */
export class AddP2AggregateSyncColumns1795100000000 implements MigrationInterface {
    name = 'AddP2AggregateSyncColumns1795100000000';

    /** The P2 aggregates. */
    static readonly TABLES: readonly string[] = ['work_proposals', 'goals', 'missions'];

    static columns(): TableColumn[] {
        return [
            new TableColumn({ name: 'version', type: 'int', default: 1, isNullable: false }),
            new TableColumn({
                name: 'createdByType',
                type: 'varchar',
                length: '16',
                isNullable: true,
            }),
            new TableColumn({
                name: 'createdById',
                type: 'varchar',
                length: '64',
                isNullable: true,
            }),
        ];
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of AddP2AggregateSyncColumns1795100000000.TABLES) {
            for (const column of AddP2AggregateSyncColumns1795100000000.columns()) {
                const table = await queryRunner.getTable(tableName);
                if (table && !table.findColumnByName(column.name)) {
                    await queryRunner.addColumn(tableName, column);
                }
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const tableName of AddP2AggregateSyncColumns1795100000000.TABLES) {
            for (const column of AddP2AggregateSyncColumns1795100000000.columns().reverse()) {
                const table = await queryRunner.getTable(tableName);
                if (table?.findColumnByName(column.name)) {
                    await queryRunner.dropColumn(tableName, column.name);
                }
            }
        }
    }
}
