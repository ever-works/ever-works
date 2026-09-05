import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Panic controls (EW-778) — append-only audit trail for the fleet's
 * operator-level actions.
 *
 * Every set / clear of the global stop flag, every drain-all and every
 * cancel-in-flight writes one row here with the ACTOR and the TIME.
 * This is the minimal shape the panic controls need; slice AQ extends
 * it (per-node actions, retention) rather than replacing it, which is
 * why the table is named `fleet_audit` and not something narrower.
 *
 * Modelled on `tenant_job_runtime_audit`:
 *   - `actorUserId` nullable (NULL = system actor, or a since-purged
 *     user — the FK is ON DELETE SET NULL so the trail survives);
 *   - `action` is `varchar(64)`, not an enum, so a new action is a code
 *     change and not a type-altering migration;
 *   - `details` is `simple-json` (text at the SQL level) for sqlite
 *     parity in the test suite.
 *
 * `ownerUserId` is the OWNER SCOPE of an owner action (drain-all,
 * cancel-in-flight); NULL for global actions (the stop flag). `nodeId`
 * is reserved for per-node rows and carries NO foreign key: history must
 * survive node deletion, for the same reason `fleet_jobs.nodeId` has none.
 *
 * Raw uuid references only (no @ManyToOne, per the EW-654 cycle-avoidance
 * rule); the `users` FK lives in the migration.
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`, so a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'fleet_audit' })
@Index('idx_fleet_audit_owner_occurred', ['ownerUserId', 'occurredAt'])
@Index('idx_fleet_audit_action_occurred', ['action', 'occurredAt'])
export class FleetAudit {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * `'kill-switch.stop' | 'kill-switch.clear' | 'drain-all' |
     * 'cancel-in-flight'` today (`FleetAuditAction` in contracts).
     */
    @Column({ type: 'varchar', length: 64 })
    action: string;

    /** Who did it. NULL = system, or a user purged since. */
    @Column({ type: 'uuid', nullable: true })
    actorUserId: string | null;

    /** Owner scope of an owner action; NULL for global actions. */
    @Column({ type: 'uuid', nullable: true })
    ownerUserId: string | null;

    /** Per-node rows only (slice AQ). No FK — history outlives the node. */
    @Column({ type: 'uuid', nullable: true })
    nodeId: string | null;

    /** Reason, counts, bounded id lists — whatever the action recorded. */
    @Column({ type: 'simple-json', nullable: true })
    details: Record<string, unknown> | null;

    @CreateDateColumn()
    occurredAt: Date;
}
