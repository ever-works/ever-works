'use server';

import type { ActionResult } from '@/app/actions/plugins';
import { oauthAPI } from '@/lib/api/plugins-capabilities/oauth';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import { gitProvidersAPI } from '@/lib/api/plugins-capabilities/git-providers';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import { deviceAuthAPI } from '@/lib/api/plugins-capabilities/device-auth';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';

interface OnboardingPluginStatusRequest {
    pluginId: string;
    capabilities: string[];
}

interface OnboardingPluginStatuses {
    connections: Record<string, OAuthConnectionInfo | GitProviderConnectionInfo | null>;
    deviceAuthStatuses: Record<string, PluginDeviceAuthStatus | null>;
}

export async function getOnboardingPluginStatuses(
    plugins: OnboardingPluginStatusRequest[],
): Promise<ActionResult<OnboardingPluginStatuses>> {
    try {
        const [connectionEntries, deviceAuthEntries] = await Promise.all([
            Promise.all(
                plugins.map(async (plugin) => {
                    if (plugin.capabilities.includes('git-provider')) {
                        const connection = await gitProvidersAPI
                            .checkConnection(plugin.pluginId)
                            .catch(() => null);
                        return [plugin.pluginId, connection] as [
                            string,
                            GitProviderConnectionInfo | null,
                        ];
                    }

                    if (plugin.capabilities.includes('oauth')) {
                        const connection = await oauthAPI
                            .checkConnection(plugin.pluginId)
                            .catch(() => null);
                        return [plugin.pluginId, connection] as [
                            string,
                            OAuthConnectionInfo | null,
                        ];
                    }

                    return [plugin.pluginId, null] as [string, null];
                }),
            ),
            Promise.all(
                plugins.map(async (plugin) => {
                    if (!plugin.capabilities.includes('device-auth')) {
                        return [plugin.pluginId, null] as [string, null];
                    }

                    const status = await deviceAuthAPI.getStatus(plugin.pluginId).catch(() => null);
                    return [plugin.pluginId, status] as [string, PluginDeviceAuthStatus | null];
                }),
            ),
        ]);

        return {
            success: true,
            data: {
                connections: Object.fromEntries(connectionEntries),
                deviceAuthStatuses: Object.fromEntries(deviceAuthEntries),
            },
        };
    } catch (error) {
        console.error('Failed to get onboarding plugin statuses:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to get onboarding plugin statuses',
        };
    }
}
