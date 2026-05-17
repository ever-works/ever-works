jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { USER_LOGIN: 'USER_LOGIN' },
    ActivityStatus: { COMPLETED: 'COMPLETED' },
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/agent/services', () => ({
    ZeroFrictionFunnelService: class ZeroFrictionFunnelService {},
}));

import { AuthController } from './auth.controller';
import type { AuthService } from '../services/auth.service';
import type { AnonymousAuthService } from '../services/anonymous-auth.service';
import type { ClaimAccountService } from '../services/claim-account.service';
import type { CaptchaVerifierService } from '../services/captcha-verifier.service';
import type { SocialAuthService } from '../services/social-auth.service';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import type { AuthProvider } from '../providers/auth-provider.abstract';

describe('AuthController', () => {
    let controller: AuthController;
    let authService: jest.Mocked<
        Pick<
            AuthService,
            | 'assertCanRegister'
            | 'sendVerificationEmail'
            | 'getUserProfile'
            | 'updateUserProfile'
            | 'verifyEmail'
            | 'forgotPassword'
            | 'getUserByPasswordResetToken'
            | 'consumePasswordResetToken'
            | 'validateEmailVerificationToken'
            | 'validatePasswordResetToken'
        >
    >;
    let socialAuth: jest.Mocked<Pick<SocialAuthService, 'getConfiguredProviders'>>;
    let anonymousAuth: jest.Mocked<Pick<AnonymousAuthService, 'createAnonymousUser'>>;
    let claimAccount: jest.Mocked<Pick<ClaimAccountService, 'claim'>>;
    let captchaVerifier: jest.Mocked<
        Pick<CaptchaVerifierService, 'isEnabled' | 'isRequired' | 'verify'>
    >;
    let funnel: { emit: jest.Mock };
    let activityLog: jest.Mocked<Pick<ActivityLogService, 'log'>>;
    let authProvider: jest.Mocked<
        Pick<
            AuthProvider,
            | 'signUpEmail'
            | 'signInEmail'
            | 'signOut'
            | 'signOutAll'
            | 'changePassword'
            | 'setPassword'
            | 'issueSession'
        >
    >;

    beforeEach(() => {
        authService = {
            assertCanRegister: jest.fn().mockResolvedValue(undefined),
            sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
            getUserProfile: jest.fn(),
            updateUserProfile: jest.fn(),
            verifyEmail: jest.fn(),
            forgotPassword: jest.fn(),
            getUserByPasswordResetToken: jest.fn(),
            consumePasswordResetToken: jest.fn().mockResolvedValue(undefined),
            validateEmailVerificationToken: jest.fn(),
            validatePasswordResetToken: jest.fn(),
        } as any;
        socialAuth = { getConfiguredProviders: jest.fn() } as any;
        anonymousAuth = { createAnonymousUser: jest.fn() } as any;
        claimAccount = { claim: jest.fn() } as any;
        // Default: captcha disabled + not-required (dev/test mode) so the
        // existing tests pass through. H-05 added isRequired() — defaults to
        // false here; production tests can override.
        captchaVerifier = {
            isEnabled: jest.fn().mockReturnValue(false),
            isRequired: jest.fn().mockReturnValue(false),
            verify: jest.fn().mockResolvedValue({ success: true, skipped: true }),
        } as any;
        funnel = { emit: jest.fn() };
        activityLog = { log: jest.fn().mockResolvedValue(undefined) } as any;
        authProvider = {
            signUpEmail: jest.fn(),
            signInEmail: jest.fn(),
            signOut: jest.fn().mockResolvedValue(undefined),
            signOutAll: jest.fn().mockResolvedValue(undefined),
            changePassword: jest.fn().mockResolvedValue(undefined),
            setPassword: jest.fn().mockResolvedValue(undefined),
            issueSession: jest.fn(),
        } as any;
        controller = new AuthController(
            authService as unknown as AuthService,
            socialAuth as unknown as SocialAuthService,
            anonymousAuth as unknown as AnonymousAuthService,
            claimAccount as unknown as ClaimAccountService,
            captchaVerifier as unknown as CaptchaVerifierService,
            funnel as any,
            activityLog as unknown as ActivityLogService,
            authProvider as unknown as AuthProvider,
        );
    });

    describe('claim (POST /api/auth/claim) — EW-617 G3', () => {
        it('delegates to claimAccountService and logs activity', async () => {
            const claimed = {
                id: 'u-anon-1',
                email: 'jane@example.com',
                username: 'jane-doe',
                emailVerified: false,
            };
            claimAccount.claim.mockResolvedValue(claimed);

            const req = {
                // L-05: claim endpoint requires isAnonymous=true on the
                // AuthenticatedUser envelope.
                user: { userId: 'u-anon-1', isAnonymous: true },
                ip: '1.2.3.4',
                headers: { 'user-agent': 'jest-agent' },
            };

            const result = await (controller as any).claimAccount(req, {
                email: 'jane@example.com',
                password: 'MySecure123!',
                username: 'jane-doe',
            });

            expect(claimAccount.claim).toHaveBeenCalledWith({
                userId: 'u-anon-1',
                email: 'jane@example.com',
                password: 'MySecure123!',
                username: 'jane-doe',
                emailVerificationCallbackUrl: undefined,
            });
            expect(result).toEqual(claimed);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u-anon-1',
                    action: 'user.account_claimed',
                    ipAddress: '1.2.3.4',
                    userAgent: 'jest-agent',
                }),
            );
        });

        it('passes through emailVerificationCallbackUrl when provided', async () => {
            claimAccount.claim.mockResolvedValue({
                id: 'u-1',
                email: 'a@b.com',
                username: 'a',
                emailVerified: false,
            });

            await (controller as any).claimAccount(
                { user: { userId: 'u-1', isAnonymous: true }, headers: {} },
                {
                    email: 'a@b.com',
                    password: 'MySecure123!',
                    emailVerificationCallbackUrl: 'https://app.ever.works/welcome',
                },
            );

            expect(claimAccount.claim).toHaveBeenCalledWith(
                expect.objectContaining({
                    emailVerificationCallbackUrl: 'https://app.ever.works/welcome',
                }),
            );
        });

        it('rejects with 403 when the bearer-user is NOT anonymous (L-05)', async () => {
            await expect(
                (controller as any).claimAccount(
                    { user: { userId: 'u-real', isAnonymous: false }, headers: {} },
                    { email: 'a@b.com', password: 'MySecure123!' },
                ),
            ).rejects.toThrow(/anonymous/);
            expect(claimAccount.claim).not.toHaveBeenCalled();
        });
    });

    describe('anonymous (POST /api/auth/anonymous) — EW-617 G2', () => {
        it('mints an anonymous session and logs the creation', async () => {
            const tokenResponse = {
                access_token: 'tok-anon-1',
                user: {
                    id: 'u-anon-1',
                    email: null,
                    username: 'anon-deadbeef',
                    isAnonymous: true,
                    anonymousExpiresAt: '2026-05-21T00:00:00.000Z',
                },
            };
            anonymousAuth.createAnonymousUser.mockResolvedValue(tokenResponse as any);

            const req = {
                ip: '1.2.3.4',
                headers: { 'user-agent': 'jest-agent', 'x-forwarded-for': '10.0.0.1, 1.2.3.4' },
            };

            const result = await (controller as any).anonymous(req);

            expect(anonymousAuth.createAnonymousUser).toHaveBeenCalledWith({
                ipAddress: '1.2.3.4',
                userAgent: 'jest-agent',
            });
            expect(result).toEqual(tokenResponse);
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u-anon-1',
                    action: 'user.anonymous_created',
                    ipAddress: '1.2.3.4',
                    userAgent: 'jest-agent',
                }),
            );
        });

        it('falls back to x-forwarded-for first hop when req.ip is missing', async () => {
            anonymousAuth.createAnonymousUser.mockResolvedValue({
                access_token: 'tok',
                user: { id: 'u', email: null, username: 'anon-x', isAnonymous: true },
            } as any);

            const req = {
                headers: { 'x-forwarded-for': ' 8.8.8.8 , 9.9.9.9 ' },
            };

            await (controller as any).anonymous(req);

            expect(anonymousAuth.createAnonymousUser).toHaveBeenCalledWith({
                ipAddress: '8.8.8.8',
                userAgent: null,
            });
        });
    });

    describe('getConfiguredProviders (GET /api/auth/providers)', () => {
        it('returns email/password always-on plus the configured social provider list', () => {
            socialAuth.getConfiguredProviders.mockReturnValue(['github', 'google'] as any);

            expect(controller.getConfiguredProviders()).toEqual({
                emailPassword: true,
                socialProviders: ['github', 'google'],
            });
        });

        it('returns empty socialProviders array when none configured', () => {
            socialAuth.getConfiguredProviders.mockReturnValue([] as any);

            expect(controller.getConfiguredProviders()).toEqual({
                emailPassword: true,
                socialProviders: [],
            });
        });
    });

    describe('register (POST /api/auth/register)', () => {
        const dto: any = {
            username: 'alice',
            email: 'a@b.co',
            password: 'pw',
            emailVerificationCallbackUrl: 'https://app/v',
        };
        const req: any = { headers: { 'user-agent': 'UA' } };

        it('asserts uniqueness, signs up via provider, then sends verification email', async () => {
            const order: string[] = [];
            authService.assertCanRegister.mockImplementation(async () => {
                order.push('assert');
            });
            authProvider.signUpEmail.mockImplementation(async () => {
                order.push('signUp');
                return { user: { id: 'u1' } } as any;
            });
            authService.sendVerificationEmail.mockImplementation(async () => {
                order.push('sendVerification');
                return {} as any;
            });

            const result = await controller.register(dto, req);

            expect(order).toEqual(['assert', 'signUp', 'sendVerification']);
            expect(authService.assertCanRegister).toHaveBeenCalledWith('a@b.co');
            expect(authProvider.signUpEmail).toHaveBeenCalledWith(
                'alice',
                'a@b.co',
                'pw',
                expect.any(Headers),
            );
            expect(authService.sendVerificationEmail).toHaveBeenCalledWith('u1', 'https://app/v');
            expect(result).toEqual({ user: { id: 'u1' } });
        });

        it('does not call signUpEmail or sendVerification if assertCanRegister rejects', async () => {
            authService.assertCanRegister.mockRejectedValue(new Error('Email already exists'));

            await expect(controller.register(dto, req)).rejects.toThrow('Email already exists');
            expect(authProvider.signUpEmail).not.toHaveBeenCalled();
            expect(authService.sendVerificationEmail).not.toHaveBeenCalled();
        });

        it('still returns provider response when sendVerificationEmail rejects (warn-and-swallow)', async () => {
            authProvider.signUpEmail.mockResolvedValue({
                user: { id: 'u1' },
                access_token: 't',
            } as any);
            authService.sendVerificationEmail.mockRejectedValue(new Error('SMTP down'));

            const result = await controller.register(dto, req);

            expect(result).toEqual({ user: { id: 'u1' }, access_token: 't' });
        });

        it('coerces non-Error rejection from sendVerificationEmail to String() in the warn log', async () => {
            authProvider.signUpEmail.mockResolvedValue({ user: { id: 'u1' } } as any);
            authService.sendVerificationEmail.mockRejectedValue('string-error');

            await expect(controller.register(dto, req)).resolves.toEqual({ user: { id: 'u1' } });
        });

        it('treats missing req.headers as empty (no crash on toHeaders)', async () => {
            authProvider.signUpEmail.mockResolvedValue({ user: { id: 'u1' } } as any);

            await expect(controller.register(dto, {} as any)).resolves.toBeDefined();
            const headers = (authProvider.signUpEmail as jest.Mock).mock.calls[0][3];
            expect(headers).toBeInstanceOf(Headers);
        });
    });

    describe('login (POST /api/auth/login)', () => {
        it('returns provider result and emits user.login activity log', async () => {
            authProvider.signInEmail.mockResolvedValue({
                user: { id: 'u1' },
                access_token: 'tok',
            } as any);

            const req: any = { ip: '1.2.3.4', headers: { 'user-agent': 'UA' } };
            const result = await controller.login(req, { email: 'a@b.co', password: 'pw' } as any);

            expect(authProvider.signInEmail).toHaveBeenCalledWith(
                'a@b.co',
                'pw',
                expect.any(Headers),
            );
            expect(result).toEqual({ user: { id: 'u1' }, access_token: 'tok' });
            expect(activityLog.log).toHaveBeenCalledWith({
                userId: 'u1',
                actionType: 'USER_LOGIN',
                action: 'user.login',
                status: 'COMPLETED',
                summary: 'Signed in',
                ipAddress: '1.2.3.4',
                userAgent: 'UA',
            });
        });

        it('falls back to x-forwarded-for when req.ip is empty', async () => {
            authProvider.signInEmail.mockResolvedValue({ user: { id: 'u1' } } as any);

            const req: any = { headers: { 'user-agent': 'UA', 'x-forwarded-for': '5.6.7.8' } };
            await controller.login(req, { email: 'a@b.co', password: 'pw' } as any);

            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({ ipAddress: '5.6.7.8' }),
            );
        });

        it('does NOT emit activity log when signInEmail rejects', async () => {
            authProvider.signInEmail.mockRejectedValue(new Error('Bad credentials'));

            await expect(
                controller.login({ headers: {} } as any, { email: 'a', password: 'b' } as any),
            ).rejects.toThrow('Bad credentials');
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('swallows activity-log rejection (fire-and-forget)', async () => {
            authProvider.signInEmail.mockResolvedValue({ user: { id: 'u1' } } as any);
            activityLog.log.mockRejectedValue(new Error('jitsu'));

            await expect(
                controller.login({ headers: {} } as any, { email: 'a', password: 'b' } as any),
            ).resolves.toEqual({ user: { id: 'u1' } });
        });
    });

    describe('logout (POST /api/auth/logout)', () => {
        it('forwards headers to provider.signOut and returns success message', async () => {
            const req: any = { headers: { authorization: 'Bearer x' } };
            const result = await controller.logout(req);

            expect(authProvider.signOut).toHaveBeenCalledWith(expect.any(Headers));
            expect(result).toEqual({ message: 'Logged out successfully' });
        });

        it('treats missing headers as empty', async () => {
            await expect(controller.logout({} as any)).resolves.toEqual({
                message: 'Logged out successfully',
            });
        });
    });

    describe('logoutAll (POST /api/auth/logout-all)', () => {
        it('forwards req.user.userId to provider.signOutAll and audit-logs the action (L-03)', async () => {
            const req: any = {
                user: { userId: 'u1' },
                ip: '1.2.3.4',
                headers: { 'user-agent': 'jest-agent' },
            };

            const result = await controller.logoutAll(req);

            expect(authProvider.signOutAll).toHaveBeenCalledWith('u1');
            expect(result).toEqual({ message: 'Logged out from all devices successfully' });
            // L-03: forensic audit-log entry.
            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    action: 'user.logout_all',
                    ipAddress: '1.2.3.4',
                    userAgent: 'jest-agent',
                }),
            );
        });
    });

    describe('getProfile (GET /api/auth/profile)', () => {
        it('returns the in-request user verbatim (set by AuthSessionGuard)', async () => {
            const user = { userId: 'u1', email: 'a@b.co' };

            await expect(controller.getProfile({ user } as any)).resolves.toBe(user);
        });
    });

    describe('getFreshProfile (GET /api/auth/profile/fresh)', () => {
        it('forwards userId to authService.getUserProfile', async () => {
            authService.getUserProfile.mockResolvedValue({ id: 'u1', email: 'fresh' } as any);

            const result = await controller.getFreshProfile({ user: { userId: 'u1' } } as any);

            expect(authService.getUserProfile).toHaveBeenCalledWith('u1');
            expect(result).toEqual({ id: 'u1', email: 'fresh' });
        });
    });

    describe('updatePassword (POST /api/auth/update-password)', () => {
        it('forwards (currentPassword, newPassword, headers) to provider.changePassword', async () => {
            const req: any = { headers: { authorization: 'Bearer x' } };
            const result = await controller.updatePassword(req, {
                currentPassword: 'old',
                newPassword: 'new',
            } as any);

            expect(authProvider.changePassword).toHaveBeenCalledWith(
                'old',
                'new',
                expect.any(Headers),
            );
            expect(result).toEqual({ message: 'Password updated successfully' });
        });

        it('propagates provider errors (wrong current password)', async () => {
            authProvider.changePassword.mockRejectedValue(new Error('Bad current password'));

            await expect(
                controller.updatePassword(
                    { headers: {} } as any,
                    {
                        currentPassword: 'x',
                        newPassword: 'y',
                    } as any,
                ),
            ).rejects.toThrow('Bad current password');
        });
    });

    describe('updateProfile (PUT /api/auth/profile)', () => {
        it('forwards (userId, dto) to authService.updateUserProfile', async () => {
            authService.updateUserProfile.mockResolvedValue({ id: 'u1' } as any);

            const result = await controller.updateProfile(
                { user: { userId: 'u1' } } as any,
                {
                    username: 'new',
                } as any,
            );

            expect(authService.updateUserProfile).toHaveBeenCalledWith('u1', { username: 'new' });
            expect(result).toEqual({ id: 'u1' });
        });
    });

    describe('sendVerification (POST /api/auth/send-verification)', () => {
        it('forwards req.user.userId without callback URL', async () => {
            authService.sendVerificationEmail.mockResolvedValue({ ok: true } as any);

            const result = await controller.sendVerification({ user: { userId: 'u1' } } as any);

            // Note: this endpoint deliberately does NOT forward a callback URL
            // (unlike register), so the second arg is missing.
            expect(authService.sendVerificationEmail).toHaveBeenCalledWith('u1');
            expect(result).toEqual({ ok: true });
        });
    });

    describe('verifyEmail (POST /api/auth/verify-email)', () => {
        // H-04: verifyEmail now binds the new session to the requesting client.
        function makeReq() {
            return {
                ip: '203.0.113.5',
                headers: { 'user-agent': 'Mozilla/5.0' },
            } as any;
        }

        it('verifies token, then issues a session bound to the requesting client', async () => {
            authService.verifyEmail.mockResolvedValue({ id: 'u1' } as any);
            authProvider.issueSession.mockResolvedValue({ access_token: 'tok' } as any);

            const result = await controller.verifyEmail({ token: 'verif-tok' } as any, makeReq());

            expect(authService.verifyEmail).toHaveBeenCalledWith('verif-tok');
            expect(authProvider.issueSession).toHaveBeenCalledWith('u1', {
                ipAddress: '203.0.113.5',
                userAgent: 'Mozilla/5.0',
            });
            expect(result).toEqual({ access_token: 'tok' });
        });

        it('does not issue a session when verifyEmail rejects', async () => {
            authService.verifyEmail.mockRejectedValue(new Error('Invalid or expired token'));

            await expect(controller.verifyEmail({ token: 'x' } as any, makeReq())).rejects.toThrow(
                'Invalid or expired token',
            );
            expect(authProvider.issueSession).not.toHaveBeenCalled();
        });
    });

    describe('forgotPassword (POST /api/auth/forgot-password)', () => {
        it('forwards full dto to authService.forgotPassword', async () => {
            authService.forgotPassword.mockResolvedValue({ message: 'sent' } as any);

            const dto: any = { email: 'a@b.co', resetCallbackUrl: 'https://app/r' };
            const result = await controller.forgotPassword(dto);

            expect(authService.forgotPassword).toHaveBeenCalledWith(dto);
            expect(result).toEqual({ message: 'sent' });
        });
    });

    describe('resetPassword (POST /api/auth/reset-password)', () => {
        it('runs token-resolve → setPassword → consumeToken → signOutAll in order, then returns success', async () => {
            const order: string[] = [];
            authService.getUserByPasswordResetToken.mockImplementation(async () => {
                order.push('resolve');
                return { id: 'u1' } as any;
            });
            authProvider.setPassword.mockImplementation(async () => {
                order.push('setPassword');
            });
            authService.consumePasswordResetToken.mockImplementation(async () => {
                order.push('consume');
                return {} as any;
            });
            authProvider.signOutAll.mockImplementation(async () => {
                order.push('signOutAll');
            });

            const result = await controller.resetPassword({
                token: 'reset-tok',
                newPassword: 'newpw',
            } as any);

            expect(order).toEqual(['resolve', 'setPassword', 'consume', 'signOutAll']);
            expect(authService.getUserByPasswordResetToken).toHaveBeenCalledWith('reset-tok');
            expect(authProvider.setPassword).toHaveBeenCalledWith('u1', 'newpw');
            expect(authService.consumePasswordResetToken).toHaveBeenCalledWith('reset-tok');
            expect(authProvider.signOutAll).toHaveBeenCalledWith('u1');
            expect(result).toEqual({ message: 'Password reset successfully' });
        });

        it('aborts when token resolution rejects (token invalid)', async () => {
            authService.getUserByPasswordResetToken.mockRejectedValue(
                new Error('Invalid or expired token'),
            );

            await expect(
                controller.resetPassword({ token: 'bad', newPassword: 'pw' } as any),
            ).rejects.toThrow('Invalid or expired token');

            expect(authProvider.setPassword).not.toHaveBeenCalled();
            expect(authService.consumePasswordResetToken).not.toHaveBeenCalled();
            expect(authProvider.signOutAll).not.toHaveBeenCalled();
        });

        it('aborts before consume/signOut when setPassword rejects', async () => {
            authService.getUserByPasswordResetToken.mockResolvedValue({ id: 'u1' } as any);
            authProvider.setPassword.mockRejectedValue(new Error('Weak password'));

            await expect(
                controller.resetPassword({ token: 't', newPassword: 'pw' } as any),
            ).rejects.toThrow('Weak password');

            expect(authService.consumePasswordResetToken).not.toHaveBeenCalled();
            expect(authProvider.signOutAll).not.toHaveBeenCalled();
        });
    });

    describe('validateEmailVerificationToken (GET /api/auth/validate-email-token)', () => {
        it('passes the token through to the service', async () => {
            authService.validateEmailVerificationToken.mockResolvedValue({ valid: true } as any);

            const result = await controller.validateEmailVerificationToken('tok');

            expect(authService.validateEmailVerificationToken).toHaveBeenCalledWith('tok');
            expect(result).toEqual({ valid: true });
        });
    });

    describe('validatePasswordResetToken (GET /api/auth/validate-reset-token)', () => {
        it('passes the token through to the service', async () => {
            authService.validatePasswordResetToken.mockResolvedValue({ valid: false } as any);

            const result = await controller.validatePasswordResetToken('tok');

            expect(authService.validatePasswordResetToken).toHaveBeenCalledWith('tok');
            expect(result).toEqual({ valid: false });
        });
    });
});
