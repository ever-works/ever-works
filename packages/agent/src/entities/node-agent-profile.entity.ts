import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Agent computers — one Agent's OWN profile on one Node: its browser
 * profile, its cookies and signed-in sessions, its file root.
 *
 * The isolation guarantee this row stands for: two Agents on one machine
 * never share a profile, so one Agent can never see the accounts another
 * is signed into, and resetting one Agent's logins touches no other.
 * Exactly one row per (Node, Agent) — enforced by the unique index.
 *
 * `profileKey` is an OPAQUE id minted by the platform. The Node maps it to
 * a directory under its own data root. The platform NEVER stores a
 * filesystem path, and a reset rotates the key, which is how the Node
 * learns that the directory it holds for this Agent is no longer the one
 * to use.
 *
 * Written by `NodeAgentProfileService` (lazy create, the Node's own usage
 * report, reset). Raw uuid scope columns; foreign keys live in the
 * migration (`1791110000000-CreateComputerSessions`).
 */
@Entity({ name: 'node_agent_profiles' })
@Index('uq_node_agent_profiles_node_agent', ['nodeId', 'agentId'], { unique: true })
@Index('idx_node_agent_profiles_user_agent', ['userId', 'agentId'])
export class NodeAgentProfile {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The Node's owner. */
    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column({ type: 'uuid' })
    nodeId: string;

    @Column({ type: 'uuid' })
    agentId: string;

    /** Opaque id the Node maps to a directory — never a path. Rotated by a reset. */
    @Column({ type: 'varchar', length: 64 })
    profileKey: string;

    @CreateDateColumn()
    createdAt: Date;

    /** Last time the Node reported using this profile. */
    @PortableDateColumn({ nullable: true })
    lastUsedAt?: Date | null;

    /** Sites the profile holds a signed-in session for, as the Node last reported. */
    @Column({ type: 'int', default: 0 })
    signedInSiteCount: number;

    /** Disk the profile occupies, as the Node last reported. `bigint`; normalized in the view. */
    @Column({ type: 'bigint', default: 0 })
    diskBytes: string | number;

    @PortableDateColumn({ nullable: true })
    lastResetAt?: Date | null;

    @Column({ type: 'uuid', nullable: true })
    lastResetByUserId?: string | null;
}
