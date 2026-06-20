import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

/**
 * EW-752 P5.1 (T35a) — creates the `tenant_runtime_provider_allowlist`
 * table that backs the per-tenant runtime provider whitelist overlay.
 * Behaviour is gated at the application layer behind
 * `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING`; when the flag is OFF
 * the table is ignored, so this migration is safe to roll out ahead of
 * the feature flip.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §10 P5.1](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 *
 * Columns mirror `TenantRuntimeProviderAllowlist` entity in
 * `packages/agent/src/entities/tenant-runtime-provider-allowlist.entity.ts`.
 *
 * **Schema:**
 *   - Composite PK `(tenantId, providerId)` — one row per (tenant,
 *     provider) tuple. Re-inserting the same row is a PK conflict, which
 *     is what callers want (the PUT endpoint clears the tenant's existing
 *     rows inside the same transaction before inserting the new set).
 *   - `providerId` is `varchar(64)` to match the same convention used by
 *     `tenant_job_runtime_config.providerId` (EW-665) so adding a new
 *     provider never needs a type-altering migration.
 *   - `createdBy` → `users.id` with `ON DELETE SET NULL` so a row
 *     survives the originating user being purged.
 *   - `tenantId` → `tenants.id` with `ON DELETE CASCADE` so removing a
 *     tenant takes the per-tenant allow-list with it.
 *   - No `updatedAt` — rows are immutable; the PUT endpoint
 *     delete-and-inserts inside a transaction.
 *   - No additional indexes — the composite PK already covers the only
 *     two access patterns (lookup by tenant; lookup by tenant+provider).
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1780900000000-AddTenantJobRuntimeConfig` and `1781000000000-AddTenantJobRuntimeAudit`.
 */
export class AddTenantRuntimeProviderAllowlist1781100000000 implements MigrationInterface {
    name = 'AddTenantRuntimeProviderAllowlist1781100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tenant_runtime_provider_allowlist')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'tenant_runtime_provider_allowlist',
                columns: [
                    {
                        name: 'tenantId',
                        type: 'uuid',
                        isPrimary: true,
                    },
                    {
                        name: 'providerId',
                        type: 'varchar',
                        length: '64',
                        isPrimary: true,
                    },
                    {
                        name: 'createdBy',
                        type: 'uuid',
                        isNullable: true,
                    },
                    {
                        name: 'createdAt',
                        type: 'timestamp',
                        default: 'CURRENT_TIMESTAMP',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'tenant_runtime_provider_allowlist',
            new TableForeignKey({
                name: 'fk_tenant_runtime_provider_allowlist_tenant',
                columnNames: ['tenantId'],
                referencedTableName: 'tenants',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        // createdBy is informational only (the row survives the user
        // being deleted; the audit log carries the actor identity
        // independently via `tenant_job_runtime_audit`). ON DELETE SET
        // NULL keeps the row queryable when the originating user is
        // purged — same pattern as `tenant_job_runtime_config.createdBy`.
        await queryRunner.createForeignKey(
            'tenant_runtime_provider_allowlist',
            new TableForeignKey({
                name: 'fk_tenant_runtime_provider_allowlist_user',
                columnNames: ['createdBy'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('tenant_runtime_provider_allowlist')) {
            await queryRunner.dropTable('tenant_runtime_provider_allowlist', true);
        }
    }
}
