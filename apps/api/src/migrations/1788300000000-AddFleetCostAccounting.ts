import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Fleet cost accounting + model identity (EW-777, self-build slice U).
 *
 * The defect this closes: a fleet node parsed the model CLI's
 * `total_cost_usd` and the reconciler spent it on one chat sentence.
 * `agent_runs.costCents` stayed NULL for every fleet run, the Goal spend
 * cap summed zeros, the Costs dashboard read $0.00 while six subscriptions
 * burned, and "max spend per run" was unenforceable. The reconciler now
 * records the spend the way a cloud run's is recorded; these columns are
 * what the DAILY ceilings and the billing identity need on top.
 *
 * Four independent, additive steps, each separately guarded so a partially
 * applied database converges rather than aborting:
 *
 *  1. `fleet_nodes.modelIdentity`        — which account / seat the node's
 *                                          agent CLI is logged in as (a
 *                                          display label, never a
 *                                          credential). NULL on every
 *                                          existing row and on rows written
 *                                          by daemons that predate the field;
 *                                          the heartbeat treats absent as
 *                                          "leave alone".
 *     `fleet_nodes.dailyCostCeilingCents` — per-node daily (UTC) model-spend
 *                                          ceiling; NULL = inherit the
 *                                          deployment default (unset by
 *                                          default = no ceiling, so nothing
 *                                          changes on upgrade).
 *     `fleet_nodes.dailyCostTrippedOn`    — `YYYY-MM-DD` the node was last
 *                                          drained by its ceiling: the
 *                                          one-notice-per-day CAS key.
 *  2. `fleet_jobs.costCents`             — the cents the job's run reported,
 *                                          stamped by the reconciler. NULL =
 *                                          no model ran, or the CLI printed
 *                                          no price. Plus the
 *                                          `(nodeId, completedAt)` index the
 *                                          per-node daily sum reads.
 *  3. `fleet_cost_policies`              — one row per owner: the fleet-wide
 *                                          daily ceiling and its trip marker.
 *
 * Portable DDL throughout (`TableColumn` / `Table` / `TableIndex`) because
 * the e2e stack and CI run better-sqlite3 while production runs Postgres.
 * Forward-only with guards; `down()` reverses every step.
 */
export class AddFleetCostAccounting1788300000000 implements MigrationInterface {
    name = 'AddFleetCostAccounting1788300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes) {
            if (!nodes.findColumnByName('modelIdentity')) {
                await queryRunner.addColumn(
                    'fleet_nodes',
                    new TableColumn({
                        name: 'modelIdentity',
                        type: 'varchar',
                        length: '200',
                        isNullable: true,
                    }),
                );
            }
            if (!nodes.findColumnByName('dailyCostCeilingCents')) {
                await queryRunner.addColumn(
                    'fleet_nodes',
                    new TableColumn({
                        name: 'dailyCostCeilingCents',
                        type: 'int',
                        isNullable: true,
                    }),
                );
            }
            if (!nodes.findColumnByName('dailyCostTrippedOn')) {
                await queryRunner.addColumn(
                    'fleet_nodes',
                    new TableColumn({
                        name: 'dailyCostTrippedOn',
                        type: 'varchar',
                        length: '10',
                        isNullable: true,
                    }),
                );
            }
        }

        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs) {
            if (!jobs.findColumnByName('costCents')) {
                await queryRunner.addColumn(
                    'fleet_jobs',
                    new TableColumn({ name: 'costCents', type: 'int', isNullable: true }),
                );
            }
            // The daily sums need `completedAt`, which the base table has
            // carried since `1784200000000-CreateFleetJobs`; guard anyway so
            // a stripped-down test schema does not abort the whole step.
            const hasIndex = jobs.indices.some(
                (index) => index.name === 'idx_fleet_jobs_node_completed',
            );
            if (
                !hasIndex &&
                jobs.findColumnByName('nodeId') &&
                jobs.findColumnByName('completedAt')
            ) {
                await queryRunner.createIndex(
                    'fleet_jobs',
                    new TableIndex({
                        name: 'idx_fleet_jobs_node_completed',
                        columnNames: ['nodeId', 'completedAt'],
                    }),
                );
            }
        }

        if (!(await queryRunner.hasTable('fleet_cost_policies'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_cost_policies',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        // NULL = inherit the deployment default.
                        { name: 'dailyCeilingCents', type: 'int', isNullable: true },
                        // `YYYY-MM-DD` — the one-notice-per-day CAS key.
                        { name: 'trippedOn', type: 'varchar', length: '10', isNullable: true },
                        { name: 'trippedAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            // UNIQUE, unlike `idx_fleet_exec_prefs_scope`: the key is one
            // NOT NULL column, so the index does enforce one row per owner.
            await queryRunner.createIndex(
                'fleet_cost_policies',
                new TableIndex({
                    name: 'uq_fleet_cost_policies_user',
                    columnNames: ['userId'],
                    isUnique: true,
                }),
            );

            // Guarded on the table existing: the migration must not
            // explode on a database whose user table is not there yet.
            if (await queryRunner.hasTable('users')) {
                await queryRunner.createForeignKey(
                    'fleet_cost_policies',
                    new TableForeignKey({
                        name: 'fk_fleet_cost_policies_user',
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_cost_policies')) {
            await queryRunner.dropTable('fleet_cost_policies', true);
        }
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs) {
            if (jobs.indices.some((index) => index.name === 'idx_fleet_jobs_node_completed')) {
                await queryRunner.dropIndex('fleet_jobs', 'idx_fleet_jobs_node_completed');
            }
            if (jobs.findColumnByName('costCents')) {
                await queryRunner.dropColumn('fleet_jobs', 'costCents');
            }
        }
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes) {
            for (const column of ['dailyCostTrippedOn', 'dailyCostCeilingCents', 'modelIdentity']) {
                if (nodes.findColumnByName(column)) {
                    await queryRunner.dropColumn('fleet_nodes', column);
                }
            }
        }
    }
}
