import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import DashboardClient from './dashboard-client';
import { getWorks, getWorkStats } from '@/app/actions/dashboard/works';
import { GET_WORK_LIST_LIMIT } from '@/lib/constants';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import { missionsAPI } from '@/lib/api/missions';
import { usageAPI } from '@/lib/api/usage';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('dashboard') };
}

interface DashboardPageProps {
    searchParams: Promise<{ newUser?: string }>;
}

export default async function Dashboard({ searchParams }: DashboardPageProps) {
    const [
        { newUser },
        user,
        worksResponse,
        statsResponse,
        proposals,
        proposalsStatus,
        missions,
        allIdeas,
        accountWide,
    ] = await Promise.all([
        searchParams,
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
            totalMissions: 0,
            totalIdeas: 0,
        })),
        workProposalsAPI.list(['pending']).catch(() => []),
        workProposalsAPI.status().catch(() => ({ researching: false, canRefresh: true }) as const),
        missionsAPI.list().catch(() => []),
        workProposalsAPI
            .list(['pending', 'queued', 'building', 'failed', 'accepted', 'dismissed'])
            .catch(() => []),
        usageAPI.accountWide().catch(() => null),
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
            autoStartProposals={newUser === 'true' && proposals.length === 0}
            initialMissions={missions}
            initialAllIdeas={allIdeas}
            monthSpendCents={accountWide?.currentSpendCents ?? 0}
            monthSpendCurrency={accountWide?.currency ?? 'usd'}
        />
    );
}
