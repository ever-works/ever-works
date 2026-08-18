import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
    OrganizationInvitationService,
    type IssuedOrganizationInvitation,
} from '@ever-works/agent/services';
import {
    OrganizationMemberRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import type { OrganizationInvitation, OrganizationMember } from '@ever-works/agent/entities';
import { TenantBootstrapService } from '../scope/tenant-bootstrap.service';
import { MailService } from '../mail/mail.service';
import { config } from '../config/constants';
import { OrganizationMembershipService } from './organization-membership.service';

export type AcceptOutcome = {
    organizationId: string;
    organizationSlug: string;
    /** False when this invitation had already been redeemed by this same user. */
    joined: boolean;
};

/**
 * The write side of Organization membership: issue an invitation, redeem one,
 * and remove a member.
 *
 * Sits in `apps/api` rather than `packages/agent` because it composes three
 * things that only the API layer owns together — the agent-side token service,
 * the roster repository, and `TenantBootstrapService`, which is the audited
 * writer of `users.tenantId`.
 *
 * 🛑 The ordering inside `accept` is deliberate and is the whole correctness
 * argument. See the comments there before changing it.
 */
@Injectable()
export class OrganizationInvitationFlowService {
    private readonly logger = new Logger(OrganizationInvitationFlowService.name);

    constructor(
        private readonly invitations: OrganizationInvitationService,
        private readonly members: OrganizationMemberRepository,
        private readonly organizations: OrganizationRepository,
        private readonly users: UserRepository,
        private readonly tenants: TenantRepository,
        private readonly tenantBootstrap: TenantBootstrapService,
        private readonly membership: OrganizationMembershipService,
        private readonly mail: MailService,
    ) {}

    /**
     * Issue an invitation on behalf of an existing member.
     *
     * `ensureMember` runs again here even though the controller sits behind
     * `OrganizationOwnershipGuard`: this is also the call that resolves the
     * Organization's `tenantId`, and taking it from the guard's own lookup
     * rather than a second unvalidated read is what stops a caller from
     * inviting someone into a Tenant they cannot see.
     */
    async invite(
        orgId: string,
        actorUserId: string,
        email: string,
        invitedName?: string,
    ): Promise<IssuedOrganizationInvitation> {
        const organization = await this.membership.ensureMember(orgId, actorUserId);
        if (!organization.tenantId) {
            // An Organization with no Tenant cannot grant access to anything,
            // so there is nothing coherent to invite someone into.
            throw new BadRequestException('organization_has_no_tenant');
        }

        const normalized = OrganizationInvitationService.normaliseEmail(email);

        // Someone already inside this Tenant does not need an invitation, and
        // issuing one would produce a token that can only ever fail at accept
        // (joinTenant returns 'already_member' and the roster row may exist).
        // Better to say so now than to send an email that leads nowhere.
        const existing = await this.users.findByEmail(normalized).catch(() => null);
        if (existing?.tenantId && existing.tenantId === organization.tenantId) {
            const alreadyOnRoster = await this.members.findByOrgAndUser(orgId, existing.id);
            if (alreadyOnRoster) {
                throw new BadRequestException('user_already_a_member');
            }
            // In the Tenant but not on this Org's roster: adopt them directly
            // rather than mailing a token they do not need.
            await this.recordMembership(organization.id, organization.tenantId, existing.id, {
                invitedById: actorUserId,
            });
            throw new BadRequestException('user_added_directly');
        }

        const issued = await this.invitations.issue({
            organizationId: organization.id,
            tenantId: organization.tenantId,
            invitedById: actorUserId,
            email,
            invitedName,
        });

        // 🛑 The raw token leaves this method exactly once, into the email
        // body. It is not returned to the caller by the controller, not
        // logged, and not stored — the row holds only sha256(token).
        const inviter = await this.users.findById(actorUserId);
        await this.mail.sendOrganizationInvitation({
            recipientEmail: issued.invitation.email,
            organizationName: organization.displayName ?? organization.slug,
            inviterName: inviter?.username ?? 'A teammate',
            acceptUrl: `${config.webAppUrl()}/org-invite/${issued.token}`,
            expiresAt: issued.invitation.tokenExpiresAt,
        });

        return issued;
    }

    /**
     * Redeem a token as the signed-in `userId`.
     *
     * Order of operations, and why:
     *
     *  1. `findConsumable` with the redeemer's address — validates the token
     *     AND enforces the email binding before anything is written.
     *  2. `joinTenant` — may THROW for a user who already belongs elsewhere.
     *     It runs before the invitation is marked accepted so that a refusal
     *     leaves the invitation still redeemable; burning a token on a
     *     failure would strand the invitee with no way back.
     *  3. `tryAccept` — the conditional UPDATE that resolves concurrent
     *     redemptions. If it returns false somebody else won the race.
     *  4. The roster row last, because it is the only step that is safe to
     *     retry and the only one that is purely a record.
     */
    async accept(token: string, userId: string): Promise<AcceptOutcome> {
        const user = await this.users.findById(userId);
        if (!user) {
            throw new ForbiddenException('unknown_user');
        }
        if (!user.email) {
            // The token is email-bound, so an account with no address can
            // never satisfy it. Say that plainly instead of a bare mismatch.
            throw new ForbiddenException('account_has_no_email');
        }

        const invitation = await this.invitations.findConsumable(token, user.email);
        const organization = await this.organizations.findById(invitation.organizationId);
        if (!organization) {
            throw new BadRequestException('organization_not_found');
        }

        // May throw ConflictException('user_already_in_another_tenant').
        // Deliberately BEFORE tryAccept — see the docblock.
        const outcome = await this.tenantBootstrap.joinTenant(
            userId,
            invitation.tenantId,
            invitation.organizationId,
        );

        const claimed = await this.invitations.tryAccept(invitation.id, userId);
        if (!claimed) {
            // Someone redeemed this token between our read and our write.
            // If that someone was this same user (a double-clicked accept),
            // the tenant join above was idempotent and they are already in —
            // so report success rather than a confusing error.
            const fresh = await this.invitations
                .findConsumable(token, user.email)
                .catch(() => null);
            if (fresh === null && outcome === 'already_member') {
                return {
                    organizationId: organization.id,
                    organizationSlug: organization.slug,
                    joined: false,
                };
            }
            throw new BadRequestException('invitation_state_changed');
        }

        await this.recordMembership(organization.id, invitation.tenantId, userId, {
            invitedById: invitation.invitedById,
            invitationId: invitation.id,
        });

        this.logger.log(
            `User ${userId} accepted invitation ${invitation.id} into org ${organization.id}`,
        );

        return {
            organizationId: organization.id,
            organizationSlug: organization.slug,
            joined: outcome === 'joined',
        };
    }

    async listMembers(orgId: string, actorUserId: string): Promise<OrganizationMember[]> {
        await this.membership.ensureMember(orgId, actorUserId);
        return this.members.listForOrganization(orgId);
    }

    async listInvitations(orgId: string, actorUserId: string): Promise<OrganizationInvitation[]> {
        await this.membership.ensureMember(orgId, actorUserId);
        return this.invitations.listForOrganization(orgId);
    }

    async revokeInvitation(
        orgId: string,
        invitationId: string,
        actorUserId: string,
    ): Promise<void> {
        await this.membership.ensureMember(orgId, actorUserId);
        await this.invitations.revoke(orgId, invitationId);
    }

    /**
     * Remove someone from an Organization.
     *
     * 🛑 Because access is TENANT-wide, this is the only place that can give a
     * departing member their independence back. Their `users.tenantId` is
     * cleared — but ONLY once they hold no other membership in that Tenant,
     * otherwise removing them from one Organization would silently revoke
     * their access to a sibling Organization they are still a member of.
     *
     * Clearing it back to NULL (rather than repointing) is what makes this
     * reversible: `TenantBootstrapService.ensureTenant` will lazily create
     * them their own Tenant the next time they create an Organization. Without
     * this, accepting an invitation would be a one-way door — `joinTenant`
     * refuses to move an already-homed user, so they could never own anything
     * again.
     *
     * Nothing is deleted beyond the roster row. Work they did inside the
     * Organization stays stamped with that Tenant and stays with the
     * Organization, which is the intended reading of "they were a member".
     */
    async removeMember(orgId: string, targetUserId: string, actorUserId: string): Promise<void> {
        const organization = await this.membership.ensureMember(orgId, actorUserId);

        const owner = await this.isTenantOwner(targetUserId, organization.tenantId);
        if (owner) {
            // The Tenant owner is a member by construction; removing them
            // would orphan every Organization in the Tenant.
            throw new BadRequestException('cannot_remove_tenant_owner');
        }

        const removed = await this.members.deleteByOrgAndUser(orgId, targetUserId);
        if (!removed) {
            throw new BadRequestException('not_a_member');
        }

        if (!organization.tenantId) return;
        const remaining = await this.members.listForUserInTenant(
            targetUserId,
            organization.tenantId,
        );
        if (remaining.length === 0) {
            await this.users.update(targetUserId, { tenantId: null });
            this.logger.log(
                `User ${targetUserId} left tenant ${organization.tenantId} — no memberships remain`,
            );
        }
    }

    /**
     * `tenants.ownerUserId` is UNIQUE, so a single read settles ownership.
     * The owner is a member of every Organization in their Tenant by
     * construction — there is no roster row to delete and removing them
     * would orphan the whole Tenant.
     */
    private async isTenantOwner(userId: string, tenantId: string | null): Promise<boolean> {
        if (!tenantId) return false;
        const tenant = await this.tenants.findById(tenantId);
        return tenant?.ownerUserId === userId;
    }

    private async recordMembership(
        organizationId: string,
        tenantId: string,
        userId: string,
        extra: { invitedById?: string | null; invitationId?: string | null },
    ): Promise<void> {
        const existing = await this.members.findByOrgAndUser(organizationId, userId);
        if (existing) return;
        await this.members.create({
            organizationId,
            tenantId,
            userId,
            role: 'member',
            invitedById: extra.invitedById ?? null,
            invitationId: extra.invitationId ?? null,
            joinedAt: new Date(),
        });
    }
}
