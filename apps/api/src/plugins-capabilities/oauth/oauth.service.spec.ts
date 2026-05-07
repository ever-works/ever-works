jest.mock('@ever-works/agent/facades', () => ({ OAuthFacadeService: class {} }));
jest.mock('@ever-works/agent/database', () => ({
    AuthAccountRepository: class {},
    PLUGIN_PROVIDER_PREFIX: 'plugin:',
    buildPluginProviderId: (providerId: string) => `plugin:${providerId}`,
}));
jest.mock('@ever-works/agent/plugins', () => ({ PluginSettingsService: class {} }));

// randomBytes -> deterministic 16-byte output of 0x00 = '00000000000000000000000000000000'
jest.mock('crypto', () => ({
    ...jest.requireActual('crypto'),
    randomBytes: jest.fn(() => Buffer.alloc(16, 0)),
}));

import { BadRequestException } from '@nestjs/common';
import { OAuthService } from './oauth.service';
import type { OAuthFacadeService } from '@ever-works/agent/facades';
import type { AuthAccountRepository } from '@ever-works/agent/database';
import type { PluginSettingsService } from '@ever-works/agent/plugins';

describe('OAuthService', () => {
    let oauthFacade: {
        isConfigured: jest.Mock;
        getAvailableProviders: jest.Mock;
        getAuthenticatedUser: jest.Mock;
        getAccessToken: jest.Mock;
        hasValidCredentials: jest.Mock;
        getAuthorizationUrl: jest.Mock;
        exchangeCodeForToken: jest.Mock;
        revokeToken: jest.Mock;
    };
    let authAccountRepository: {
        findConnectedProviderAccount: jest.Mock;
        upsertProviderAccount: jest.Mock;
    };
    let pluginSettingsService: { getSettings: jest.Mock };
    let service: OAuthService;

    beforeEach(() => {
        oauthFacade = {
            isConfigured: jest.fn(),
            getAvailableProviders: jest.fn(),
            getAuthenticatedUser: jest.fn(),
            getAccessToken: jest.fn(),
            hasValidCredentials: jest.fn(),
            getAuthorizationUrl: jest.fn(),
            exchangeCodeForToken: jest.fn(),
            revokeToken: jest.fn(),
        };
        authAccountRepository = {
            findConnectedProviderAccount: jest.fn(),
            upsertProviderAccount: jest.fn().mockResolvedValue(undefined),
        };
        pluginSettingsService = { getSettings: jest.fn() };
        service = new OAuthService(
            oauthFacade as unknown as OAuthFacadeService,
            authAccountRepository as unknown as AuthAccountRepository,
            pluginSettingsService as unknown as PluginSettingsService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('pass-through helpers', () => {
        it('isConfigured forwards to oauthFacade.isConfigured', () => {
            oauthFacade.isConfigured.mockReturnValue(true);
            expect(service.isConfigured()).toBe(true);

            oauthFacade.isConfigured.mockReturnValue(false);
            expect(service.isConfigured()).toBe(false);
        });

        it('getAvailableProviders returns the facade list verbatim', () => {
            const list = [{ id: 'github', name: 'GitHub', enabled: true }];
            oauthFacade.getAvailableProviders.mockReturnValue(list);

            const result = service.getAvailableProviders();

            expect(result).toBe(list);
        });

        it('hasValidCredentials forwards (userId, providerId)', async () => {
            oauthFacade.hasValidCredentials.mockResolvedValue(true);

            const result = await service.hasValidCredentials('user-1', 'github');

            expect(oauthFacade.hasValidCredentials).toHaveBeenCalledWith('user-1', 'github');
            expect(result).toBe(true);
        });

        it('disconnectProvider forwards (userId, providerId) to oauthFacade.revokeToken', async () => {
            oauthFacade.revokeToken.mockResolvedValue(undefined);

            await service.disconnectProvider('user-1', 'github');

            expect(oauthFacade.revokeToken).toHaveBeenCalledWith('user-1', 'github');
        });
    });

    describe('checkConnection', () => {
        const provider = { id: 'github', name: 'GitHub', enabled: true };

        it('returns Unknown placeholder when provider not in available list', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([]);

            const result = await service.checkConnection('user-1', 'unknown');

            expect(result).toEqual({
                id: 'unknown',
                name: 'Unknown',
                enabled: false,
                connected: false,
            });
            expect(authAccountRepository.findConnectedProviderAccount).not.toHaveBeenCalled();
        });

        it('returns connected:false when no account or accessToken', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue(null);

            const result = await service.checkConnection('user-1', 'github');

            expect(authAccountRepository.findConnectedProviderAccount).toHaveBeenCalledWith(
                'user-1',
                'github',
                { usePluginProviderId: true },
            );
            expect(result).toEqual({ ...provider, connected: false });
            expect(oauthFacade.getAuthenticatedUser).not.toHaveBeenCalled();
        });

        it('returns connected:false when account exists but accessToken is empty', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
                accessToken: '',
                providerId: 'plugin:github',
            });

            const result = await service.checkConnection('user-1', 'github');

            expect(result).toEqual({ ...provider, connected: false });
            expect(oauthFacade.getAuthenticatedUser).not.toHaveBeenCalled();
        });

        it('returns connected:true with connectionSource=plugin when providerId starts with plugin: prefix', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
                accessToken: 'tok',
                providerId: 'plugin:github',
            });
            oauthFacade.getAuthenticatedUser.mockResolvedValue({
                username: 'alice',
                email: 'a@b',
                avatarUrl: 'https://x/a.png',
            });

            const result = await service.checkConnection('user-1', 'github');

            expect(oauthFacade.getAuthenticatedUser).toHaveBeenCalledWith('github', 'tok');
            expect(result).toEqual({
                ...provider,
                connected: true,
                username: 'alice',
                email: 'a@b',
                avatarUrl: 'https://x/a.png',
                connectionSource: 'plugin',
            });
        });

        it('returns connectionSource=social when providerId does NOT start with plugin: prefix', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
                accessToken: 'tok',
                providerId: 'github',
            });
            oauthFacade.getAuthenticatedUser.mockResolvedValue({
                username: 'bob',
                email: 'b@b',
                avatarUrl: undefined,
            });

            const result = await service.checkConnection('user-1', 'github');

            expect(result.connectionSource).toBe('social');
            expect(result.connected).toBe(true);
        });

        it('returns connected:false when getAuthenticatedUser throws (warns, does not propagate)', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
                accessToken: 'tok',
                providerId: 'plugin:github',
            });
            oauthFacade.getAuthenticatedUser.mockRejectedValue(new Error('upstream 401'));

            const result = await service.checkConnection('user-1', 'github');

            expect(result).toEqual({ ...provider, connected: false });
        });

        it('returns connected:false when findConnectedProviderAccount throws (warns, does not propagate)', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockRejectedValue(
                new Error('db down'),
            );

            const result = await service.checkConnection('user-1', 'github');

            expect(result).toEqual({ ...provider, connected: false });
        });
    });

    describe('getUser', () => {
        it('throws BadRequestException when no token returned by facade', async () => {
            oauthFacade.getAccessToken.mockResolvedValue(null);

            await expect(service.getUser('user-1', 'github')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(oauthFacade.getAuthenticatedUser).not.toHaveBeenCalled();
        });

        it('throws BadRequestException with provider-specific message', async () => {
            oauthFacade.getAccessToken.mockResolvedValue(undefined);

            await expect(service.getUser('user-1', 'gitlab')).rejects.toThrow(
                'No valid token for provider gitlab',
            );
        });

        it('forwards token + providerId to getAuthenticatedUser when token exists', async () => {
            oauthFacade.getAccessToken.mockResolvedValue('tok-xyz');
            const user = { id: 'u1', username: 'alice', email: 'a@b' };
            oauthFacade.getAuthenticatedUser.mockResolvedValue(user);

            const result = await service.getUser('user-1', 'github');

            expect(oauthFacade.getAccessToken).toHaveBeenCalledWith('user-1', 'github');
            expect(oauthFacade.getAuthenticatedUser).toHaveBeenCalledWith('github', 'tok-xyz');
            expect(result).toBe(user);
        });
    });

    describe('getOAuthUrl', () => {
        const validSettings = { clientId: 'cid', clientSecret: 'csecret' };

        it('uses provided state verbatim and forwards to oauthFacade.getAuthorizationUrl', async () => {
            pluginSettingsService.getSettings.mockResolvedValue(validSettings);
            oauthFacade.getAuthorizationUrl.mockReturnValue('https://provider/auth?state=abc');

            const result = await service.getOAuthUrl({
                userId: 'user-1',
                providerId: 'github',
                redirectUri: 'https://app/cb',
                state: 'abc',
                forceConsent: true,
            });

            expect(pluginSettingsService.getSettings).toHaveBeenCalledWith('github', {
                includeSecrets: true,
            });
            expect(oauthFacade.getAuthorizationUrl).toHaveBeenCalledWith('github', 'abc', {
                clientId: 'cid',
                clientSecret: 'csecret',
                redirectUri: 'https://app/cb',
                scopes: undefined,
                forceConsent: true,
            });
            expect(result).toEqual({
                url: 'https://provider/auth?state=abc',
                state: 'abc',
            });
        });

        it('generates random state when none provided (16 bytes hex)', async () => {
            pluginSettingsService.getSettings.mockResolvedValue(validSettings);
            oauthFacade.getAuthorizationUrl.mockReturnValue('https://provider/auth');

            const result = await service.getOAuthUrl({
                userId: 'user-1',
                providerId: 'github',
                redirectUri: '',
            });

            // Buffer.alloc(16, 0).toString('hex') === '00000000000000000000000000000000'
            expect(result.state).toBe('00000000000000000000000000000000');
            expect(result.state).toHaveLength(32);
        });

        it('passes forceConsent through (default undefined when omitted)', async () => {
            pluginSettingsService.getSettings.mockResolvedValue(validSettings);
            oauthFacade.getAuthorizationUrl.mockReturnValue('u');

            await service.getOAuthUrl({
                userId: 'user-1',
                providerId: 'github',
                redirectUri: 'https://app/cb',
                state: 's',
            });

            expect(oauthFacade.getAuthorizationUrl).toHaveBeenCalledWith(
                'github',
                's',
                expect.objectContaining({ forceConsent: undefined }),
            );
        });

        it('passes scopes from settings when present', async () => {
            pluginSettingsService.getSettings.mockResolvedValue({
                ...validSettings,
                scopes: ['read:user', 'repo'],
            });
            oauthFacade.getAuthorizationUrl.mockReturnValue('u');

            await service.getOAuthUrl({
                userId: 'user-1',
                providerId: 'github',
                redirectUri: 'https://app/cb',
                state: 's',
            });

            expect(oauthFacade.getAuthorizationUrl).toHaveBeenCalledWith(
                'github',
                's',
                expect.objectContaining({ scopes: ['read:user', 'repo'] }),
            );
        });

        it('throws BadRequestException when clientId missing', async () => {
            pluginSettingsService.getSettings.mockResolvedValue({
                clientSecret: 'csecret',
            });

            await expect(
                service.getOAuthUrl({
                    userId: 'user-1',
                    providerId: 'github',
                    redirectUri: '',
                }),
            ).rejects.toThrow('OAuth credentials not configured for provider: github');
        });

        it('throws BadRequestException when clientSecret missing', async () => {
            pluginSettingsService.getSettings.mockResolvedValue({ clientId: 'cid' });

            await expect(
                service.getOAuthUrl({
                    userId: 'user-1',
                    providerId: 'gitlab',
                    redirectUri: '',
                }),
            ).rejects.toThrow('OAuth credentials not configured for provider: gitlab');
        });

        it('throws BadRequestException when settings is null/undefined', async () => {
            pluginSettingsService.getSettings.mockResolvedValue(null);

            await expect(
                service.getOAuthUrl({
                    userId: 'user-1',
                    providerId: 'github',
                    redirectUri: '',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('handleOAuthCallback', () => {
        const provider = { id: 'github', name: 'GitHub', enabled: true };
        const validSettings = { clientId: 'cid', clientSecret: 'csecret' };

        beforeEach(() => {
            pluginSettingsService.getSettings.mockResolvedValue(validSettings);
            oauthFacade.exchangeCodeForToken.mockResolvedValue({
                accessToken: 'access',
                refreshToken: 'refresh',
                tokenType: 'Bearer',
                scope: 'repo',
                expiresIn: 3600,
            });
            oauthFacade.getAuthenticatedUser.mockResolvedValue({
                id: 'oauth-id',
                username: 'alice',
                email: 'a@b',
                name: 'Alice',
                avatarUrl: 'https://x/a.png',
            });
            oauthFacade.getAvailableProviders.mockReturnValue([provider]);
        });

        it('exchanges code, fetches user, upserts account with plugin: prefix and connectionSource=plugin', async () => {
            const before = Date.now();
            const result = await service.handleOAuthCallback('user-1', 'github', 'code-abc', 'state-xyz');
            const after = Date.now();

            expect(oauthFacade.exchangeCodeForToken).toHaveBeenCalledWith(
                'github',
                'code-abc',
                expect.objectContaining({
                    clientId: 'cid',
                    clientSecret: 'csecret',
                    redirectUri: undefined,
                    scopes: undefined,
                }),
            );
            expect(oauthFacade.getAuthenticatedUser).toHaveBeenCalledWith('github', 'access');

            expect(authAccountRepository.upsertProviderAccount).toHaveBeenCalledTimes(1);
            const arg = authAccountRepository.upsertProviderAccount.mock.calls[0][0];
            expect(arg).toMatchObject({
                userId: 'user-1',
                providerId: 'plugin:github',
                accountId: 'oauth-id',
                accessToken: 'access',
                refreshToken: 'refresh',
                tokenType: 'Bearer',
                scope: 'repo',
                email: 'a@b',
                username: 'alice',
                metadata: {
                    oauthUserId: 'oauth-id',
                    name: 'Alice',
                    avatarUrl: 'https://x/a.png',
                },
            });

            // expiresAt = now + expiresIn(3600)s
            const expectedMin = before + 3600 * 1000 - 50;
            const expectedMax = after + 3600 * 1000 + 50;
            expect(arg.accessTokenExpiresAt).toBeInstanceOf(Date);
            expect((arg.accessTokenExpiresAt as Date).getTime()).toBeGreaterThanOrEqual(expectedMin);
            expect((arg.accessTokenExpiresAt as Date).getTime()).toBeLessThanOrEqual(expectedMax);

            expect(result).toEqual({
                id: 'github',
                name: 'GitHub',
                enabled: true,
                connected: true,
                username: 'alice',
                email: 'a@b',
                avatarUrl: 'https://x/a.png',
                connectionSource: 'plugin',
            });
        });

        it('passes accessTokenExpiresAt=undefined when token has no expiresIn', async () => {
            oauthFacade.exchangeCodeForToken.mockResolvedValue({
                accessToken: 'access',
                refreshToken: undefined,
                tokenType: undefined,
                scope: undefined,
            });

            await service.handleOAuthCallback('user-1', 'github', 'code', undefined);

            const arg = authAccountRepository.upsertProviderAccount.mock.calls[0][0];
            expect(arg.accessTokenExpiresAt).toBeUndefined();
        });

        it('coerces empty user.email to null in upsert payload', async () => {
            oauthFacade.getAuthenticatedUser.mockResolvedValue({
                id: 'oauth-id',
                username: 'alice',
                email: '',
                name: 'Alice',
                avatarUrl: 'a.png',
            });

            await service.handleOAuthCallback('user-1', 'github', 'code');

            const arg = authAccountRepository.upsertProviderAccount.mock.calls[0][0];
            expect(arg.email).toBeNull();
        });

        it('falls back to providerId when no providerInfo found in available list', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([]);

            const result = await service.handleOAuthCallback('user-1', 'github', 'code');

            expect(result).toEqual(
                expect.objectContaining({
                    id: 'github',
                    name: 'github',
                    enabled: true,
                }),
            );
        });

        it('uses providerInfo.enabled when available (false)', async () => {
            oauthFacade.getAvailableProviders.mockReturnValue([
                { id: 'github', name: 'GitHub', enabled: false },
            ]);

            const result = await service.handleOAuthCallback('user-1', 'github', 'code');

            expect(result.enabled).toBe(false);
        });

        it('throws BadRequestException when settings missing clientId/clientSecret', async () => {
            pluginSettingsService.getSettings.mockResolvedValue({});

            await expect(
                service.handleOAuthCallback('user-1', 'github', 'code'),
            ).rejects.toThrow('OAuth credentials not configured for provider: github');

            expect(oauthFacade.exchangeCodeForToken).not.toHaveBeenCalled();
            expect(authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
        });

        it('propagates exchangeCodeForToken errors', async () => {
            oauthFacade.exchangeCodeForToken.mockRejectedValue(new Error('invalid_grant'));

            await expect(
                service.handleOAuthCallback('user-1', 'github', 'code'),
            ).rejects.toThrow('invalid_grant');
            expect(authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
        });
    });
});
