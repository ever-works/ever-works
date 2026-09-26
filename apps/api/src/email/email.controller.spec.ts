// Stub the agent subpaths + auth barrel so their transitive
// `@ever-works/agent/database` → `database.config.ts` (which imports the
// api-only `@src/config` alias) is never pulled into this controller test.
jest.mock('@ever-works/agent/facades', () => ({
    EmailFacadeService: class EmailFacadeService {},
}));
jest.mock('@ever-works/agent/notifications', () => ({
    AGENT_INBOUND_EMAIL_DISPATCHER: 'AGENT_INBOUND_EMAIL_DISPATCHER',
}));
const AGENT_INBOUND_EMAIL_DISPATCHER = 'AGENT_INBOUND_EMAIL_DISPATCHER';
jest.mock('@ever-works/agent/database', () => ({}));
// AW-05 — the draft loop is an optional collaborator; stub its subpath too.
jest.mock('@ever-works/agent/email', () => ({
    EmailDraftService: class EmailDraftService {},
}));
// Stub the React-Email renderer so the api test never loads React.
jest.mock('./templates/render', () => ({
    renderTemplate: jest.fn(),
    listTemplates: jest.fn(() => []),
}));
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    Public: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { EmailFacadeService } from '@ever-works/agent/facades';
import { EmailDraftService } from '@ever-works/agent/email';
import { AuthSessionGuard } from '../auth';

/**
 * EW-669 / T12 — EmailController wiring smoke tests. Per-route behaviour
 * lives in service-level + plugin-level test suites.
 */
describe('EmailController', () => {
    let controller: EmailController;
    let service: jest.Mocked<EmailService>;
    let facade: { parseInbound: jest.Mock };
    let inboundDispatcher: { dispatch: jest.Mock };

    beforeEach(async () => {
        service = {
            listAddresses: jest.fn().mockResolvedValue([]),
            createAddress: jest.fn().mockResolvedValue({ id: 'addr-1' }),
            updateAddress: jest.fn().mockResolvedValue({ id: 'addr-1' }),
            deleteAddress: jest.fn().mockResolvedValue(undefined),
            triggerVerification: jest.fn().mockResolvedValue({ messageRef: 'ref' }),
            confirmVerification: jest.fn().mockResolvedValue({ verified: true }),
            listMessagesForAgent: jest.fn().mockResolvedValue([]),
        } as unknown as jest.Mocked<EmailService>;
        facade = {
            parseInbound: jest.fn().mockResolvedValue({
                providerMessageId: 'pmid-1',
                from: 'sender@x.com',
                to: ['agent@x.com'],
                subject: 'hi',
                bodyText: 'body',
                bodyHtml: '<p>body</p>',
                receivedAt: new Date('2026-06-08T00:00:00Z'),
            }),
        };
        inboundDispatcher = {
            dispatch: jest.fn().mockResolvedValue({
                handled: true,
                agentId: 'agent-secret-42',
                mode: 'spawn-task',
            }),
        };
        const moduleRef: TestingModule = await Test.createTestingModule({
            controllers: [EmailController],
            providers: [
                { provide: EmailService, useValue: service },
                { provide: EmailFacadeService, useValue: facade },
                { provide: AGENT_INBOUND_EMAIL_DISPATCHER, useValue: inboundDispatcher },
            ],
        })
            .overrideGuard(AuthSessionGuard)
            .useValue({ canActivate: () => true })
            .compile();
        controller = moduleRef.get(EmailController);
    });

    it('listAddresses delegates to the service', async () => {
        const auth = { userId: 'user-1' } as any;
        await controller.listAddresses(auth);
        expect(service.listAddresses).toHaveBeenCalledWith('user-1', undefined);
    });

    it('createAddress delegates to the service', async () => {
        const auth = { userId: 'user-1' } as any;
        const body = {
            address: 'a@x.com',
            direction: 'outbound' as const,
            pluginId: 'postmark',
            providerSettings: {},
        };
        await controller.createAddress(auth, body);
        expect(service.createAddress).toHaveBeenCalledWith('user-1', body);
    });

    it('confirmVerification is publicly accessible and returns the service result', async () => {
        await expect(controller.confirmVerification('tok')).resolves.toEqual({ verified: true });
    });

    describe('inboundWebhook (EW-718 — no internal metadata leak)', () => {
        const req = { body: { foo: 'bar' } } as any;
        const headers = { 'x-signature': 'sig' } as any;

        it('returns a minimal ack that does NOT leak internal routing metadata', async () => {
            const res = await controller.inboundWebhook('postmark', req, headers);

            // Public, unauthenticated caller must only see the bare ack.
            expect(res).toEqual({ received: true });

            // None of the internal fields may appear in the response body,
            // even though the dispatcher resolved real values for them.
            const keys = Object.keys(res as Record<string, unknown>);
            expect(keys).not.toContain('providerMessageId');
            expect(keys).not.toContain('agentId');
            expect(keys).not.toContain('mode');
            expect(keys).not.toContain('handled');

            const serialized = JSON.stringify(res);
            expect(serialized).not.toContain('pmid-1');
            expect(serialized).not.toContain('agent-secret-42');
            expect(serialized).not.toContain('spawn-task');
        });

        it('still parses + dispatches the inbound message (processing unchanged)', async () => {
            await controller.inboundWebhook('postmark', req, headers);

            // Happy path: the message is still parsed and routed to the agent
            // dispatcher with the resolved provider metadata.
            expect(facade.parseInbound).toHaveBeenCalledTimes(1);
            expect(inboundDispatcher.dispatch).toHaveBeenCalledTimes(1);
            expect(inboundDispatcher.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({
                    pluginId: 'postmark',
                    providerMessageId: 'pmid-1',
                    from: 'sender@x.com',
                    subject: 'hi',
                }),
            );
        });

        // PLG-1 follow-up — the dispatcher must route to the address the
        // signature was verified for, not re-derive one from `to`: the route
        // hands it the facade's `authenticatedRecipient` as-is.
        it('dispatches to the address the facade authenticated the webhook for', async () => {
            const recipient = { emailAddressId: 'addr-7', userId: 'owner-7' };
            facade.parseInbound.mockResolvedValueOnce({
                providerMessageId: 'pmid-2',
                from: 'sender@x.com',
                to: ['someone-else@x.com', 'agent@x.com'],
                subject: 'hi',
                bodyText: 'body',
                receivedAt: new Date('2026-06-08T00:00:00Z'),
                authenticatedRecipient: recipient,
            });

            await controller.inboundWebhook('postmark', req, headers);

            expect(inboundDispatcher.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({ pluginId: 'postmark', recipient }),
            );
        });

        it('dispatches with no recipient when the facade bound the webhook to none', async () => {
            facade.parseInbound.mockResolvedValueOnce({
                providerMessageId: 'pmid-3',
                from: 'sender@x.com',
                to: ['agent@x.com'],
                subject: 'hi',
                bodyText: 'body',
                receivedAt: new Date('2026-06-08T00:00:00Z'),
                authenticatedRecipient: null,
            });

            await controller.inboundWebhook('postmark', req, headers);

            expect(inboundDispatcher.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({ recipient: null }),
            );
        });

        // PLG-1 — the facade fails closed (a bad signature throws; a plugin
        // that cannot load is refused with a 503). The public route must pass
        // that refusal through: never ack, never dispatch the message.
        it.each([
            ['a bad signature', new Error('Postmark inbound: signature mismatch.')],
            [
                'an inbound plugin that cannot load (503)',
                Object.assign(new Error('Inbound email plugin postmark is unavailable'), {
                    status: 503,
                }),
            ],
        ])('refuses the webhook and dispatches nothing on %s', async (_case, refusal) => {
            facade.parseInbound.mockRejectedValueOnce(refusal);

            await expect(controller.inboundWebhook('postmark', req, headers)).rejects.toBe(refusal);
            expect(inboundDispatcher.dispatch).not.toHaveBeenCalled();
        });
    });

    describe('compose + held drafts (AW-05)', () => {
        let drafts: { approve: jest.Mock; discard: jest.Mock };
        let withDrafts: EmailController;

        beforeEach(async () => {
            (service as any).sendMessage = jest
                .fn()
                .mockResolvedValue({ messageRef: 'ref', providerMessageId: 'pm-1' });
            drafts = {
                approve: jest.fn().mockResolvedValue({
                    message: {
                        id: 'm-1',
                        status: 'sent',
                        approvedById: 'user-1',
                        approvedAt: new Date('2026-09-14T12:00:00Z'),
                        sentAt: new Date('2026-09-14T12:00:01Z'),
                        failureReason: null,
                        bodyText: 'never echoed back',
                    },
                    result: { providerMessageId: 'pm-1' },
                }),
                discard: jest.fn().mockResolvedValue({
                    message: { id: 'm-1', status: 'discarded', bodyText: 'never echoed back' },
                }),
            };
            const moduleRef: TestingModule = await Test.createTestingModule({
                controllers: [EmailController],
                providers: [
                    { provide: EmailService, useValue: service },
                    { provide: EmailFacadeService, useValue: facade },
                    { provide: EmailDraftService, useValue: drafts },
                ],
            })
                .overrideGuard(AuthSessionGuard)
                .useValue({ canActivate: () => true })
                .compile();
            withDrafts = moduleRef.get(EmailController);
        });

        it('sends a composed message as a person — the server sets the origin, not the body', async () => {
            const body = { agentId: 'agent-1', to: ['a@x.com'], subject: 's', bodyText: 'b' };
            await withDrafts.sendMessage({ userId: 'user-1' } as any, body as any);
            expect((service as any).sendMessage).toHaveBeenCalledWith('user-1', body, {
                origin: 'human',
            });
        });

        it('approves a draft for the caller and reports the decision without the body', async () => {
            const res = await withDrafts.approveDraft({ userId: 'user-1' } as any, 'm-1');
            expect(drafts.approve).toHaveBeenCalledWith('user-1', 'm-1');
            expect(res).toEqual({
                message: {
                    id: 'm-1',
                    status: 'sent',
                    approvedById: 'user-1',
                    approvedAt: '2026-09-14T12:00:00.000Z',
                    sentAt: '2026-09-14T12:00:01.000Z',
                    failureReason: null,
                },
                result: { providerMessageId: 'pm-1' },
            });
            expect(JSON.stringify(res)).not.toContain('never echoed back');
        });

        it('discards a draft for the caller', async () => {
            const res = await withDrafts.discardDraft({ userId: 'user-1' } as any, 'm-1');
            expect(drafts.discard).toHaveBeenCalledWith('user-1', 'm-1');
            expect(res.message).toMatchObject({ id: 'm-1', status: 'discarded' });
        });

        it('passes a draft-loop refusal through unchanged (e.g. 409 already decided)', async () => {
            const conflict = Object.assign(new Error('already decided'), { status: 409 });
            drafts.approve.mockRejectedValue(conflict);
            await expect(withDrafts.approveDraft({ userId: 'user-1' } as any, 'm-1')).rejects.toBe(
                conflict,
            );
        });

        it('answers 404 when the draft loop is not wired, like a missing message', async () => {
            await expect(
                controller.approveDraft({ userId: 'user-1' } as any, 'm-1'),
            ).rejects.toMatchObject({ status: 404 });
        });

        it('declares the draft routes before messages/:id so ":id" cannot capture them', () => {
            const names = Object.getOwnPropertyNames(EmailController.prototype);
            expect(names.indexOf('approveDraft')).toBeLessThan(names.indexOf('getMessage'));
            expect(names.indexOf('discardDraft')).toBeLessThan(names.indexOf('getMessage'));
        });
    });
});
