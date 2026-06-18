import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * EW-742 P1 (T12) — append-only audit trail for every change to
 * `tenant_job_runtime_config`. Tenant-scoped (per FR-13): every mutation
 * — create / update / rotate / force-invalidate / delete /
 * operator allow-list change — writes one row here with the before/after
 * snapshot and the actor.
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

    /** FK to `tenants.id`. Indexed via `idx_tenant_job_runtime_audit_tenant_occurred`. */
    @Column({ type: 'uuid' })
    tenantId: string;

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
     * storage. `simple-json` (rather than `jsonb`) for SQLite parity in
     * the test suite — same rationale as `webhook-delivery.entity.ts`
     * `payload`. Physical column type is `jsonb` on Postgres prod via
     * the migration.
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
