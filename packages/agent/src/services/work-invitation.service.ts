import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { WorkInvitationRepository } from '../database/repositories/work-invitation.repository';
import { WorkInvitation } from '../entities/work-invitation.entity';
import {
    ALL_INVITATION_ROLES,
    INVITATION_ROLE_OWNER_CLAIM,
    InvitationRole,
    WorkInvitationStatus,
    WorkInvitationTransferState,
    WorkInvitationMetadata,
} from '../entities';

export type IssuedInvitation = {
    invitation: WorkInvitation;
    /** Raw token, returned ONCE — only the hash is persisted. */
    token: string;
};

export type CreateInvitationInput = {
    workId: string;
    invitedById: string;
    role: InvitationRole;
    email?: string | null;
    expiresInDays?: number;
    metadata?: WorkInvitationMetadata | null;
};

const DEFAULT_EXPIRES_IN_DAYS = 30;
const MAX_EXPIRES_IN_DAYS = 90;
const TOKEN_BYTES = 32;

@Injectable()
export class WorkInvitationService {
    constructor(private readonly invitations: WorkInvitationRepository) {}

    async issue(input: CreateInvitationInput): Promise<IssuedInvitation> {
        this.assertRole(input.role);
        const expiresInDays = this.normaliseExpiry(input.expiresInDays);

        if (input.role === INVITATION_ROLE_OWNER_CLAIM) {
            const username = input.metadata?.expectedProviderUsername;
            if (!username || typeof username !== 'string' || username.trim() === '') {
                throw new BadRequestException(
                    'owner-claim invitations require metadata.expectedProviderUsername',
                );
            }
        }

        const token = this.generateToken();
        const tokenHash = this.hashToken(token);
        const tokenExpiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

        const invitation = await this.invitations.create({
            workId: input.workId,
            invitedById: input.invitedById,
            role: input.role,
            email: input.email ?? null,
            tokenHash,
            tokenExpiresAt,
            status: WorkInvitationStatus.PENDING,
            metadata: input.metadata ?? null,
            transferState:
                input.role === INVITATION_ROLE_OWNER_CLAIM ? { status: 'not_required' } : null,
        });

        return { invitation, token };
    }

    async listPending(workId: string): Promise<WorkInvitation[]> {
        return this.invitations.listPendingForWork(workId);
    }

    async revoke(invitationId: string, actorUserId: string): Promise<void> {
        const invitation = await this.invitations.findById(invitationId);
        if (!invitation) {
            throw new NotFoundException('invitation_not_found');
        }
        if (invitation.status !== WorkInvitationStatus.PENDING) {
            throw new BadRequestException('invitation_not_pending');
        }
        if (invitation.invitedById !== actorUserId) {
            // Authorization beyond inviter (e.g., owner/manager) is enforced
            // by the caller; this is a defensive default.
        }
        const ok = await this.invitations.markRevoked(invitationId);
        if (!ok) {
            throw new BadRequestException('invitation_state_changed');
        }
    }

    async findConsumable(token: string): Promise<WorkInvitation> {
        if (!token || typeof token !== 'string') {
            throw new BadRequestException('invalid_token');
        }
        const invitation = await this.invitations.findByTokenHash(this.hashToken(token));
        if (!invitation) {
            throw new NotFoundException('invitation_not_found');
        }
        if (invitation.status === WorkInvitationStatus.REVOKED) {
            throw new ForbiddenException('invitation_revoked');
        }
        if (invitation.status === WorkInvitationStatus.ACCEPTED) {
            throw new BadRequestException('invitation_already_accepted');
        }
        if (invitation.isExpired()) {
            await this.invitations.expireBefore(new Date()).catch(() => 0);
            throw new BadRequestException('invitation_expired');
        }
        return invitation;
    }

    async tryAccept(invitationId: string, acceptedByUserId: string): Promise<boolean> {
        return this.invitations.tryMarkAccepted(invitationId, acceptedByUserId, new Date());
    }

    async setTransferState(
        invitationId: string,
        transferState: WorkInvitationTransferState,
    ): Promise<void> {
        await this.invitations.updateTransferState(invitationId, transferState);
    }

    async sweepExpired(now: Date = new Date()): Promise<number> {
        return this.invitations.expireBefore(now);
    }

    verifyToken(token: string, tokenHash: string): boolean {
        const expected = this.hashToken(token);
        if (expected.length !== tokenHash.length) return false;
        return timingSafeEqual(Buffer.from(expected), Buffer.from(tokenHash));
    }

    private assertRole(role: InvitationRole): void {
        if (!ALL_INVITATION_ROLES.includes(role)) {
            throw new BadRequestException(`invalid_role:${role}`);
        }
    }

    private normaliseExpiry(requested: number | undefined): number {
        if (requested === undefined) return DEFAULT_EXPIRES_IN_DAYS;
        if (!Number.isInteger(requested) || requested < 1) {
            throw new BadRequestException('expiresInDays must be a positive integer');
        }
        if (requested > MAX_EXPIRES_IN_DAYS) {
            throw new BadRequestException(`expiresInDays cannot exceed ${MAX_EXPIRES_IN_DAYS}`);
        }
        return requested;
    }

    private generateToken(): string {
        return randomBytes(TOKEN_BYTES).toString('hex');
    }

    private hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }
}
