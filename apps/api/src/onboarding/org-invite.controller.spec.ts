import { BadRequestException } from '@nestjs/common';

// Stub the heavy workspace barrels at module scope so importing the
// controller does not drag the generator/entity graph through Jest, the
// same posture as ingest.module.spec.ts. The controller only ever touches
// these through the injected mocks below.
jest.mock('@ever-works/agent/services', () => ({
    OrganizationInvitationService: class OrganizationInvitationService {},
}));
jest.mock('@ever-works/agent/database', () => ({
    OrganizationRepository: class OrganizationRepository {},
}));
jest.mock('../organizations/organization-invitation-flow.service', () => ({
    OrganizationInvitationFlowService: class OrganizationInvitationFlowService {},
}));
jest.mock('../organizations/organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));
// The `../auth` barrel reaches auth.module -> auth-runtime.instance, which
// Jest cannot parse. CurrentUser is a PARAMETER decorator, so its mock has
// to be a factory returning a decorator, not a plain value.
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
import { OrgInviteController } from './org-invite.controller';

/**
 * The consumption side of an Organization invitation.
 *
 * Two properties are load-bearing and neither is obvious from the types:
 *
 *  1. The PUBLIC preview must not leak the invited address. Anyone holding a
 *     leaked link can call it, so returning the address in full would turn a
 *     forwarded email into an address disclosure. It is masked instead — still
 *     enough to tell the recipient which account to sign in as, which they
 *     need, because the token is email-bound.
 *  2. The preview must not consume anything. It is a read; the accept route is
 *     the only thing that writes.
 */
describe('OrgInviteController', () => {
    const makeInvitation = (overrides: Record<string, unknown> = {}) => ({
        id: 'inv-1',
        organizationId: 'org-1',
        tenantId: 'ten-1',
        email: 'newcomer@example.com',
        emailNormalized: 'newcomer@example.com',
        tokenExpiresAt: new Date('2030-01-01T00:00:00.000Z'),
        ...overrides,
    });

    function build(opts: { invitation?: unknown; organization?: unknown } = {}) {
        const invitations = {
            findConsumable: jest.fn().mockResolvedValue(opts.invitation ?? makeInvitation()),
            tryAccept: jest.fn(),
        };
        const organizations = {
            findById: jest
                .fn()
                .mockResolvedValue(
                    opts.organization === undefined
                        ? { id: 'org-1', slug: 'acme', displayName: 'Acme Inc' }
                        : opts.organization,
                ),
        };
        const flow = { accept: jest.fn().mockResolvedValue({}) };
        const controller = new OrgInviteController(
            invitations as never,
            organizations as never,
            flow as never,
        );
        return { controller, invitations, organizations, flow };
    }

    describe('preview (public)', () => {
        it('MASKS the invited address', async () => {
            const { controller } = build();
            const res = await controller.preview({ token: 't'.repeat(64) });

            expect(res.invitedEmailMasked).toBe('n***@example.com');
            // The whole address must not appear anywhere in the payload.
            expect(JSON.stringify(res)).not.toContain('newcomer@example.com');
        });

        it('masks a one-character local part without revealing it', async () => {
            const { controller } = build({
                invitation: makeInvitation({ email: 'a@example.com' }),
            });
            const res = await controller.preview({ token: 't'.repeat(64) });
            expect(res.invitedEmailMasked).toBe('*@example.com');
        });

        it('does not consume the invitation', async () => {
            const { controller, invitations } = build();
            await controller.preview({ token: 't'.repeat(64) });
            expect(invitations.tryAccept).not.toHaveBeenCalled();
        });

        it('resolves WITHOUT a redeemer address — there is no signed-in user yet', async () => {
            // This is what lets a brand-new person see "you've been invited to
            // Acme" before they have an account. Passing an address here would
            // make the preview 403 for exactly the people it exists to serve.
            const { controller, invitations } = build();
            await controller.preview({ token: 't'.repeat(64) });

            expect(invitations.findConsumable).toHaveBeenCalledTimes(1);
            expect(invitations.findConsumable.mock.calls[0][1]).toBeUndefined();
        });

        it('returns the organization display name, falling back to the slug', async () => {
            const named = build();
            expect((await named.controller.preview({ token: 't' })).organizationName).toBe(
                'Acme Inc',
            );

            const unnamed = build({
                organization: { id: 'org-1', slug: 'acme', displayName: null },
            });
            expect((await unnamed.controller.preview({ token: 't' })).organizationName).toBe(
                'acme',
            );
        });

        it('400s when the Organization has been deleted since the invite', async () => {
            const { controller } = build({ organization: null });
            await expect(controller.preview({ token: 't' })).rejects.toThrow(BadRequestException);
        });

        it('passes an empty string rather than undefined for a missing token', async () => {
            // `findConsumable` rejects a falsy token with 400 invalid_token; the
            // coercion keeps that path deterministic instead of relying on
            // whatever the query parser produced.
            const { controller, invitations } = build();
            await controller.preview({ token: undefined } as never);
            expect(invitations.findConsumable).toHaveBeenCalledWith('');
        });
    });

    describe('accept (authenticated)', () => {
        it('delegates to the flow service with the caller identity', async () => {
            // The controller must NOT re-derive the user or re-check the token:
            // the ordering guarantees (email bind -> joinTenant -> conditional
            // UPDATE -> roster) all live in the flow service, and a second
            // implementation here would be the one that drifts.
            const { controller, flow } = build();
            const token = 'a'.repeat(64);

            await controller.accept({ token }, { userId: 'u-9' } as never);

            expect(flow.accept).toHaveBeenCalledTimes(1);
            expect(flow.accept).toHaveBeenCalledWith(token, 'u-9');
        });
    });
});
