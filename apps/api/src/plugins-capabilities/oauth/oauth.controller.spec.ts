jest.mock('@ever-works/agent/facades', () => ({ OAuthFacadeService: class {} }));
jest.mock('@ever-works/agent/database', () => ({
    AuthAccountRepository: class {},
    PLUGIN_PROVIDER_PREFIX: 'plugin:',
    buildPluginProviderId: (providerId: string) => `plugin:${providerId}`,
}));
jest.mock('@ever-works/agent/plugins', () => ({ PluginSettingsService: class {} }));
jest.mock('../../auth/guards/auth-session.guard', () => ({ AuthSessionGuard: class {} }));

import { BadRequestException } from '@nestjs/common';
import { OAuthController } from './oauth.controller';
import type { OAuthService } from './oauth.service';
import type { OAuthStateService } from '../../auth/services/oauth-state.service';

describe('OAuthController', () => {
    let oauthService: {
        getAvailableProviders: jest.Mock;
        isConfigured: jest.Mock;
        checkConnection: jest.Mock;
        getOAuthUrl: jest.Mock;
        handleOAuthCallback: jest.Mock;
        getReadPackagesOAuthUrl: jest.Mock;
        handleReadPackagesOAuthCallback: jest.Mock;
        getUser: jest.Mock;
        disconnectProvider: jest.Mock;
    };
    // EW-722 #20: the controller now mints/verifies the OAuth CSRF state
    // via OAuthStateService — mocked here, contract covered by
    // auth/services/oauth-state.service.spec.ts.
    let oauthState: {
        mint: jest.Mock;
        verify: jest.Mock;
    };
    let res: { getHeader: jest.Mock; setHeader: jest.Mock };
    let controller: OAuthController;
    const req = { user: { userId: 'user-1' }, headers: {} } as any;

    beforeEach(() => {
        oauthService = {
            getAvailableProviders: jest.fn(),
            isConfigured: jest.fn(),
            checkConnection: jest.fn(),
            getOAuthUrl: jest.fn(),
            handleOAuthCallback: jest.fn(),
            getReadPackagesOAuthUrl: jest.fn(),
            handleReadPackagesOAuthCallback: jest.fn(),
            getUser: jest.fn(),
            disconnectProvider: jest.fn(),
        };
        oauthState = {
            mint: jest
                .fn()
                .mockReturnValue({ state: 'minted-state', setCookie: 'ew_oauth_state=minted' }),
            verify: jest.fn().mockReturnValue({ valid: true, clearCookie: 'ew_oauth_state=' }),
        };
        res = { getHeader: jest.fn().mockReturnValue(undefined), setHeader: jest.fn() };
        controller = new OAuthController(
            oauthService as unknown as OAuthService,
            oauthState as unknown as OAuthStateService,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('listProviders', () => {
        it('returns { configured, providers } envelope', async () => {
            oauthService.getAvailableProviders.mockReturnValue([{ id: 'github' }]);
            oauthService.isConfigured.mockReturnValue(true);

            const result = await controller.listProviders();

            expect(result).toEqual({ configured: true, providers: [{ id: 'github' }] });
        });

        it('returns configured:false when service reports not configured', async () => {
            oauthService.getAvailableProviders.mockReturnValue([]);
            oauthService.isConfigured.mockReturnValue(false);

            const result = await controller.listProviders();

            expect(result).toEqual({ configured: false, providers: [] });
        });
    });

    describe('checkConnection', () => {
        it('forwards (req.user.userId, providerId) and returns service result verbatim', async () => {
            const info = { id: 'github', connected: true };
            oauthService.checkConnection.mockResolvedValue(info);

            const result = await controller.checkConnection(req, 'github');

            expect(oauthService.checkConnection).toHaveBeenCalledWith('user-1', 'github');
            expect(result).toBe(info);
        });
    });

    describe('getConnectUrl', () => {
        it('forwards params with the SERVER-MINTED state and returns service result on success', async () => {
            const payload = { url: 'https://provider/auth', state: 'minted-state' };
            oauthService.getOAuthUrl.mockResolvedValue(payload);

            const result = await controller.getConnectUrl(
                req,
                'github',
                res as any,
                'https://app/cb',
                'true',
            );

            // EW-722 #20: state is minted by OAuthStateService, never taken
            // from the client — a client-chosen state would defeat the
            // cookie↔query CSRF binding verified at the callback.
            expect(oauthState.mint).toHaveBeenCalledTimes(1);
            expect(oauthService.getOAuthUrl).toHaveBeenCalledWith({
                userId: 'user-1',
                redirectUri: 'https://app/cb',
                forceConsent: true,
                providerId: 'github',
                state: 'minted-state',
            });
            expect(result).toBe(payload);
        });

        it('sets the minted state cookie on the response', async () => {
            oauthService.getOAuthUrl.mockResolvedValue({ url: 'u', state: 'minted-state' });

            await controller.getConnectUrl(req, 'github', res as any, 'cb');

            expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', 'ew_oauth_state=minted');
        });

        it('appends to existing Set-Cookie headers instead of clobbering them', async () => {
            res.getHeader.mockReturnValue('other=1');
            oauthService.getOAuthUrl.mockResolvedValue({ url: 'u', state: 'minted-state' });

            await controller.getConnectUrl(req, 'github', res as any, 'cb');

            expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
                'other=1',
                'ew_oauth_state=minted',
            ]);
        });

        it('coerces forceConsent to false when not literally "true"', async () => {
            oauthService.getOAuthUrl.mockResolvedValue({ url: 'u', state: 's' });

            await controller.getConnectUrl(req, 'github', res as any, 'cb', 'false');
            await controller.getConnectUrl(req, 'github', res as any, 'cb', undefined);
            await controller.getConnectUrl(req, 'github', res as any, 'cb', '');
            await controller.getConnectUrl(req, 'github', res as any, 'cb', 'TRUE'); // case-sensitive

            for (const call of oauthService.getOAuthUrl.mock.calls) {
                expect(call[0].forceConsent).toBe(false);
            }
        });

        it('coerces missing callbackUrl to empty string', async () => {
            oauthService.getOAuthUrl.mockResolvedValue({ url: 'u', state: 's' });

            await controller.getConnectUrl(req, 'github', res as any, undefined);

            expect(oauthService.getOAuthUrl).toHaveBeenCalledWith(
                expect.objectContaining({ redirectUri: '' }),
            );
        });

        it('wraps Error rejection in BadRequestException with the original message', async () => {
            oauthService.getOAuthUrl.mockRejectedValue(new Error('credentials missing'));

            await expect(
                controller.getConnectUrl(req, 'github', res as any, 'cb'),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(controller.getConnectUrl(req, 'github', res as any, 'cb')).rejects.toThrow(
                'credentials missing',
            );
        });

        it('wraps non-Error rejection in BadRequestException with generic message', async () => {
            oauthService.getOAuthUrl.mockRejectedValue('something');

            await expect(controller.getConnectUrl(req, 'github', res as any, 'cb')).rejects.toThrow(
                'Failed to get OAuth URL',
            );
        });
    });

    describe('handleOAuthCallback', () => {
        it('throws BadRequestException when code is missing (BEFORE the state check)', async () => {
            await expect(
                controller.handleOAuthCallback(req, 'github', res as any, '', 'state'),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                controller.handleOAuthCallback(req, 'github', res as any, '', 'state'),
            ).rejects.toThrow('Authorization code is required');

            expect(oauthService.handleOAuthCallback).not.toHaveBeenCalled();
            // e2e pins 'Authorization code is required' as the FIRST gate —
            // state verification must not run when the code is absent.
            expect(oauthState.verify).not.toHaveBeenCalled();
        });

        it('throws BadRequestException when code is undefined', async () => {
            await expect(
                controller.handleOAuthCallback(req, 'github', res as any, undefined as any, 's'),
            ).rejects.toThrow('Authorization code is required');
        });

        it('verifies state against the cookie, clears the cookie, and forwards (userId, providerId, code)', async () => {
            const info = { id: 'github', connected: true };
            oauthService.handleOAuthCallback.mockResolvedValue(info);
            const cookieReq = {
                user: { userId: 'user-1' },
                headers: { cookie: 'ew_oauth_state=state-xyz' },
            } as any;

            const result = await controller.handleOAuthCallback(
                cookieReq,
                'github',
                res as any,
                'code-abc',
                'state-xyz',
            );

            expect(oauthState.verify).toHaveBeenCalledWith({
                cookieHeader: 'ew_oauth_state=state-xyz',
                stateQuery: 'state-xyz',
                secure: false,
            });
            // The state cookie is single-use: cleared even on success.
            expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', 'ew_oauth_state=');
            expect(oauthService.handleOAuthCallback).toHaveBeenCalledWith(
                'user-1',
                'github',
                'code-abc',
            );
            expect(result).toBe(info);
        });

        it('rejects with BadRequestException when state verification fails (EW-722 #20 CSRF gate)', async () => {
            oauthState.verify.mockReturnValue({
                valid: false,
                clearCookie: 'ew_oauth_state=',
                reason: 'state value mismatch',
            });

            await expect(
                controller.handleOAuthCallback(req, 'github', res as any, 'code-abc', 'attacker'),
            ).rejects.toThrow('OAuth state verification failed: state value mismatch');

            // The code is NEVER exchanged on a failed state check — that is
            // the whole point: no attacker code-to-account linkage.
            expect(oauthService.handleOAuthCallback).not.toHaveBeenCalled();
            // Cookie still cleared (single-use) on the failure path.
            expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', 'ew_oauth_state=');
        });

        it('rejects when state query param is omitted', async () => {
            oauthState.verify.mockReturnValue({
                valid: false,
                clearCookie: 'ew_oauth_state=',
                reason: 'missing state query',
            });

            await expect(
                controller.handleOAuthCallback(req, 'github', res as any, 'code-abc'),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(oauthState.verify).toHaveBeenCalledWith(
                expect.objectContaining({ stateQuery: undefined }),
            );
            expect(oauthService.handleOAuthCallback).not.toHaveBeenCalled();
        });

        it('propagates errors from service.handleOAuthCallback (no try/catch wrap)', async () => {
            const err = new Error('upstream');
            oauthService.handleOAuthCallback.mockRejectedValue(err);

            await expect(
                controller.handleOAuthCallback(req, 'github', res as any, 'code', 's'),
            ).rejects.toBe(err);
        });
    });

    describe('read-packages variant (connect/url + callback)', () => {
        it('getReadPackagesConnectUrl uses the server-minted state and sets the cookie', async () => {
            const payload = { url: 'https://provider/auth', state: 'minted-state' };
            oauthService.getReadPackagesOAuthUrl.mockResolvedValue(payload);

            const result = await controller.getReadPackagesConnectUrl(
                req,
                'github',
                res as any,
                'cb',
            );

            expect(oauthState.mint).toHaveBeenCalledTimes(1);
            expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', 'ew_oauth_state=minted');
            expect(oauthService.getReadPackagesOAuthUrl).toHaveBeenCalledWith(
                expect.objectContaining({ state: 'minted-state' }),
            );
            expect(result).toBe(payload);
        });

        it('handleReadPackagesOAuthCallback gates on code first, then state, then forwards', async () => {
            await expect(
                controller.handleReadPackagesOAuthCallback(req, 'github', res as any, '', 's'),
            ).rejects.toThrow('Authorization code is required');
            expect(oauthState.verify).not.toHaveBeenCalled();

            oauthService.handleReadPackagesOAuthCallback.mockResolvedValue({
                providerId: 'github',
                connected: true,
            });
            const result = await controller.handleReadPackagesOAuthCallback(
                req,
                'github',
                res as any,
                'code-abc',
                'state-xyz',
            );
            expect(oauthState.verify).toHaveBeenCalledTimes(1);
            expect(oauthService.handleReadPackagesOAuthCallback).toHaveBeenCalledWith(
                'user-1',
                'github',
                'code-abc',
            );
            expect(result).toEqual({ providerId: 'github', connected: true });
        });

        it('handleReadPackagesOAuthCallback rejects on invalid state without exchanging the code', async () => {
            oauthState.verify.mockReturnValue({
                valid: false,
                clearCookie: 'ew_oauth_state=',
                reason: 'missing state cookie',
            });

            await expect(
                controller.handleReadPackagesOAuthCallback(
                    req,
                    'github',
                    res as any,
                    'code-abc',
                    'forged',
                ),
            ).rejects.toThrow('OAuth state verification failed: missing state cookie');

            expect(oauthService.handleReadPackagesOAuthCallback).not.toHaveBeenCalled();
        });
    });

    describe('getUser', () => {
        it('returns { success: true, user } on success', async () => {
            oauthService.getUser.mockResolvedValue({ username: 'alice' });

            const result = await controller.getUser(req, 'github');

            expect(oauthService.getUser).toHaveBeenCalledWith('user-1', 'github');
            expect(result).toEqual({ success: true, user: { username: 'alice' } });
        });

        it('returns { success: false, user: null, error: <message> } on Error rejection', async () => {
            oauthService.getUser.mockRejectedValue(new Error('401'));

            const result = await controller.getUser(req, 'github');

            expect(result).toEqual({ success: false, user: null, error: '401' });
        });

        it('returns generic error fallback when rejection is not an Error instance', async () => {
            oauthService.getUser.mockRejectedValue({ status: 502 });

            const result = await controller.getUser(req, 'github');

            expect(result).toEqual({
                success: false,
                user: null,
                error: 'Failed to fetch user',
            });
        });
    });

    describe('disconnectProvider', () => {
        it('forwards (userId, providerId) and resolves to undefined', async () => {
            oauthService.disconnectProvider.mockResolvedValue(undefined);

            const result = await controller.disconnectProvider(req, 'github');

            expect(oauthService.disconnectProvider).toHaveBeenCalledWith('user-1', 'github');
            expect(result).toBeUndefined();
        });

        it('propagates errors from service.disconnectProvider', async () => {
            oauthService.disconnectProvider.mockRejectedValue(new Error('cannot revoke'));

            await expect(controller.disconnectProvider(req, 'github')).rejects.toThrow(
                'cannot revoke',
            );
        });
    });
});
