import { runInThisContext } from 'node:vm';
import { Logger } from '@nestjs/common';
import type { EmailOptions } from '@ever-works/plugin';
import { EmailFacadeService } from '../email.facade';
import { loadPluginSchema } from '../../plugins/services/plugin-registry.service';
import type { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { TenantEmailAddressRepository } from '../../database/repositories/tenant-email-address.repository';
import {
    createRegistry,
    gate,
    registerColdPlugin,
    settle,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * PLG-1 — the @Public inbound-email webhooks (`POST /email/inbound/:pluginId`,
 * `POST /email/events/:pluginId`) rest on the plugin's SYNC
 * `verifyWebhookSignature` throwing, and on its SYNC
 * `extractInboundRecipients` naming the owner whose per-user secret verifies.
 *
 * mailgun and postmark are disk-discovered, so the registry holds them as lazy
 * proxies. Called through a proxy that is cold, or whose first load is still
 * settling, a sync method answers a Promise: the recipients were "not
 * iterable" (the owner's secret was never resolved, and a plugin with no
 * secret at that scope accepts), and a bad signature became a discarded
 * rejected Promise (an unhandled rejection) while the forged message was
 * parsed and dispatched. These specs use REAL lazy proxies.
 */

const PLUGIN_ID = 'postmark';
const RECIPIENT = 'inbox@ever.works';
const OWNER_ID = 'owner-1';

function basic(secret: string): string {
    return `Basic ${Buffer.from(`postmark:${secret}`).toString('base64')}`;
}

function body(to = RECIPIENT): Buffer {
    return Buffer.from(JSON.stringify({ MessageID: 'pm-1', To: to, Subject: 'hi' }));
}

/**
 * A postmark-shaped inbound plugin: verification is an operator opt-in (no
 * secret at the resolved scope → accept), and a mismatch THROWS — exactly
 * the contract `IEmailInboundPlugin.verifyWebhookSignature` states.
 */
function inboundMembers(overrides: Record<string, unknown> = {}) {
    const parsed = jest.fn(async () => ({
        provider: PLUGIN_ID,
        providerMessageId: 'pm-1',
        from: 'attacker@example.com',
        to: [RECIPIENT],
        subject: 'forged',
        bodyText: 'forged',
        attachments: [],
        receivedAt: new Date(0),
    }));
    const events = jest.fn(async () => [
        { type: 'delivered', providerMessageId: 'pm-1', occurredAt: new Date(0) },
    ]);
    return {
        parsed,
        events,
        members: {
            verifyWebhookSignature(
                _raw: Buffer,
                headers: Readonly<Record<string, string>>,
                options: EmailOptions,
            ): void {
                const expected = options.settings?.inboundWebhookSecret;
                if (typeof expected !== 'string' || !expected) return;
                if (headers['authorization'] !== basic(expected)) {
                    throw new Error('Postmark inbound: signature mismatch.');
                }
            },
            extractInboundRecipients(raw: Buffer): readonly string[] {
                try {
                    const payload = JSON.parse(raw.toString('utf8')) as { To?: string };
                    return payload.To ? [payload.To] : [];
                } catch {
                    return [];
                }
            },
            parseInboundWebhook: parsed,
            parseEventWebhook: events,
            ...overrides,
        },
    };
}

/**
 * The settings service as the facade uses it: `getSettings` loads the schema
 * (`loadPluginSchema`, as `PluginSettingsService.getSettings` does) and then
 * answers the secret configured at the asked scope.
 */
function settingsStub(
    registry: PluginRegistryService,
    byScope: { admin?: Record<string, unknown>; owner?: Record<string, unknown> },
) {
    const scopes: string[] = [];
    const getSettings = jest.fn(async (pluginId: string, options: { userId?: string }) => {
        const registered = registry.get(pluginId);
        if (registered) await loadPluginSchema(registered.plugin, registered);
        scopes.push(options.userId ?? 'admin');
        return options.userId === OWNER_ID
            ? { ...(byScope.admin ?? {}), ...(byScope.owner ?? {}) }
            : { ...(byScope.admin ?? {}) };
    });
    return { service: { getSettings } as unknown as PluginSettingsService, scopes };
}

function addressesStub(): TenantEmailAddressRepository {
    return {
        findByAddress: jest.fn(async (address: string) =>
            address === RECIPIENT ? { userId: OWNER_ID, pluginId: PLUGIN_ID } : null,
        ),
    } as unknown as TenantEmailAddressRepository;
}

function facadeFor(registry: PluginRegistryService, settings: PluginSettingsService) {
    return new EmailFacadeService(registry, settings, undefined, addressesStub());
}

/**
 * Every unhandled rejection raised while `run` executes (and a few macrotask
 * turns after it, so Node has had the chance to report one).
 *
 * The listener goes on the REAL `process`: under Jest the test's `process`
 * global is a sandbox copy that never hears `unhandledRejection` (jest-circus
 * listens on the real one, and also fails the running test on such a
 * rejection). `runInThisContext` evaluates outside the sandbox.
 */
async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
    const realProcess = runInThisContext('process') as NodeJS.Process;
    const seen: unknown[] = [];
    const listener = (reason: unknown) => {
        seen.push(reason);
    };
    realProcess.on('unhandledRejection', listener);
    try {
        await run();
        for (let turn = 0; turn < 5; turn++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    } finally {
        realProcess.off('unhandledRejection', listener);
    }
    return seen;
}

describe('EmailFacadeService — inbound webhooks over a lazy (cold) email plugin', () => {
    it('rejects a forged webhook that arrives while another request is settling the first load', async () => {
        const registry = createRegistry();
        const firstLoad = gate();
        const { members, parsed } = inboundMembers();
        registerColdPlugin(registry, {
            id: PLUGIN_ID,
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: {} as never,
            members,
            firstLoadGate: firstLoad.promise,
        });
        const { service } = settingsStub(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        let legit: Promise<unknown> | undefined;
        let forged: Promise<unknown> | undefined;
        const outcomes: string[] = [];
        const unhandled = await collectUnhandled(async () => {
            // Request A starts the first load and is held inside its hook.
            legit = facade.parseInbound(PLUGIN_ID, body(), { authorization: basic('admin') }).then(
                () => outcomes.push('legit: accepted'),
                (error: Error) => outcomes.push(`legit: rejected: ${error.message}`),
            );
            await settle();
            // Request B arrives once the module is imported but the first load
            // has not settled — with a bad signature.
            forged = facade.parseInbound(PLUGIN_ID, body(), { authorization: basic('wrong') }).then(
                () => outcomes.push('forged: accepted'),
                (error: Error) => outcomes.push(`forged: rejected: ${error.message}`),
            );
            await settle();
            firstLoad.release();
            await Promise.all([legit, forged]);
        });

        expect(outcomes).toContain('legit: accepted');
        expect(outcomes).toContain('forged: rejected: Postmark inbound: signature mismatch.');
        expect(parsed).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
    });

    it("resolves the owner's per-user secret on the FIRST webhook after a restart and rejects a bad signature", async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdPlugin(registry, {
            id: PLUGIN_ID,
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: {} as never,
            members,
        });
        // Per-user secret only: no admin or env secret.
        const { service, scopes } = settingsStub(registry, {
            owner: { inboundWebhookSecret: 'owner-secret' },
        });
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseInbound(PLUGIN_ID, body(), { authorization: basic('forged') }),
            ).rejects.toThrow('Postmark inbound: signature mismatch.');
        });

        expect(scopes).toEqual([OWNER_ID]);
        expect(parsed).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });

    it('accepts the owner-signed first webhook after a restart', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdPlugin(registry, {
            id: PLUGIN_ID,
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: {} as never,
            members,
        });
        const { service } = settingsStub(registry, {
            owner: { inboundWebhookSecret: 'owner-secret' },
        });
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseInbound(PLUGIN_ID, body(), { authorization: basic('owner-secret') }),
        ).resolves.toMatchObject({ providerMessageId: 'pm-1' });
        expect(parsed).toHaveBeenCalledTimes(1);
        expect((parsed.mock.calls[0] as unknown[])[2]).toMatchObject({ userId: OWNER_ID });
    });

    it('rejects a forged delivery-event webhook that arrives while the first load is settling', async () => {
        const registry = createRegistry();
        const firstLoad = gate();
        const { members, events } = inboundMembers();
        registerColdPlugin(registry, {
            id: PLUGIN_ID,
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: {} as never,
            members,
            firstLoadGate: firstLoad.promise,
        });
        const { service } = settingsStub(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        const outcomes: string[] = [];
        const unhandled = await collectUnhandled(async () => {
            const legit = facade
                .parseEventWebhook(PLUGIN_ID, body(), { authorization: basic('admin') })
                .then(
                    () => outcomes.push('legit: accepted'),
                    (error: Error) => outcomes.push(`legit: rejected: ${error.message}`),
                );
            await settle();
            const forged = facade
                .parseEventWebhook(PLUGIN_ID, body(), { authorization: basic('wrong') })
                .then(
                    () => outcomes.push('forged: accepted'),
                    (error: Error) => outcomes.push(`forged: rejected: ${error.message}`),
                );
            await settle();
            firstLoad.release();
            await Promise.all([legit, forged]);
        });

        expect(outcomes).toContain('legit: accepted');
        expect(outcomes).toContain('forged: rejected: Postmark inbound: signature mismatch.');
        expect(events).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
    });

    it('answers no delivery events, without verifying anything, when the loaded plugin publishes none', async () => {
        const registry = createRegistry();
        const { members } = inboundMembers({ parseEventWebhook: undefined });
        registerColdPlugin(registry, {
            id: PLUGIN_ID,
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: {} as never,
            members,
        });
        const { service } = settingsStub(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseEventWebhook(PLUGIN_ID, body(), { authorization: basic('admin') }),
        ).resolves.toEqual([]);
    });

    it('refuses (503) — never accepts — a webhook for a plugin whose import fails', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdPlugin(registry, {
            id: PLUGIN_ID,
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: {} as never,
            members,
            failing: true,
        });
        const { service } = settingsStub(registry, {});
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseInbound(PLUGIN_ID, body(), { authorization: basic('x') }),
            ).rejects.toMatchObject({ status: 503 });
        });

        expect(parsed).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });

    it('refuses (503) a webhook for a plugin whose first load (onLoad) fails', async () => {
        const registry = createRegistry();
        const { members, parsed, events } = inboundMembers();
        registerColdPlugin(registry, {
            id: PLUGIN_ID,
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: {} as never,
            members,
            onLoadFails: true,
        });
        const { service } = settingsStub(registry, {});
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseInbound(PLUGIN_ID, body(), { authorization: basic('x') }),
        ).rejects.toMatchObject({ status: 503 });
        // The failed first load left the entry in `error`: later webhooks are
        // refused as for any plugin that is not loaded.
        await expect(
            facade.parseEventWebhook(PLUGIN_ID, body(), { authorization: basic('x') }),
        ).rejects.toThrow('Inbound email plugin not found or disabled: postmark');
        expect(parsed).not.toHaveBeenCalled();
        expect(events).not.toHaveBeenCalled();
    });

    it('awaits a verifyWebhookSignature that (against the contract) returns a Promise: a rejection still refuses the webhook', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers({
            verifyWebhookSignature: async () => {
                throw new Error('async signature mismatch');
            },
        });
        registerColdPlugin(registry, {
            id: PLUGIN_ID,
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: {} as never,
            members,
        });
        const { service } = settingsStub(registry, {});
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseInbound(PLUGIN_ID, body(), { authorization: basic('x') }),
            ).rejects.toThrow('async signature mismatch');
        });

        expect(parsed).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });
});
