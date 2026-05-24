import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import DashboardClient from './dashboard-client';
import { getWorks, getWorkStats } from '@/app/actions/dashboard/works';
import { GET_WORK_LIST_LIMIT } from '@/lib/constants';
import { workProposalsAPI } from '@/lib/api/work-proposals';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('dashboard') };
}

export default async function Dashboard() {
    const [user, worksResponse, statsResponse, proposals, proposalsStatus] = await Promise.all([
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
            // Phase 2 PR F — new Dashboard tiles. Catch-fallback must
            // include these so the type-narrowed branch below doesn't
            // see undefined.
            totalMissions: 0,
            totalIdeas: 0,
        })),
        workProposalsAPI.list(['pending']).catch(() => []),
        workProposalsAPI.status().catch(() => ({ researching: false, canRefresh: true }) as const),
    ]);

    const totalWorks = statsResponse.success ? statsResponse.totalWorks : worksResponse.total;

    return (
        <DashboardClient
            user={user!}
            initialWorks={worksResponse.works}
            totalWorks={totalWorks}
            totalItems={statsResponse.totalItems}
            activeWebsites={statsResponse.activeWebsites}
            totalMissions={statsResponse.totalMissions ?? 0}
            totalIdeas={statsResponse.totalIdeas ?? 0}
            initialProposals={proposals}
            initiallyResearching={proposalsStatus.researching}
            initiallyCanRefresh={proposalsStatus.canRefresh}
        />
    );
}
