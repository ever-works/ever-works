import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import { WorkStatusCard } from '@/components/works/detail/WorkStatusCard';
import { WorkInfo } from '@/components/works/detail/overview/WorkInfo';
import { WorkStats } from '@/components/works/detail/overview/WorkStats';
import { WorkConfig } from '@/components/works/detail/overview/WorkConfig';
import { GenerateStatusType } from '@/lib/api/enums';
import { notFound } from 'next/navigation';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('overview') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkOverviewPage({ params }: Params) {
    const { id } = await params;

    let work;
    let config = null;
    let countRes = { items: 0, categories: 0, tags: 0, comparisons: 0 };

    try {
        const [workRes, configResult, countResult] = await Promise.all([
            workAPI.get(id),
            workAPI.getConfig(id).catch(() => ({ config: null })),
            workAPI
                .getCount(id)
                .catch(() => ({ items: 0, categories: 0, tags: 0, comparisons: 0 })),
        ]);

        work = workRes.work;
        config = configResult.config;
        countRes = countResult;
    } catch {
        notFound();
    }

    const showStatusCard =
        !work.generateStatus?.status ||
        work.generateStatus?.status === GenerateStatusType.ERROR ||
        work.generateStatus?.status === GenerateStatusType.GENERATING ||
        work.generateStatus?.status === GenerateStatusType.CANCELLED ||
        (work.generateStatus?.status === GenerateStatusType.GENERATED &&
            !!work.generateStatus?.warnings?.length);

    return (
        <div className="space-y-6">
            {showStatusCard && <WorkStatusCard work={work} />}

            <WorkStats
                itemsCount={work.itemsCount || countRes.items}
                categoriesCount={countRes.categories}
                tagsCount={countRes.tags}
                comparisonsCount={countRes.comparisons || 0}
                work={work}
            />

            {/* Work Info and Config side by side */}
            <div className="grid @3xl/main:grid-cols-2 gap-6">
                <WorkInfo work={work} config={config} />
                {config && <WorkConfig config={config} />}
            </div>
        </div>
    );
}
