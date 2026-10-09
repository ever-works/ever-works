import {
    ConflictException,
    ForbiddenException,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';
import { GitHubAppOnboardingService } from './github-app-onboarding.service';
import { GitHubAppService } from './github-app.service';

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
            userCanAccessInstallation: jest.fn().mockResolvedValue(true),
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
            findByUsernameCaseInsensitive: jest.fn(),
            findBySlug: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        };
        // EW-652: minimal allocator stub — identity allocateUsername that
        // mirrors whatever base it's called with. Normalization + collision
        // semantics are covered by the dedicated allocator spec
        // (username-allocator.service.spec.ts).
        const usernameAllocator = {
            allocateUsername: jest.fn().mockImplementation(async (base: string) => base),
            normalize: jest.fn().mockImplementation((s: string) => s),
            suggest: jest.fn(),
        };

        const service = new GitHubAppOnboardingService(
            gitHubAppService as any,
            installationRepository as any,
            userLinkRepository as any,
            authAccountRepository as any,
            userRepository as any,
            usernameAllocator as any,
        );

        return {
            service,
            gitHubAppService,
            installationRepository,
            userLinkRepository,
            authAccountRepository,
            userRepository,
            usernameAllocator,
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

        // Review (CodeRabbit security note on #2578): the signed state carries an
        // installation id chosen by whoever called the PUBLIC setup endpoint.
        // Making the callback succeed without "Email addresses: read" must not
        // let any GitHub login claim a known, still-unclaimed installation.
        it('refuses before any write when the authorizing GitHub user cannot access the installation', async () => {
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
            gitHubAppService.exchangeUserCode.mockResolvedValue({ access_token: 'ghu_token' });
            gitHubAppService.getAuthenticatedGithubUser.mockResolvedValue({
                githubUserId: 'gh-attacker',
                login: 'attacker',
                email: 'attacker@example.com',
                emailVerified: false,
                avatarUrl: null,
                nodeId: null,
            });
            gitHubAppService.userCanAccessInstallation.mockResolvedValue(false);

            await expect(service.completeUserAuth({ code: 'code', state })).rejects.toBeInstanceOf(
                ForbiddenException,
            );

            expect(gitHubAppService.userCanAccessInstallation).toHaveBeenCalledWith(
                'ghu_token',
                '12345',
            );
            expect(userLinkRepository.findByGithubUserId).not.toHaveBeenCalled();
            expect(userRepository.create).not.toHaveBeenCalled();
            expect(userRepository.update).not.toHaveBeenCalled();
            expect(authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
            expect(userLinkRepository.upsertLink).not.toHaveBeenCalled();
            expect(installationRepository.upsertFromGithub).not.toHaveBeenCalled();
            expect(installationRepository.claimOwnershipIfUnassigned).not.toHaveBeenCalled();
        });

        // Prod 2026-10-09 — the App had no "Email addresses: read" permission, so
        // the email is the unverified public profile email. Identity must come
        // from the GitHub user id, never from that email.
        describe('identity resolution with an UNVERIFIED (profile-fallback) email', () => {
            const installation = {
                id: 'installation-row-1',
                installationId: '12345',
                accountLogin: 'acme',
                accountType: 'Organization',
                targetType: 'Organization',
            };
            const existingUser = {
                id: 'user-owner',
                username: 'owner',
                email: 'owner@example.com',
                emailVerified: true,
                registrationProvider: 'github',
                avatar: null,
            };

            const arrange = (overrides: { githubUserId?: string } = {}) => {
                const ctx = createService();
                const state = (ctx.service as any).signState({
                    installationId: '12345',
                    issuedAt: Date.now(),
                });
                ctx.gitHubAppService.exchangeUserCode.mockResolvedValue({
                    access_token: 'ghu_token',
                    scope: '',
                });
                ctx.gitHubAppService.getAuthenticatedGithubUser.mockResolvedValue({
                    githubUserId: overrides.githubUserId ?? '4242',
                    login: 'octo-owner',
                    email: 'owner@example.com',
                    emailVerified: false,
                    avatarUrl: null,
                    nodeId: 'NODE_4242',
                });
                ctx.gitHubAppService.getInstallation.mockResolvedValue({
                    id: 12345,
                    app_slug: 'ever-works',
                    account: { login: 'acme', type: 'Organization' },
                    target_type: 'Organization',
                });
                ctx.installationRepository.upsertFromGithub.mockResolvedValue(installation);
                ctx.installationRepository.claimOwnershipIfUnassigned.mockResolvedValue(
                    installation,
                );
                ctx.userRepository.update.mockImplementation(async (id: string, patch: object) => ({
                    ...existingUser,
                    ...patch,
                    id,
                }));
                return { ...ctx, state };
            };

            it('resolves the user via the `github` auth account (accountId = GitHub id) before any email lookup', async () => {
                const ctx = arrange();
                ctx.userLinkRepository.findByGithubUserId.mockResolvedValue(null);
                ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue({
                    userId: existingUser.id,
                    providerId: 'github',
                    accountId: '4242',
                });
                ctx.userRepository.findById.mockResolvedValue(existingUser);

                const result = await ctx.service.completeUserAuth({
                    code: 'code',
                    state: ctx.state,
                });

                expect(
                    ctx.authAccountRepository.findProviderAccountByAccountId,
                ).toHaveBeenCalledWith('github', '4242');
                expect(ctx.userRepository.findByEmail).not.toHaveBeenCalled();
                expect(ctx.userRepository.create).not.toHaveBeenCalled();
                expect(result.user.id).toBe(existingUser.id);
                // An unverified email never downgrades an already-verified account.
                expect(ctx.userRepository.update).toHaveBeenCalledWith(
                    existingUser.id,
                    expect.objectContaining({ emailVerified: true }),
                );
                expect(ctx.installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalledWith(
                    '12345',
                    existingUser.id,
                    '4242',
                );
            });

            it('resolves the user via the GitHub App user link first (no auth-account or email lookup)', async () => {
                const ctx = arrange();
                ctx.userLinkRepository.findByGithubUserId.mockResolvedValue({
                    userId: existingUser.id,
                    githubUserId: '4242',
                });
                ctx.userRepository.findById.mockResolvedValue(existingUser);

                const result = await ctx.service.completeUserAuth({
                    code: 'code',
                    state: ctx.state,
                });

                expect(result.user.id).toBe(existingUser.id);
                expect(
                    ctx.authAccountRepository.findProviderAccountByAccountId,
                ).not.toHaveBeenCalled();
                expect(ctx.userRepository.findByEmail).not.toHaveBeenCalled();
                expect(ctx.userRepository.create).not.toHaveBeenCalled();
            });

            it('never creates a duplicate user when the `github` auth account exists but its user cannot be loaded', async () => {
                const ctx = arrange();
                ctx.userLinkRepository.findByGithubUserId.mockResolvedValue(null);
                ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue({
                    userId: 'user-gone',
                    providerId: 'github',
                    accountId: '4242',
                });
                ctx.userRepository.findById.mockResolvedValue(null);
                ctx.userRepository.findByEmail.mockResolvedValue(null);

                await expect(
                    ctx.service.completeUserAuth({ code: 'code', state: ctx.state }),
                ).rejects.toBeInstanceOf(ConflictException);

                expect(ctx.userRepository.create).not.toHaveBeenCalled();
                expect(ctx.authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
                expect(ctx.userLinkRepository.upsertLink).not.toHaveBeenCalled();
                expect(
                    ctx.installationRepository.claimOwnershipIfUnassigned,
                ).not.toHaveBeenCalled();
            });

            it('still refuses to LINK the unverified email to an existing user with no GitHub identity', async () => {
                const ctx = arrange();
                ctx.userLinkRepository.findByGithubUserId.mockResolvedValue(null);
                ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue(null);
                ctx.userRepository.findByEmail.mockResolvedValue({
                    ...existingUser,
                    registrationProvider: 'local',
                });

                await expect(
                    ctx.service.completeUserAuth({ code: 'code', state: ctx.state }),
                ).rejects.toBeInstanceOf(UnauthorizedException);

                expect(ctx.userRepository.create).not.toHaveBeenCalled();
                expect(ctx.authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
            });

            it('creates a fresh user with emailVerified=false for a never-seen GitHub id', async () => {
                const ctx = arrange({ githubUserId: '9999' });
                ctx.userLinkRepository.findByGithubUserId.mockResolvedValue(null);
                ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue(null);
                ctx.userRepository.findByEmail.mockResolvedValue(null);
                ctx.userRepository.create.mockImplementation(async (data: object) => ({
                    id: 'user-new',
                    ...data,
                }));

                const result = await ctx.service.completeUserAuth({
                    code: 'code',
                    state: ctx.state,
                });

                expect(ctx.userRepository.create).toHaveBeenCalledTimes(1);
                expect(ctx.userRepository.create).toHaveBeenCalledWith(
                    expect.objectContaining({ email: 'owner@example.com', emailVerified: false }),
                );
                expect(result.user.id).toBe('user-new');
            });
        });

        // Incident replay through the REAL GitHubAppService: /user/emails answers
        // 403 (App installed without "Email addresses: read"). The callback must
        // complete and claim the installation for the owner's existing account.
        it('incident replay: /user/emails 403 no longer fails the callback; the installation is claimed', async () => {
            const ctx = createService();
            const httpService = { get: jest.fn(), post: jest.fn() };
            const realGitHubAppService = new GitHubAppService(httpService as any);
            jest.spyOn(realGitHubAppService, 'exchangeUserCode').mockResolvedValue({
                access_token: 'ghu_token',
            });
            jest.spyOn(realGitHubAppService, 'getInstallation').mockResolvedValue({
                id: 169597044,
                app_slug: 'ever-works',
                account: { login: 'ever-co', type: 'Organization' },
                target_type: 'Organization',
            });
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            httpService.get
                .mockReturnValueOnce(
                    of({
                        data: { id: 4242, login: 'octo-owner', email: 'owner@example.com' },
                    }),
                )
                .mockReturnValueOnce(
                    throwError(
                        () =>
                            new AxiosError(
                                'Request failed with status code 403',
                                AxiosError.ERR_BAD_REQUEST,
                                undefined,
                                {},
                                {
                                    status: 403,
                                    statusText: 'Forbidden',
                                    data: { message: 'Resource not accessible by integration' },
                                    headers: {},
                                    config: { headers: {} } as never,
                                },
                            ),
                    ),
                )
                .mockReturnValueOnce(
                    of({ data: { total_count: 1, installations: [{ id: 169597044 }] } }),
                );
            const service = new GitHubAppOnboardingService(
                realGitHubAppService,
                ctx.installationRepository as any,
                ctx.userLinkRepository as any,
                ctx.authAccountRepository as any,
                ctx.userRepository as any,
                ctx.usernameAllocator as any,
            );
            const owner = { id: 'user-owner', username: 'owner', emailVerified: true };
            const claimed = { id: 'row-1', installationId: '169597044' };
            ctx.userLinkRepository.findByGithubUserId.mockResolvedValue(null);
            ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue({
                userId: owner.id,
            });
            ctx.userRepository.findById.mockResolvedValue(owner);
            ctx.userRepository.update.mockResolvedValue(owner);
            ctx.installationRepository.claimOwnershipIfUnassigned.mockResolvedValue(claimed);

            try {
                const result = await service.completeUserAuth({
                    code: 'code',
                    state: (service as any).signState({
                        installationId: '169597044',
                        issuedAt: Date.now(),
                    }),
                });

                expect(result.installation).toBe(claimed);
                expect(ctx.installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalledWith(
                    '169597044',
                    owner.id,
                    '4242',
                );
                expect(httpService.get).toHaveBeenNthCalledWith(
                    3,
                    'https://api.github.com/user/installations',
                    expect.anything(),
                );
                expect(ctx.userRepository.findByEmail).not.toHaveBeenCalled();
                expect(ctx.userRepository.create).not.toHaveBeenCalled();
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('Email addresses: read'),
                );
            } finally {
                warnSpy.mockRestore();
            }
        });
    });
});
