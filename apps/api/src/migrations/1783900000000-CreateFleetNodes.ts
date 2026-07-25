import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Fleet (Wave 12, slice 1) — creates the `fleet_nodes` table backing
 * the node registry: machines the owner enrolls to execute their work
 * (desktop nodes / headless nodes). Nodes of user-configured clusters
 * are merged into list responses LIVE and are intentionally absent
 * here — nothing cluster-side is ever persisted, and platform-operated
 * shared clusters are structurally excluded from Fleet.
 *
 * Entity: `packages/agent/src/entities/fleet-node.entity.ts`
 * Service: `packages/agent/src/fleet/fleet.service.ts`
 *
 * **Schema notes:**
 *   - `enrollmentTokenHash` (varchar(128), UNIQUE, NULLABLE) — sha256
 *     hex of the CURRENT credential: the one-time enrollment token
 *     while `status = 'enrolling'`, the node heartbeat secret once
 *     enrolled (the enroll CAS swaps it atomically). Plaintext never
 *     touches the database. Unique so credential lookup is exact and
 *     random-collision-free; every supported driver allows multiple
 *     NULLs under a unique index.
 *   - `capabilities` (text) — the entity's `simple-json` tag array
 *     ('terminal', 'workspace', 'docker', ...).
 *   - `status` / `kind` are deliberate varchar(16)s (not enums) so new
 *     shapes ship without schema changes — same convention as
 *     `tenant_job_runtime_config.providerId`.
 *   - Scope columns (`organizationId`) are raw uuid references — no
 *     entity-level @ManyToOne (cycle avoidance per EW-654).
 *   - FK `userId` → `users.id` ON DELETE CASCADE (a node registration
 *     is meaningless without its owner).
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1783800000000-CreateMeetings`.
 */
export class CreateFleetNodes1783900000000 implements MigrationInterface {
    name = 'CreateFleetNodes1783900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_nodes')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'fleet_nodes',
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
                    { name: 'name', type: 'varchar', length: '200' },
                    { name: 'kind', type: 'varchar', length: '16' },
                    { name: 'status', type: 'varchar', length: '16' },
                    {
                        name: 'enrollmentTokenHash',
                        type: 'varchar',
                        length: '128',
                        isNullable: true,
                    },
                    { name: 'lastHeartbeatAt', type: 'timestamp', isNullable: true },
                    { name: 'capabilities', type: 'text' },
                    { name: 'platform', type: 'varchar', length: '64', isNullable: true },
                    { name: 'version', type: 'varchar', length: '32', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // Owner-scoped list reads (Fleet settings page, chat tool).
        await queryRunner.createIndex(
            'fleet_nodes',
            new TableIndex({
                name: 'idx_fleet_nodes_user',
                columnNames: ['userId'],
            }),
        );

        // Exact credential-hash lookup at enroll + heartbeat; unique so
        // two nodes can never share a credential.
        await queryRunner.createIndex(
            'fleet_nodes',
            new TableIndex({
                name: 'idx_fleet_nodes_credential',
                columnNames: ['enrollmentTokenHash'],
                isUnique: true,
            }),
        );

        await queryRunner.createForeignKey(
            'fleet_nodes',
            new TableForeignKey({
                name: 'fk_fleet_nodes_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('fleet_nodes')) {
            await queryRunner.dropTable('fleet_nodes', true);
        }
    }
}
