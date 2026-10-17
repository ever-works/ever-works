import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getWorks, getWorkStats } from '@/app/actions/dashboard/works';
import WorksClient from './works-client';
import { ALL_WORK_KIND_CHIP_VALUES } from '@/lib/work-kinds/chip-values';
import { getDisabledWorkKinds } from '@/lib/feature-flags/work-kinds';
import { getAuthFromRequest } from '@/lib/auth';

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

    // APW-01 T23 — the quick-add composer's kind chips follow the same flag
    // set as `/works/new`, so the fail-closed App chip is absent here too while
    // `works-app` / `EVER_WORKS_APP_WORKS_ENABLED` is off. Never throws.
    const auth = await getAuthFromRequest().catch(() => null);
    const disabledKinds = Array.from(
        await getDisabledWorkKinds(ALL_WORK_KIND_CHIP_VALUES, auth?.user?.sub),
    );

    return (
        <WorksClient
            disabledKinds={disabledKinds}
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
