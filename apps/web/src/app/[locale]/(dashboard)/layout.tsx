import { cookies } from 'next/headers';
import { getAuthFromCookie } from '@/lib/auth';
import { DashboardLayoutClient } from './layout-client';
import { authAPI } from '@/lib/api';
import { getDirectoryStats } from '@/app/actions/dashboard/directories';
import { pluginsAPI } from '@/lib/api/plugins';
import { oauthAPI } from '@/lib/api/plugins-capabilities/oauth';
import { gitProvidersAPI } from '@/lib/api/plugins-capabilities/git-providers';
import { deviceAuthAPI } from '@/lib/api/plugins-capabilities/device-auth';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import type { UserPlugin } from '@/lib/api/plugins';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const user = await getAuthFromCookie();

    if (!user) {
        return null;
    }

    const [profile, statsResponse, pluginsResponse] = await Promise.all([
        authAPI.getFreshProfile().catch(() => null),
        getDirectoryStats().catch(() => ({
            success: false,
            totalDirectories: 0,
        })),
        pluginsAPI.list().catch(() => ({ plugins: [] as UserPlugin[], total: 0 })),
    ]);

    const hasGithubConnected =
        profile?.oauthTokens?.some((token) => token.provider === 'github') ?? false;
    const onboardingTotalDirectories = statsResponse.success ? statsResponse.totalDirectories : 0;
    const onboardingPlugins = pluginsResponse.plugins
        .filter((plugin) => plugin.uiHints?.includeInOnboarding)
        .sort(
            (a, b) => (a.uiHints?.onboardingPriority ?? 99) - (b.uiHints?.onboardingPriority ?? 99),
        );
    const connectionEntries = await Promise.all(
        onboardingPlugins.map(async (plugin) => {
            if (plugin.capabilities.includes('git-provider')) {
                const connection = await gitProvidersAPI
                    .checkConnection(plugin.pluginId)
                    .catch(() => null);
                return [plugin.pluginId, connection] as [string, GitProviderConnectionInfo | null];
            }

            if (plugin.capabilities.includes('oauth')) {
                const connection = await oauthAPI
                    .checkConnection(plugin.pluginId)
                    .catch(() => null);
                return [plugin.pluginId, connection] as [string, OAuthConnectionInfo | null];
            }

            return [plugin.pluginId, null] as [string, null];
        }),
    );
    const onboardingConnections = Object.fromEntries(connectionEntries);
    const deviceAuthEntries = await Promise.all(
        onboardingPlugins.map(async (plugin) => {
            if (!plugin.capabilities.includes('device-auth')) {
                return [plugin.pluginId, null] as [string, null];
            }

            const status = await deviceAuthAPI.getStatus(plugin.pluginId).catch(() => null);
            return [plugin.pluginId, status] as [string, PluginDeviceAuthStatus | null];
        }),
    );
    const onboardingDeviceAuthStatuses = Object.fromEntries(deviceAuthEntries);

    const cookieStore = await cookies();
    const chatCookie = cookieStore.get('chat-panel-open')?.value;
    const chatPanelOpen = chatCookie === undefined ? true : chatCookie === '1';
    const collapsedCookie = cookieStore.get('sidebar-collapsed')?.value;
    const sidebarCollapsed = collapsedCookie === undefined ? true : collapsedCookie === '1';

    return (
        <DashboardLayoutClient
            user={user}
            initialChatOpen={chatPanelOpen}
            initialSidebarCollapsed={sidebarCollapsed}
            hasGithubConnected={hasGithubConnected}
            onboardingTotalDirectories={onboardingTotalDirectories}
            onboardingPlugins={onboardingPlugins}
            onboardingConnections={onboardingConnections}
            onboardingDeviceAuthStatuses={onboardingDeviceAuthStatuses}
        >
            {children}
        </DashboardLayoutClient>
    );
}
