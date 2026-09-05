import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Panic controls (EW-778, closes OPS-16 + security audit 2026-05-17 #25).
 *
 * Two tables:
 *
 *   - `fleet_kill_switch` — the GLOBAL STOP FLAG. A single row keyed
 *     `'global'`, SEEDED here so that a missing row can only ever mean
 *     "this migration has not run". `FleetKillSwitchService` treats a
 *     missing row (or any read failure) as STOPPED, so an API replica that
 *     boots ahead of the migration refuses dispatch until the row exists —
 *     that is the fail-closed contract, and this seed is what keeps it from
 *     being a permanent outage.
 *   - `fleet_audit` — append-only trail of every set / clear / drain-all /
 *     cancel-in-flight, carrying the actor and the time. The minimal shape
 *     the panic controls need; slice AQ extends it.
 *
 * Columns mirror `FleetKillSwitch` / `FleetAudit` in
 * `packages/agent/src/entities/`. `details` is `text` at the SQL level
 * (the entity column is `simple-json`) for dialect portability, the same
 * pattern as `tenant_job_runtime_audit.before/after`.
 *
 * Both FKs to `users` are `ON DELETE SET NULL` — an audit row and the
 * switch itself must survive the purge of the user who touched them — and
 * are guarded on `hasTable('users')` so the migration also runs against the
 * bare in-memory harness the spec uses. `fleet_audit.nodeId` deliberately
 * carries NO FK: history must outlive node deletion.
 *
 * Idempotent (`hasTable` guards, seed-if-absent); `down` drops both tables.
 */
export class CreateFleetKillSwitchAndAudit1788150000000 implements MigrationInterface {
    name = 'CreateFleetKillSwitchAndAudit1788150000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const hasUsers = await queryRunner.hasTable('users');

        if (!(await queryRunner.hasTable('fleet_kill_switch'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_kill_switch',
                    columns: [
                        { name: 'id', type: 'varchar', length: '32', isPrimary: true },
                        { name: 'stopped', type: 'boolean', default: false },
                        { name: 'reason', type: 'varchar', length: '500', isNullable: true },
                        { name: 'setByUserId', type: 'uuid', isNullable: true },
                        { name: 'setAt', type: 'timestamp', isNullable: true },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );

            if (hasUsers) {
                await queryRunner.createForeignKey(
                    'fleet_kill_switch',
                    new TableForeignKey({
                        name: 'fk_fleet_kill_switch_set_by',
                        columnNames: ['setByUserId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'SET NULL',
                    }),
                );
            }
        }

        // Seed the one row. Relying on the column defaults (rather than
        // spelling out `false`) keeps the statement identical on Postgres
        // and sqlite. INSERT-if-absent so a re-run never duplicates it.
        const existing: unknown[] = await queryRunner.query(
            `SELECT id FROM fleet_kill_switch WHERE id = 'global'`,
        );
        if (existing.length === 0) {
            await queryRunner.query(`INSERT INTO fleet_kill_switch (id) VALUES ('global')`);
        }

        if (!(await queryRunner.hasTable('fleet_audit'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_audit',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'action', type: 'varchar', length: '64' },
                        { name: 'actorUserId', type: 'uuid', isNullable: true },
                        { name: 'ownerUserId', type: 'uuid', isNullable: true },
                        { name: 'nodeId', type: 'uuid', isNullable: true },
                        { name: 'details', type: 'text', isNullable: true },
                        { name: 'occurredAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );

            if (hasUsers) {
                await queryRunner.createForeignKey(
                    'fleet_audit',
                    new TableForeignKey({
                        name: 'fk_fleet_audit_actor',
                        columnNames: ['actorUserId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'SET NULL',
                    }),
                );
            }
        }

        const audit = await queryRunner.getTable('fleet_audit');
        if (
            audit &&
            !audit.indices.some((index) => index.name === 'idx_fleet_audit_owner_occurred')
        ) {
            await queryRunner.createIndex(
                'fleet_audit',
                new TableIndex({
                    name: 'idx_fleet_audit_owner_occurred',
                    columnNames: ['ownerUserId', 'occurredAt'],
                }),
            );
        }
        if (
            audit &&
            !audit.indices.some((index) => index.name === 'idx_fleet_audit_action_occurred')
        ) {
            await queryRunner.createIndex(
                'fleet_audit',
                new TableIndex({
                    name: 'idx_fleet_audit_action_occurred',
                    columnNames: ['action', 'occurredAt'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_audit')) {
            await queryRunner.dropTable('fleet_audit', true);
        }
        if (await queryRunner.hasTable('fleet_kill_switch')) {
            await queryRunner.dropTable('fleet_kill_switch', true);
        }
    }
}
