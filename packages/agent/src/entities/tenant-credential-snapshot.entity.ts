import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * EW-742 P1 T11 follow-up — per-version credential snapshot history for
 * the tenant overlay. Backs the graceful-drain semantic from
 * [ADR-017 §3 Q4](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md#3-credential-rotation--graceful-drain-locked-q4-do-not-reopen):
 * an in-flight run enqueued at `credentialVersion = N` keeps its captured
 * credential bag for the run's full lifetime, even after the operator
 * rotates the tenant to `N+1`. Without this table the resolver loses the
 * old bag the moment a rotation lands and the run binds to whatever's
 * current — which is precisely the drain bug Q4 forbids.
 *
 * # Why a separate table (not a JSONB column on tenant_job_runtime_config)
 *
 *   - `tenant_job_runtime_config` is a single row per tenant; storing
 *     history inline would force unbounded JSONB growth and lose the
 *     per-version uniqueness guarantee at the DB layer.
 *   - A dedicated table lets us index `(tenantId, providerId,
 *     credentialVersion)` and FK other rows (future audit linkage) to the
 *     specific snapshot the run actually used.
 *   - Snapshot pruning (drop snapshots older than the oldest in-flight
 *     run) becomes a single `DELETE FROM tenant_credential_snapshot WHERE
 *     credentialVersion < $cutoff` query.
 *
 * # Cardinality + uniqueness
 *
 *   - PK is a synthetic `uuid` so other tables can FK to a specific
 *     snapshot row (future audit / run-history linkage). The natural key
 *     `(tenantId, providerId, credentialVersion)` is enforced as a
 *     UNIQUE INDEX at the migration layer — re-inserting the same tuple
 *     is the caller's signal that the snapshot already exists, and the
 *     service translates the PK-conflict into a no-op (idempotency).
 *   - `providerId` is `varchar(64)` to match the convention used by
 *     `tenant_job_runtime_config.providerId` so adding a new provider
 *     never needs a type-altering migration.
 *
 * # Encryption
 *
 *   - `credentialsEncrypted` is **already encrypted** by the time it
 *     reaches this entity. The secret-store resolver layer (P3.2 / EW-748)
 *     owns the at-rest envelope under `PLUGIN_SECRET_ENCRYPTION_KEY` (see
 *     [`settings-system.md` §5](../../../../docs/specs/architecture/settings-system.md));
 *     this column is a transparent passthrough.
 *   - JSONB (not BYTEA) so future schema evolution of the bag's shape
 *     never needs a type-altering migration. The bag's interior keys are
 *     opaque to TypeORM and the service — `Record<string, unknown>`.
 *
 * No `@ManyToOne` relations declared — see `user.entity.ts` EW-654
 * comment for the import-cycle rationale shared across every
 * tenant-scoped entity. The FK to `tenants(id)` (ON DELETE CASCADE) and
 * the UNIQUE index on `(tenantId, providerId, credentialVersion)` are
 * enforced at the DB layer by the migration
 * `1781300000000-AddTenantCredentialSnapshot`.
 */
@Entity({ name: 'tenant_credential_snapshot' })
export class TenantCredentialSnapshot {
    /**
     * Synthetic PK so other tables can FK to a specific snapshot row
     * (future audit linkage). The natural key
     * `(tenantId, providerId, credentialVersion)` is the unique index
     * created by the migration.
     */
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * FK to `tenants.id`. Indexed because the most common lookup is
     * "give me every snapshot for tenant X" (drain reconciliation +
     * operator dashboards). The composite UNIQUE index also covers
     * `(tenantId, providerId, credentialVersion)` lookups.
     */
    @Column({ type: 'uuid' })
    @Index('idx_tenant_credential_snapshot_tenant')
    tenantId: string;

    /**
     * Matches `IJobRuntimeProvider.runtimeId` (one of `'trigger' |
     * 'temporal' | 'bullmq' | 'pgboss' | 'inngest'` today). `varchar(64)`
     * keeps it consistent with `tenant_job_runtime_config.providerId`.
     */
    @Column({ type: 'varchar', length: 64 })
    providerId: string;

    /**
     * The monotonic per-tenant version this snapshot captures. Together
     * with `(tenantId, providerId)` forms the natural key enforced by
     * the migration's UNIQUE index.
     */
    @Column({ type: 'integer' })
    credentialVersion: number;

    /**
     * The credential bag as stored — **already encrypted** by the
     * secret-store resolver layer. Stored as JSONB so future schema
     * evolution doesn't need a type-altering migration. Whether
     * decryption happens at write or read time is operator-side; this
     * column just persists the bag verbatim.
     */
    @Column({ type: 'jsonb' })
    credentialsEncrypted: Record<string, unknown>;

    /**
     * Wall-clock capture time. Set automatically by TypeORM on insert;
     * never updated (snapshots are immutable history rows).
     */
    @CreateDateColumn()
    capturedAt: Date;
}
