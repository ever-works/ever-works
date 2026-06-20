import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * EW-752 P5.1 — per-tenant runtime provider allow-list overlay. Sits on
 * top of the global `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS` env
 * var (EW-742 P5) and lets a platform operator restrict an individual
 * tenant to a subset of the global list. Gated behind
 * `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING`; when the flag is off
 * the table is ignored and behaviour is identical to today.
 *
 * Behaviour spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §10 P5.1](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 * Tasks: T35a + T35b
 *
 * **Semantic when the flag is ON:**
 *   - Empty per-tenant row set → tenant inherits the global allow-list
 *     as-is (NOT "tenant has nothing"). Inheritance is the default so
 *     enabling the flag without populating the table is a no-op.
 *   - Populated row set → tenant is restricted to `global ∩ per-tenant`.
 *     Providers in the per-tenant set that are NOT in the global set
 *     are silently dropped (the global env is the upper bound).
 *
 * **Cardinality:** composite PK `(tenantId, providerId)` so the same
 * provider appears at most once per tenant. Rows are immutable — to
 * change the set, delete and re-insert (the `PUT` endpoint runs the
 * whole replacement in a transaction). That's why there is no
 * `updatedAt` column.
 *
 * No `@ManyToOne` declared — see `user.entity.ts` EW-654 comment for
 * the import-cycle rationale shared across every tenant-scoped entity.
 * The FK to `tenants(id)` (ON DELETE CASCADE) and the FK to
 * `users(id)` on `createdBy` (ON DELETE SET NULL) are enforced at the
 * DB layer by the migration `1781100000000-AddTenantRuntimeProviderAllowlist`.
 */
@Entity({ name: 'tenant_runtime_provider_allowlist' })
export class TenantRuntimeProviderAllowlist {
    /** FK to `tenants.id`. Part of the composite PK. */
    @PrimaryColumn({ type: 'uuid' })
    tenantId: string;

    /**
     * Matches `IJobRuntimeProvider.runtimeId` from the EW-685 contract —
     * one of the bundled provider ids. Kept as `varchar(64)` rather than
     * a Postgres enum so adding a new provider never needs a
     * type-altering migration (same convention as
     * `tenant_job_runtime_config.providerId`).
     */
    @PrimaryColumn({ type: 'varchar', length: 64 })
    providerId: string;

    /**
     * FK to `users.id`. NULL for system / migration-created rows. No
     * `@ManyToOne` to avoid the entities import cycle — see
     * `user.entity.ts` EW-654 comment.
     */
    @Column({ type: 'uuid', nullable: true })
    createdBy: string | null;

    /**
     * No `updatedAt` — rows are immutable. The PUT endpoint replaces
     * the whole per-tenant set atomically (delete-then-insert in a
     * single transaction); a change therefore always materialises as a
     * new row with a fresh `createdAt`.
     */
    @CreateDateColumn()
    createdAt: Date;
}
