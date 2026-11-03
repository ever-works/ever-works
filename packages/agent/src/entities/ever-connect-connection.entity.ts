import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/** The primary key of the one connection row. */
export const EVER_CONNECT_CONNECTION_ROW_ID = 'self';

/**
 * Where this installation's connection to Ever Platform stands.
 *
 * - `disconnected`: never connected, or disconnected (by the operator or by Ever Platform).
 * - `pending_approval`: connected with a code that waits for an organization owner's approval.
 * - `active`: connected; calls are made with the installation's own token.
 * - `revoked`: Ever Platform revoked the installation's credential.
 */
export type EverConnectConnectionStatus =
    | 'disconnected'
    | 'pending_approval'
    | 'active'
    | 'revoked';

/**
 * This installation's connection to Ever Platform: ONE row (`id = 'self'`).
 *
 * Holds identifiers only: Ever Platform's id for the installation (its
 * Registry id), the connect key id, the feed position and the hash of a
 * connect code read from the environment (so it is used once). The connect key
 * itself lives on `ever_instance` (wrapped), tokens only in memory.
 */
@Entity({ name: 'ever_connect_connection' })
export class EverConnectConnection {
    @PrimaryColumn({ type: 'varchar', length: 16 })
    id: string;

    @Column({ type: 'varchar', length: 24, default: 'disconnected' })
    status: EverConnectConnectionStatus;

    /** Ever Platform's id for this installation (a ULID), set by the redeem. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    platformInstanceId: string | null;

    /** The id of the connect key the installation was connected with. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    kid: string | null;

    @PortableDateColumn({ nullable: true })
    connectedAt: Date | null;

    @PortableDateColumn({ nullable: true })
    disconnectedAt: Date | null;

    /** The id of the last feed event handled and acknowledged. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    lastFeedCursor: string | null;

    /** sha256 of the `EVER_CONNECT_CODE` already used, so it is never redeemed twice. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    envCodeConsumedHash: string | null;

    /** The machine code of the last failed connect, shown to the operator. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    lastError: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
