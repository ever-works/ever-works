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
            // Default: an Organization installation (claim authority below).
            getInstallation: jest.fn().mockResolvedValue({
                id: 12345,
                app_slug: 'ever-works',
                account: { id: 999, login: 'acme', type: 'Organization' },
                target_type: 'Organization',
            }),
            getUserAuthorizationUrl: jest.fn(),
            exchangeUserCode: jest.fn(),
            getAuthenticatedGithubUser: jest.fn(),
            isActiveOrgAdmin: jest.fn().mockResolvedValue(true),
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

        // Review (CodeRabbit security notes on #2578): the signed state carries an
        // installation id chosen by whoever called the PUBLIC setup endpoint, and
        // `GET /user/installations` also lists installations a read-only
        // collaborator can merely access. Only someone who could have INSTALLED
        // the App on that account may claim the installation.
        describe('installation claim authority (refused with 403 before any write)', () => {
            const arrange = (
                installation: Record<string, unknown>,
                options: { recordedInstaller?: string | null; githubUserId?: string } = {},
            ) => {
                const ctx = createService();
                const state = (ctx.service as any).signState({
                    installationId: '12345',
                    issuedAt: Date.now(),
                });
                ctx.gitHubAppService.exchangeUserCode.mockResolvedValue({
                    access_token: 'ghu_token',
                });
                ctx.gitHubAppService.getAuthenticatedGithubUser.mockResolvedValue({
                    githubUserId: options.githubUserId ?? '4242',
                    login: 'octo',
                    email: null,
                    emailVerified: false,
                    avatarUrl: null,
                    nodeId: null,
                });
                ctx.gitHubAppService.getInstallation.mockResolvedValue({
                    id: 12345,
                    app_slug: 'ever-works',
                    ...installation,
                });
                ctx.installationRepository.findByInstallationId.mockResolvedValue(
                    options.recordedInstaller === undefined
                        ? null
                        : {
                              installationId: '12345',
                              createdByGithubUserId: options.recordedInstaller,
                          },
                );
                ctx.userLinkRepository.findByGithubUserId.mockResolvedValue(null);
                ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue(null);
                ctx.userRepository.findByEmail.mockResolvedValue(null);
                ctx.userRepository.create.mockImplementation(async (data: object) => ({
                    id: 'user-new',
                    ...data,
                }));
                const row = { id: 'row-1', installationId: '12345' };
                ctx.installationRepository.upsertFromGithub.mockResolvedValue(row);
                ctx.installationRepository.claimOwnershipIfUnassigned.mockResolvedValue(row);
                const run = () => ctx.service.completeUserAuth({ code: 'code', state });
                return { ...ctx, state, run };
            };
            const orgInstallation = {
                account: { id: 999, login: 'acme', type: 'Organization' },
                target_type: 'Organization',
            };
            const userInstallation = (accountId: number) => ({
                account: { id: accountId, login: 'octo', type: 'User' },
                target_type: 'User',
            });
            const expectNothingWritten = (ctx: ReturnType<typeof arrange>) => {
                expect(ctx.userLinkRepository.findByGithubUserId).not.toHaveBeenCalled();
                expect(ctx.userRepository.create).not.toHaveBeenCalled();
                expect(ctx.userRepository.update).not.toHaveBeenCalled();
                expect(ctx.authAccountRepository.upsertProviderAccount).not.toHaveBeenCalled();
                expect(ctx.userLinkRepository.upsertLink).not.toHaveBeenCalled();
                expect(ctx.installationRepository.upsertFromGithub).not.toHaveBeenCalled();
                expect(
                    ctx.installationRepository.claimOwnershipIfUnassigned,
                ).not.toHaveBeenCalled();
            };

            it('org: an active org admin may claim', async () => {
                const ctx = arrange(orgInstallation);
                ctx.gitHubAppService.isActiveOrgAdmin.mockResolvedValue(true);

                await ctx.run();

                expect(ctx.gitHubAppService.isActiveOrgAdmin).toHaveBeenCalledWith(
                    'ghu_token',
                    'acme',
                );
                expect(ctx.installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalledWith(
                    '12345',
                    'user-new',
                    '4242',
                );
            });

            // isActiveOrgAdmin answers false for a non-admin member, an outside
            // (read-only) collaborator, a pending invitation and any membership
            // lookup error alike — see github-app.service.spec.ts.
            it.each([
                ['an org member who is not an admin'],
                ['an outside read-only collaborator'],
                ['a user whose membership lookup failed'],
            ])('org: %s is refused', async () => {
                const ctx = arrange(orgInstallation);
                ctx.gitHubAppService.isActiveOrgAdmin.mockResolvedValue(false);

                await expect(ctx.run()).rejects.toBeInstanceOf(ForbiddenException);

                expectNothingWritten(ctx);
            });

            it('user installation: the account owner may claim, with no membership lookup', async () => {
                const ctx = arrange(userInstallation(4242));

                await ctx.run();

                expect(ctx.gitHubAppService.isActiveOrgAdmin).not.toHaveBeenCalled();
                expect(ctx.installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalled();
            });

            it("user installation: anyone else (e.g. a collaborator on the owner's repos) is refused", async () => {
                const ctx = arrange(userInstallation(5151));

                await expect(ctx.run()).rejects.toBeInstanceOf(ForbiddenException);

                expect(ctx.gitHubAppService.isActiveOrgAdmin).not.toHaveBeenCalled();
                expectNothingWritten(ctx);
            });

            it('user installation without an account id is refused', async () => {
                const ctx = arrange({
                    account: { login: 'octo', type: 'User' },
                    target_type: 'User',
                });

                await expect(ctx.run()).rejects.toBeInstanceOf(ForbiddenException);

                expectNothingWritten(ctx);
            });

            it('recorded installer (installation webhook `sender`) equal to the user may claim, with no membership lookup', async () => {
                const ctx = arrange(orgInstallation, { recordedInstaller: '4242' });
                ctx.gitHubAppService.isActiveOrgAdmin.mockResolvedValue(false);

                await ctx.run();

                expect(ctx.gitHubAppService.isActiveOrgAdmin).not.toHaveBeenCalled();
                expect(ctx.installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalled();
            });

            it('recorded installer different from the user is refused, even for an org admin', async () => {
                const ctx = arrange(orgInstallation, { recordedInstaller: '7777' });
                ctx.gitHubAppService.isActiveOrgAdmin.mockResolvedValue(true);

                await expect(ctx.run()).rejects.toBeInstanceOf(ForbiddenException);

                expect(ctx.gitHubAppService.isActiveOrgAdmin).not.toHaveBeenCalled();
                expectNothingWritten(ctx);
            });

            it('an unsupported target type (e.g. Enterprise) is refused', async () => {
                const ctx = arrange({
                    account: { id: 1, login: 'big-corp', type: 'Enterprise' },
                    target_type: 'Enterprise',
                });

                await expect(ctx.run()).rejects.toBeInstanceOf(ForbiddenException);

                expectNothingWritten(ctx);
            });
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
                account: { id: 1001, login: 'ever-co', type: 'Organization' },
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
                .mockReturnValueOnce(of({ data: { state: 'active', role: 'admin' } }));
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
                    'https://api.github.com/user/memberships/orgs/ever-co',
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
