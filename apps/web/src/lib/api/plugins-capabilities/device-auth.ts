import 'server-only';
import { serverFetch, serverMutation } from '../server-api';
import type { DeviceAuthStatus } from '@ever-works/plugin';

export type PluginDeviceAuthStatus = DeviceAuthStatus;

export const deviceAuthAPI = {
    getStatus: async (pluginId: string): Promise<PluginDeviceAuthStatus> => {
        return serverFetch<PluginDeviceAuthStatus>(`/device-auth/${pluginId}/status`);
    },

    start: async (pluginId: string): Promise<PluginDeviceAuthStatus> => {
        return serverMutation<PluginDeviceAuthStatus>({
            endpoint: `/device-auth/${pluginId}/start`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
