// EW-719 (open-redirect): pin the platform web-app host + the extra
// allow-listed callback host BEFORE the service is constructed, since
// `parseAllowedCallbackHosts()` reads them in the constructor. `app.ever.works`
// is the host the existing "forwards callbackUrl" test uses as a legit
// platform-origin callback, so it must be allow-listed.
const ORIGINAL_ENV = { ...process.env };
beforeAll(() => {
    process.env.WEB_URL = 'https://app.ever.works';
});
afterAll(() => {
    process.env = ORIGINAL_ENV;
});

import { Test, TestingModule } from '@nestjs/testing';
import {
    BadGatewayException,
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';

// Short-circuit the heavy agent/plugins barrel chain — the only symbol we
// need from it is the `PluginSettingsService` class token, and we provide
// the value via NestJS DI rather than calling its methods directly.
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class PluginSettingsService {},
}));

jest.mock('@composio/core', () => ({
    Composio: jest.fn().mockImplementation(() => ({
        toolkits: { get: jest.fn() },
        connectedAccounts: { list: jest.fn(), initiate: jest.fn() },
        triggers: { create: jest.fn(), delete: jest.fn(), verifyWebhook: jest.fn() },
    })),
}));

import { PluginSettingsService } from '@ever-works/agent/plugins';
import { ComposioService, type ComposioSdkLike } from './composio.service';

function buildSdkStub(): ComposioSdkLike {
    return {
        toolkits: { get: jest.fn() },
        connectedAccounts: { list: jest.fn(), initiate: jest.fn() },
        triggers: { create: jest.fn(), delete: jest.fn(), verifyWebhook: jest.fn() },
    } as unknown as ComposioSdkLike;
}

function buildResolvedSettings(overrides: Record<string, unknown> = {}): {
    settings: Record<string, unknown>;
} {
    return { settings: { apiKey: 'test-key', ...overrides } };
}

function sdkError(status: number, message: string): Error {
    const err = new Error(message);
    (err as { status?: number }).status = status;
    return err;
}

/**
 * Replaces the private `getSdk` for direct SDK control in tests. Bypasses the
 * `@composio/core` constructor (mocked above) and the settings-resolution path,
 * letting each test isolate the SDK-call assertions.
 */
function injectSdk(service: ComposioService, sdk: ComposioSdkLike): void {
    (service as unknown as { getSdk: jest.Mock }).getSdk = jest.fn().mockResolvedValue(sdk);
}

describe('ComposioService', () => {
    let service: ComposioService;
    let settingsService: { getResolvedSettings: jest.Mock };

    beforeEach(async () => {
        settingsService = { getResolvedSettings: jest.fn() };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ComposioService,
                { provide: PluginSettingsService, useValue: settingsService },
            ],
        }).compile();
        service = module.get(ComposioService);
    });

    describe('listToolkits — settings gating', () => {
        it('throws BadRequestException when the plugin is not configured', async () => {
            settingsService.getResolvedSettings.mockResolvedValue(null);
            await expect(service.listToolkits('user-1')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('throws when the API key is missing from settings', async () => {
            settingsService.getResolvedSettings.mockResolvedValue({ settings: {} });
            await expect(service.listToolkits('user-1')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });

    describe('listToolkits', () => {
        it('passes the requested limit through to the SDK', async () => {
            const sdk = buildSdkStub();
            (sdk.toolkits.get as jest.Mock).mockResolvedValue({
                items: [{ slug: 'GMAIL', name: 'Gmail' }],
            });
            injectSdk(service, sdk);

            const items = await service.listToolkits('user-1', 50);
            expect(items).toEqual([{ slug: 'GMAIL', name: 'Gmail' }]);
            expect(sdk.toolkits.get).toHaveBeenCalledWith({ limit: 50 });
        });

        it('clamps the limit into [1, 200]', async () => {
            const sdk = buildSdkStub();
            (sdk.toolkits.get as jest.Mock).mockResolvedValue({ items: [] });
            injectSdk(service, sdk);

            await service.listToolkits('user-1', 99999);
            expect(sdk.toolkits.get).toHaveBeenLastCalledWith({ limit: 200 });
            await service.listToolkits('user-1', 0);
            expect(sdk.toolkits.get).toHaveBeenLastCalledWith({ limit: 1 });
        });

        it('translates 401 into UnauthorizedException', async () => {
            const sdk = buildSdkStub();
            (sdk.toolkits.get as jest.Mock).mockRejectedValue(sdkError(401, 'no'));
            injectSdk(service, sdk);

            await expect(service.listToolkits('user-1')).rejects.toBeInstanceOf(
                UnauthorizedException,
            );
        });
    });

    describe('listConnectedAccounts', () => {
        it('hard-pins the user_id filter to the JWT user (no override)', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.list as jest.Mock).mockResolvedValue({ items: [] });
            injectSdk(service, sdk);

            await service.listConnectedAccounts('user-1');
            expect(sdk.connectedAccounts.list).toHaveBeenCalledWith({ userIds: ['user-1'] });
        });

        it('passes toolkit filter as an uppercase array', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.list as jest.Mock).mockResolvedValue({ items: [] });
            injectSdk(service, sdk);

            await service.listConnectedAccounts('user-1', { toolkitSlug: 'gmail' });
            expect(sdk.connectedAccounts.list).toHaveBeenCalledWith({
                userIds: ['user-1'],
                toolkitSlugs: ['GMAIL'],
            });
        });

        it('maps SDK records into DTOs with camelCase + raw user_id fallback', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.list as jest.Mock).mockResolvedValue({
                items: [
                    { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'GMAIL' }, userId: 'alice' },
                    { id: 'ca_2', status: 'INITIATED', toolkit: { slug: 'GMAIL' }, user_id: 'bob' },
                ],
            });
            injectSdk(service, sdk);

            const result = await service.listConnectedAccounts('user-1');
            expect(result).toEqual([
                { id: 'ca_1', status: 'ACTIVE', toolkitSlug: 'GMAIL', userId: 'alice' },
                { id: 'ca_2', status: 'INITIATED', toolkitSlug: 'GMAIL', userId: 'bob' },
            ]);
        });
    });

    describe('initiateConnection', () => {
        it('throws when toolkitSlug is missing', async () => {
            await expect(
                service.initiateConnection('user-1', {
                    toolkitSlug: '',
                    authConfigId: 'ac_xyz',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('throws when authConfigId is missing', async () => {
            await expect(
                service.initiateConnection('user-1', {
                    toolkitSlug: 'GMAIL',
                    authConfigId: '',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('returns the SDK redirect URL + connectedAccountId on success', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockResolvedValue({
                id: 'ca_new',
                connectionRequest: { redirectUrl: 'https://composio.example/oauth/gmail?token=x' },
            });
            injectSdk(service, sdk);

            const result = await service.initiateConnection('user-1', {
                toolkitSlug: 'GMAIL',
                authConfigId: 'ac_xyz',
            });
            expect(result).toEqual({
                redirectUrl: 'https://composio.example/oauth/gmail?token=x',
                connectedAccountId: 'ca_new',
            });
            expect(sdk.connectedAccounts.initiate).toHaveBeenCalledWith('user-1', 'ac_xyz', {});
        });

        it('falls back to top-level redirectUrl when connectionRequest is missing', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockResolvedValue({
                redirectUrl: 'https://composio.example/oauth/raw',
            });
            injectSdk(service, sdk);

            const result = await service.initiateConnection('user-1', {
                toolkitSlug: 'GMAIL',
                authConfigId: 'ac_xyz',
            });
            expect(result.redirectUrl).toBe('https://composio.example/oauth/raw');
            expect(result.connectedAccountId).toBeUndefined();
        });

        it('forwards callbackUrl to the SDK and always pins user_id to JWT user', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockResolvedValue({
                redirectUrl: 'https://composio.example/oauth',
            });
            injectSdk(service, sdk);

            await service.initiateConnection('user-1', {
                toolkitSlug: 'GMAIL',
                authConfigId: 'ac_xyz',
                callbackUrl: 'https://app.ever.works/settings/plugins/composio/callback',
            });
            expect(sdk.connectedAccounts.initiate).toHaveBeenCalledWith('user-1', 'ac_xyz', {
                callbackUrl: 'https://app.ever.works/settings/plugins/composio/callback',
            });
        });

        // EW-719 (open-redirect): a callbackUrl on a non-allow-listed host must
        // NOT reach the SDK — Composio would otherwise redirect the victim's
        // browser to the attacker origin after the OAuth dance.
        it('drops a callbackUrl on a non-allow-listed (attacker) host', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockResolvedValue({
                redirectUrl: 'https://composio.example/oauth',
            });
            injectSdk(service, sdk);

            await service.initiateConnection('user-1', {
                toolkitSlug: 'GMAIL',
                authConfigId: 'ac_xyz',
                callbackUrl: 'https://attacker.example/steal',
            });
            // Falls back to omitting callbackUrl (SDK uses platform default) —
            // the attacker host is never forwarded.
            expect(sdk.connectedAccounts.initiate).toHaveBeenCalledWith('user-1', 'ac_xyz', {});
        });

        // EW-719: fail CLOSED on a non-http(s) scheme even if a host string is
        // present (e.g. a smuggled javascript:/data: URL).
        it('drops a callbackUrl with a non-http(s) scheme', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockResolvedValue({
                redirectUrl: 'https://composio.example/oauth',
            });
            injectSdk(service, sdk);

            await service.initiateConnection('user-1', {
                toolkitSlug: 'GMAIL',
                authConfigId: 'ac_xyz',
                callbackUrl: 'javascript:alert(1)//app.ever.works',
            });
            expect(sdk.connectedAccounts.initiate).toHaveBeenCalledWith('user-1', 'ac_xyz', {});
        });

        // EW-719: the legit happy path — a callbackUrl on the platform web-app
        // origin (config.webAppUrl() host) is allow-listed and forwarded.
        it('forwards a callbackUrl on the platform web-app origin', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockResolvedValue({
                redirectUrl: 'https://composio.example/oauth',
            });
            injectSdk(service, sdk);

            await service.initiateConnection('user-1', {
                toolkitSlug: 'GMAIL',
                authConfigId: 'ac_xyz',
                callbackUrl: 'https://app.ever.works/settings/plugins/composio/callback?foo=bar',
            });
            expect(sdk.connectedAccounts.initiate).toHaveBeenCalledWith('user-1', 'ac_xyz', {
                callbackUrl: 'https://app.ever.works/settings/plugins/composio/callback?foo=bar',
            });
        });

        it('translates 5xx errors into BadGatewayException', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockRejectedValue(
                sdkError(503, 'upstream down'),
            );
            injectSdk(service, sdk);

            await expect(
                service.initiateConnection('user-1', {
                    toolkitSlug: 'GMAIL',
                    authConfigId: 'ac_xyz',
                }),
            ).rejects.toBeInstanceOf(BadGatewayException);
        });

        it('translates 404 errors into NotFoundException', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockRejectedValue(
                sdkError(404, 'no toolkit'),
            );
            injectSdk(service, sdk);

            await expect(
                service.initiateConnection('user-1', {
                    toolkitSlug: 'GMAIL',
                    authConfigId: 'ac_xyz',
                }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('throws when the SDK does not return a redirect URL', async () => {
            const sdk = buildSdkStub();
            (sdk.connectedAccounts.initiate as jest.Mock).mockResolvedValue({});
            injectSdk(service, sdk);

            await expect(
                service.initiateConnection('user-1', {
                    toolkitSlug: 'GMAIL',
                    authConfigId: 'ac_xyz',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('triggers — upstream enable + webhook verification', () => {
        it('createTrigger calls the SDK and returns the tg_* id', async () => {
            const sdk = buildSdkStub();
            (sdk.triggers.create as jest.Mock).mockResolvedValue({ triggerId: 'tg_real_1' });
            injectSdk(service, sdk);

            const result = await service.createTrigger('user-1', {
                triggerSlug: 'GMAIL_NEW_EMAIL',
                connectedAccountId: 'ca_1',
                config: { labelIds: ['INBOX'] },
            });

            expect(result).toEqual({ triggerId: 'tg_real_1' });
            expect(sdk.triggers.create).toHaveBeenCalledWith('user-1', 'GMAIL_NEW_EMAIL', {
                triggerConfig: { labelIds: ['INBOX'] },
                connectedAccountId: 'ca_1',
            });
        });

        it('createTrigger throws when the SDK returns no trigger id', async () => {
            const sdk = buildSdkStub();
            (sdk.triggers.create as jest.Mock).mockResolvedValue({});
            injectSdk(service, sdk);
            await expect(
                service.createTrigger('user-1', { triggerSlug: 'X' }),
            ).rejects.toBeInstanceOf(Error);
        });

        it('deleteTrigger returns true on success, false (swallowed) on failure', async () => {
            const sdk = buildSdkStub();
            (sdk.triggers.delete as jest.Mock).mockResolvedValue({ triggerId: 'tg_1' });
            injectSdk(service, sdk);
            await expect(service.deleteTrigger('user-1', 'tg_1')).resolves.toBe(true);

            (sdk.triggers.delete as jest.Mock).mockRejectedValue(new Error('already gone'));
            await expect(service.deleteTrigger('user-1', 'tg_1')).resolves.toBe(false);
        });

        it('verifyWebhook fails closed when no webhook secret is configured', async () => {
            settingsService.getResolvedSettings.mockResolvedValue(buildResolvedSettings());
            const prevEnv = process.env.COMPOSIO_WEBHOOK_SECRET;
            delete process.env.COMPOSIO_WEBHOOK_SECRET;
            try {
                await expect(
                    service.verifyWebhook('user-1', {
                        id: 'wh_1',
                        rawBody: '{}',
                        signature: 'v1,sig',
                        timestamp: '123',
                    }),
                ).rejects.toBeInstanceOf(UnauthorizedException);
            } finally {
                if (prevEnv !== undefined) process.env.COMPOSIO_WEBHOOK_SECRET = prevEnv;
            }
        });

        it('verifyWebhook delegates to the SDK with the resolved project secret', async () => {
            settingsService.getResolvedSettings.mockResolvedValue(
                buildResolvedSettings({ webhookSecret: 'whsec_project' }),
            );
            const sdk = buildSdkStub();
            (sdk.triggers.verifyWebhook as jest.Mock).mockResolvedValue({
                version: 'V3',
                payload: { ok: true },
                rawPayload: '{}',
            });
            injectSdk(service, sdk);

            const result = await service.verifyWebhook('user-1', {
                id: 'wh_1',
                rawBody: '{"a":1}',
                signature: 'v1,sig',
                timestamp: '1700000000',
            });

            expect(result).toEqual({ version: 'V3', payload: { ok: true } });
            expect(sdk.triggers.verifyWebhook).toHaveBeenCalledWith({
                id: 'wh_1',
                payload: '{"a":1}',
                signature: 'v1,sig',
                timestamp: '1700000000',
                secret: 'whsec_project',
            });
        });

        it('verifyWebhook maps SDK verification failure to UnauthorizedException', async () => {
            settingsService.getResolvedSettings.mockResolvedValue(
                buildResolvedSettings({ webhookSecret: 'whsec_project' }),
            );
            const sdk = buildSdkStub();
            (sdk.triggers.verifyWebhook as jest.Mock).mockRejectedValue(new Error('bad signature'));
            injectSdk(service, sdk);

            await expect(
                service.verifyWebhook('user-1', {
                    id: 'wh_1',
                    rawBody: '{}',
                    signature: 'v1,bad',
                    timestamp: '1700000000',
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);
        });
    });
});
