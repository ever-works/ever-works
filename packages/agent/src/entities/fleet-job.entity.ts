import { PortableDateColumn } from './_types';
import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { FleetJobKind, FleetJobStatus } from '@ever-works/contracts';

/**
 * Fleet job (Desktop PRD §6.2 / M4) — one unit of work that an enrolled
 * fleet node can LEASE and EXECUTE.
 *
 * This row is the whole "queue" of the `job-runtime-node` provider.
 * Before it existed, machines enrolled, heartbeated and appeared in the
 * Fleet settings page, and nothing could ever be scheduled onto one.
 *
 * Lifecycle (`FleetJobService`, contract in `@ever-works/contracts`):
 *   1. `enqueue` inserts `status:'queued'` with the executor payload and
 *      the capability tags a node must advertise to be eligible.
 *   2. `lease` CAS-claims the row for exactly one node — the UPDATE
 *      matches on `status:'queued'` AND `id`, so two nodes racing the
 *      same row produce one winner and one no-op. The claim is
 *      time-boxed by `leaseExpiresAt`, never a lock.
 *   3. `heartbeat` (job-scoped) extends `leaseExpiresAt` and flips the
 *      first beat `leased` → `running`.
 *   4. `complete` records success (`done`) or failure (`failed`).
 *   5. Expired leases are reclaimed — back to `queued` while `attempts <
 *      maxAttempts`, otherwise `failed`. Reclaim runs inline on every
 *      lease poll AND on the `fleet-job-lease-sweeper` cron, so a fleet
 *      that stops polling still converges.
 *
 * Auth: every node-facing transition authenticates with the SAME node
 * secret minted at enrollment (constant-time compare against the
 * `fleet_nodes.enrollmentTokenHash`, fail-closed). No second credential.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; FKs live in the migration
 * (`1784200000000-CreateFleetJobs`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`, so a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'fleet_jobs' })
@Index('idx_fleet_jobs_user_status', ['userId', 'status'])
@Index('idx_fleet_jobs_node_status', ['nodeId', 'status'])
@Index('idx_fleet_jobs_lease_expiry', ['status', 'leaseExpiresAt'])
export class FleetJob {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner the job belongs to — only this owner's nodes may lease it. */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /**
     * Node holding (or last holding) the claim. NULL while queued. Not a
     * FK: deleting a node registration must not delete its job history.
     */
    @Column({ type: 'uuid', nullable: true })
    nodeId?: string | null;

    /** What the node should do. `varchar(32)`, not an enum — new kinds ship without schema changes. */
    @Column({ type: 'varchar', length: 32 })
    kind: FleetJobKind;

    /** 'queued' | 'leased' | 'running' | 'done' | 'failed'. */
    @Column({ type: 'varchar', length: 16 })
    status: FleetJobStatus;

    /** Executor input; shape is per-kind. Size-capped at the API edge. */
    @Column({ type: 'simple-json', nullable: true })
    payload?: Record<string, unknown> | null;

    /** Tags a node must advertise to be eligible (fail-closed set check). */
    @Column({ type: 'simple-json' })
    requiredCapabilities: string[];

    /**
     * When the current claim lapses. Server-computed at lease/heartbeat
     * time — the node never supplies its own clock.
     */
    @PortableDateColumn({ nullable: true })
    leaseExpiresAt?: Date | null;

    /** Lease attempts consumed. Reclaim fails the job once it hits `maxAttempts`. */
    @Column({ type: 'int', default: 0 })
    attempts: number;

    @Column({ type: 'int', default: 3 })
    maxAttempts: number;

    /**
     * Stable identity across retries (`JobEnqueueOptions.idempotencyKey`).
     * UNIQUE so a re-enqueue of the same logical job reuses the row
     * instead of doubling the work onto the fleet.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    idempotencyKey?: string | null;

    /** Executor output on success; shape is per-kind. Size-capped at the edge. */
    @Column({ type: 'simple-json', nullable: true })
    result?: Record<string, unknown> | null;

    /** Failure detail on `failed`. Length-capped at the edge. */
    @Column({ type: 'text', nullable: true })
    error?: string | null;

    /**
     * Why a `queued` row has not started yet — today only
     * `waiting-for-runner`, stamped by the fleet run router when the job
     * was accepted with no runner able to take it.
     *
     * It lives on the JOB, not on the `agent_runs` row, because the fact
     * is a property of the queue: the lease CAS is the moment it stops
     * being true, and that CAS already writes this row. Anywhere else it
     * would need a second writer to remember to clear it, which is the
     * shape of every stale-status bug.
     *
     * Short machine token, never free text.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    queuedReason?: string | null;

    /** First transition into `running` (the node acknowledged the claim). */
    @PortableDateColumn({ nullable: true })
    startedAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    completedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
