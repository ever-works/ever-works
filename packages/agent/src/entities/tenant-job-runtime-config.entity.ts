import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * EW-742 P1 (Tenant-Scoped Job-Runtime Overlay) — per-tenant overlay row
 * that sits between the platform-global `EVER_WORKS_JOB_RUNTIME` selector
 * (EW-683 / ADR-015) and the dispatch path. Absence of a row is
 * equivalent to `mode = 'inherit'` and yields byte-identical behaviour to
 * the pre-overlay path; single-tenant self-hosters never see this table.
 *
 * Behaviour spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Data model: [`plan.md` §3](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md#3-data-model)
 * Decision record: [ADR-017](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
 *
 * **Cardinality:** one row per tenant (PK = `tenantId`). The dispatcher
 * resolver (P3, T20) looks up by `tenantId`, and credential reads are
 * cached with the row's `credentialVersion` as the version key so that
 * routine rotation can drain in-flight runs gracefully (Q4 / FR-5).
 *
 * **Credential storage:** `credentialsSecretRef` is a pointer into the
 * existing encrypted secrets envelope (`PLUGIN_SECRET_ENCRYPTION_KEY`,
 * see [`settings-system.md` §5](../../../../docs/specs/architecture/settings-system.md));
 * the actual credential blob does NOT live on this row. NULL when
 * `mode = 'inherit'`.
 *
 * **Modes:**
 *   - `inherit` — use the instance-global provider + the platform-default
 *     credentials. Default for every tenant before they opt in.
 *   - `byo`     — same provider as the instance default but with the
 *     tenant's own credentials.
 *   - `override` — tenant chooses a different provider from the operator
 *     allow-list AND supplies their own credentials.
 *
 * No `@ManyToOne` relations declared here to avoid the entities import
 * cycle that bit Tenants & Organizations Phase 2 — see
 * `user.entity.ts` EW-654 comment block. Services that need the owning
 * `Tenant` / `User` row do explicit repository lookups.
 */
// The partial index `idx_tenant_job_runtime_config_provider_enabled` on
// `(providerId) WHERE enabled = true` is created by migration
// `1780900000000-AddTenantJobRuntimeConfig` (Postgres `CREATE INDEX ...
// WHERE ...`). The migration owns it because TypeORM's `@Index` decorator
// `where:` option does not round-trip cleanly through the synchronize-based
// test schema (better-sqlite3); the migration's raw SQL works on both.
@Entity({ name: 'tenant_job_runtime_config' })
export class TenantJobRuntimeConfig {
    /**
     * FK to `tenants.id`. PK — one overlay row per tenant. The FK + ON
     * DELETE CASCADE is enforced at the DB level by the migration
     * (`1780900000000-AddTenantJobRuntimeConfig`).
     */
    @PrimaryColumn({ type: 'uuid' })
    tenantId: string;

    /**
     * Matches `IJobRuntimeProvider.runtimeId` from the EW-685 contract —
     * one of `'trigger' | 'temporal' | 'bullmq' | 'pgboss' | 'inngest'`
     * today, extensible as new job-runtime plugins are bundled. Kept as
     * `varchar(64)` rather than a Postgres enum so adding a new provider
     * never needs a type-altering migration (same convention as
     * `works.kind` per EW-665 / migration 1779991010000).
     */
    @Column({ type: 'varchar', length: 64 })
    providerId: string;

    /**
     * Opaque pointer into the encrypted secrets store. NULL when
     * `mode = 'inherit'` (the tenant uses the platform-default credentials
     * resolved from env / global plugin settings). The actual credential
     * blob is encrypted at rest under `PLUGIN_SECRET_ENCRYPTION_KEY`; this
     * column never holds plaintext secrets, only the lookup key.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    credentialsSecretRef: string | null;

    /**
     * Monotonic per-tenant credential version. Bumped on every rotation
     * write by `CredentialVersionService.bumpVersion(tenantId)`. Captured
     * at enqueue time into the run / history row so an in-flight run
     * keeps using its captured version for the full run lifetime even if
     * a newer credential lands mid-run (graceful drain, FR-5 / Q4).
     */
    @Column({ type: 'int', default: 1 })
    credentialVersion: number;

    /**
     * Trichotomy from ADR-017 §1. Stored as `varchar(16)` rather than a
     * Postgres enum so adding a future mode (e.g. an operator-imposed
     * `disabled` for force-invalidate) never needs a type-altering
     * migration. Application-layer validation pins the value to
     * `'inherit' | 'byo' | 'override'`.
     */
    @Column({ type: 'varchar', length: 16 })
    mode: 'inherit' | 'byo' | 'override';

    /**
     * Soft-disable without losing the row. When `false` the resolver
     * MUST treat the tenant as `inherit` (per plan.md §3) so the operator
     * can quickly fall back without dropping the credential pointer.
     */
    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    /**
     * FK to `users.id`. NULL for system / migration-created rows. No
     * `@ManyToOne` to avoid the entities import cycle — see
     * `user.entity.ts` EW-654 comment.
     */
    @Column({ type: 'uuid', nullable: true })
    createdBy: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
