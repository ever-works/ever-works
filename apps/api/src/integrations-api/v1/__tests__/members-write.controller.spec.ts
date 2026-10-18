jest.mock('../../../organizations/organization-invitation-flow.service', () => ({
    OrganizationInvitationFlowService: class OrganizationInvitationFlowService {},
}));

import { IntegrationMembersWriteController } from '../members-write.controller';

/**
 * `POST /api/integrations/v1/members/invite` (CR-13, scope `members:write`): the app's own member
 * invitation of the pinned organization, sent as the act-as user (else the key's owner), idempotent per
 * email; the token never comes back. Over doubles.
 */
describe('IntegrationMembersWriteController', () => {
    const principal = (actAsUserId: string | null = null) => ({
        keyId: 'key-1',
        keyName: 'Gauzy',
        integrationKind: 'ever-gauzy',
        tenantId: 'tenant-1',
        allowedOrganizationIds: ['org-a'],
        scopes: ['members:write'],
        ownerUserId: 'owner-1',
        actAsUserId,
    });
    const user = (actAsUserId: string | null = null) =>
        ({
            userId: 'owner-1',
            authMethod: 'integration',
            integration: principal(actAsUserId),
        }) as never;
    const req = () => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/members/invite',
        body: {},
        headers: { 'idempotency-key': 'idem-1' },
    });
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });
    const invitation = {
        id: 'inv-1',
        email: 'newcomer@example.com',
        role: 'member',
        status: 'pending',
        tokenExpiresAt: new Date('2026-10-25T00:00:00.000Z'),
        createdAt: new Date('2026-10-18T00:00:00.000Z'),
        tokenHash: 'f'.repeat(64),
        invitedById: 'owner-1',
    };

    const setup = (outcome: Record<string, unknown>, organizationId: string | null = 'org-a') => {
        const flow = { inviteForIntegration: jest.fn().mockResolvedValue(outcome) };
        const scope = { getScope: () => ({ organizationId }) };
        const idempotency = {
            run: jest.fn(
                async (
                    _input: unknown,
                    work: () => Promise<{ status: number; body: unknown }>,
                ) => ({
                    ...(await work()),
                    replayed: false,
                }),
            ),
        };
        const controller = new IntegrationMembersWriteController(
            flow as never,
            scope as never,
            idempotency as never,
        );
        return { controller, flow, idempotency };
    };

    it('invites into the pinned organization as the key owner and answers 201 with the invitation', async () => {
        const { controller, flow, idempotency } = setup({
            status: 'invited',
            invitation,
            userId: null,
        });
        const response = res();
        const body = await controller.invite(
            user(),
            { email: 'newcomer@example.com', invitedName: 'Newcomer' },
            req(),
            response,
        );
        expect(flow.inviteForIntegration).toHaveBeenCalledWith(
            'org-a',
            'owner-1',
            'newcomer@example.com',
            {
                role: 'member',
                invitedName: 'Newcomer',
            },
        );
        expect(idempotency.run).toHaveBeenCalledTimes(1);
        expect(response.status).toHaveBeenCalledWith(201);
        expect(body).toEqual({
            status: 'invited',
            invitation: {
                id: 'inv-1',
                email: 'newcomer@example.com',
                role: 'member',
                status: 'pending',
                expiresAt: '2026-10-25T00:00:00.000Z',
                createdAt: '2026-10-18T00:00:00.000Z',
            },
            userId: null,
        });
        // Neither the token nor its hash leaves the API.
        expect(JSON.stringify(body)).not.toContain('f'.repeat(64));
    });

    it('sends the invitation as the act-as user when the request names one', async () => {
        const { controller, flow } = setup({ status: 'invited', invitation, userId: null });
        await controller.invite(
            user('ada-1'),
            { email: 'newcomer@example.com', role: 'member' },
            req(),
            res(),
        );
        expect(flow.inviteForIntegration).toHaveBeenCalledWith(
            'org-a',
            'ada-1',
            'newcomer@example.com',
            {
                role: 'member',
                invitedName: undefined,
            },
        );
    });

    it('answers a pending invitation and a member with 200 (nothing new was created)', async () => {
        for (const outcome of [
            { status: 'pending', invitation, userId: null },
            { status: 'already_member', invitation: null, userId: 'u-known' },
        ]) {
            const { controller } = setup(outcome);
            const response = res();
            const body = (await controller.invite(
                user(),
                { email: 'x@example.com' },
                req(),
                response,
            )) as {
                status: string;
                userId: string | null;
            };
            expect(response.status).toHaveBeenCalledWith(200);
            expect(body.status).toBe(outcome.status);
            expect(body.userId).toBe(outcome.userId);
        }
    });

    it('answers a person added to the roster directly with 201 and their user id', async () => {
        const { controller } = setup({ status: 'added', invitation: null, userId: 'u-colleague' });
        const response = res();
        const body = await controller.invite(
            user(),
            { email: 'colleague@example.com' },
            req(),
            response,
        );
        expect(response.status).toHaveBeenCalledWith(201);
        expect(body).toEqual({ status: 'added', invitation: null, userId: 'u-colleague' });
    });

    it('refuses a request with no pinned organization (403 org_not_pinned) before inviting', async () => {
        const { controller, flow } = setup({ status: 'invited', invitation, userId: null }, null);
        await expect(
            controller.invite(user(), { email: 'x@example.com' }, req(), res()),
        ).rejects.toMatchObject({
            status: 403,
        });
        expect(flow.inviteForIntegration).not.toHaveBeenCalled();
    });
});
