import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/** The primary key of the one schedule row. */
export const EVER_STATS_LEASE_ROW_ID = 'self';

/**
 * The schedule of the anonymous usage statistics module and the lease that
 * makes N API replicas on one database send ONE report, not N.
 *
 * - **Lease.** A replica that wants to send takes the row with a
 *   compare-and-set (`holder`, `expiresAt` = now + 15 min) and only the winner
 *   sends; the others skip. The lease is released after the attempt.
 * - **Schedule.** `nextSendAt` is shared by every replica, so a restart or a
 *   second replica never resets or doubles the daily send. `failures` drives
 *   the retry ladder (+1 h, +4 h, +12 h, next day), and `rejectedModuleVersion`
 *   stops retries of a report the receiver refused until the module is
 *   upgraded (or the identity is reset).
 */
@Entity({ name: 'ever_stats_lease' })
export class EverStatsLease {
    @PrimaryColumn({ type: 'varchar', length: 16 })
    id: string;

    /** `<pid>:<random>` of the replica holding the lease, or `null`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    holder?: string | null;

    @PortableDateColumn({ nullable: true })
    expiresAt?: Date | null;

    /** When the next scheduled report is due. */
    @PortableDateColumn({ nullable: true })
    nextSendAt?: Date | null;

    /** Consecutive `failed` attempts (0 after any answer from the receiver). */
    @Column({ type: 'int', default: 0 })
    failures: number;

    /** Set after a `rejected` report: no retry while the module version is this one. */
    @Column({ type: 'varchar', length: 14, nullable: true })
    rejectedModuleVersion?: string | null;

    /** When the operator last used *Send now* (rate limit: one per 10 minutes). */
    @PortableDateColumn({ nullable: true })
    lastManualSendAt?: Date | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
