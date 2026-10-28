import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/** Where a deletion came from. */
export type AccountDeletionSource = 'email_link' | 'in_product';

/**
 * Lifecycle of one row.
 *
 * - `pending`   — an email link was issued and can still be used.
 * - `revoked`   — a newer request for the same address replaced it.
 * - `consumed`  — the confirm POST won the atomic claim; the deletion is running.
 * - `completed` — the account is gone; the row is now the audit record.
 * - `failed`    — the deletion stopped part-way; `failureCode` says why.
 *
 * An unused link simply passes `expiresAt` — nothing rewrites it to an
 * "expired" status, every read compares the timestamp instead.
 */
export type AccountDeletionStatus = 'pending' | 'revoked' | 'consumed' | 'completed' | 'failed';

/** Counts written once the deletion finished. Never names, never addresses. */
export interface AccountDeletionSummary {
    worksDeleted?: number;
    organizationsDeleted?: number;
    workspaceDeleted?: boolean;
    workspaceTransferred?: boolean;
    membershipsRemoved?: number;
    contentReassigned?: number;
    apiKeysRevoked?: number;
    sessionsRevoked?: number;
    subscriptionsCanceled?: number;
    filesDeleted?: number;
}

/**
 * Self-serve account deletion — the email-link token AND the audit record.
 *
 * One row per request. For the public email-link flow it starts `pending` with
 * `tokenHash = sha256(token)` (the raw token only ever exists in the email);
 * for the in-product delete it is written straight as `completed`. When the
 * deletion completes the row keeps only what an auditor needs: the SHA-256 of
 * the lower-cased address, the timestamps and the counts. `userId` is cleared
 * at completion, so no row points at a person any more.
 *
 * No foreign key on `userId` on purpose: the row must outlive the user it
 * deletes.
 */
@Entity({ name: 'account_deletion_requests' })
@Index('idx_account_deletion_requests_token_hash', ['tokenHash'], { unique: true })
@Index('idx_account_deletion_requests_email_created', ['emailHash', 'createdAt'])
@Index('idx_account_deletion_requests_status', ['status'])
export class AccountDeletionRequest {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 16 })
    source: AccountDeletionSource;

    /** sha256(lower(trim(email))) in hex. */
    @Column({ type: 'varchar', length: 64 })
    emailHash: string;

    /** sha256(token) in hex; NULL for the in-product delete. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    tokenHash: string | null;

    /** The account the link was issued for; cleared once the deletion completes. */
    @Column({ type: 'uuid', nullable: true })
    userId: string | null;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: AccountDeletionStatus;

    @PortableDateColumn({ nullable: true })
    expiresAt: Date | null;

    @PortableDateColumn({ nullable: true })
    consumedAt: Date | null;

    @PortableDateColumn({ nullable: true })
    completedAt: Date | null;

    @Column('simple-json', { nullable: true })
    summary: AccountDeletionSummary | null;

    /** A short machine code, never a message that could carry user data. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    failureCode: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
