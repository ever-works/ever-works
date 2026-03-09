import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import DashboardClient from './dashboard-client';
import { getDirectories, getDirectoryStats } from '@/app/actions/dashboard/directories';
import { GET_DIRECTORY_LIST_LIMIT } from '@/lib/constants';

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

    return (
        <DashboardClient
            user={user!}
            initialDirectories={directoriesResponse.directories}
            totalDirectories={statsResponse.totalDirectories}
            totalItems={statsResponse.totalItems}
            activeWebsites={statsResponse.activeWebsites}
        />
    );
}
