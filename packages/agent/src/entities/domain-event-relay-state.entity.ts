import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/** Primary key of the one relay-state row. */
export const DOMAIN_EVENT_RELAY_STATE_ID = 'relay';

/**
 * State of the domain event relay (EW-P1-1): ONE row shared by every API
 * replica.
 *
 * - **Lease.** A replica becomes the relay leader by taking `holder` with a
 *   compare-and-set (free or expired); the leader renews `leaseExpiresAt`
 *   while it runs. The same compare-and-set fences position assignment: a
 *   batch commits only if this replica still holds an unexpired lease AND
 *   `lastSeq` is still the value it read.
 * - **`lastSeq`** — the last feed position handed out; the feed's `head`.
 * - **`retentionFloorSeq`** — the highest position the retention job has
 *   deleted; a feed cursor below it answers `410 cursor_expired`.
 *
 * Both sequence columns are `bigint`: strings on Postgres/MySQL, numbers on
 * SQLite — read them through `String(...)`.
 */
@Entity({ name: 'domain_event_relay_state' })
export class DomainEventRelayState {
    @PrimaryColumn({ type: 'varchar', length: 32 })
    id: string;

    /** `<pid>:<random>` of the replica holding the lease, or `null`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    holder?: string | null;

    @PortableDateColumn({ nullable: true })
    leaseExpiresAt?: Date | null;

    @Column({ type: 'bigint', default: 0 })
    lastSeq: string | number;

    @Column({ type: 'bigint', default: 0 })
    retentionFloorSeq: string | number;

    @UpdateDateColumn()
    updatedAt: Date;
}
