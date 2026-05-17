jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: { USER_LOGIN: 'USER_LOGIN' },
    ActivityStatus: { COMPLETED: 'COMPLETED' },
}));
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));

import { OAuthController } from './oauth.controller';
import { OAuthStateService } from '../services/oauth-state.service';
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
    let oauthState: OAuthStateService;

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
        oauthState = new OAuthStateService();
        controller = new OAuthController(
            socialAuth as unknown as SocialAuthService,
            activityLog as unknown as ActivityLogService,
            oauthState,
            authProvider as unknown as AuthProvider,
        );
    });

    // Express-style Response stub captures Set-Cookie via getHeader/setHeader.
    function makeRes() {
        const headers: Record<string, string | string[]> = {};
        return {
            getHeader: (name: string) => headers[name.toLowerCase()],
            setHeader: (name: string, value: string | string[]) => {
                headers[name.toLowerCase()] = value;
            },
            _headers: headers,
        } as any;
    }

    function makeRequest(overrides: { ip?: string; headers?: Record<string, string> } = {}) {
        const hasIp = 'ip' in overrides;
        const hasHeaders = 'headers' in overrides;
        return {
            ip: hasIp ? overrides.ip : '203.0.113.5',
            headers: hasHeaders ? overrides.headers : { 'user-agent': 'Mozilla/5.0' },
        } as any;
    }

    describe('getAuthUrl (GET /api/oauth/:providerId/url)', () => {
        // C-03: server now mints state; client-supplied state is ignored.
        it('mints a server-side state nonce, sets the cookie, and embeds the nonce in the OAuth URL', async () => {
            socialAuth.getAuthorizationUrl.mockReturnValue('https://github.com/login/oauth/...');
            const res = makeRes();

            const result = await controller.getAuthUrl('github', res);

            expect(socialAuth.getAuthorizationUrl).toHaveBeenCalledTimes(1);
            const [providerArg, redirectArg, stateArg] = socialAuth.getAuthorizationUrl.mock.calls[0];
            expect(providerArg).toBe('github');
            expect(redirectArg).toBeUndefined();
            // The state passed to the social-auth call must match the cookie value.
            expect(typeof stateArg).toBe('string');
            expect((stateArg as string).length).toBeGreaterThan(20);
            // Cookie header is set.
            const setCookie = res._headers['set-cookie'];
            expect(setCookie).toBeDefined();
            expect(String(setCookie)).toContain(`ew_oauth_state=${stateArg}`);
            expect(String(setCookie)).toContain('HttpOnly');
            expect(result).toEqual({ url: 'https://github.com/login/oauth/...' });
        });

        it('propagates service errors (e.g. unknown provider)', async () => {
            socialAuth.getAuthorizationUrl.mockImplementation(() => {
                throw new Error('Unknown provider: discord');
            });
            const res = makeRes();

            await expect(controller.getAuthUrl('discord', res)).rejects.toThrow(
                'Unknown provider: discord',
            );
        });
    });

    describe('authRedirect (GET /api/oauth/:providerId/callback)', () => {
        // C-03: callback verifies cookie vs state query. Helper to round-trip
        // a valid state pair from mint() → request headers.
        function mintAndMakeReq(overrides: { ip?: string; headers?: Record<string, string> } = {}) {
            const { state, setCookie } = oauthState.mint({ secure: false });
            const cookieValue = setCookie.split(';')[0]; // "ew_oauth_state=<state>"
            const baseHeaders = { 'user-agent': 'Mozilla/5.0', cookie: cookieValue };
            const headers = overrides.headers ? { ...baseHeaders, ...overrides.headers } : baseHeaders;
            return {
                state,
                req: makeRequest({ ...overrides, headers }),
            };
        }

        it('verifies state, exchanges code, issues session, and emits a per-provider login activity log', async () => {
            socialAuth.authenticate.mockResolvedValue({ id: 'u1' } as any);
            socialAuth.getProviderDisplayName.mockReturnValue('GitHub');
            authProvider.issueSession.mockResolvedValue({ access_token: 'tok' } as any);
            const { state, req } = mintAndMakeReq();
            const res = makeRes();

            const result = await controller.authRedirect('github', 'code-abc', state, req, res);

            expect(socialAuth.authenticate).toHaveBeenCalledWith('github', 'code-abc');
            expect(authProvider.issueSession).toHaveBeenCalledWith('u1', {
                ipAddress: '203.0.113.5',
                userAgent: 'Mozilla/5.0',
            });
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

            // C-03 single-use: cookie is cleared on success.
            expect(String(res._headers['set-cookie'])).toContain('Max-Age=0');
        });

        it('falls back to x-forwarded-for when req.ip is missing', async () => {
            socialAuth.authenticate.mockResolvedValue({ id: 'u2' } as any);
            socialAuth.getProviderDisplayName.mockReturnValue('Google');
            authProvider.issueSession.mockResolvedValue({ access_token: 't' } as any);
            const { state, req } = mintAndMakeReq({
                ip: undefined as any,
                headers: { 'user-agent': 'UA', 'x-forwarded-for': '198.51.100.7' },
            });
            const res = makeRes();

            await controller.authRedirect('google', 'code', state, req, res);

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
            const { state, req } = mintAndMakeReq();
            const res = makeRes();

            await controller.authRedirect('linkedin', 'c', state, req, res);

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
            const { state, req } = mintAndMakeReq();
            const res = makeRes();

            await expect(controller.authRedirect('github', 'c', state, req, res)).resolves.toEqual({
                access_token: 't',
            });
        });

        it('propagates social-auth errors (invalid code) — but only after state passes', async () => {
            socialAuth.authenticate.mockRejectedValue(new Error('No access token returned'));
            const { state, req } = mintAndMakeReq();
            const res = makeRes();

            await expect(
                controller.authRedirect('github', 'bad', state, req, res),
            ).rejects.toThrow('No access token returned');

            expect(authProvider.issueSession).not.toHaveBeenCalled();
            expect(activityLog.log).not.toHaveBeenCalled();
        });

        it('propagates issueSession errors', async () => {
            socialAuth.authenticate.mockResolvedValue({ id: 'u1' } as any);
            authProvider.issueSession.mockRejectedValue(new Error('session store down'));
            const { state, req } = mintAndMakeReq();
            const res = makeRes();

            await expect(
                controller.authRedirect('github', 'c', state, req, res),
            ).rejects.toThrow('session store down');

            expect(activityLog.log).not.toHaveBeenCalled();
        });

        // C-03 — state verification:
        it('rejects when the state cookie is missing (CSRF defense)', async () => {
            const req = makeRequest({ headers: { 'user-agent': 'UA' } }); // no cookie
            const res = makeRes();

            await expect(
                controller.authRedirect('github', 'c', 'some-state', req, res),
            ).rejects.toThrow(/OAuth state verification failed/);

            expect(socialAuth.authenticate).not.toHaveBeenCalled();
            expect(authProvider.issueSession).not.toHaveBeenCalled();
        });

        it('rejects when state query and cookie value do not match (attacker-supplied state)', async () => {
            const { setCookie } = oauthState.mint({ secure: false });
            const cookieValue = setCookie.split(';')[0];
            const req = makeRequest({
                headers: { 'user-agent': 'UA', cookie: cookieValue },
            });
            const res = makeRes();

            await expect(
                controller.authRedirect('github', 'c', 'WRONG_STATE', req, res),
            ).rejects.toThrow(/OAuth state verification failed/);

            expect(socialAuth.authenticate).not.toHaveBeenCalled();
        });

        it('clears the state cookie on rejection too (no zombie state)', async () => {
            const req = makeRequest({ headers: { 'user-agent': 'UA' } });
            const res = makeRes();

            await expect(
                controller.authRedirect('github', 'c', 'no-state', req, res),
            ).rejects.toThrow(/OAuth state verification failed/);

            expect(String(res._headers['set-cookie'])).toContain('Max-Age=0');
        });
    });
});
