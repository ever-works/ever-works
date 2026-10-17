import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Fleet usage limits — a model CLI out of quota parks work instead of failing it.
 *
 * Prod, 2026-10-17: a run on one PC failed with Claude Code's "You've hit your
 * weekly limit · resets Oct 19, 3am", the node stayed online and kept leasing
 * agent-task jobs that failed the same way, and the Agent's error count
 * climbed until it was halted. The platform now parks such a job back in the
 * queue and keeps that node off that CLI's work until the reset. Two columns:
 *
 *  - `fleet_nodes.modelThrottles` (text) — the entity's `simple-json` list of
 *    `{ provider, window, until, reason, since }`, one per CLI the node's seat
 *    is out of quota on. The lease drops the throttled CLI's capability tag for
 *    the node until `until`. NULL = never throttled; no backfill.
 *  - `fleet_jobs.usageLimitParks` (int, default 0) — how many times the job was
 *    parked, the backstop (`FLEET_JOB_MAX_USAGE_LIMIT_PARKS`) that keeps a
 *    mis-recognised failure from requeueing forever. Existing rows start at 0.
 *
 * Forward-only with per-step guards so a partially applied database
 * converges; portable `TableColumn` DDL because the e2e stack and CI run
 * better-sqlite3 while production runs Postgres.
 */
export class AddFleetModelUsageLimits1795161700000 implements MigrationInterface {
    name = 'AddFleetModelUsageLimits1795161700000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes && !nodes.findColumnByName('modelThrottles')) {
            await queryRunner.addColumn(
                'fleet_nodes',
                new TableColumn({ name: 'modelThrottles', type: 'text', isNullable: true }),
            );
        }
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs && !jobs.findColumnByName('usageLimitParks')) {
            await queryRunner.addColumn(
                'fleet_jobs',
                new TableColumn({
                    name: 'usageLimitParks',
                    type: 'int',
                    isNullable: false,
                    default: 0,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs?.findColumnByName('usageLimitParks')) {
            await queryRunner.dropColumn('fleet_jobs', 'usageLimitParks');
        }
        const nodes = await queryRunner.getTable('fleet_nodes');
        if (nodes?.findColumnByName('modelThrottles')) {
            await queryRunner.dropColumn('fleet_nodes', 'modelThrottles');
        }
    }
}
