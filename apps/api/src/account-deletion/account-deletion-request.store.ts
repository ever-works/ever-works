import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import { AccountDeletionRequest } from '@ever-works/agent/entities';
import type {
    AccountDeletionSource,
    AccountDeletionStatus,
    AccountDeletionSummary,
} from '@ever-works/agent/entities';

export interface NewAccountDeletionRequest {
    source: AccountDeletionSource;
    emailHash: string;
    tokenHash: string | null;
    userId: string | null;
    status: AccountDeletionStatus;
    expiresAt: Date | null;
    consumedAt?: Date | null;
    completedAt?: Date | null;
    summary?: AccountDeletionSummary | null;
}

export type AccountDeletionRequestPatch = Partial<
    Pick<
        AccountDeletionRequest,
        'status' | 'userId' | 'completedAt' | 'consumedAt' | 'summary' | 'failureCode'
    >
>;

/**
 * Persistence seam of the deletion flow. The TypeORM implementation below is
 * what runs; the token service's unit tests drive an in-memory twin with the
 * same contract — in particular {@link claim}, the ONE atomic gate that makes
 * a link single-use.
 */
export abstract class AccountDeletionRequestStore {
    /** Email-link rows issued for this address since `since` (the per-address rate limit). */
    abstract countIssuedSince(emailHash: string, since: Date): Promise<number>;
    /** Revoke every still-pending link of this address. Returns how many were revoked. */
    abstract revokePending(emailHash: string): Promise<number>;
    abstract insert(row: NewAccountDeletionRequest): Promise<AccountDeletionRequest>;
    abstract findByTokenHash(tokenHash: string): Promise<AccountDeletionRequest | null>;
    /**
     * Atomically move a `pending`, unexpired row to `consumed`. `true` only for
     * the single caller whose UPDATE matched — every concurrent or later
     * attempt gets `false`.
     */
    abstract claim(tokenHash: string, now: Date): Promise<boolean>;
    abstract update(id: string, patch: AccountDeletionRequestPatch): Promise<void>;
}

@Injectable()
export class TypeormAccountDeletionRequestStore extends AccountDeletionRequestStore {
    private readonly repository: Repository<AccountDeletionRequest>;

    constructor(@InjectDataSource() dataSource: DataSource) {
        super();
        this.repository = dataSource.getRepository(AccountDeletionRequest);
    }

    async countIssuedSince(emailHash: string, since: Date): Promise<number> {
        return this.repository.count({
            where: { emailHash, source: 'email_link', createdAt: MoreThanOrEqual(since) },
        });
    }

    async revokePending(emailHash: string): Promise<number> {
        const result = await this.repository.update(
            { emailHash, status: 'pending' },
            { status: 'revoked' },
        );
        return result.affected ?? 0;
    }

    async insert(row: NewAccountDeletionRequest): Promise<AccountDeletionRequest> {
        const entity = this.repository.create({
            consumedAt: null,
            completedAt: null,
            summary: null,
            failureCode: null,
            ...row,
        });
        return this.repository.save(entity);
    }

    async findByTokenHash(tokenHash: string): Promise<AccountDeletionRequest | null> {
        return this.repository.findOne({ where: { tokenHash } });
    }

    async claim(tokenHash: string, now: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(AccountDeletionRequest)
            .set({ status: 'consumed', consumedAt: now })
            // Object form so TypeORM quotes the identifiers per dialect
            // (Postgres, SQLite and MySQL disagree on how).
            .where({ tokenHash, status: 'pending', expiresAt: MoreThan(now) })
            .execute();
        return (result.affected ?? 0) === 1;
    }

    async update(id: string, patch: AccountDeletionRequestPatch): Promise<void> {
        await this.repository.update({ id }, patch);
    }
}
