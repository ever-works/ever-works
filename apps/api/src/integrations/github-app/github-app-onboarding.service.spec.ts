import { UnauthorizedException } from '@nestjs/common';
import { GitHubAppOnboardingService } from './github-app-onboarding.service';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));

describe('GitHubAppOnboardingService', () => {
    beforeAll(() => {
        // H-14: config.auth.secret() now enforces a 32-char minimum, so
        // use a 32+ byte fixture instead of the historic 15-char one.
        process.env.AUTH_SECRET = 'test-auth-secret-test-auth-secret';
    });

    const createService = () => {
        const gitHubAppService = {
            getInstallation: jest.fn(),
            getUserAuthorizationUrl: jest.fn(),
            exchangeUserCode: jest.fn(),
            getAuthenticatedGithubUser: jest.fn(),
        };
        const installationRepository = {
            findByInstallationId: jest.fn(),
            claimOwnershipIfUnassigned: jest.fn(),
            upsertFromGithub: jest.fn(),
        };
        const userLinkRepository = {
            findByGithubUserId: jest.fn(),
            upsertLink: jest.fn(),
        };
        const authAccountRepository = {
            findProviderAccountByAccountId: jest.fn(),
            upsertProviderAccount: jest.fn(),
        };
        const userRepository = {
            findById: jest.fn(),
            findByEmail: jest.fn(),
            findByUsername: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        };

        const service = new GitHubAppOnboardingService(
            gitHubAppService as any,
            installationRepository as any,
            userLinkRepository as any,
            authAccountRepository as any,
            userRepository as any,
        );

        return {
            service,
            gitHubAppService,
            installationRepository,
            userLinkRepository,
            authAccountRepository,
            userRepository,
        };
    };

    describe('completeUserAuth', () => {
        it('rejects linking an unverified GitHub email to an existing user', async () => {
            const {
                service,
                gitHubAppService,
                userLinkRepository,
                authAccountRepository,
                userRepository,
            } = createService();
            const state = (service as any).signState({
                installationId: '12345',
                issuedAt: Date.now(),
            });

            gitHubAppService.exchangeUserCode.mockResolvedValue({
                access_token: 'token',
                scope: 'read:user',
            });
            gitHubAppService.getAuthenticatedGithubUser.mockResolvedValue({
                githubUserId: 'gh-user-1',
                login: 'octocat',
                email: 'user@example.com',
                emailVerified: false,
                avatarUrl: null,
                nodeId: null,
            });
            userLinkRepository.findByGithubUserId.mockResolvedValue(null);
            authAccountRepository.findProviderAccountByAccountId.mockResolvedValue(null);
            userRepository.findByEmail.mockResolvedValue({
                id: 'user-1',
                email: 'user@example.com',
            });

            await expect(
                service.completeUserAuth({
                    code: 'code',
                    state,
                }),
            ).rejects.toBeInstanceOf(UnauthorizedException);

            expect(authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
            expect(userLinkRepository.upsertLink).not.toHaveBeenCalled();
        });

        it('allows linking when the GitHub email is verified', async () => {
            const {
                service,
                gitHubAppService,
                installationRepository,
                userLinkRepository,
                authAccountRepository,
                userRepository,
            } = createService();
            const state = (service as any).signState({
                installationId: '12345',
                issuedAt: Date.now(),
                redirectTo: '/settings/github-app',
            });
            const existingUser = {
                id: 'user-1',
                username: 'existing-user',
                email: 'user@example.com',
                emailVerified: false,
                registrationProvider: 'local',
                avatar: null,
            };
            const updatedUser = {
                ...existingUser,
                emailVerified: true,
                registrationProvider: 'github',
            };
            const installation = {
                id: 'installation-row-1',
                installationId: '12345',
                accountLogin: 'acme',
                accountType: 'Organization',
                targetType: 'Organization',
            };

            gitHubAppService.exchangeUserCode.mockResolvedValue({
                access_token: 'token',
                scope: 'read:user',
            });
            gitHubAppService.getAuthenticatedGithubUser.mockResolvedValue({
                githubUserId: 'gh-user-1',
                login: 'octocat',
                email: 'user@example.com',
                emailVerified: true,
                avatarUrl: 'https://example.com/avatar.png',
                nodeId: 'NODE_1',
            });
            gitHubAppService.getInstallation.mockResolvedValue({
                id: 12345,
                app_slug: 'ever-works',
                account: {
                    login: 'acme',
                    type: 'Organization',
                },
                target_type: 'Organization',
            });
            userLinkRepository.findByGithubUserId.mockResolvedValue(null);
            authAccountRepository.findProviderAccountByAccountId.mockResolvedValue(null);
            userRepository.findByEmail.mockResolvedValue(existingUser);
            userRepository.update.mockResolvedValue(updatedUser);
            installationRepository.upsertFromGithub.mockResolvedValue(installation);
            installationRepository.claimOwnershipIfUnassigned.mockResolvedValue(installation);

            const result = await service.completeUserAuth({
                code: 'code',
                state,
            });

            expect(result.user).toEqual(updatedUser);
            expect(result.installation).toEqual(installation);
            expect(result.redirectTo).toBe('/settings/github-app');
            expect(authAccountRepository.upsertProviderAccount).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: existingUser.id,
                    providerId: 'github',
                    accountId: 'gh-user-1',
                }),
            );
            expect(userLinkRepository.upsertLink).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: existingUser.id,
                    githubUserId: 'gh-user-1',
                }),
            );
            expect(installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalledWith(
                '12345',
                existingUser.id,
                'gh-user-1',
            );
        });

        it('preserves an existing installation owner during callback completion', async () => {
            const {
                service,
                gitHubAppService,
                installationRepository,
                userLinkRepository,
                authAccountRepository,
                userRepository,
            } = createService();
            const state = (service as any).signState({
                installationId: '12345',
                issuedAt: Date.now(),
            });
            const user = {
                id: 'user-2',
                username: 'new-user',
                email: 'new@example.com',
                emailVerified: true,
                registrationProvider: 'github',
                avatar: null,
            };

            gitHubAppService.exchangeUserCode.mockResolvedValue({
                access_token: 'token',
                scope: 'read:user',
            });
            gitHubAppService.getAuthenticatedGithubUser.mockResolvedValue({
                githubUserId: 'gh-user-2',
                login: 'octocat-2',
                email: 'new@example.com',
                emailVerified: true,
                avatarUrl: null,
                nodeId: 'NODE_2',
            });
            gitHubAppService.getInstallation.mockResolvedValue({
                id: 12345,
                app_slug: 'ever-works',
                account: {
                    login: 'acme',
                    type: 'Organization',
                },
                target_type: 'Organization',
            });
            userLinkRepository.findByGithubUserId.mockResolvedValue(null);
            authAccountRepository.findProviderAccountByAccountId.mockResolvedValue(null);
            userRepository.findByEmail.mockResolvedValue(null);
            userRepository.findByUsername.mockResolvedValue(null);
            userRepository.create.mockResolvedValue(user);
            installationRepository.upsertFromGithub.mockResolvedValue({
                id: 'installation-row-1',
                installationId: '12345',
            });
            installationRepository.claimOwnershipIfUnassigned.mockResolvedValue({
                id: 'installation-row-1',
                installationId: '12345',
                createdByUserId: 'user-1',
                createdByGithubUserId: 'gh-user-1',
            });

            await service.completeUserAuth({
                code: 'code',
                state,
            });

            expect(installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalledWith(
                '12345',
                'user-2',
                'gh-user-2',
            );
        });
    });
});
