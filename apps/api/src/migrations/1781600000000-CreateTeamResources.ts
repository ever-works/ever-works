import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Teams & Prebuilt Companies — Team ↔ resource association table.
 *
 * Spec: operator ask "some Works belong to some Teams" — generalized to
 * Works / Tasks / Agents / Missions / Ideas.
 * Entity: `packages/agent/src/entities/team-resource.entity.ts`.
 *
 * Creates:
 *   - `team_resources` — Tier C polymorphic edge rows (`resourceType` ∈
 *     work|task|agent|mission|idea, `resourceId` → the matching table).
 *     UNIQUE on `(teamId, resourceType, resourceId)` so a resource can't be
 *     attached to the same Team twice; a secondary `(resourceType,
 *     resourceId)` index drives the reverse "which teams own this resource"
 *     lookup. `ON DELETE CASCADE` from `teams` so a Team takes its
 *     associations with it. Resource existence + tenancy is validated in
 *     `TeamResourcesService` (no polymorphic FK possible).
 *
 * Scope FKs (`tenantId`/`organizationId`) follow the Tier C house
 * convention: nullable, `ON DELETE SET NULL`.
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1781500000000-CreateTeamsTables`.
 */
export class CreateTeamResources1781600000000 implements MigrationInterface {
    name = 'CreateTeamResources1781600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('team_resources')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'team_resources',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'teamId', type: 'uuid' },
                    { name: 'resourceType', type: 'varchar', length: '16' },
                    { name: 'resourceId', type: 'uuid' },
                    { name: 'addedById', type: 'uuid', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'team_resources',
            new TableIndex({
                name: 'uq_team_resources_team_resource',
                columnNames: ['teamId', 'resourceType', 'resourceId'],
                isUnique: true,
            }),
        );
        // Reverse lookup: "which teams own this Work/Agent/…" — drives the
        // GET /organizations/:orgId/resource-teams endpoint + resource-detail UI.
        await queryRunner.createIndex(
            'team_resources',
            new TableIndex({
                name: 'idx_team_resources_resource',
                columnNames: ['resourceType', 'resourceId'],
            }),
        );

        await queryRunner.createForeignKey(
            'team_resources',
            new TableForeignKey({
                name: 'fk_team_resources_team',
                columnNames: ['teamId'],
                referencedTableName: 'teams',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
        await queryRunner.createForeignKey(
            'team_resources',
            new TableForeignKey({
                name: 'fk_team_resources_tenant',
                columnNames: ['tenantId'],
                referencedTableName: 'tenants',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );
        await queryRunner.createForeignKey(
            'team_resources',
            new TableForeignKey({
                name: 'fk_team_resources_organization',
                columnNames: ['organizationId'],
                referencedTableName: 'organizations',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('team_resources')) {
            await queryRunner.dropTable('team_resources', true);
        }
    }
}
