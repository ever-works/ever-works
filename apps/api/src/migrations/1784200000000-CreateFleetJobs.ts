import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fleet job runtime (Desktop PRD §6.2 / M4) — creates the `fleet_jobs`
 * table: the lease-able work queue whose "workers" are the machines the
 * owner enrolled in Fleet.
 *
 * Entity: `packages/agent/src/entities/fleet-job.entity.ts`
 * Service: `packages/agent/src/fleet/fleet-job.service.ts`
 * Contract: `packages/contracts/src/fleet/fleet-jobs.types.ts`
 *
 * **Schema notes:**
 *   - `status` / `kind` are deliberate varchars (not enums) so new
 *     shapes ship without schema changes — same convention as
 *     `fleet_nodes.kind` and `tenant_job_runtime_config.providerId`.
 *   - `idempotencyKey` (varchar(200), UNIQUE, NULLABLE) — a re-enqueue
 *     of the same logical job reuses the row rather than doubling the
 *     work onto the fleet. Every supported driver allows multiple NULLs
 *     under a unique index.
 *   - `nodeId` is a raw uuid with NO foreign key: deleting a node
 *     registration must not cascade away its job history, and a job
 *     whose node vanished has to stay reclaimable.
 *   - `payload` / `result` (text) — the entity's `simple-json` columns.
 *   - Three indexes, one per real access path: owner listing
 *     (`userId,status`), per-node load for the Fleet UI
 *     (`nodeId,status`), and the reclaim sweep (`status,leaseExpiresAt`).
 *   - FK `userId` → `users.id` ON DELETE CASCADE (a job is meaningless
 *     without its owner).
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1783900000000-CreateFleetNodes`.
 */
export class CreateFleetJobs1784200000000 implements MigrationInterface {
    name = 'CreateFleetJobs1784200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_jobs')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'fleet_jobs',
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
                    { name: 'nodeId', type: 'uuid', isNullable: true },
                    { name: 'kind', type: 'varchar', length: '32' },
                    { name: 'status', type: 'varchar', length: '16' },
                    { name: 'payload', type: 'text', isNullable: true },
                    { name: 'requiredCapabilities', type: 'text' },
                    { name: 'leaseExpiresAt', type: 'timestamp', isNullable: true },
                    { name: 'attempts', type: 'int', default: 0 },
                    { name: 'maxAttempts', type: 'int', default: 3 },
                    {
                        name: 'idempotencyKey',
                        type: 'varchar',
                        length: '200',
                        isNullable: true,
                    },
                    { name: 'result', type: 'text', isNullable: true },
                    { name: 'error', type: 'text', isNullable: true },
                    { name: 'startedAt', type: 'timestamp', isNullable: true },
                    { name: 'completedAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // Owner-scoped listing + the lease candidate scan.
        await queryRunner.createIndex(
            'fleet_jobs',
            new TableIndex({
                name: 'idx_fleet_jobs_user_status',
                columnNames: ['userId', 'status'],
            }),
        );

        // Per-node load for the Fleet settings page (busy/idle, current job).
        await queryRunner.createIndex(
            'fleet_jobs',
            new TableIndex({
                name: 'idx_fleet_jobs_node_status',
                columnNames: ['nodeId', 'status'],
            }),
        );

        // The expired-lease reclaim sweep.
        await queryRunner.createIndex(
            'fleet_jobs',
            new TableIndex({
                name: 'idx_fleet_jobs_lease_expiry',
                columnNames: ['status', 'leaseExpiresAt'],
            }),
        );

        // A re-enqueue of the same logical job must reuse the row.
        await queryRunner.createIndex(
            'fleet_jobs',
            new TableIndex({
                name: 'idx_fleet_jobs_idempotency',
                columnNames: ['idempotencyKey'],
                isUnique: true,
            }),
        );

        await queryRunner.createForeignKey(
            'fleet_jobs',
            new TableForeignKey({
                name: 'fk_fleet_jobs_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_jobs')) {
            await queryRunner.dropTable('fleet_jobs', true);
        }
    }
}
