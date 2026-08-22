import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';

/**
 * Additive Fleet scheduling intent for strict Agent-to-node affinity.
 *
 * Identifiers deliberately have no cascading foreign keys: a binding or
 * historical job must never cause Agent, node, Organization, or job data to
 * be deleted as a side effect. The service validates ownership and active
 * Organization membership at the write boundary.
 */
export class CreateFleetAgentNodeAffinity1786940000000 implements MigrationInterface {
    name = 'CreateFleetAgentNodeAffinity1786940000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const jobs = await queryRunner.getTable('fleet_jobs');
        if (jobs && !jobs.findColumnByName('targetNodeId')) {
            await queryRunner.addColumn(
                'fleet_jobs',
                new TableColumn({ name: 'targetNodeId', type: 'uuid', isNullable: true }),
            );
        }

        const jobsWithTarget = await queryRunner.getTable('fleet_jobs');
        if (
            jobsWithTarget?.findColumnByName('targetNodeId') &&
            !jobsWithTarget.indices.some((index) => index.name === 'idx_fleet_jobs_target_status')
        ) {
            await queryRunner.createIndex(
                'fleet_jobs',
                new TableIndex({
                    name: 'idx_fleet_jobs_target_status',
                    columnNames: ['targetNodeId', 'status'],
                }),
            );
        }

        if (!(await queryRunner.hasTable('fleet_agent_node_affinities'))) {
            const isPostgres = queryRunner.connection.options.type === 'postgres';
            await queryRunner.createTable(
                new Table({
                    name: 'fleet_agent_node_affinities',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid' },
                        { name: 'agentId', type: 'uuid' },
                        { name: 'nodeId', type: 'uuid' },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        const affinities = await queryRunner.getTable('fleet_agent_node_affinities');
        if (
            affinities &&
            !affinities.indices.some((index) => index.name === 'uq_fleet_agent_node_affinity_scope')
        ) {
            await queryRunner.createIndex(
                'fleet_agent_node_affinities',
                new TableIndex({
                    name: 'uq_fleet_agent_node_affinity_scope',
                    columnNames: ['userId', 'organizationId', 'agentId'],
                    isUnique: true,
                }),
            );
        }
        if (
            affinities &&
            !affinities.indices.some((index) => index.name === 'idx_fleet_agent_node_affinity_node')
        ) {
            await queryRunner.createIndex(
                'fleet_agent_node_affinities',
                new TableIndex({
                    name: 'idx_fleet_agent_node_affinity_node',
                    columnNames: ['userId', 'nodeId'],
                }),
            );
        }
    }

    /**
     * Intentionally forward-only. Rolling application code back leaves the
     * nullable column and unused table in place, preserving every job and
     * operator binding for a later safe roll-forward.
     */
    public async down(_queryRunner: QueryRunner): Promise<void> {}
}
