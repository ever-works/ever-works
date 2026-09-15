import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * EW-742 P1 (T12) — append-only audit trail for every change to
 * `tenant_job_runtime_config`. Tenant-scoped (per FR-13): every mutation
 * — create / update / rotate / force-invalidate / delete /
 * operator allow-list change — writes one row here with the before/after
 * snapshot and the actor.
 *
 * The single exception is the instance-level `operator_allowlist_boot`
 * row (EW-752 P5.1 T35b): it records the platform-wide operator
 * allow-list captured at process start, is not tied to any tenant, and
 * is stored with `tenantId = NULL`. Every other row carries a real
 * tenant id.
 *
 * Behaviour spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md` §FR-13](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan reference: [`plan.md` §3 + §10 P5 (T35)](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 * Decision record: [ADR-017](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md)
 *
 * Stored as a wide-row append-only log rather than a CDC table because:
 *   - operators investigating a tenant incident want a single linear log
 *     they can read top-to-bottom, not a join across N change tables;
 *   - `before` / `after` capture the full row state — secrets are
 *     MASKED at write time by the writing service (never raw plaintext);
 *   - retention is owned by ops policy (this table can be partitioned by
 *     `occurredAt` once volume warrants it; out of scope for P1).
 *
 * No `@ManyToOne` declared — see `user.entity.ts` EW-654 comment for the
 * import-cycle rationale shared across every tenant-scoped entity.
 */
@Entity({ name: 'tenant_job_runtime_audit' })
@Index('idx_tenant_job_runtime_audit_tenant_occurred', ['tenantId', 'occurredAt'])
export class TenantJobRuntimeAudit {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * FK to `tenants.id`. Indexed via `idx_tenant_job_runtime_audit_tenant_occurred`.
     *
     * NULL marks an instance-level row. Only the `operator_allowlist_boot`
     * action writes NULL; every tenant mutation row carries a real tenant
     * id. The database column was relaxed to nullable by migration
     * `1781200000000-RelaxTenantJobRuntimeAuditTenantNullable`; this
     * declaration must stay nullable too, because environments that build
     * the schema from entities (`DATABASE_AUTOMIGRATE=true`, which turns on
     * TypeORM `synchronize` and skips migrations) would otherwise create
     * the column NOT NULL and reject the boot row.
     */
    @Column({ type: 'uuid', nullable: true })
    tenantId: string | null;

    /**
     * FK to `users.id`. NULL = system actor (background job, migration,
     * boot-time reconciliation). Operator vs tenant-admin distinction is
     * captured in `action` semantics + `before/after` deltas, not in a
     * separate role column.
     */
    @Column({ type: 'uuid', nullable: true })
    actorUserId: string | null;

    /**
     * Free-form action discriminator. Application-layer constants:
     *   - `'create'`                       — first overlay row written
     *   - `'update'`                       — mode / provider / metadata change
     *   - `'rotate'`                       — credential rotation (graceful drain)
     *   - `'force_invalidate'`             — operator-only break-glass kill
     *   - `'delete'`                       — overlay reverted to inherit
     *   - `'operator_allowlist_change'`    — instance allow-list edited;
     *     emitted per affected tenant (T35).
     *   - `'desktop_wizard_seed'`          — overlay row recorded from the
     *     desktop install wizard's runtime choice on the tenant's first
     *     overlay read.
     *   - `'operator_allowlist_boot'`      — instance-level snapshot of the
     *     operator allow-list taken at process start (T35b); the only
     *     action written with `tenantId = NULL`.
     *
     * Stored as `varchar(64)` rather than a Postgres enum so we can add
     * new action types without a type-altering migration — same
     * convention as `works.kind` per EW-665.
     */
    @Column({ type: 'varchar', length: 64 })
    action: string;

    /**
     * Snapshot of the relevant tenant_job_runtime_config fields BEFORE
     * the change. Secrets MUST be redacted by the writing service before
     * storage. `simple-json` (rather than `jsonb`) so the SQLite test
     * driver behaves the same — same rationale as `webhook-delivery.entity.ts`
     * `payload`. The migration declares the physical column as `text` on
     * every dialect, which `simple-json` round-trips via
     * JSON.stringify/parse.
     */
    @Column({ type: 'simple-json', nullable: true })
    before: Record<string, unknown> | null;

    /** Snapshot AFTER the change. Same redaction + JSON-type rationale as `before`. */
    @Column({ type: 'simple-json', nullable: true })
    after: Record<string, unknown> | null;

    /**
     * Credential version associated with the action. For `rotate` this is
     * the NEW version that was issued; for `force_invalidate` this is
     * the version being killed; for `create`/`update`/`delete` it
     * mirrors the row's `credentialVersion` at the time of the change.
     */
    @Column({ type: 'int', nullable: true })
    credentialVersion: number | null;

    @CreateDateColumn()
    occurredAt: Date;
}
