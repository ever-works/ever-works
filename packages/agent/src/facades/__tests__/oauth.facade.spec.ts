import { Test, TestingModule } from '@nestjs/testing';
import { OAuthFacadeService, NoOAuthProviderError } from '../oauth.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { AuthAccountRepository } from '../../database/repositories/auth-account.repository';
import type { IOAuthPlugin, PluginManifest, PluginState } from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

describe('OAuthFacadeService', () => {
    let service: OAuthFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let authAccountRepository: jest.Mocked<AuthAccountRepository>;

    const createMockOAuthPlugin = (id: string, name: string): IOAuthPlugin =>
        ({
            id,
            name,
            version: '1.0.0',
            category: 'integration',
            capabilities: [PLUGIN_CAPABILITIES.OAUTH],
            settingsSchema: { type: 'object', properties: {} },
            onLoad: jest.fn(),
            onUnload: jest.fn(),
            getAuthorizationUrl: jest.fn().mockReturnValue(`https://provider.com/oauth?state=test`),
            exchangeCodeForToken: jest.fn().mockResolvedValue({
                accessToken: 'token-123',
                tokenType: 'Bearer',
                scope: 'read',
            }),
            getAuthenticatedUser: jest.fn().mockResolvedValue({
                id: 'user-1',
                username: 'testuser',
                email: 'test@example.com',
            }),
            revokeToken: jest.fn().mockResolvedValue(undefined),
        }) as unknown as IOAuthPlugin;

    const createRegisteredPlugin = (
        plugin: IOAuthPlugin,
        options: { state?: PluginState; capabilities?: string[] } = {},
    ): RegisteredPlugin => ({
        plugin,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: '1.0.0',
            description: 'Test OAuth plugin',
            capabilities: options.capabilities || [PLUGIN_CAPABILITIES.OAUTH],
            category: 'integration',
        } as PluginManifest,
        state: options.state || 'loaded',
        builtIn: true,
        registeredAt: Date.now(),
        stateHistory: [],
    });

    beforeEach(async () => {
        registry = {
            getByCapability: jest.fn().mockReturnValue([]),
            get: jest.fn(),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        } as any;

        authAccountRepository = {
            findProviderAccount: jest.fn(),
            deleteProviderAccount: jest.fn(),
            isAccessTokenExpired: jest.fn().mockReturnValue(false),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OAuthFacadeService,
                { provide: PluginRegistryService, useValue: registry },
                { provide: AuthAccountRepository, useValue: authAccountRepository },
            ],
        }).compile();

        service = module.get<OAuthFacadeService>(OAuthFacadeService);
    });

    describe('isConfigured', () => {
        it('should return true when enabled OAuth providers exist', () => {
            const oauthPlugin = createMockOAuthPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(oauthPlugin);
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(true);
        });

        it('should return false when no OAuth providers exist', () => {
            registry.getByCapability.mockReturnValue([]);
            expect(service.isConfigured()).toBe(false);
        });

        it('should return false when all OAuth providers are disabled', () => {
            const oauthPlugin = createMockOAuthPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(oauthPlugin, { state: 'unloaded' });
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('getAvailableProviders', () => {
        it('should return list of OAuth providers', () => {
            const github = createMockOAuthPlugin('github', 'GitHub');
            const gitlab = createMockOAuthPlugin('gitlab', 'GitLab');
            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(github),
                createRegisteredPlugin(gitlab, { state: 'unloaded' }),
            ]);

            const result = service.getAvailableProviders();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ id: 'github', name: 'GitHub', enabled: true });
            expect(result[1]).toEqual({ id: 'gitlab', name: 'GitLab', enabled: false });
        });
    });

    describe('getAuthorizationUrl', () => {
        it('should return OAuth URL from plugin', () => {
            const oauthPlugin = createMockOAuthPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(oauthPlugin);
            registry.getByCapability.mockReturnValue([registered]);

            const result = service.getAuthorizationUrl('github', 'test-state', {});

            expect(result).toContain('provider.com/oauth');
            expect(oauthPlugin.getAuthorizationUrl).toHaveBeenCalledWith('test-state', {});
        });

        it('should throw NoOAuthProviderError when no providers available', () => {
            registry.getByCapability.mockReturnValue([]);

            expect(() => service.getAuthorizationUrl('github', 'test-state', {})).toThrow(
                NoOAuthProviderError,
            );
        });
    });

    describe('exchangeCodeForToken', () => {
        it('should exchange code for token', async () => {
            const oauthPlugin = createMockOAuthPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(oauthPlugin);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.exchangeCodeForToken('github', 'auth-code', {});

            expect(result.accessToken).toBe('token-123');
            expect(oauthPlugin.exchangeCodeForToken).toHaveBeenCalledWith('auth-code', {});
        });
    });

    describe('getAuthenticatedUser', () => {
        it('should get authenticated user', async () => {
            const oauthPlugin = createMockOAuthPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(oauthPlugin);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.getAuthenticatedUser('github', 'test-token');

            expect(result.username).toBe('testuser');
            expect(oauthPlugin.getAuthenticatedUser).toHaveBeenCalledWith('test-token');
        });
    });

    describe('hasValidCredentials', () => {
        it('should return true when valid token exists', async () => {
            const token = { accessToken: 'token', userId: 'user-1', provider: 'github' };
            authAccountRepository.findProviderAccount.mockResolvedValue(token as any);
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);

            const result = await service.hasValidCredentials('user-1', 'github');

            expect(result).toBe(true);
        });

        it('should return false when token is expired', async () => {
            const token = { accessToken: 'token', userId: 'user-1', provider: 'github' };
            authAccountRepository.findProviderAccount.mockResolvedValue(token as any);
            authAccountRepository.isAccessTokenExpired.mockReturnValue(true);

            const result = await service.hasValidCredentials('user-1', 'github');

            expect(result).toBe(false);
        });

        it('should return false when no token exists', async () => {
            authAccountRepository.findProviderAccount.mockResolvedValue(null);

            const result = await service.hasValidCredentials('user-1', 'github');

            expect(result).toBe(false);
        });
    });

    describe('getAccessToken', () => {
        it('should return access token when valid', async () => {
            const token = { accessToken: 'token-123', userId: 'user-1', provider: 'github' };
            authAccountRepository.findProviderAccount.mockResolvedValue(token as any);
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);

            const result = await service.getAccessToken('user-1', 'github');

            expect(result).toBe('token-123');
        });

        it('should return null when token expired', async () => {
            const token = { accessToken: 'token-123', userId: 'user-1', provider: 'github' };
            authAccountRepository.findProviderAccount.mockResolvedValue(token as any);
            authAccountRepository.isAccessTokenExpired.mockReturnValue(true);

            const result = await service.getAccessToken('user-1', 'github');

            expect(result).toBeNull();
        });
    });

    describe('revokeToken', () => {
        it('should call plugin revokeToken and delete from repository', async () => {
            const oauthPlugin = createMockOAuthPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(oauthPlugin);
            registry.getByCapability.mockReturnValue([registered]);

            const token = { accessToken: 'token-123', userId: 'user-1', provider: 'github' };
            authAccountRepository.findProviderAccount.mockResolvedValue(token as any);

            await service.revokeToken('user-1', 'github');

            expect(oauthPlugin.revokeToken).toHaveBeenCalledWith('token-123');
            expect(authAccountRepository.deleteProviderAccount).toHaveBeenCalledWith(
                'user-1',
                'plugin:github',
            );
        });

        it('should delete from repository even if remote revocation fails', async () => {
            const oauthPlugin = createMockOAuthPlugin('github', 'GitHub');
            (oauthPlugin.revokeToken as jest.Mock).mockRejectedValue(new Error('Remote error'));
            const registered = createRegisteredPlugin(oauthPlugin);
            registry.getByCapability.mockReturnValue([registered]);

            const token = { accessToken: 'token-123', userId: 'user-1', provider: 'github' };
            authAccountRepository.findProviderAccount.mockResolvedValue(token as any);

            await service.revokeToken('user-1', 'github');

            expect(authAccountRepository.deleteProviderAccount).toHaveBeenCalledWith(
                'user-1',
                'plugin:github',
            );
        });
    });
});
