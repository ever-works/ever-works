// Stub the agent subpaths + auth barrel so their transitive
// `@ever-works/agent/database` → `database.config.ts` (which imports the
// api-only `@src/config` alias) is never pulled into this controller test.
jest.mock('@ever-works/agent/facades', () => ({
    EmailFacadeService: class EmailFacadeService {},
    // The real base class, from source: the API's `FacadeExceptionFilter`
    // `@Catch`es it, and the HTTP block below installs that filter as
    // api.module.ts does.
    FacadeError: jest.requireActual('../../../../packages/agent/src/facades/base.facade')
        .FacadeError,
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

import { type INestApplication, Logger } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { EmailFacadeService } from '@ever-works/agent/facades';
import { EmailDraftService } from '@ever-works/agent/email';
import { AuthSessionGuard } from '../auth';
import { FacadeExceptionFilter } from '../common/filters/facade-exception.filter';

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

// The REAL facade, from source (the file-level mock above stands in for it in
// the wiring tests): its signature wrapper decides what a refused webhook
// answers, so the HTTP block below must run it.
type RealEmailFacadeCtor = new (registry: unknown, settings: unknown) => EmailFacadeService;
const { EmailFacadeService: RealEmailFacadeService } = jest.requireActual<{
    EmailFacadeService: RealEmailFacadeCtor;
}>('../../../../packages/agent/src/facades/email.facade');

/**
 * PLG-1 follow-up — what a refused webhook ANSWERS, through a real HTTP stack.
 *
 * Both webhook routes are @Public: the plugin's signature check is their only
 * authentication. The email-providers spec (§7) says a signature mismatch
 * answers 401 without saying which check failed. The plugin reports a
 * mismatch by THROWING a plain `Error` (the `IEmailInboundPlugin` contract),
 * which is neither an `HttpException` nor a `FacadeError` — left as it is,
 * Nest answers 500, and the provider retries a forged delivery as if we had
 * failed.
 *
 * Behind the routes: the real `EmailFacadeService` over a stub registry
 * holding a postmark-shaped plugin, and the API's `FacadeExceptionFilter`
 * installed as api.module.ts installs it.
 */
describe('EmailController — refused webhooks over HTTP', () => {
    const PLUGIN_ID = 'postmark';
    const SECRET = 'whsec-admin';
    // What the plugin says on a mismatch. It may name the check that failed,
    // so it is logged server-side and never answered.
    const PLUGIN_REASON = 'Postmark inbound: signature mismatch.';
    const IMPORT_FAILURE = 'Cannot find module /srv/plugins/postmark/dist/index.js';

    let app: INestApplication | undefined;
    let dispatcher: { dispatch: jest.Mock };
    let parsed: jest.Mock;
    let events: jest.Mock;
    let warn: jest.SpyInstance;

    function postmarkPlugin(overrides: Record<string, unknown> = {}) {
        parsed = jest.fn(async () => ({
            provider: PLUGIN_ID,
            providerMessageId: 'pm-1',
            from: 'sender@x.com',
            to: ['agent@x.com'],
            subject: 'hi',
            bodyText: 'body',
            attachments: [],
            receivedAt: new Date(0),
        }));
        events = jest.fn(async () => [
            { type: 'delivered', providerMessageId: 'pm-1', occurredAt: new Date(0) },
        ]);
        return {
            id: PLUGIN_ID,
            capabilities: ['email-inbound'],
            verifyWebhookSignature(_raw: Buffer, headers: Readonly<Record<string, string>>): void {
                if (headers['authorization'] !== `Basic ${SECRET}`) {
                    throw new Error(PLUGIN_REASON);
                }
            },
            parseInboundWebhook: parsed,
            parseEventWebhook: events,
            ...overrides,
        };
    }

    async function serve(entry: { plugin: unknown; state: string }): Promise<INestApplication> {
        const registry = { getByCapability: jest.fn(() => [entry]) };
        const settings = {
            getSettings: jest.fn(async () => ({ inboundWebhookSecret: SECRET })),
        };
        dispatcher = { dispatch: jest.fn().mockResolvedValue({ handled: true }) };
        const moduleRef = await Test.createTestingModule({
            controllers: [EmailController],
            providers: [
                { provide: EmailService, useValue: {} },
                {
                    provide: EmailFacadeService,
                    useValue: new RealEmailFacadeService(registry, settings),
                },
                { provide: AGENT_INBOUND_EMAIL_DISPATCHER, useValue: dispatcher },
                { provide: APP_FILTER, useClass: FacadeExceptionFilter },
            ],
        })
            .overrideGuard(AuthSessionGuard)
            .useValue({ canActivate: () => true })
            .compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        return app;
    }

    beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(async () => {
        await app?.close();
        app = undefined;
        jest.restoreAllMocks();
    });

    const payload = { MessageID: 'pm-1', To: 'agent@x.com', Subject: 'hi' };

    it('accepts a correctly signed inbound webhook (202) and dispatches it', async () => {
        const server = await serve({ plugin: postmarkPlugin(), state: 'loaded' });

        const res = await request(server.getHttpServer())
            .post(`/api/email/inbound/${PLUGIN_ID}`)
            .set('Authorization', `Basic ${SECRET}`)
            .send(payload);

        expect(res.status).toBe(202);
        expect(res.body).toEqual({ received: true });
        expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('answers 401 (not 500) to an inbound webhook with a bad signature, and dispatches nothing', async () => {
        const server = await serve({ plugin: postmarkPlugin(), state: 'loaded' });

        const res = await request(server.getHttpServer())
            .post(`/api/email/inbound/${PLUGIN_ID}`)
            .set('Authorization', 'Basic forged')
            .send(payload);

        expect(res.status).toBe(401);
        expect(parsed).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('answers 401 to a delivery-event webhook with a bad signature, and records nothing', async () => {
        const server = await serve({ plugin: postmarkPlugin(), state: 'loaded' });

        const res = await request(server.getHttpServer())
            .post(`/api/email/events/${PLUGIN_ID}`)
            .set('Authorization', 'Basic forged')
            .send(payload);

        expect(res.status).toBe(401);
        expect(events).not.toHaveBeenCalled();
    });

    it('answers 401 when the verification (against the contract) rejects asynchronously', async () => {
        const server = await serve({
            plugin: postmarkPlugin({
                verifyWebhookSignature: async () => {
                    throw new Error(PLUGIN_REASON);
                },
            }),
            state: 'loaded',
        });

        const res = await request(server.getHttpServer())
            .post(`/api/email/inbound/${PLUGIN_ID}`)
            .set('Authorization', 'Basic forged')
            .send(payload);

        expect(res.status).toBe(401);
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("answers a generic 401 body: the plugin's reason is logged, never sent to the caller", async () => {
        const server = await serve({ plugin: postmarkPlugin(), state: 'loaded' });

        const res = await request(server.getHttpServer())
            .post(`/api/email/inbound/${PLUGIN_ID}`)
            .set('Authorization', 'Basic forged')
            .send(payload);

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ statusCode: 401, message: 'Invalid webhook signature' });
        expect(res.text).not.toContain('Postmark');
        expect(res.text).not.toContain('mismatch');
        expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(PLUGIN_REASON);
    });

    it('still answers 503 (not 401) when the plugin cannot load, without the load error', async () => {
        const server = await serve({
            plugin: {
                ...postmarkPlugin(),
                __materialize: jest.fn(() => Promise.reject(new Error(IMPORT_FAILURE))),
            },
            state: 'loaded',
        });

        for (const route of ['inbound', 'events']) {
            const res = await request(server.getHttpServer())
                .post(`/api/email/${route}/${PLUGIN_ID}`)
                .set('Authorization', `Basic ${SECRET}`)
                .send(payload);

            expect(res.status).toBe(503);
            expect(res.text).not.toContain('Cannot find module');
        }
        expect(parsed).not.toHaveBeenCalled();
        expect(events).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });
});
