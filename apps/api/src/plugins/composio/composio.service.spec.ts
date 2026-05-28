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
    })),
}));

import { PluginSettingsService } from '@ever-works/agent/plugins';
import { ComposioService, type ComposioSdkLike } from './composio.service';

function buildSdkStub(): ComposioSdkLike {
    return {
        toolkits: { get: jest.fn() },
        connectedAccounts: { list: jest.fn(), initiate: jest.fn() },
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
        it("hard-pins the user_id filter to the JWT user (no override)", async () => {
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
            expect(sdk.connectedAccounts.initiate).toHaveBeenCalledWith(
                'user-1',
                'ac_xyz',
                { callbackUrl: 'https://app.ever.works/settings/plugins/composio/callback' },
            );
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
});
