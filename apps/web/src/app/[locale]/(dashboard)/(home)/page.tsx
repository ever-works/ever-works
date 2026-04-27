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
    const [user, directoriesResponse, statsResponse] = await Promise.all([
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
    ]);

    const totalDirectories = statsResponse.success
        ? statsResponse.totalDirectories
        : directoriesResponse.total;

    return (
        <DashboardClient
            user={user!}
            initialDirectories={directoriesResponse.directories}
            totalDirectories={totalDirectories}
            totalItems={statsResponse.totalItems}
            activeWebsites={statsResponse.activeWebsites}
        />
    );
}
