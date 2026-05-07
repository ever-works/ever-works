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

describe('OAuthController', () => {
    let oauthService: {
        getAvailableProviders: jest.Mock;
        isConfigured: jest.Mock;
        checkConnection: jest.Mock;
        getOAuthUrl: jest.Mock;
        handleOAuthCallback: jest.Mock;
        getUser: jest.Mock;
        disconnectProvider: jest.Mock;
    };
    let controller: OAuthController;
    const req = { user: { userId: 'user-1' } } as any;

    beforeEach(() => {
        oauthService = {
            getAvailableProviders: jest.fn(),
            isConfigured: jest.fn(),
            checkConnection: jest.fn(),
            getOAuthUrl: jest.fn(),
            handleOAuthCallback: jest.fn(),
            getUser: jest.fn(),
            disconnectProvider: jest.fn(),
        };
        controller = new OAuthController(oauthService as unknown as OAuthService);
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
        it('forwards all params and returns service result on success', async () => {
            const payload = { url: 'https://provider/auth', state: 'abc' };
            oauthService.getOAuthUrl.mockResolvedValue(payload);

            const result = await controller.getConnectUrl(
                req,
                'github',
                'https://app/cb',
                'abc',
                'true',
            );

            expect(oauthService.getOAuthUrl).toHaveBeenCalledWith({
                userId: 'user-1',
                redirectUri: 'https://app/cb',
                forceConsent: true,
                providerId: 'github',
                state: 'abc',
            });
            expect(result).toBe(payload);
        });

        it('coerces forceConsent to false when not literally "true"', async () => {
            oauthService.getOAuthUrl.mockResolvedValue({ url: 'u', state: 's' });

            await controller.getConnectUrl(req, 'github', 'cb', 's', 'false');
            await controller.getConnectUrl(req, 'github', 'cb', 's', undefined);
            await controller.getConnectUrl(req, 'github', 'cb', 's', '');
            await controller.getConnectUrl(req, 'github', 'cb', 's', 'TRUE'); // case-sensitive

            for (const call of oauthService.getOAuthUrl.mock.calls) {
                expect(call[0].forceConsent).toBe(false);
            }
        });

        it('coerces missing callbackUrl to empty string', async () => {
            oauthService.getOAuthUrl.mockResolvedValue({ url: 'u', state: 's' });

            await controller.getConnectUrl(req, 'github', undefined, 's');

            expect(oauthService.getOAuthUrl).toHaveBeenCalledWith(
                expect.objectContaining({ redirectUri: '' }),
            );
        });

        it('passes state=undefined through when omitted', async () => {
            oauthService.getOAuthUrl.mockResolvedValue({ url: 'u', state: 'auto' });

            await controller.getConnectUrl(req, 'github', 'cb');

            expect(oauthService.getOAuthUrl).toHaveBeenCalledWith(
                expect.objectContaining({ state: undefined }),
            );
        });

        it('wraps Error rejection in BadRequestException with the original message', async () => {
            oauthService.getOAuthUrl.mockRejectedValue(new Error('credentials missing'));

            await expect(
                controller.getConnectUrl(req, 'github', 'cb'),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                controller.getConnectUrl(req, 'github', 'cb'),
            ).rejects.toThrow('credentials missing');
        });

        it('wraps non-Error rejection in BadRequestException with generic message', async () => {
            oauthService.getOAuthUrl.mockRejectedValue('something');

            await expect(
                controller.getConnectUrl(req, 'github', 'cb'),
            ).rejects.toThrow('Failed to get OAuth URL');
        });
    });

    describe('handleOAuthCallback', () => {
        it('throws BadRequestException when code is missing', async () => {
            await expect(
                controller.handleOAuthCallback(req, 'github', '', 'state'),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                controller.handleOAuthCallback(req, 'github', '', 'state'),
            ).rejects.toThrow('Authorization code is required');

            expect(oauthService.handleOAuthCallback).not.toHaveBeenCalled();
        });

        it('throws BadRequestException when code is undefined', async () => {
            await expect(
                controller.handleOAuthCallback(req, 'github', undefined as any, 'state'),
            ).rejects.toThrow('Authorization code is required');
        });

        it('forwards (userId, providerId, code, state) to service.handleOAuthCallback', async () => {
            const info = { id: 'github', connected: true };
            oauthService.handleOAuthCallback.mockResolvedValue(info);

            const result = await controller.handleOAuthCallback(req, 'github', 'code-abc', 'state-xyz');

            expect(oauthService.handleOAuthCallback).toHaveBeenCalledWith(
                'user-1',
                'github',
                'code-abc',
                'state-xyz',
            );
            expect(result).toBe(info);
        });

        it('passes state=undefined when omitted', async () => {
            oauthService.handleOAuthCallback.mockResolvedValue({});

            await controller.handleOAuthCallback(req, 'github', 'code-abc');

            expect(oauthService.handleOAuthCallback).toHaveBeenCalledWith(
                'user-1',
                'github',
                'code-abc',
                undefined,
            );
        });

        it('propagates errors from service.handleOAuthCallback (no try/catch wrap)', async () => {
            const err = new Error('upstream');
            oauthService.handleOAuthCallback.mockRejectedValue(err);

            await expect(
                controller.handleOAuthCallback(req, 'github', 'code'),
            ).rejects.toBe(err);
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
