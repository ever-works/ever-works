jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { USER_LOGIN: 'USER_LOGIN' },
    ActivityStatus: { COMPLETED: 'COMPLETED' },
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));

import { OAuthController } from './oauth.controller';
import type { SocialAuthService } from '../services/social-auth.service';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import type { AuthProvider } from '../providers/auth-provider.abstract';

describe('OAuthController', () => {
    let controller: OAuthController;
    let socialAuth: jest.Mocked<
        Pick<SocialAuthService, 'getAuthorizationUrl' | 'authenticate' | 'getProviderDisplayName'>
    >;
    let activityLog: jest.Mocked<Pick<ActivityLogService, 'log'>>;
    let authProvider: jest.Mocked<Pick<AuthProvider, 'issueSession'>>;

    beforeEach(() => {
        socialAuth = {
            getAuthorizationUrl: jest.fn(),
            authenticate: jest.fn(),
            getProviderDisplayName: jest.fn(),
        } as any;
        activityLog = {
            log: jest.fn().mockResolvedValue(undefined),
        } as any;
        authProvider = {
            issueSession: jest.fn(),
        } as any;
        controller = new OAuthController(
            socialAuth as unknown as SocialAuthService,
            activityLog as unknown as ActivityLogService,
            authProvider as unknown as AuthProvider,
        );
    });

    describe('getAuthUrl (GET /api/oauth/:providerId/url)', () => {
        it('forwards providerId and state and returns { url } envelope', async () => {
            socialAuth.getAuthorizationUrl.mockReturnValue('https://github.com/login/oauth/...');

            const result = await controller.getAuthUrl('github', 'opaque-state');

            expect(socialAuth.getAuthorizationUrl).toHaveBeenCalledWith(
                'github',
                undefined,
                'opaque-state',
            );
            expect(result).toEqual({ url: 'https://github.com/login/oauth/...' });
        });

        it('passes undefined state when not provided', async () => {
            socialAuth.getAuthorizationUrl.mockReturnValue('https://x');

            await controller.getAuthUrl('google', undefined);

            expect(socialAuth.getAuthorizationUrl).toHaveBeenCalledWith(
                'google',
                undefined,
                undefined,
            );
        });

        it('propagates service errors (e.g. unknown provider)', async () => {
            socialAuth.getAuthorizationUrl.mockImplementation(() => {
                throw new Error('Unknown provider: discord');
            });

            await expect(controller.getAuthUrl('discord', undefined)).rejects.toThrow(
                'Unknown provider: discord',
            );
        });
    });

    describe('authRedirect (GET /api/oauth/:providerId/callback)', () => {
        function makeRequest(overrides: { ip?: string; headers?: Record<string, string> } = {}) {
            const hasIp = 'ip' in overrides;
            const hasHeaders = 'headers' in overrides;
            return {
                ip: hasIp ? overrides.ip : '203.0.113.5',
                headers: hasHeaders ? overrides.headers : { 'user-agent': 'Mozilla/5.0' },
            } as any;
        }

        it('exchanges code, issues session, and emits a per-provider login activity log', async () => {
            socialAuth.authenticate.mockResolvedValue({ id: 'u1' } as any);
            socialAuth.getProviderDisplayName.mockReturnValue('GitHub');
            authProvider.issueSession.mockResolvedValue({ access_token: 'tok' } as any);

            const result = await controller.authRedirect('github', 'code-abc', makeRequest());

            expect(socialAuth.authenticate).toHaveBeenCalledWith('github', 'code-abc');
            expect(authProvider.issueSession).toHaveBeenCalledWith('u1');
            expect(result).toEqual({ access_token: 'tok' });

            expect(activityLog.log).toHaveBeenCalledWith({
                userId: 'u1',
                actionType: 'USER_LOGIN',
                action: 'user.login.github',
                status: 'COMPLETED',
                summary: 'Signed in via GitHub',
                ipAddress: '203.0.113.5',
                userAgent: 'Mozilla/5.0',
                metadata: { provider: 'github' },
            });
        });

        it('falls back to x-forwarded-for when req.ip is missing', async () => {
            socialAuth.authenticate.mockResolvedValue({ id: 'u2' } as any);
            socialAuth.getProviderDisplayName.mockReturnValue('Google');
            authProvider.issueSession.mockResolvedValue({ access_token: 't' } as any);

            await controller.authRedirect(
                'google',
                'code',
                makeRequest({
                    ip: undefined as any,
                    headers: { 'user-agent': 'UA', 'x-forwarded-for': '198.51.100.7' },
                }),
            );

            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    ipAddress: '198.51.100.7',
                    userAgent: 'UA',
                    action: 'user.login.google',
                }),
            );
        });

        it('uses provider display name in summary even for non-canonical providerIds', async () => {
            socialAuth.authenticate.mockResolvedValue({ id: 'u3' } as any);
            socialAuth.getProviderDisplayName.mockReturnValue('LinkedIn');
            authProvider.issueSession.mockResolvedValue({ access_token: 't' } as any);

            await controller.authRedirect('linkedin', 'c', makeRequest());

            expect(activityLog.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    summary: 'Signed in via LinkedIn',
                    action: 'user.login.linkedin',
                }),
            );
        });

        it('swallows activity-log rejections (fire-and-forget)', async () => {
            socialAuth.authenticate.mockResolvedValue({ id: 'u1' } as any);
            socialAuth.getProviderDisplayName.mockReturnValue('GitHub');
            authProvider.issueSession.mockResolvedValue({ access_token: 't' } as any);
            activityLog.log.mockRejectedValue(new Error('jitsu down'));

            // Should NOT reject — the .catch(() => {}) on the log call swallows.
            await expect(controller.authRedirect('github', 'c', makeRequest())).resolves.toEqual({
                access_token: 't',
            });
        });

        it('propagates social-auth errors (invalid code)', async () => {
            socialAuth.authenticate.mockRejectedValue(new Error('No access token returned'));

            await expect(controller.authRedirect('github', 'bad', makeRequest())).rejects.toThrow(
                'No access token returned',
            );

            expect(authProvider.issueSession).not.toHaveBeenCalled();
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('propagates issueSession errors', async () => {
            socialAuth.authenticate.mockResolvedValue({ id: 'u1' } as any);
            authProvider.issueSession.mockRejectedValue(new Error('session store down'));

            await expect(controller.authRedirect('github', 'c', makeRequest())).rejects.toThrow(
                'session store down',
            );

            // Activity log emission is registered AFTER issueSession resolves, so it must NOT fire.
            expect(activityLog.log).not.toHaveBeenCalled();
        });
    });
});
