import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/** Which request Ever Platform made for a person. */
export type EverConnectPersonRequestKind = 'deletion' | 'export';

/**
 * The installation's answer to one deletion or export request Ever Platform
 * made for a person (an Ever ID account whose links reach this installation).
 *
 * One row per platform job: the answer is decided once and kept, so a request
 * delivered again is answered with the same result instead of being worked out
 * again from data the first run already removed. `answeredAt` is set when Ever
 * Platform recorded the answer.
 *
 * Identifiers only: the platform's ids, a machine reason code, the legal basis a
 * `retained_legal` answer names and the export address — never a subject, its
 * hash, an e-mail address or a name.
 */
@Entity({ name: 'ever_connect_person_requests' })
@Index('uq_ever_connect_person_requests_job', ['jobId'], { unique: true })
export class EverConnectPersonRequest {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Ever Platform's job id (a ULID). */
    @Column({ type: 'varchar', length: 64 })
    jobId: string;

    /** The id of the feed event that carried the request. */
    @Column({ type: 'varchar', length: 64 })
    eventId: string;

    @Column({ type: 'varchar', length: 16 })
    kind: EverConnectPersonRequestKind;

    /** The answer: `deleted`, `anonymised`, `retained_legal`, `no_account`, `exported` or `failed`. */
    @Column({ type: 'varchar', length: 32 })
    result: string;

    /** Why a `failed` answer failed, a machine token such as `account_deletion_pending`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    reasonCode: string | null;

    /** The statute or contract clause a `retained_legal` answer keeps the data under. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    legalBasis: string | null;

    /** The `https` address of the export an `exported` answer points to. */
    @Column({ type: 'varchar', length: 2048, nullable: true })
    exportUrl: string | null;

    /** When Ever Platform recorded the answer; NULL until then. */
    @PortableDateColumn({ nullable: true })
    answeredAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
