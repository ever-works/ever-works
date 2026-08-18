import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { OrganizationInvitationRepository } from '../database/repositories/organization-invitation.repository';
import { OrganizationInvitation } from '../entities/organization-invitation.entity';
import {
    ORGANIZATION_MEMBER_ROLES,
    OrganizationInvitationRole,
    OrganizationInvitationStatus,
} from '../entities/types';
import { isUniqueConstraintError } from '../utils/db-error.utils';

const TOKEN_BYTES = 32;
const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 30;
const MIN_EXPIRY_DAYS = 1;
/** RFC 5321 caps a path at 320 octets; the column is sized to match. */
const MAX_EMAIL_LENGTH = 320;

export type CreateOrganizationInvitationInput = {
    organizationId: string;
    tenantId: string;
    invitedById: string;
    email: string;
    role?: OrganizationInvitationRole;
    expiresInDays?: number;
    invitedName?: string;
};

export type IssuedOrganizationInvitation = {
    invitation: OrganizationInvitation;
    /** Raw token, returned ONCE — only the hash is persisted. */
    token: string;
};

/**
 * Issuance and consumption of `OrganizationInvitation` tokens.
 *
 * Security properties, all inherited deliberately from
 * `WorkInvitationService` so the two adjacent features cannot drift:
 *
 *  - Token is `randomBytes(32).toString('hex')` — 256 bits of entropy.
 *  - The token is returned to the issuer **once** and never persisted; only
 *    `sha256(token)` is stored. A lost token is unrecoverable — revoke and
 *    re-issue.
 *  - Lookup is by hash, so the raw token never appears in a query.
 *  - `tryAccept` is a conditional UPDATE, so concurrent redemptions of one
 *    token resolve with exactly one winner.
 *
 * One deliberate divergence, and it is the important one:
 *
 * 🛑 **The org token is EMAIL-BOUND; the Work token is a bearer credential.**
 * `findConsumable` takes the redeeming user's address and refuses a mismatch.
 * Accepting an Org invitation writes `users.tenantId`, which grants access to
 * every Organization in that Tenant — a far larger blast radius than joining
 * one Work. A forwarded email should not be enough. The cost is that an
 * invitee cannot redeem with a different address than the one invited, which
 * is the intended trade.
 */
@Injectable()
export class OrganizationInvitationService {
    constructor(private readonly invitations: OrganizationInvitationRepository) {}

    /**
     * Canonical form of an address, for storage and comparison.
     *
     * Case-folding only — deliberately NOT dot-stripping or plus-tag removal.
     * Those are Gmail conventions, not SMTP ones; applying them would make
     * `a.b@corp.com` and `ab@corp.com` the same person on a domain where they
     * are two different employees.
     */
    static normaliseEmail(email: string): string {
        return email.trim().toLowerCase();
    }

    async issue(input: CreateOrganizationInvitationInput): Promise<IssuedOrganizationInvitation> {
        const email = input.email?.trim();
        if (!email || email.length > MAX_EMAIL_LENGTH || !email.includes('@')) {
            throw new BadRequestException('invalid_email');
        }
        const role = input.role ?? 'member';
        this.assertRole(role);

        const emailNormalized = OrganizationInvitationService.normaliseEmail(email);
        const expiresInDays = this.normaliseExpiry(input.expiresInDays);
        const token = this.generateToken();

        try {
            const invitation = await this.invitations.create({
                organizationId: input.organizationId,
                tenantId: input.tenantId,
                invitedById: input.invitedById,
                email,
                emailNormalized,
                role,
                tokenHash: this.hashToken(token),
                tokenExpiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
                status: OrganizationInvitationStatus.PENDING,
                metadata: input.invitedName ? { invitedName: input.invitedName } : null,
            });
            return { invitation, token };
        } catch (error) {
            // The partial unique index is the authority on "already invited",
            // not a prior SELECT: two clicks a millisecond apart both pass a
            // read-then-write check and mint two live tokens for one mailbox.
            if (isUniqueConstraintError(error)) {
                throw new ConflictException('invitation_already_pending');
            }
            throw error;
        }
    }

    async listForOrganization(organizationId: string): Promise<OrganizationInvitation[]> {
        return this.invitations.listForOrganization(organizationId);
    }

    async listPending(organizationId: string): Promise<OrganizationInvitation[]> {
        return this.invitations.listPendingForOrganization(organizationId);
    }

    /**
     * Revoke a pending invitation.
     *
     * Authorization is the CALLER's job — the controller sits behind
     * `OrganizationOwnershipGuard`. This additionally pins the invitation to
     * the Organization in the URL, so a member of org A cannot revoke org B's
     * invitation by id alone; the 404 keeps that from being a probe.
     */
    async revoke(organizationId: string, invitationId: string): Promise<void> {
        const invitation = await this.invitations.findById(invitationId);
        if (!invitation || invitation.organizationId !== organizationId) {
            throw new NotFoundException('invitation_not_found');
        }
        if (invitation.status !== OrganizationInvitationStatus.PENDING) {
            throw new BadRequestException('invitation_not_pending');
        }
        const ok = await this.invitations.markRevoked(invitationId);
        if (!ok) {
            // Lost a race with a concurrent accept or revoke.
            throw new BadRequestException('invitation_state_changed');
        }
    }

    /**
     * Resolve a raw token to an invitation that may still be redeemed.
     *
     * `redeemerEmail` is optional so the signed-out PREVIEW page can render
     * "You have been invited to Acme" without an account. Every path that
     * actually grants access must pass it — see `assertEmailMatches`.
     */
    async findConsumable(token: string, redeemerEmail?: string): Promise<OrganizationInvitation> {
        if (!token || typeof token !== 'string') {
            throw new BadRequestException('invalid_token');
        }
        const invitation = await this.invitations.findByTokenHash(this.hashToken(token));
        if (!invitation) {
            throw new NotFoundException('invitation_not_found');
        }
        if (invitation.status === OrganizationInvitationStatus.REVOKED) {
            throw new ForbiddenException('invitation_revoked');
        }
        if (invitation.status === OrganizationInvitationStatus.ACCEPTED) {
            throw new BadRequestException('invitation_already_accepted');
        }
        if (invitation.isExpired()) {
            // Best-effort tidy-up; the decision above already stands on
            // isExpired(), never on `status`.
            await this.invitations.expireBefore(new Date()).catch(() => 0);
            throw new BadRequestException('invitation_expired');
        }
        if (redeemerEmail !== undefined) {
            this.assertEmailMatches(invitation, redeemerEmail);
        }
        return invitation;
    }

    /**
     * The email binding. Throws unless the redeemer is who was invited.
     *
     * Compared on the normalised form, and with `timingSafeEqual` on equal
     * lengths — an address is not a secret, but the comparison is free to be
     * constant-time and it keeps the shape identical to `verifyToken`.
     */
    assertEmailMatches(invitation: OrganizationInvitation, redeemerEmail: string): void {
        const actual = OrganizationInvitationService.normaliseEmail(redeemerEmail ?? '');
        const expected = invitation.emailNormalized;
        const a = Buffer.from(actual);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            throw new ForbiddenException('invitation_email_mismatch');
        }
    }

    /** False if somebody else redeemed the same token first. */
    async tryAccept(invitationId: string, acceptedByUserId: string): Promise<boolean> {
        return this.invitations.tryMarkAccepted(invitationId, acceptedByUserId, new Date());
    }

    async sweepExpired(now: Date = new Date()): Promise<number> {
        return this.invitations.expireBefore(now);
    }

    verifyToken(token: string, tokenHash: string): boolean {
        const expected = this.hashToken(token);
        const a = Buffer.from(expected);
        const b = Buffer.from(tokenHash);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    private assertRole(role: OrganizationInvitationRole): void {
        if (!ORGANIZATION_MEMBER_ROLES.includes(role)) {
            throw new BadRequestException('invalid_role');
        }
    }

    private normaliseExpiry(requested: number | undefined): number {
        if (requested === undefined) return DEFAULT_EXPIRY_DAYS;
        if (!Number.isFinite(requested)) {
            throw new BadRequestException('invalid_expiry');
        }
        const days = Math.floor(requested);
        if (days < MIN_EXPIRY_DAYS || days > MAX_EXPIRY_DAYS) {
            throw new BadRequestException('invalid_expiry');
        }
        return days;
    }

    private generateToken(): string {
        return randomBytes(TOKEN_BYTES).toString('hex');
    }

    private hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }
}
