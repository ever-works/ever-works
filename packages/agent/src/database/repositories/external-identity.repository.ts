import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import {
    ExternalIdentity,
    type ExternalIdentityDelegatedClient,
    type ExternalIdentityLinkedVia,
} from '../../entities/external-identity.entity';

/** At most this many delegated clients are remembered per identity (FR-31, FR-48). */
export const EXTERNAL_IDENTITY_DELEGATED_CLIENTS_MAX = 10;

/** Which uniqueness rule an insert broke (APW-12 plan §3.1, FR-21, FR-27). */
export type ExternalIdentityConflictReason = 'subjectLinked' | 'userHasIssuer';

/**
 * An insert refused by one of the two unique constraints of
 * `external_identities`.
 *
 * - `subjectLinked` — the pair (issuer, subject) is already connected to an
 *   account (S12; also the losing side of the S24 race).
 * - `userHasIssuer` — the account already has a pair for this issuer (S13).
 *
 * The message names the rule and nothing else: never the other account, never
 * the subject (FR-27).
 */
export class ExternalIdentityConflictError extends Error {
    constructor(readonly reason: ExternalIdentityConflictReason) {
        super(`external identity conflict: ${reason}`);
        this.name = 'ExternalIdentityConflictError';
    }
}

/** What a new connected identity is created from (FR-31's list). */
export interface ExternalIdentityLinkInput {
    userId: string;
    issuer: string;
    subject: string;
    emailAtLink: string;
    emailVerifiedAtLink: boolean;
    linkedVia: ExternalIdentityLinkedVia;
    tenantId?: string | null;
    /** Defaults to now. */
    linkedAt?: Date;
}

/**
 * APW-12 (Ever ID) — persistence of connected identities (plan §3.1).
 *
 * Every lookup that selects an account goes through the pair
 * (`findByIssuerSubject`); nothing here resolves an account by e-mail
 * (FR-22). The unique constraints decide every race: `insertLink` maps a
 * violation onto {@link ExternalIdentityConflictError} instead of pre-checking
 * and hoping, so two replicas inserting the same pair at once leave exactly one
 * row (S24, ACC-12-19).
 */
@Injectable()
export class ExternalIdentityRepository {
    constructor(
        @InjectRepository(ExternalIdentity)
        private readonly repository: Repository<ExternalIdentity>,
    ) {}

    findById(id: string): Promise<ExternalIdentity | null> {
        return this.repository.findOne({ where: { id } });
    }

    findByIssuerSubject(issuer: string, subject: string): Promise<ExternalIdentity | null> {
        return this.repository.findOne({ where: { issuer, subject } });
    }

    findByUserAndIssuer(userId: string, issuer: string): Promise<ExternalIdentity | null> {
        return this.repository.findOne({ where: { userId, issuer } });
    }

    /** Every connected identity of one account, oldest first. */
    listForUser(userId: string): Promise<ExternalIdentity[]> {
        return this.repository.find({ where: { userId }, order: { linkedAt: 'ASC' } });
    }

    /** Whether any identity of this issuer is connected at all — a cheap existence probe. */
    existsForIssuer(issuer: string): Promise<boolean> {
        return this.repository.exists({ where: { issuer } });
    }

    /**
     * Connect a pair to an account. A unique-constraint violation is answered
     * with the rule it broke, read back from the table rather than parsed from a
     * driver message (the four supported engines word it four different ways).
     */
    async insertLink(input: ExternalIdentityLinkInput): Promise<ExternalIdentity> {
        const entity = this.repository.create({
            userId: input.userId,
            issuer: input.issuer,
            subject: input.subject,
            emailAtLink: input.emailAtLink,
            emailVerifiedAtLink: input.emailVerifiedAtLink,
            linkedVia: input.linkedVia,
            linkedAt: input.linkedAt ?? new Date(),
            lastLoginAt: null,
            delegatedClients: null,
            tenantId: input.tenantId ?? null,
        });
        try {
            return await this.repository.save(entity);
        } catch (error) {
            if (!(error instanceof QueryFailedError)) throw error;
            const reason = await this.conflictReason(input);
            if (reason) throw new ExternalIdentityConflictError(reason);
            throw error;
        }
    }

    /**
     * Delete one identity of one account. `false` when no such row exists for
     * that account — the caller answers 404 without saying whether the id
     * exists for someone else.
     */
    async deleteForUser(id: string, userId: string): Promise<boolean> {
        const result = await this.repository.delete({ id, userId });
        return (result.affected ?? 0) > 0;
    }

    /** Record a sign-in through this identity (never called by a delegated read, FR-47). */
    async touchLogin(id: string, at: Date = new Date()): Promise<void> {
        await this.repository.update({ id }, { lastLoginAt: at });
    }

    /**
     * Remember that `clientId` read the person's App Works with a delegated
     * permission (FR-31, FR-48). The list keeps one entry per client, newest
     * first, and at most {@link EXTERNAL_IDENTITY_DELEGATED_CLIENTS_MAX}
     * entries — the oldest is evicted.
     *
     * Returns whether this is the client's first read in the last `windowMs`
     * (so the caller can write FR-49's "first delegated read per app per 24
     * hours" Activity row exactly once).
     */
    async recordDelegatedClient(
        id: string,
        clientId: string,
        at: Date = new Date(),
        windowMs: number = 24 * 60 * 60 * 1000,
    ): Promise<{ firstInWindow: boolean }> {
        const row = await this.repository.findOne({ where: { id } });
        if (!row) return { firstInWindow: false };

        const existing = Array.isArray(row.delegatedClients) ? row.delegatedClients : [];
        const previous = existing.find((client) => client.clientId === clientId);
        const previousAt = previous ? Date.parse(previous.lastSeenAt) : Number.NaN;
        const firstInWindow = !Number.isFinite(previousAt) || at.getTime() - previousAt >= windowMs;

        const next: ExternalIdentityDelegatedClient[] = [
            { clientId, lastSeenAt: at.toISOString() },
            ...existing.filter((client) => client.clientId !== clientId),
        ].slice(0, EXTERNAL_IDENTITY_DELEGATED_CLIENTS_MAX);

        await this.repository.update({ id }, { delegatedClients: next });
        return { firstInWindow };
    }

    /** Which unique rule a failed insert of `input` broke, if either. */
    private async conflictReason(
        input: Pick<ExternalIdentityLinkInput, 'issuer' | 'subject' | 'userId'>,
    ): Promise<ExternalIdentityConflictReason | null> {
        const pair = await this.findByIssuerSubject(input.issuer, input.subject);
        if (pair) return 'subjectLinked';
        const userIssuer = await this.findByUserAndIssuer(input.userId, input.issuer);
        if (userIssuer) return 'userHasIssuer';
        return null;
    }
}
