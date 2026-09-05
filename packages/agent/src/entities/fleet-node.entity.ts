import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { FleetNodeKind, FleetNodeStatus, FleetNodeWorkerState } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Fleet (Wave 12, slice 1) — one machine registered to execute the
 * owner's work: a desktop node (thin connected agent app), a headless
 * node (CLI/service), or — read-only, NEVER persisted as rows — a node
 * of the user's OWN configured cluster surfaced live at list time.
 *
 * Lifecycle (`FleetService`):
 *   1. `createEnrollmentToken` inserts the row with `status:
 *      'enrolling'` and `enrollmentTokenHash` = sha256 of a one-time
 *      token (returned once, never stored).
 *   2. `enroll` CAS-consumes the token (single-use + 15-min expiry via
 *      `createdAt`), flips the node `online` and REPLACES the hash with
 *      the sha256 of the freshly minted node secret — so the column is
 *      a dual-role credential hash: enrollment-token hash while
 *      `enrolling`, heartbeat-secret hash once enrolled. The plain
 *      token/secret never touch the database.
 *   3. `heartbeat` authenticates with a constant-time compare against
 *      that hash (fail-closed) and server-stamps `lastHeartbeatAt`.
 *   4. List reads sweep `online` nodes with no heartbeat for 5 minutes
 *      to `offline` (no dedicated cron).
 *   5. `rotateCredentialForUser` puts an enrolled node BACK to
 *      `enrolling` with a freshly minted one-time token: the old
 *      heartbeat secret stops working the instant the hash is replaced,
 *      and the operator re-enrolls the machine with the new token.
 *
 * Cluster boundary: rows only ever describe user-enrolled machines.
 * Nodes of user-configured clusters (`clusterSource:
 * 'custom-kubeconfig'` in the deployment plugin settings) are merged
 * into list responses live and tagged `kind: 'k8s'`; platform-operated
 * shared clusters are structurally excluded and nothing cluster-side is
 * ever written here.
 *
 * Scope columns are raw uuid references (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; FKs live in the migration
 * (`1783900000000-CreateFleetNodes`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this
 * repo has no `autoLoadEntities`, a forFeature'd-but-unregistered
 * entity throws EntityMetadataNotFoundError on first query.
 */

/**
 * The kind/status unions are the SHARED contract's
 * (`@ever-works/contracts`), re-exported here so the entity, the API
 * edge, the web tier and the node apps cannot drift: adding a status
 * server-side is a compile error everywhere that switches on it.
 *
 * `k8s` is list-time only — never persisted as a row.
 */
export type { FleetNodeKind, FleetNodeStatus, FleetNodeWorkerState } from '@ever-works/contracts';
/**
 * Statuses in which the platform will NOT lease new work onto a node.
 *
 * The list itself MOVED to `@ever-works/contracts` (next to the status
 * union) once the API edge started asking the same question for run
 * routing — two copies of it would drift the first time a status is
 * added. Re-exported here so every existing server-side importer keeps
 * working unchanged.
 */
export { FLEET_NODE_NON_LEASABLE_STATUSES } from '@ever-works/contracts';

/**
 * Statuses that must be PRESERVED by an accepted heartbeat instead of
 * being overwritten with `online`. A drained node that goes dark is
 * indistinguishable from a dead one, so it keeps beating — but a beat
 * must never silently un-pause it.
 */
export const FLEET_NODE_STICKY_STATUSES: readonly FleetNodeStatus[] = ['paused', 'disabled'];

@Entity({ name: 'fleet_nodes' })
@Index('idx_fleet_nodes_user', ['userId'])
@Index('idx_fleet_nodes_credential', ['enrollmentTokenHash'], { unique: true })
export class FleetNode {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner the node executes work for (scopes every read/write). */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column({ type: 'varchar', length: 200 })
    name: string;

    /** 'desktop-node' | 'node' (enrollable); 'k8s' exists only in views. */
    @Column({ type: 'varchar', length: 16 })
    kind: FleetNodeKind;

    /** 'enrolling' | 'online' | 'offline' | 'paused' | 'disabled'. */
    @Column({ type: 'varchar', length: 16 })
    status: FleetNodeStatus;

    /**
     * sha256 hex of the current credential — the one-time enrollment
     * token while `enrolling`, the node heartbeat secret once enrolled.
     * NULL only for defensively-degraded rows; heartbeat fails closed
     * on it. The plaintext is never stored.
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    enrollmentTokenHash?: string | null;

    /** Server-stamped on every accepted heartbeat (never client-trusted). */
    // Portable date: better-sqlite3 (the e2e/CI driver) has no `timestamp`
    // type, so a raw one makes TypeORM metadata validation throw
    // DataTypeNotSupportedError and the API cannot boot there at all.
    @PortableDateColumn({ nullable: true })
    lastHeartbeatAt?: Date | null;

    /**
     * When the CURRENT credential was issued.
     *
     * Enrollment-token expiry is measured from here rather than from
     * `createdAt`, because a credential ROTATION mints a fresh token on
     * an existing row: judging that token by the row's creation date
     * would make every rotated token instantly expired. NULL on rows
     * written before rotation existed — the service falls back to
     * `createdAt` for those, so the pre-rotation behaviour is unchanged.
     */
    @PortableDateColumn({ nullable: true })
    credentialIssuedAt?: Date | null;

    /** Capability tags ('terminal', 'workspace', 'docker', ...). */
    @Column({ type: 'simple-json' })
    capabilities: string[];

    /**
     * True once an admin has hand-edited {@link capabilities}.
     *
     * Tags are normally the NODE's self-description, refreshed on every
     * heartbeat. Pinning is what makes them admin-editable in a way that
     * survives: while pinned, an incoming heartbeat no longer overwrites
     * the tag set, so an operator can add (or withhold) a capability
     * without the machine silently reverting it seconds later. Unpinning
     * hands ownership back to the node.
     */
    @Column({ type: 'boolean', default: false })
    capabilitiesPinned: boolean;

    /** os/arch self-description, e.g. 'linux/x64' (sanitized at enroll). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    platform?: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    version?: string | null;

    /**
     * Version of the AGENT CLI installed on the machine — the binary an
     * `agent-task` step shells out to — as opposed to {@link version},
     * which is the node daemon's own.
     *
     * Additive telemetry: a daemon built before this field existed sends
     * nothing and the column stays NULL, which is why the heartbeat
     * treats "absent" as "leave alone" rather than "clear".
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    cliVersion?: string | null;

    /**
     * Free bytes on the volume the node's workspace lives on, as last
     * reported.
     *
     * `bigint` because a modern volume overflows a 32-bit int by three
     * orders of magnitude. TypeORM hands `bigint` back as a STRING on
     * Postgres and a number on sqlite, so nothing may read this column
     * without normalizing it — `FleetService.toView` is the one place
     * that does (see `toOptionalNumber` there).
     */
    @Column({ type: 'bigint', nullable: true })
    diskFreeBytes?: string | number | null;

    /**
     * Fleet cost accounting (EW-777) — which account / seat the agent CLI
     * on this machine is logged in as, as last reported by the node
     * (`claude-code: user@example.com (Acme, max)`, `codex: chatgpt`). A
     * display label the node builds from whitelisted fields; never a
     * credential. Makes the spend a run reports ATTRIBUTABLE to the
     * subscription that paid for it — it does not decide which
     * subscription that should be (dedicated seat per PC vs the owner's
     * own login is the founder's call; see
     * `docs/internal/feat-fleet-cost-accounting-notes.md`).
     *
     * Same additive telemetry contract as {@link cliVersion}: absent on a
     * heartbeat means "leave alone", so an older daemon never blanks it.
     * Migration: `1788300000000-AddFleetCostAccounting`.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    modelIdentity?: string | null;

    /**
     * Per-node DAILY (UTC day) model-spend ceiling in cents. NULL = inherit
     * the deployment default (`FLEET_NODE_DAILY_COST_CEILING_USD`), itself
     * unset by default, i.e. no ceiling. `FleetCostCeilingService`
     * evaluates it on every fleet job completion against
     * `SUM(fleet_jobs.costCents)` for the day; crossing it DRAINS the node
     * (`disabled` + claims requeued) — the same stop the drain endpoint
     * applies, chosen over `paused` because a node can lift its own pause
     * but not an owner-level disable.
     */
    @Column({ type: 'int', nullable: true })
    dailyCostCeilingCents?: number | null;

    /**
     * The UTC day (`YYYY-MM-DD`) this node was last drained by its daily
     * ceiling. The ONE-NOTICE idempotency key: the trip is a CAS on this
     * column (`FleetNodeRepository.casTripDailyCeiling`), so however many
     * completions cross the ceiling on one day, exactly one of them files
     * the Inbox notice. Draining itself is repeated on every crossing —
     * a ceiling is a stop, not a rate limit. Cleared whenever the owner
     * changes the ceiling (`FleetService.setDailyCostCeilingForUser`): the
     * next crossing of a NEW ceiling is news again.
     */
    @Column({ type: 'varchar', length: 10, nullable: true })
    dailyCostTrippedOn?: string | null;

    /**
     * Fleet health signals (EW-776) — what the node's WORKER last
     * reported doing: `idle | working | paused | quarantined | throttled`.
     *
     * NULL means the node has never reported one (a daemon predating the
     * field, a visibility-only node with its worker disabled, or a value
     * this build did not recognise). Rendered as "unknown", never as
     * `idle`: the whole reason this column exists is that `status:
     * 'online'` was being read as "healthy" by a machine that had
     * self-quarantined and was refusing every job.
     *
     * Never stored verbatim from the wire — `FleetService` runs every
     * incoming value through `normalizeFleetNodeWorkerState` first.
     * Same additive contract as {@link cliVersion}: a beat that omits the
     * field leaves the stored value alone.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    workerState?: FleetNodeWorkerState | null;

    /**
     * Why the worker is in that state — the quarantine's own message, the
     * resource ceiling that throttled the lease — sanitized and capped at
     * `FLEET_MAX_WORKER_STATE_REASON_LENGTH`. NULL when the state carries
     * no reason worth reading.
     */
    @Column({ type: 'varchar', length: 500, nullable: true })
    workerStateReason?: string | null;

    /**
     * When {@link workerState} last CHANGED. Stamped only on a transition,
     * not on every beat: "quarantined since 03:14" is the fact an operator
     * needs, and re-stamping it twice a minute would erase it.
     */
    @PortableDateColumn({ nullable: true })
    workerStateChangedAt?: Date | null;

    /**
     * Dedup marker: set when the online → offline notice for the CURRENT
     * outage was filed, cleared by the beat that brings the node back.
     *
     * The marker lives on the row rather than in the Inbox because
     * `InboxService.notice` files unconditionally — it has no dedup of its
     * own — so "exactly one notice per transition" has to be a CAS
     * somewhere, and the node row is the only thing both the sweep and the
     * heartbeat already touch. Written by
     * `FleetNodeRepository.markOfflineIfStale`, which is a conditional
     * UPDATE on `status = 'online'`: two API replicas sweeping the same
     * owner at once produce one notice, not two.
     */
    @PortableDateColumn({ nullable: true })
    offlineNoticedAt?: Date | null;

    /**
     * Dedup marker for the SECOND, louder notice: this machine has now
     * been gone longer than `FLEET_NODE_OFFLINE_NOTICE_AFTER_MS` (default
     * 30 minutes). One per outage — the sweep runs on every list read, and
     * without this the owner would get a notice every 30 seconds for as
     * long as the PC stayed off. Cleared by the beat that brings it back,
     * so the NEXT outage notifies again.
     */
    @PortableDateColumn({ nullable: true })
    offlineLongNoticedAt?: Date | null;

    /**
     * Dedup marker for the online → quarantined notice, set on the FIRST
     * beat that reports the quarantine and cleared by the first beat that
     * reports anything else. That re-arm is what makes a second
     * quarantine, hours later, news again.
     */
    @PortableDateColumn({ nullable: true })
    quarantineNoticedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
