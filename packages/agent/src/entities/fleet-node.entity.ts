import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { FleetNodeKind, FleetNodeStatus } from '@ever-works/contracts';
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
export type { FleetNodeKind, FleetNodeStatus } from '@ever-works/contracts';

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

    /** 'enrolling' | 'online' | 'offline' | 'disabled'. */
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

    /** Capability tags ('terminal', 'workspace', 'docker', ...). */
    @Column({ type: 'simple-json' })
    capabilities: string[];

    /** os/arch self-description, e.g. 'linux/x64' (sanitized at enroll). */
    @Column({ type: 'varchar', length: 64, nullable: true })
    platform?: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    version?: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
