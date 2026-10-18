import { ConflictException, ForbiddenException } from '@nestjs/common';

// Same stubs as organization-invitation-flow.service.spec.ts: importing the service must not drag the
// entity/generator graph through Jest.
jest.mock('@ever-works/agent/services', () => ({
    OrganizationInvitationService: class OrganizationInvitationService {
        static normaliseEmail(email: string): string {
            return email.trim().toLowerCase();
        }
    },
}));
jest.mock('@ever-works/agent/database', () => ({
    OrganizationMemberRepository: class OrganizationMemberRepository {},
    OrganizationRepository: class OrganizationRepository {},
    TenantRepository: class TenantRepository {},
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('../../scope/tenant-bootstrap.service', () => ({
    TenantBootstrapService: class TenantBootstrapService {},
}));
jest.mock('../../mail/mail.service', () => ({ MailService: class MailService {} }));
jest.mock('../../config/constants', () => ({
    config: { webAppUrl: () => 'https://app.test' },
}));
jest.mock('../organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));

import { OrganizationInvitationFlowService } from '../organization-invitation-flow.service';

/**
 * `inviteForIntegration()` — `POST /api/integrations/v1/members/invite` (Gauzy "invite to Ever Works",
 * CR-13): the app's own invitation (email-bound token, the normal email, the seat check), idempotent per
 * email: a pending invitation is answered again, a member is answered as one, and a person already in the
 * Tenant joins the roster directly (as `invite()` does), never a second email.
 */
const ORG = { id: 'org-1', tenantId: 'ten-1', slug: 'acme', displayName: 'Acme Inc' };
const FUTURE = new Date(Date.now() + 3 * 86_400_000);

function build(
    opts: {
        existingUser?: { id: string; tenantId: string | null } | null;
        rosterRow?: boolean;
        pending?: Array<{ id: string; emailNormalized: string; tokenExpiresAt: Date }>;
        issueConflict?: boolean;
        mailFails?: boolean;
        seatsFull?: boolean;
        owner?: string;
    } = {},
) {
    const pending = opts.pending ?? [];
    const issued = {
        id: 'inv-new',
        email: 'newcomer@example.com',
        role: 'member',
        status: 'pending',
        tokenExpiresAt: FUTURE,
        createdAt: new Date('2026-10-18T00:00:00.000Z'),
    };
    const invitations = {
        issue: jest.fn(async () => {
            if (opts.issueConflict) {
                pending.push({
                    id: 'inv-race',
                    emailNormalized: 'newcomer@example.com',
                    tokenExpiresAt: FUTURE,
                });
                throw new ConflictException('invitation_already_pending');
            }
            return { invitation: issued, token: 'a'.repeat(64) };
        }),
        listPending: jest.fn(async () =>
            pending.map((row) => ({ ...row, email: row.emailNormalized })),
        ),
        revoke: jest.fn().mockResolvedValue(undefined),
    };
    const members = {
        findByOrgAndUser: jest.fn(async () =>
            opts.rosterRow ? { organizationId: 'org-1', userId: 'u-known', role: 'member' } : null,
        ),
        create: jest.fn(async (row: Record<string, unknown>) => ({ ...row, id: 'm-1' })),
    };
    const organizations = { findById: jest.fn().mockResolvedValue(ORG) };
    const users = {
        findByEmail: jest.fn().mockResolvedValue(opts.existingUser ?? null),
        findById: jest.fn().mockResolvedValue({ id: 'u-actor', username: 'ada' }),
    };
    const tenants = {
        findById: jest
            .fn()
            .mockResolvedValue({ id: 'ten-1', ownerUserId: opts.owner ?? 'u-owner' }),
    };
    const membership = { ensureMember: jest.fn().mockResolvedValue(ORG) };
    const mail = {
        sendOrganizationInvitation: opts.mailFails
            ? jest.fn().mockRejectedValue(new Error('SMTP 421 service unavailable'))
            : jest.fn().mockResolvedValue(undefined),
    };
    const seats = {
        assertSeatAvailable: opts.seatsFull
            ? jest.fn().mockRejectedValue(new ForbiddenException('seat_limit_reached'))
            : jest.fn().mockResolvedValue(undefined),
    };
    const service = new OrganizationInvitationFlowService(
        invitations as never,
        members as never,
        organizations as never,
        users as never,
        tenants as never,
        { joinTenant: jest.fn() } as never,
        membership as never,
        mail as never,
        seats as never,
    );
    return { service, invitations, members, mail, membership, seats };
}

describe('OrganizationInvitationFlowService.inviteForIntegration', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it('issues the normal member invitation and emails it, as the acting user', async () => {
        const { service, invitations, mail, membership } = build();
        const outcome = await service.inviteForIntegration(
            'org-1',
            'u-actor',
            'Newcomer@Example.com',
            {
                invitedName: 'Newcomer',
            },
        );
        expect(membership.ensureMember).toHaveBeenCalledWith('org-1', 'u-actor');
        expect(invitations.issue).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                tenantId: 'ten-1',
                invitedById: 'u-actor',
                email: 'Newcomer@Example.com',
                role: 'member',
                invitedName: 'Newcomer',
            }),
        );
        expect(mail.sendOrganizationInvitation).toHaveBeenCalledTimes(1);
        expect(outcome).toEqual({
            status: 'invited',
            invitation: expect.objectContaining({ id: 'inv-new' }),
            userId: null,
        });
        // The token never leaves through the outcome.
        expect(JSON.stringify(outcome)).not.toContain('a'.repeat(64));
    });

    it('answers an invitation still pending for the email again, whatever its case — no second email', async () => {
        const { service, invitations, mail } = build({
            pending: [
                { id: 'inv-old', emailNormalized: 'newcomer@example.com', tokenExpiresAt: FUTURE },
            ],
        });
        const outcome = await service.inviteForIntegration(
            'org-1',
            'u-actor',
            ' NEWCOMER@example.com',
        );
        expect(outcome.status).toBe('pending');
        expect(outcome.invitation).toEqual(expect.objectContaining({ id: 'inv-old' }));
        expect(invitations.issue).not.toHaveBeenCalled();
        expect(mail.sendOrganizationInvitation).not.toHaveBeenCalled();
    });

    it('issues a new invitation when the pending one has expired', async () => {
        const { service, invitations } = build({
            pending: [
                {
                    id: 'inv-old',
                    emailNormalized: 'newcomer@example.com',
                    tokenExpiresAt: new Date(Date.now() - 1000),
                },
            ],
        });
        const outcome = await service.inviteForIntegration(
            'org-1',
            'u-actor',
            'newcomer@example.com',
        );
        expect(outcome.status).toBe('invited');
        expect(invitations.issue).toHaveBeenCalledTimes(1);
    });

    it('answers a member of the organization as one, writing and sending nothing', async () => {
        const { service, invitations, members, mail } = build({
            existingUser: { id: 'u-known', tenantId: 'ten-1' },
            rosterRow: true,
        });
        const outcome = await service.inviteForIntegration('org-1', 'u-actor', 'known@example.com');
        expect(outcome).toEqual({ status: 'already_member', invitation: null, userId: 'u-known' });
        expect(invitations.issue).not.toHaveBeenCalled();
        expect(members.create).not.toHaveBeenCalled();
        expect(mail.sendOrganizationInvitation).not.toHaveBeenCalled();
    });

    it('answers the Tenant owner (a member of every organization) as a member without a roster write', async () => {
        const { service, members, invitations } = build({
            existingUser: { id: 'u-owner', tenantId: 'ten-1' },
            owner: 'u-owner',
        });
        const outcome = await service.inviteForIntegration('org-1', 'u-actor', 'owner@example.com');
        expect(outcome).toEqual({ status: 'already_member', invitation: null, userId: 'u-owner' });
        expect(members.create).not.toHaveBeenCalled();
        expect(invitations.issue).not.toHaveBeenCalled();
    });

    it('adds a person of the Tenant who is not on this roster directly (no email), like invite()', async () => {
        const { service, members, mail, invitations } = build({
            existingUser: { id: 'u-colleague', tenantId: 'ten-1' },
        });
        const outcome = await service.inviteForIntegration(
            'org-1',
            'u-actor',
            'colleague@example.com',
        );
        expect(outcome).toEqual({ status: 'added', invitation: null, userId: 'u-colleague' });
        expect(members.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: 'org-1',
                userId: 'u-colleague',
                role: 'member',
                invitedById: 'u-actor',
            }),
        );
        expect(invitations.issue).not.toHaveBeenCalled();
        expect(mail.sendOrganizationInvitation).not.toHaveBeenCalled();
    });

    it('answers already_member when a concurrent call added the person to the roster first', async () => {
        const { service, members } = build({
            existingUser: { id: 'u-colleague', tenantId: 'ten-1' },
        });
        // Not on the roster when checked, nor when the write re-checks; there once the insert lost.
        members.findByOrgAndUser
            .mockResolvedValueOnce(null as never)
            .mockResolvedValueOnce(null as never)
            .mockResolvedValueOnce({ organizationId: 'org-1', userId: 'u-colleague' } as never);
        members.create.mockRejectedValueOnce(
            Object.assign(new Error('duplicate key value violates unique constraint'), {
                code: '23505',
            }),
        );
        const outcome = await service.inviteForIntegration(
            'org-1',
            'u-actor',
            'colleague@example.com',
        );
        expect(outcome).toEqual({
            status: 'already_member',
            invitation: null,
            userId: 'u-colleague',
        });
    });

    it('still surfaces a roster write that fails for another reason', async () => {
        const { service, members } = build({
            existingUser: { id: 'u-colleague', tenantId: 'ten-1' },
        });
        members.create.mockRejectedValueOnce(new Error('connection reset'));
        await expect(
            service.inviteForIntegration('org-1', 'u-actor', 'colleague@example.com'),
        ).rejects.toThrow(/connection reset/);
    });

    it('invites a person whose account lives in another Tenant', async () => {
        const { service, invitations } = build({
            existingUser: { id: 'u-far', tenantId: 'ten-9' },
        });
        const outcome = await service.inviteForIntegration('org-1', 'u-actor', 'far@example.com');
        expect(outcome.status).toBe('invited');
        expect(invitations.issue).toHaveBeenCalledTimes(1);
    });

    it('a concurrent invite of the same email answers the invitation that won the race', async () => {
        const { service, mail } = build({ issueConflict: true });
        const outcome = await service.inviteForIntegration(
            'org-1',
            'u-actor',
            'newcomer@example.com',
        );
        expect(outcome.status).toBe('pending');
        expect(outcome.invitation).toEqual(expect.objectContaining({ id: 'inv-race' }));
        expect(mail.sendOrganizationInvitation).not.toHaveBeenCalled();
    });

    it('refuses before anything is written when the Tenant has no seat left', async () => {
        const { service, invitations, members } = build({ seatsFull: true });
        await expect(
            service.inviteForIntegration('org-1', 'u-actor', 'newcomer@example.com'),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(invitations.issue).not.toHaveBeenCalled();
        expect(members.create).not.toHaveBeenCalled();
    });

    it('revokes the invitation and rethrows when its email cannot be sent', async () => {
        const { service, invitations } = build({ mailFails: true });
        await expect(
            service.inviteForIntegration('org-1', 'u-actor', 'newcomer@example.com'),
        ).rejects.toThrow(/SMTP/);
        expect(invitations.revoke).toHaveBeenCalledWith('org-1', 'inv-new');
    });
});
