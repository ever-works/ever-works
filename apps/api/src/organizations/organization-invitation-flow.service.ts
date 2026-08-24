import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    Optional,
} from '@nestjs/common';
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
// Token + interface only. Importing `SeatsService` itself would pull the whole
// `@ever-works/agent/subscriptions` barrel — and through it NotificationsModule
// → AuthModule — into this module's load graph, which crashes the invitation
// specs at import time (TDZ on `AuthProvider`). `seat-guard` is a zero-import
// leaf declaring exactly the two methods this path needs.
import { SEAT_GUARD, type SeatGuard } from '@ever-works/agent/agents';
import { TenantBootstrapService } from '../scope/tenant-bootstrap.service';
import { MailService } from '../mail/mail.service';
import { config } from '../config/constants';
import { OrganizationMembershipService } from './organization-membership.service';

/**
 * A roster row as the members UI needs it.
 *
 * `username`/`email` are nullable because the roster row outlives nothing but
 * could still be read while the User row is mid-delete; the UI falls back
 * rather than rendering a UUID.
 */
export type OrganizationMemberView = {
    id: string;
    userId: string;
    username: string | null;
    email: string | null;
    role: string;
    invitedById: string | null;
    joinedAt: Date;
    /** Server-computed, so the client cannot forget to ask. */
    isSelf: boolean;
    /**
     * The Tenant owner. Never removable — removing them would orphan every
     * Organization in the Tenant — and possibly SYNTHESIZED, because an org
     * created before organization_members existed has no roster row for them.
     */
    isOwner: boolean;
};

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
        /**
         * Seats (billing spec §3.6 / FR-28). `@Optional()` so the hand-rolled
         * unit tests (which never wire billing) keep constructing this
         * service, and so an install without the billing stack still invites
         * people. `SeatsService` is itself a no-op when subscriptions are off.
         */
        @Optional()
        @Inject(SEAT_GUARD)
        private readonly seats?: SeatGuard,
    ) {}

    /**
     * Refuse a seat-consuming admission BEFORE anything is written (billing
     * spec FR-28), charged to the Tenant owner rather than the inviter.
     *
     * Checked at INVITE time as well as at accept: telling somebody "no seats
     * left" while they are inviting is far better than mailing a token that
     * dies on redemption, and the accept-side check is what stops a pre-issued
     * invitation from smuggling a seat in later.
     */
    private async assertSeatForTenant(tenantId: string): Promise<void> {
        if (!this.seats) return;
        const tenant = await this.tenants.findById(tenantId).catch(() => null);
        const owner = tenant?.ownerUserId;
        if (!owner) return;
        await this.seats.assertSeatAvailable(owner);
    }

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

        await this.assertSeatForTenant(organization.tenantId);

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
        try {
            await this.mail.sendOrganizationInvitation({
                recipientEmail: issued.invitation.email,
                organizationName: organization.displayName ?? organization.slug,
                inviterName: inviter?.username ?? 'A teammate',
                acceptUrl: `${config.webAppUrl()}/org-invite/${issued.token}`,
                expiresAt: issued.invitation.tokenExpiresAt,
            });
        } catch (error) {
            // 🛑 The row is committed but the token only ever existed in the
            // email that failed to send — so NOBODY holds it, and it cannot be
            // recovered (the database has only sha256). Left pending, that row
            // is worse than useless: the partial unique index makes it BLOCK
            // re-inviting the same address, and there is no resend, so the
            // admin is told an invitation is pending for a token that reached
            // no one.
            //
            // Revoking it releases the address immediately, so the obvious
            // response — try again — actually works. The failure is rethrown
            // so the caller reports it rather than claiming an invite was sent.
            await this.invitations
                .revoke(organization.id, issued.invitation.id)
                .catch(() => undefined);
            this.logger.error(
                `Invitation ${issued.invitation.id} was revoked because its email could not be ` +
                    `sent — the token reached nobody and would otherwise have blocked re-inviting ` +
                    `that address`,
                error instanceof Error ? error.stack : String(error),
            );
            throw error;
        }

        return issued;
    }

    /**
     * Redeem a token as the signed-in `userId`.
     *
     * Order of operations, and why:
     *
     *  1. `findConsumable` with the redeemer's address — validates the token
     *     AND enforces the email binding before anything is written.
     *  2. `tryAccept` — the conditional UPDATE, and the ONLY atomic gate.
     *     Nothing is granted unless it wins.
     *  3. `joinTenant` — the access grant, only after the claim succeeded.
     *  4. The roster row last: it is purely a record and safe to retry.
     *
     * 🛑 Steps 2 and 3 were originally swapped, and that was a real defect,
     * not a stylistic choice. `joinTenant` commits `users.tenantId`, so with
     * the grant first a concurrent REVOKE landing in the window left the
     * invitee with tenant-wide access, no roster row, no entry in the
     * members list, and no way for an admin to remove them. Whatever gate
     * authorizes access has to be the atomic one.
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

        // Seats (billing spec FR-28): an invitation issued while a seat was
        // free must not smuggle one in after the allowance filled up. Checked
        // BEFORE the claim so a refusal leaves the token redeemable once the
        // owner buys a seat, rather than burning it.
        await this.assertSeatForTenant(invitation.tenantId);

        // 🛑 The CLAIM comes first, and it is what authorizes the grant.
        //
        // This ordering was originally the other way round, on the theory
        // that refusing a cross-tenant user before burning the token left
        // the invitation redeemable. That reasoning only covered the
        // REFUSAL case and missed the inverse: joinTenant commits
        // `users.tenantId`, so if the claim then lost a race with a
        // concurrent revoke, the invitee kept tenant-wide access with NO
        // roster row — invisible in the members list (which reads the
        // roster) and not removable through removeMember (which needs one).
        // A revoked invitation therefore still granted access.
        //
        // Claiming first inverts that: the conditional UPDATE is the single
        // atomic gate, and nothing is granted unless it wins.
        const claimed = await this.invitations.tryAccept(invitation.id, userId);
        if (!claimed) {
            // Somebody consumed this token between our read and our write.
            // If it was this same user (a double-clicked accept) the row now
            // records THEM, so report success instead of a confusing error.
            // Checking `acceptedByUserId` is what makes that precise — the
            // previous code inferred it from a failed re-read, which also
            // matched a REVOKED invitation and reported success for it.
            const current = await this.invitations.findById(invitation.id);
            if (current?.acceptedByUserId === userId) {
                // Their earlier accept already granted the tenant and wrote
                // the roster row; make sure both are present, then succeed.
                await this.tenantBootstrap.joinTenant(
                    userId,
                    invitation.tenantId,
                    invitation.organizationId,
                );
                await this.recordMembership(organization.id, invitation.tenantId, userId, {
                    invitedById: invitation.invitedById,
                    invitationId: invitation.id,
                });
                return {
                    organizationId: organization.id,
                    organizationSlug: organization.slug,
                    joined: false,
                };
            }
            throw new BadRequestException('invitation_state_changed');
        }

        // 🛑 The ROSTER ROW comes before the grant, and that ordering is the
        // whole point.
        //
        // These are three separate commits with no enclosing transaction
        // (joinTenant writes through a different repository), so SOME partial
        // state is unavoidable. The choice is which partial state to prefer,
        // and the deciding property is VISIBILITY:
        //
        //   roster-then-grant (this order): if the grant fails, a roster row
        //     exists with no access. The person shows up in the members list,
        //     an admin can see and remove them, and re-accepting repairs it.
        //     Harmless and self-announcing.
        //
        //   grant-then-roster (the obvious order): if the roster write fails,
        //     the person has TENANT-WIDE ACCESS with no roster row — invisible
        //     in the members list, and removeMember refuses with `not_a_member`
        //     because it has no row to delete. That is exactly the unrevocable
        //     state this method was already fixed once to avoid; reintroducing
        //     it through a different door would be worse for having been
        //     thought about.
        //
        // recordMembership is idempotent (it no-ops when a row exists), so
        // writing it first costs nothing on the happy path.
        await this.recordMembership(organization.id, invitation.tenantId, userId, {
            invitedById: invitation.invitedById,
            invitationId: invitation.id,
        });

        // joinTenant may still throw ConflictException for a user who already
        // belongs to another Tenant. The invitation stays marked accepted —
        // deliberately, since leaving a live token for someone who provably
        // cannot use it helps nobody, and re-inviting a DIFFERENT address is
        // the actual remedy.
        let outcome: Awaited<ReturnType<TenantBootstrapService['joinTenant']>>;
        try {
            outcome = await this.tenantBootstrap.joinTenant(
                userId,
                invitation.tenantId,
                invitation.organizationId,
            );
        } catch (error) {
            this.logger.warn(
                `Invitation ${invitation.id} was claimed by ${userId} but the tenant join failed — ` +
                    `a roster row exists WITHOUT access, so they are visible and removable`,
            );
            throw error;
        }

        this.logger.log(
            `User ${userId} accepted invitation ${invitation.id} into org ${organization.id}`,
        );

        return {
            organizationId: organization.id,
            organizationSlug: organization.slug,
            joined: outcome === 'joined',
        };
    }

    /**
     * The roster, with each member resolved to a person.
     *
     * Returns display identity rather than bare `userId`s. A members list that
     * renders raw UUIDs is unusable for its one purpose — deciding who to
     * remove — and it makes "is this row me?" impossible to answer, which is
     * how a UI ends up offering somebody a button that evicts themselves.
     *
     * `isSelf` is computed here rather than left to the client: the caller's
     * identity is already known at this layer, and a client that has to be
     * told its own id separately is a client that will one day forget to.
     */
    async listMembers(orgId: string, actorUserId: string): Promise<OrganizationMemberView[]> {
        const organization = await this.membership.ensureMember(orgId, actorUserId);
        const rows = await this.members.listForOrganization(orgId);

        // 🛑 The Tenant owner is a member by construction and has NO roster row:
        // nothing ever wrote one, because organization_members did not exist
        // when their Organization was created. Without this, the members list
        // is EMPTY for every Organization that predates this feature — which,
        // on the day it ships, is all of them — and the owner sees a panel
        // implying they are not in their own org.
        //
        // Synthesized rather than backfilled: this is a read path, and a lazy
        // write here would be a surprising side effect of opening a settings
        // page. The synthetic row carries the real user, is flagged `isOwner`,
        // and is never removable — which is also the correct behaviour, since
        // removing the owner would orphan every Organization in the Tenant.
        const ownerId = organization.tenantId
            ? ((await this.tenants.findById(organization.tenantId))?.ownerUserId ?? null)
            : null;
        const ownerHasRow = ownerId ? rows.some((r) => r.userId === ownerId) : true;

        if (rows.length === 0 && ownerHasRow) return [];

        const userIds = [...rows.map((r) => r.userId), ...(ownerHasRow ? [] : [ownerId!])];
        const users = await Promise.all(
            userIds.map((id) => this.users.findById(id).catch(() => null)),
        );
        const byId = new Map(users.filter(Boolean).map((u) => [u!.id, u!]));

        const synthetic: OrganizationMemberView[] = ownerHasRow
            ? []
            : [
                  {
                      id: `owner:${ownerId}`,
                      userId: ownerId!,
                      username: byId.get(ownerId!)?.username ?? null,
                      email: byId.get(ownerId!)?.email ?? null,
                      role: 'owner',
                      invitedById: null,
                      joinedAt: organization.createdAt ?? new Date(),
                      isSelf: ownerId === actorUserId,
                      isOwner: true,
                  },
              ];

        const real: OrganizationMemberView[] = rows.map((r) => {
            const user = byId.get(r.userId);
            return {
                id: r.id,
                userId: r.userId,
                // `username` is non-null on User and is what
                // `resolveMemberViews` uses for team rosters — the same person
                // reads the same way in both places.
                username: user?.username ?? null,
                email: user?.email ?? null,
                role: r.role,
                invitedById: r.invitedById,
                joinedAt: r.joinedAt,
                isSelf: r.userId === actorUserId,
                isOwner: ownerId !== null && r.userId === ownerId,
            };
        });

        // Owner first — they are the fixed point of the list.
        return [...synthetic, ...real];
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
