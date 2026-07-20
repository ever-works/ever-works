import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Teams & Prebuilt Companies — Phase 1 data model.
 *
 * Spec: [`docs/specs/features/teams-and-companies/spec.md` §2](../../../../docs/specs/features/teams-and-companies/spec.md)
 * Entities: `packages/agent/src/entities/team.entity.ts`,
 *           `packages/agent/src/entities/team-member.entity.ts`
 *
 * Creates:
 *   - `teams` — Tier A org-scoped grouping with self-referencing
 *     `parentTeamId` hierarchy (acyclicity is service-enforced; the FK is
 *     `SET NULL` so deleting a parent never deletes a subtree — the service
 *     re-parents children explicitly before delete).
 *   - `team_members` — Tier C polymorphic roster rows (`agent`|`user`).
 *     UNIQUE on `(teamId, memberType, memberId)`; `ON DELETE CASCADE`
 *     from `teams` so a team takes its roster with it.
 *   - `agents.reportsToAgentId` — additive nullable self-reference for the
 *     Org Chart / `AGENTS.md reportsTo:` import; `SET NULL` on manager
 *     delete (dangling manager ⇒ chart treats the agent as a root).
 *
 * Scope FKs (`tenantId`/`organizationId`) follow the Tier A/C house
 * convention from `1779991006000-AddTenantIdAndOrganizationIdToTierA`:
 * nullable, indexed, `ON DELETE SET NULL`.
 *
 * Forward-only + idempotent (`hasTable`/`hasColumn` guards) — same shape
 * as `1781300000000-AddTenantCredentialSnapshot`.
 */
export class CreateTeamsTables1781500000000 implements MigrationInterface {
    name = 'CreateTeamsTables1781500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('teams'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'teams',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'name', type: 'varchar', length: '200' },
                        { name: 'slug', type: 'varchar', length: '100' },
                        { name: 'description', type: 'text', isNullable: true },
                        { name: 'parentTeamId', type: 'uuid', isNullable: true },
                        { name: 'managerAgentId', type: 'uuid', isNullable: true },
                        { name: 'avatarIcon', type: 'varchar', length: '64', isNullable: true },
                        { name: 'metadata', type: 'text', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );

            // Slug is the portable identity of a team INSIDE one Organization
            // (agentcompanies/v1 semantics). NULL organizationId rows cannot
            // exist via the service (Teams are org-scoped in v1), so the
            // NULLs-are-distinct caveat of this composite unique is moot.
            await queryRunner.createIndex(
                'teams',
                new TableIndex({
                    name: 'uq_teams_org_slug',
                    columnNames: ['organizationId', 'slug'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'teams',
                new TableIndex({ name: 'idx_teams_user', columnNames: ['userId'] }),
            );
            await queryRunner.createIndex(
                'teams',
                new TableIndex({ name: 'idx_teams_parent', columnNames: ['parentTeamId'] }),
            );
            await queryRunner.createIndex(
                'teams',
                new TableIndex({ name: 'idx_teams_tenant', columnNames: ['tenantId'] }),
            );
            await queryRunner.createIndex(
                'teams',
                new TableIndex({ name: 'idx_teams_org', columnNames: ['organizationId'] }),
            );

            await queryRunner.createForeignKey(
                'teams',
                new TableForeignKey({
                    name: 'fk_teams_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'teams',
                new TableForeignKey({
                    name: 'fk_teams_parent',
                    columnNames: ['parentTeamId'],
                    referencedTableName: 'teams',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
            await queryRunner.createForeignKey(
                'teams',
                new TableForeignKey({
                    name: 'fk_teams_manager_agent',
                    columnNames: ['managerAgentId'],
                    referencedTableName: 'agents',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
            await queryRunner.createForeignKey(
                'teams',
                new TableForeignKey({
                    name: 'fk_teams_tenant',
                    columnNames: ['tenantId'],
                    referencedTableName: 'tenants',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
            await queryRunner.createForeignKey(
                'teams',
                new TableForeignKey({
                    name: 'fk_teams_organization',
                    columnNames: ['organizationId'],
                    referencedTableName: 'organizations',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }

        if (!(await queryRunner.hasTable('team_members'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'team_members',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'teamId', type: 'uuid' },
                        { name: 'memberType', type: 'varchar', length: '16' },
                        { name: 'memberId', type: 'uuid' },
                        { name: 'role', type: 'varchar', length: '16', default: "'member'" },
                        { name: 'addedById', type: 'uuid', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'team_members',
                new TableIndex({
                    name: 'uq_team_members_team_member',
                    columnNames: ['teamId', 'memberType', 'memberId'],
                    isUnique: true,
                }),
            );
            // Reverse lookup: "which teams does this agent/user sit in" —
            // drives the org-chart teamIds projection and agent-detail UI.
            await queryRunner.createIndex(
                'team_members',
                new TableIndex({
                    name: 'idx_team_members_member',
                    columnNames: ['memberType', 'memberId'],
                }),
            );

            await queryRunner.createForeignKey(
                'team_members',
                new TableForeignKey({
                    name: 'fk_team_members_team',
                    columnNames: ['teamId'],
                    referencedTableName: 'teams',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        if (!(await queryRunner.hasColumn('agents', 'reportsToAgentId'))) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({ name: 'reportsToAgentId', type: 'uuid', isNullable: true }),
            );
            await queryRunner.createIndex(
                'agents',
                new TableIndex({
                    name: 'idx_agents_reports_to',
                    columnNames: ['reportsToAgentId'],
                }),
            );
            await queryRunner.createForeignKey(
                'agents',
                new TableForeignKey({
                    name: 'fk_agents_reports_to_agent',
                    columnNames: ['reportsToAgentId'],
                    referencedTableName: 'agents',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('agents', 'reportsToAgentId')) {
            await queryRunner.dropColumn('agents', 'reportsToAgentId');
        }
        if (await queryRunner.hasTable('team_members')) {
            await queryRunner.dropTable('team_members', true);
        }
        if (await queryRunner.hasTable('teams')) {
            await queryRunner.dropTable('teams', true);
        }
    }
}
