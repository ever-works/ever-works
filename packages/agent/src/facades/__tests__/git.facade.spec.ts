import { Test, TestingModule } from '@nestjs/testing';
import { requestGitHubAppInstallationAccessTokenDetails } from '@src/utils';
import {
    GitFacadeService,
    GitFacadeError,
    NoGitProviderError,
    GitProviderNotFoundError,
    NoGitCredentialsError,
} from '../git.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { AuthAccountRepository } from '../../database/repositories/auth-account.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import { GitHubAppInstallationRepository } from '../../database/repositories/github-app-installation.repository';
import type { ResolvedSettings } from '@ever-works/plugin';
import type {
    IGitProviderPlugin,
    IOAuthPlugin,
    PluginManifest,
    GitUser,
    GitOrganization,
    GitRepository,
    GitBranch,
    GitCommit,
    GitCommitter,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';

jest.mock('@src/utils', () => ({
    requestGitHubAppInstallationAccessTokenDetails: jest.fn(),
}));

describe('GitFacadeService', () => {
    let service: GitFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let authAccountRepository: jest.Mocked<AuthAccountRepository>;
    let settingsService: jest.Mocked<PluginSettingsService>;
    let workRepository: jest.Mocked<WorkRepository>;
    let gitHubAppInstallationRepository: jest.Mocked<GitHubAppInstallationRepository>;

    const createMockGitPlugin = (
        id: string,
        providerName: string,
        supportsOAuth = true,
    ): IGitProviderPlugin & Partial<IOAuthPlugin> =>
        ({
            id,
            name: `${providerName} Plugin`,
            version: '1.0.0',
            category: 'git-provider',
            capabilities: supportsOAuth ? ['git-provider', 'oauth'] : ['git-provider'],
            settingsSchema: { type: 'object', properties: {} },
            providerName,
            onLoad: jest.fn(),
            onUnload: jest.fn(),
            getUser: jest.fn().mockResolvedValue({
                id: 'user-123',
                login: 'testuser',
                name: 'Test User',
                email: 'test@example.com',
                avatarUrl: 'https://example.com/avatar.png',
            } as GitUser),
            getOrganizations: jest
                .fn()
                .mockResolvedValue([
                    { id: 'org-1', login: 'test-org', name: 'Test Organization' },
                ] as GitOrganization[]),
            getRepository: jest.fn().mockResolvedValue({
                owner: 'testuser',
                name: 'test-repo',
                fullName: 'testuser/test-repo',
                isPrivate: false,
                defaultBranch: 'main',
                url: 'https://github.com/testuser/test-repo',
                cloneUrl: 'https://github.com/testuser/test-repo.git',
            } as GitRepository),
            listRepositories: jest.fn().mockResolvedValue([]),
            createRepository: jest.fn().mockResolvedValue({
                owner: 'testuser',
                name: 'new-repo',
                fullName: 'testuser/new-repo',
                isPrivate: false,
                defaultBranch: 'main',
                url: 'https://github.com/testuser/new-repo',
                cloneUrl: 'https://github.com/testuser/new-repo.git',
            } as GitRepository),
            deleteRepository: jest.fn().mockResolvedValue(undefined),
            updateRepository: jest.fn().mockResolvedValue({
                owner: 'testuser',
                name: 'test-repo',
                fullName: 'testuser/test-repo',
                defaultBranch: 'main',
                isPrivate: true,
                url: 'https://github.com/testuser/test-repo',
                cloneUrl: 'https://github.com/testuser/test-repo.git',
            } as GitRepository),
            hasRepositoryAccess: jest.fn().mockResolvedValue(true),
            forkRepository: jest.fn().mockResolvedValue({
                owner: 'testuser',
                name: 'fork-repo',
                fullName: 'testuser/fork-repo',
                defaultBranch: 'main',
                isPrivate: false,
                url: 'https://github.com/testuser/fork-repo',
                cloneUrl: 'https://github.com/testuser/fork-repo.git',
            } as GitRepository),
            createRepositoryFromTemplate: jest.fn().mockResolvedValue({
                owner: 'testuser',
                name: 'from-template',
                fullName: 'testuser/from-template',
                defaultBranch: 'main',
                isPrivate: false,
                url: 'https://github.com/testuser/from-template',
                cloneUrl: 'https://github.com/testuser/from-template.git',
            } as GitRepository),
            hasForkRelationship: jest.fn().mockResolvedValue(true),
            repositoryExists: jest.fn().mockResolvedValue(true),
            listBranches: jest.fn().mockResolvedValue([
                { name: 'main', commit: 'abc123', isDefault: true },
                { name: 'develop', commit: 'def456', isDefault: false },
            ] as GitBranch[]),
            createBranch: jest.fn().mockResolvedValue({
                name: 'feature',
                commit: 'ghi789',
                isDefault: false,
            } as GitBranch),
            deleteBranch: jest.fn().mockResolvedValue(undefined),
            getLatestCommit: jest.fn().mockResolvedValue({
                sha: 'abc123',
                message: 'Latest commit',
            } as GitCommit),
            getFileContent: jest.fn().mockResolvedValue({
                content: 'file content',
                encoding: 'utf-8',
            }),
            getReadme: jest.fn().mockResolvedValue({
                content: '# README',
                path: 'README.md',
            }),
            getRawFileUrl: jest
                .fn()
                .mockImplementation(
                    (owner, repo, branch, path) =>
                        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
                ),
            getWorkContents: jest
                .fn()
                .mockResolvedValue([{ name: 'file.txt', type: 'file', path: 'file.txt' }]),
            createPullRequest: jest.fn().mockResolvedValue({
                id: 'pr-1',
                number: 1,
                title: 'Test PR',
            }),
            getPullRequest: jest.fn().mockResolvedValue({
                id: 'pr-1',
                number: 1,
                title: 'Test PR',
            }),
            mergePullRequest: jest.fn().mockResolvedValue({
                merged: true,
                sha: 'merged-sha',
            }),
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
            pull: jest.fn().mockResolvedValue(undefined),
            add: jest.fn().mockResolvedValue(undefined),
            addAll: jest.fn().mockResolvedValue(undefined),
            commit: jest.fn().mockResolvedValue('new-commit-sha'),
            push: jest.fn().mockResolvedValue(undefined),
            getCurrentBranch: jest.fn().mockResolvedValue('main'),
            getMainBranch: jest.fn().mockResolvedValue('main'),
            switchBranch: jest.fn().mockResolvedValue('develop'),
            getStatus: jest.fn().mockResolvedValue([]),
            getCloneUrl: jest
                .fn()
                .mockImplementation((owner, repo) => `https://github.com/${owner}/${repo}.git`),
            getWebUrl: jest
                .fn()
                .mockImplementation((owner, repo) => `https://github.com/${owner}/${repo}`),
            getLocalDir: jest.fn().mockImplementation((owner, repo) => `/tmp/${owner}/${repo}`),
            removeLocalDir: jest.fn().mockResolvedValue(undefined),
            // OAuth methods (optional)
            ...(supportsOAuth
                ? {
                      getAuthorizationUrl: jest
                          .fn()
                          .mockReturnValue('https://github.com/login/oauth/authorize?state=test'),
                      exchangeCodeForToken: jest.fn().mockResolvedValue({
                          accessToken: 'token-123',
                          tokenType: 'bearer',
                          expiresIn: 3600,
                      }),
                      getAuthenticatedUser: jest.fn().mockResolvedValue({
                          id: 'oauth-user-123',
                          username: 'oauthuser',
                          email: 'oauth@example.com',
                      }),
                  }
                : {}),
        }) as unknown as IGitProviderPlugin & Partial<IOAuthPlugin>;

    const createRegisteredPlugin = (
        plugin: IGitProviderPlugin,
        manifest: Partial<PluginManifest>,
        state: RegisteredPlugin['state'] = 'loaded',
    ): RegisteredPlugin => ({
        plugin: plugin as any,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test git provider plugin',
            category: plugin.category,
            capabilities: manifest.capabilities || [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            autoEnable: manifest.autoEnable ?? true,
            ...manifest,
        } as PluginManifest,
        state,
        builtIn: manifest.builtIn ?? false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    const createMockProviderAccount = (overrides: Partial<any> = {}) =>
        ({
            id: 'account-1',
            userId: 'user-123',
            accountId: 'github-user-123',
            providerId: 'github',
            accessToken: 'access-token-123',
            refreshToken: 'refresh-token-123',
            accessTokenExpiresAt: new Date(Date.now() + 3600000), // 1 hour from now
            refreshTokenExpiresAt: null,
            username: 'testuser',
            email: 'test@example.com',
            tokenType: 'Bearer',
            scope: 'repo,user',
            metadata: { login: 'testuser' },
            createdAt: new Date(),
            updatedAt: new Date(),
            ...overrides,
        }) as any;

    const createMockResolvedSetting = (
        key: string,
        value: unknown,
        source: 'default' | 'env' | 'admin' | 'user' | 'work' = 'user',
    ) => ({
        key,
        value,
        source,
        isFallback: false,
    });

    const createMockResolvedSettings = (
        overrides: Partial<ResolvedSettings> = {},
    ): ResolvedSettings => ({
        ...overrides,
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GitFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: AuthAccountRepository,
                    useValue: {
                        findProviderAccount: jest.fn(),
                        findConnectedProviderAccount: jest.fn(
                            async (userId, providerId, options = {}) => {
                                const providerIds = options.usePluginProviderId
                                    ? [`plugin:${providerId}`, providerId]
                                    : [providerId];

                                for (const candidateProviderId of providerIds) {
                                    const account = await authAccountRepository.findProviderAccount(
                                        userId,
                                        candidateProviderId,
                                    );
                                    if (
                                        account?.accessToken &&
                                        !authAccountRepository.isAccessTokenExpired(account) &&
                                        authAccountRepository.hasRequiredScopes(
                                            account,
                                            options.requiredScopes ?? [],
                                        )
                                    ) {
                                        return account;
                                    }
                                }

                                return null;
                            },
                        ),
                        isAccessTokenExpired: jest.fn().mockReturnValue(false),
                        hasRequiredScopes: jest.fn().mockReturnValue(true),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: {
                        getResolvedSettings: jest.fn().mockResolvedValue({}),
                    },
                },
                {
                    provide: WorkRepository,
                    useValue: {
                        findById: jest.fn().mockResolvedValue(null),
                    },
                },
                {
                    provide: GitHubAppInstallationRepository,
                    useValue: {
                        findByInstallationId: jest.fn().mockResolvedValue(null),
                    },
                },
            ],
        }).compile();

        service = module.get<GitFacadeService>(GitFacadeService);
        registry = module.get(PluginRegistryService);
        authAccountRepository = module.get(AuthAccountRepository);
        settingsService = module.get(PluginSettingsService);
        workRepository = module.get(WorkRepository);
        gitHubAppInstallationRepository = module.get(GitHubAppInstallationRepository);
        jest.mocked(requestGitHubAppInstallationAccessTokenDetails).mockReset();
    });

    describe('isConfigured', () => {
        it('should return true when git provider plugin is enabled', () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(true);
        });

        it('should return false when no git provider plugins exist', () => {
            registry.getByCapability.mockReturnValue([]);

            expect(service.isConfigured()).toBe(false);
        });

        it('should return false when git provider plugin is not enabled', () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(
                gitPlugin,
                { capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER] },
                'unloaded',
            );
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('getAvailableProviders', () => {
        it('should return list of available git providers', () => {
            const github = createMockGitPlugin('github', 'GitHub');
            const gitlab = createMockGitPlugin('gitlab', 'GitLab');

            const githubRegistered = createRegisteredPlugin(github, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            const gitlabRegistered = createRegisteredPlugin(
                gitlab,
                { capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER] },
                'unloaded',
            );

            registry.getByCapability.mockReturnValue([githubRegistered, gitlabRegistered]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(2);
            expect(providers[0]).toEqual({
                id: 'github',
                name: 'GitHub',
                enabled: true,
                icon: undefined,
                description: 'Test git provider plugin',
                homepage: undefined,
            });
            expect(providers[1]).toEqual({
                id: 'gitlab',
                name: 'GitLab',
                enabled: false,
                icon: undefined,
                description: 'Test git provider plugin',
                homepage: undefined,
            });
        });

        it('should return empty array when no providers exist', () => {
            registry.getByCapability.mockReturnValue([]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(0);
        });
    });

    describe('hasValidCredentials', () => {
        it('should return true when token is directly provided', async () => {
            const result = await service.hasValidCredentials({
                providerId: 'github',
                token: 'direct-token',
            });

            expect(result).toBe(true);
        });

        it('should return false when no userId or providerId', async () => {
            const result = await service.hasValidCredentials({
                providerId: '',
                token: '',
            });

            expect(result).toBe(false);
        });

        it('should return true when valid OAuth token exists', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(
                createMockProviderAccount(),
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);

            const result = await service.hasValidCredentials({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBe(true);
        });

        it('should return false when OAuth token is expired', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(
                createMockProviderAccount(),
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(true);

            const result = await service.hasValidCredentials({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBe(false);
        });

        it('should return false when provider account is missing required git scopes', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(
                createMockProviderAccount({ scope: 'read:user,user:email' }),
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);
            authAccountRepository.hasRequiredScopes.mockReturnValue(false);

            const result = await service.hasValidCredentials({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBe(false);
        });

        it('should return false when no OAuth token exists', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);

            const result = await service.hasValidCredentials({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBe(false);
        });
    });

    describe('getAccessToken', () => {
        it('should return provided token if available', async () => {
            const result = await service.getAccessToken({
                providerId: 'github',
                token: 'direct-token',
            });

            expect(result).toBe('direct-token');
        });

        it('should return null when no userId or providerId', async () => {
            const result = await service.getAccessToken({
                providerId: '',
                token: '',
            });

            expect(result).toBeNull();
        });

        it('should return provider access token when valid', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const mockToken = createMockProviderAccount({ accessToken: 'oauth-access-token' });
            authAccountRepository.findProviderAccount.mockResolvedValue(mockToken);
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);

            const result = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBe('oauth-access-token');
        });

        it('should return null when provider account token is expired', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(
                createMockProviderAccount(),
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(true);

            const result = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBeNull();
        });

        it('should prefer plugin-integration account over sign-in account', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockImplementation(
                async (_userId: string, providerId: string) => {
                    if (providerId === 'plugin:github') {
                        return createMockProviderAccount({
                            accessToken: 'plugin-token',
                            scope: 'repo,user',
                        });
                    }
                    return createMockProviderAccount({
                        accessToken: 'signin-token',
                        scope: 'repo,user',
                    });
                },
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);

            const result = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBe('plugin-token');
        });

        it('should fall back to sign-in account when plugin-integration account is missing', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockImplementation(
                async (_userId: string, providerId: string) => {
                    if (providerId === 'plugin:github') return null;
                    return createMockProviderAccount({
                        accessToken: 'signin-token',
                        scope: 'repo,user',
                    });
                },
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);

            const result = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBe('signin-token');
        });

        it('should return null when provider account is missing required git scopes', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(
                createMockProviderAccount({ scope: 'read:user,user:email' }),
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);
            authAccountRepository.hasRequiredScopes.mockReturnValue(false);

            const result = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBeNull();
        });

        it('should cache GitHub App installation tokens for linked works', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            process.env.GITHUB_APP_ID = 'app-123';
            process.env.GITHUB_APP_PRIVATE_KEY =
                '-----BEGIN PRIVATE KEY-----\\nmock\\n-----END PRIVATE KEY-----';
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);
            workRepository.findById.mockResolvedValue({
                sourceRepository: {
                    auth: {
                        mode: 'github_app_installation',
                        installationId: 'inst-123',
                    },
                },
            } as any);
            gitHubAppInstallationRepository.findByInstallationId.mockResolvedValue({
                installationId: 'inst-123',
                deletedAt: null,
                suspendedAt: null,
            } as any);
            jest.mocked(requestGitHubAppInstallationAccessTokenDetails).mockResolvedValue({
                token: 'installation-token',
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });

            const firstToken = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
                workId: 'dir-123',
            });
            const secondToken = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
                workId: 'dir-123',
            });

            expect(firstToken).toBe('installation-token');
            expect(secondToken).toBe('installation-token');
            expect(requestGitHubAppInstallationAccessTokenDetails).toHaveBeenCalledTimes(1);

            delete process.env.GITHUB_APP_ID;
            delete process.env.GITHUB_APP_PRIVATE_KEY;
        });

        it('should not return cached installation tokens for suspended installations', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            process.env.GITHUB_APP_ID = 'app-123';
            process.env.GITHUB_APP_PRIVATE_KEY =
                '-----BEGIN PRIVATE KEY-----\\nmock\\n-----END PRIVATE KEY-----';
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);
            workRepository.findById.mockResolvedValue({
                sourceRepository: {
                    auth: {
                        mode: 'github_app_installation',
                        installationId: 'inst-123',
                    },
                },
            } as any);

            gitHubAppInstallationRepository.findByInstallationId
                .mockResolvedValueOnce({
                    installationId: 'inst-123',
                    deletedAt: null,
                    suspendedAt: null,
                } as any)
                .mockResolvedValueOnce({
                    installationId: 'inst-123',
                    deletedAt: null,
                    suspendedAt: new Date(),
                } as any);

            jest.mocked(requestGitHubAppInstallationAccessTokenDetails).mockResolvedValue({
                token: 'installation-token',
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            });

            const firstToken = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
                workId: 'dir-123',
            });
            const secondToken = await service.getAccessToken({
                providerId: 'github',
                userId: 'user-123',
                workId: 'dir-123',
            });

            expect(firstToken).toBe('installation-token');
            expect(secondToken).toBeNull();
            expect(requestGitHubAppInstallationAccessTokenDetails).toHaveBeenCalledTimes(1);

            delete process.env.GITHUB_APP_ID;
            delete process.env.GITHUB_APP_PRIVATE_KEY;
        });
    });

    describe('getCommitter', () => {
        it('should return null when no userId or providerId', async () => {
            const result = await service.getCommitter({
                providerId: '',
                token: '',
            });

            expect(result).toBeNull();
        });

        it('should return committer with username and email', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const mockToken = createMockProviderAccount({
                username: 'testuser',
                email: 'test@example.com',
                metadata: { login: 'testuser' },
            });
            authAccountRepository.findProviderAccount.mockResolvedValue(mockToken);

            const result = await service.getCommitter({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toEqual({ name: 'testuser', email: 'test@example.com' });
        });

        it('should return null when provider account has no username or email', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const mockToken = createMockProviderAccount({
                username: undefined,
                email: undefined,
                metadata: {},
            });
            authAccountRepository.findProviderAccount.mockResolvedValue(mockToken);

            const result = await service.getCommitter({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(result).toBeNull();
        });
    });

    describe('getUser', () => {
        it('should call plugin.getUser with resolved token', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.getUser({
                providerId: 'github',
                token: 'test-token',
            });

            expect(gitPlugin.getUser).toHaveBeenCalledWith('test-token');
            expect(result.login).toBe('testuser');
        });

        it('should throw when no credentials', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.getUser({
                    providerId: 'github',
                    userId: 'test-user',
                }),
            ).rejects.toThrow(GitFacadeError);
        });
    });

    describe('getOrganizations', () => {
        it('should call plugin.getOrganizations with resolved token', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.getOrganizations({
                providerId: 'github',
                token: 'test-token',
            });

            expect(gitPlugin.getOrganizations).toHaveBeenCalledWith('test-token');
            expect(result).toHaveLength(1);
            expect(result[0].login).toBe('test-org');
        });
    });

    describe('listRepositories', () => {
        it('should call plugin.listRepositories with pagination', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await service.listRepositories({ providerId: 'github', token: 'test-token' }, 1, 20);

            expect(gitPlugin.listRepositories).toHaveBeenCalledWith('test-token', 1, 20, undefined);
        });

        it('should return empty array when listRepositories not supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.listRepositories = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.listRepositories({
                providerId: 'github',
                token: 'test-token',
            });

            expect(result).toEqual([]);
        });
    });

    describe('createRepository', () => {
        it('should call plugin.createRepository', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.createRepository(
                { name: 'new-repo', isPrivate: false },
                { providerId: 'github', token: 'test-token' },
            );

            expect(gitPlugin.createRepository).toHaveBeenCalledWith(
                { name: 'new-repo', isPrivate: false },
                'test-token',
            );
            expect(result.name).toBe('new-repo');
        });
    });

    describe('deleteRepository', () => {
        it('should call plugin.deleteRepository', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await service.deleteRepository('owner', 'repo', {
                providerId: 'github',
                token: 'test-token',
            });

            expect(gitPlugin.deleteRepository).toHaveBeenCalledWith('owner', 'repo', 'test-token');
        });
    });

    describe('updateRepository', () => {
        it('should call plugin.updateRepository when supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await service.updateRepository(
                'owner',
                'repo',
                { isPrivate: true },
                {
                    providerId: 'github',
                    token: 'test-token',
                },
            );

            expect(gitPlugin.updateRepository).toHaveBeenCalledWith(
                'owner',
                'repo',
                { isPrivate: true },
                'test-token',
            );
        });

        it('should throw GitFacadeError when not supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.updateRepository = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.updateRepository(
                    'owner',
                    'repo',
                    { isPrivate: true },
                    {
                        providerId: 'github',
                        token: 'test-token',
                    },
                ),
            ).rejects.toThrow(GitFacadeError);
        });
    });

    describe('forkRepository', () => {
        it('should call plugin.forkRepository when supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await service.forkRepository(
                'owner',
                'repo',
                {},
                {
                    providerId: 'github',
                    token: 'test-token',
                },
            );

            expect(gitPlugin.forkRepository).toHaveBeenCalled();
        });

        it('should throw GitFacadeError when not supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.forkRepository = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.forkRepository(
                    'owner',
                    'repo',
                    {},
                    {
                        providerId: 'github',
                        token: 'test-token',
                    },
                ),
            ).rejects.toThrow(GitFacadeError);
        });
    });

    describe('createRepositoryFromTemplate', () => {
        it('should call plugin.createRepositoryFromTemplate when supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await service.createRepositoryFromTemplate(
                'template-owner',
                'template-repo',
                { name: 'new-repo', isPrivate: false },
                { providerId: 'github', token: 'test-token' },
            );

            expect(gitPlugin.createRepositoryFromTemplate).toHaveBeenCalled();
        });

        it('should throw GitFacadeError when not supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.createRepositoryFromTemplate = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.createRepositoryFromTemplate(
                    'owner',
                    'repo',
                    { name: 'new', isPrivate: false },
                    { providerId: 'github', token: 'test-token' },
                ),
            ).rejects.toThrow(GitFacadeError);
        });
    });

    describe('hasForkRelationship', () => {
        it('should return result from plugin', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.hasForkRelationship(
                'fork-owner',
                'fork-repo',
                'parent-owner',
                'parent-repo',
                { providerId: 'github', token: 'test-token' },
            );

            expect(result).toBe(true);
            expect(gitPlugin.hasForkRelationship).toHaveBeenCalled();
        });

        it('should return false when not supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.hasForkRelationship = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.hasForkRelationship(
                'fork-owner',
                'fork-repo',
                'parent-owner',
                'parent-repo',
                { providerId: 'github', token: 'test-token' },
            );

            expect(result).toBe(false);
        });
    });

    describe('repositoryExists', () => {
        it('should call plugin.repositoryExists', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.repositoryExists('owner', 'repo', {
                providerId: 'github',
                token: 'test-token',
            });

            expect(result).toBe(true);
            expect(gitPlugin.repositoryExists).toHaveBeenCalled();
        });

        it('should fallback to getRepository check', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.repositoryExists = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.repositoryExists('owner', 'repo', {
                providerId: 'github',
                token: 'test-token',
            });

            expect(result).toBe(true);
            expect(gitPlugin.getRepository).toHaveBeenCalledWith('owner', 'repo', 'test-token');
        });
    });

    describe('listBranches', () => {
        it('should return branches from plugin', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.listBranches('owner', 'repo', {
                providerId: 'github',
                token: 'test-token',
            });

            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('main');
        });
    });

    describe('createBranch', () => {
        it('should call plugin.createBranch when supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.createBranch('owner', 'repo', 'feature', 'main', {
                providerId: 'github',
                token: 'test-token',
            });

            expect(result.name).toBe('feature');
            expect(gitPlugin.createBranch).toHaveBeenCalled();
        });

        it('should throw when not supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.createBranch = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.createBranch('owner', 'repo', 'feature', 'main', {
                    providerId: 'github',
                    token: 'test-token',
                }),
            ).rejects.toThrow(GitFacadeError);
        });
    });

    describe('deleteBranch', () => {
        it('should call plugin.deleteBranch when supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await service.deleteBranch('owner', 'repo', 'feature', {
                providerId: 'github',
                token: 'test-token',
            });

            expect(gitPlugin.deleteBranch).toHaveBeenCalled();
        });

        it('should throw when not supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.deleteBranch = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.deleteBranch('owner', 'repo', 'feature', {
                    providerId: 'github',
                    token: 'test-token',
                }),
            ).rejects.toThrow(GitFacadeError);
        });
    });

    describe('getLatestCommit', () => {
        it('should return commit when supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.getLatestCommit('owner', 'repo', 'main', {
                providerId: 'github',
                token: 'test-token',
            });

            expect(result?.sha).toBe('abc123');
        });

        it('should return null when not supported', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.getLatestCommit = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.getLatestCommit('owner', 'repo', 'main', {
                providerId: 'github',
                token: 'test-token',
            });

            expect(result).toBeNull();
        });
    });

    describe('cloneOrPull', () => {
        it('should call plugin.cloneOrPull with token', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.cloneOrPull(
                { owner: 'testuser', repo: 'test-repo' },
                { providerId: 'github', token: 'test-token' },
            );

            expect(result).toBe('/tmp/repo');
            expect(gitPlugin.cloneOrPull).toHaveBeenCalledWith(
                expect.objectContaining({
                    owner: 'testuser',
                    repo: 'test-repo',
                    token: 'test-token',
                }),
            );
        });
    });

    describe('add', () => {
        it('should call plugin.add synchronously', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            await service.add('github', '/tmp/repo', ['file.txt']);

            expect(gitPlugin.add).toHaveBeenCalledWith('/tmp/repo', ['file.txt']);
        });
    });

    describe('addAll', () => {
        it('should call plugin.addAll synchronously', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            await service.addAll('github', '/tmp/repo');

            expect(gitPlugin.addAll).toHaveBeenCalledWith('/tmp/repo');
        });
    });

    describe('commit', () => {
        it('should call plugin.commit with committer', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const committer: GitCommitter = { name: 'Test', email: 'test@example.com' };
            const result = await service.commit('github', '/tmp/repo', 'Test commit', committer);

            expect(result).toBe('new-commit-sha');
            expect(gitPlugin.commit).toHaveBeenCalledWith('/tmp/repo', 'Test commit', committer);
        });
    });

    describe('push', () => {
        it('should call plugin.push with token', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await service.push({ dir: '/tmp/repo' }, { providerId: 'github', token: 'test-token' });

            expect(gitPlugin.push).toHaveBeenCalledWith(
                expect.objectContaining({
                    dir: '/tmp/repo',
                    token: 'test-token',
                }),
            );
        });
    });

    describe('getCloneUrl', () => {
        it('should return clone URL from plugin', () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = service.getCloneUrl('github', 'owner', 'repo');

            expect(result).toBe('https://github.com/owner/repo.git');
        });
    });

    describe('getWebUrl', () => {
        it('should return web URL from plugin', () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = service.getWebUrl('github', 'owner', 'repo');

            expect(result).toBe('https://github.com/owner/repo');
        });
    });

    describe('getLocalDir', () => {
        it('should return local work path', () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = service.getLocalDir('github', 'owner', 'repo');

            expect(result).toBe('/tmp/owner/repo');
        });
    });

    describe('getRawFileUrl', () => {
        it('should return raw file URL when supported', () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = service.getRawFileUrl('github', 'owner', 'repo', 'main', 'file.txt');

            expect(result).toBe('https://raw.githubusercontent.com/owner/repo/main/file.txt');
        });

        it('should throw when not supported', () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            gitPlugin.getRawFileUrl = undefined as any;
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.getByCapability.mockReturnValue([registered]);

            expect(() =>
                service.getRawFileUrl('github', 'owner', 'repo', 'main', 'file.txt'),
            ).toThrow(GitFacadeError);
        });
    });

    describe('resolvePlugin', () => {
        it('should throw GitFacadeError when providerId is missing', async () => {
            await expect(service.getUser({ providerId: '', token: '' })).rejects.toThrow(
                GitFacadeError,
            );
        });

        it('should throw GitProviderNotFoundError for invalid providerId', async () => {
            registry.get.mockReturnValue(undefined);

            await expect(
                service.getUser({ providerId: 'non-existent', token: 'token' }),
            ).rejects.toThrow(GitProviderNotFoundError);
        });

        it('should return plugin when providerId is valid and enabled', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.getUser({
                providerId: 'github',
                token: 'test-token',
            });

            expect(result.login).toBe('testuser');
        });

        it('should respect work-level enable/disable via registry', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            await expect(
                service.getUser({
                    providerId: 'github',
                    workId: 'dir-123',
                    token: 'test-token',
                }),
            ).rejects.toThrow(GitProviderNotFoundError);
        });

        it('should respect user-level enable/disable via registry', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(false);

            await expect(
                service.getUser({
                    providerId: 'github',
                    userId: 'user-123',
                    token: 'test-token',
                }),
            ).rejects.toThrow(GitProviderNotFoundError);
        });

        it('should use plugin when registry returns enabled', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
                autoEnable: true,
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);
            registry.isPluginEnabledForScope.mockResolvedValue(true);

            const result = await service.getUser({
                providerId: 'github',
                userId: 'user-123',
                workId: 'dir-123',
                token: 'test-token',
            });

            expect(result.login).toBe('testuser');
        });
    });

    describe('resolvePluginAndToken', () => {
        it('should use provided token when available', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await service.getUser({
                providerId: 'github',
                token: 'provided-token',
            });

            expect(gitPlugin.getUser).toHaveBeenCalledWith('provided-token');
            expect(authAccountRepository.findProviderAccount).not.toHaveBeenCalled();
        });

        it('should lookup OAuth token when userId provided', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const mockToken = createMockProviderAccount({ accessToken: 'oauth-token' });
            authAccountRepository.findProviderAccount.mockResolvedValue(mockToken);
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);

            await service.getUser({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(gitPlugin.getUser).toHaveBeenCalledWith('oauth-token');
            // The facade prefers the plugin-integration account (broader scopes);
            // the first lookup uses the `plugin:` namespaced provider id.
            expect(authAccountRepository.findProviderAccount).toHaveBeenCalledWith(
                'user-123',
                'plugin:github',
            );
        });

        it('should throw NoGitCredentialsError when no token found and no PAT', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);
            settingsService.getResolvedSettings.mockResolvedValue(createMockResolvedSettings({}));

            await expect(
                service.getUser({
                    providerId: 'github',
                    userId: 'user-123',
                }),
            ).rejects.toThrow(NoGitCredentialsError);
        });

        it('should throw NoGitCredentialsError when token is expired and no PAT', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(
                createMockProviderAccount(),
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(true);
            settingsService.getResolvedSettings.mockResolvedValue(createMockResolvedSettings({}));

            await expect(
                service.getUser({
                    providerId: 'github',
                    userId: 'user-123',
                }),
            ).rejects.toThrow(NoGitCredentialsError);
        });

        it('should throw NoGitCredentialsError when provider account is missing required git scopes and no PAT', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(
                createMockProviderAccount({
                    accessToken: 'social-login-token',
                    scope: 'read:user,user:email',
                }),
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);
            authAccountRepository.hasRequiredScopes.mockReturnValue(false);
            settingsService.getResolvedSettings.mockResolvedValue(createMockResolvedSettings({}));

            await expect(
                service.getUser({
                    providerId: 'github',
                    userId: 'user-123',
                }),
            ).rejects.toThrow(NoGitCredentialsError);
        });

        it('should throw GitFacadeError when no token and no userId', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            await expect(
                service.getUser({
                    providerId: 'github',
                    token: '',
                }),
            ).rejects.toThrow(GitFacadeError);
        });
    });

    describe('PAT fallback', () => {
        it('should use PAT from plugin settings when no OAuth token exists', async () => {
            const gitPlugin = createMockGitPlugin('gitlab', 'GitLab', false);
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);
            settingsService.getResolvedSettings.mockResolvedValue(
                createMockResolvedSettings({
                    accessToken: createMockResolvedSetting('accessToken', 'pat-token-123', 'user'),
                }),
            );

            await service.getUser({
                providerId: 'gitlab',
                userId: 'user-123',
            });

            expect(gitPlugin.getUser).toHaveBeenCalledWith('pat-token-123');
        });

        it('should use PAT when OAuth token is expired', async () => {
            const gitPlugin = createMockGitPlugin('gitlab', 'GitLab', false);
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(
                createMockProviderAccount(),
            );
            authAccountRepository.isAccessTokenExpired.mockReturnValue(true);
            settingsService.getResolvedSettings.mockResolvedValue(
                createMockResolvedSettings({
                    accessToken: createMockResolvedSetting('accessToken', 'pat-token-456', 'user'),
                }),
            );

            await service.getUser({
                providerId: 'gitlab',
                userId: 'user-123',
            });

            expect(gitPlugin.getUser).toHaveBeenCalledWith('pat-token-456');
        });

        it('should prefer OAuth token over PAT when both are available', async () => {
            const gitPlugin = createMockGitPlugin('github', 'GitHub');
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            const mockToken = createMockProviderAccount({ accessToken: 'oauth-token' });
            authAccountRepository.findProviderAccount.mockResolvedValue(mockToken);
            authAccountRepository.isAccessTokenExpired.mockReturnValue(false);
            settingsService.getResolvedSettings.mockResolvedValue(
                createMockResolvedSettings({
                    accessToken: createMockResolvedSetting('accessToken', 'pat-token', 'user'),
                }),
            );

            await service.getUser({
                providerId: 'github',
                userId: 'user-123',
            });

            expect(gitPlugin.getUser).toHaveBeenCalledWith('oauth-token');
        });

        it('should throw NoGitCredentialsError when neither OAuth nor PAT available', async () => {
            const gitPlugin = createMockGitPlugin('gitlab', 'GitLab', false);
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);
            settingsService.getResolvedSettings.mockResolvedValue(createMockResolvedSettings({}));

            await expect(
                service.getUser({
                    providerId: 'gitlab',
                    userId: 'user-123',
                }),
            ).rejects.toThrow(NoGitCredentialsError);
        });

        it('hasValidCredentials should return true when PAT exists in settings', async () => {
            const gitPlugin = createMockGitPlugin('gitlab', 'GitLab', false);
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);
            settingsService.getResolvedSettings.mockResolvedValue(
                createMockResolvedSettings({
                    accessToken: createMockResolvedSetting('accessToken', 'pat-token', 'user'),
                }),
            );

            const result = await service.hasValidCredentials({
                providerId: 'gitlab',
                userId: 'user-123',
            });

            expect(result).toBe(true);
        });

        it('getAccessToken should return PAT when OAuth is not available', async () => {
            const gitPlugin = createMockGitPlugin('gitlab', 'GitLab', false);
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);
            settingsService.getResolvedSettings.mockResolvedValue(
                createMockResolvedSettings({
                    accessToken: createMockResolvedSetting('accessToken', 'pat-token-789', 'user'),
                }),
            );

            const result = await service.getAccessToken({
                providerId: 'gitlab',
                userId: 'user-123',
            });

            expect(result).toBe('pat-token-789');
        });

        it('getCommitter should return committer info from plugin settings', async () => {
            const gitPlugin = createMockGitPlugin('gitlab', 'GitLab', false);
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);
            settingsService.getResolvedSettings.mockResolvedValue(
                createMockResolvedSettings({
                    gitUsername: createMockResolvedSetting('gitUsername', 'gitlab-user', 'user'),
                    gitEmail: createMockResolvedSetting('gitEmail', 'gitlab@example.com', 'user'),
                    accessToken: createMockResolvedSetting('accessToken', 'pat-token', 'user'),
                }),
            );

            const result = await service.getCommitter({
                providerId: 'gitlab',
                userId: 'user-123',
            });

            expect(result).toEqual({ name: 'gitlab-user', email: 'gitlab@example.com' });
        });

        it('getCommitter should fetch from API when PAT exists but no stored committer info', async () => {
            const gitPlugin = createMockGitPlugin('gitlab', 'GitLab', false);
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);
            settingsService.getResolvedSettings.mockResolvedValue(
                createMockResolvedSettings({
                    accessToken: createMockResolvedSetting('accessToken', 'pat-token', 'user'),
                }),
            );

            const result = await service.getCommitter({
                providerId: 'gitlab',
                userId: 'user-123',
            });

            expect(gitPlugin.getUser).toHaveBeenCalledWith('pat-token');
            expect(result).toEqual({ name: 'testuser', email: 'test@example.com' });
        });

        it('should handle work-scoped PAT settings', async () => {
            const gitPlugin = createMockGitPlugin('gitlab', 'GitLab', false);
            const registered = createRegisteredPlugin(gitPlugin, {
                capabilities: [PLUGIN_CAPABILITIES.GIT_PROVIDER],
            });
            registry.get.mockReturnValue(registered);
            registry.getByCapability.mockReturnValue([registered]);

            authAccountRepository.findProviderAccount.mockResolvedValue(null);
            settingsService.getResolvedSettings.mockResolvedValue(
                createMockResolvedSettings({
                    accessToken: createMockResolvedSetting(
                        'accessToken',
                        'work-pat-token',
                        'work',
                    ),
                }),
            );

            await service.getUser({
                providerId: 'gitlab',
                userId: 'user-123',
                workId: 'dir-123',
            });

            expect(settingsService.getResolvedSettings).toHaveBeenCalledWith('gitlab', {
                userId: 'user-123',
                workId: 'dir-123',
                includeSecrets: true,
            });
            expect(gitPlugin.getUser).toHaveBeenCalledWith('work-pat-token');
        });
    });

    describe('error classes', () => {
        it('NoGitProviderError should have correct name and message', () => {
            const error = new NoGitProviderError();
            expect(error.name).toBe('NoGitProviderError');
            expect(error.message).toContain('No Git provider');
        });

        it('GitProviderNotFoundError should include providerId', () => {
            const error = new GitProviderNotFoundError('gitlab');
            expect(error.name).toBe('GitProviderNotFoundError');
            expect(error.message).toContain('gitlab');
            expect(error.provider).toBe('gitlab');
        });

        it('NoGitCredentialsError should include providerId and userId', () => {
            const error = new NoGitCredentialsError('github', 'user-123');
            expect(error.name).toBe('NoGitCredentialsError');
            expect(error.message).toContain('github');
            expect(error.message).toContain('user-123');
        });

        it('GitFacadeError should include operation and provider', () => {
            const error = new GitFacadeError('Test error', 'testOperation', 'github');
            expect(error.name).toBe('GitFacadeError');
            expect(error.operation).toBe('testOperation');
            expect(error.provider).toBe('github');
        });
    });
});
