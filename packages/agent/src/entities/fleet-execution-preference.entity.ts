import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { FleetExecutionMode, FleetExecutionScopeType } from '@ever-works/contracts';

/**
 * Execution routing preference — "run this Work / Goal on my own
 * machine, or in the cloud?".
 *
 * One row per (owner, scope). The account-wide row is
 * `scopeType: 'user'` with a NULL `scopeId`; narrower rows name the Work
 * or Goal they apply to. Resolution is narrowest-wins and lives in
 * `resolveFleetExecutionMode` in `@ever-works/contracts`, so the router,
 * the API and the settings UI share ONE rule.
 *
 * ## Uniqueness
 *
 * `idx_fleet_exec_prefs_scope` is an ACCELERATOR, not a constraint. It
 * deliberately is not UNIQUE: the account-wide row carries a NULL
 * `scopeId`, and neither Postgres nor sqlite treats NULLs as equal in a
 * unique index — so a unique index would enforce nothing for exactly the
 * row most likely to be double-written, while implying it did. The
 * single-row-per-scope invariant is enforced in
 * `FleetExecutionPreferenceRepository.upsert` (find-then-save), and
 * `resolveFleetExecutionMode` picks the first match, so even a
 * duplicated row is resolved deterministically rather than throwing.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; the FK to `users` lives in the migration
 * (`1786920000000-FleetRunnerTelemetryAndRouting`). `workId` / `goalId`
 * intentionally get NO foreign key: a preference is advisory, and a
 * dangling row for a deleted Work simply never matches again.
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`, so a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'fleet_execution_preferences' })
@Index('idx_fleet_exec_prefs_user', ['userId'])
@Index('idx_fleet_exec_prefs_scope', ['userId', 'scopeType', 'scopeId'])
export class FleetExecutionPreference {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner the preference belongs to (scopes every read and write). */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** 'user' | 'work' | 'goal'. */
    @Column({ type: 'varchar', length: 16 })
    scopeType: FleetExecutionScopeType;

    /** The Work / Goal id. NULL for the account-wide row. */
    @Column({ type: 'uuid', nullable: true })
    scopeId?: string | null;

    /** 'local-wait' | 'local-fallback' | 'cloud'. */
    @Column({ type: 'varchar', length: 24 })
    mode: FleetExecutionMode;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
