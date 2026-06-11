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
    });
});
