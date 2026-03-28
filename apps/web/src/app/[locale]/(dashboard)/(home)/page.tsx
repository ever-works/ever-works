import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import DashboardClient from './dashboard-client';
import { getDirectories, getDirectoryStats } from '@/app/actions/dashboard/directories';
import { GET_DIRECTORY_LIST_LIMIT } from '@/lib/constants';
import { pluginsAPI } from '@/lib/api/plugins';
import { oauthAPI } from '@/lib/api/plugins-capabilities/oauth';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { UserPlugin } from '@/lib/api/plugins';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('dashboard') };
}

export default async function Dashboard() {
    const [user, directoriesResponse, statsResponse, pluginsResponse] = await Promise.all([
        getAuthFromCookie(),
        getDirectories({ limit: GET_DIRECTORY_LIST_LIMIT }).catch(() => ({
            success: false,
            directories: [],
            total: 0,
        })),
        getDirectoryStats().catch(() => ({
            success: false,
            totalDirectories: 0,
            totalItems: 0,
            activeWebsites: 0,
        })),
        pluginsAPI.list().catch(() => ({ plugins: [] as UserPlugin[], total: 0 })),
    ]);

    const totalDirectories = statsResponse.success
        ? statsResponse.totalDirectories
        : directoriesResponse.total;

    // Collect plugins that opt into onboarding, sorted by declared priority
    const onboardingPlugins = pluginsResponse.plugins
        .filter((p) => p.uiHints?.includeInOnboarding)
        .sort(
            (a, b) => (a.uiHints?.onboardingPriority ?? 99) - (b.uiHints?.onboardingPriority ?? 99),
        );

    // Fetch OAuth connection status for any onboarding plugin that uses OAuth
    const oauthPlugins = onboardingPlugins.filter((p) => p.capabilities.includes('oauth'));
    const oauthConnectionEntries = await Promise.all(
        oauthPlugins.map(async (p) => {
            const conn = await oauthAPI.checkConnection(p.pluginId).catch(() => null);
            return [p.pluginId, conn] as [string, OAuthConnectionInfo | null];
        }),
    );
    const oauthConnections = Object.fromEntries(oauthConnectionEntries);

    return (
        <DashboardClient
            user={user!}
            initialDirectories={directoriesResponse.directories}
            totalDirectories={totalDirectories}
            totalItems={statsResponse.totalItems}
            activeWebsites={statsResponse.activeWebsites}
            onboardingPlugins={onboardingPlugins}
            oauthConnections={oauthConnections}
        />
    );
}
