import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EW-752 P5.1 (T35b) — drops the NOT NULL constraint on
 * `tenant_job_runtime_audit.tenantId` so the boot-time
 * `operator_allowlist_boot` audit row (written by
 * `TenantJobRuntimeBootAuditService`) can be inserted with
 * `tenantId = NULL`.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §10 P5.1](../../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 *
 * **Rationale:** every existing audit row is tenant-scoped — a tenant
 * mutated their overlay, an operator changed their allow-list, etc. The
 * boot audit captures the global operator allow-list + per-tenant
 * gating flag at process start; it is NOT tied to any one tenant.
 * Encoding that as `tenantId = NULL` (rather than e.g. a synthetic
 * "platform" tenant row) keeps the FK to `tenants(id)` honest and
 * matches the existing convention that NULL on `actorUserId` means
 * "system actor".
 *
 * **Compatibility:**
 *   - Drops NOT NULL on `tenantId`. Existing rows are unaffected (they
 *     all have non-null `tenantId`).
 *   - The FK to `tenants(id)` with `ON DELETE CASCADE` is preserved.
 *     A NULL `tenantId` is allowed by the FK (NULL never references a
 *     row — it's just "not constrained").
 *   - The compound index `(tenantId, occurredAt)` keeps working — NULL
 *     `tenantId` rows simply sort together at one end of the index;
 *     no operational impact at the volumes this table carries.
 *
 * Forward-only — the down() restores NOT NULL, which would fail if any
 * boot-audit rows exist by then. Down is provided for completeness; in
 * practice we never roll this back once the boot writer ships.
 */
export class RelaxTenantJobRuntimeAuditTenantNullable1781200000000 implements MigrationInterface {
    name = 'RelaxTenantJobRuntimeAuditTenantNullable1781200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tenant_job_runtime_audit'))) {
            return;
        }
        const table = await queryRunner.getTable('tenant_job_runtime_audit');
        const column = table?.findColumnByName('tenantId');
        if (!column || column.isNullable) {
            return;
        }
        // Dialect-portable: TypeORM's `changeColumn` rewrites the column
        // definition in place. We clone the column descriptor and flip
        // `isNullable` so the existing FK + index references stay intact
        // on Postgres (`ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`)
        // and on the test SQLite driver (table recreate behind the
        // scenes). Same pattern used by EW-654 user.entity nullable
        // tightening migrations.
        const updated = column.clone();
        updated.isNullable = true;
        await queryRunner.changeColumn('tenant_job_runtime_audit', column, updated);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('tenant_job_runtime_audit'))) {
            return;
        }
        const table = await queryRunner.getTable('tenant_job_runtime_audit');
        const column = table?.findColumnByName('tenantId');
        if (!column || !column.isNullable) {
            return;
        }
        const updated = column.clone();
        updated.isNullable = false;
        await queryRunner.changeColumn('tenant_job_runtime_audit', column, updated);
    }
}
