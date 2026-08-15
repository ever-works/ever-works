import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fleet local-runner polish — node telemetry, the queued-reason token and
 * the execution-preference table.
 *
 * Four independent, additive steps. They ship as one migration because
 * they land one feature; each is separately guarded so a partially
 * applied database converges rather than aborting.
 *
 *  1. `fleet_nodes.cliVersion`      — version of the AGENT CLI installed
 *                                     on the machine, distinct from
 *                                     `version` (the daemon's own).
 *                                     NULL on every existing row and on
 *                                     rows written by daemons that
 *                                     predate the field; the heartbeat
 *                                     treats absent as "leave alone", so
 *                                     an old daemon keeps working and
 *                                     never clears a newer reading.
 *  2. `fleet_nodes.diskFreeBytes`   — free bytes on the node's workspace
 *                                     volume. `bigint`, because a modern
 *                                     volume overflows int32 by three
 *                                     orders of magnitude.
 *  3. `fleet_jobs.queuedReason`     — why a queued job has not started.
 *                                     Today only `waiting-for-runner`.
 *                                     Cleared by the lease CAS, which
 *                                     already writes the row.
 *  4. `fleet_execution_preferences` — per Work / Goal / account choice of
 *                                     local runner vs cloud.
 *
 * Plus the `fleet_runner_fallback` notification event type, mirroring
 * `1784600000000-CreateEscalationsAndReviewRejections`: the same rows are
 * bootstrapped at boot by `NotificationEventTypeBootstrap` for
 * SQLite/CI (where migrations do not run), and inserted here for
 * Postgres.
 *
 * Portable DDL throughout — the e2e stack and CI run better-sqlite3 while
 * production runs Postgres, so the table is built with TypeORM's
 * `Table`/`TableIndex`/`TableForeignKey` API rather than raw SQL.
 *
 * NOTE on `idx_fleet_exec_prefs_scope`: deliberately NOT unique. The
 * account-wide row carries a NULL `scopeId`, and neither engine treats
 * NULLs as equal in a unique index — so a unique index would enforce
 * nothing for exactly the row most likely to be double-written while
 * implying that it did. The invariant is held by
 * `FleetExecutionPreferenceRepository.upsert` (find-then-save), and
 * `resolveFleetExecutionMode` resolves deterministically even if a
 * duplicate ever appears.
 */
export class FleetRunnerTelemetryAndRouting1785100000000 implements MigrationInterface {
    name = 'FleetRunnerTelemetryAndRouting1785100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes) {
            if (!nodes.findColumnByName('cliVersion')) {
                await queryRunner.query(
                    `ALTER TABLE "fleet_nodes" ADD COLUMN "cliVersion" varchar(64)`,
                );
            }
            if (!nodes.findColumnByName('diskFreeBytes')) {
                await queryRunner.query(
                    `ALTER TABLE "fleet_nodes" ADD COLUMN "diskFreeBytes" bigint`,
                );
            }
        }

        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs && !jobs.findColumnByName('queuedReason')) {
            await queryRunner.query(
                `ALTER TABLE "fleet_jobs" ADD COLUMN "queuedReason" varchar(64)`,
            );
        }

        if (!(await queryRunner.hasTable('fleet_execution_preferences'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_execution_preferences',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        // 'user' | 'work' | 'goal'
                        { name: 'scopeType', type: 'varchar', length: '16' },
                        // The Work / Goal id. NULL for the account-wide row.
                        // No FK on purpose: a preference is advisory, and a
                        // row left behind by a deleted Work simply stops
                        // matching rather than blocking the delete.
                        { name: 'scopeId', type: 'uuid', isNullable: true },
                        // 'local-wait' | 'local-fallback' | 'cloud'
                        { name: 'mode', type: 'varchar', length: '24' },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'fleet_execution_preferences',
                new TableIndex({
                    name: 'idx_fleet_exec_prefs_user',
                    columnNames: ['userId'],
                }),
            );
            await queryRunner.createIndex(
                'fleet_execution_preferences',
                new TableIndex({
                    name: 'idx_fleet_exec_prefs_scope',
                    columnNames: ['userId', 'scopeType', 'scopeId'],
                }),
            );

            // Guarded on the table existing: the migration must not
            // explode on a database whose user table is not there yet.
            if (await queryRunner.hasTable('users')) {
                await queryRunner.createForeignKey(
                    'fleet_execution_preferences',
                    new TableForeignKey({
                        name: 'fk_fleet_exec_prefs_user',
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                );
            }
        }

        if (await queryRunner.hasTable('notification_event_types')) {
            await queryRunner.query(
                `INSERT INTO notification_event_types
                   (key, category, title, description, urgent, "defaultChannels", source, "pluginId", "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, $4, false, $5::jsonb, 'core', NULL, now(), now())
                 ON CONFLICT (key) DO NOTHING`,
                [
                    'fleet_runner_fallback',
                    'agent',
                    'Local runner fallback',
                    'A run that preferred your local runner was executed in the cloud instead, because no runner could take it.',
                    JSON.stringify(['in-app']),
                ],
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('notification_event_types')) {
            await queryRunner.query(
                `DELETE FROM "notification_event_types" WHERE "key" = 'fleet_runner_fallback'`,
            );
        }
        if (await queryRunner.hasTable('fleet_execution_preferences')) {
            await queryRunner.dropTable('fleet_execution_preferences', true);
        }
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs?.findColumnByName('queuedReason')) {
            await queryRunner.query(`ALTER TABLE "fleet_jobs" DROP COLUMN "queuedReason"`);
        }
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes) {
            for (const col of ['diskFreeBytes', 'cliVersion']) {
                if (nodes.findColumnByName(col)) {
                    await queryRunner.query(`ALTER TABLE "fleet_nodes" DROP COLUMN "${col}"`);
                }
            }
        }
    }
}
