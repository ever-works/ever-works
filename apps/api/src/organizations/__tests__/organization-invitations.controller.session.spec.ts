// The auth barrel pulls `better-auth` (ESM) and the guard / flow service pull the database layer;
// the controller is constructed directly with a double, so only the tokens are stubbed.
jest.mock('../../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
jest.mock('../guards/organization-ownership.guard', () => ({
    OrganizationOwnershipGuard: class OrganizationOwnershipGuard {},
}));
jest.mock('../organization-invitation-flow.service', () => ({
    OrganizationInvitationFlowService: class OrganizationInvitationFlowService {},
}));

import { ForbiddenException } from '@nestjs/common';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';
import {
    OrganizationInvitationsController,
    organizationMemberChangesSessionOnly,
} from '../organization-invitations.controller';

/**
 * Works-security (2026-10-18) — inviting, removing a member and changing a member's role are taken
 * only from a signed-in session (`ORGANIZATION_MEMBER_CHANGES_SESSION_ONLY`, default on): an admin
 * can mint Organization-pinned integration keys, so "promote, then mint" must not be open to a
 * personal API key, a fleet run or an integration key. Listing and revoking are unchanged.
 */
describe('OrganizationInvitationsController — member changes need a signed-in session', () => {
    const ORG = '00000000-0000-4000-8000-0000000000aa';
    const TARGET = '00000000-0000-4000-8000-0000000000bb';
    const OWNER = 'owner-1';

    const session = { userId: OWNER, authMethod: 'session' } as never;
    const personalKey = { userId: OWNER, authMethod: 'api-key' } as never;
    const fleetRun = { userId: OWNER, authMethod: 'api-key' } as never; // a run token's stamp
    const noStamp = { userId: OWNER } as never;
    const integration = {
        userId: OWNER,
        authMethod: 'integration',
        integration: { keyId: 'k-1', scopes: ['org:write'] },
    } as never;

    const previous = process.env.ORGANIZATION_MEMBER_CHANGES_SESSION_ONLY;
    afterEach(() => {
        if (previous === undefined) delete process.env.ORGANIZATION_MEMBER_CHANGES_SESSION_ONLY;
        else process.env.ORGANIZATION_MEMBER_CHANGES_SESSION_ONLY = previous;
    });

    function build() {
        const invitation = {
            id: 'inv-1',
            email: 'a@example.com',
            role: 'member',
            status: 'pending',
            invitedById: OWNER,
            tokenExpiresAt: new Date(),
            acceptedAt: null,
            createdAt: new Date(),
        };
        const flow = {
            setMemberRole: jest.fn(async () => ({ userId: TARGET, role: 'admin' })),
            removeMember: jest.fn(async () => undefined),
            invite: jest.fn(async () => ({ invitation, token: 'never-returned' })),
            revokeInvitation: jest.fn(async () => undefined),
            listMembers: jest.fn(async () => []),
            listInvitations: jest.fn(async () => []),
        };
        return { controller: new OrganizationInvitationsController(flow as never), flow };
    }

    const calls = {
        role: (c: OrganizationInvitationsController, auth: never) =>
            c.updateMemberRole(ORG, TARGET, { role: 'admin' } as never, auth),
        remove: (c: OrganizationInvitationsController, auth: never) =>
            c.removeMember(ORG, TARGET, auth),
        invite: (c: OrganizationInvitationsController, auth: never) =>
            c.invite(ORG, auth, { email: 'a@example.com' } as never),
    };
    const flowMethod = { role: 'setMemberRole', remove: 'removeMember', invite: 'invite' } as const;

    describe.each(Object.keys(calls) as Array<keyof typeof calls>)('%s', (name) => {
        it('is refused for a personal API key, a fleet run and a missing stamp (403)', async () => {
            for (const auth of [personalKey, fleetRun, noStamp]) {
                const { controller, flow } = build();
                await expect(calls[name](controller, auth)).rejects.toBeInstanceOf(
                    ForbiddenException,
                );
                expect(flow[flowMethod[name]]).not.toHaveBeenCalled();
            }
        });

        it('is refused for an integration key (422 domain_rule)', async () => {
            const { controller, flow } = build();
            await expect(calls[name](controller, integration)).rejects.toBeInstanceOf(
                IntegrationHttpException,
            );
            expect(flow[flowMethod[name]]).not.toHaveBeenCalled();
        });

        it('reaches the service (which still checks the Tenant owner) from a session', async () => {
            const { controller, flow } = build();
            await calls[name](controller, session);
            expect(flow[flowMethod[name]]).toHaveBeenCalledTimes(1);
        });

        it('ORGANIZATION_MEMBER_CHANGES_SESSION_ONLY=false restores personal-key calls', async () => {
            process.env.ORGANIZATION_MEMBER_CHANGES_SESSION_ONLY = 'false';
            const { controller, flow } = build();
            await calls[name](controller, personalKey);
            expect(flow[flowMethod[name]]).toHaveBeenCalledTimes(1);
        });
    });

    it('listing and revoking are unchanged for a personal key', async () => {
        const { controller, flow } = build();
        await controller.listMembers(ORG, personalKey);
        await controller.listInvitations(ORG, personalKey);
        await controller.revoke(ORG, 'inv-1', personalKey);
        expect(flow.revokeInvitation).toHaveBeenCalledTimes(1);
    });

    it('the switch is on unless exactly false', () => {
        expect(organizationMemberChangesSessionOnly({})).toBe(true);
        expect(
            organizationMemberChangesSessionOnly({ ORGANIZATION_MEMBER_CHANGES_SESSION_ONLY: 'no' }),
        ).toBe(true);
        expect(
            organizationMemberChangesSessionOnly({
                ORGANIZATION_MEMBER_CHANGES_SESSION_ONLY: 'FALSE',
            }),
        ).toBe(false);
    });
});
