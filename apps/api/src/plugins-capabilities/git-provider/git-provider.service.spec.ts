jest.mock('@ever-works/agent/facades', () => ({ GitFacadeService: class {} }));
jest.mock('@ever-works/agent/database', () => ({ AuthAccountRepository: class {} }));

import { GitProviderService } from './git-provider.service';
import type { GitFacadeService } from '@ever-works/agent/facades';
import type { AuthAccountRepository } from '@ever-works/agent/database';

describe('GitProviderService', () => {
    let gitFacade: {
        isConfigured: jest.Mock;
        getAvailableProviders: jest.Mock;
        getUser: jest.Mock;
        getOrganizations: jest.Mock;
        listRepositories: jest.Mock;
        hasValidCredentials: jest.Mock;
    };
    let authAccountRepository: { findConnectedProviderAccount: jest.Mock };
    let service: GitProviderService;

    beforeEach(() => {
        gitFacade = {
            isConfigured: jest.fn(),
            getAvailableProviders: jest.fn(),
            getUser: jest.fn(),
            getOrganizations: jest.fn(),
            listRepositories: jest.fn(),
            hasValidCredentials: jest.fn(),
        };
        authAccountRepository = { findConnectedProviderAccount: jest.fn() };
        service = new GitProviderService(
            gitFacade as unknown as GitFacadeService,
            authAccountRepository as unknown as AuthAccountRepository,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('isConfigured / getAvailableProviders / getUser / getOrganizations / getRepositories / hasValidCredentials — pass-through helpers', () => {
        it('isConfigured forwards to gitFacade.isConfigured', () => {
            gitFacade.isConfigured.mockReturnValue(true);
            expect(service.isConfigured()).toBe(true);
            expect(gitFacade.isConfigured).toHaveBeenCalledTimes(1);

            gitFacade.isConfigured.mockReturnValue(false);
            expect(service.isConfigured()).toBe(false);
        });

        it('getAvailableProviders returns the facade list verbatim', () => {
            const list = [{ id: 'github', name: 'GitHub', enabled: true }];
            gitFacade.getAvailableProviders.mockReturnValue(list);

            const result = service.getAvailableProviders();

            expect(result).toBe(list);
            expect(gitFacade.getAvailableProviders).toHaveBeenCalledTimes(1);
        });

        it('getUser forwards { userId, providerId } to gitFacade.getUser', async () => {
            const user = { login: 'alice', email: 'a@b' };
            gitFacade.getUser.mockResolvedValue(user);

            const result = await service.getUser('user-1', 'github');

            expect(gitFacade.getUser).toHaveBeenCalledWith({
                userId: 'user-1',
                providerId: 'github',
            });
            expect(result).toBe(user);
        });

        it('getOrganizations forwards { userId, providerId }', async () => {
            const orgs = [{ id: 'o1', login: 'acme' }];
            gitFacade.getOrganizations.mockResolvedValue(orgs);

            const result = await service.getOrganizations('user-1', 'github');

            expect(gitFacade.getOrganizations).toHaveBeenCalledWith({
                userId: 'user-1',
                providerId: 'github',
            });
            expect(result).toBe(orgs);
        });

        it('getRepositories forwards { userId, providerId } and pagination args positionally', async () => {
            const repos = [{ id: 'r1', name: 'repo' }];
            gitFacade.listRepositories.mockResolvedValue(repos);

            const result = await service.getRepositories('user-1', 'github', 2, 50);

            expect(gitFacade.listRepositories).toHaveBeenCalledWith(
                { userId: 'user-1', providerId: 'github' },
                2,
                50,
            );
            expect(result).toBe(repos);
        });

        it('getRepositories passes undefined page/perPage when omitted', async () => {
            gitFacade.listRepositories.mockResolvedValue([]);

            await service.getRepositories('user-1', 'github');

            expect(gitFacade.listRepositories).toHaveBeenCalledWith(
                { userId: 'user-1', providerId: 'github' },
                undefined,
                undefined,
            );
        });

        it('hasValidCredentials forwards { userId, providerId }', async () => {
            gitFacade.hasValidCredentials.mockResolvedValue(true);

            const result = await service.hasValidCredentials('user-1', 'github');

            expect(gitFacade.hasValidCredentials).toHaveBeenCalledWith({
                userId: 'user-1',
                providerId: 'github',
            });
            expect(result).toBe(true);
        });
    });

    describe('checkConnection', () => {
        const provider = { id: 'github', name: 'GitHub', enabled: true };

        it('returns Unknown placeholder when provider not in available list', async () => {
            gitFacade.getAvailableProviders.mockReturnValue([]);

            const result = await service.checkConnection('user-1', 'unknown');

            expect(result).toEqual({
                id: 'unknown',
                name: 'Unknown',
                enabled: false,
                connected: false,
            });
            expect(authAccountRepository.findConnectedProviderAccount).not.toHaveBeenCalled();
        });

        it('returns connected:false when no oauth account and gitFacade reports no PAT', async () => {
            gitFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue(null);
            gitFacade.hasValidCredentials.mockResolvedValue(false);

            const result = await service.checkConnection('user-1', 'github');

            expect(authAccountRepository.findConnectedProviderAccount).toHaveBeenCalledWith(
                'user-1',
                'github',
                { usePluginProviderId: true },
            );
            expect(gitFacade.hasValidCredentials).toHaveBeenCalledWith({
                userId: 'user-1',
                providerId: 'github',
            });
            expect(result).toEqual({ ...provider, connected: false });
            expect(gitFacade.getUser).not.toHaveBeenCalled();
        });

        it('uses oauthAccount.accessToken when available, sets authMethod=oauth', async () => {
            gitFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
                accessToken: 'gh_oauth_tok',
            });
            gitFacade.getUser.mockResolvedValue({
                login: 'alice',
                email: 'a@b',
                avatarUrl: 'https://x/a.png',
            });

            const result = await service.checkConnection('user-1', 'github');

            expect(gitFacade.getUser).toHaveBeenCalledWith({
                providerId: 'github',
                token: 'gh_oauth_tok',
            });
            expect(result).toEqual({
                ...provider,
                connected: true,
                username: 'alice',
                email: 'a@b',
                avatarUrl: 'https://x/a.png',
                authMethod: 'oauth',
            });
        });

        it('falls back to PAT when no oauth account but gitFacade reports valid credentials, sets authMethod=personal-access-token', async () => {
            gitFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue(null);
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.getUser.mockResolvedValue({
                login: 'bob',
                email: 'b@b',
                avatarUrl: undefined,
            });

            const result = await service.checkConnection('user-1', 'github');

            expect(gitFacade.getUser).toHaveBeenCalledWith({
                userId: 'user-1',
                providerId: 'github',
            });
            expect(result).toEqual({
                ...provider,
                connected: true,
                username: 'bob',
                email: 'b@b',
                avatarUrl: undefined,
                authMethod: 'personal-access-token',
            });
        });

        it('handles oauth account WITHOUT accessToken (falsy) by falling through to PAT path', async () => {
            gitFacade.getAvailableProviders.mockReturnValue([provider]);
            // hasAnyCredentials = !!oauthAccount → true (truthy object), so enters try block
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
                accessToken: '',
            });
            gitFacade.getUser.mockResolvedValue({ login: 'c', email: 'c@b', avatarUrl: null });

            const result = await service.checkConnection('user-1', 'github');

            // Empty-string accessToken is falsy, so service uses { userId, providerId }
            expect(gitFacade.getUser).toHaveBeenCalledWith({
                userId: 'user-1',
                providerId: 'github',
            });
            // authMethod still resolves to 'oauth' because oauthAccount is truthy
            expect(result.authMethod).toBe('oauth');
            expect(result.connected).toBe(true);
        });

        it('returns connected:false on getUser failure (warns but does not throw)', async () => {
            gitFacade.getAvailableProviders.mockReturnValue([provider]);
            authAccountRepository.findConnectedProviderAccount.mockResolvedValue({
                accessToken: 'tok',
            });
            gitFacade.getUser.mockRejectedValue(new Error('upstream 401'));

            const result = await service.checkConnection('user-1', 'github');

            expect(result).toEqual({ ...provider, connected: false });
        });
    });
});
