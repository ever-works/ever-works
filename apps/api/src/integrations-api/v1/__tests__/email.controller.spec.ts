import { ResourceNotFoundError } from '@ever-works/agent/integrations-api';
import { IntegrationEmailController } from '../email.controller';

/**
 * Agent email of `/api/integrations/v1` (EW-P4-2 / EW-P4-1) over doubles: the
 * list filters, and `POST /email/inbound` delivering to the agent's own
 * inbound address through the provider path's dispatcher, de-duplicated, never
 * fetching an attachment URL, and refused for an agent without an inbound
 * assignment.
 */
describe('IntegrationEmailController', () => {
    const ORG = '0f4b2c6d-8e1a-4b3c-9d5e-6f7a8b9c0d12';
    const AGENT = '3c7e5f90-1b4d-4e6f-8a82-9c0d1e2f3a41';
    const user = {
        userId: 'owner-1',
        authMethod: 'integration',
        integration: {
            keyId: 'key-1',
            keyName: 'Gauzy',
            integrationKind: 'ever-gauzy',
            tenantId: 'tenant-1',
            allowedOrganizationIds: [ORG],
            scopes: ['email:read', 'email:write'],
            ownerUserId: 'owner-1',
            actAsUserId: null,
        },
    } as never;
    const res = () => ({ status: jest.fn(), setHeader: jest.fn() });
    const req = (key = 'idem-1') => ({
        method: 'POST',
        originalUrl: '/api/integrations/v1/email/inbound',
        body: {},
        headers: key ? { 'idempotency-key': key } : {},
    });
    const address = {
        id: 'addr-1',
        userId: 'agent-owner',
        pluginId: 'postmark',
        organizationId: ORG,
    };
    const body = (extra: Record<string, unknown> = {}) => ({
        agentId: AGENT,
        message: {
            from: 'ada@example.com',
            to: ['support.acme@inbox.gauzy.co'],
            subject: 'Refund',
            text: 'Can I get a refund?',
            messageId: '<CAF1@mail.example.com>',
            attachments: [
                {
                    filename: 'invoice.pdf',
                    contentType: 'application/pdf',
                    url: 'https://g.test/a',
                },
            ],
            ...extra,
        },
    });

    const setup = (
        opts: { inbox?: boolean; pushed?: boolean; addressOrganizationId?: string | null } = {},
    ) => {
        const email = {
            list: jest.fn().mockResolvedValue({ data: [], nextCursor: null, hasMore: false }),
            get: jest.fn(async (_org: string, id: string) => ({
                dto: { id, taskId: 'task-1', conversationId: null, version: 1 },
                etag: '"1"',
            })),
            inboundAddressOf: jest.fn(async () =>
                opts.inbox === false
                    ? { ok: false, reason: 'The agent has no inbound email assignment.' }
                    : {
                          ok: true,
                          address:
                              'addressOrganizationId' in opts
                                  ? { ...address, organizationId: opts.addressOrganizationId }
                                  : address,
                      },
            ),
            findPushed: jest.fn(async () => (opts.pushed ? { id: 'msg-old' } : null)),
        };
        const resources = { get: jest.fn().mockResolvedValue({ dto: { id: AGENT }, etag: '"1"' }) };
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
        const dispatcher = {
            dispatch: jest.fn().mockResolvedValue({
                handled: true,
                agentId: AGENT,
                mode: 'task-spawn',
                emailMessageId: 'msg-1',
                taskId: 'task-1',
            }),
        };
        const scope = { getScope: () => ({ tenantId: 'tenant-1', organizationId: ORG }) };
        const controller = new IntegrationEmailController(
            email as never,
            resources as never,
            idempotency as never,
            scope as never,
            dispatcher as never,
        );
        return { controller, email, resources, dispatcher };
    };

    it('lists with validated filters', async () => {
        const { controller, email } = setup();
        await controller.list({ agentId: AGENT, direction: 'inbound', status: 'received,sent' });
        expect(email.list).toHaveBeenCalledWith(
            ORG,
            expect.objectContaining({
                agentId: AGENT,
                direction: 'inbound',
                statuses: ['received', 'sent'],
            }),
        );
        for (const query of [{ agentId: 'x' }, { direction: 'both' }, { status: 'deleted' }]) {
            await expect(controller.list(query)).rejects.toMatchObject({
                code: 'validation_failed',
            });
        }
    });

    it("delivers to the agent's inbound address through the provider dispatcher, never fetching attachment URLs", async () => {
        const { controller, dispatcher } = setup();
        const response = res();
        const result = await controller.inbound(user, body(), req(), response);
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                pluginId: 'postmark',
                recipient: { emailAddressId: 'addr-1', userId: 'agent-owner' },
                // Review 2026-10-17 F15: the agent the key was authorized for.
                agentId: AGENT,
                from: 'ada@example.com',
                subject: 'Refund',
                bodyText: 'Can I get a refund?',
                messageIdHeader: 'CAF1@mail.example.com',
                metadata: expect.objectContaining({
                    source: 'integration',
                    externalAttachments: [
                        {
                            filename: 'invoice.pdf',
                            contentType: 'application/pdf',
                            url: 'https://g.test/a',
                        },
                    ],
                }),
            }),
        );
        // Nothing to store from a URL: the dispatcher gets no attachment bytes.
        expect(dispatcher.dispatch.mock.calls[0][0].attachments).toBeUndefined();
        expect(response.status).toHaveBeenCalledWith(201);
        expect(result).toEqual({
            message: { id: 'msg-1', taskId: 'task-1', conversationId: null, version: 1 },
            dispatch: {
                mode: 'task-spawn',
                taskId: 'task-1',
                conversationId: null,
                threaded: false,
            },
        });
    });

    it('answers a push already delivered (same Message-ID) with 200 and dispatches nothing', async () => {
        const { controller, dispatcher, email } = setup({ pushed: true });
        const response = res();
        await controller.inbound(user, body(), req(), response);
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
        // The replay lookup is the pinned organization's only.
        expect(email.findPushed).toHaveBeenCalledWith(ORG, 'postmark', expect.any(String));
    });

    // Review 2026-10-17 F54 (raised again by CodeRabbit on #2709): de-duplication is
    // per agent, so one Message-ID pushed to two agents reaches both.
    it('delivers the same Message-ID to a second agent, and still dedupes a legacy push of the same agent', async () => {
        const other = setup();
        // The per-agent id finds nothing; the legacy id finds the OTHER agent's copy.
        other.email.findPushed
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'msg-a', agentId: 'agent-a' } as never);
        await other.controller.inbound(user, body(), req(), res());
        expect(other.dispatcher.dispatch).toHaveBeenCalledTimes(1);
        const [perAgentId, legacyId] = other.email.findPushed.mock.calls.map(
            (call: unknown[]) => call[2],
        );
        expect(perAgentId).not.toBe(legacyId);

        const same = setup();
        same.email.findPushed
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'msg-old', agentId: AGENT } as never);
        const response = res();
        await same.controller.inbound(user, body(), req(), response);
        expect(same.dispatcher.dispatch).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(200);
    });

    it('refuses an inbound address of another organization, or of none (422): its mail would be unreadable', async () => {
        for (const addressOrganizationId of ['00000000-0000-4000-8000-0000000000ff', null]) {
            const { controller, dispatcher } = setup({ addressOrganizationId });
            await expect(controller.inbound(user, body(), req(), res())).rejects.toMatchObject({
                code: 'domain_rule',
            });
            expect(dispatcher.dispatch).not.toHaveBeenCalled();
        }
    });

    it('refuses an agent without an inbound assignment (422) and a message with no body (400)', async () => {
        const none = setup({ inbox: false });
        await expect(none.controller.inbound(user, body(), req(), res())).rejects.toMatchObject({
            code: 'domain_rule',
        });
        expect(none.dispatcher.dispatch).not.toHaveBeenCalled();
        const empty = setup();
        await expect(
            empty.controller.inbound(user, body({ text: null, html: null }), req(), res()),
        ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('404s an agent the key does not see in the organization', async () => {
        const { controller, resources, dispatcher } = setup();
        resources.get.mockRejectedValueOnce(new ResourceNotFoundError('agent', AGENT));
        await expect(controller.inbound(user, body(), req(), res())).rejects.toBeInstanceOf(
            ResourceNotFoundError,
        );
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });
});
