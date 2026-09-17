import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Safety rails (AW-24) — the OWNER's stop, one row per paused workspace.
 *
 * The platform stop flag (`fleet_kill_switch`) is a single global row owned
 * by the platform operator behind a deployment switch. Agent, Mission and Run
 * pauses are statuses on their own records. There has never been a row that
 * means "this workspace is stopped", and nowhere to hang the actor, the
 * reason and the resume progress. This is it.
 *
 * The two are INDEPENDENT in both directions (FR-51): the operator's flag
 * does not create a row here, and clearing one never clears the other.
 *
 * # Present only while paused
 *
 * Pausing inserts; resuming deletes. "Is this workspace paused?" is therefore
 * a presence check rather than a boolean somebody has to remember to reset —
 * the same reasoning behind every other soft-state row in this codebase.
 *
 * # Reads fail CLOSED
 *
 * `WorkspacePauseService.state()` folds every read error into
 * `{ paused: true, unverified: true }`, exactly as `FleetKillSwitchService`
 * does. A stop that permits whenever it cannot read itself is not a stop.
 *
 * # Why the unique index is NOT declared here
 *
 * A workspace is `(tenantId, organizationId)` with a NULL organization for
 * the bare-tenant workspace, and SQL treats NULLs as DISTINCT inside a unique
 * index — so the constraint has to be a Postgres PARTIAL unique pair, written
 * by hand in the migration exactly as `work_budgets` does it. A
 * decorator-level `@Index(..., { unique: true })` would additionally make
 * TypeORM generate a non-partial duplicate on the better-sqlite3 test driver.
 * Only the non-unique lookup index is declared here.
 */
@Entity({ name: 'workspace_pauses' })
@Index('idx_workspace_pauses_tenant', ['tenantId'])
@Index('idx_workspace_pauses_user', ['userId'])
export class WorkspacePause {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner of the workspace. */
    @Column({ type: 'uuid' })
    userId: string;

    /** Never null here — a pause is always tenant-anchored. */
    @Column({ type: 'uuid' })
    tenantId: string;

    /** Null = the bare-tenant workspace (no Organization). */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** Shown everywhere paused work appears. At most 500 characters (FR-48). */
    @Column({ type: 'varchar', length: 500, nullable: true })
    reason?: string | null;

    /** The person who paused. Only a person may (FR-47). */
    @Column({ type: 'uuid' })
    pausedByUserId: string;

    @Column()
    pausedAt: Date;

    /** Starts this pause has refused so far — the banner's count. */
    @Column({ type: 'int', default: 0 })
    refusedStarts: number;

    /** Runs that reached a tool boundary and parked cleanly, state preserved. */
    @Column({ type: 'int', default: 0 })
    cleanlyStopped: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
