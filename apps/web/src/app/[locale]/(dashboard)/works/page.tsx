import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getWorks, getWorkStats } from '@/app/actions/dashboard/works';
import WorksClient from './works-client';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('works') };
}

export default async function WorksPage() {
    // Fetch all works with pagination
    const [response, statsResponse] = await Promise.all([
        getWorks({ limit: 20, offset: 0 }).catch(() => ({
            success: false,
            works: [],
            total: 0,
        })),
        getWorkStats().catch(() => ({
            success: false,
            totalWorks: 0,
            totalItems: 0,
            activeWebsites: 0,
            generatingCount: 0,
        })),
    ]);

    return (
        <WorksClient
            initialWorks={response.works}
            totalWorks={response.total}
            initialStats={{
                totalWorks: statsResponse.totalWorks,
                totalItems: statsResponse.totalItems,
                generatingCount: statsResponse.generatingCount,
            }}
        />
    );
}
