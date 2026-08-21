import { BadRequestException } from '@nestjs/common';

// Stub the workspace barrels at module scope so importing the service does not
// drag the entity/generator graph through Jest — same posture as
// `ingest.module.spec.ts` and the org-invite controller spec.
jest.mock('@ever-works/agent/services', () => ({
    // `invite()` calls the STATIC normaliseEmail on this class, so the stub
    // needs it. Kept as the real implementation (trim + lowercase) rather than
    // a jest.fn(), because the value feeds the already-in-tenant lookup and a
    // mock returning undefined would change which branch runs.
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
 * `invite()` — what happens when the email does not send.
 *
 * The invitation row is committed BEFORE the mail call, and the raw token
 * exists in exactly one place: that email. So a send failure leaves a row
 * whose token reached nobody and which cannot be recovered — the database
 * holds only sha256. Left pending, the partial unique index on
 * (organizationId, emailNormalized) WHERE status='pending' then BLOCKS
 * re-inviting that address, and there is no resend endpoint, so the obvious
 * remedy is unavailable and the admin is told an invitation is pending for a
 * token that does not exist anywhere.
 */
const ORG = {
    id: 'org-1',
    tenantId: 'ten-1',
    slug: 'acme',
    displayName: 'Acme Inc',
};

function build(opts: { mailFails?: boolean } = {}) {
    const invitations = {
        issue: jest.fn().mockResolvedValue({
            invitation: {
                id: 'inv-1',
                email: 'newcomer@example.com',
                tokenExpiresAt: new Date('2030-01-01'),
            },
            token: 'a'.repeat(64),
        }),
        revoke: jest.fn().mockResolvedValue(undefined),
    };
    const members = { findByOrgAndUser: jest.fn().mockResolvedValue(null), create: jest.fn() };
    const organizations = { findById: jest.fn().mockResolvedValue(ORG) };
    const users = {
        findByEmail: jest.fn().mockResolvedValue(null),
        findById: jest.fn().mockResolvedValue({ id: 'u-1', username: 'ada' }),
    };
    const tenants = { findById: jest.fn().mockResolvedValue({ ownerUserId: 'u-1' }) };
    const tenantBootstrap = { joinTenant: jest.fn() };
    const membership = { ensureMember: jest.fn().mockResolvedValue(ORG) };
    const mail = {
        sendOrganizationInvitation: opts.mailFails
            ? jest.fn().mockRejectedValue(new Error('SMTP 421 service unavailable'))
            : jest.fn().mockResolvedValue(undefined),
    };

    const service = new OrganizationInvitationFlowService(
        invitations as never,
        members as never,
        organizations as never,
        users as never,
        tenants as never,
        tenantBootstrap as never,
        membership as never,
        mail as never,
    );
    return { service, invitations, mail, members };
}

describe('OrganizationInvitationFlowService.invite', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('control: a successful send leaves the invitation alone', () => {
        // If revoke were called on the happy path too, the assertion below
        // would pass for the wrong reason.
        const { service, invitations, mail } = build();
        return service.invite('org-1', 'u-1', 'newcomer@example.com').then(() => {
            expect(mail.sendOrganizationInvitation).toHaveBeenCalledTimes(1);
            expect(invitations.revoke).not.toHaveBeenCalled();
        });
    });

    it('🛑 REVOKES the invitation when its email cannot be sent', async () => {
        const { service, invitations } = build({ mailFails: true });

        await expect(service.invite('org-1', 'u-1', 'newcomer@example.com')).rejects.toThrow(
            /SMTP/,
        );

        // Released immediately, so "try again" — the obvious response — works.
        expect(invitations.revoke).toHaveBeenCalledWith('org-1', 'inv-1');
    });

    it('rethrows, so the caller never claims an invitation was sent', async () => {
        const { service } = build({ mailFails: true });
        await expect(service.invite('org-1', 'u-1', 'newcomer@example.com')).rejects.toThrow();
    });

    it('does not let a failed revoke mask the original error', async () => {
        // The mail failure is what the admin needs to see. A secondary failure
        // while tidying up must not replace it with something less useful.
        const { service, invitations } = build({ mailFails: true });
        invitations.revoke.mockRejectedValue(new Error('db unavailable'));

        await expect(service.invite('org-1', 'u-1', 'newcomer@example.com')).rejects.toThrow(
            /SMTP/,
        );
    });

    it('refuses an Organization with no Tenant before minting anything', async () => {
        const { service, invitations } = build();
        const noTenant = { ...ORG, tenantId: null };
        (service as never as { membership: { ensureMember: jest.Mock } }).membership.ensureMember =
            jest.fn().mockResolvedValue(noTenant);

        await expect(service.invite('org-1', 'u-1', 'x@y.com')).rejects.toThrow(
            BadRequestException,
        );
        expect(invitations.issue).not.toHaveBeenCalled();
    });
});
