jest.mock('@ever-works/agent/plugins', () => ({ PluginOperationsService: class {} }));

import { DeviceAuthService } from './device-auth.service';
import type { PluginOperationsService } from '@ever-works/agent/plugins';

describe('DeviceAuthService', () => {
    let pluginOperations: {
        getPluginDeviceAuthStatus: jest.Mock;
        startPluginDeviceAuth: jest.Mock;
    };
    let service: DeviceAuthService;

    beforeEach(() => {
        pluginOperations = {
            getPluginDeviceAuthStatus: jest.fn(),
            startPluginDeviceAuth: jest.fn(),
        };
        service = new DeviceAuthService(pluginOperations as unknown as PluginOperationsService);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('getStatus', () => {
        it('forwards (pluginId, userId) to pluginOperations.getPluginDeviceAuthStatus and returns its result', async () => {
            const status = { state: 'connected', userCode: 'ABC-123' };
            pluginOperations.getPluginDeviceAuthStatus.mockResolvedValue(status);

            const result = await service.getStatus('user-1', 'plugin-x');

            expect(pluginOperations.getPluginDeviceAuthStatus).toHaveBeenCalledWith(
                'plugin-x',
                'user-1',
            );
            expect(pluginOperations.getPluginDeviceAuthStatus).toHaveBeenCalledTimes(1);
            expect(result).toBe(status);
        });

        it('propagates rejection from pluginOperations.getPluginDeviceAuthStatus', async () => {
            const err = new Error('plugin unavailable');
            pluginOperations.getPluginDeviceAuthStatus.mockRejectedValue(err);

            await expect(service.getStatus('user-1', 'plugin-x')).rejects.toBe(err);
        });
    });

    describe('start', () => {
        it('forwards (pluginId, userId) to pluginOperations.startPluginDeviceAuth and returns its result', async () => {
            const status = { state: 'pending', verificationUri: 'https://x.test/device' };
            pluginOperations.startPluginDeviceAuth.mockResolvedValue(status);

            const result = await service.start('user-2', 'plugin-y');

            expect(pluginOperations.startPluginDeviceAuth).toHaveBeenCalledWith(
                'plugin-y',
                'user-2',
            );
            expect(pluginOperations.startPluginDeviceAuth).toHaveBeenCalledTimes(1);
            expect(result).toBe(status);
        });

        it('propagates rejection from pluginOperations.startPluginDeviceAuth', async () => {
            const err = new Error('rate-limited');
            pluginOperations.startPluginDeviceAuth.mockRejectedValue(err);

            await expect(service.start('user-2', 'plugin-y')).rejects.toBe(err);
        });

        it('does not call getPluginDeviceAuthStatus when start is invoked', async () => {
            pluginOperations.startPluginDeviceAuth.mockResolvedValue({ state: 'pending' });

            await service.start('user-3', 'plugin-z');

            expect(pluginOperations.getPluginDeviceAuthStatus).not.toHaveBeenCalled();
        });

        it('does not call startPluginDeviceAuth when getStatus is invoked', async () => {
            pluginOperations.getPluginDeviceAuthStatus.mockResolvedValue({ state: 'connected' });

            await service.getStatus('user-3', 'plugin-z');

            expect(pluginOperations.startPluginDeviceAuth).not.toHaveBeenCalled();
        });
    });
});
