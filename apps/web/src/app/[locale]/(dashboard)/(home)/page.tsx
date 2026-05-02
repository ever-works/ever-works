import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import DashboardClient from './dashboard-client';
import { getWorks, getWorkStats } from '@/app/actions/dashboard/works';
import { GET_WORK_LIST_LIMIT } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('dashboard') };
}

export default async function Dashboard() {
    const [user, worksResponse, statsResponse] = await Promise.all([
        getAuthFromCookie(),
        getWorks({ limit: GET_WORK_LIST_LIMIT }).catch(() => ({
            success: false,
            works: [],
            total: 0,
        })),
        getWorkStats().catch(() => ({
            success: false,
            totalWorks: 0,
            totalItems: 0,
            activeWebsites: 0,
        })),
    ]);

    const totalWorks = statsResponse.success
        ? statsResponse.totalWorks
        : worksResponse.total;

    return (
        <DashboardClient
            user={user!}
            initialWorks={worksResponse.works}
            totalWorks={totalWorks}
            totalItems={statsResponse.totalItems}
            activeWebsites={statsResponse.activeWebsites}
        />
    );
}
