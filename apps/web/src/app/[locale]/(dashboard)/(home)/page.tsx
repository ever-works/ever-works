import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import DashboardClient from './dashboard-client';
import { getDirectories, getDirectoryStats } from '@/app/actions/dashboard/directories';
import { GET_DIRECTORY_LIST_LIMIT } from '@/lib/constants';
import { pluginsAPI } from '@/lib/api/plugins';
import { gitProvidersAPI } from '@/lib/api/plugins-capabilities/git-providers';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('dashboard') };
}

export default async function Dashboard() {
    const user = await getAuthFromCookie();

    const [directoriesResponse, statsResponse] = await Promise.all([
        getDirectories({ limit: GET_DIRECTORY_LIST_LIMIT }),
        getDirectoryStats(),
    ]);

    const [claudePlugin, openRouterPlugin, vercelPlugin, gitHubConnection] = await Promise.all([
        pluginsAPI.get('claude-code').catch(() => null),
        pluginsAPI.get('openrouter').catch(() => null),
        pluginsAPI.get('vercel').catch(() => null),
        gitProvidersAPI.checkConnection('github').catch(() => null),
    ]);

    return (
        <DashboardClient
            user={user!}
            initialDirectories={directoriesResponse.directories}
            totalDirectories={
                statsResponse.success ? statsResponse.totalDirectories : directoriesResponse.total
            }
            totalItems={statsResponse.totalItems}
            activeWebsites={statsResponse.activeWebsites}
            claudePlugin={claudePlugin}
            openRouterPlugin={openRouterPlugin}
            vercelPlugin={vercelPlugin}
            gitHubConnection={gitHubConnection}
        />
    );
}
