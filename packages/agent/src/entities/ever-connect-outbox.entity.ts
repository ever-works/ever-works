import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Where an outbox row stands: `pending` until delivered (`sent`), or never to be
 * delivered: `dropped` (nothing to report any more) or `failed` (refused).
 */
export type EverConnectOutboxState = 'pending' | 'sent' | 'dropped' | 'failed';

/**
 * A report this installation owes Ever Platform, kept until it is delivered:
 * written when the change happens, sent by the outbox worker with retries.
 *
 * `event` names the kind of report (`person_link`); `payload` is its body
 * (identifiers only, never an e-mail address or a name); `dedupeKey` makes a
 * report written twice one row.
 */
@Entity({ name: 'ever_connect_outbox' })
@Index('uq_ever_connect_outbox_dedupe', ['dedupeKey'], { unique: true })
@Index('idx_ever_connect_outbox_due', ['state', 'nextAttemptAt'])
@Index('idx_ever_connect_outbox_account', ['accountRef'])
export class EverConnectOutbox {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 64 })
    event: string;

    @Column({ type: 'simple-json' })
    payload: Record<string, unknown>;

    @Column({ type: 'varchar', length: 128 })
    dedupeKey: string;

    /**
     * The order reports were written in (milliseconds × 1000 plus a counter):
     * reports about one account are sent in this order.
     */
    @Column({ type: 'bigint', default: 0 })
    seq: string;

    /** The local account a report is about: its reports are delivered in `seq` order. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    accountRef: string | null;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    state: EverConnectOutboxState;

    /** Deliveries tried so far. */
    @Column({ type: 'int', default: 0 })
    attempts: number;

    @PortableDateColumn()
    nextAttemptAt: Date;

    @PortableDateColumn({ nullable: true })
    sentAt: Date | null;

    /** The machine code of the last failed delivery. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    lastError: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
