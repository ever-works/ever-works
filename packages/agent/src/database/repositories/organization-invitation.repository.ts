import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { OrganizationInvitation } from '../../entities/organization-invitation.entity';
import { OrganizationInvitationStatus } from '../../entities/types';

/**
 * Data access for `OrganizationInvitation`.
 *
 * Mirrors `WorkInvitationRepository`, including the one method that carries
 * the concurrency guarantee: `tryMarkAccepted` is a conditional UPDATE, not a
 * read-then-write, so two people redeeming the same token race in the
 * database and exactly one wins.
 */
@Injectable()
export class OrganizationInvitationRepository {
    constructor(
        @InjectRepository(OrganizationInvitation)
        private readonly repository: Repository<OrganizationInvitation>,
    ) {}

    async create(data: Partial<OrganizationInvitation>): Promise<OrganizationInvitation> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async findById(id: string): Promise<OrganizationInvitation | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByTokenHash(tokenHash: string): Promise<OrganizationInvitation | null> {
        return this.repository.findOne({ where: { tokenHash } });
    }

    /** The live invitation for this mailbox, if any — what the unique index protects. */
    async findPendingForEmail(
        organizationId: string,
        emailNormalized: string,
    ): Promise<OrganizationInvitation | null> {
        return this.repository.findOne({
            where: {
                organizationId,
                emailNormalized,
                status: OrganizationInvitationStatus.PENDING,
            },
        });
    }

    async listForOrganization(organizationId: string): Promise<OrganizationInvitation[]> {
        return this.repository.find({
            where: { organizationId },
            order: { createdAt: 'DESC' },
        });
    }

    async listPendingForOrganization(organizationId: string): Promise<OrganizationInvitation[]> {
        return this.repository.find({
            where: { organizationId, status: OrganizationInvitationStatus.PENDING },
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Claim the invitation, atomically.
     *
     * The `status = pending` predicate lives in the WHERE clause on purpose: a
     * read-then-write would let two concurrent redemptions of one token both
     * observe `pending` and both proceed, producing two memberships and two
     * tenant writes. Returns false if somebody else got there first.
     */
    async tryMarkAccepted(
        id: string,
        acceptedByUserId: string,
        acceptedAt: Date,
    ): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(OrganizationInvitation)
            .set({
                status: OrganizationInvitationStatus.ACCEPTED,
                acceptedByUserId,
                acceptedAt,
            })
            .where('id = :id AND status = :pending', {
                id,
                pending: OrganizationInvitationStatus.PENDING,
            })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async markRevoked(id: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(OrganizationInvitation)
            .set({ status: OrganizationInvitationStatus.REVOKED })
            .where('id = :id AND status = :pending', {
                id,
                pending: OrganizationInvitationStatus.PENDING,
            })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Move timed-out rows to `expired`.
     *
     * Housekeeping only — it does NOT gate access. Nothing runs this on a
     * timer, so consumption paths must still call `isExpired()` rather than
     * trusting `status`.
     */
    async expireBefore(now: Date): Promise<number> {
        const result = await this.repository
            .createQueryBuilder()
            .update(OrganizationInvitation)
            .set({ status: OrganizationInvitationStatus.EXPIRED })
            .where('status = :pending AND "tokenExpiresAt" <= :now', {
                pending: OrganizationInvitationStatus.PENDING,
                now,
            })
            .execute();
        return result.affected ?? 0;
    }

    async findExpiredPending(now: Date, limit = 100): Promise<OrganizationInvitation[]> {
        return this.repository.find({
            where: {
                status: OrganizationInvitationStatus.PENDING,
                tokenExpiresAt: LessThanOrEqual(now),
            },
            take: limit,
        });
    }
}
