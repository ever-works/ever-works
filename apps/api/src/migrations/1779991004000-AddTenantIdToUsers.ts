import { MigrationInterface, QueryRunner, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * EW-654 (Tenants & Organizations Phase 2) — adds the User → Tenant FK
 * and the "remember the user's currently-active scope" column.
 *
 * Adds two nullable columns to `users`:
 *
 *   - `tenantId` — FK to `tenants(id)` ON DELETE SET NULL. NULL until
 *     the user creates their first Organization (Phase 6 lazy-create
 *     fills it in).
 *   - `lastScopeOrganizationId` — FK to `organizations(id)` ON DELETE
 *     SET NULL. NULL means "default to bare-Tenant view on next login"
 *     ([spec.md §5.6](../../../../docs/specs/features/tenants-and-organizations/spec.md#56-default-organization-on-next-login)).
 *     The Phase 6 Org-create flow sets it on first-Org "Upgrade
 *     current account" so subsequent logins land in the Org's scope.
 *
 * Both columns are nullable and there is **no backfill**. Existing
 * users keep working with both columns NULL until they create their
 * first Organization. See
 * [plan.md Phase 2](../../../../docs/specs/features/tenants-and-organizations/plan.md#phase-2--add-tenantid-to-users-add-tenantid-to-tier-b-entities).
 *
 * Forward-only, additive, idempotent (gates on `hasColumn`).
 */
export class AddTenantIdToUsers1779991004000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('users', 'tenantId'))) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({ name: 'tenantId', type: 'uuid', isNullable: true }),
            );
        }

        if (!(await queryRunner.hasColumn('users', 'lastScopeOrganizationId'))) {
            await queryRunner.addColumn(
                'users',
                new TableColumn({
                    name: 'lastScopeOrganizationId',
                    type: 'uuid',
                    isNullable: true,
                }),
            );
        }

        const users = await queryRunner.getTable('users');

        // FK on tenantId → tenants(id).
        const hasTenantFk = users?.foreignKeys.some((fk) => fk.name === 'fk_users_tenant');
        if (!hasTenantFk) {
            await queryRunner.createForeignKey(
                'users',
                new TableForeignKey({
                    name: 'fk_users_tenant',
                    columnNames: ['tenantId'],
                    referencedTableName: 'tenants',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }

        // FK on lastScopeOrganizationId → organizations(id).
        const hasLastScopeFk = users?.foreignKeys.some(
            (fk) => fk.name === 'fk_users_last_scope_organization',
        );
        if (!hasLastScopeFk) {
            await queryRunner.createForeignKey(
                'users',
                new TableForeignKey({
                    name: 'fk_users_last_scope_organization',
                    columnNames: ['lastScopeOrganizationId'],
                    referencedTableName: 'organizations',
                    referencedColumnNames: ['id'],
                    onDelete: 'SET NULL',
                }),
            );
        }

        const usersAfterFk = await queryRunner.getTable('users');
        const hasTenantIdx = usersAfterFk?.indices.some((i) => i.name === 'idx_users_tenant_id');
        if (!hasTenantIdx) {
            await queryRunner.createIndex(
                'users',
                new TableIndex({ name: 'idx_users_tenant_id', columnNames: ['tenantId'] }),
            );
        }
        const hasLastScopeIdx = usersAfterFk?.indices.some(
            (i) => i.name === 'idx_users_last_scope_organization_id',
        );
        if (!hasLastScopeIdx) {
            await queryRunner.createIndex(
                'users',
                new TableIndex({
                    name: 'idx_users_last_scope_organization_id',
                    columnNames: ['lastScopeOrganizationId'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const users = await queryRunner.getTable('users');

        if (users?.indices.some((i) => i.name === 'idx_users_last_scope_organization_id')) {
            await queryRunner.dropIndex('users', 'idx_users_last_scope_organization_id');
        }
        if (users?.indices.some((i) => i.name === 'idx_users_tenant_id')) {
            await queryRunner.dropIndex('users', 'idx_users_tenant_id');
        }

        const lastScopeFk = users?.foreignKeys.find(
            (fk) => fk.name === 'fk_users_last_scope_organization',
        );
        if (lastScopeFk) {
            await queryRunner.dropForeignKey('users', lastScopeFk);
        }
        const tenantFk = users?.foreignKeys.find((fk) => fk.name === 'fk_users_tenant');
        if (tenantFk) {
            await queryRunner.dropForeignKey('users', tenantFk);
        }

        if (await queryRunner.hasColumn('users', 'lastScopeOrganizationId')) {
            await queryRunner.dropColumn('users', 'lastScopeOrganizationId');
        }
        if (await queryRunner.hasColumn('users', 'tenantId')) {
            await queryRunner.dropColumn('users', 'tenantId');
        }
    }
}
