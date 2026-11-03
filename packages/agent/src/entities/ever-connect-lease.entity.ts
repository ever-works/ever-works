import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/** The primary key of the one lease row. */
export const EVER_CONNECT_LEASE_ROW_ID = 'self';

/**
 * The lease that makes N API replicas on one database run ONE Ever Connect
 * worker: the replica holding it reads the feed and sends the outbox, the
 * others wait. Taken and renewed with a compare-and-set (`holder`,
 * `expiresAt`); separate from the statistics lease.
 */
@Entity({ name: 'ever_connect_lease' })
export class EverConnectLease {
    @PrimaryColumn({ type: 'varchar', length: 16 })
    id: string;

    /** `<pid>:<random>` of the replica holding the lease, or `null`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    holder: string | null;

    @PortableDateColumn({ nullable: true })
    expiresAt: Date | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
