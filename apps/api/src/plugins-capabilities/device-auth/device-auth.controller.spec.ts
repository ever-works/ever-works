jest.mock('@ever-works/agent/plugins', () => ({ PluginOperationsService: class {} }));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { DeviceAuthController } from './device-auth.controller';
import type { DeviceAuthService } from './device-auth.service';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

describe('DeviceAuthController', () => {
    let deviceAuthService: { getStatus: jest.Mock; start: jest.Mock };
    let controller: DeviceAuthController;
    const auth: AuthenticatedUser = { userId: 'user-1' } as any;

    beforeEach(() => {
        deviceAuthService = {
            getStatus: jest.fn(),
            start: jest.fn(),
        };
        controller = new DeviceAuthController(deviceAuthService as unknown as DeviceAuthService);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('getStatus', () => {
        it('forwards (auth.userId, pluginId) to service.getStatus and returns its result', async () => {
            const status = { state: 'connected', userCode: 'AAA-111' };
            deviceAuthService.getStatus.mockResolvedValue(status);

            const result = await controller.getStatus(auth, 'plugin-x');

            expect(deviceAuthService.getStatus).toHaveBeenCalledWith('user-1', 'plugin-x');
            expect(deviceAuthService.getStatus).toHaveBeenCalledTimes(1);
            expect(result).toBe(status);
            expect(deviceAuthService.start).not.toHaveBeenCalled();
        });

        it('propagates errors thrown by service.getStatus', async () => {
            const err = new Error('boom');
            deviceAuthService.getStatus.mockRejectedValue(err);

            await expect(controller.getStatus(auth, 'plugin-x')).rejects.toBe(err);
        });
    });

    describe('start', () => {
        it('forwards (auth.userId, pluginId) to service.start and returns its result', async () => {
            const status = { state: 'pending', verificationUri: 'https://x.test/device' };
            deviceAuthService.start.mockResolvedValue(status);

            const result = await controller.start(auth, 'plugin-y');

            expect(deviceAuthService.start).toHaveBeenCalledWith('user-1', 'plugin-y');
            expect(deviceAuthService.start).toHaveBeenCalledTimes(1);
            expect(result).toBe(status);
            expect(deviceAuthService.getStatus).not.toHaveBeenCalled();
        });

        it('propagates errors thrown by service.start', async () => {
            const err = new Error('plugin not configured');
            deviceAuthService.start.mockRejectedValue(err);

            await expect(controller.start(auth, 'plugin-y')).rejects.toBe(err);
        });

        it('passes through different userId/pluginId pairs without mutation', async () => {
            deviceAuthService.start.mockResolvedValue({ state: 'pending' });

            await controller.start({ userId: 'u-42' } as AuthenticatedUser, 'plugin-z');
            await controller.start({ userId: 'u-99' } as AuthenticatedUser, 'plugin-w');

            expect(deviceAuthService.start.mock.calls).toEqual([
                ['u-42', 'plugin-z'],
                ['u-99', 'plugin-w'],
            ]);
        });
    });
});
