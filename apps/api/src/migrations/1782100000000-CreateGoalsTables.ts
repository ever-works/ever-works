import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Goals & Metrics — PR-8 (spec FR-9..FR-11;
 * `docs/specs/features/goals-and-metrics/spec.md`; domain-model
 * review §23.4).
 *
 * Creates the Goal entity family:
 *   - `goals`               — measurable targets (provider plugin id +
 *                             metric id + window, comparator + target
 *                             value, deadline, status, outcome).
 *   - `goal_metric_samples` — append-only per-Goal time series of
 *                             observed values.
 *   - `mission_goals`       — Mission ↔ Goal join with `isPrimary`
 *                             (at most one primary Goal per Mission).
 *
 * Column-type notes (mirrors 1779978001000-CreateMissionsTable):
 *   - `metricSource` is the entity's `simple-json` → created as
 *     `text` for dialect portability (test driver is sqlite; the
 *     entity transformer owns (de)serialization).
 *   - `currentValueAt` / `deadline` / `nextCheckAt` / `sampledAt`
 *     back `PortableDateColumn` (entity `type: Date`) → `timestamp`.
 *   - value columns are `float`.
 *
 * One-primary-per-Mission (FR-11) is enforced with a Postgres
 * PARTIAL unique index on `(missionId) WHERE "isPrimary" = true` —
 * TypeORM's `TableIndex` has a `where` option, but partial indexes
 * are Postgres-only, so it is gated on the driver here; on SQLite
 * (tests, synchronize-mode) the service layer
 * (`GoalsService.linkToMission`) is the enforcement.
 *
 * FKs are created separately from the tables (repo convention) and
 * everything is `hasTable`-guarded so the migration is idempotent
 * under dev resets / CI re-runs. Forward-only (Principle V).
 */
export class CreateGoalsTables1782100000000 implements MigrationInterface {
    name = 'CreateGoalsTables1782100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // ── goals ───────────────────────────────────────────────────
        if (!(await queryRunner.hasTable('goals'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'goals',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid', isNullable: false },
                        { name: 'title', type: 'varchar', length: '200', isNullable: false },
                        { name: 'description', type: 'text', isNullable: true },
                        {
                            // `simple-json` on the entity — stored as text so
                            // the migration stays dialect-portable.
                            name: 'metricSource',
                            type: 'text',
                            isNullable: false,
                        },
                        { name: 'comparator', type: 'varchar', length: '8', isNullable: false },
                        { name: 'targetValue', type: 'float', isNullable: false },
                        { name: 'unit', type: 'varchar', length: '32', isNullable: false },
                        { name: 'window', type: 'varchar', length: '16', isNullable: false },
                        { name: 'baselineValue', type: 'float', isNullable: true },
                        { name: 'currentValue', type: 'float', isNullable: true },
                        { name: 'currentValueAt', type: 'timestamp', isNullable: true },
                        { name: 'deadline', type: 'timestamp', isNullable: true },
                        {
                            name: 'checkFrequencyMinutes',
                            type: 'int',
                            isNullable: false,
                            default: 60,
                        },
                        { name: 'nextCheckAt', type: 'timestamp', isNullable: true },
                        {
                            name: 'status',
                            type: 'varchar',
                            length: '16',
                            isNullable: false,
                            default: "'draft'",
                        },
                        { name: 'outcome', type: 'varchar', length: '16', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                        {
                            name: 'updatedAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                }),
                true,
            );

            // "List my goals" dashboard query.
            await queryRunner.createIndex(
                'goals',
                new TableIndex({
                    name: 'idx_goals_user_status',
                    columnNames: ['userId', 'status'],
                }),
            );

            // Dispatcher due-scan: WHERE status='active' AND nextCheckAt <= now.
            await queryRunner.createIndex(
                'goals',
                new TableIndex({
                    name: 'idx_goals_status_next_check',
                    columnNames: ['status', 'nextCheckAt'],
                }),
            );

            await queryRunner.createForeignKey(
                'goals',
                new TableForeignKey({
                    name: 'fk_goals_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        // ── goal_metric_samples ─────────────────────────────────────
        if (!(await queryRunner.hasTable('goal_metric_samples'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'goal_metric_samples',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'goalId', type: 'uuid', isNullable: false },
                        { name: 'sampledAt', type: 'timestamp', isNullable: false },
                        { name: 'value', type: 'float', isNullable: false },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                }),
                true,
            );

            // Progress-history reads: per-Goal, time-ordered.
            await queryRunner.createIndex(
                'goal_metric_samples',
                new TableIndex({
                    name: 'idx_goal_metric_samples_goal_sampled',
                    columnNames: ['goalId', 'sampledAt'],
                }),
            );

            await queryRunner.createForeignKey(
                'goal_metric_samples',
                new TableForeignKey({
                    name: 'fk_goal_metric_samples_goal',
                    columnNames: ['goalId'],
                    referencedTableName: 'goals',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        // ── mission_goals ───────────────────────────────────────────
        if (!(await queryRunner.hasTable('mission_goals'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'mission_goals',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'missionId', type: 'uuid', isNullable: false },
                        { name: 'goalId', type: 'uuid', isNullable: false },
                        { name: 'userId', type: 'uuid', isNullable: false },
                        {
                            name: 'isPrimary',
                            type: 'boolean',
                            isNullable: false,
                            default: false,
                        },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                }),
                true,
            );

            // A Goal is attached to a Mission at most once.
            await queryRunner.createIndex(
                'mission_goals',
                new TableIndex({
                    name: 'uq_mission_goals_mission_goal',
                    columnNames: ['missionId', 'goalId'],
                    isUnique: true,
                }),
            );

            // Reverse lookup: "which Missions carry this Goal?".
            await queryRunner.createIndex(
                'mission_goals',
                new TableIndex({
                    name: 'idx_mission_goals_goal',
                    columnNames: ['goalId'],
                }),
            );

            // FR-11: at most ONE primary Goal per Mission. Partial
            // unique indexes are Postgres-only — SQLite (tests) relies
            // on the service-layer demote-then-promote in
            // GoalsService.linkToMission.
            if (queryRunner.connection.options.type === 'postgres') {
                await queryRunner.query(
                    `CREATE UNIQUE INDEX IF NOT EXISTS "uq_mission_goals_primary"
                     ON "mission_goals" ("missionId") WHERE "isPrimary" = true`,
                );
            }

            await queryRunner.createForeignKey(
                'mission_goals',
                new TableForeignKey({
                    name: 'fk_mission_goals_mission',
                    columnNames: ['missionId'],
                    referencedTableName: 'missions',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'mission_goals',
                new TableForeignKey({
                    name: 'fk_mission_goals_goal',
                    columnNames: ['goalId'],
                    referencedTableName: 'goals',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'mission_goals',
                new TableForeignKey({
                    name: 'fk_mission_goals_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Children first (FKs reference goals/missions/users).
        if (await queryRunner.hasTable('mission_goals')) {
            await queryRunner.dropTable('mission_goals', true);
        }
        if (await queryRunner.hasTable('goal_metric_samples')) {
            await queryRunner.dropTable('goal_metric_samples', true);
        }
        if (await queryRunner.hasTable('goals')) {
            await queryRunner.dropTable('goals', true);
        }
    }
}
