import { BadRequestException, ForbiddenException } from '@nestjs/common';

// Same module-scope stubs as `organization-invitation-flow.service.spec.ts`.
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
 * EW-P2-6 — `setMemberRole`: only the Tenant owner promotes or demotes, only
 * `admin` / `member`, never the owner, only a roster member.
 */
const ORG = { id: 'org-1', tenantId: 'ten-1', slug: 'acme', displayName: 'Acme' };
const OWNER = 'owner-1';
const ADA = 'ada-1';

function build() {
    let role = 'member';
    const members = {
        findByOrgAndUser: jest.fn(async (_org: string, userId: string) =>
            userId === ADA
                ? {
                      id: 'm-1',
                      organizationId: ORG.id,
                      userId: ADA,
                      role,
                      invitedById: OWNER,
                      joinedAt: new Date('2026-10-01'),
                  }
                : null,
        ),
        listForOrganization: jest.fn(async () => [
            {
                id: 'm-1',
                organizationId: ORG.id,
                userId: ADA,
                role,
                invitedById: OWNER,
                joinedAt: new Date('2026-10-01'),
            },
        ]),
        updateRole: jest.fn(async (_org: string, _user: string, next: string) => {
            role = next;
            return true;
        }),
    };
    const users = { findById: jest.fn(async (id: string) => ({ id, username: id, email: null })) };
    const tenants = { findById: jest.fn().mockResolvedValue({ id: 'ten-1', ownerUserId: OWNER }) };
    const membership = { ensureMember: jest.fn().mockResolvedValue(ORG) };
    const service = new OrganizationInvitationFlowService(
        {} as never,
        members as never,
        { findById: jest.fn().mockResolvedValue(ORG) } as never,
        users as never,
        tenants as never,
        {} as never,
        membership as never,
        {} as never,
    );
    return { service, members };
}

describe('OrganizationInvitationFlowService.setMemberRole (EW-P2-6)', () => {
    it('the Tenant owner promotes a member to admin and back', async () => {
        const { service, members } = build();
        const promoted = await service.setMemberRole(ORG.id, ADA, 'admin', OWNER);
        expect(members.updateRole).toHaveBeenCalledWith(ORG.id, ADA, 'admin');
        expect(promoted).toMatchObject({ userId: ADA, role: 'admin' });
        const demoted = await service.setMemberRole(ORG.id, ADA, 'member', OWNER);
        expect(demoted).toMatchObject({ role: 'member' });
    });

    it('refuses anyone but the Tenant owner (403)', async () => {
        const { service, members } = build();
        await expect(service.setMemberRole(ORG.id, ADA, 'admin', ADA)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        expect(members.updateRole).not.toHaveBeenCalled();
    });

    it('refuses the owner role, the owner as target and a non-member (400)', async () => {
        const { service, members } = build();
        await expect(service.setMemberRole(ORG.id, ADA, 'owner', OWNER)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        await expect(service.setMemberRole(ORG.id, OWNER, 'admin', OWNER)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        await expect(
            service.setMemberRole(ORG.id, 'stranger', 'admin', OWNER),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(members.updateRole).not.toHaveBeenCalled();
    });

    it('re-applying the current role writes nothing', async () => {
        const { service, members } = build();
        await service.setMemberRole(ORG.id, ADA, 'member', OWNER);
        expect(members.updateRole).not.toHaveBeenCalled();
    });
});
