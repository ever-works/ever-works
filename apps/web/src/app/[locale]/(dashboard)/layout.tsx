import { cookies } from 'next/headers';
import { getAuthFromCookie } from '@/lib/auth';
import { DashboardLayoutClient } from './layout-client';
import { authAPI } from '@/lib/api';
import { getWorkStats } from '@/app/actions/dashboard/works';
import { pluginsAPI } from '@/lib/api/plugins';
import { onboardingAPI } from '@/lib/api/onboarding';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import type {
    OnboardingCatalogResponse,
    OnboardingStateResponse,
} from '@ever-works/contracts/api';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import type { UserPlugin } from '@/lib/api/plugins';

const FALLBACK_CATALOG: OnboardingCatalogResponse = {
    ai: [],
    storage: [],
    deploy: [],
    plugins: [],
};

const FALLBACK_STATE: OnboardingStateResponse = {
    completedAt: null,
    dismissedAt: null,
    state: ONBOARDING_DEFAULT_STATE,
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const user = await getAuthFromCookie();

    if (!user) {
        return null;
    }

    const [profile, statsResponse, pluginsResponse, onboardingState, onboardingCatalog] =
        await Promise.all([
            authAPI.getFreshProfile().catch(() => null),
            getWorkStats().catch(() => ({
                success: false,
                totalWorks: 0,
            })),
            pluginsAPI.list().catch(() => ({ plugins: [] as UserPlugin[], total: 0 })),
            onboardingAPI.getState().catch(() => FALLBACK_STATE),
            onboardingAPI.getCatalog().catch(() => FALLBACK_CATALOG),
        ]);

    const hasGithubConnected =
        profile?.oauthTokens?.some((token) => token.provider === 'github') ?? false;
    const onboardingTotalWorks = statsResponse.success ? statsResponse.totalWorks : 0;
    const onboardingPlugins = pluginsResponse.plugins
        .filter((plugin) => plugin.uiHints?.includeInOnboarding)
        .sort(
            (a, b) => (a.uiHints?.onboardingPriority ?? 99) - (b.uiHints?.onboardingPriority ?? 99),
        );
    const onboardingConnections = Object.fromEntries(
        onboardingPlugins.map(
            (plugin) =>
                [plugin.pluginId, null] as [
                    string,
                    OAuthConnectionInfo | GitProviderConnectionInfo | null,
                ],
        ),
    );
    const onboardingDeviceAuthStatuses = Object.fromEntries(
        onboardingPlugins.map(
            (plugin) => [plugin.pluginId, null] as [string, PluginDeviceAuthStatus | null],
        ),
    );

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
            onboardingTotalWorks={onboardingTotalWorks}
            onboardingPlugins={onboardingPlugins}
            initialOnboardingConnections={onboardingConnections}
            initialOnboardingDeviceAuthStatuses={onboardingDeviceAuthStatuses}
            initialOnboardingState={onboardingState}
            initialOnboardingCatalog={onboardingCatalog}
        >
            {children}
        </DashboardLayoutClient>
    );
}
