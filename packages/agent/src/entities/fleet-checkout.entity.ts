import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    FleetCheckoutCreatedBy,
    FleetCheckoutIsolation,
    FleetCheckoutKind,
    FleetCheckoutLastCommand,
    FleetCheckoutState,
    FleetGitLine,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Checkouts on computers (FL-14, CONTRACTS §4.3, R-16) — one git clone or
 * worktree on a Node.
 *
 * The NODE is the source of truth for the folder: whether it is there, its
 * branch, its git line, its size. This row is the platform's registry over
 * what the node reports (`checkouts.list`), plus what only the platform
 * holds: the bin (`state = 'archived'`, `archivedAt`), the link to a
 * repository Work (`workId`, matched by remote — R-16) and the last command
 * a person ran on it.
 *
 * `(nodeId, path)` is unique: the node keys a checkout by its absolute path
 * and discovery never registers one path twice (spec U13). `remoteUrl` is
 * ALWAYS token-free — stripped on the node before it left the machine and
 * again by the contracts parser before it reaches this row (spec FR-5); a
 * remote that carried one sets `remoteHadCredential`.
 *
 * Written ONLY by `FleetCheckoutService` (node lists, archive/restore, sync
 * outcomes) and the reconcile sweep. No Organization column (CONTRACTS §4.3
 * has none): R-19 limits are read from the Node's binding at request time.
 *
 * Scope columns are raw uuids (no `@ManyToOne`) per the entity-cycle rule;
 * foreign keys live in the migration (`1796140000000-CreateFleetCheckouts`).
 * Registered in `database/_entities-inventory.ts` and `_entity-names.ts`.
 */
@Entity({ name: 'fleet_checkouts' })
@Index('idx_fleet_checkouts_node_state', ['nodeId', 'state'])
@Index('idx_fleet_checkouts_user_state', ['userId', 'state'])
@Index('idx_fleet_checkouts_work', ['workId'])
@Index('uq_fleet_checkouts_node_path', ['nodeId', 'path'], { unique: true })
export class FleetCheckout {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Which machine. Never changes. */
    @Column({ type: 'uuid' })
    nodeId: string;

    /** The Node's owner (every read is scoped through the Node's policy). */
    @Column({ type: 'uuid' })
    userId: string;

    /** Absolute path on the node — the node's key for it. Never changes. */
    @Column({ type: 'text' })
    path: string;

    /** `clone` | `worktree` | `discovered`. */
    @Column({ type: 'varchar', length: 16 })
    kind: FleetCheckoutKind;

    /** The checkout this one is a worktree of. */
    @Column({ type: 'uuid', nullable: true })
    parentCheckoutId?: string | null;

    /** Token-free remote of `origin`, when it has one. */
    @Column({ type: 'text', nullable: true })
    remoteUrl?: string | null;

    /** The remote carried a credential that was stripped (spec FR-5, U12). */
    @Column({ type: 'boolean', default: false })
    remoteHadCredential: boolean;

    /** The repository Work whose remote matches (R-16), host-aware. */
    @Column({ type: 'uuid', nullable: true })
    workId?: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    branch?: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    baseRef?: string | null;

    /** `host` | `container` (P3). */
    @Column({ type: 'varchar', length: 12, default: 'host' })
    isolation: FleetCheckoutIsolation;

    /** `creating` | `ready` | `missing` | `archived` (spec §1). */
    @Column({ type: 'varchar', length: 12, default: 'ready' })
    state: FleetCheckoutState;

    /** `user` | `agent` | `task` | `discovery`. Set once. */
    @Column({ type: 'varchar', length: 12 })
    createdBy: FleetCheckoutCreatedBy;

    /** The git line snapshot (CONTRACTS §4.7), `simple-json` text. */
    @Column({ type: 'simple-json', nullable: true })
    gitLine?: FleetGitLine | null;

    /** `{ command, exitCode, at, stderrHead?, operationId? }`, `simple-json` text. */
    @Column({ type: 'simple-json', nullable: true })
    lastCommand?: FleetCheckoutLastCommand | null;

    /** Size on disk (spec FR-14). `bigint`: a STRING on Postgres, a number on SQLite — normalized in the view. */
    @Column({ type: 'bigint', nullable: true })
    sizeBytes?: string | number | null;

    /** Last time the node reported the folder present (discovery or refresh). */
    @PortableDateColumn({ nullable: true })
    lastSeenAt?: Date | null;

    /** When it entered the bin. */
    @PortableDateColumn({ nullable: true })
    archivedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
