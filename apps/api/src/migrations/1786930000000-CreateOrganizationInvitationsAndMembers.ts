import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Organization invitations — the `OrganizationMember` / `OrganizationInvitation`
 * pair deferred to v1.1 in
 * [`docs/specs/features/tenants-and-organizations/spec.md` §7](../../../../docs/specs/features/tenants-and-organizations/spec.md).
 *
 * Entities: `packages/agent/src/entities/organization-invitation.entity.ts`,
 *           `packages/agent/src/entities/organization-member.entity.ts`
 *
 * Creates:
 *   - `organization_invitations` — one live token per (Organization, email).
 *     Only `sha256(token)` is stored; the raw token is shown to the issuer
 *     once and is unrecoverable thereafter.
 *   - `organization_members` — the roster. NOT the authorization check:
 *     access is still `users.tenantId === organizations.tenantId`. See the
 *     entity docblock for why that was left alone.
 *
 * 🛑 This migration is the ONLY thing that creates these tables in
 * production. `DATABASE_AUTOMIGRATE` (TypeORM `synchronize`) is **true in
 * dev and stage but false in prod** — verified on the live Secrets — so a
 * defect here is invisible in both lower environments and surfaces only
 * after the prod deploy. Do not treat a green dev rollout as evidence that
 * this file is correct.
 *
 * Scope columns are NOT the nullable Tier-A/C denormalization: `tenantId` is
 * the scope key itself and `organizationId` is the parent, so both are NOT
 * NULL with `ON DELETE CASCADE`. Deleting an Organization takes its pending
 * invitations and its roster rows with it; it does NOT touch `users`.
 *
 * Forward-only and idempotent (`hasTable` guards), matching
 * `1781500000000-CreateTeamsTables`.
 */
export class CreateOrganizationInvitationsAndMembers1786930000000 implements MigrationInterface {
    name = 'CreateOrganizationInvitationsAndMembers1786930000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';
        const uuidDefault = isPostgres ? 'uuid_generate_v4()' : undefined;

        if (!(await queryRunner.hasTable('organization_invitations'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'organization_invitations',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: uuidDefault,
                        },
                        { name: 'organizationId', type: 'uuid' },
                        { name: 'tenantId', type: 'uuid' },
                        { name: 'email', type: 'varchar', length: '320' },
                        { name: 'emailNormalized', type: 'varchar', length: '320' },
                        { name: 'role', type: 'varchar', length: '32', default: "'member'" },
                        { name: 'tokenHash', type: 'varchar', length: '64' },
                        { name: 'tokenExpiresAt', type: 'timestamp' },
                        { name: 'invitedById', type: 'uuid' },
                        { name: 'status', type: 'varchar', length: '16', default: "'pending'" },
                        { name: 'acceptedByUserId', type: 'uuid', isNullable: true },
                        { name: 'acceptedAt', type: 'timestamp', isNullable: true },
                        { name: 'metadata', type: 'text', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'organization_invitations',
                new TableIndex({
                    name: 'idx_org_invitations_org',
                    columnNames: ['organizationId'],
                }),
            );
            await queryRunner.createIndex(
                'organization_invitations',
                new TableIndex({
                    name: 'uq_org_invitations_token_hash',
                    columnNames: ['tokenHash'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'organization_invitations',
                new TableIndex({
                    name: 'idx_org_invitations_status',
                    columnNames: ['status'],
                }),
            );
            // One LIVE invitation per person per Organization. Partial, so
            // re-inviting after a revoke or an expiry stays legal — a plain
            // unique index would make a revoked invite permanently block the
            // address. TypeORM emits the WHERE clause on Postgres and SQLite
            // alike; both support partial indexes.
            await queryRunner.createIndex(
                'organization_invitations',
                new TableIndex({
                    name: 'uq_org_invitations_pending_email',
                    columnNames: ['organizationId', 'emailNormalized'],
                    isUnique: true,
                    where: "status = 'pending'",
                }),
            );

            await queryRunner.createForeignKey(
                'organization_invitations',
                new TableForeignKey({
                    name: 'fk_org_invitations_org',
                    columnNames: ['organizationId'],
                    referencedTableName: 'organizations',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'organization_invitations',
                new TableForeignKey({
                    name: 'fk_org_invitations_tenant',
                    columnNames: ['tenantId'],
                    referencedTableName: 'tenants',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'organization_invitations',
                new TableForeignKey({
                    name: 'fk_org_invitations_invited_by',
                    columnNames: ['invitedById'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            // SET NULL, not CASCADE: deleting the accepting user must not
            // erase the record that the invitation was consumed.
            await queryRunner.createForeignKey(
                'organization_invitations',
                new TableForeignKey({
                    name: 'fk_org_invitations_accepted_by',
                    columnNames: ['acceptedByUserId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }

        if (!(await queryRunner.hasTable('organization_members'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'organization_members',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: uuidDefault,
                        },
                        { name: 'organizationId', type: 'uuid' },
                        { name: 'tenantId', type: 'uuid' },
                        { name: 'userId', type: 'uuid' },
                        { name: 'role', type: 'varchar', length: '32', default: "'member'" },
                        { name: 'invitedById', type: 'uuid', isNullable: true },
                        { name: 'invitationId', type: 'uuid', isNullable: true },
                        { name: 'joinedAt', type: 'timestamp' },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'organization_members',
                new TableIndex({
                    name: 'uq_org_members_org_user',
                    columnNames: ['organizationId', 'userId'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'organization_members',
                new TableIndex({ name: 'idx_org_members_org', columnNames: ['organizationId'] }),
            );
            await queryRunner.createIndex(
                'organization_members',
                new TableIndex({ name: 'idx_org_members_user', columnNames: ['userId'] }),
            );

            await queryRunner.createForeignKey(
                'organization_members',
                new TableForeignKey({
                    name: 'fk_org_members_org',
                    columnNames: ['organizationId'],
                    referencedTableName: 'organizations',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'organization_members',
                new TableForeignKey({
                    name: 'fk_org_members_tenant',
                    columnNames: ['tenantId'],
                    referencedTableName: 'tenants',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'organization_members',
                new TableForeignKey({
                    name: 'fk_org_members_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'organization_members',
                new TableForeignKey({
                    name: 'fk_org_members_invited_by',
                    columnNames: ['invitedById'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
            // SET NULL: an invitation row may be pruned; the membership it
            // produced must survive that.
            await queryRunner.createForeignKey(
                'organization_members',
                new TableForeignKey({
                    name: 'fk_org_members_invitation',
                    columnNames: ['invitationId'],
                    referencedTableName: 'organization_invitations',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }
    }

    /**
     * Drops only the two tables this migration created.
     *
     * Order matters: `organization_members.invitationId` references
     * `organization_invitations`, so the child goes first.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('organization_members')) {
            await queryRunner.dropTable('organization_members', true, true, true);
        }
        if (await queryRunner.hasTable('organization_invitations')) {
            await queryRunner.dropTable('organization_invitations', true, true, true);
        }
    }
}
