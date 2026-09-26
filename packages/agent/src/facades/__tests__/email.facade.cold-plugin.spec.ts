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
            const timestamp = '1790000000';
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
    });
});
