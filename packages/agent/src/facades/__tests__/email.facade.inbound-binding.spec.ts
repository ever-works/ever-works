import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { IPlugin, PluginManifest } from '@ever-works/plugin';
import { EmailFacadeService } from '../email.facade';
import { DefaultInboundEmailDispatcher } from '../../notifications/default-inbound-email-dispatcher.service';
import type { AgentInboundEmailDispatchResult } from '../../notifications/agent-inbound-email-dispatcher';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type {
    TenantEmailAddressRepository,
    AgentEmailAssignmentRepository,
    EmailMessageRepository,
    EmailConversationRepository,
} from '../../database';
import { createRegistry } from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

// The REAL plugin classes, from SOURCE. Loaded at runtime rather than
// imported: each plugin is type-checked in its own package under its own
// compiler options, and a static import would pull it into this package's
// `tsc` program, where NodeNext resolves `mailgun.js`'s default export
// differently (TS2351).
type PluginClass = new () => IPlugin;
const { PostmarkPlugin } = jest.requireActual<{ PostmarkPlugin: PluginClass }>(
    '../../../../plugins/postmark/src/postmark-plugin',
);
const { MailgunPlugin } = jest.requireActual<{ MailgunPlugin: PluginClass }>(
    '../../../../plugins/mailgun/src/mailgun-plugin',
);

/**
 * PLG-1 follow-up — a signed inbound webhook must be delivered ONLY to the
 * address whose owner's secret verified it.
 *
 * The facade picked the verification scope from the FIRST payload recipient
 * registered to the webhook's plugin, and a user-level secret replaces the
 * admin one at that user's scope. The dispatcher then re-derived the
 * destination from the payload's `to` list — the first recipient matching ANY
 * address row, of any plugin, of any owner. So a tenant could sign a webhook
 * with their OWN per-user key, name their own address where the facade stops
 * and the victim's where the dispatcher stops, and have the forged mail
 * spawn a Task for the victim's Agent — with every secret configured:
 *  (a) the victim's address is on another provider (the facade skips it, the
 *      dispatcher does not);
 *  (b) both are on the same provider, and the plugin normalises the address
 *      list differently for the owner lookup (display name stripped) than for
 *      `to` (kept), so the dispatcher misses the attacker's own entry.
 *
 * These specs drive the REAL Postmark and Mailgun plugin classes (behind real
 * lazy proxies), the real `EmailFacadeService` and the real
 * `DefaultInboundEmailDispatcher`, joined exactly as
 * `EmailController.inboundWebhook` joins them.
 */

interface AddressRow {
    id: string;
    userId: string;
    address: string;
    pluginId: string;
    direction: 'inbound' | 'outbound' | 'both';
    disabledAt: Date | null;
    createdAt: Date;
}

const VICTIM = 'victim';
const ATTACKER = 'attacker';

/** Every secret configured: platform (admin) keys AND per-user keys. */
const SETTINGS: Record<
    string,
    { admin: Record<string, unknown>; users: Record<string, Record<string, unknown>> }
> = {
    postmark: {
        admin: { inboundWebhookSecret: 'pm-admin' },
        users: { [VICTIM]: { inboundWebhookSecret: 'pm-victim' } },
    },
    mailgun: {
        admin: { webhookSigningKey: 'mg-admin' },
        users: {
            [VICTIM]: { webhookSigningKey: 'mg-victim' },
            [ATTACKER]: { webhookSigningKey: 'mg-attacker' },
        },
    },
};

function row(id: string, userId: string, address: string, pluginId: string, order: number) {
    return {
        id,
        userId,
        address,
        pluginId,
        direction: 'inbound',
        disabledAt: null,
        createdAt: new Date(order * 1000),
    } as AddressRow;
}

/** Postmark authenticates inbound webhooks with HTTP Basic `postmark:<secret>`. */
function postmarkWebhook(to: string[], secret: string) {
    return {
        rawBody: Buffer.from(
            JSON.stringify({
                MessageID: 'pm-in-1',
                From: 'sender@example.com',
                ToFull: to.map((Email) => ({ Email })),
                Subject: 'hello',
                TextBody: 'body',
                Date: '2026-09-26T10:00:00Z',
            }),
        ),
        headers: {
            authorization: `Basic ${Buffer.from(`postmark:${secret}`).toString('base64')}`,
        } as Record<string, string>,
    };
}

/** Mailgun signs `timestamp + token` with HMAC-SHA256 of the signing key. */
function mailgunWebhook(fields: Record<string, string>, signingKey: string) {
    const timestamp = '1790000000';
    const token = 'token-1';
    const signature = createHmac('sha256', signingKey).update(`${timestamp}${token}`).digest('hex');
    return {
        rawBody: Buffer.from(
            new URLSearchParams({
                sender: 'sender@example.com',
                subject: 'hello',
                'body-plain': 'body',
                'Message-Id': '<mg-in-1@example.com>',
                ...fields,
                timestamp,
                token,
                signature,
            }).toString(),
        ),
        headers: {} as Record<string, string>,
    };
}

function world(rows: AddressRow[]) {
    const registry = createRegistry();
    for (const plugin of [new PostmarkPlugin(), new MailgunPlugin()]) {
        registry.registerLazy(
            {
                id: plugin.id,
                name: plugin.name,
                version: plugin.version,
                description: plugin.name,
                category: plugin.category,
                capabilities: [...plugin.capabilities],
            } as PluginManifest,
            async () => plugin,
        );
    }

    const settingsScopes: string[] = [];
    const settings = {
        getSettings: jest.fn(async (pluginId: string, options: { userId?: string }) => {
            settingsScopes.push(`${pluginId}:${options.userId ?? 'admin'}`);
            const byScope = SETTINGS[pluginId];
            return {
                ...byScope.admin,
                ...(options.userId ? (byScope.users[options.userId] ?? {}) : {}),
            };
        }),
    } as unknown as PluginSettingsService;

    // `TenantEmailAddressRepository` semantics: the oldest active row of that
    // literal mailbox, in the asked directions.
    const addresses = {
        findByAddress: jest.fn(
            async (address: string, directions: string[] = ['inbound', 'both']) =>
                rows
                    .filter((r) => r.address === address && !r.disabledAt)
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                    .find((r) => directions.includes(r.direction)) ?? null,
        ),
        findById: jest.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    };
    const assignments = {
        findByEmailAddress: jest.fn(async (emailAddressId: string) => [
            { agentId: `agent-of-${emailAddressId}`, dispatchMode: 'task-spawn' },
        ]),
    };
    let saved = 0;
    const messages = {
        save: jest.fn(async (message: Record<string, unknown>) => ({
            id: `msg-${++saved}`,
            ...message,
        })),
        updateDeliveryStatus: jest.fn(async () => undefined),
    };
    const spawned: Array<{ agentId: string; userId: string }> = [];
    const spawner = {
        spawnTaskForInboundEmail: jest.fn(async (input: { agentId: string; userId: string }) => {
            spawned.push({ agentId: input.agentId, userId: input.userId });
            return { taskId: `task-${spawned.length}` };
        }),
    };

    const facade = new EmailFacadeService(
        registry as PluginRegistryService,
        settings,
        undefined,
        addresses as unknown as TenantEmailAddressRepository,
    );
    const dispatcher = new DefaultInboundEmailDispatcher(
        addresses as unknown as TenantEmailAddressRepository,
        assignments as unknown as AgentEmailAssignmentRepository,
        messages as unknown as EmailMessageRepository,
        {} as EmailConversationRepository,
        spawner,
    );

    /** What `EmailController.inboundWebhook` does with one webhook. */
    async function deliver(
        pluginId: string,
        webhook: { rawBody: Buffer; headers: Record<string, string> },
    ): Promise<AgentInboundEmailDispatchResult> {
        const message = await facade.parseInbound(pluginId, webhook.rawBody, webhook.headers);
        return dispatcher.dispatch({
            pluginId,
            recipient: message.authenticatedRecipient,
            providerMessageId: message.providerMessageId,
            from: message.from,
            to: [...message.to],
            subject: message.subject,
            bodyText: message.bodyText,
            bodyHtml: message.bodyHtml,
            receivedAt: message.receivedAt,
        });
    }

    return { facade, deliver, spawned, settingsScopes, messages };
}

describe('EmailFacadeService + DefaultInboundEmailDispatcher — a webhook reaches only the address it was verified for', () => {
    const savedEnv = {
        postmark: process.env.POSTMARK_INBOUND_SECRET,
        mailgun: process.env.MAILGUN_WEBHOOK_SIGNING_KEY,
    };
    beforeEach(() => {
        delete process.env.POSTMARK_INBOUND_SECRET;
        delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    });
    afterAll(() => {
        if (savedEnv.postmark !== undefined)
            process.env.POSTMARK_INBOUND_SECRET = savedEnv.postmark;
        if (savedEnv.mailgun !== undefined)
            process.env.MAILGUN_WEBHOOK_SIGNING_KEY = savedEnv.mailgun;
    });

    // Victim on postmark (own secret), attacker on mailgun (own key).
    const crossProviderRows = () => [
        row('addr-victim-pm', VICTIM, 'victim@v.test', 'postmark', 1),
        row('addr-attacker-mg', ATTACKER, 'attacker@a.test', 'mailgun', 2),
    ];
    // Both on mailgun, each with their own key.
    const sameProviderRows = () => [
        row('addr-victim-mg', VICTIM, 'victim@v.test', 'mailgun', 1),
        row('addr-attacker-mg', ATTACKER, 'attacker@a.test', 'mailgun', 2),
    ];

    it("(a) never delivers to another provider's address a webhook signed with the sender's own key", async () => {
        const { deliver, spawned, settingsScopes } = world(crossProviderRows());

        const result = await deliver(
            'mailgun',
            mailgunWebhook({ recipient: 'victim@v.test, attacker@a.test' }, 'mg-attacker'),
        );

        // Verified as the attacker — so it may reach the attacker's inbox, and
        // nothing else.
        expect(settingsScopes).toEqual(['mailgun:attacker']);
        expect(spawned.map((s) => s.userId)).not.toContain(VICTIM);
        expect(result).toMatchObject({ handled: true, agentId: 'agent-of-addr-attacker-mg' });
        expect(spawned).toEqual([{ agentId: 'agent-of-addr-attacker-mg', userId: ATTACKER }]);
    });

    it("(b) never delivers to a same-provider victim named after the sender's own display-name address", async () => {
        const { deliver, spawned } = world(sameProviderRows());

        const result = await deliver(
            'mailgun',
            mailgunWebhook({ To: 'Attacker <attacker@a.test>, victim@v.test' }, 'mg-attacker'),
        );

        expect(spawned.map((s) => s.userId)).not.toContain(VICTIM);
        expect(result).toMatchObject({ handled: true, agentId: 'agent-of-addr-attacker-mg' });
    });

    it("does not deliver a webhook authenticated only by one provider's platform secret to an address registered with another provider", async () => {
        // The victim's mailbox is on mailgun (their own key); a postmark
        // webhook for it proves only the postmark platform secret.
        const { deliver, spawned } = world(sameProviderRows());

        const result = await deliver('postmark', postmarkWebhook(['victim@v.test'], 'pm-admin'));

        expect(result).toMatchObject({ handled: false });
        expect(spawned).toEqual([]);
    });

    it('rejects a forged webhook that names the victim first (verified with the victim key)', async () => {
        const { deliver, spawned, settingsScopes } = world(sameProviderRows());

        await expect(
            deliver(
                'mailgun',
                mailgunWebhook({ recipient: 'victim@v.test, attacker@a.test' }, 'mg-attacker'),
            ),
        ).rejects.toThrow('Mailgun inbound: signature mismatch.');
        expect(settingsScopes).toEqual(['mailgun:victim']);
        expect(spawned).toEqual([]);
    });

    it("rejects a forged webhook naming only another provider's address", async () => {
        const { deliver, spawned } = world(crossProviderRows());

        await expect(
            deliver('mailgun', mailgunWebhook({ recipient: 'victim@v.test' }, 'mg-attacker')),
        ).rejects.toThrow('Mailgun inbound: signature mismatch.');
        expect(spawned).toEqual([]);
    });

    it("delivers the victim's own signed webhook to the victim", async () => {
        const { deliver, spawned } = world(crossProviderRows());

        const result = await deliver('postmark', postmarkWebhook(['victim@v.test'], 'pm-victim'));

        expect(result).toMatchObject({ handled: true, agentId: 'agent-of-addr-victim-pm' });
        expect(spawned).toEqual([{ agentId: 'agent-of-addr-victim-pm', userId: VICTIM }]);
    });

    it('delivers a platform-signed webhook to an owner who inherits the platform key', async () => {
        // The attacker has no postmark secret of their own: at their scope the
        // admin one applies, so a platform-signed webhook is theirs.
        const rows = [row('addr-a-pm', ATTACKER, 'attacker@a.test', 'postmark', 1)];
        const { deliver, spawned } = world(rows);

        const result = await deliver('postmark', postmarkWebhook(['attacker@a.test'], 'pm-admin'));

        expect(result).toMatchObject({ handled: true, agentId: 'agent-of-addr-a-pm' });
        expect(spawned).toEqual([{ agentId: 'agent-of-addr-a-pm', userId: ATTACKER }]);
    });

    it('verifies but dispatches nothing when no recipient is a registered address of the plugin', async () => {
        const { facade, deliver, spawned } = world(crossProviderRows());
        const webhook = mailgunWebhook({ recipient: 'nobody@n.test' }, 'mg-admin');

        await expect(
            facade.parseInbound('mailgun', webhook.rawBody, webhook.headers),
        ).resolves.toMatchObject({ authenticatedRecipient: null });
        await expect(deliver('mailgun', webhook)).resolves.toMatchObject({ handled: false });
        expect(spawned).toEqual([]);
    });

    it('names the verified address (id + owner) on the parsed message', async () => {
        const { facade } = world(crossProviderRows());
        const webhook = postmarkWebhook(['victim@v.test'], 'pm-victim');

        await expect(
            facade.parseInbound('postmark', webhook.rawBody, webhook.headers),
        ).resolves.toMatchObject({
            providerMessageId: 'pm-in-1',
            authenticatedRecipient: { emailAddressId: 'addr-victim-pm', userId: VICTIM },
        });
    });

    it('binds no address when the caller supplied the verification scope itself', async () => {
        const { facade } = world(crossProviderRows());
        const webhook = postmarkWebhook(['victim@v.test'], 'pm-victim');

        await expect(
            facade.parseInbound('postmark', webhook.rawBody, webhook.headers, { userId: VICTIM }),
        ).resolves.toMatchObject({ authenticatedRecipient: null });
    });

    it('records the display-name-stripped recipients on the persisted message', async () => {
        const { deliver, messages } = world(sameProviderRows());

        await deliver(
            'mailgun',
            mailgunWebhook({ To: 'Attacker <attacker@a.test>, victim@v.test' }, 'mg-attacker'),
        );

        expect(messages.save).toHaveBeenCalledWith(
            expect.objectContaining({ toAddresses: ['attacker@a.test', 'victim@v.test'] }),
        );
    });
});
