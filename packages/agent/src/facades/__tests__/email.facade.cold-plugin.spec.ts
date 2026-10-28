import { createHmac } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { EmailOptions, IPlugin, JsonSchema, PluginManifest } from '@ever-works/plugin';
import { EmailFacadeService } from '../email.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type { LazyPluginStub } from '../../plugins/services/lazy-plugin-proxy';
import type { PluginRepository } from '../../plugins/repositories/plugin.repository';
import type { UserPluginRepository } from '../../plugins/repositories/user-plugin.repository';
import type { WorkPluginRepository } from '../../plugins/repositories/work-plugin.repository';
import type { TenantEmailAddressRepository } from '../../database/repositories/tenant-email-address.repository';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

// The REAL plugin classes, from SOURCE. Loaded at runtime rather than
// imported: each plugin is type-checked in its own package under its own
// compiler options, and a static import would pull it into this package's
// `tsc` program.
type PluginClass = new () => IPlugin;
const { PostmarkPlugin } = jest.requireActual<{ PostmarkPlugin: PluginClass }>(
    '../../../../plugins/postmark/src/postmark-plugin',
);
const { MailgunPlugin } = jest.requireActual<{ MailgunPlugin: PluginClass }>(
    '../../../../plugins/mailgun/src/mailgun-plugin',
);

/**
 * PLG-1 — the @Public inbound-email webhooks (`POST /email/inbound/:pluginId`,
 * `POST /email/events/:pluginId`) are authenticated ONLY by the plugin's SYNC
 * `verifyWebhookSignature` throwing on a mismatch.
 *
 * mailgun and postmark are disk-discovered, so the registry holds them as
 * LAZY PROXIES, and the proxy answers every non-manifest member with an async
 * forwarding wrapper — cold or loaded. Called through it:
 *  - a failing `verifyWebhookSignature` became a discarded rejected Promise:
 *    the forged message was parsed and handed to the agent inbound dispatcher,
 *    and the rejection went unhandled (fatal for a Node process with no
 *    `unhandledRejection` listener);
 *  - `extractInboundRecipients` answered a Promise ("not iterable"), so the
 *    recipient owner's per-user secret was never resolved;
 *  - while the plugin was still cold its `settingsSchema` read as `{}`, so the
 *    settings (and therefore the secret) resolved EMPTY — and a plugin with no
 *    secret accepts unsigned webhooks;
 *  - `parseEventWebhook` was always "present", even on a plugin without one.
 *
 * These specs use a REAL `PluginRegistryService` holding REAL lazy proxies
 * (`registerLazy`) and the REAL `PluginSettingsService` over stub repositories.
 */

const FIXTURE_ID = 'postmark';
const RECIPIENT = 'inbox@ever.works';
const OWNER_ID = 'owner-1';
const FIXTURE_ENV_SECRET = 'EW_SPEC_FIXTURE_INBOUND_SECRET';

/** The class-level schema: the package.json manifest does not carry it. */
const FIXTURE_SCHEMA = {
    type: 'object',
    properties: {
        inboundWebhookSecret: {
            type: 'string',
            'x-secret': true,
            'x-envVar': FIXTURE_ENV_SECRET,
        },
    },
} as unknown as JsonSchema;

function basic(secret: string): string {
    return `Basic ${Buffer.from(`postmark:${secret}`).toString('base64')}`;
}

function body(to = RECIPIENT): Buffer {
    return Buffer.from(JSON.stringify({ MessageID: 'pm-1', To: to, Subject: 'hi' }));
}

/**
 * A postmark-shaped inbound plugin: verification is an operator opt-in (no
 * secret at the resolved scope → accept), and a mismatch THROWS — exactly the
 * contract `IEmailInboundPlugin.verifyWebhookSignature` states. It reads the
 * secret from the resolved settings only, so a settings resolution that missed
 * the class schema (or the owner's scope) shows as an accepted forgery.
 */
function inboundMembers(overrides: Record<string, unknown> = {}) {
    const parsed = jest.fn(async () => ({
        provider: FIXTURE_ID,
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

/** A deferred promise: holds a first load inside its hook until released. */
function gate(): { promise: Promise<void>; release(): void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

/** Let every pending import and hook step run until it blocks on a gate. */
function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

interface ColdSpec {
    members: Record<string, unknown>;
    /** The import fails: the loader rejects. */
    failing?: boolean;
    /** The import succeeds but `onLoad` throws. */
    onLoadFails?: boolean;
    /** Holds the first-materialise hook, after the import, before `onLoad`. */
    firstLoadGate?: Promise<unknown>;
}

/**
 * Register a fixture inbound plugin as a lazy proxy, wired as
 * `PluginBootstrapService` wires every disk-discovered plugin: the
 * first-materialise hook runs `onLoad` (a throw records `error` on the entry,
 * as `PluginLifecycleManagerService.callOnLoad` does), and a failed import
 * records `error` too.
 */
function registerColdInbound(registry: PluginRegistryService, spec: ColdSpec): LazyPluginStub {
    const manifest = {
        id: FIXTURE_ID,
        name: 'Postmark (fixture)',
        version: '1.0.0',
        description: 'Cold inbound fixture',
        category: 'email',
        capabilities: ['email-inbound'],
    } as unknown as PluginManifest;
    const loader = async (): Promise<IPlugin | null> => {
        if (spec.failing) throw new Error('fixture: cannot import postmark');
        return {
            id: FIXTURE_ID,
            name: 'Postmark (fixture)',
            version: '1.0.0',
            category: 'email',
            capabilities: ['email-inbound'],
            settingsSchema: FIXTURE_SCHEMA,
            onLoad: async () => {
                if (spec.onLoadFails) throw new Error('fixture: postmark onLoad failed');
            },
            onUnload: async () => undefined,
            ...spec.members,
        } as unknown as IPlugin;
    };
    const registered = registry.registerLazy(manifest, loader, {
        onFirstMaterialize: async (pluginId, real) => {
            if (spec.firstLoadGate) await spec.firstLoadGate;
            try {
                await real.onLoad({} as never);
            } catch (error) {
                registry.updateState(pluginId, 'error', error as Error);
            }
        },
        onMaterializeError: async (pluginId, error) => {
            registry.updateState(pluginId, 'error', error);
        },
    });
    return registered.plugin as LazyPluginStub;
}

/** Register a REAL plugin class behind a lazy proxy (package.json manifest only). */
function registerRealLazy(registry: PluginRegistryService, plugin: IPlugin): void {
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
        {
            onFirstMaterialize: async (_pluginId, real) => {
                await real.onLoad({} as never);
            },
        },
    );
}

/**
 * The REAL settings service over stub repositories: `admin` is the platform
 * row's secrets, `owner` the owner's `user_plugins` secrets. `scopes` records
 * each resolution's scope (`admin` or the userId).
 */
function realSettings(
    registry: PluginRegistryService,
    secrets: { admin?: Record<string, unknown>; owner?: Record<string, unknown> },
) {
    const scopes: string[] = [];
    const pluginRepository = {
        findByPluginId: jest.fn(async () => {
            scopes.push('admin');
            return { settings: {}, secretSettings: { ...(secrets.admin ?? {}) } };
        }),
    } as unknown as PluginRepository;
    const userPluginRepository = {
        findByUserAndPlugin: jest.fn(async (userId: string) => {
            scopes[scopes.length - 1] = userId;
            return userId === OWNER_ID
                ? { settings: {}, secretSettings: { ...(secrets.owner ?? {}) } }
                : null;
        }),
    } as unknown as UserPluginRepository;
    const workPluginRepository = {
        findByWorkAndPlugin: jest.fn(async () => null),
    } as unknown as WorkPluginRepository;
    const service = new PluginSettingsService(
        registry,
        pluginRepository,
        userPluginRepository,
        workPluginRepository,
        new EventEmitter2(),
    );
    return { service, scopes };
}

/**
 * How a refused webhook reads: its HTTP status, the generic answer, and the
 * plugin's own reason (kept as the `cause`, never answered).
 */
function refusal(error: unknown): string {
    const refused = error as { status?: number; message?: string; cause?: unknown };
    const reason = refused.cause instanceof Error ? ` (${refused.cause.message})` : '';
    return `${refused.status ?? 'no status'} ${refused.message}${reason}`;
}

/** A failed signature check: 401, a generic answer, the plugin's `reason` as cause. */
function signatureRefused(reason: string) {
    return {
        status: 401,
        message: 'Invalid webhook signature',
        cause: expect.objectContaining({ message: reason }),
    };
}

function addressesStub(pluginId = FIXTURE_ID): TenantEmailAddressRepository {
    return {
        findByAddress: jest.fn(async (address: string) =>
            address === RECIPIENT ? { userId: OWNER_ID, pluginId } : null,
        ),
    } as unknown as TenantEmailAddressRepository;
}

function createRegistry(): PluginRegistryService {
    return new PluginRegistryService(new EventEmitter2());
}

function facadeFor(
    registry: PluginRegistryService,
    settings: PluginSettingsService,
    addresses: TenantEmailAddressRepository = addressesStub(),
) {
    return new EmailFacadeService(registry, settings, undefined, addresses);
}

/**
 * Every unhandled rejection raised while `run` executes (and a few macrotask
 * turns after it, so Node has had the chance to report one).
 *
 * The listener goes on the REAL `process`: under Jest the test's `process`
 * global is a sandbox copy that never hears `unhandledRejection`.
 * `runInThisContext` evaluates outside the sandbox.
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

describe('EmailFacadeService — inbound webhooks over a lazy email plugin (PLG-1)', () => {
    const ENV_KEYS = [FIXTURE_ENV_SECRET, 'POSTMARK_INBOUND_SECRET', 'MAILGUN_WEBHOOK_SIGNING_KEY'];
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    it('rejects a forged webhook on the FIRST call after a restart (cold plugin, platform secret)', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('forged') }),
            ).rejects.toMatchObject(signatureRefused('Postmark inbound: signature mismatch.'));
        });

        expect(parsed).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });

    it('rejects a forged webhook once the plugin is loaded (a warm proxy still wraps every method)', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        const proxy = registerColdInbound(registry, { members });
        await proxy.__materialize();
        const { service } = realSettings(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('forged') }),
            ).rejects.toMatchObject(signatureRefused('Postmark inbound: signature mismatch.'));
        });

        expect(parsed).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });

    it('accepts a correctly signed webhook on a cold plugin', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('admin') }),
        ).resolves.toMatchObject({ providerMessageId: 'pm-1' });
        expect(parsed).toHaveBeenCalledTimes(1);
    });

    it('resolves an env-bound secret from the CLASS schema on a cold plugin and rejects a forgery', async () => {
        process.env[FIXTURE_ENV_SECRET] = 'env-secret';
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, {});
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('forged') }),
        ).rejects.toMatchObject(signatureRefused('Postmark inbound: signature mismatch.'));
        expect(parsed).not.toHaveBeenCalled();
    });

    it("resolves the owner's per-user secret on the FIRST webhook after a restart and rejects a bad signature", async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdInbound(registry, { members });
        // Per-user secret only: no platform or env secret.
        const { service, scopes } = realSettings(registry, {
            owner: { inboundWebhookSecret: 'owner-secret' },
        });
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('forged') }),
            ).rejects.toMatchObject(signatureRefused('Postmark inbound: signature mismatch.'));
        });

        expect(scopes).toEqual([OWNER_ID]);
        expect(parsed).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });

    it('accepts the owner-signed first webhook after a restart, parsed at the owner scope', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, {
            owner: { inboundWebhookSecret: 'owner-secret' },
        });
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('owner-secret') }),
        ).resolves.toMatchObject({ providerMessageId: 'pm-1' });
        expect(parsed).toHaveBeenCalledTimes(1);
        expect((parsed.mock.calls[0] as unknown[])[2]).toMatchObject({ userId: OWNER_ID });
    });

    it('rejects a forged webhook that arrives while another request is settling the first load', async () => {
        const registry = createRegistry();
        const firstLoad = gate();
        const { members, parsed } = inboundMembers();
        registerColdInbound(registry, { members, firstLoadGate: firstLoad.promise });
        const { service } = realSettings(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        const outcomes: string[] = [];
        const unhandled = await collectUnhandled(async () => {
            // Request A starts the first load and is held inside its hook.
            const legit = facade
                .parseInbound(FIXTURE_ID, body(), { authorization: basic('admin') })
                .then(
                    () => outcomes.push('legit: accepted'),
                    (error: unknown) => outcomes.push(`legit: rejected: ${refusal(error)}`),
                );
            await settle();
            // Request B arrives once the module is imported but the first load
            // has not settled — with a bad signature.
            const forged = facade
                .parseInbound(FIXTURE_ID, body(), { authorization: basic('wrong') })
                .then(
                    () => outcomes.push('forged: accepted'),
                    (error: unknown) => outcomes.push(`forged: rejected: ${refusal(error)}`),
                );
            await settle();
            firstLoad.release();
            await Promise.all([legit, forged]);
        });

        expect(outcomes).toContain('legit: accepted');
        expect(outcomes).toContain(
            'forged: rejected: 401 Invalid webhook signature (Postmark inbound: signature mismatch.)',
        );
        expect(parsed).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
    });

    it('rejects a forged delivery-event webhook and accepts a signed one', async () => {
        const registry = createRegistry();
        const { members, events } = inboundMembers();
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseEventWebhook(FIXTURE_ID, body(), { authorization: basic('wrong') }),
            ).rejects.toMatchObject(signatureRefused('Postmark inbound: signature mismatch.'));
            await expect(
                facade.parseEventWebhook(FIXTURE_ID, body(), { authorization: basic('admin') }),
            ).resolves.toHaveLength(1);
        });

        expect(events).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
    });

    it('answers no delivery events when the loaded plugin publishes none', async () => {
        const registry = createRegistry();
        const { members } = inboundMembers({ parseEventWebhook: undefined });
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, { admin: { inboundWebhookSecret: 'admin' } });
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseEventWebhook(FIXTURE_ID, body(), { authorization: basic('admin') }),
        ).resolves.toEqual([]);
    });

    it('refuses (503) — never accepts — a webhook for a plugin whose import fails', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers();
        registerColdInbound(registry, { members, failing: true });
        const { service } = realSettings(registry, {});
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('x') }),
            ).rejects.toMatchObject({ status: 503 });
        });

        expect(parsed).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });

    it('refuses (503) a webhook for a plugin whose first load (onLoad) fails', async () => {
        const registry = createRegistry();
        const { members, parsed, events } = inboundMembers();
        registerColdInbound(registry, { members, onLoadFails: true });
        const { service } = realSettings(registry, {});
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('x') }),
        ).rejects.toMatchObject({ status: 503 });
        // The failed first load left the entry in `error`: later webhooks are
        // refused as for any plugin that is not loaded.
        await expect(
            facade.parseEventWebhook(FIXTURE_ID, body(), { authorization: basic('x') }),
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
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, {});
        const facade = facadeFor(registry, service);

        const unhandled = await collectUnhandled(async () => {
            await expect(
                facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('x') }),
            ).rejects.toMatchObject(signatureRefused('async signature mismatch'));
        });

        expect(parsed).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
    });

    it('refuses a webhook for a loaded plugin that has no verifyWebhookSignature', async () => {
        const registry = createRegistry();
        const { members, parsed } = inboundMembers({ verifyWebhookSignature: undefined });
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, {});
        const facade = facadeFor(registry, service);

        await expect(
            facade.parseInbound(FIXTURE_ID, body(), { authorization: basic('x') }),
        ).rejects.toThrow('cannot verify webhook signatures');
        expect(parsed).not.toHaveBeenCalled();
    });

    describe('the real Postmark and Mailgun classes behind lazy proxies', () => {
        function postmarkWebhook(secret: string) {
            return {
                rawBody: Buffer.from(
                    JSON.stringify({
                        MessageID: 'pm-in-1',
                        From: 'sender@example.com',
                        ToFull: [{ Email: RECIPIENT }],
                        Subject: 'hello',
                        TextBody: 'body',
                        Date: '2026-09-26T10:00:00Z',
                    }),
                ),
                headers: { authorization: basic(secret) } as Record<string, string>,
            };
        }

        function mailgunWebhook(signingKey: string) {
            // F56 (896973282): Mailgun signatures are accepted only while fresh, so the
            // signing time is now, not a fixed instant that ages out of the window.
            const timestamp = String(Math.floor(Date.now() / 1000));
            const token = 'token-1';
            const signature = createHmac('sha256', signingKey)
                .update(`${timestamp}${token}`)
                .digest('hex');
            return {
                rawBody: Buffer.from(
                    new URLSearchParams({
                        sender: 'sender@example.com',
                        recipient: RECIPIENT,
                        subject: 'hello',
                        'body-plain': 'body',
                        'Message-Id': '<mg-in-1@example.com>',
                        timestamp,
                        token,
                        signature,
                    }).toString(),
                ),
                headers: {} as Record<string, string>,
            };
        }

        function realWorld(pluginId: 'postmark' | 'mailgun', admin: Record<string, unknown>) {
            const registry = createRegistry();
            registerRealLazy(registry, new PostmarkPlugin());
            registerRealLazy(registry, new MailgunPlugin());
            const { service } = realSettings(registry, { admin });
            return facadeFor(registry, service, addressesStub(pluginId));
        }

        it('postmark: rejects a forged first webhook and accepts a signed one', async () => {
            const facade = realWorld('postmark', { inboundWebhookSecret: 'pm-admin' });

            const unhandled = await collectUnhandled(async () => {
                const forged = postmarkWebhook('pm-forged');
                await expect(
                    facade.parseInbound('postmark', forged.rawBody, forged.headers),
                ).rejects.toMatchObject(signatureRefused('Postmark inbound: signature mismatch.'));
                const legit = postmarkWebhook('pm-admin');
                await expect(
                    facade.parseInbound('postmark', legit.rawBody, legit.headers),
                ).resolves.toMatchObject({ providerMessageId: 'pm-in-1', to: [RECIPIENT] });
            });

            expect(unhandled).toEqual([]);
        });

        it('mailgun: rejects a forged first webhook and accepts a signed one', async () => {
            const facade = realWorld('mailgun', { webhookSigningKey: 'mg-admin' });

            const unhandled = await collectUnhandled(async () => {
                const forged = mailgunWebhook('mg-forged');
                await expect(
                    facade.parseInbound('mailgun', forged.rawBody, forged.headers),
                ).rejects.toMatchObject(signatureRefused('Mailgun inbound: signature mismatch.'));
                const legit = mailgunWebhook('mg-admin');
                await expect(
                    facade.parseInbound('mailgun', legit.rawBody, legit.headers),
                ).resolves.toMatchObject({ providerMessageId: 'mg-in-1@example.com' });
            });

            expect(unhandled).toEqual([]);
        });

        /**
         * EW-P4-3 — with NO secret at any scope (no owner secret, no admin
         * secret, no env var) the shipped plugins used to ACCEPT the webhook
         * (Postmark with a warning, Mailgun silently), so anyone who knew the
         * public URL could inject mail. They now refuse it (401), unless the
         * operator sets the explicit opt-out `EMAIL_INBOUND_ALLOW_UNSIGNED=true`.
         */
        describe('with no secret configured at any scope (EW-P4-3)', () => {
            const ENV_KEYS = [
                'POSTMARK_INBOUND_SECRET',
                'MAILGUN_WEBHOOK_SIGNING_KEY',
                'EMAIL_INBOUND_ALLOW_UNSIGNED',
            ] as const;
            const saved: Record<string, string | undefined> = {};

            beforeEach(() => {
                for (const key of ENV_KEYS) {
                    saved[key] = process.env[key];
                    delete process.env[key];
                }
            });

            afterEach(() => {
                for (const key of ENV_KEYS) {
                    if (saved[key] === undefined) delete process.env[key];
                    else process.env[key] = saved[key];
                }
            });

            it('postmark: refuses an unsigned webhook (401) and never parses it', async () => {
                const facade = realWorld('postmark', {});
                const { rawBody } = postmarkWebhook('anything');

                const unhandled = await collectUnhandled(async () => {
                    await expect(
                        facade.parseInbound('postmark', rawBody, {}),
                    ).rejects.toMatchObject({
                        status: 401,
                        message: 'Invalid webhook signature',
                    });
                    // A guessed Basic credential is no better: there is nothing to check it against.
                    await expect(
                        facade.parseInbound('postmark', rawBody, { authorization: basic('guess') }),
                    ).rejects.toMatchObject({ status: 401 });
                });

                expect(unhandled).toEqual([]);
            });

            it('mailgun: refuses an unsigned webhook (401) and never parses it', async () => {
                const facade = realWorld('mailgun', {});
                const unsigned = Buffer.from(
                    new URLSearchParams({
                        sender: 'sender@example.com',
                        recipient: RECIPIENT,
                        subject: 'hello',
                        'body-plain': 'body',
                    }).toString(),
                );

                const unhandled = await collectUnhandled(async () => {
                    await expect(
                        facade.parseInbound('mailgun', unsigned, {}),
                    ).rejects.toMatchObject({
                        status: 401,
                        message: 'Invalid webhook signature',
                    });
                    // A self-made signature is refused too: no key to check it with.
                    const selfSigned = mailgunWebhook('attacker-key');
                    await expect(
                        facade.parseInbound('mailgun', selfSigned.rawBody, selfSigned.headers),
                    ).rejects.toMatchObject({ status: 401 });
                });

                expect(unhandled).toEqual([]);
            });

            it('postmark: the delivery-event webhook is refused the same way', async () => {
                const facade = realWorld('postmark', {});
                const event = Buffer.from(
                    JSON.stringify({
                        RecordType: 'Delivery',
                        MessageID: 'pm-1',
                        Recipient: 'x@y.test',
                    }),
                );
                await expect(facade.parseEventWebhook('postmark', event, {})).rejects.toMatchObject(
                    {
                        status: 401,
                    },
                );
            });

            it("accepts a webhook signed with the address owner's own secret", async () => {
                const registry = createRegistry();
                registerRealLazy(registry, new PostmarkPlugin());
                const { service } = realSettings(registry, {
                    owner: { inboundWebhookSecret: 'pm-owner' },
                });
                const facade = facadeFor(registry, service, addressesStub('postmark'));

                // Only the owner has a secret (no admin, no env), so a
                // success proves the webhook was verified at the owner scope.
                const legit = postmarkWebhook('pm-owner');
                await expect(
                    facade.parseInbound('postmark', legit.rawBody, legit.headers),
                ).resolves.toMatchObject({ providerMessageId: 'pm-in-1' });
                const forged = postmarkWebhook('pm-forged');
                await expect(
                    facade.parseInbound('postmark', forged.rawBody, forged.headers),
                ).rejects.toMatchObject({ status: 401 });
            });

            it('accepts unsigned only under the explicit opt-out EMAIL_INBOUND_ALLOW_UNSIGNED=true', async () => {
                process.env.EMAIL_INBOUND_ALLOW_UNSIGNED = 'true';
                const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
                try {
                    const facade = realWorld('postmark', {});
                    const { rawBody } = postmarkWebhook('anything');
                    await expect(
                        facade.parseInbound('postmark', rawBody, {}),
                    ).resolves.toMatchObject({
                        providerMessageId: 'pm-in-1',
                    });
                    expect(warn).toHaveBeenCalledWith(
                        expect.stringMatching(/WITHOUT signature verification/),
                    );
                } finally {
                    warn.mockRestore();
                }
            });
        });
    });
});

/**
 * Ever Email Router — the REAL plugin behind a REAL lazy proxy. Its webhook
 * is answered with counts only because the facade reads `inboundAck` from the
 * LOADED instance: a cold proxy answers a forwarding function for that name.
 * An unknown recipient (no address bound) is verified with the deployment's
 * secret — the `x-adminOnly` setting's env var, from the CLASS schema.
 */
describe('EmailFacadeService — Ever Email Router over a lazy proxy', () => {
    const { EverEmailRouterPlugin } = jest.requireActual<{ EverEmailRouterPlugin: PluginClass }>(
        '../../../../plugins/ever-email-router/src/ever-email-router-plugin',
    );
    const ROUTER_ID = 'ever-email-router';
    const SECRET = 'router-secret-0123456789-abcdef';
    const saved = process.env.EVER_EMAIL_ROUTER_SECRET;

    afterEach(() => {
        if (saved === undefined) delete process.env.EVER_EMAIL_ROUTER_SECRET;
        else process.env.EVER_EMAIL_ROUTER_SECRET = saved;
    });

    function routerWebhook(secret: string, to = 'nobody@ever.email') {
        const rawBody = Buffer.from(
            JSON.stringify({
                raw: Buffer.from(
                    'From: ada@example.com\r\nTo: x@ever.email\r\nSubject: hi\r\nMessage-ID: <r-1@example.com>\r\n\r\nhello\r\n',
                ).toString('base64'),
                envelope: { from: 'ada@example.com', to: [to] },
            }),
        );
        const t = Math.floor(Date.now() / 1000);
        const v1 = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
        return { rawBody, headers: { 'x-ever-email-signature': `t=${t},v1=${v1}` } };
    }

    function world() {
        const registry = createRegistry();
        registerRealLazy(registry, new EverEmailRouterPlugin());
        registerRealLazy(registry, new PostmarkPlugin());
        const { service, scopes } = realSettings(registry, {});
        const addresses = {
            findByAddress: jest.fn(async () => null),
        } as unknown as TenantEmailAddressRepository;
        return { registry, scopes, facade: facadeFor(registry, service, addresses) };
    }

    it('answers inboundAck "counts" from the loaded instance on the first (cold) webhook', async () => {
        process.env.EVER_EMAIL_ROUTER_SECRET = SECRET;
        const { registry, facade } = world();
        const cold = registry
            .getByCapability('email-inbound')
            .find((entry) => entry.plugin.id === ROUTER_ID)!.plugin as unknown as Record<
            string,
            unknown
        >;
        // What a read through the cold proxy would see — never 'counts'.
        expect(typeof cold.inboundAck).toBe('function');

        const legit = routerWebhook(SECRET);
        await expect(
            facade.parseInbound(ROUTER_ID, legit.rawBody, legit.headers),
        ).resolves.toMatchObject({ inboundAck: 'counts', authenticatedRecipient: null });
    });

    it('verifies an unknown recipient with EVER_EMAIL_ROUTER_SECRET at admin scope, and refuses a forgery (401)', async () => {
        process.env.EVER_EMAIL_ROUTER_SECRET = SECRET;
        const { scopes, facade } = world();

        const forged = routerWebhook('forged-secret-0123456789-abcdef');
        await expect(
            facade.parseInbound(ROUTER_ID, forged.rawBody, forged.headers),
        ).rejects.toMatchObject(signatureRefused('Ever Email Router inbound: signature mismatch.'));
        const legit = routerWebhook(SECRET);
        await expect(
            facade.parseInbound(ROUTER_ID, legit.rawBody, legit.headers),
        ).resolves.toMatchObject({ provider: ROUTER_ID, to: ['x@ever.email'] });
        expect(scopes.every((scope) => scope === 'admin')).toBe(true);
    });

    it('refuses every webhook when the deployment has no secret (fail closed)', async () => {
        delete process.env.EVER_EMAIL_ROUTER_SECRET;
        const { facade } = world();
        const signed = routerWebhook(SECRET);
        await expect(
            facade.parseInbound(ROUTER_ID, signed.rawBody, signed.headers),
        ).rejects.toMatchObject({ status: 401 });
    });

    it('keeps "received" for a plugin that did not opt in (postmark)', async () => {
        process.env.POSTMARK_INBOUND_SECRET = 'pm-env';
        try {
            const { facade } = world();
            const rawBody = Buffer.from(
                JSON.stringify({
                    MessageID: 'pm-1',
                    To: 'x@y.test',
                    Subject: 'hi',
                    Date: '2026-10-27T00:00:00Z',
                }),
            );
            await expect(
                facade.parseInbound('postmark', rawBody, { authorization: basic('pm-env') }),
            ).resolves.toMatchObject({ inboundAck: 'received' });
        } finally {
            delete process.env.POSTMARK_INBOUND_SECRET;
        }
    });
});

/**
 * `EmailFacadeService.inboundAddressPolicy` — the address rules the API
 * enforces on registration, read from the plugin's LOADED instance (the
 * router's policy is a getter over `EVER_EMAIL_DOMAIN`; a cold proxy answers a
 * forwarding function for it). A registered inbound plugin that cannot load
 * refuses (503) rather than letting its rules be skipped.
 */
describe('EmailFacadeService.inboundAddressPolicy', () => {
    const { EverEmailRouterPlugin } = jest.requireActual<{ EverEmailRouterPlugin: PluginClass }>(
        '../../../../plugins/ever-email-router/src/ever-email-router-plugin',
    );
    const savedDomain = process.env.EVER_EMAIL_DOMAIN;

    afterEach(() => {
        if (savedDomain === undefined) delete process.env.EVER_EMAIL_DOMAIN;
        else process.env.EVER_EMAIL_DOMAIN = savedDomain;
    });

    function world() {
        const registry = createRegistry();
        registerRealLazy(registry, new EverEmailRouterPlugin());
        registerRealLazy(registry, new PostmarkPlugin());
        const { service } = realSettings(registry, {});
        return { registry, facade: facadeFor(registry, service) };
    }

    it("answers the router's policy from the loaded instance on a cold proxy, following EVER_EMAIL_DOMAIN", async () => {
        delete process.env.EVER_EMAIL_DOMAIN;
        const { registry, facade } = world();
        const cold = registry
            .getByCapability('email-inbound')
            .find((entry) => entry.plugin.id === 'ever-email-router')!.plugin as unknown as Record<
            string,
            unknown
        >;
        // What a read through the cold proxy would see — never the policy.
        expect(typeof cold.inboundAddressPolicy).toBe('function');

        await expect(facade.inboundAddressPolicy('ever-email-router')).resolves.toEqual({
            domain: 'ever.email',
            exclusive: true,
        });
        process.env.EVER_EMAIL_DOMAIN = 'Mail.Example.org';
        await expect(facade.inboundAddressPolicy('ever-email-router')).resolves.toEqual({
            domain: 'mail.example.org',
            exclusive: true,
        });
    });

    it('answers null for a plugin without a policy, and for an id that is no registered inbound plugin', async () => {
        const { facade } = world();
        await expect(facade.inboundAddressPolicy('postmark')).resolves.toBeNull();
        await expect(facade.inboundAddressPolicy('resend')).resolves.toBeNull();
        await expect(facade.inboundAddressPolicy('no-such-plugin')).resolves.toBeNull();
    });

    it.each([
        ['its import fails', { failing: true }],
        ['its first load (onLoad) fails', { onLoadFails: true }],
    ])('refuses (503) — never skips the rules — when %s', async (_case, failure) => {
        const registry = createRegistry();
        const { members } = inboundMembers({
            inboundAddressPolicy: { domain: 'ever.email', exclusive: true },
        });
        registerColdInbound(registry, { members, ...failure });
        const { service } = realSettings(registry, {});
        const facade = facadeFor(registry, service);

        await expect(facade.inboundAddressPolicy(FIXTURE_ID)).rejects.toMatchObject({
            status: 503,
        });
    });

    it('refuses (503) a policy that names no domain, and normalizes a valid one', async () => {
        const registry = createRegistry();
        const { members } = inboundMembers({
            inboundAddressPolicy: { domain: '  ', exclusive: true },
        });
        registerColdInbound(registry, { members });
        const { service } = realSettings(registry, {});
        await expect(
            facadeFor(registry, service).inboundAddressPolicy(FIXTURE_ID),
        ).rejects.toMatchObject({ status: 503 });

        const other = createRegistry();
        const valid = inboundMembers({
            inboundAddressPolicy: { domain: ' Ever.Email ', exclusive: 1 },
        });
        registerColdInbound(other, { members: valid.members });
        const settings = realSettings(other, {});
        await expect(
            facadeFor(other, settings.service).inboundAddressPolicy(FIXTURE_ID),
        ).resolves.toEqual({ domain: 'ever.email', exclusive: false });
    });
});
