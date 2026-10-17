import {
    ConflictException,
    ForbiddenException,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { AxiosError } from 'axios';
import { createHash } from 'node:crypto';
import { of, throwError } from 'rxjs';
import { GitHubAppOnboardingService } from './github-app-onboarding.service';
import { GitHubAppService } from './github-app.service';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { PROVIDER_CONNECTED: 'provider_connected' },
    ActivityStatus: { COMPLETED: 'completed' },
}));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));

/** Item 13 — the browser-binding nonce the initiating browser's cookie holds. */
const BINDING = 'browser-binding-nonce';
const TX_MANAGER = { tx: true };

/** A state signed the way `beginSetup` signs it: bound to {@link BINDING}. */
function signBound(service: unknown, payload: Record<string, unknown>): string {
    return (service as { signState(p: Record<string, unknown>): string }).signState({
        binding: createHash('sha256').update(BINDING, 'utf8').digest('base64url'),
        ...payload,
    });
}

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
            // Item 13: the claim runs in one transaction; the doubles hand
            // themselves back as the transaction-bound copies.
            transaction: jest.fn(async (work: (manager: unknown) => Promise<unknown>) =>
                work(TX_MANAGER),
            ),
            withManager: jest.fn(),
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

        const activityLog = {
            log: jest.fn().mockResolvedValue({}),
        };

        for (const repo of [
            installationRepository,
            userLinkRepository,
            authAccountRepository,
            userRepository,
        ] as Array<{ withManager?: jest.Mock }>) {
            repo.withManager = jest.fn(() => repo);
        }

        const service = new GitHubAppOnboardingService(
            gitHubAppService as any,
            installationRepository as any,
            userLinkRepository as any,
            authAccountRepository as any,
            userRepository as any,
            usernameAllocator as any,
            activityLog as any,
        );

        return {
            service,
            gitHubAppService,
            installationRepository,
            userLinkRepository,
            authAccountRepository,
            userRepository,
            usernameAllocator,
            activityLog,
        };
    };

    // Prod 2026-10-17 — App installs made straight from github.com never pass
    // through the setup URL, so the row the verified `installation.created`
    // webhook recorded stayed unclaimed (createdByUserId NULL) and invisible to
    // its owner. The verified webhook path now claims it — for the RECORDED
    // installer only, resolved through OAuth-proven links, never by email.
    describe('claimForRecordedInstaller (verified installation webhook)', () => {
        const INSTALLER = '7001';
        const recordedRow = (overrides: Record<string, unknown> = {}) => ({
            id: 'installation-row-1',
            installationId: '12345',
            accountLogin: 'ever-co',
            targetType: 'Organization',
            createdByUserId: null,
            createdByGithubUserId: INSTALLER,
            deletedAt: null,
            ...overrides,
        });
        const owner = { id: 'user-owner', isActive: true };

        const arrange = (
            links: { link?: string | null; account?: string | null } = {},
            user: unknown = owner,
        ) => {
            const ctx = createService();
            ctx.userLinkRepository.findByGithubUserId.mockResolvedValue(
                links.link ? { userId: links.link, githubUserId: INSTALLER } : null,
            );
            ctx.authAccountRepository.findProviderAccountByAccountId.mockResolvedValue(
                links.account
                    ? { userId: links.account, providerId: 'github', accountId: INSTALLER }
                    : null,
            );
            ctx.userRepository.findById.mockResolvedValue(user);
            ctx.installationRepository.claimOwnershipIfUnassigned.mockImplementation(
                async (_installationId: string, userId: string, githubUserId: string) =>
                    recordedRow({ createdByUserId: userId, createdByGithubUserId: githubUserId }),
            );
            return ctx;
        };

        const expectUntouched = (ctx: ReturnType<typeof arrange>) => {
            expect(ctx.installationRepository.claimOwnershipIfUnassigned).not.toHaveBeenCalled();
            expect(ctx.activityLog.log).not.toHaveBeenCalled();
        };

        it('claims for the user behind the GitHub App user link and records the activity', async () => {
            const ctx = arrange({ link: owner.id });

            const claimed = await ctx.service.claimForRecordedInstaller(recordedRow() as any);

            expect(ctx.userLinkRepository.findByGithubUserId).toHaveBeenCalledWith(INSTALLER);
            expect(ctx.installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalledWith(
                '12345',
                owner.id,
                INSTALLER,
            );
            expect(claimed).toEqual(expect.objectContaining({ createdByUserId: owner.id }));
            expect(ctx.activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: owner.id,
                    actionType: 'provider_connected',
                    action: 'github_app_installation_claimed',
                    status: 'completed',
                    details: expect.objectContaining({
                        installationId: '12345',
                        accountLogin: 'ever-co',
                        githubUserId: INSTALLER,
                        source: 'installation-webhook',
                        matchedBy: ['github-app-user-link'],
                    }),
                }),
            );
            // Identity never comes from an email.
            expect(ctx.userRepository.findByEmail).not.toHaveBeenCalled();
        });

        it('claims for the user behind the linked `github` OAuth account (accountId = GitHub id)', async () => {
            const ctx = arrange({ account: owner.id });

            const claimed = await ctx.service.claimForRecordedInstaller(recordedRow() as any);

            expect(ctx.authAccountRepository.findProviderAccountByAccountId).toHaveBeenCalledWith(
                'github',
                INSTALLER,
            );
            expect(ctx.installationRepository.claimOwnershipIfUnassigned).toHaveBeenCalledWith(
                '12345',
                owner.id,
                INSTALLER,
            );
            expect(claimed).not.toBeNull();
        });

        it('claims when both links agree on the same user', async () => {
            const ctx = arrange({ link: owner.id, account: owner.id });

            await ctx.service.claimForRecordedInstaller(recordedRow() as any);

            expect(ctx.activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    details: expect.objectContaining({
                        matchedBy: ['github-app-user-link', 'github-auth-account'],
                    }),
                }),
            );
        });

        it('leaves the row unclaimed (NULL) when the installer has no linked platform user', async () => {
            const ctx = arrange({});

            await expect(
                ctx.service.claimForRecordedInstaller(recordedRow() as any),
            ).resolves.toBeNull();

            expectUntouched(ctx);
        });

        it('never touches an already-claimed row', async () => {
            const ctx = arrange({ link: owner.id });

            await expect(
                ctx.service.claimForRecordedInstaller(
                    recordedRow({ createdByUserId: 'user-someone-else' }) as any,
                ),
            ).resolves.toBeNull();

            expect(ctx.userLinkRepository.findByGithubUserId).not.toHaveBeenCalled();
            expectUntouched(ctx);
        });

        it('refuses when the installer id matches MORE than one platform user', async () => {
            const ctx = arrange({ link: 'user-a', account: 'user-b' });

            await expect(
                ctx.service.claimForRecordedInstaller(recordedRow() as any),
            ).resolves.toBeNull();

            expect(ctx.userRepository.findById).not.toHaveBeenCalled();
            expectUntouched(ctx);
        });

        it.each([
            [
                'no recorded installer (row created by a non-`created` action)',
                { createdByGithubUserId: null },
            ],
            ['a deleted installation', { deletedAt: new Date('2026-10-17T00:00:00Z') }],
        ])('does nothing for %s', async (_label, overrides) => {
            const ctx = arrange({ link: owner.id });

            await expect(
                ctx.service.claimForRecordedInstaller(recordedRow(overrides) as any),
            ).resolves.toBeNull();

            expect(ctx.userLinkRepository.findByGithubUserId).not.toHaveBeenCalled();
            expectUntouched(ctx);
        });

        it.each([
            ['a linked user that no longer exists', null],
            ['a deactivated user', { id: 'user-owner', isActive: false }],
        ])('refuses %s', async (_label, user) => {
            const ctx = arrange({ link: owner.id }, user);

            await expect(
                ctx.service.claimForRecordedInstaller(recordedRow() as any),
            ).resolves.toBeNull();

            expectUntouched(ctx);
        });

        it('reports nothing claimed when a concurrent claim for someone else won the conditional update', async () => {
            const ctx = arrange({ link: owner.id });
            ctx.installationRepository.claimOwnershipIfUnassigned.mockResolvedValue(
                recordedRow({ createdByUserId: 'user-setup-flow' }),
            );

            await expect(
                ctx.service.claimForRecordedInstaller(recordedRow() as any),
            ).resolves.toBeNull();

            expect(ctx.activityLog.log).not.toHaveBeenCalled();
        });

        it('keeps the claim when the activity log write fails', async () => {
            const ctx = arrange({ link: owner.id });
            ctx.activityLog.log.mockRejectedValue(new Error('activity store down'));
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);

            try {
                await expect(
                    ctx.service.claimForRecordedInstaller(recordedRow() as any),
                ).resolves.toEqual(expect.objectContaining({ createdByUserId: owner.id }));
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.stringContaining('Could not record the activity'),
                );
            } finally {
                warnSpy.mockRestore();
            }
        });
    });

    describe('completeUserAuth', () => {
        it('rejects linking an unverified GitHub email to an existing user', async () => {
            const {
                service,
                gitHubAppService,
                userLinkRepository,
                authAccountRepository,
                userRepository,
            } = createService();
            const state = signBound(service, {
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
                service.completeUserAuth({ binding: BINDING, code: 'code', state }),
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
            const state = signBound(service, {
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
                binding: BINDING,
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
            const state = signBound(service, {
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

            await service.completeUserAuth({ binding: BINDING, code: 'code', state });

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
                const state = signBound(ctx.service, {
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
                const run = () =>
                    ctx.service.completeUserAuth({ binding: BINDING, code: 'code', state });
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
                const state = signBound(ctx.service, {
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
                    binding: BINDING,
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
                    binding: BINDING,
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
                    ctx.service.completeUserAuth({
                        binding: BINDING,
                        code: 'code',
                        state: ctx.state,
                    }),
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
                    ctx.service.completeUserAuth({
                        binding: BINDING,
                        code: 'code',
                        state: ctx.state,
                    }),
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
                    binding: BINDING,
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
                    binding: BINDING,
                    code: 'code',
                    state: signBound(service, {
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

    // 10-09 handover item 13 — the setup state is bound to the browser that
    // started it, and the claim's writes are one transaction.
    describe('browser binding and one transaction (item 13)', () => {
        it('beginSetup hands the web tier a binding nonce and signs only its hash', async () => {
            const { service, gitHubAppService, installationRepository } = createService();
            installationRepository.upsertFromGithub.mockResolvedValue({});
            gitHubAppService.getUserAuthorizationUrl.mockImplementation(
                (state: string) => `https://github.com/login/oauth/authorize?state=${state}`,
            );
            const result = await service.beginSetup({ installationId: '12345' });
            expect(typeof result.binding).toBe('string');
            expect(result.binding.length).toBeGreaterThanOrEqual(40);
            expect(result.bindingTtlSeconds).toBe(600);
            const state = decodeURIComponent(result.url.split('state=')[1]);
            const payload = JSON.parse(
                Buffer.from(state.split('.')[0], 'base64url').toString('utf8'),
            );
            expect(payload.binding).toBe(
                createHash('sha256').update(result.binding, 'utf8').digest('base64url'),
            );
            expect(JSON.stringify(payload)).not.toContain(result.binding);
        });

        it.each([
            ['no binding cookie', undefined],
            ["another browser's binding", 'someone-elses-nonce'],
        ])('refuses a callback with %s before exchanging the code', async (_label, binding) => {
            const { service, gitHubAppService, userRepository } = createService();
            const state = signBound(service, { installationId: '12345', issuedAt: Date.now() });
            await expect(
                service.completeUserAuth({ code: 'code', state, binding: binding ?? null }),
            ).rejects.toThrow('Finish the GitHub App setup in the browser where you started it');
            expect(gitHubAppService.exchangeUserCode).not.toHaveBeenCalled();
            expect(userRepository.create).not.toHaveBeenCalled();
        });

        it('refuses a state signed with the raw secret (no domain separation) or without a binding', async () => {
            const { service } = createService();
            const unbound = (service as any).signState({
                installationId: '12345',
                issuedAt: Date.now(),
            });
            await expect(
                service.completeUserAuth({ code: 'code', state: unbound, binding: BINDING }),
            ).rejects.toThrow('Finish the GitHub App setup in the browser where you started it');
        });

        it('writes the claim through transaction-bound repositories', async () => {
            const {
                service,
                gitHubAppService,
                installationRepository,
                userLinkRepository,
                authAccountRepository,
                userRepository,
            } = createService();
            gitHubAppService.exchangeUserCode.mockResolvedValue({ access_token: 'token' });
            gitHubAppService.getAuthenticatedGithubUser.mockResolvedValue({
                githubUserId: 'gh-1',
                login: 'octo',
                email: null,
                emailVerified: false,
                avatarUrl: null,
                nodeId: null,
            });
            userLinkRepository.findByGithubUserId.mockResolvedValue(null);
            authAccountRepository.findProviderAccountByAccountId.mockResolvedValue(null);
            userRepository.create.mockResolvedValue({ id: 'user-1' });
            installationRepository.claimOwnershipIfUnassigned.mockResolvedValue({
                installationId: '12345',
            });
            const state = signBound(service, { installationId: '12345', issuedAt: Date.now() });

            await service.completeUserAuth({ code: 'code', state, binding: BINDING });

            expect(installationRepository.transaction).toHaveBeenCalledTimes(1);
            for (const repo of [
                installationRepository,
                userLinkRepository,
                authAccountRepository,
                userRepository,
            ]) {
                expect((repo as { withManager?: jest.Mock }).withManager).toHaveBeenCalledWith(
                    TX_MANAGER,
                );
            }
        });
    });
});
