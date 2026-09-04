import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Agent execution v2 (slice B) — `fleet_jobs.cancelRequestedAt`.
 *
 * A fleet node is reached outbound-only, so an operator cannot cancel a
 * job a node already holds by calling the node. The request is recorded
 * here instead, and `FleetJobService.heartbeatJob` refuses the node's
 * next job heartbeat — the very "lease lost" signal the node already
 * aborts on. The node then reports, and the row settles with its verdict.
 *
 * Additive, nullable, no index: it is read on the heartbeat path by
 * primary key only. Every existing row reads NULL ("no cancel
 * requested"), which is the correct history. Forward-only with a guard
 * so a partially applied database converges; portable `TableColumn` DDL
 * because the e2e stack and CI run better-sqlite3 while production runs
 * Postgres.
 */
export class AddFleetJobCancelRequestedAt1787700000000 implements MigrationInterface {
    name = 'AddFleetJobCancelRequestedAt1787700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs && !jobs.findColumnByName('cancelRequestedAt')) {
            await queryRunner.addColumn(
                'fleet_jobs',
                new TableColumn({ name: 'cancelRequestedAt', type: 'timestamp', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs?.findColumnByName('cancelRequestedAt')) {
            await queryRunner.dropColumn('fleet_jobs', 'cancelRequestedAt');
        }
    }
}
